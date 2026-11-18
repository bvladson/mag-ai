#!/usr/bin/env bash
# MAG AI — implantação na VPS em passos com portões. Roda como root NA VPS.
#
#   mag-ai.sh checklist            SOMENTE LEITURA: memória, redes, bancos, backups, estabilidade e reversão
#   mag-ai.sh verificar            pré-requisitos, janela e foto "antes" (grava só a foto e o log)
#   mag-ai.sh preparar             pastas, chaves (só o hash vai para o gateway), .env, volume e rede do BIOMIE (vazia)
#   mag-ai.sh construir            imagens mag-ai-ollama (só CPU, pacote oficial conferido) e mag-ai-gateway
#   mag-ai.sh modelo               baixa o modelo por uma rede temporária e confere as camadas fixadas
#   mag-ai.sh subir                sobe os 2 containers, espera ficarem saudáveis, liga monitor e backup
#   mag-ai.sh testar               isolamento (sondas), segurança, função, desempenho e consumo
#   mag-ai.sh ensaiar-reversao     desfazer → conferir que nada fora do MAG AI mudou → subir de novo
#   mag-ai.sh foto <nome>          retrato do servidor (tudo que NÃO é do mag-ai)
#   mag-ai.sh comparar [a] [d]     compara duas fotos; qualquer diferença fora do mag-ai = falha
#   mag-ai.sh desfazer             derruba os 2 containers e desliga monitor/backup (volume, rede e imagens ficam)
#   mag-ai.sh remover --confirmo   desfazer + apaga volume, redes, imagens e pastas do mag-ai
#   mag-ai.sh preparar-analise     (16/11) compose novo + GATEWAY_VERSION + MAG_AI_MODEL_ANALISE no .env
#                                  + tarefa "analisar" (prazo 200 s, resposta 1000) nas aplicações
#   mag-ai.sh modelo-analise       baixa o 2º modelo (análise) pela rede temporária e REGISTRA o manifesto
#
# Passos pesados (construir, modelo, testar) só fora do expediente, com o servidor folgado e sem
# homologação de outro sistema rodando. Exceção explícita: --fora-da-janela="motivo".
#
# Não mexe em: nginx, firewall, daemon do Docker, bancos, nem em containers, redes ou volumes de outros projetos.
set -Eeuo pipefail
export LC_ALL=C
umask 077

BASE=/opt/mag-ai
SRV=/srv/mag-ai
FOTOS=$SRV/fotos
LOG=/var/log/mag-ai-implantacao.log
PROJETO=mag-ai
MODELO=qwen3.5:0.8b-q8_0
MANIFESTO_REL=models/manifests/registry.ollama.ai/library/qwen3.5/0.8b-q8_0
MANIFESTO_SHA=7c00f78aed0fd757e9ba2f2720896768fd22da24b7fb6fe17096bb1e85bb2d25
CAMADAS_FIXADAS="sha256:889ea3b9143cdc32146c7d530ce5f3d452ec18069086f6f4167ce9ae72a9691f sha256:5ba2eb9bf28c5b5ff7a705f07bd9269f0f2dbd6cb2b4c46d5f98ed8d15d18883"
REDE_CLIENTE=mag-ai_biomie
REDE_INTERNA=mag-ai_interna
REDE_SAIDA=mag-ai_saida
VOLUME=mag-ai_modelos
NODE_IMG=node:24-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9
ROTULO=br.com.mag.projeto=mag-ai
SEM_ENDERECO=com.docker.network.bridge.inhibit_ipv4=true
MEM_MINIMA_TESTE=1500   # se a memória disponível do servidor cair abaixo disto durante os testes, o teste é interrompido

SEM_LOG=
log() {
  if [ -n "$SEM_LOG" ]; then printf '%s %s\n' "$(date '+%F %T')" "$*" >&2
  else printf '%s %s\n' "$(date '+%F %T')" "$*" | tee -a "$LOG" >&2; fi
}
falha() { log "FALHA: $*"; exit 1; }
trap 'log "FALHA: comando interrompido na linha $LINENO"' ERR

[ "$(id -u)" -eq 0 ] || falha "rode como root"

# Pasta do pacote enviado (gateway/, deploy/, ops/, srv/). Quando o script roda da cópia em /opt/mag-ai/bin,
# o pacote vem do .env (gravado no "preparar").
AQUI=$(cd "$(dirname "$0")/.." && pwd)
if [ -f "$AQUI/deploy/compose.yml" ]; then
  PACOTE=$AQUI
elif [ -f "$BASE/.env" ]; then
  PACOTE=$(sed -n 's/^MAG_AI_PACOTE=//p' "$BASE/.env")
else
  PACOTE=
fi

compose() { docker compose --project-name "$PROJETO" --env-file "$BASE/.env" -f "$BASE/compose.yml" "$@"; }
env_valor() { sed -n "s/^$1=//p" "$BASE/.env"; }
chave_de() { sed -n "s/^$1=//p" "$SRV/CREDENCIAIS.txt"; }
ponte_tem_ip() { local id; id=$(docker network inspect -f '{{.Id}}' "$1" | cut -c1-12); ip -4 -o addr show "br-$id" 2>/dev/null | grep -q inet; }
gateway_ipam() { docker network inspect -f '{{range .IPAM.Config}}{{.Gateway}}{{end}}' "$1" 2>/dev/null || true; }

