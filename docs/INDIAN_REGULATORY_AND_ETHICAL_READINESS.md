# Indian Regulatory, Data Protection & Research Ethics Assessment for ReproCare

**Document ID:** `REPROCARE-REG-INDIA-003`  
**Version:** `2.0 (Final Completion Sprint 1)`  
**Scope:** Student Research Prototype & Experimental Proof of Principle vs. Regulated Clinical Product in India

> **Mandatory Legal & Regulatory Disclaimer:** ReproCare is currently an **experimental research prototype and academic proof of principle**. Passing software unit/integration tests does **not** establish legal, regulatory, ethical, or clinical compliance. ReproCare has **not** been cleared or licensed by the Central Drugs Standard Control Organization (CDSCO), has **not** undergone Institutional Ethics Committee (IEC) review for prospective human-participant studies, and must **not** be deployed for clinical patient care prior to completing the external regulatory, legal, ethical, and multi-centre clinical validation requirements detailed below.

---

## 1. CDSCO & Medical Device Software (SaMD) Assessment

### 1.1 Regulatory Reference Basis
- **Medical Devices Rules, 2017 (MDR 2017):** Notified by the Ministry of Health and Family Welfare (G.S.R. 78(E)), Government of India, under the Drugs and Cosmetics Act, 1940, along with the Medical Devices (Amendment) Rules, 2020 (G.S.R. 102(E)), bringing all medical devices (including standalone software) under mandatory phased registration and licensing (Class A/B mandatory licensing from October 1, 2022; Class C/D from October 1, 2023).
- **CDSCO Guidance Document on Medical Device Software (July 21, 2026 / SaMD Classification & Technical Documentation Framework):** Establishes the qualification criteria, IMDRF-aligned risk classification matrix, clinical evaluation expectations, and lifecycle documentation standards (ISO 13485, ISO 14971, IEC 62304, IEC 82304-1, IEC 62366-1) for Software as a Medical Device (SaMD), including AI/ML-enabled medical software.

### 1.2 Intended Purpose, Users, Population & Use Environment
- **Intended Purpose:** Longitudinal tracking, 3D visualization, multi-study spatial registration, and clinician-reviewed decision support for benign gynaecological conditions (uterine fibroids/leiomyomas, endometriosis, ovarian cysts, and polycystic ovary syndrome — PCOS).
- **Intended Users:**
  1. **Primary Clinical Users:** Registered gynaecologists, radiologists, and reproductive endocrinologists holding verified medical council registration (e.g., National Medical Commission / State Medical Councils).
  2. **Patient Users:** Adult and adolescent patients reviewing their own longitudinal symptom logs, menstrual cycles, and clinician-shared records under explicit consent.
  3. **System Administrators:** Governance personnel managing clinician credential verification and audit logs without unrestricted access to patient medical records.
- **Intended Use Environment:**
  - *Current State:* Controlled academic/software engineering sandbox using synthetic phantoms and de-identified research benchmarks.
  - *Future Target Clinical Environment (Subject to Regulatory Clearance):* Outpatient gynaecology clinics, radiology review workstations, and reproductive medicine centres.
- **Clinical Role of AI Segmentation:**
  - Experimental decision-support adjunct that delineates 4 uterine structures (`uterine_wall`, `cavity`, `myoma`, `nabothian`) on sagittal T2-weighted pelvic MRI to assist — never replace — a qualified clinician in estimating lesion volume and longitudinal growth.
  - All AI outputs are tagged `ai_experimental` and `unreviewed` by default and require explicit clinician confirmation (`clinician_confirmed_assessment`) before entering the confirmed clinical record.

