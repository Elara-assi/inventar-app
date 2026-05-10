#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 3 ]]; then
  echo "Nutzung: $0 /opt/stacks/inventar-app /pfad/db.dump /pfad/uploads.tgz" >&2
  exit 2
fi

ROOT_DIR="$1"
DB_DUMP="$2"
UPLOADS_ARCHIVE="$3"

cd "$ROOT_DIR"
test -f "$DB_DUMP"
test -f "$UPLOADS_ARCHIVE"

docker compose exec -T postgres dropdb -U inventar --if-exists inventar
docker compose exec -T postgres createdb -U inventar inventar
docker compose exec -T postgres pg_restore -U inventar -d inventar --clean --if-exists < "$DB_DUMP"

mkdir -p storage
tar -C "$ROOT_DIR" -xzf "$UPLOADS_ARCHIVE"

echo "Restore abgeschlossen. Bitte API/Web neu starten und /health prüfen."
