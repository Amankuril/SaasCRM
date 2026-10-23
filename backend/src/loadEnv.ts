// Imported first by entry points so `.env` is loaded before config is parsed.
try {
  process.loadEnvFile();
} catch {
  // No .env file: rely on the real environment.
}
