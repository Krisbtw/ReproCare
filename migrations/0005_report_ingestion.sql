-- 0005: uploaded clinical reports (TXT / DOCX / PDF) and source-anchored evidence quotes.
--
-- Data minimisation:
--   * The original file never reaches the server. The browser extracts text, de-identifies it, shows the
--     redacted preview, and sends only the confirmed de-identified text plus a SHA-256 of the original file.
--   * The server runs de-identification again before storing (it does not trust the client).
--   * Redactions are stored as kind + length only. Removed values are never stored.
--
-- Provenance:
--   * report_extractions keeps the extractor id, the de-identification method and the full structured
--     extraction JSON, so every extracted item can be traced to [start, end) offsets in reports.body.
--   * evidence_links gains quote_start / quote_end. A report quote is saved only after the server checks that
--     reports.body.slice(start, end) equals the quote exactly.

alter table reports add column if not exists source_kind text not null default 'seeded';

create table if not exists report_extractions (
  id text primary key,
  user_id text not null,
  report_id text not null references reports (id) on delete cascade,
  file_name text not null,
  file_kind text not null check (file_kind in ('txt', 'docx', 'pdf')),
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  deid_method text not null,
  redaction_count integer not null check (redaction_count >= 0),
  redaction_kinds text not null,
  extractor text not null,
  extraction text not null,
  warnings text not null,
  created_at timestamptz not null default now()
);
create index if not exists report_extractions_report_idx on report_extractions (report_id);
create index if not exists report_extractions_user_idx on report_extractions (user_id, created_at);

alter table evidence_links add column if not exists quote_start integer;
alter table evidence_links add column if not exists quote_end integer;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'evidence_links_quote_range') then
    alter table evidence_links
      add constraint evidence_links_quote_range
      check (
        (quote_start is null and quote_end is null)
        or (quote_start >= 0 and quote_end > quote_start)
      );
  end if;
end $$;
