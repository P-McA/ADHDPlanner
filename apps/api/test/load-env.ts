import 'reflect-metadata';

// main.ts loads apps/api/.env at bootstrap, but the e2e suite constructs the
// app itself and never runs main.ts — without this, PrismaService would find no
// DATABASE_URL and throw before a single test ran.
try {
  process.loadEnvFile();
} catch {
  // Already in the ambient environment (CI), which is equally fine.
}

// No app built by this suite may consume the `audio-ingestion` queue. The
// pipeline tests drive AudioIngestionProcessor directly and then assert what
// state a record is in; a live consumer picking the same job up would make
// every one of those assertions a race. Set before any module is imported,
// because the worker reads it in onModuleInit.
process.env.INGESTION_WORKER_DISABLED = 'true';

// A developer's real key must never be spent by the e2e suite. The AI ports
// are overridden with fakes there, so this is belt and braces: if an override
// is ever missed, the adapter throws "OPENAI_API_KEY is not set" instead of
// quietly billing someone for a test run.
delete process.env.OPENAI_API_KEY;
