# Projeto mag-ai — manifesto

Infraestrutura de IA local da MAG: um Ollama (modelo pequeno, só CPU) atrás de um gateway interno com chave
por aplicação. Primeiro cliente: BIOMIE v2. Convenção da VPS: `/srv/LEIA-ME.md`.

## O que pertence ao projeto

| tipo | nome | observação |
|---|---|---|
| containers | `mag-ai-ollama`, `mag-ai-gateway` | projeto Compose `mag-ai`, arquivo `/opt/mag-ai/compose.yml` |
| imagens | `mag-ai-ollama:<versão>-cpu`, `mag-ai-gateway:<versão>` | rótulo `br.com.mag.projeto=mag-ai` |
| volume | `mag-ai_modelos` | modelos baixados (~1 GB); externo ao Compose |
| rede | `mag-ai_interna` | interna (sem internet) e ponte sem endereço do servidor: só Ollama e gateway |
| rede | `mag-ai_biomie` | interna (sem internet) e ponte sem endereço do servidor: gateway + web do BIOMIE (Fase 4) |
| rede temporária | `mag-ai_saida` | só durante o download do modelo; removida em seguida |
| pastas | `/opt/mag-ai/` | compose, `.env` (versões), `config/apps.json` (só hashes), `bin/`, `build/` (fontes) |
| pastas | `/srv/mag-ai/` | este manifesto, `backup.sh`, `restore.sh`, `CREDENCIAIS.txt` (600), `docs/`, `fotos/`, `backups/` |
| cron | `/etc/cron.d/mag-ai-saude` | monitor a cada 5 min |
| cron | `/etc/cron.d/mag-ai-backup` | pacote diário às 04:12 (`vps-backup-run mag-ai`) |
| logrotate | `/etc/logrotate.d/mag-ai` | mensal, 6 meses |
| logs | `/var/log/mag-ai-saude.{log,csv}`, `/var/log/mag-ai-implantacao.log`, `/var/log/vps-backup-mag-ai.log` | sem texto de pedidos |

Nenhuma porta no servidor. Nada no nginx, no firewall, no daemon do Docker nem nos bancos.

## Limites

Ollama: 2,5 GB de memória sem swap, 1 vCPU, prioridade de CPU menor que a dos outros sistemas, 1 geração por vez,
fila de 2, contexto de 2.048 tokens (homologação), modelo descarregado após 2 min sem uso, `OLLAMA_NO_CLOUD=1`,
`OLLAMA_VULKAN=0`.
Gateway: 192 MB, 0,25 vCPU, sistema de arquivos só leitura, sem privilégios.

## Dependência do BIOMIE

Da Fase 4 em diante, o compose do BIOMIE declara a rede `mag-ai_biomie` como externa. **Não apague essa rede
enquanto o BIOMIE a referenciar**: o `compose up` do BIOMIE falharia. O `mag-ai.sh remover` não apaga a rede
se houver container ligado a ela. Desligar a IA no BIOMIE = chave `ai_assistant` desligada (sem deploy).

## Operação

    /opt/mag-ai/bin/mag-ai.sh checklist                # somente leitura
    /opt/mag-ai/bin/mag-ai.sh verificar | foto <nome> | comparar <a> <d> | testar | ensaiar-reversao
    /opt/mag-ai/bin/mag-ai.sh desfazer              # derruba os 2 containers (volume, redes e imagens ficam)
    /opt/mag-ai/bin/mag-ai.sh remover --confirmo    # apaga tudo do projeto (guarda docs e chaves em /root/backups)
    docker exec mag-ai-gateway node src/metricas.mjs
    tail /var/log/mag-ai-saude.log /var/log/mag-ai-saude.csv

## Backup e restauração

`backup.sh` gera `/srv/mag-ai/backups/mag-ai-AAAAMMDD-HHMMSS.tar.gz` (600) com `/opt/mag-ai`, este manifesto,
os documentos e as chaves. O modelo não entra: a restauração baixa de novo e confere as camadas fixadas.
`restore.sh <pacote>` restaura numa VPS sem o projeto.