# ---------------------------------------------------------------- portões
FORA_DA_JANELA=
for arg in "$@"; do
  case $arg in --fora-da-janela=*) FORA_DA_JANELA=${arg#*=} ;; esac
done

janela() {
  # Fora do expediente (Brasília): dias úteis antes das 07:30 ou a partir das 18:30; sábado antes das 07:30
  # (madrugada) ou a partir das 12:30; domingo livre. Longe das cargas do BIOMIE (:21 e :51): começa só em
  # :00–:12 ou :30–:42.
  local dia hm min
  dia=$(TZ=America/Sao_Paulo date +%u)
  hm=$(TZ=America/Sao_Paulo date +%H%M)
  min=$(TZ=America/Sao_Paulo date +%M)
  local ok=0
  if [ "$dia" -eq 7 ]; then ok=1
  elif [ "$dia" -eq 6 ] && { [ "$((10#$hm))" -lt 730 ] || [ "$((10#$hm))" -ge 1230 ]; }; then ok=1
  elif [ "$dia" -le 5 ] && { [ "$((10#$hm))" -lt 730 ] || [ "$((10#$hm))" -ge 1830 ]; }; then ok=1
  fi
  if [ "$ok" -eq 1 ] && { [ "$((10#$min))" -le 12 ] || { [ "$((10#$min))" -ge 30 ] && [ "$((10#$min))" -le 42 ]; }; }; then
    return 0
  fi
  return 1
}

servidor_folgado() {
  local load1 mem
  load1=$(cut -d' ' -f1 /proc/loadavg)
  mem=$(awk '/^MemAvailable:/{print int($2/1024)}' /proc/meminfo)
  awk -v l="$load1" 'BEGIN{exit !(l < 1.0)}' || { log "servidor ocupado: carga de 1 min = $load1"; return 1; }
  [ "$mem" -ge 3000 ] || { log "memória disponível baixa: ${mem} MB"; return 1; }
  local outros
  outros=$(docker ps -q --filter label=com.docker.compose.project=biomie-hml; docker ps -q --filter label=com.docker.compose.project=vsb360-hml; docker ps -q --filter label=com.docker.compose.project=vsb360-hml-ensaio; docker ps -q --filter name=biomie-v2-intel)
  [ -z "$outros" ] || { log "homologação ou motor de outro sistema rodando agora"; return 1; }
  return 0
}

portao_pesado() {
  if [ -n "$FORA_DA_JANELA" ]; then
    log "aviso: fora da janela por decisão explícita: $FORA_DA_JANELA"
  else
    janela || falha "fora da janela (dia útil antes de 07:30 ou após 18:30, sábado antes de 07:30 ou após 12:30, domingo; minutos :00–:12 ou :30–:42)"
  fi
  servidor_folgado || falha "servidor sem folga agora; tente mais tarde"
}

# ---------------------------------------------------------------- checklist (somente leitura)
CK_FALHAS=0
CK_AVISOS=0
ck_ok() { printf '  OK     %s\n' "$*"; }
ck_aviso() { printf '  AVISO  %s\n' "$*"; CK_AVISOS=$((CK_AVISOS + 1)); }
ck_falha() { printf '  FALHA  %s\n' "$*"; CK_FALHAS=$((CK_FALHAS + 1)); }
idade_h() {  # horas desde o campo "at" de uma linha JSON do backup do BIOMIE v2
  local t
  t=$(printf '%s' "$1" | sed -nE 's/.*"at": "([^"]+)".*/\1/p')
  if [ -n "$t" ]; then echo $(( ($(date +%s) - $(date -d "$t" +%s)) / 3600 )); else echo 9999; fi
}

checklist() {
  SEM_LOG=1
  echo "CHECKLIST MAG AI — $(TZ=America/Sao_Paulo date '+%d/%m/%Y %H:%M') (somente leitura)"

  echo "1. Memória, CPU e disco"
  local mem swap load1 min24 quando psi disco
  mem=$(awk '/^MemAvailable:/{print int($2/1024)}' /proc/meminfo)
  swap=$(awk '/^SwapTotal:/{t=$2} /^SwapFree:/{f=$2} END{print int((t-f)/1024)}' /proc/meminfo)
  load1=$(cut -d' ' -f1 /proc/loadavg)
  if [ "$mem" -ge 3000 ]; then ck_ok "memória disponível agora: $mem MB (mínimo para começar: 3.000)"; else ck_falha "memória disponível agora: $mem MB (abaixo de 3.000)"; fi
  min24=
  quando=
  if [ -f /var/log/biomie-v2-health.csv ]; then
    read -r min24 quando < <(tail -n 288 /var/log/biomie-v2-health.csv | awk -F, '$4 ~ /^[0-9]+$/ {if(m==""||$4<m){m=$4;w=substr($1,1,16)}} END{print m, w}') || true
  fi
  if [ -n "$min24" ] && [ "$min24" -ge 3000 ]; then ck_ok "menor memória disponível nas últimas 24 h: $min24 MB ($quando UTC)"
  else ck_aviso "menor memória disponível nas últimas 24 h: ${min24:-?} MB ($quando UTC)"; fi
  psi=$(awk '/^some/{for(i=1;i<=NF;i++) if($i ~ /^avg300=/){sub("avg300=","",$i); print $i}}' /proc/pressure/memory)
  if awk -v p="$psi" 'BEGIN{exit !(p < 1.0)}'; then ck_ok "pressão de memória (média de 5 min): $psi%"; else ck_aviso "pressão de memória (média de 5 min): $psi%"; fi
  ck_ok "swap em uso: $swap MB (páginas inativas de outros serviços; informativo)"
  if awk -v l="$load1" 'BEGIN{exit !(l < 1.0)}'; then ck_ok "carga de 1 min: $load1"; else ck_aviso "carga de 1 min: $load1 (os passos pesados esperam ficar abaixo de 1,0)"; fi
  disco=$(df -BG --output=avail / | tail -1 | tr -dc 0-9)
  if [ "$disco" -ge 10 ]; then ck_ok "disco livre: $disco GB (o MAG AI usa ~1,5 GB)"; else ck_falha "disco livre: $disco GB (abaixo de 10)"; fi

  echo "2. Isolamento de redes"
  if ufw status | grep -q '^Status: active'; then
    ck_ok "firewall ativo; entrada liberada só para: $(ufw status | grep ALLOW | grep -v '(v6)' | sed -E 's/ +ALLOW IN.*//; s/ +$//' | paste -sd ';' -)"
  else ck_falha "firewall inativo"; fi
  if [ "$(iptables -S DOCKER-USER 2>/dev/null | wc -l)" -le 1 ]; then ck_ok "cadeia DOCKER-USER sem regras"; else ck_aviso "cadeia DOCKER-USER tem regras (conferir)"; fi
  local publicas
  publicas=$(ss -tlnH | awk '{print $4}' | grep -vE '^(127\.|\[::1\])' | sed -E 's/.*:([0-9]+)$/\1/' | sort -un | tr '\n' ' ')
  if [ "$publicas" = "22 80 443 " ]; then ck_ok "portas abertas para fora: $publicas"; else ck_aviso "portas abertas para fora: $publicas"; fi
  local r interna sem_ip membros
  for r in "$REDE_INTERNA" "$REDE_CLIENTE"; do
    if docker network inspect "$r" >/dev/null 2>&1; then
      interna=$(docker network inspect -f '{{.Internal}}' "$r")
      sem_ip=sim
      if ponte_tem_ip "$r"; then sem_ip=não; fi
      membros=$(docker network inspect -f '{{range .Containers}}{{.Name}} {{end}}' "$r")
      if [ "$interna" = true ]; then ck_ok "rede $r: interna (sem internet); ponte sem endereço do servidor: $sem_ip; membros: ${membros:-nenhum}"
      else ck_falha "rede $r existe e NÃO é interna"; fi
    else
      ck_ok "rede $r: ainda não existe (será criada interna e sem endereço do servidor na ponte)"
    fi
  done
  if docker network inspect "$REDE_SAIDA" >/dev/null 2>&1; then ck_aviso "rede temporária $REDE_SAIDA existe (só deveria existir durante o download)"
  else ck_ok "rede temporária $REDE_SAIDA não existe (só existe durante o download do modelo)"; fi
  ck_ok "faixas Docker em uso: $(docker network ls -q | xargs docker network inspect -f '{{range .IPAM.Config}}{{.Subnet}} {{end}}' | wc -w) de 4.096 /24 disponíveis em 172.16.0.0/12"
  local c
  for c in mag-ai-ollama mag-ai-gateway; do
    if docker ps -a --format '{{.Names}}' | grep -qx "$c"; then
      if [ -z "$(docker port "$c")" ]; then ck_ok "$c sem porta no servidor"; else ck_falha "$c publica porta: $(docker port "$c" | tr '\n' ' ')"; fi
    fi
  done

  echo "3. Acesso aos bancos"
  local p ouvindo
  for p in 3306 3307 5432 6379 27017; do
    ouvindo=$(ss -tlnH | awk -v p=":$p\$" '$4 ~ p {print $4}' | tr '\n' ' ')
    if [ -z "$ouvindo" ]; then ck_ok "porta $p: nada escuta no servidor"
    elif printf '%s' "$ouvindo" | tr ' ' '\n' | grep -v '^$' | grep -qvE '^(127\.0\.0\.1|\[::1\]):'; then ck_falha "porta $p aberta além do 127.0.0.1: $ouvindo"
    else ck_ok "porta $p só em 127.0.0.1 ($ouvindo): container nenhum alcança"; fi
  done
  local redes
  for c in $(docker ps --format '{{.Names}} {{.Image}}' | awk '$2 ~ /(postgres:|mariadb|mysql|redis)/ {print $1}'); do
    redes=$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$c")
    if printf '%s' "$redes" | grep -q 'mag-ai_'; then ck_falha "$c está numa rede do MAG AI: $redes"
    elif [ -n "$(docker port "$c")" ]; then ck_aviso "$c publica porta no servidor: $(docker port "$c" | tr '\n' ' ')"
    else ck_ok "$c: só na rede ${redes% }, sem porta no servidor"; fi
  done
  if docker ps -a --format '{{.Names}}' | grep -qx mag-ai-gateway; then
    local envs
    envs=$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' mag-ai-ollama mag-ai-gateway | cut -d= -f1 | sort -u | tr '\n' ' ')
    if printf '%s' "$envs" | grep -qiE 'PASS|SENHA|SECRET|TOKEN|DATABASE|DB_|MYSQL|MARIADB|OMIE|SUPABASE|JWT'; then ck_falha "variável com cara de credencial no MAG AI: $envs"
    else ck_ok "MAG AI sem credencial de banco, Omie ou Supabase (variáveis: $envs)"; fi
  else
    ck_ok "MAG AI não recebe credencial de banco, Omie ou Supabase (só modelo, limites e hashes das chaves)"
  fi

  echo "4. Backups"
  local f proj ult limite
  limite=$(date -d '-26 hours' '+%F %T')
  for f in /var/log/vps-backup-*.log; do
    proj=$(basename "$f" .log)
    proj=${proj#vps-backup-}
    [ "$proj" = alertas ] && continue
    ult=$(grep -E 'RESULTADO:' "$f" | tail -1 || true)
    if [[ "$ult" == *"RESULTADO: OK"* ]] && [[ "${ult:0:19}" > "$limite" ]]; then ck_ok "$proj: $ult"
    else ck_aviso "$proj: ${ult:-sem resultado ainda}"; fi
  done
  local bk ofs rt h1 h2 h3
  bk=$(grep '"backup_complete"' /var/log/biomie-v2-backup.log 2>/dev/null | tail -1 || true)
  ofs=$(grep '"offsite_complete"' /var/log/biomie-v2-backup.log 2>/dev/null | tail -1 || true)
  rt=$(grep -E '"restore_test_(passed|failed)"' /var/log/biomie-v2-backup.log 2>/dev/null | tail -1 || true)
  h1=$(idade_h "$bk"); h2=$(idade_h "$ofs"); h3=$(idade_h "$rt")
  if [ "$h1" -le 26 ]; then ck_ok "BIOMIE v2: backup cifrado há ${h1} h ($(printf '%s' "$bk" | sed -nE 's/.*"file": "([^"]+)".*/\1/p'))"; else ck_aviso "BIOMIE v2: último backup cifrado há ${h1} h"; fi
  if [ "$h2" -le 26 ]; then ck_ok "BIOMIE v2: cópia externa há ${h2} h ($(printf '%s' "$ofs" | sed -nE 's/.*"copies": "([0-9]+)".*/\1/p') cópias fora do servidor)"; else ck_aviso "BIOMIE v2: última cópia externa há ${h2} h"; fi
  if [[ "$rt" == *restore_test_passed* ]] && [ "$h3" -le 200 ]; then ck_ok "BIOMIE v2: último teste de restauração APROVADO há ${h3} h (semanal, domingo 03:50)"
  else ck_aviso "BIOMIE v2: teste de restauração: ${rt:0:120}"; fi
  ult=$(tail -1 /var/log/leantime-backup.log 2>/dev/null || true)
  if printf '%s' "$ult" | grep -qE "$(date +%Y%m%d)|$(date -d '-1 day' +%Y%m%d)"; then ck_ok "base de tarefas: $ult"; else ck_aviso "base de tarefas: ${ult:-sem registro}"; fi
  local n_leg
  n_leg=$(find /var/backups/biomie-v2/legado -maxdepth 1 -name '*.gpg' 2>/dev/null | wc -l)
  if [ "$n_leg" -ge 1 ]; then ck_ok "BIOMIE antigo: $n_leg arquivo(s) cifrado(s) guardado(s)"; else ck_aviso "BIOMIE antigo: nenhum arquivo cifrado encontrado"; fi
  ck_ok "o MAG AI não toca em nenhum backup existente; o dele roda às 04:12, fora dos horários dos outros"

  echo "5. Estabilidade do BIOMIE v2 e do legado"
  local rel st h ini rs idade
  rel=$(docker inspect -f '{{.Config.Image}}' biomie-v2-web-1 2>/dev/null | sed 's/.*://' || true)
  ck_ok "release ativa do BIOMIE v2: ${rel:-?}"
  for c in biomie-v2-web-1 biomie-v2-worker-1 biomie-v2-db-1 biomie-v2-rest-1 biomie-v2-auth-1 biomie-v2-gateway-1; do
    read -r st h ini rs < <(docker inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}-{{end}} {{.State.StartedAt}} {{.RestartCount}}' "$c" 2>/dev/null || echo "ausente - - -") || true
    if [ "$st" = running ]; then idade=$(( ($(date +%s) - $(date -d "$ini" +%s)) / 3600 )); else idade=0; fi
    if [ "$st" = running ] && [ "$h" != unhealthy ] && [ "$idade" -ge 6 ]; then ck_ok "$c: $st/$h, no ar há ${idade} h"
    elif [ "$st" = running ] && [ "$h" != unhealthy ]; then ck_aviso "$c: no ar há só ${idade} h (ativação recente?)"
    else ck_falha "$c: $st/$h"; fi
  done
  local warn
  warn=$(awk -v d="$(date -u -d '-12 hours' +%Y-%m-%dT%H:%M)" '$0 ~ /WARN/ && substr($1,1,16) >= d' /var/log/biomie-v2-health.log 2>/dev/null | wc -l)
  if [ "$warn" -eq 0 ]; then ck_ok "monitor do BIOMIE v2: nenhum aviso nas últimas 12 h"; else ck_aviso "monitor do BIOMIE v2: $warn aviso(s) nas últimas 12 h"; fi
  if [ "$(docker ps -q --filter label=com.docker.compose.project=biomie-hml | wc -l)" -eq 0 ]; then ck_ok "homologação do BIOMIE parada"
  else ck_aviso "homologação do BIOMIE rodando agora"; fi
  ck_ok "legado: biomie-python $(systemctl is-active biomie-python 2>/dev/null || true); tarefas ativas em /etc/cron.d/biomie: $(grep -cvE '^\s*(#|$)|^[A-Z_]+=' /etc/cron.d/biomie 2>/dev/null || true)"

  echo "6. Reversão"
  ck_ok "voltar: mag-ai.sh desfazer (derruba só mag-ai-ollama e mag-ai-gateway e tira os 2 crons do MAG AI; ~1 min)"
  ck_ok "conferir: mag-ai.sh comparar antes depois-desfazer (containers, portas, firewall, nginx, cron e redes de fora iguais)"
  ck_ok "remoção total: mag-ai.sh remover --confirmo (guarda documentos e chaves em /root/backups)"
  ck_ok "o ensaio de reversão faz parte da instalação (mag-ai.sh ensaiar-reversao)"

  echo "RESUMO: $CK_FALHAS falha(s), $CK_AVISOS aviso(s)"
  [ "$CK_FALHAS" -eq 0 ]
}

# ---------------------------------------------------------------- fotos
foto() {
  local nome=${1:?nome da foto}
  mkdir -p "$FOTOS"
  local cmp="$FOTOS/$nome.cmp" info="$FOTOS/$nome.info"
  {
    echo "## containers fora do mag-ai: nome | início | imagem | reinícios | estado"
    docker ps -a --format '{{.Names}}' | grep -v '^mag-ai-' | sort | while read -r c; do
      docker inspect -f '{{.Name}} | {{.State.StartedAt}} | {{.Image}} | {{.RestartCount}} | {{.State.Status}}' "$c"
    done
    echo "## portas em escuta no servidor"
    ss -tlnH | awk '{print $4}' | sort -u
    echo "## firewall"
    ufw status verbose
    echo "## cadeia DOCKER-USER"
    iptables -S DOCKER-USER
    echo "## nginx (hash de cada arquivo)"
    find /etc/nginx -type f -print0 | sort -z | xargs -0 sha256sum
    echo "## daemon do Docker"
    sha256sum /etc/docker/daemon.json
    echo "## cron fora do mag-ai"
    find /etc/cron.d -maxdepth 1 -type f ! -name 'mag-ai-*' -print0 | sort -z | xargs -0 sha256sum
    echo "## redes e volumes fora do mag-ai"
    docker network ls --format '{{.Name}}' | grep -v '^mag-ai_' | sort
    docker volume ls --format '{{.Name}}' | grep -v '^mag-ai_' | sort
  } > "$cmp" 2>&1
  {
    date -Is
    free -m
    cat /proc/loadavg
    df -h /
    docker stats --no-stream --format '{{.Name}} {{.CPUPerc}} {{.MemUsage}}'
  } > "$info" 2>&1
  log "foto '$nome': $(wc -l < "$cmp") linhas comparáveis em $cmp"
}

comparar() {
  local a=${1:-antes} d=${2:-depois}
  [ -f "$FOTOS/$a.cmp" ] || falha "foto '$a' não existe"
  foto "$d"
  local dif="$FOTOS/diferencas-$a-$d.txt"
  if diff -u "$FOTOS/$a.cmp" "$FOTOS/$d.cmp" > "$dif"; then
    log "comparar: NADA fora do mag-ai mudou entre '$a' e '$d'"
  else
    log "comparar: HÁ DIFERENÇAS fora do mag-ai entre '$a' e '$d' (conferir se são de rotinas agendadas):"
    cat "$dif" >&2
    return 1
  fi
}

# ---------------------------------------------------------------- passos
verificar() {
  log "verificar: início"
  for c in docker ss ufw iptables ip python3 openssl curl sha256sum; do command -v "$c" >/dev/null || falha "comando ausente: $c"; done
  docker compose version >/dev/null || falha "docker compose ausente"
  [ "$(docker info --format '{{.CgroupVersion}}')" = 2 ] || falha "precisa de cgroup v2 (limites de memória)"
  local livre_gb
  livre_gb=$(df -BG --output=avail / | tail -1 | tr -dc 0-9)
  [ "$livre_gb" -ge 10 ] || falha "menos de 10 GB livres no disco (${livre_gb} GB)"
  log "disco livre: ${livre_gb} GB; memória disponível: $(awk '/^MemAvailable:/{print int($2/1024)}' /proc/meminfo) MB; carga: $(cut -d' ' -f1-3 /proc/loadavg)"
  for n in mag-ai-ollama mag-ai-gateway; do
    if docker ps -a --format '{{.Names}}' | grep -qx "$n"; then log "aviso: o container $n já existe"; fi
  done
  servidor_folgado || log "aviso: servidor sem folga AGORA (os passos pesados vão esperar)"
  janela || log "aviso: fora da janela AGORA (os passos pesados vão recusar)"
  [ -f "$FOTOS/antes.cmp" ] || { mkdir -p "$FOTOS"; foto antes; }
  log "verificar: ok"
}

preparar() {
  [ -n "$PACOTE" ] && [ -f "$PACOTE/deploy/compose.yml" ] || falha "rode o preparar a partir da pasta do pacote enviado"
  [ -f "$FOTOS/antes.cmp" ] || falha "falta a foto 'antes' (rode o verificar)"
  log "preparar: início (pacote $PACOTE)"
  install -d -m 755 "$BASE" "$BASE/bin" "$BASE/config"
  install -d -m 700 "$SRV" "$SRV/docs" "$SRV/fotos" "$SRV/backups"

  local versao_gw
  versao_gw="0.1.0-$(cd "$PACOTE/gateway" && find src -type f -name '*.mjs' | sort | xargs cat package.json | sha256sum | cut -c1-10)"
  install -m 644 "$PACOTE/deploy/compose.yml" "$BASE/compose.yml"
  {
    sed -n 's/^\(OLLAMA_VERSION=.*\)$/\1/p;s/^\(MAG_AI_MODEL=.*\)$/\1/p' "$PACOTE/deploy/env.exemplo"
    echo "GATEWAY_VERSION=$versao_gw"
    echo "MAG_AI_PACOTE=$PACOTE"
  } > "$BASE/.env"
  chmod 644 "$BASE/.env"
  grep -q "^MAG_AI_MODEL=$MODELO$" "$BASE/.env" || falha "o env.exemplo não fixa $MODELO"

  if [ -f "$BASE/config/apps.json" ]; then
    log "apps.json já existe: chaves mantidas"
  else
    local k_biomie k_hml
    k_biomie="magai_biomie_$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n')"
    k_hml="magai_homologacao_$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n')"
    [ "${#k_biomie}" -eq 56 ] && [ "${#k_hml}" -eq 61 ] || falha "chave gerada com tamanho inesperado"
    {
      echo "# MAG AI — chaves das aplicações ($(date '+%F %T')). chmod 600."
      echo "# Nunca em repositório, log, relatório ou conversa. O gateway guarda só o SHA-256 (config/apps.json)."
      echo "biomie=$k_biomie"
      echo "homologacao=$k_hml"
    } > "$SRV/CREDENCIAIS.txt"
    chmod 600 "$SRV/CREDENCIAIS.txt"
    H_BIOMIE=$(printf '%s' "$k_biomie" | sha256sum | cut -d' ' -f1) \
    H_HML=$(printf '%s' "$k_hml" | sha256sum | cut -d' ' -f1) \
    python3 - "$PACOTE/deploy/apps.exemplo.json" "$BASE/config/apps.json" <<'PY'
import json, os, sys
modelo = json.load(open(sys.argv[1], encoding='utf-8'))
hashes = {'biomie': os.environ['H_BIOMIE'], 'homologacao': os.environ['H_HML']}
for app in modelo['apps']:
    app['key_sha256'] = hashes[app['id']]
with open(sys.argv[2], 'w', encoding='utf-8', newline='\n') as f:
    json.dump(modelo, f, ensure_ascii=False, indent=2)
    f.write('\n')
PY
    unset k_biomie k_hml
    chown root:10080 "$BASE/config/apps.json"
    chmod 640 "$BASE/config/apps.json"
    log "chaves geradas: biomie e homologacao (texto só em $SRV/CREDENCIAIS.txt)"
  fi

  install -m 700 "$PACOTE/ops/mag-ai.sh" "$BASE/bin/mag-ai.sh"
  install -m 700 "$PACOTE/ops/saude.py" "$BASE/bin/saude.py"
  install -m 600 "$PACOTE/srv/MANIFESTO.md" "$SRV/MANIFESTO.md"
  install -m 700 "$PACOTE/srv/backup.sh" "$SRV/backup.sh"
  install -m 700 "$PACOTE/srv/restore.sh" "$SRV/restore.sh"

  docker volume inspect "$VOLUME" >/dev/null 2>&1 || docker volume create --label "$ROTULO" "$VOLUME" >/dev/null
  if ! docker network inspect "$REDE_CLIENTE" >/dev/null 2>&1; then
    docker network create --internal -o "$SEM_ENDERECO" --label "$ROTULO" "$REDE_CLIENTE" >/dev/null
  fi
  [ "$(docker network inspect -f '{{.Internal}}' "$REDE_CLIENTE")" = true ] || falha "$REDE_CLIENTE existe mas não é interna"
  if ponte_tem_ip "$REDE_CLIENTE"; then log "aviso: a ponte de $REDE_CLIENTE ficou com endereço do servidor (a opção sem endereço não teve efeito)"
  else log "rede $REDE_CLIENTE: interna, vazia e sem endereço do servidor na ponte"; fi
  compose config -q || falha "compose.yml inválido"
  log "preparar: ok (gateway $versao_gw; volume $VOLUME)"
}

construir() {
  portao_pesado
  [ -n "$PACOTE" ] || falha "pacote desconhecido (rode o preparar)"
  local v gw
  v=$(env_valor OLLAMA_VERSION)
  gw=$(env_valor GATEWAY_VERSION)
  log "construir: mag-ai-ollama:$v-cpu (baixa o pacote oficial de ~1,5 GB e confere o SHA256)"
  docker build --label "$ROTULO" -t "mag-ai-ollama:$v-cpu" - < "$PACOTE/deploy/ollama/Dockerfile"
  local versao_lida
  versao_lida=$(docker run --rm --network none --entrypoint /usr/bin/ollama "mag-ai-ollama:$v-cpu" --version 2>&1 || true)
  printf '%s\n' "$versao_lida" >> "$LOG"
  grep -q "$v" <<< "$versao_lida" || falha "a imagem não respondeu com a versão $v"
  log "construir: mag-ai-gateway:$gw"
  docker build --label "$ROTULO" -t "mag-ai-gateway:$gw" -f "$PACOTE/deploy/gateway/Dockerfile" "$PACOTE"
  docker images --format '{{.Repository}}:{{.Tag}} {{.Size}}' | grep '^mag-ai-' | tee -a "$LOG" >&2 || true
  log "construir: ok"
}

modelo() {
  portao_pesado
  local v
  v=$(env_valor OLLAMA_VERSION)
  docker network inspect "$REDE_SAIDA" >/dev/null 2>&1 || docker network create --label "$ROTULO" "$REDE_SAIDA" >/dev/null
  log "modelo: baixando $MODELO por uma rede temporária ($REDE_SAIDA)"
  docker run --rm --name mag-ai-download --network "$REDE_SAIDA" --memory 1g --cpus 1 \
    --cap-drop ALL --security-opt no-new-privileges:true \
    -e OLLAMA_NO_CLOUD=1 -e OLLAMA_VULKAN=0 -e OLLAMA_HOST=127.0.0.1:11434 \
    -v "$VOLUME:/home/ollama/.ollama" --entrypoint /bin/sh "mag-ai-ollama:$v-cpu" -c "
      /usr/bin/ollama serve >/tmp/serve.log 2>&1 &
      for i in \$(seq 1 30); do /usr/bin/ollama list >/dev/null 2>&1 && break; sleep 1; done
      /usr/bin/ollama pull $MODELO
    " || { docker network rm "$REDE_SAIDA" >/dev/null 2>&1 || true; falha "download do modelo"; }
  docker network rm "$REDE_SAIDA" >/dev/null
  log "modelo: rede temporária removida; conferindo as camadas"
  local man
  man=$(mktemp)
  docker run --rm --network none -v "$VOLUME:/m:ro" --entrypoint /bin/cat "mag-ai-ollama:$v-cpu" "/m/$MANIFESTO_REL" > "$man"
  local sha
  sha=$(sha256sum "$man" | cut -d' ' -f1)
  if [ "$sha" = "$MANIFESTO_SHA" ]; then
    log "modelo: manifesto IDÊNTICO ao fixado ($MANIFESTO_SHA)"
  else
    log "aviso: manifesto com hash $sha (fixado: $MANIFESTO_SHA); conferindo camada a camada"
  fi
  python3 - "$man" $CAMADAS_FIXADAS <<'PY' || { rm -f "$man"; falha "as camadas do modelo não são as fixadas: NÃO usar"; }
import json, sys
m = json.load(open(sys.argv[1]))
tem = {layer['digest'] for layer in m.get('layers', [])}
faltam = [d for d in sys.argv[2:] if d not in tem]
if faltam:
    print('faltam camadas:', faltam, file=sys.stderr)
    sys.exit(1)
PY
  rm -f "$man"
  docker run --rm --network none -v "$VOLUME:/m:ro" --entrypoint /usr/bin/du "mag-ai-ollama:$v-cpu" -sh /m 2>&1 | tee -a "$LOG" >&2
  log "modelo: ok"
}

subir() {
  [ -f "$BASE/.env" ] || falha "rode o preparar"
  log "subir: iniciando os containers do mag-ai"
  compose up -d
  local i s1 s2
  for i in $(seq 1 60); do
    s1=$(docker inspect -f '{{.State.Health.Status}}' mag-ai-ollama 2>/dev/null || echo ausente)
    s2=$(docker inspect -f '{{.State.Health.Status}}' mag-ai-gateway 2>/dev/null || echo ausente)
    [ "$s1" = healthy ] && [ "$s2" = healthy ] && break
    sleep 2
  done
  [ "$s1" = healthy ] && [ "$s2" = healthy ] || falha "containers não ficaram saudáveis (ollama=$s1 gateway=$s2); para voltar: mag-ai.sh desfazer"
  [ -z "$(docker port mag-ai-ollama)" ] && [ -z "$(docker port mag-ai-gateway)" ] || falha "há porta publicada no servidor (não deveria)"
  if docker logs mag-ai-ollama 2>&1 | grep -qi 'cloud disabled: true'; then log "Ollama confirma no log: nuvem desligada"
  else log "aviso: o log do Ollama não mostrou 'cloud disabled: true'"; fi
  local r
  for r in "$REDE_INTERNA" "$REDE_CLIENTE"; do
    if ponte_tem_ip "$r"; then log "aviso: a ponte de $r tem endereço do servidor"; else log "rede $r: ponte sem endereço do servidor"; fi
  done

  cat > /etc/cron.d/mag-ai-saude <<'CRON'
# MAG AI — monitor de memória, CPU, fila e tempo de resposta (instalado por /opt/mag-ai/bin/mag-ai.sh)
*/5 * * * * root /usr/bin/flock -n /run/lock/mag-ai-saude.lock /usr/bin/python3 /opt/mag-ai/bin/saude.py >> /var/log/mag-ai-saude.log 2>&1
CRON
  cat > /etc/cron.d/mag-ai-backup <<'CRON'
# MAG AI — pacote diário de configuração e chaves (o modelo não entra: é baixado de novo e conferido)
12 4 * * * root /usr/local/bin/vps-backup-run mag-ai >> /var/log/vps-backup-mag-ai.log 2>&1
CRON
  cat > /etc/logrotate.d/mag-ai <<'ROT'
/var/log/mag-ai-saude.log /var/log/mag-ai-saude.csv /var/log/mag-ai-implantacao.log /var/log/vps-backup-mag-ai.log {
    monthly
    rotate 6
    compress
    missingok
    notifempty
}
ROT
  chmod 644 /etc/cron.d/mag-ai-saude /etc/cron.d/mag-ai-backup /etc/logrotate.d/mag-ai
  docker ps --filter name=mag-ai- --format '{{.Names}} {{.Status}}' | tee -a "$LOG" >&2
  log "subir: ok (monitor a cada 5 min; backup às 04:12)"
}

sondar() {  # $1 = rede, $2 = arquivo de saída, demais = argumentos da sonda
  local rede=$1 saida=$2
  shift 2
  docker run --rm --name "mag-ai-sonda-${rede#mag-ai_}" --network "$rede" --memory 128m --cpus 0.25 --read-only --tmpfs /tmp:size=16m \
    --cap-drop ALL --security-opt no-new-privileges:true \
    -v "$PACOTE/ops/sonda_rede.mjs:/t/sonda_rede.mjs:ro" "$NODE_IMG" node /t/sonda_rede.mjs "$@" > "$saida"
}

testar() {
  portao_pesado
  [ -f "$SRV/CREDENCIAIS.txt" ] || falha "sem credenciais (rode o preparar)"
  local stamp saida recursos envf alerta
  stamp=$(date +%Y%m%d-%H%M%S)
  saida="$SRV/docs/teste-$stamp.txt"
  recursos="$SRV/docs/teste-$stamp-recursos.csv"
  alerta="$SRV/docs/teste-$stamp-ALERTA.txt"
  log "testar: início"

  log "1/5 nenhuma porta do MAG AI no servidor e nenhuma credencial nos containers"
  [ -z "$(docker port mag-ai-ollama)" ] && [ -z "$(docker port mag-ai-gateway)" ] || falha "porta publicada"
  if curl -s --max-time 2 -o /dev/null http://127.0.0.1:11434/; then falha "algo responde em 127.0.0.1:11434"; fi
  local envs
  envs=$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' mag-ai-ollama mag-ai-gateway | cut -d= -f1 | sort -u | tr '\n' ' ')
  if printf '%s' "$envs" | grep -qiE 'PASS|SENHA|SECRET|TOKEN|DATABASE|DB_|MYSQL|MARIADB|OMIE|SUPABASE|JWT'; then falha "variável com cara de credencial: $envs"; fi
  log "variáveis dos containers (só nomes): $envs"
  log "montagens: $(docker inspect -f '{{.Name}}: {{range .Mounts}}{{.Destination}}({{if .RW}}gravável{{else}}só leitura{{end}}) {{end}}' mag-ai-ollama mag-ai-gateway | tr '\n' ' ')"

  log "2/5 sondas de rede: bancos, serviços do servidor, internet e outros projetos inalcançáveis"
  local portas_internas="3306 3307 5432 6379 8001 8080 3018 3019 3020 3030 3130 3140 3141 5678 8082 8083 11434 65529"
  local portas_publicas="22 80 443"
  local pub gwi gwc bloq rel nomes c ip porta
  pub=$(ip -4 route get 1.1.1.1 | awk '{for (i = 1; i < NF; i++) if ($i == "src") print $(i + 1)}')
  gwi=$(gateway_ipam "$REDE_INTERNA")
  gwc=$(gateway_ipam "$REDE_CLIENTE")
  bloq=""
  rel=""
  for ip in $gwi $gwc; do
    for porta in $portas_internas; do bloq="$bloq $ip:$porta"; done
  done
  for porta in $portas_internas $portas_publicas; do bloq="$bloq $pub:$porta"; done
  if ponte_tem_ip "$REDE_INTERNA" || ponte_tem_ip "$REDE_CLIENTE"; then
    log "aviso: alguma ponte do MAG AI tem endereço do servidor; 22/80/443 nela entram só como registro (já são públicas)"
    for ip in $gwi $gwc; do for porta in $portas_publicas; do rel="$rel $ip:$porta"; done; done
  else
    for ip in $gwi $gwc; do for porta in $portas_publicas; do bloq="$bloq $ip:$porta"; done; done
  fi
  for c in $(docker ps --format '{{.Names}} {{.Image}}' | awk '$2 ~ /(postgres:|mariadb|mysql|redis)/ {print $1}'); do
    case $c in *redis*) porta=6379 ;; *postgres*|*biomie-v2-db*) porta=5432 ;; *) porta=3306 ;; esac
    for ip in $(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' "$c"); do bloq="$bloq $ip:$porta"; done
  done
  nomes="biomie-v2-db-1 biomie-v2-web-1 biomie-v2-rest-1 biomie-v2-auth-1 scf-db-1 vsb-erpnext-db-1 vsb-cms-database-1 vsb-n8n-postgres-1"
  # shellcheck disable=SC2086
  sondar "$REDE_INTERNA" "$SRV/docs/sonda-interna-$stamp.txt" --bloqueados $bloq registry.ollama.ai:443 --relatar $rel \
    --nomes $nomes --esperados mag-ai-ollama:11434 mag-ai-gateway:8080 || { cat "$SRV/docs/sonda-interna-$stamp.txt" >&2; falha "isolamento da rede do Ollama"; }
  tail -1 "$SRV/docs/sonda-interna-$stamp.txt" | tee -a "$LOG" >&2
  # shellcheck disable=SC2086
  sondar "$REDE_CLIENTE" "$SRV/docs/sonda-biomie-$stamp.txt" --bloqueados $bloq mag-ai-ollama:11434 registry.ollama.ai:443 --relatar $rel \
    --nomes $nomes mag-ai-ollama --esperados mag-ai:8080 || { cat "$SRV/docs/sonda-biomie-$stamp.txt" >&2; falha "isolamento da rede do BIOMIE"; }
  tail -1 "$SRV/docs/sonda-biomie-$stamp.txt" | tee -a "$LOG" >&2

  log "3/5 testes de ponta a ponta pela rede do BIOMIE (dados fictícios), com vigia de memória do servidor"
  local id cg cpu0 cpu1
  id=$(docker inspect -f '{{.Id}}' mag-ai-ollama)
  cg=/sys/fs/cgroup/system.slice/docker-$id.scope
  [ -d "$cg" ] || falha "cgroup do Ollama não encontrado"
  cpu0=$(awk '/^usage_usec/{print $2}' "$cg/cpu.stat")
  echo "at,ollama_mem_mb,mem_disponivel_host_mb,load1" > "$recursos"
  ( trap - ERR; set +e
    while :; do
      livre=$(awk '/^MemAvailable:/{print int($2/1024)}' /proc/meminfo)
      printf '%s,%s,%s,%s\n' "$(date +%T)" "$(( $(cat "$cg/memory.current") / 1048576 ))" "$livre" "$(cut -d' ' -f1 /proc/loadavg)" >> "$recursos"
      if [ "$livre" -lt "$MEM_MINIMA_TESTE" ]; then
        echo "$(date '+%F %T') memória disponível do servidor em $livre MB (< $MEM_MINIMA_TESTE): teste interrompido" > "$alerta"
        docker kill mag-ai-teste >/dev/null 2>&1
      fi
      sleep 2
    done ) &
  local amostrador=$!
  envf=$(mktemp)
  chmod 600 "$envf"
  {
    echo "MAG_AI_URL=http://mag-ai:8080"
    echo "MAG_AI_KEY_HOMOLOGACAO=$(chave_de homologacao)"
    echo "MAG_AI_KEY_BIOMIE=$(chave_de biomie)"
  } > "$envf"
  local rc=0
  docker run --rm --name mag-ai-teste --network "$REDE_CLIENTE" --memory 256m --cpus 0.5 --read-only --tmpfs /tmp:size=16m \
    --cap-drop ALL --security-opt no-new-privileges:true \
    --env-file "$envf" -v "$PACOTE/ops/teste_cliente.mjs:/t/teste_cliente.mjs:ro" "$NODE_IMG" \
    node /t/teste_cliente.mjs > "$saida" || rc=$?
  rm -f "$envf"
  kill "$amostrador" 2>/dev/null || true
  cpu1=$(awk '/^usage_usec/{print $2}' "$cg/cpu.stat")

  log "4/5 consumo"
  local pico atual
  pico=$(( $(cat "$cg/memory.peak") / 1048576 ))
  atual=$(( $(cat "$cg/memory.current") / 1048576 ))
  log "Ollama: pico de memória ${pico} MB (limite 2560); agora ${atual} MB; CPU nos testes $(( (cpu1 - cpu0) / 1000000 )) s"
  awk -F, 'NR>1{ if(min==""||$3<min)min=$3; if($4>max)max=$4 } END{printf "servidor durante os testes: memória disponível mínima %s MB; carga de 1 min máxima %s\n", min, max}' "$recursos" | tee -a "$LOG" >&2

  log "5/5 resultado"
  [ ! -f "$alerta" ] || falha "$(cat "$alerta") — para voltar: mag-ai.sh desfazer"
  log "resultado detalhado: $saida"
  grep -E '^(OK|FALHA)' "$saida" | tee -a "$LOG" >&2 || true
  [ "$rc" -eq 0 ] || falha "testes de ponta a ponta com falha (ver $saida)"
  log "testar: ok"
}

desfazer() {
  log "desfazer: derrubando os containers do mag-ai (volume, redes externas e imagens ficam)"
  rm -f /etc/cron.d/mag-ai-saude /etc/cron.d/mag-ai-backup
  if [ -f "$BASE/compose.yml" ] && [ -f "$BASE/.env" ]; then compose down --timeout 20; fi
  docker rm -f mag-ai-download mag-ai-teste mag-ai-sonda-interna mag-ai-sonda-biomie >/dev/null 2>&1 || true
  docker network rm "$REDE_SAIDA" >/dev/null 2>&1 || true
  log "desfazer: ok — compare com: mag-ai.sh comparar antes depois-desfazer"
}

ensaiar_reversao() {
  log "ensaio de reversão: desfazer → conferir → subir de novo"
  local t0 t1
  t0=$(date +%s)
  desfazer
  t1=$(date +%s)
  log "reversão concluída em $((t1 - t0)) s"
  comparar antes depois-desfazer || falha "a reversão deixou diferenças fora do MAG AI (ver $FOTOS/diferencas-antes-depois-desfazer.txt)"
  subir
  log "ensaio de reversão: ok (voltar levou $((t1 - t0)) s; reinstalado e saudável)"
}

remover() {
  case " $* " in *" --confirmo "*) ;; *) falha "remover apaga volume, redes, imagens e pastas do mag-ai: repita com --confirmo" ;; esac
  desfazer
  local usando
  usando=$(docker network inspect -f '{{range .Containers}}{{.Name}} {{end}}' "$REDE_CLIENTE" 2>/dev/null || true)
  if [ -n "${usando// /}" ]; then
    log "aviso: a rede $REDE_CLIENTE ainda tem containers ($usando): fica (tire a dependência do BIOMIE antes)"
  else
    docker network rm "$REDE_CLIENTE" >/dev/null 2>&1 || true
  fi
  docker volume rm "$VOLUME" >/dev/null 2>&1 || true
  docker images --format '{{.Repository}}:{{.Tag}}' | grep -E '^mag-ai-(ollama|gateway):' | xargs -r docker rmi >/dev/null || true
  rm -f /etc/logrotate.d/mag-ai
  local guarda
  guarda=/root/backups/mag-ai-removido-$(date +%Y%m%d-%H%M%S)
  mkdir -p /root/backups
  [ -d "$SRV" ] && mv "$SRV" "$guarda"
  rm -rf "$BASE"
  log "remover: ok — documentos, fotos e credenciais guardados em $guarda (apagar quando não precisar mais)"
}

