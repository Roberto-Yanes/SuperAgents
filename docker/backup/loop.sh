#!/usr/bin/env bash
# Lanza backup.sh cada día a BACKUP_AT (HH:MM, UTC; por defecto 03:15). Un fallo se registra y se reintenta al día siguiente.
set -uo pipefail
at="${BACKUP_AT:-03:15}"
while true; do
  now=$(date -u +%s)
  next=$(date -u -d "today $at" +%s)
  [ "$next" -le "$now" ] && next=$(date -u -d "tomorrow $at" +%s)
  echo "[backup] próxima copia: $(date -u -d "@$next" '+%F %R') UTC"
  sleep $((next - now))
  backup.sh || echo "[backup] ERROR: la copia falló" >&2
done
