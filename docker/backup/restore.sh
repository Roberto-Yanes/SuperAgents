#!/usr/bin/env bash
# Restaura una copia de backup.sh. DESTRUCTIVO: reemplaza el contenido de la base de datos destino y de DATA_DIR.
#
# Uso: BACKUP_PASSPHRASE=... restore.sh <copia.tar.enc> --yes [--db-only|--files-only]
#   DATABASE_URL (o PG*) apunta a la base destino; DATA_DIR al directorio de archivos destino.
#   Para probar sin tocar producción: restaura en otra base (p. ej. ega_restore) y otro DATA_DIR.
set -euo pipefail

file="${1:-}"; shift || true
confirm=""; mode="all"
for a in "$@"; do
  case "$a" in
    --yes) confirm=1 ;;
    --db-only) mode="db" ;;
    --files-only) mode="files" ;;
    *) echo "opción desconocida: $a" >&2; exit 2 ;;
  esac
done
[ -f "$file" ] || { echo "Uso: restore.sh <copia.tar.enc> --yes [--db-only|--files-only]" >&2; exit 2; }
: "${BACKUP_PASSPHRASE:?define BACKUP_PASSPHRASE}"
[ -n "$confirm" ] || { echo "Esto reemplaza la base de datos y los archivos destino. Repite con --yes." >&2; exit 2; }
DATA_DIR="${DATA_DIR:-/data}"

if [ -f "$file.sha256" ]; then ( cd "$(dirname "$file")" && sha256sum -c "$(basename "$file").sha256" ); fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:BACKUP_PASSPHRASE -in "$file" -out "$work/payload.tar" 2>/dev/null \
  || { echo "[restore] no se pudo descifrar: frase incorrecta o copia dañada" >&2; exit 1; }
tar -C "$work" -xf "$work/payload.tar" && rm -f "$work/payload.tar"
echo "[restore] copia: $(cat "$work/manifest.json")"

if [ "$mode" != "files" ]; then
  echo "[restore] base de datos"
  if [ -n "${DATABASE_URL:-}" ]; then pg_restore --clean --if-exists --no-owner --single-transaction --dbname="$DATABASE_URL" "$work/db.dump"
  else pg_restore --clean --if-exists --no-owner --single-transaction --dbname="${PGDATABASE:?}" "$work/db.dump"; fi
fi
if [ "$mode" != "db" ] && [ -f "$work/data.tar" ]; then
  echo "[restore] archivos en $DATA_DIR"
  mkdir -p "$DATA_DIR"
  find "$DATA_DIR" -mindepth 1 -delete
  tar -C "$DATA_DIR" -xf "$work/data.tar"
fi
echo "[restore] listo"
