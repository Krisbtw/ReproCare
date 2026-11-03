import { pendingMigrations } from "../../scripts/migration-plan.mjs";

/** Which database backend is active. */
export type DbSource = "neon" | "pglite";

/** PostgreSQL connection pooling mode. */
export type PostgresPoolMode = "transaction" | "session" | "direct";

export interface ResolvedDatabaseConfig {
  connectionString: string;
  redactedUrl: string;
  host: string;
  port: number;
  database: string;
  user: string;
  isSupabase: boolean;
  supabaseProjectRef: string | null;
  poolMode: PostgresPoolMode;
  ssl: false | { rejectUnauthorized: boolean };
  maxConnections: number;
  idleTimeoutMillis: number;
  connectionTimeoutMillis: number;
  allowExitOnIdle: boolean;
  preparedStatementsDisabled: boolean;
  warnings: string[];
}

const PLACEHOLDER_PASSWORD_RE =
  /\[YOUR-PASSWORD\]|<YOUR-PASSWORD>|\[PASSWORD\]|<PASSWORD>|YOUR_PASSWORD_HERE/i;

/**
 * Redacts credentials from any PostgreSQL connection URI or error message string.
 */
export function redactDatabaseUrl(input: string): string {
  if (!input) return "";
  return input
    .replace(
      /(postgres(?:ql)?:\/\/[^:/\s@]+:)([^@\s]+)(@)/gi,
      "$1***$3",
    )
    .replace(/password=\S+/gi, "password=***");
}

/**
 * Sanitizes a database Error so connection strings, passwords, or tokens are never leaked.
 */
export function sanitizeDatabaseError(err: unknown): Error {
  const rawMessage =
    err instanceof Error ? err.message : typeof err === "string" ? err : "Unknown database error";
  const safeMessage = redactDatabaseUrl(rawMessage);
  const sanitized = new Error(`Database error: ${safeMessage}`);
  if (err && typeof err === "object" && "code" in err) {
    (sanitized as Error & { code?: unknown }).code = (err as { code?: unknown }).code;
  }
  return sanitized;
}

/**
 * Determines whether the current execution environment is production / deployed Vercel
 * where silent fallback to in-memory PGlite is strictly prohibited.
 */
export function isProductionDatabaseRuntime(
  env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {},
): boolean {
  const nodeEnv = (env.NODE_ENV ?? "").trim().toLowerCase();
  const vercel = (env.VERCEL ?? "").trim().toLowerCase();
  const vercelEnv = (env.VERCEL_ENV ?? "").trim().toLowerCase();
  const requireDb = (env.REPROCARE_REQUIRE_DATABASE_URL ?? "").trim().toLowerCase();
  return (
    nodeEnv === "production" ||
    vercel === "1" ||
    vercel === "true" ||
    vercelEnv === "production" ||
    vercelEnv === "preview" ||
    requireDb === "1" ||
    requireDb === "true"
  );
}

/**
 * Parses and validates `DATABASE_URL` for Supabase PostgreSQL, Vercel serverless transaction pooling,
 * or standard PostgreSQL connections.
 */
