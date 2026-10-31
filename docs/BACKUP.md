# Backup & restore
```bash
DATABASE_URL=postgres://... infrastructure/backup.sh        # custom-format dump in backups/
createdb sms_restore_test
DATABASE_URL=postgres://.../sms_restore_test infrastructure/restore.sh backups/<file>.dump
```
Verification checklist after a restore (do this on a schedule, an untested backup is not a backup):
1. `SELECT count(*) FROM operations;` equals production.
2. `SELECT count(*) FROM stock_movements;` equals production.
3. Owner report summary for a closed month equals the pre-backup figures.
4. Triggers present: `\d stock_movements` shows `stock_movements_immutable`.
Encrypt dumps and store off-site. This procedure has NOT been executed in this sandbox (no PostgreSQL).
