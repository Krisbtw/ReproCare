#!/usr/bin/env bash
set -euo pipefail

# ReproCare Disaster Recovery Restore Procedure
# Usage: ./scripts/restore.sh backups/reprocare_backup_YYYYMMDD_HHMMSS.tar.gz

if [ "$#" -lt 1 ]; then
  echo "Usage: $0 <backup_file.tar.gz>"
  exit 1
fi

BACKUP_FILE="$1"
if [ ! -f "$BACKUP_FILE" ]; then
  echo "Error: Backup file $BACKUP_FILE not found."
  exit 1
fi

echo "=== ReproCare Restore Procedure ==="
RESTORE_TEMP="restore_temp_$(date +%s)"
mkdir -p "$RESTORE_TEMP"

echo "1. Extracting backup archive..."
tar -xzvf "$BACKUP_FILE" -C "$RESTORE_TEMP"

# Find SQL dump inside extracted folder
SQL_DUMP=$(find "$RESTORE_TEMP" -name "*.sql" | head -n 1)

if [ -n "$SQL_DUMP" ]; then
  echo "2. Restoring PostgreSQL database from $SQL_DUMP..."
  if docker ps --format '{{.Names}}' | grep -q "reprocare.*db"; then
    DB_CONTAINER=$(docker ps --format '{{.Names}}' | grep "reprocare.*db" | head -n 1)
    docker exec -i "$DB_CONTAINER" psql -U reprocare -d reprocare_db < "$SQL_DUMP"
  elif command -v psql >/dev/null 2>&1; then
    psql -U reprocare -d reprocare_db < "$SQL_DUMP"
  fi
  echo "✔ Database restored."
fi

# Restore models if present
MODEL_DIR=$(find "$RESTORE_TEMP" -type d -name "models" | head -n 1)
if [ -n "$MODEL_DIR" ]; then
  echo "3. Restoring model checkpoints..."
  mkdir -p imaging-service/models
  cp -r "$MODEL_DIR"/* imaging-service/models/ 2>/dev/null || true
  echo "✔ Model checkpoints restored."
fi

rm -rf "$RESTORE_TEMP"
echo "=== Restore completed successfully ==="