### 1.3 Qualification as Medical Device Software & Risk Classification
- **Why a Research Disclaimer Does Not Exempt Clinical Use:** Under MDR 2017 and the CDSCO Medical Device Software Guidance, whether software qualifies as a regulated Medical Device Software (SaMD) depends on its **intended purpose and actual deployment context** (diagnosis, monitoring, alleviation, or treatment support of disease in human beings), **not** merely on whether the developer places an "experimental/research" banner in the UI. While pure academic laboratory research not involving clinical patient care is outside commercial device licensing, deploying ReproCare in a clinic to inform patient management immediately triggers MDR 2017 regulation.
- **Applicable CDSCO Risk Classification (First Schedule, MDR 2017):**
  - **Class B (Low–Moderate Risk):** Applicable if restricted strictly to passive 3D visualization, structured record organization, and non-diagnostic display where the clinician independently performs all primary measurements on qualified PACS viewers.
  - **Class C (Moderate–High Risk):** Applicable if AI-generated 3D U-Net segmentation masks, automated volumetric growth rates (`mm³/month`), or longitudinal correspondence proposals are used to inform clinical diagnosis, surgical planning (e.g., myomectomy vs. UAE), or therapeutic monitoring.
- **Required Regulatory Pathway Before Clinical Deployment in India:**
  1. Establish an **ISO 13485:2016** certified Quality Management System (QMS).
  2. Compile the Device Master File (DMF) and Plant Master File (PMF) per Fourth Schedule of MDR 2017, incorporating IEC 62304 software lifecycle artifacts, ISO 14971 risk management file, IEC 62366-1 usability engineering file, and cybersecurity verification.
  3. Obtain Institutional Ethics Committee (IEC) approval and Central Licensing Authority (CLA) permission (Form MD-22 / MD-23) for any prospective clinical investigation / multi-centre performance evaluation in India.
  4. Apply for manufacturing/distribution licence via the CDSCO online portal (**Form MD-3 / MD-5** via State Licensing Authority for Class B, or **Form MD-7 / MD-9** via Central Licensing Authority for Class C).

---

## 2. Indian Data Protection & Privacy Assessment

### 2.1 Applicable Statutory Framework
1. **Information Technology Act, 2000 (IT Act, 2000) & SPDI Rules, 2011:**
   - Section 43A (compensation for failure to protect data) and Section 72A (punishment for disclosure of information in breach of lawful contract).
   - Rule 3 of the SPDI Rules, 2011 explicitly classifies **physical, physiological, and mental health conditions, sexual orientation, and medical records and history** as **Sensitive Personal Data or Information (SPDI)**, requiring written/electronic consent (Rule 5), lawful purpose limitation, disclosure restrictions (Rule 6), and ISO/IEC 27001-equivalent security practices (Rule 8).
2. **Digital Personal Data Protection Act, 2023 (DPDP Act, 2023) & DPDP Rules, 2025:**
   - Establishes obligations for **Data Fiduciaries** processing digital personal data of **Data Principals** (patients), including itemized privacy notice (Section 5), free, specific, informed, unconditional, and unambiguous consent with ease of withdrawal (Section 6), technical and organizational security safeguards to prevent personal data breaches (Section 8(5)), data erasure upon consent withdrawal or purpose completion (Section 8(7)), and Data Protection Board / Data Principal breach notification (Section 8(6)).
   - Respects the phased DPDP Rules, 2025 commencement timeline (governance bodies first, followed by core fiduciary notice, consent, security, and cross-border processor obligations).

### 2.2 Technical & Architectural Safeguards Implemented in ReproCare

