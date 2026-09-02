/**
 * Loads .env for the standalone worker and scripts.
 *
 * Next.js does this for the web process on its own; nothing outside Next gets
 * that for free, so anything with its own entrypoint calls this first.
 */
export function loadEnv(): void {
  try {
    process.loadEnvFile('.env');
  } catch {
    // No .env file — env vars may still come from the shell or docker-compose.
  }
}
