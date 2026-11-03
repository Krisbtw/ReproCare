-- 0015: ReproTrace Requirements 1 & 2 — source-to-anatomy provenance and live correspondence runs.
--
-- Additive and backward-compatible. No existing row is rewritten except where a new nullable column
-- receives an explicit "legacy" marker so the UI never presents an unlabelled row as a live result.
--
--   1. evidence_links gains the provenance fields needed to trace
--      report -> extraction -> quote -> finding version -> study -> series -> SOP/slice -> LPS coordinate.
--      Every field is nullable: missing source data stays NULL and is shown as missing, never invented.
--   2. report_observation_links: append-only record of each clinician decision on an extracted report
--      observation (confirm an existing finding, create a provisional finding, or leave unlinked), with the
--      deterministic candidate state and rationale that was shown at decision time.
--   3. reprotrace_runs: one row per correspondence computation (live recompute or seeded demonstration),
--      so proposals can be attributed to a specific engine run.
--   4. correspondences gain origin (seeded_demo | live_recompute | legacy_unlabelled), run_id and
--      alternatives_json (competing candidates when a match is ambiguous).
--   5. correspondence_decisions gain the engine version, finding versions and category that the clinician
--      actually reviewed. Decisions record a relationship only; findings are never merged.

-- 1. Evidence-link provenance
alter table evidence_links add column if not exists extraction_id text;
alter table evidence_links add column if not exists observation_index integer;
alter table evidence_links add column if not exists page_number integer;
alter table evidence_links add column if not exists extraction_provenance text;
alter table evidence_links add column if not exists link_status text;
alter table evidence_links add column if not exists review_status text;
alter table evidence_links add column if not exists reviewed_by text;
alter table evidence_links add column if not exists reviewed_at timestamptz;
alter table evidence_links add column if not exists sop_instance_uid text;
alter table evidence_links add column if not exists frame_number integer;
alter table evidence_links add column if not exists coordinate_frame text;
alter table evidence_links add column if not exists centroid_lps_json text;
alter table evidence_links add column if not exists registration_id text;
alter table evidence_links add column if not exists source_artifact_ref text;
alter table evidence_links add column if not exists created_at timestamptz default now();

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'evidence_links_link_status_check') then
    alter table evidence_links
      add constraint evidence_links_link_status_check
      check (link_status is null or link_status in ('report_only', 'anatomically_linked', 'spatially_anchored'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'evidence_links_review_status_check') then
    alter table evidence_links
      add constraint evidence_links_review_status_check
      check (review_status is null or review_status in ('needs_review', 'clinician_verified'));
  end if;
end $$;

-- 2. Clinician decisions on extracted report observations
create table if not exists report_observation_links (
  id text primary key,
  user_id text not null,
  patient_id text not null references patients (id) on delete cascade,
  report_id text not null references reports (id) on delete cascade,
  extraction_id text,
  observation_index integer not null,
  decision text not null check (decision in ('linked_existing', 'created_provisional', 'left_unlinked')),
  candidate_state text not null check (candidate_state in ('strong', 'possible', 'ambiguous', 'none', 'insufficient_evidence')),
  candidates_json text not null default '[]',
  finding_id text,
  finding_version_id text,
  evidence_link_id text,
  quote text,
  quote_start integer,
  quote_end integer,
  page_number integer,
  reviewer_user_id text not null,
  note text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists idx_rol_report on report_observation_links (report_id, observation_index, created_at);
create index if not exists idx_rol_patient on report_observation_links (patient_id, created_at);

-- 3. Correspondence computation runs
create table if not exists reprotrace_runs (
  id text primary key,
  user_id text not null,
  patient_id text not null references patients (id) on delete cascade,
  triggered_by text not null,
  trigger text not null,
  origin text not null check (origin in ('seeded_demo', 'live_recompute')),
  engine_version text not null,
  study_ids_json text not null default '[]',
  proposals_count integer not null default 0,
  review_required_count integer not null default 0,
  registration_notes_json text not null default '[]',
  created_at timestamptz not null default now()
);
create index if not exists idx_reprotrace_runs_patient on reprotrace_runs (patient_id, created_at desc);

-- 4. Correspondence origin and run attribution
alter table correspondences add column if not exists origin text;
alter table correspondences add column if not exists run_id text;
alter table correspondences add column if not exists alternatives_json text;
-- Rows created before run tracking cannot be attributed honestly; label them as such.
update correspondences set origin = 'legacy_unlabelled' where origin is null;

-- 5. Decision context
alter table correspondence_decisions add column if not exists engine_version text;
alter table correspondence_decisions add column if not exists from_version_id text;
alter table correspondence_decisions add column if not exists to_version_id text;
alter table correspondence_decisions add column if not exists category_at_decision text;
alter table correspondence_decisions add column if not exists run_id text;

-- Append-only protection for the new decision history table.
do $$
begin
  if exists (select 1 from pg_proc where proname = 'ab_block_mutation') then
    execute 'drop trigger if exists report_observation_links_append_only on report_observation_links';
    execute 'create trigger report_observation_links_append_only before update or delete on report_observation_links for each row execute function ab_block_mutation()';
  end if;
end $$;

-- 6. Registration provenance: how the transform was obtained (automatic algorithm vs supplied externally).
alter table registrations add column if not exists method text;