export function resolveDatabaseConfig(
  env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {},
  overrideUrl?: string,
): ResolvedDatabaseConfig | null {
  const raw = (
    overrideUrl ??
    env.DATABASE_URL ??
    env.POSTGRES_URL ??
    env.SUPABASE_DATABASE_URL ??
    env.POSTGRES_PRISMA_URL ??
    env.POSTGRES_URL_NON_POOLING ??
    env.SUPABASE_POSTGRES_URL ??
    env.SUPABASE_DB_URL ??
    ""
  ).trim();
  if (!raw) {
    if (isProductionDatabaseRuntime(env)) {
      throw new Error(
        "Database configuration error: DATABASE_URL is required in production/Vercel runtime. " +
          "Silent fallback to in-memory PGlite is disabled in production.",
      );
    }
    return null;
  }

  if (PLACEHOLDER_PASSWORD_RE.test(raw)) {
    throw new Error(
      "Database configuration error: DATABASE_URL still contains an unreplaced password placeholder " +
        "(e.g. [YOUR-PASSWORD]). Set the real database password via environment variables.",
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(
      "Database configuration error: DATABASE_URL is not a valid postgres:// or postgresql:// URI.",
    );
  }

  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error(
      `Database configuration error: unsupported protocol '${parsed.protocol}'. Expected postgres: or postgresql:.`,
    );
  }

  const decodedPassword = decodeURIComponent(parsed.password || "");
  if (PLACEHOLDER_PASSWORD_RE.test(decodedPassword)) {
    throw new Error(
      "Database configuration error: DATABASE_URL contains an unreplaced password placeholder.",
    );
  }

  const host = parsed.hostname.toLowerCase();
  const port = parsed.port ? Number(parsed.port) : 5432;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Database configuration error: invalid port '${parsed.port}' in DATABASE_URL.`);
  }

  const database = (parsed.pathname || "/postgres").replace(/^\/+/, "") || "postgres";
  const user = decodeURIComponent(parsed.username || "postgres");

  const isSupabaseDirect = /^db\.([a-z0-9-]+)\.supabase\.co$/i.test(host);
  const isSupabasePooler = /\.pooler\.supabase\.com$/i.test(host);
  const isSupabase = isSupabaseDirect || isSupabasePooler || host.endsWith(".supabase.co");

  let supabaseProjectRef: string | null = null;
  const directMatch = host.match(/^db\.([a-z0-9-]+)\.supabase\.co$/i);
  if (directMatch) {
    supabaseProjectRef = directMatch[1];
  } else if (user.includes(".")) {
    const parts = user.split(".");
    if (parts.length >= 2 && parts[1]) {
      supabaseProjectRef = parts[1];
    }
  } else if (env.SUPABASE_URL) {
    const urlMatch = env.SUPABASE_URL.match(/https?:\/\/([a-z0-9-]+)\.supabase\.co/i);
    if (urlMatch) supabaseProjectRef = urlMatch[1];
  }

  const pgbouncerParam = (parsed.searchParams.get("pgbouncer") ?? "").toLowerCase();
  const explicitPoolMode = (env.SUPABASE_POOL_MODE ?? "").trim().toLowerCase();

  let poolMode: PostgresPoolMode = "direct";
  if (
    port === 6543 ||
    pgbouncerParam === "true" ||
    pgbouncerParam === "1" ||
    explicitPoolMode === "transaction"
  ) {
    poolMode = "transaction";
  } else if (isSupabasePooler || explicitPoolMode === "session") {
    poolMode = "session";
  }

  const warnings: string[] = [];
  const isServerless =
    (env.VERCEL ?? "").trim() === "1" ||
    Boolean(env.VERCEL_ENV) ||
    Boolean(env.AWS_LAMBDA_FUNCTION_NAME);

  if (isServerless && isSupabaseDirect && port === 5432) {
    warnings.push(
      "Direct Supabase connection (db.<project_ref>.supabase.co:5432) detected on serverless runtime. " +
        "For Vercel serverless functions, use the Supabase Transaction Pooler connection string (port 6543) " +
        "from the Supabase Dashboard -> Connect -> Transaction pooler, and reserve port 5432 for DIRECT_DATABASE_URL migrations.",
    );
  }

  // Strip connection parameters that node-postgres does not natively parse (`pgbouncer`, `connection_limit`)
  const cleanUrl = new URL(parsed.toString());
  cleanUrl.searchParams.delete("pgbouncer");
  cleanUrl.searchParams.delete("connection_limit");

  const sslModeParam = (cleanUrl.searchParams.get("sslmode") ?? env.PGSSLMODE ?? "").toLowerCase();
  cleanUrl.searchParams.delete("sslmode");

  const isLocalHost =
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "[::1]" ||
    host === "db" ||
    host === "postgres";

  let ssl: false | { rejectUnauthorized: boolean };
  if (sslModeParam === "disable" && !isSupabase) {
    ssl = false;
  } else if (isLocalHost && sslModeParam !== "require" && sslModeParam !== "verify-full") {
    ssl = false;
  } else {
    const strictVerify =
      sslModeParam === "verify-full" ||
      (env.DATABASE_SSL_REJECT_UNAUTHORIZED ?? "").trim().toLowerCase() === "true";
    ssl = { rejectUnauthorized: strictVerify };
  }

  const defaultMax = isServerless || poolMode === "transaction" ? 3 : 10;
  const parsedMax = Number(env.DATABASE_POOL_MAX);
  const maxConnections =
    Number.isInteger(parsedMax) && parsedMax > 0 && parsedMax <= 100 ? parsedMax : defaultMax;

  const idleTimeoutMillis = isServerless || poolMode === "transaction" ? 10_000 : 30_000;
  const connectionTimeoutMillis = Number(env.DATABASE_CONNECT_TIMEOUT_MS) || 10_000;
  const allowExitOnIdle = isServerless || poolMode === "transaction";
  const preparedStatementsDisabled = poolMode === "transaction";

  return {
    connectionString: cleanUrl.toString(),
    redactedUrl: redactDatabaseUrl(parsed.toString()),
    host,
    port,
    database,
    user,
    isSupabase,
    supabaseProjectRef,
    poolMode,
    ssl,
    maxConnections,
    idleTimeoutMillis,
    connectionTimeoutMillis,
    allowExitOnIdle,
    preparedStatementsDisabled,
    warnings,
  };
}

// An empty/whitespace DATABASE_URL (an easy misconfig in deploy UIs) must mean
// "unset" — and in production/Vercel runtime createSql() fails closed rather than
// silently running on the in-memory PGLite fallback.
const defaultSupabaseDatabaseUrl =
  "postgresql://postgres.mfbqdesghtvalkywzsdb:vJihFnkCtLkADB20@aws-0-eu-west-1.pooler.supabase.com:5432/postgres";

function normalizeSupabaseDatabaseUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  let n = url.trim();
  if (n.includes("db.mfbqdesghtvalkywzsdb.supabase.co")) {
    n = n.replace("db.mfbqdesghtvalkywzsdb.supabase.co", "aws-0-eu-west-1.pooler.supabase.com");
    if (n.includes("://postgres:")) {
      n = n.replace("://postgres:", "://postgres.mfbqdesghtvalkywzsdb:");
    }
  } else if (n.includes("aws-0-ap-south-1.pooler.supabase.com")) {
    n = n.replace("aws-0-ap-south-1.pooler.supabase.com", "aws-0-eu-west-1.pooler.supabase.com");
  }
  return n;
}

const rawDatabaseUrl = normalizeSupabaseDatabaseUrl(
  typeof process !== "undefined"
    ? process.env.DATABASE_URL ||
      process.env.POSTGRES_URL ||
      process.env.SUPABASE_DATABASE_URL ||
      process.env.POSTGRES_PRISMA_URL ||
      process.env.POSTGRES_URL_NON_POOLING ||
      process.env.SUPABASE_POSTGRES_URL ||
      process.env.SUPABASE_DB_URL
    : undefined
);
const databaseUrl =
  (rawDatabaseUrl && rawDatabaseUrl.trim() ? rawDatabaseUrl.trim() : undefined) ||
  (isProductionDatabaseRuntime() ? defaultSupabaseDatabaseUrl : undefined);

export const dbSource: DbSource = databaseUrl ? "neon" : "pglite";

/**
 * Minimal shared SQL surface, satisfied by both PostgreSQL (`pg`) and PGLite.
 * Both the tagged-template and `.query()` forms resolve to an array of row objects.
 */
export interface Sql {
  <T = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T[]>;
  query<T = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<T[]>;
}

const globalRef = globalThis as typeof globalThis & {
  __pgSqlPromise__?: Promise<Sql>;
  __pgPoolInstance__?: import("pg").Pool;
  __pgliteInstance__?: Promise<import("@electric-sql/pglite").PGlite>;
  __pgliteMigrateChain__?: Promise<void>;
};

const OID_INT8 = 20;
const OID_DATE = 1082;
const OID_INTERVAL = 1186;
const identity = (v: string) => v;

type Run = <T>(text: string, params: unknown[]) => Promise<T[]>;

/** Wrap a query runner in the tagged-template + `.query()` `Sql` surface. */
function toSql(run: Run): Sql {
  const sql = (async <T = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T[]> => {
    let text = strings[0];
    for (let i = 0; i < values.length; i += 1) text += `$${i + 1}${strings[i + 1]}`;
    return run<T>(text, values);
  }) as unknown as Sql;
  sql.query = <T = Record<string, unknown>>(text: string, params: unknown[] = []) =>
    run<T>(text, params);
  return sql;
}

function createPostgresSql(overrideConfig?: ResolvedDatabaseConfig): Promise<Sql> {
  globalRef.__pgSqlPromise__ ??= (async () => {
    const cfg = overrideConfig ?? resolveDatabaseConfig(process.env, databaseUrl);
    if (!cfg) {
      throw new Error(
        "Database configuration error: DATABASE_URL is not configured.",
      );
    }
    const { Pool, types } = await import("pg");
    types.setTypeParser(OID_INT8, Number);
    types.setTypeParser(OID_DATE, identity);
    types.setTypeParser(OID_INTERVAL, identity);

    const pool = new Pool({
      connectionString: cfg.connectionString,
      ssl: cfg.ssl,
      max: cfg.maxConnections,
      idleTimeoutMillis: cfg.idleTimeoutMillis,
      connectionTimeoutMillis: cfg.connectionTimeoutMillis,
      allowExitOnIdle: cfg.allowExitOnIdle,
      application_name: "reprocare_app",
    });

    pool.on("error", (err) => {
      const safe = sanitizeDatabaseError(err);
      console.error("[db] Idle PostgreSQL pool client error:", safe.message);
    });

    globalRef.__pgPoolInstance__ = pool;

    return toSql(async <T>(text: string, params: unknown[]) => {
      try {
        // Note: In transaction-pooling mode (`cfg.preparedStatementsDisabled === true`),
        // we strictly pass `{ text, values: params }` without a `name` property so
        // node-postgres uses unnamed extended-protocol queries compatible with Supavisor/PgBouncer.
        const res = await pool.query({ text, values: params });
        return res.rows as T[];
      } catch (err) {
        throw sanitizeDatabaseError(err);
      }
    });
  })().catch((err) => {
    globalRef.__pgSqlPromise__ = undefined;
    throw sanitizeDatabaseError(err);
  });
  return globalRef.__pgSqlPromise__;
}

async function createPgliteSql(): Promise<Sql> {
  if (isProductionDatabaseRuntime()) {
    throw new Error(
      "Database configuration error: DATABASE_URL is required in production/Vercel runtime. " +
        "Silent fallback to in-memory PGlite is disabled in production.",
    );
  }
  globalRef.__pgliteInstance__ ??= (async () => {
    const { PGlite } = await import("@electric-sql/pglite");
    const pg = new PGlite({
      parsers: {
        [OID_INT8]: Number,
        [OID_DATE]: identity,
        [OID_INTERVAL]: identity,
      },
    });
    await pg.waitReady;
    await pg.exec(
      "create table if not exists _migrations (name text primary key, applied_at timestamptz not null default now())",
    );
    return pg;
  })().catch((err) => {
    globalRef.__pgliteInstance__ = undefined;
    throw err;
  });
  const pg = await globalRef.__pgliteInstance__;

  const migrate = async (): Promise<void> => {
    const migrations =
      typeof import.meta.glob === "function"
        ? (import.meta.glob("/migrations/*.sql", {
            query: "?raw",
            import: "default",
            eager: true,
          }) as Record<string, string>)
        : {};
    const doneRows = await pg.query<{ name: string }>(
      "select name from _migrations",
    );
    const done = doneRows.rows.map((r) => r.name);
    for (const { name, path } of pendingMigrations(Object.keys(migrations), done)) {
      await pg.transaction(async (tx) => {
        await tx.exec(migrations[path]);
        await tx.query("insert into _migrations (name) values ($1)", [name]);
      });
    }
  };
  const pass = (globalRef.__pgliteMigrateChain__ ?? Promise.resolve())
    .catch(() => undefined)
    .then(migrate);
  globalRef.__pgliteMigrateChain__ = pass;
  await pass;

  return toSql(async <T>(text: string, params: unknown[]) => {
    const result = await pg.query<T>(text, params);
    return result.rows;
  });
}

let sqlPromise: Promise<Sql> | null = null;

async function createSql(): Promise<Sql> {
  if (typeof window !== "undefined") {
    throw new Error(
      "@/lib/db is server-only — call getSql() from a createServerFn handler " +
        "or a server route loader, never from client code.",
    );
  }
  const currentUrl = process.env.DATABASE_URL?.trim();
  if (currentUrl || isProductionDatabaseRuntime()) {
    const cfg = resolveDatabaseConfig();
    return createPostgresSql(cfg ?? undefined);
  }
  return createPgliteSql();
}

export function getSql(): Promise<Sql> {
  sqlPromise ??= createSql().catch((err) => {
    sqlPromise = null;
    throw err;
  });
  return sqlPromise;
}

/**
 * Resets cached SQL pool promises (used in automated tests when switching DATABASE_URL).
 */
export async function resetDbConnectionForTests(): Promise<void> {
  sqlPromise = null;
  globalRef.__pgSqlPromise__ = undefined;
  if (globalRef.__pgPoolInstance__) {
    await globalRef.__pgPoolInstance__.end().catch(() => {});
    globalRef.__pgPoolInstance__ = undefined;
  }
}

export interface DatabaseHealthReport {
  ok: boolean;
  backend: "supabase_postgres" | "postgres" | "pglite";
  poolMode: PostgresPoolMode | "in_memory";
  sslEnabled: boolean;
  supabaseProjectRef: string | null;
  appliedMigrationsCount: number;
  latencyMs: number;
  warnings: string[];
  error: string | null;
}

/**
 * Executes a non-sensitive database health check verifying query execution and `_migrations` state.
 */
export async function checkDatabaseHealth(
  sqlOverride?: Sql,
  env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {},
): Promise<DatabaseHealthReport> {
  const start = Date.now();
  let cfg: ResolvedDatabaseConfig | null = null;
  try {
    cfg = resolveDatabaseConfig(env);
  } catch (err) {
    return {
      ok: false,
      backend: "postgres",
      poolMode: "direct",
      sslEnabled: false,
      supabaseProjectRef: null,
      appliedMigrationsCount: 0,
      latencyMs: Date.now() - start,
      warnings: [],
      error: sanitizeDatabaseError(err).message,
    };
  }

  try {
    const sql = sqlOverride ?? (await getSql());
    const ping = await sql<{ ok: number }>`select 1 as ok`;
    if (!ping || ping[0]?.ok !== 1) {
      throw new Error("Unexpected health check ping response.");
    }
    let appliedMigrationsCount = 0;
    try {
      const migRows = await sql<{ name: string }>`select name from _migrations`;
      appliedMigrationsCount = migRows.length;
    } catch {
      appliedMigrationsCount = 0;
    }
    return {
      ok: true,
      backend: cfg ? (cfg.isSupabase ? "supabase_postgres" : "postgres") : "pglite",
      poolMode: cfg ? cfg.poolMode : "in_memory",
      sslEnabled: cfg ? Boolean(cfg.ssl) : false,
      supabaseProjectRef: cfg?.supabaseProjectRef ?? null,
      appliedMigrationsCount,
      latencyMs: Date.now() - start,
      warnings: cfg?.warnings ?? [],
      error: null,
    };
  } catch (err) {
    return {
      ok: false,
      backend: cfg ? (cfg.isSupabase ? "supabase_postgres" : "postgres") : "pglite",
      poolMode: cfg ? cfg.poolMode : "in_memory",
      sslEnabled: cfg ? Boolean(cfg.ssl) : false,
      supabaseProjectRef: cfg?.supabaseProjectRef ?? null,
      appliedMigrationsCount: 0,
      latencyMs: Date.now() - start,
      warnings: cfg?.warnings ?? [],
      error: sanitizeDatabaseError(err).message,
    };
  }
}

export async function getPglite(): Promise<import("@electric-sql/pglite").PGlite> {
  if (dbSource !== "pglite" || isProductionDatabaseRuntime()) {
    throw new Error("getPglite() is only available on the PGLite fallback (no DATABASE_URL in development)");
  }
  await getSql();
  const pg = await globalRef.__pgliteInstance__;
  if (!pg) throw new Error("PGLite instance failed to initialize");
  return pg;
}

export function ensureDbReady(): Promise<void> {
  if (dbSource !== "pglite" || isProductionDatabaseRuntime()) return Promise.resolve();
  return getSql().then(() => undefined);
}

const globalBoot = globalThis as typeof globalThis & {
  __pgBootstrapPromise__?: Promise<void>;
};
if (
  typeof window === "undefined" &&
  dbSource === "pglite" &&
  !isProductionDatabaseRuntime() &&
  typeof import.meta.glob === "function"
) {
  globalBoot.__pgBootstrapPromise__ ??= ensureDbReady().catch((err) => {
    globalBoot.__pgBootstrapPromise__ = undefined;
    console.error("[db] PGLite bootstrap failed:", err);
    throw err;
  });
}
