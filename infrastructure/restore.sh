#!/usr/bin/env bash
# Usage: DATABASE_URL=<EMPTY target db> ./restore.sh backups/file.dump
set -euo pipefail
pg_restore --clean --if-exists --no-owner --dbname="$DATABASE_URL" "$1"
echo "Restored. Run: npm run migrate (no-op if schema is current) and verify with docs/BACKUP.md checklist."
