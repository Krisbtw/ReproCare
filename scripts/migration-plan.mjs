// @ts-check
/**
 * Migration bookkeeping shared by the two appliers — `scripts/migrate.mjs`
 * (deploy, `readdir`) and `src/lib/db.ts` (PGLite preview, `import.meta.glob`).
 *
 * Applied files are keyed by BASENAME, so the same file applies once no matter
 * which directory it is globbed from. That is what makes the auth schema safe to
 * copy from `migrations/auth/` into `migrations/` when an app turns sign-in on:
 * a database that already has `0001_auth.sql` will not re-run it.
 *
 * Neither applier descends into subdirectories, so `migrations/auth/*.sql` is
 * out of scope for both until it is copied up.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

export const KNOWN_MIGRATION_FILES = [
  "0001_auth.sql",
  "0002_anatomybridge.sql",
  "0003_append_only.sql",
  "0004_menarche_year.sql",
  "0005_report_ingestion.sql",
  "0006_performance_indices.sql",
  "0007_fix_profile_default.sql",
  "0008_clinician_verification.sql",
  "0009_imaging_and_provenance.sql",
  "0010_sprint1_auth_and_registration.sql",
  "0011_sprint3_imaging_storage_and_reprotrace.sql",
  "0012_sprint4_collaboration_and_report_intelligence.sql",
  "0013_sprint5_dicom_and_condition_workflows.sql",
  "0014_supabase_storage_integration.sql",
  "0015_reprotrace_evidence_and_correspondence_runs.sql",
];

/**
 * Discovers all `.sql` migration filenames in `migrationsDir`, combining `readdir`
 * output with direct `existsSync` checks for `KNOWN_MIGRATION_FILES` so mounted/FUSE
 * filesystems with cached directory listings never miss a migration file.
 * @param {string} migrationsDir
 * @param {Iterable<string>} [readdirEntries]
 * @returns {string[]}
 */
export function discoverMigrationFiles(migrationsDir, readdirEntries = []) {
  const found = new Set(readdirEntries);
  for (const known of KNOWN_MIGRATION_FILES) {
    if (!found.has(known) && existsSync(join(migrationsDir, known))) {
      found.add(known);
    }
  }
  return [...found];
}

/**
 * The `_migrations` key for a migration path (or bare filename).
 * @param {string} path
 * @returns {string}
 */
export function migrationName(path) {
  return path.split("/").pop() ?? path;
}

/**
 * @param {string} path
 * @returns {boolean}
 */
export function isMigrationFile(path) {
  return path.endsWith(".sql");
}

/**
 * Migrations in `paths` that are not yet in `applied`, in apply order.
 * Non-`.sql` entries (a `readdir` also yields `migrations/auth/`) are dropped.
 * @param {Iterable<string>} paths
 * @param {Iterable<string>} applied
 * @returns {Array<{ name: string, path: string }>}
 */
export function pendingMigrations(paths, applied) {
  const done = new Set(applied);
  return [...paths]
    .filter(isMigrationFile)
    .map((path) => ({ name: migrationName(path), path }))
    .sort((a, b) => a.name.localeCompare(b.name))
    .filter(({ name }) => !done.has(name));
}
