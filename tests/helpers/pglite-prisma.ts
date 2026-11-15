import fs from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { PrismaClient } from '@/generated/prisma/client';

interface QueryLikeConfig {
  text: string;
  values?: unknown[];
  rowMode?: string;
  types?: {
    getTypeParser?: (oid: number, format?: string) => (val: string) => unknown;
  };
}

const KNOWN_PG_OIDS: number[] = Array.from(
  new Set<number>([
    ...Object.values(pg.types.builtins).filter(
      (v): v is number => typeof v === 'number'
    ),
    19, 114, 142, 143, 199, 651, 791, 1000, 1001, 1002, 1005, 1007, 1009, 1014,
    1015, 1016, 1021, 1022, 1028, 1041, 1082, 1083, 1114, 1115, 1182, 1183,
    1184, 1185, 1231, 1266, 1561, 1563, 1700, 2950, 2951, 3802, 3807,
  ])
);

function buildPGliteParsers(
  getTypeParser?: (oid: number, format?: string) => (val: string) => unknown
): Record<number, (val: string) => unknown> | undefined {
  if (!getTypeParser) {
    return undefined;
  }
  const parsers: Record<number, (val: string) => unknown> = {};
  for (const oid of KNOWN_PG_OIDS) {
    parsers[oid] = getTypeParser(oid, 'text');
  }
  return parsers;
}

class PGlitePool extends pg.Pool {
  private readonly db: PGlite;

  constructor(db: PGlite) {
    super();
    this.db = db;
    this.query = (async (
      queryTextOrConfig: string | QueryLikeConfig,
      values?: unknown[]
    ): Promise<pg.QueryResult<pg.QueryResultRow>> => {
      const client = await this.connect();
      try {
        return await (
          client as unknown as {
            query: (
              q: string | QueryLikeConfig,
              v?: unknown[]
            ) => Promise<pg.QueryResult<pg.QueryResultRow>>;
          }
        ).query(queryTextOrConfig, values);
      } finally {
        client.release();
      }
    }) as unknown as pg.Pool['query'];
  }

  public override connect(): Promise<pg.PoolClient> {
    const db = this.db;
    const client = {
      async query(
        queryTextOrConfig: string | QueryLikeConfig,
        values?: unknown[]
      ) {
        const text =
          typeof queryTextOrConfig === 'string'
            ? queryTextOrConfig
            : queryTextOrConfig.text;
        const params =
          typeof queryTextOrConfig === 'string'
            ? values
            : queryTextOrConfig.values;
        const rowMode =
          typeof queryTextOrConfig === 'object' &&
          queryTextOrConfig?.rowMode === 'array'
            ? 'array'
            : undefined;
        const parsers = buildPGliteParsers(
          typeof queryTextOrConfig === 'object'
            ? queryTextOrConfig?.types?.getTypeParser
            : undefined
        );

        const res = await db.query(text, params, {
          ...(rowMode ? { rowMode } : {}),
          ...(parsers ? { parsers } : {}),
        });

        return {
          rows: res.rows,
          rowCount: res.affectedRows ?? res.rows.length,
          command: text.trim().split(/\s+/)[0]?.toUpperCase() || 'SELECT',
          oid: 0,
          fields: (res.fields ?? []).map((f) => ({
            name: f.name,
            dataTypeID: f.dataTypeID,
          })),
        };
      },
      on(): void {
        // Event emitter stub used by PrismaPgAdapter.startTransaction()
      },
      removeListener(): void {
        // Event emitter stub used by PrismaPgAdapter.startTransaction()
      },
      release(): void {
        // No-op for single-instance PGlite test database
      },
    };

    return Promise.resolve(client as unknown as pg.PoolClient);
  }

  public override async end(): Promise<void> {
    // Closed cleanly via db.close()
  }
}

/**
 * Loads all Prisma SQL migration files from `prisma/migrations/*\/migration.sql`
 * in chronological directory order so test DBs match `prisma migrate deploy` identically.
 */
export function loadOrderedMigrationSqlFiles(): string[] {
  const migrationsRoot = path.resolve(process.cwd(), 'prisma/migrations');
  const entries = fs
    .readdirSync(migrationsRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort((a, b) => a.localeCompare(b));

  const sqlList: string[] = [];
  for (const dirName of entries) {
    const sqlPath = path.join(migrationsRoot, dirName, 'migration.sql');
    if (fs.existsSync(sqlPath)) {
      sqlList.push(fs.readFileSync(sqlPath, 'utf8').replace(/^\uFEFF/, ''));
    }
  }
  return sqlList;
}

/**
 * Creates a fresh in-memory PostgreSQL (`PGlite`) instance with all Prisma migrations applied
 * and returns a real PrismaClient wired through `@prisma/adapter-pg`.
 */
export async function createTestPGlitePrisma(): Promise<{
  db: PGlite;
  prisma: PrismaClient;
  close: () => Promise<void>;
}> {
  const db = new PGlite();
  const migrations = loadOrderedMigrationSqlFiles();
  for (const sql of migrations) {
    await db.exec(sql);
  }

  const pool = new PGlitePool(db);
  const adapter = new PrismaPg(pool);
  const prisma = new PrismaClient({ adapter });

  return {
    db,
    prisma,
    close: async () => {
      await prisma.$disconnect();
      await db.close();
    },
  };
}
