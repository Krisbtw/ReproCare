#!/usr/bin/env node
/**
 * Release/startup-time database migrator (node-postgres, `pg`).
 *
 * Supports Supabase PostgreSQL and standard PostgreSQL deployments:
 * - Prefers `DIRECT_DATABASE_URL` (port 5432 direct or session pooler) when set for schema
 *   migrations, falling back to `DATABASE_URL`.
 * - Enforces encrypted SSL connections on Supabase (`*.supabase.co`, `*.pooler.supabase.com`)
 *   and remote PostgreSQL hosts.
 * - Acquires a PostgreSQL session-level advisory lock (`pg_advisory_lock`) on direct/session
 *   connections, or a transaction-level advisory lock (`pg_advisory_xact_lock`) when connected
 *   through a transaction-mode pooler (port 6543 / `pgbouncer=true`).
 * - Rejects unreplaced password placeholders (`[YOUR-PASSWORD]`) and redacts credentials in logs.
 */
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { discoverMigrationFiles, pendingMigrations } from "./migration-plan.mjs";

export const MIGRATION_ADVISORY_LOCK_ID = 72839401;

const PLACEHOLDER_RE =
  /\[YOUR-PASSWORD\]|<YOUR-PASSWORD>|\[PASSWORD\]|<PASSWORD>|YOUR_PASSWORD_HERE/i;

/** @param {string | null | undefined} input */
export function redactMigrationUrl(input) {
  if (!input) return "";
  return String(input)
    .replace(/(postgres(?:ql)?:\/\/[^:/\s@]+:)([^@\s]+)(@)/gi, "$1***$3")
    .replace(/password=\S+/gi, "password=***");
}

export function resolveMigrationConnectionConfig(env = process.env) {
  const rawUrl = (env.DIRECT_DATABASE_URL || env.DATABASE_URL || "").trim();
  const isProd =
    (env.NODE_ENV || "").toLowerCase() === "production" ||
    env.VERCEL === "1" ||
    env.REPROCARE_REQUIRE_DATABASE_URL === "true";

  if (!rawUrl) {
    if (isProd) {
      throw new Error(
        "[migrate] DATABASE_URL (or DIRECT_DATABASE_URL) is required in production.",
      );
    }
    return null;
  }

  if (PLACEHOLDER_RE.test(rawUrl)) {
    throw new Error(
      "[migrate] Connection string contains an unreplaced password placeholder ([YOUR-PASSWORD]).",
    );
  }

  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("[migrate] Invalid PostgreSQL connection URI.");
  }

  const host = parsed.hostname.toLowerCase();
  const port = parsed.port ? Number(parsed.port) : 5432;
  const isSupabase =
    host.endsWith(".supabase.co") || host.endsWith(".pooler.supabase.com");
  const isTransactionPooler =
    port === 6543 ||
    (parsed.searchParams.get("pgbouncer") || "").toLowerCase() === "true";

  const cleanUrl = new URL(parsed.toString());
  cleanUrl.searchParams.delete("pgbouncer");
  cleanUrl.searchParams.delete("connection_limit");
  const sslMode = (cleanUrl.searchParams.get("sslmode") || env.PGSSLMODE || "").toLowerCase();
  cleanUrl.searchParams.delete("sslmode");

  const isLocal =
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "db" ||
    host === "postgres";

  const ssl =
    sslMode === "disable" && !isSupabase
      ? false
      : isLocal && sslMode !== "require"
        ? false
        : {
            rejectUnauthorized:
              sslMode === "verify-full" ||
              env.DATABASE_SSL_REJECT_UNAUTHORIZED === "true",
          };

  return {
    connectionString: cleanUrl.toString(),
    redactedUrl: redactMigrationUrl(parsed.toString()),
    isSupabase,
    isTransactionPooler,
    ssl,
  };
}

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

async function main() {
  const cfg = resolveMigrationConnectionConfig(process.env);
  if (!cfg) {
    console.log(
      "[migrate] DATABASE_URL not set — skipping (the PGLite fallback migrates itself in development).",
    );
    return;
  }

  let rawEntries;
  try {
    rawEntries = await readdir(migrationsDir);
  } catch {
    console.log("[migrate] no migrations/ directory — nothing to do.");
    return;
  }
  const entries = discoverMigrationFiles(migrationsDir, rawEntries);
  if (pendingMigrations(entries, []).length === 0) {
    console.log("[migrate] no migrations — nothing to do.");
    return;
  }

  const { default: pg } = await import("pg");
  const pool = new pg.Pool({
    connectionString: cfg.connectionString,
    ssl: cfg.ssl,
    max: 1,
    connectionTimeoutMillis: 15_000,
    application_name: "reprocare_migrator",
  });
  const client = await pool.connect();
  let sessionLockAcquired = false;
  try {
    if (!cfg.isTransactionPooler) {
      await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_ADVISORY_LOCK_ID]);
      sessionLockAcquired = true;
    }

    await client.query(
      "CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())",
    );
    const applied = (await client.query("SELECT name FROM _migrations")).rows.map(
      (r) => r.name,
    );

    let count = 0;
    for (const { name } of pendingMigrations(entries, applied)) {
      const text = await readFile(join(migrationsDir, name), "utf8");
      try {
        await client.query("BEGIN");
        if (cfg.isTransactionPooler) {
          await client.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_ADVISORY_LOCK_ID]);
        }
        await client.query(text);
        await client.query(
          "INSERT INTO _migrations (name) VALUES ($1) ON CONFLICT (name) DO NOTHING",
          [name],
        );
        await client.query("COMMIT");
      } catch (err) {
        console.error(`[migrate] error applying ${name}`);
        try {
          await client.query("ROLLBACK");
        } catch {
          // ROLLBACK fails when the connection died — keep the original error.
        }
        throw err;
      }
      console.log(`[migrate] applied ${name}`);
      count += 1;
    }
    console.log(
      count ? `[migrate] done — ${count} migration(s) applied.` : "[migrate] up to date.",
    );
  } finally {
    if (sessionLockAcquired) {
      await client
        .query("SELECT pg_advisory_unlock($1)", [MIGRATION_ADVISORY_LOCK_ID])
        .catch(() => {});
    }
    client.release();
    await pool.end();
  }
}

const isMainModule =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === process.argv[1];

if (isMainModule) {
  main().catch((err) => {
    console.error("[migrate] failed:", redactMigrationUrl(err?.message || err));
    for (const key of ["code", "detail", "hint", "position", "where"]) {
      if (err?.[key] != null) {
        console.error(`[migrate]   ${key}: ${redactMigrationUrl(err[key])}`);
      }
    }
    process.exit(1);
  });
}
