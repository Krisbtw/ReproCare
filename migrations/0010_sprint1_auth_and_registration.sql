-- 0010: Sprint 1 clinician verification lifecycle statuses and ReproTrace registration provenance.

do $$
begin
  if exists (
    select 1 from pg_constraint where conname = 'clinician_verifications_status_check'
  ) then
    alter table clinician_verifications drop constraint clinician_verifications_status_check;
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'clinician_verifications_status_lifecycle_check'
  ) then
    alter table clinician_verifications
      add constraint clinician_verifications_status_lifecycle_check
      check (status in ('pending', 'verified', 'approved', 'rejected', 'suspended', 'revoked'));
  end if;
end $$;

alter table registrations add column if not exists fixed_study_id text;
alter table registrations add column if not exists moving_study_id text;
alter table registrations add column if not exists quality_note text not null default '';
alter table registrations add column if not exists matrix_valid boolean not null default true;

create index if not exists idx_registrations_series_pair on registrations (fixed_series_id, moving_series_id);
create index if not exists idx_registrations_study_pair on registrations (fixed_study_id, moving_study_id);

alter table correspondences add column if not exists from_series_id text;
alter table correspondences add column if not exists to_series_id text;
alter table correspondences add column if not exists registration_id text;
alter table correspondences add column if not exists registration_status text;
alter table correspondences add column if not exists registration_ncc double precision;
alter table correspondences add column if not exists registration_residual_mm double precision;
