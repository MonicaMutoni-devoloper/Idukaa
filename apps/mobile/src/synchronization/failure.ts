/**
 * How a failed push is described on the sync screen.
 *
 * The API answers 503 `schema_out_of_date` (with the migration file to apply) when the server's
 * database is older than its code — a deployment state, not a problem with the user's record.
 * That distinction has to survive the round trip: storing `server_503` alone made an out-of-date
 * server look like a broken sale and told the user nothing. The stored outbox `message` stays a
 * stable code (`schema_out_of_date:<file>`) so the screen can translate it; only the screen renders
 * words, never the database layer.
 *
 * Kept free of React Native imports so the mapping can be tested on plain Node.
 */
export const SCHEMA_OUT_OF_DATE = "schema_out_of_date";

/** The `message` stored on outbox rows that will be retried after this failure. */
export function failureMessage(status: number, body: unknown): string {
  const b = body as { error?: unknown; migration?: unknown } | null;
  if (status === 503 && b?.error === SCHEMA_OUT_OF_DATE) {
    const file = typeof b.migration === "string" ? b.migration.trim() : "";
    return file ? `${SCHEMA_OUT_OF_DATE}:${file}` : SCHEMA_OUT_OF_DATE;
  }
  return `server_${status}`;
}

/** Read a stored retry message: `null` unless the server database was out of date. */
export function schemaOutOfDate(message: string | null | undefined): { migration: string | null } | null {
  if (message === SCHEMA_OUT_OF_DATE) return { migration: null };
  const prefix = `${SCHEMA_OUT_OF_DATE}:`;
  if (message?.startsWith(prefix)) return { migration: message.slice(prefix.length) || null };
  return null;
}
