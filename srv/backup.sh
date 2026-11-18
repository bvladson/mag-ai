#!/bin/sh
# Projeto mag-ai — pacote diário (configuração + chaves). Ver /srv/mag-ai/MANIFESTO.md.
# Contrato com vps-backup-run: imprime SOMENTE o caminho do pacote no stdout (mensagens vão para o stderr).
# O modelo (~1 GB) NÃO entra: a restauração baixa de novo e confere as camadas fixadas (mag-ai.sh modelo).
# O pacote contém as chaves das aplicações: fica chmod 600.
set -eu
umask 077
OUT=/srv/mag-ai/backups
STAMP=$(date +%Y%m%d-%H%M%S)
WORK=$(mktemp -d /tmp/mag-ai-backup.XXXXXX)
trap 'rm -rf "$WORK"' EXIT
P=$WORK/pacote
mkdir -p "$OUT" "$P/srv-mag-ai" "$P/sistema"

# 1) Configuração, fontes da versão instalada e scripts (compose, .env, apps.json só com hashes, build/).
cp -a /opt/mag-ai "$P/opt-mag-ai"

# 2) Manifesto, documentos e chaves.
for f in MANIFESTO.md backup.sh restore.sh CREDENCIAIS.txt; do
  if [ -f "/srv/mag-ai/$f" ]; then cp -a "/srv/mag-ai/$f" "$P/srv-mag-ai/"; fi
done
if [ -d /srv/mag-ai/docs ]; then cp -a /srv/mag-ai/docs "$P/srv-mag-ai/docs"; fi

# 3) Arquivos de sistema do projeto.
for f in /etc/cron.d/mag-ai-saude /etc/cron.d/mag-ai-backup /etc/logrotate.d/mag-ai; do
  if [ -f "$f" ]; then cp -a "$f" "$P/sistema/"; fi
done
docker image ls --format '{{.Repository}}:{{.Tag}} {{.ID}}' | grep '^mag-ai-' > "$P/IMAGENS.txt" || true

PKG=$OUT/mag-ai-$STAMP.tar.gz
tar -C "$WORK" -czf "$PKG" pacote
chmod 600 "$PKG"
echo "$PKG"
