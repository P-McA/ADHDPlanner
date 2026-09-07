import { defineConfig, env } from 'prisma/config';

/**
 * Prisma 7 moved the connection URL out of schema.prisma and into this file;
 * `datasource.url` is what the migrate/introspect commands read. The runtime
 * client gets its connection separately, via the pg driver adapter in
 * src/prisma/prisma.service.ts.
 *
 * Prisma 7 also stopped auto-loading .env. Node's built-in loader covers it
 * without pulling in dotenv; deployed environments supply real env vars and
 * have no .env file, hence the tolerated failure.
 */
try {
  process.loadEnvFile();
} catch {
  // No .env present — rely on the ambient environment.
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: {
    url: env('DATABASE_URL'),
  },
});
