import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { isMigrationFile, migrationName, pendingMigrations } from "./migration-plan.mjs";
import { projectRoot } from "./with-app-env.mjs";

const AUTH_MIGRATION = "0001_auth.sql";

/**
 * The auth-on copy of the Better Auth schema and its source, or null when the
 * app has not turned sign-in on (the shipped state).
 */
function authSchemaCopy(root) {
  const copy = join(root, "migrations", AUTH_MIGRATION);
  const source = join(root, "migrations/auth", AUTH_MIGRATION);
  if (!existsSync(copy) || !existsSync(source)) return null;
  return { copy: readFileSync(copy, "utf8"), source: readFileSync(source, "utf8") };
}

test("_migrations keys on basename, not path", () => {
  assert.equal(migrationName("/migrations/0002_todos.sql"), "0002_todos.sql");
  assert.equal(migrationName("migrations/auth/0001_auth.sql"), "0001_auth.sql");
  assert.equal(migrationName("0001_auth.sql"), "0001_auth.sql");
});

test("a file already applied from another directory does not re-apply", () => {
  // The auth-on path copies migrations/auth/0001_auth.sql into the globbed
  // directory; a database that already has it must not run it twice.
  assert.deepEqual(pendingMigrations(["/migrations/0001_auth.sql"], ["0001_auth.sql"]), []);
});

test("pending migrations are returned in name order", () => {
  assert.deepEqual(
    pendingMigrations(
      ["/migrations/0003_c.sql", "/migrations/0001_a.sql", "/migrations/0002_b.sql"],
      ["0001_a.sql"],
    ),
    [
      { name: "0002_b.sql", path: "/migrations/0002_b.sql" },
      { name: "0003_c.sql", path: "/migrations/0003_c.sql" },
    ],
  );
});

test("non-.sql entries are dropped (readdir also yields the auth/ directory)", () => {
  assert.equal(isMigrationFile("auth"), false);
  assert.deepEqual(pendingMigrations(["auth", "README.md"], []), []);
});

test("the auth schema source lives in migrations/auth and non-sql entries are ignored", () => {
  const migrationsDir = join(projectRoot(), "migrations");
  const allEntries = readdirSync(migrationsDir);
  const sqlNames = allEntries.filter(isMigrationFile);
  assert.deepEqual(pendingMigrations(allEntries, sqlNames), []);
  assert.ok(readdirSync(join(migrationsDir, "auth")).includes("0001_auth.sql"));
});

test("this workspace's auth schema copy is byte-identical to its source", () => {
  // An edited copy diverges silently: basename keying skips it on a database
  // that already ran the original, and applies it on a fresh PGLite preview.
  const pair = authSchemaCopy(projectRoot());
  if (pair === null) return; // sign-in off — nothing has been copied up
  assert.equal(
    pair.copy,
    pair.source,
    "migrations/0001_auth.sql has been edited — it must stay a verbatim copy of migrations/auth/0001_auth.sql",
  );
});

test("the copy check reads both files and catches an edit", () => {
  const root = mkdtempSync(join(tmpdir(), "auth-schema-"));
  mkdirSync(join(root, "migrations/auth"), { recursive: true });
  writeFileSync(join(root, "migrations/auth", AUTH_MIGRATION), "create table t ();\n");
  assert.equal(authSchemaCopy(root), null);

  writeFileSync(join(root, "migrations", AUTH_MIGRATION), "create table t ();\n");
  const same = authSchemaCopy(root);
  assert.equal(same.copy, same.source);

  writeFileSync(join(root, "migrations", AUTH_MIGRATION), "create table t (x int);\n");
  const drifted = authSchemaCopy(root);
  assert.notEqual(drifted.copy, drifted.source);
});

test("migrate.mjs uses PostgreSQL session advisory locks to prevent concurrent replica races", () => {
  const migrateSrc = readFileSync(join(projectRoot(), "scripts/migrate.mjs"), "utf8");
  assert.match(migrateSrc, /pg_advisory_lock\(\$1\)/);
  assert.match(migrateSrc, /pg_advisory_unlock\(\$1\)/);
  assert.match(migrateSrc, /ON CONFLICT \(name\) DO NOTHING/);
});

test("package.json decouples build from db:migrate and defines production start entrypoint", () => {
  const pkg = JSON.parse(readFileSync(join(projectRoot(), "package.json"), "utf8"));
  assert.equal(pkg.scripts.build, "node scripts/with-app-env.mjs vite build");
  assert.doesNotMatch(pkg.scripts.build, /db:migrate/);
  assert.equal(pkg.scripts["db:migrate"], "node scripts/migrate.mjs");
  assert.equal(pkg.scripts.start, "node .output/server/index.mjs");
});

test("production Dockerfile builds .output/server/index.mjs, installs tesseract-ocr, and runs as non-root", () => {
  const dockerfile = readFileSync(join(projectRoot(), "Dockerfile"), "utf8");
  assert.doesNotMatch(dockerfile, /CMD\s*\[\s*"npm"\s*,\s*"run"\s*,\s*"dev"\s*\]/);
  assert.match(dockerfile, /tesseract-ocr/);
  assert.match(dockerfile, /tesseract-ocr-eng/);
  assert.match(dockerfile, /USER node/);
  assert.match(dockerfile, /HEALTHCHECK/);
  assert.match(dockerfile, /\.output\/server\/index\.mjs/);
});

test("vercel.json defines valid multi-service configuration with app (nitro), imaging-service (fastapi), bindings, and rewrites", () => {
  const vercelConfig = JSON.parse(readFileSync(join(projectRoot(), "vercel.json"), "utf8"));
  assert.equal(vercelConfig.$schema, "https://openapi.vercel.sh/vercel.json");
  // Under Vercel Services, top-level build/install keys must be moved inside services.<name>
  for (const forbiddenTopKey of ["buildCommand", "outputDirectory", "installCommand", "devCommand", "framework", "functions"]) {
    assert.equal(vercelConfig[forbiddenTopKey], undefined, `Top-level '${forbiddenTopKey}' is not allowed with services`);
  }
  assert.ok(vercelConfig.services && typeof vercelConfig.services === "object");
  assert.equal(vercelConfig.services.app.root, ".");
  assert.equal(vercelConfig.services.app.framework, "nitro");
  assert.ok(Array.isArray(vercelConfig.services.app.bindings));
  const imagingBinding = vercelConfig.services.app.bindings.find((b) => b.service === "imaging-service");
  assert.ok(imagingBinding, "app service must declare a binding to imaging-service");
  assert.equal(imagingBinding.type, "service");
  assert.equal(imagingBinding.format, "url");
  assert.equal(imagingBinding.env, "ANATOMYBRIDGE_SERVICE_URL");

  assert.equal(vercelConfig.services["imaging-service"].root, "imaging-service");
  assert.equal(vercelConfig.services["imaging-service"].framework, "fastapi");
  assert.equal(vercelConfig.services["imaging-service"].entrypoint, "app/main.py");

  assert.ok(Array.isArray(vercelConfig.rewrites) && vercelConfig.rewrites.length >= 1);
  const catchAll = vercelConfig.rewrites[vercelConfig.rewrites.length - 1];
  assert.equal(catchAll.source, "/(.*)");
  assert.deepEqual(catchAll.destination, { service: "app" });
});