# ---------- Análise profunda (16/11/2026): segundo modelo, de raciocínio, para a tarefa "analisar" ----------

env_set() {
  case $1 in GATEWAY_VERSION|MAG_AI_MODEL_ANALISE) ;; *) falha "env_set só aceita GATEWAY_VERSION e MAG_AI_MODEL_ANALISE";; esac
  if grep -q "^$1=" "$BASE/.env"; then sed -i "s|^$1=.*|$1=$2|" "$BASE/.env"; else printf '%s=%s\n' "$1" "$2" >> "$BASE/.env"; fi
  log "env: $1=$2"
}

preparar_analise() {
  [ -n "$PACOTE" ] && [ -f "$PACOTE/deploy/compose.yml" ] || falha "rode da pasta do pacote novo"
  [ -f "$BASE/.env" ] || falha "MAG AI não está preparado (rode o preparar da Fase 3 antes)"
  local gw
  gw=$(python3 -c "import json;print(json.load(open('$PACOTE/gateway/package.json'))['version'])") || falha "versão do gateway ilegível"
  install -m 600 "$PACOTE/deploy/compose.yml" "$BASE/compose.yml"
  env_set GATEWAY_VERSION "$gw"
  env_set MAG_AI_MODEL_ANALISE "${2:-deepseek-r1:1.5b}"
  python3 - "$BASE/config/apps.json" <<'PY' || falha "apps.json: não consegui liberar a tarefa analisar"
import json, os, sys
p = sys.argv[1]
d = json.load(open(p, encoding='utf-8'))
for a in d.get('apps', []):
    tarefas = a.setdefault('tasks', [])
    if 'analisar' not in tarefas:
        tarefas.append('analisar')
    a['timeout_s'] = 200
    a['max_output_tokens'] = 1000
tmp = p + '.novo'
with open(tmp, 'w', encoding='utf-8') as fh:
    json.dump(d, fh, indent=2, ensure_ascii=False)
    fh.write('\n')
os.replace(tmp, p)
PY
  chown root:10080 "$BASE/config/apps.json"
  chmod 640 "$BASE/config/apps.json"
  log "preparar-analise: ok (compose novo, gateway $gw, tarefa analisar liberada nas aplicações)"
}

