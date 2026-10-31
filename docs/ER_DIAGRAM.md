# ER diagram

Generated from `migrations/0002_anatomybridge.sql` by parsing `create table` blocks and `references` clauses, so it matches the schema as written. Auth tables (`migrations/0001_auth.sql`) are not shown.

```mermaid
erDiagram
  profiles {
    text user_id PK
    text display_name
    text role
    text active_patient_id
    timestamptz created_at
  }
  patients {
    text id PK
    text user_id
    text code
    text display_name
    integer year_of_birth
    text pathway
    text synopsis
    boolean is_self
    boolean synthetic
  }
  studies {
    text id PK
    text user_id
    text patient_id FK
    text modality
    date study_date
    text description
    text accession
    boolean synthetic
    text source_note
  }
  series {
    text id PK
    text user_id
    text study_id FK
    integer series_number
    text description
    text plane
    double slice_thickness_mm
    text pixel_spacing_mm
    integer slice_count
    text quality
  }
  reports {
    text id PK
    text user_id
    text study_id FK
    date report_date
    text author_role
    text body
    boolean synthetic
  }
  findings {
    text id PK
    text user_id
    text patient_id FK
    text code
    text structure
    text organ
    text pathway
  }
  finding_versions {
    text id PK
    text user_id
    text finding_id FK
    integer version_no
    text previous_version_id
    text study_id FK
    date observed_on
    text location_label
    text figo
    text centroid_mm
    text axes_mm
    double longest_mm
    text measurement_basis
    text frame
    text segmentation_source
    text model_id
    text quality
    text modality
    double report_longest_mm
    text change_reason
    timestamptz created_at
  }
  evidence_links {
    text id PK
    text user_id
    text finding_version_id FK
    text kind
    text study_id
    text series_id
    text report_id
    text quote
    integer slice_index
    text note
  }
  symptoms {
    text id PK
    text user_id
    text patient_id FK
    date recorded_on
    text region
    integer intensity
    integer cycle_day
    text description
    text source
  }
  cycles {
    text id PK
    text user_id
    text patient_id FK
    date start_date
    integer length_days
    text flow
    text note
  }
  labs {
    text id PK
    text user_id
    text patient_id FK
    date observed_on
    text analyte
    text value_text
    text unit
    text reference_text
    text source_note
  }
  correspondences {
    text id PK
    text user_id
    text patient_id FK
    text from_version_id FK
    text to_version_id FK
    text from_study_id
    text to_study_id
    text category
    double score
    text rationale
    boolean provisional
    text engine_version
    boolean active
    timestamptz created_at
  }
  correspondence_decisions {
    text id PK
    text user_id
    text correspondence_id FK
    text decision
    text note
    timestamptz created_at
  }
  discrepancies {
    text id PK
    text user_id
    text patient_id FK
    text category
    text summary
    text detail
    text left_ref
    text right_ref
    text engine_version
    boolean active
    timestamptz created_at
  }
  reviews {
    text id PK
    text user_id
    text target_type
    text target_id
    text status
    text note
    timestamptz created_at
  }
  audit_events {
    text id PK
    text user_id
    timestamptz at
    text action
    text entity_type
    text entity_id
    text detail
  }
  consents {
    text id PK
    text user_id
    text patient_id FK
    text purpose
    boolean granted
    text note
    timestamptz created_at
  }
  dicom_uploads {
    text id PK
    text user_id
    text patient_id FK
    timestamptz received_at
    text file_name
    text transfer_syntax
    text metadata
    text warnings
    boolean identifiers_withheld
  }
  patients ||--o{ studies : "patient_id"
  studies ||--o{ series : "study_id"
  studies ||--o{ reports : "study_id"
  patients ||--o{ findings : "patient_id"
  findings ||--o{ finding_versions : "finding_id"
  studies ||--o{ finding_versions : "study_id"
  finding_versions ||--o{ evidence_links : "finding_version_id"
  patients ||--o{ symptoms : "patient_id"
  patients ||--o{ cycles : "patient_id"
  patients ||--o{ labs : "patient_id"
  patients ||--o{ correspondences : "patient_id"
  finding_versions ||--o{ correspondences : "from_version_id"
  finding_versions ||--o{ correspondences : "to_version_id"
  correspondences ||--o{ correspondence_decisions : "correspondence_id"
  patients ||--o{ discrepancies : "patient_id"
  patients ||--o{ consents : "patient_id"
  patients ||--o{ dicom_uploads : "patient_id"
```

## Entities in the master prompt that have no table yet

Users/permissions beyond a per-account role (`profiles.role`), clinician entity, imaging instances (per-slice rows), segmentations, measurements as their own rows (they live inside `finding_versions`), follow-up examinations, AI model versions as a table (a code list `MODELS` exists), and processing history. Each is a candidate for migration `0003` once the imaging pipeline writes real outputs.
