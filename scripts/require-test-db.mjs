// Guard for the API integration suite (`npm run test:api`).
//
// Every API test file wipes (DROP SCHEMA public) and re-migrates the database named in
// TEST_DATABASE_URL, and skips itself silently when the variable is unset. A silent skip
// looks like a green run, so the root command refuses to start without the variable and
// never falls back to the development DATABASE_URL.
const url = process.env.TEST_DATABASE_URL;

if (!url) {
  console.error(
    [
      "",
      "TEST_DATABASE_URL is not set — refusing to run the API integration suite.",
      "",
      "The suite DROPs the `public` schema and re-applies all migrations in the database",
      "it points at, so it must target a dedicated throwaway database (never your",
      "development database, DATABASE_URL). Create one and point the variable at it:",
      "",
      "  bash:",
      "    createdb sms_test    # or: psql -c \"CREATE DATABASE sms_test\"",
      "    TEST_DATABASE_URL=postgres://user:pass@localhost:5432/sms_test npm run test:api",
      "",
      "  PowerShell:",
      "    createdb sms_test",
      '    $env:TEST_DATABASE_URL = "postgres://user:pass@localhost:5432/sms_test"; npm run test:api',
      "",
      "(To run the suite without a database and accept skipped tests, invoke the workspace",
      " directly: npm run test -w @sms/api)",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

if (!/^postgres(ql)?:\/\//.test(url)) {
  console.error(
    `TEST_DATABASE_URL must be a postgres:// URL (got ${JSON.stringify(url.slice(0, 40))}).`,
  );
  process.exit(1);
}
