#!/usr/bin/env python3
"""MAG AI — monitor a cada 5 min (cron /etc/cron.d/mag-ai-saude).

Grava uma linha em /var/log/mag-ai-saude.csv (memória e CPU do Ollama lidas direto do cgroup, fila, pedidos,
erros, p95, reinícios, memória do servidor) e escreve avisos "WARN" na saída (vai para /var/log/mag-ai-saude.log).
Somente leitura: não reinicia nem altera nada.
"""
import datetime
import json
import pathlib
import subprocess

CSV = pathlib.Path('/var/log/mag-ai-saude.csv')
ESTADO = pathlib.Path('/run/mag-ai-saude.json')
CAMPOS = ['at', 'ollama_mem_mb', 'ollama_mem_limite_mb', 'ollama_pico_mb', 'ollama_cpu_s', 'gateway_mem_mb',
          'modelo_carregado', 'pedidos_5min', 'ok_5min', 'erros_5xx_5min', 'ocupado_5min', 'p95_ms', 'fila',
          'reinicios', 'oom', 'mem_disponivel_host_mb', 'load1']


def sh(args, timeout=20):
    try:
        p = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
        return p.returncode, p.stdout.strip()
    except (OSError, subprocess.TimeoutExpired):
        return 1, ''


def inspecionar(nome):
    rc, out = sh(['docker', 'inspect', '-f', '{{.Id}}|{{.State.Running}}|{{.RestartCount}}|{{.State.OOMKilled}}', nome])
    if rc != 0 or out.count('|') != 3:
        return None
    cid, rodando, reinicios, oom = out.split('|')
    return {'id': cid, 'rodando': rodando == 'true', 'reinicios': int(reinicios), 'oom': oom == 'true'}


def cgroup(cid, arquivo):
    try:
        return pathlib.Path(f'/sys/fs/cgroup/system.slice/docker-{cid}.scope/{arquivo}').read_text().strip()
    except OSError:
        return None


def main():
    avisos = []
    agora = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds')
    linha = dict.fromkeys(CAMPOS, '')
    linha['at'] = agora
    meminfo = {}
    for texto in pathlib.Path('/proc/meminfo').read_text().splitlines():
        partes = texto.split()
        if len(partes) >= 2 and partes[1].isdigit():
            meminfo[partes[0].rstrip(':')] = int(partes[1])
    linha['mem_disponivel_host_mb'] = meminfo.get('MemAvailable', 0) // 1024
    linha['load1'] = pathlib.Path('/proc/loadavg').read_text().split()[0]

    ollama = inspecionar('mag-ai-ollama')
    gateway = inspecionar('mag-ai-gateway')
    if not ollama or not ollama['rodando']:
        avisos.append('mag-ai-ollama parado')
    if not gateway or not gateway['rodando']:
        avisos.append('mag-ai-gateway parado')

    if ollama:
        atual, limite, pico = (cgroup(ollama['id'], f) for f in ('memory.current', 'memory.max', 'memory.peak'))
        cpu = cgroup(ollama['id'], 'cpu.stat')
        if atual:
            linha['ollama_mem_mb'] = int(atual) // 1048576
        if limite and limite != 'max':
            linha['ollama_mem_limite_mb'] = int(limite) // 1048576
        if pico:
            linha['ollama_pico_mb'] = int(pico) // 1048576
        if cpu:
            usec = next((int(t.split()[1]) for t in cpu.splitlines() if t.startswith('usage_usec')), 0)
            linha['ollama_cpu_s'] = usec // 1_000_000
        linha['oom'] = int(ollama['oom'])
        if atual and limite and limite != 'max' and int(atual) > 0.9 * int(limite):
            avisos.append(f'Ollama acima de 90% do limite de memória ({int(atual) // 1048576} MB)')
        if ollama['oom']:
            avisos.append('Ollama foi encerrado por falta de memória (OOMKilled)')
        rc, out = sh(['docker', 'exec', 'mag-ai-ollama', '/usr/bin/ollama', 'ps'])
        linha['modelo_carregado'] = int(rc == 0 and 'qwen3.5' in out)

    if gateway:
        atual = cgroup(gateway['id'], 'memory.current')
        if atual:
            linha['gateway_mem_mb'] = int(atual) // 1048576
        rc, out = sh(['docker', 'exec', 'mag-ai-gateway', 'node', 'src/metricas.mjs'])
        if rc == 0:
            m = json.loads(out)
            u = m['last_5min']
            linha.update(pedidos_5min=u['requests'], ok_5min=u['ok'], erros_5xx_5min=u['errors_5xx'],
                         ocupado_5min=u['busy'], p95_ms=u['p95_ms'] if u['p95_ms'] is not None else '',
                         fila=m['gate']['queued'])
            erros = u['errors_5xx'] - u['busy']
            if erros >= 3:
                avisos.append(f'{erros} erros 5xx (fora "ocupado") em 5 min')
            if u['busy'] >= 10:
                avisos.append(f"{u['busy']} pedidos recusados por fila cheia em 5 min")
            if u['p95_ms'] and u['p95_ms'] > 60000:
                avisos.append(f"tempo de resposta p95 de {u['p95_ms']} ms em 5 min")
            if m.get('breaker') == 'open':
                avisos.append('disjuntor aberto: o Ollama está falhando')
        elif gateway['rodando']:
            avisos.append('métricas do gateway indisponíveis')

    reinicios = (ollama['reinicios'] if ollama else 0) + (gateway['reinicios'] if gateway else 0)
    linha['reinicios'] = reinicios
    try:
        anterior = json.loads(ESTADO.read_text())
    except (OSError, ValueError):
        anterior = {}
    if reinicios > anterior.get('reinicios', reinicios):
        avisos.append(f"containers do mag-ai reiniciaram ({anterior.get('reinicios')} -> {reinicios})")
    ESTADO.write_text(json.dumps({'reinicios': reinicios}))
    if linha['mem_disponivel_host_mb'] < 1500:
        avisos.append(f"servidor com pouca memória: {linha['mem_disponivel_host_mb']} MB disponíveis")

    novo = not CSV.exists()
    with CSV.open('a', encoding='utf-8') as f:
        if novo:
            f.write(','.join(CAMPOS) + '\n')
        f.write(','.join(str(linha[c]) for c in CAMPOS) + '\n')
    for aviso in avisos:
        print(f'{agora} WARN {aviso}')


if __name__ == '__main__':
    main()
