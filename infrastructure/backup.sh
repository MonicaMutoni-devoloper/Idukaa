#!/usr/bin/env bash
# Usage: DATABASE_URL=... ./backup.sh  -> writes backups/sms-<timestamp>.dump
set -euo pipefail
mkdir -p backups
f="backups/sms-$(date +%Y%m%d-%H%M%S).dump"
pg_dump --format=custom --file="$f" "$DATABASE_URL"
echo "Backup written: $f (store it encrypted, off-site)"
