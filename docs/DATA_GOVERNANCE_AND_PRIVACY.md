# Medical Imaging Data Governance & Privacy Safeguards

**Document ID:** `REPROCARE-GOV-PRIVACY-002`  
**Implementation Module:** `imaging-service/app/privacy.py`, `imaging-service/app/series.py`, `imaging-service/app/main.py`

## 1. Strict Separation of Medical Data Categories

ReproCare enforces programmatic separation (`DataGovernanceCategory` in `imaging-service/app/privacy.py`) among four distinct categories of medical imaging data:

| Category Enum | Description | Permitted in Model Training (`train_umd.py`)? | Required Safeguards |
| :--- | :--- | :---: | :--- |
| `public_research_dataset` | Publicly released, de-identified research datasets with verified open academic licence (e.g., UMD under CC BY 4.0). | **Yes** | Licence verification, attribution, and DICOM PHI scan check. |
| `anonymised_research_data` | Hospital or research cohort irreversibly de-identified in accordance with ICMR / NEMA PS3.15 standards. | **Conditional** | Requires explicit `--ethics-approval-ref` (IEC/IRB approval ID) and passes automated PHI inspection. |
| `pseudonymised_or_identifiable_patient_data` | Clinical or production patient scans linked to a patient record or containing direct/indirect identifiers. | **NO (Hard Blocked)** | `verify_training_data_governance()` raises `PermissionError` unconditionally. |
| `prospective_clinical_research_data` | New clinical imaging data collected specifically for a research study. | **Conditional** | Requires documented IEC approval (`--ethics-approval-ref`), informed consent, and full de-identification prior to ingestion. |

## 2. DICOM PHI Inspection & Scrubbing

1. **In-Memory PHI Stripping During Inference (`imaging-service/app/series.py`):**
   - Every DICOM slice uploaded to `/series/inspect` or `/segment/{model_id}` has `_strip_phi()` applied immediately upon parsing, deleting `PatientName`, `PatientID`, `PatientBirthDate`, `PatientSex`, `PatientAge`, `PatientAddress`, `PatientTelephoneNumbers`, `OtherPatientIDs`, `OtherPatientNames`, `IssuerOfPatientID`, `InstitutionName`, `InstitutionAddress`, `ReferringPhysicianName`, `PerformingPhysicianName`, `PhysiciansOfRecord`, `OperatorsName`, `AccessionNumber`, and `StudyID`.
   - The browser proxy (`src/lib/imaging/service-client.ts` and `src/routes/api/-imaging-proxy.ts`) replaces all uploaded filenames with neutral sequential names (`slice-0000.dcm`, `slice-0001.dcm`, …) so patient names embedded in local file paths are never transmitted.
2. **Pre-Training DICOM PHI Gate (`imaging-service/app/privacy.py`):**
   - `inspect_dicom_privacy()` inspects all 18 identifying DICOM tags without echoing sensitive tag values into log outputs.
   - `verify_training_data_governance()` scans any `.dcm` files in a candidate training directory and aborts training with a `PermissionError` if any unredacted PHI tag is detected or if the directory path contains clinical storage tokens (`production_patient`, `clinical_patient`, `live_patients`, `patient_uploads`).

## 3. Log Sanitization & Credential Isolation

- **Log Redaction (`sanitize_log_message` & `redact_sensitive_data`):**
  - Training logs, FastAPI exception responses, and series inspection outputs strip or redact email addresses, SSNs, dates of birth, `patient_*` keys, and clinician notes.
- **Server-Side Credential Isolation:**
  - `ANATOMYBRIDGE_SERVICE_API_KEY` is read exclusively by the server-side proxy (`src/routes/api/-imaging-proxy.ts`) and verified via constant-time `hmac.compare_digest` in `imaging-service/app/main.py`. It is never exposed in `VITE_*` client bundles.
- **Stateless Ephemeral Processing:**
  - Uploaded DICOM slices are processed in memory and are never persisted to disk by the Python imaging service.