| DPDP / SPDI Requirement | Engineering Control Implemented in Codebase | Module / File Reference |
| :--- | :--- | :--- |
| **Purpose Limitation** | Every patient–clinician consent record requires an explicit `scope_note` and granular permission array (`view_demographics`, `view_reports`, `view_imaging`, `view_findings`, `view_longitudinal_history`, `add_annotations`, `review_ai_findings`, `approve_or_reject_findings`). | `src/lib/clinic/collaboration.ts` |
| **Data Minimisation** | Menarche is stored as year-only (`menarche_year`); DICOM uploads scrub 16–18 direct PHI tags (`0010,*` and identifying `0008,*` tags) in-place before disk storage and before inference; custom metadata strips credential and PHI keys. | `src/lib/imaging/storage.server.ts`, `imaging-service/app/series.py`, `src/lib/clinic/pcos-context.ts` |
| **Consent & Immediate Withdrawal** | Patients can grant, inspect, and revoke clinician access (`executeGrantClinicianConsent`, `executeRevokeClinicianConsent`). Revocation or expiry (`expires_at <= now()`) is checked on every backend & storage call with zero caching. | `src/lib/clinic/collaboration.ts`, `src/lib/imaging/storage.server.ts` |
| **Fail-Closed Access Control** | `checkPatientAndClinicianAccess` and `verifyCallerIdentityAndProfile` verify user identity, profile existence, approved clinician verification (`verified`/`approved`), patient ownership, and consent scope — failing closed on missing profiles or DB errors. | `src/lib/imaging/storage.server.ts`, `src/lib/clinic/server.ts` |
| **Secure Storage & Integrity** | Binary imaging blobs are stored outside the web root with versioned content-addressed filenames (`v{N}_{sha256}_{id}.bin`), `wx` exclusive creation flags, path-traversal guards, and mandatory SHA-256 verification on read. | `src/lib/imaging/storage.server.ts` |
| **Data Retention & Auditable Deletion** | `purgeImagingArtifact` deletes the binary payload on retention expiry or erasure request while preserving a non-identifying provenance tombstone and writing an append-only `audit_events` record. | `src/lib/imaging/storage.server.ts` |
| **Immutable Audit Trails** | PostgreSQL triggers in `migrations/0003_append_only.sql` forbid `UPDATE`, `DELETE`, and `TRUNCATE` on `audit_events`, `finding_versions`, and `reviews`; `consent_access_logs` records every allowed and denied cross-user access check. | `migrations/0003_append_only.sql`, `migrations/0012_sprint4_collaboration_and_report_intelligence.sql` |
| **External LLM & De-Identification Gate** | `src/lib/reports/deidentify.ts` scrubs patient names, MRNs, phone numbers, emails, addresses, and dates of birth before any optional external LLM call, and blocks external transmission unless `REPROCARE_ALLOW_EXTERNAL_LLM_DEIDENTIFIED=true` is explicitly set. | `src/lib/reports/deidentify.ts`, `src/lib/reports/llm-interpreter.ts` |

---

## 3. Research Ethics & Dataset Governance (UMD & ICMR Guidelines)

1. **UMD Figshare Licence & Attribution Verification:**
   - **Source:** Pan, H., Chen, M., Bai, W., et al., *Scientific Data* 11, 410 (2024), DOI: `10.1038/s41597-024-03170-x`; Figshare Dataset DOI: `10.6084/m9.figshare.23541312`.
   - **Licence:** Creative Commons Attribution 4.0 International (**CC BY 4.0**).
   - **Separation of Ethics Approvals:** The institutional ethics approval obtained by the original UMD authors covers only their retrospective de-identified dataset release. It **must never** be treated as ethics approval for new prospective or retrospective patient research conducted using ReproCare.
2. **ICMR 2017 & ICMR 2023 Healthcare AI Guidelines:**
   - Any collection of new Indian patient imaging, retrospective hospital PACS extraction, or prospective clinical validation study requires prior protocol approval from a DHR/NECRBHR-registered **Institutional Ethics Committee (IEC)** (`--ethics-approval-ref` enforced in `imaging-service/train_umd.py` and `imaging-service/app/privacy.py`), documented informed consent (or an IEC-approved waiver for irreversibly anonymised retrospective data), and Clinical Trials Registry – India (**CTRI**) registration where applicable.

---

## 4. Six-Part Compliance & Readiness Report

