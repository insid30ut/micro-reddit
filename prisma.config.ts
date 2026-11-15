import 'dotenv/config';
import { defineConfig } from 'prisma/config';

const isStrictProduction =
  process.env.NODE_ENV === 'production' || process.env.APP_MODE === 'live';
const migrationUrl = process.env.DIRECT_URL ?? process.env.DATABASE_URL;

if (isStrictProduction && !migrationUrl) {
  throw new Error(
    'DIRECT_URL (or DATABASE_URL) must be explicitly configured in production/live mode; no local fallback.'
  );
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    // Local fallback applies only to non-production development (e.g. `prisma generate` in CI).
    url:
      migrationUrl ??
      'postgresql://postgres:postgres@localhost:5432/community_nft_poc?schema=public',
  },
});
