#!/bin/sh
# Projeto mag-ai — restaura um pacote do backup.sh numa VPS sem o projeto. Precisa de internet
# (imagem base, pacote oficial do Ollama e modelo; o modelo é conferido pelas camadas fixadas).
# Uso: restore.sh /caminho/mag-ai-AAAAMMDD-HHMMSS.tar.gz
set -eu
PKG=${1:?uso: restore.sh <pacote.tar.gz>}
if [ -d /opt/mag-ai ]; then
  echo "ERRO: /opt/mag-ai já existe (rode 'mag-ai.sh remover --confirmo' antes ou restaure em outra VPS)" >&2
  exit 1
fi
WORK=$(mktemp -d /tmp/mag-ai-restore.XXXXXX)
trap 'rm -rf "$WORK"' EXIT
tar -C "$WORK" -xzf "$PKG"

cp -a "$WORK/pacote/opt-mag-ai" /opt/mag-ai
mkdir -p /srv/mag-ai
chmod 700 /srv/mag-ai
cp -a "$WORK/pacote/srv-mag-ai/." /srv/mag-ai/
for f in "$WORK"/pacote/sistema/*; do
  case $(basename "$f") in
    mag-ai-saude|mag-ai-backup) cp -a "$f" /etc/cron.d/ ;;
    mag-ai) cp -a "$f" /etc/logrotate.d/ ;;
  esac
done

PACOTE=$(sed -n 's/^MAG_AI_PACOTE=//p' /opt/mag-ai/.env)
[ -f "$PACOTE/deploy/compose.yml" ] || { echo "ERRO: fontes ausentes em $PACOTE" >&2; exit 1; }

docker volume inspect mag-ai_modelos >/dev/null 2>&1 || docker volume create --label br.com.mag.projeto=mag-ai mag-ai_modelos >/dev/null
docker network inspect mag-ai_biomie >/dev/null 2>&1 || docker network create --internal --label br.com.mag.projeto=mag-ai mag-ai_biomie >/dev/null

bash "$PACOTE/ops/mag-ai.sh" foto antes-restauracao
bash "$PACOTE/ops/mag-ai.sh" construir --fora-da-janela="restauração"
bash "$PACOTE/ops/mag-ai.sh" modelo --fora-da-janela="restauração"
bash "$PACOTE/ops/mag-ai.sh" subir
echo "restaurado. Conferir: bash $PACOTE/ops/mag-ai.sh testar --fora-da-janela=\"conferência da restauração\"" >&2
