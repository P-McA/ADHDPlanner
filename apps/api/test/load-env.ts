import 'reflect-metadata';

// main.ts loads apps/api/.env at bootstrap, but the e2e suite constructs the
// app itself and never runs main.ts — without this, PrismaService would find no
// DATABASE_URL and throw before a single test ran.
try {
  process.loadEnvFile();
} catch {
  // Already in the ambient environment (CI), which is equally fine.
}
