-- Migration 0006: Performance indices
-- Adds indices on FK columns that are used in per-study or per-patient lookups
-- to avoid full table scans in common Volume Lab and ReproTrace queries.

create index if not exists idx_finding_versions_study_id on finding_versions (study_id);
create index if not exists idx_finding_versions_finding_id on finding_versions (finding_id);
create index if not exists idx_evidence_links_study_id on evidence_links (study_id);
create index if not exists idx_evidence_links_series_id on evidence_links (series_id);
create index if not exists idx_evidence_links_finding_version_id on evidence_links (finding_version_id);
create index if not exists idx_correspondences_from_study_id on correspondences (from_study_id);
create index if not exists idx_correspondences_to_study_id on correspondences (to_study_id);
create index if not exists idx_correspondences_patient_id on correspondences (patient_id);
create index if not exists idx_discrepancies_patient_id on discrepancies (patient_id);
create index if not exists idx_series_study_id on series (study_id);
create index if not exists idx_studies_patient_id on studies (patient_id);
create index if not exists idx_reports_study_id on reports (study_id);

