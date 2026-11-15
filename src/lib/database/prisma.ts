import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { PrismaClient } from '@/generated/prisma/client';
import { resolveDatabaseUrl } from '@/lib/config/env';

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
  pgPool: pg.Pool | undefined;
};

export function createPrismaClient(connectionString?: string): PrismaClient {
  // Throws in production/live mode when DATABASE_URL is missing or points to localhost.
  const url = resolveDatabaseUrl(connectionString);

  const pool = globalForPrisma.pgPool ?? new pg.Pool({ connectionString: url });

  const adapter = new PrismaPg(pool);
  const client = new PrismaClient({ adapter });

  if (process.env.NODE_ENV !== 'production') {
    globalForPrisma.pgPool = pool;
    globalForPrisma.prisma = client;
  }

  return client;
}

let productionClient: PrismaClient | undefined;

function getPrismaClient(): PrismaClient {
  if (globalForPrisma.prisma) {
    return globalForPrisma.prisma;
  }
  if (process.env.NODE_ENV === 'production') {
    productionClient ??= createPrismaClient();
    return productionClient;
  }
  return createPrismaClient();
}

/**
 * Lazily-initialised shared client: configuration is validated on first use
 * (not at import time), so builds don't need live database access.
 */
export const prisma: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, prop, receiver) {
    return Reflect.get(getPrismaClient(), prop, receiver);
  },
});
