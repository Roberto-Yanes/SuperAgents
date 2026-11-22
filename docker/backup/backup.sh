#!/usr/bin/env bash
# Copia de seguridad cifrada: pg_dump (formato custom) + archivos de DATA_DIR, en un único .tar cifrado
# con AES-256 (openssl, PBKDF2). Rota las copias de más de BACKUP_KEEP_DAYS días.
#
# Variables:
#   BACKUP_PASSPHRASE   obligatoria. Guárdala aparte (sin ella la copia no se puede abrir).
#   DATABASE_URL        o las variables PG* estándar (PGHOST, PGUSER, PGPASSWORD, PGDATABASE).
#   DATA_DIR            directorio de archivos a copiar (por defecto /data). Si no existe, se omite.
#   BACKUP_DIR          destino (por defecto /backups).
#   BACKUP_KEEP_DAYS    días que se conservan (por defecto 14).
#   BACKUP_REMOTE_CMD   opcional: comando que recibe la ruta de la copia en $1 (rclone, rsync, scp...).
#
# Las copias cifradas no contienen SECRET_KEY: guárdala también aparte, la necesitan las credenciales
# de las conexiones y los archivos del vault.
set -euo pipefail

: "${BACKUP_PASSPHRASE:?define BACKUP_PASSPHRASE}"
DATA_DIR="${DATA_DIR:-/data}"
BACKUP_DIR="${BACKUP_DIR:-/backups}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
command -v pg_dump >/dev/null || { echo "falta pg_dump" >&2; exit 1; }
command -v openssl >/dev/null || { echo "falta openssl" >&2; exit 1; }

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
umask 077
mkdir -p "$BACKUP_DIR"

echo "[backup] volcando la base de datos"
if [ -n "${DATABASE_URL:-}" ]; then pg_dump --format=custom --no-owner --file="$work/db.dump" "$DATABASE_URL"
else pg_dump --format=custom --no-owner --file="$work/db.dump"; fi

if [ -d "$DATA_DIR" ]; then
  echo "[backup] empaquetando $DATA_DIR"
  tar -C "$DATA_DIR" -cf "$work/data.tar" .
fi
printf '{"createdAt":"%s","format":1}\n' "$stamp" > "$work/manifest.json"

out="$BACKUP_DIR/ega-$stamp.tar.enc"
tar -C "$work" -cf - . | openssl enc -aes-256-cbc -salt -pbkdf2 -iter 200000 -pass env:BACKUP_PASSPHRASE -out "$out.part"
mv "$out.part" "$out"
( cd "$BACKUP_DIR" && sha256sum "$(basename "$out")" > "$(basename "$out").sha256" )
echo "[backup] $out ($(du -h "$out" | cut -f1))"

find "$BACKUP_DIR" -maxdepth 1 -name 'ega-*.tar.enc*' -type f -mtime +"$KEEP_DAYS" -print -delete | sed 's/^/[backup] rotada: /'

if [ -n "${BACKUP_REMOTE_CMD:-}" ]; then
  echo "[backup] copia remota"
  sh -c "$BACKUP_REMOTE_CMD" -- "$out"
fi
