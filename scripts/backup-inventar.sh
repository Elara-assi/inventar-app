#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${1:-/opt/stacks/inventar-app}"
BACKUP_DIR="${BACKUP_DIR:-$ROOT_DIR/backups}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

cd "$ROOT_DIR"
mkdir -p "$BACKUP_DIR"

docker compose exec -T postgres pg_dump -U inventar -d inventar --format=custom > "$BACKUP_DIR/inventar-db-$STAMP.dump"
tar -C "$ROOT_DIR" -czf "$BACKUP_DIR/inventar-uploads-$STAMP.tgz" storage/uploads

find "$BACKUP_DIR" -type f -name 'inventar-db-*.dump' -mtime +14 -delete
find "$BACKUP_DIR" -type f -name 'inventar-uploads-*.tgz' -mtime +14 -delete

echo "Backup geschrieben:"
echo "$BACKUP_DIR/inventar-db-$STAMP.dump"
echo "$BACKUP_DIR/inventar-uploads-$STAMP.tgz"
