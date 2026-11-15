import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { PrismaClient } from '@/generated/prisma/client';

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
  pgPool: pg.Pool | undefined;
};

export function createPrismaClient(connectionString?: string): PrismaClient {
  const url =
    connectionString ??
    process.env.DATABASE_URL ??
    'postgresql://postgres:postgres@localhost:5432/community_nft_poc?schema=public';

  const pool =
    globalForPrisma.pgPool ??
    new pg.Pool({
      connectionString: url,
    });

  const adapter = new PrismaPg(pool);
  const client = new PrismaClient({ adapter });

  if (process.env.NODE_ENV !== 'production') {
    globalForPrisma.pgPool = pool;
    globalForPrisma.prisma = client;
  }

  return client;
}

export const prisma: PrismaClient =
  globalForPrisma.prisma ?? createPrismaClient();
