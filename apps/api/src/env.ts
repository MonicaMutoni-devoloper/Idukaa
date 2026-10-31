// Loads apps/api/.env (relative to the workspace cwd) into process.env at import time.
// Uses Node's built-in loader (Node >= 20.12) so no dotenv dependency is needed.
// Existing environment variables are NOT overridden, so real env always wins.
try {
  process.loadEnvFile();
} catch {
  /* no .env file present — rely on the ambient environment */
}