| Compliance Category | Concrete Items & Status |
| :--- | :--- |
| **1. Applicable Legal & Regulatory Requirements** | • **India Medical Device Regulation:** Drugs and Cosmetics Act, 1940; Medical Devices Rules, 2017 (MDR 2017); CDSCO Guidance Document on Medical Device Software (July 21, 2026).<br>• **India Data Protection Law:** Information Technology Act, 2000 (Sections 43A, 72A); IT (SPDI) Rules, 2011; Digital Personal Data Protection Act, 2023 (DPDP Act, 2023); DPDP Rules, 2025.<br>• **Biomedical & AI Ethics:** ICMR National Ethical Guidelines for Biomedical and Health Research Involving Human Participants (2017); ICMR Ethical Guidelines for Application of AI in Biomedical Research and Healthcare (2023).<br>• **International Medical Software Standards:** ISO 14971:2019, IEC 62304:2006+A1:2015, ISO 13485:2016, IEC 82304-1:2016, IEC 62366-1:2015. |
| **2. Requirements Already Addressed by the Implementation** | • Fail-closed RBAC, clinician verification (`clinician_verifications`), and granular patient–clinician consent (`patient_clinician_consents`) with immediate revocation/expiry enforcement across all database and imaging storage endpoints (`src/lib/imaging/storage.server.ts`, `src/lib/clinic/server.ts`).<br>• Automated DICOM PHI scrubbing (`0010,*` & `0008,*` tags), metadata credential/PHI redaction, and pre-LLM text de-identification (`src/lib/reports/deidentify.ts`).<br>• Append-only database triggers on `audit_events`, `finding_versions`, and `reviews` (`migrations/0003_append_only.sql`) plus `consent_access_logs`.<br>• Content-addressed, versioned imaging storage with SHA-256 integrity checks and auditable retention purge (`purgeImagingArtifact`).<br>• Programmatic training data governance gate (`verify_training_data_governance`), subject-level 70/15/15 split with zero leakage (`create_subject_level_split`), honest absent-class evaluation (`evaluation.py`), per-patient & failed-case reporting, non-overwrite checkpoint protection, and versioned checkpoint registry with rollback (`models.py`).<br>• Condition-specific safety guardrails (no invented FIGO codes, normal imaging never excludes endometriosis, no unvalidated cyst malignancy claims, adult vs. adolescent `<8y` post-menarche PCOS separation, and 6-tier evidence provenance). |
| **3. Requirements Not Yet Implemented (Infrastructure / Pre-Clinical Blockers)** | • Execution of full 300-case UMD model training on GPU hardware with the external ~1.2 GB Figshare NIfTI archive (`10.6084/m9.figshare.23541312`), which is not bundled in git or mounted in the offline sandbox VM.<br>• Production KMS-backed encryption at rest (e.g., AWS KMS / LUKS volume encryption) and mTLS termination at the production ingress layer.<br>• Automated 72-hour CERT-In / Data Protection Board incident-reporting webhook integration.<br>• Multi-language DPDP patient privacy notice UI (English + scheduled Indian languages per Section 5(3) of DPDP Act, 2023). |
| **4. Requirements Needing External Legal or Regulatory Review** | • Formal legal opinion on CDSCO SaMD risk class determination (**Class B vs. Class C**) based on the final commercial intended-use statement.<br>• Preparation and submission of CDSCO Device Master File (DMF) and Form MD-3 / MD-7 licensing application by a registered Indian Authorized Agent / Manufacturer holding ISO 13485 certification.<br>• Legal review of hospital Data Processing Agreements (DPAs), DPDP Consent Notice text, and cross-border data transfer compliance under DPDP Rules, 2025.<br>• Legal verification of institutional data-release agreements if UMD-trained weights are incorporated into a commercial medical product. |
| **5. Requirements Needing Institutional Ethics Committee (IEC) Review** | • Any retrospective validation study using Indian hospital PACS MRI/ultrasound scans.<br>• Any prospective clinical usability, reader-agreement, or diagnostic accuracy study involving human patients or clinicians.<br>• Verification of patient informed consent forms (or formal IEC waiver of consent for irreversibly anonymised retrospective cohorts) and CTRI trial registration prior to study initiation. |
| **6. Clinical Deployment Appropriateness Determination** | **NOT CURRENTLY APPROPRIATE FOR CLINICAL DEPLOYMENT.**<br>• **Current Classification:** ReproCare is a **student research prototype and experimental proof of principle**.<br>• While its software architecture implements fail-closed security, PHI scrubbing, auditability, and human-in-the-loop guardrails, it has **not** been trained/validated on multi-centre clinical cohorts, holds **no** IEC approval for clinical trials, and holds **no** CDSCO medical device licence. It must be used strictly for non-clinical software verification, academic demonstration, and research development until items 3, 4, and 5 are completed. |