modelo_analise() {
  portao_pesado
  local v tag
  v=$(env_valor OLLAMA_VERSION)
  tag=$(env_valor MAG_AI_MODEL_ANALISE)
  [ -n "$tag" ] || falha "defina MAG_AI_MODEL_ANALISE no .env (rode o preparar-analise)"
  docker network inspect "$REDE_SAIDA" >/dev/null 2>&1 || docker network create --label "$ROTULO" "$REDE_SAIDA" >/dev/null
  log "modelo-analise: baixando $tag por uma rede temporária ($REDE_SAIDA)"
  docker run --rm --name mag-ai-download --network "$REDE_SAIDA" --memory 1g --cpus 1 \
    --cap-drop ALL --security-opt no-new-privileges:true \
    -e OLLAMA_NO_CLOUD=1 -e OLLAMA_VULKAN=0 -e OLLAMA_HOST=127.0.0.1:11434 \
    -v "$VOLUME:/home/ollama/.ollama" --entrypoint /bin/sh "mag-ai-ollama:$v-cpu" -c "
      /usr/bin/ollama serve >/tmp/serve.log 2>&1 &
      for i in \$(seq 1 30); do /usr/bin/ollama list >/dev/null 2>&1 && break; sleep 1; done
      /usr/bin/ollama pull $tag
    " || { docker network rm "$REDE_SAIDA" >/dev/null 2>&1 || true; falha "download do modelo de análise"; }
  docker network rm "$REDE_SAIDA" >/dev/null
  # 1ª instalação deste modelo: o manifesto baixado do registro oficial (TLS) vira o REGISTRADO.
  local rel man
  rel="models/manifests/registry.ollama.ai/library/${tag%%:*}/${tag#*:}"
  man=$(mktemp)
  docker run --rm --network none -v "$VOLUME:/m:ro" --entrypoint /bin/cat "mag-ai-ollama:$v-cpu" "/m/$rel" > "$man" \
    || { rm -f "$man"; falha "manifesto do modelo de análise não encontrado ($rel)"; }
  {
    echo "modelo=$tag"
    echo "manifesto=$rel"
    echo "sha256=$(sha256sum "$man" | cut -d' ' -f1)"
    python3 - "$man" <<'PY'
import json, sys
m = json.load(open(sys.argv[1]))
for layer in m.get('layers', []):
    print(f"camada={layer['digest']} bytes={layer.get('size', 0)}")
PY
  } | tee "$SRV/docs/modelo-analise-manifesto.txt" >&2
  chmod 600 "$SRV/docs/modelo-analise-manifesto.txt"
  rm -f "$man"
  docker run --rm --network none -v "$VOLUME:/m:ro" --entrypoint /usr/bin/du "mag-ai-ollama:$v-cpu" -sh /m 2>&1 | tee -a "$LOG" >&2
  log "modelo-analise: ok (manifesto registrado em $SRV/docs/modelo-analise-manifesto.txt)"
}

passo=${1:-}
case $passo in
  checklist) checklist ;;
  preparar-analise) preparar_analise "$@" ;;
  modelo-analise) modelo_analise ;;
  verificar) verificar ;;
  preparar) preparar ;;
  construir) construir ;;
  modelo) modelo ;;
  subir) subir ;;
  testar) testar ;;
  ensaiar-reversao) ensaiar_reversao ;;
  foto) foto "${2:?nome da foto}" ;;
  comparar) comparar "${2:-antes}" "${3:-depois}" ;;
  desfazer) desfazer ;;
  remover) shift; remover "$@" ;;
  *) sed -n '2,23p' "$0"; exit 2 ;;
esac
