#!/bin/sh
# Richtet die Rechte des Datenordners ein und startet die App ohne root-Rechte.
set -eu

DATA_DIR=$(dirname "${DB_PATH:-/data/gewicht.db}")

# Läuft der Container bereits ohne root (z. B. mit "user:" in Compose), gibt es nichts zu tun.
if [ "$(id -u)" != "0" ]; then
  exec "$@"
fi

mkdir -p "$DATA_DIR"

# Nur ändern, wenn nötig, damit der Start auch bei vielen Dateien schnell bleibt.
if [ -n "$(find "$DATA_DIR" \( ! -user node -o ! -group node \) -print -quit 2>/dev/null || true)" ]; then
  if ! chown -R node:node "$DATA_DIR" 2>/dev/null; then
    echo "Warnung: Die Rechte von $DATA_DIR konnten nicht automatisch gesetzt werden." >&2
  fi
fi

if ! setpriv --reuid=node --regid=node --init-groups sh -c 'test -w "$1" && test -x "$1"' sh "$DATA_DIR"; then
  echo "Fehler: $DATA_DIR ist für Benutzer 1000 nicht beschreibbar." >&2
  echo "Bei NAS- oder Netzwerkfreigaben bitte die Rechte dort für UID 1000 freigeben." >&2
  echo "Unter SELinux den Mount in Compose als ./data:/data:z eintragen." >&2
  exit 1
fi

exec setpriv --reuid=node --regid=node --init-groups "$@"
