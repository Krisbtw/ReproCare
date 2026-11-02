# ReproCare / AnatomyBridge — Indian Regulatory, Privacy, Research Ethics & Medical AI Risk Readiness

**Date Checked:** 2026-11-02  
**Jurisdiction:** Republic of India  
**Status:** Technical Proof-of-Principle & Pre-Regulatory Readiness Assessment (*Not CDSCO-approved, not clinically validated, and not cleared for standalone clinical diagnosis*).

---

## 1. Official Regulatory, Legal & Ethical Sources Checked

| Framework / Standard | Official Source & Link | Publication / Notification Date | Date Checked | Relevant Provision / Scope |
| :--- | :--- | :--- | :--- | :--- |
| **Drugs and Cosmetics Act, 1940 & Medical Devices Rules (MDR), 2017** | [CDSCO Medical Devices Rules, 2017 (G.S.R. 78(E))](https://cdsco.gov.in/opencms/resources/UploadCDSCOWeb/2022/m_device/Medical%20Devices%20Rules,%202017.pdf) & [CDSCO Acts & Rules Portal](https://cdsco.gov.in/opencms/opencms/en/Acts-and-rules/Medical-Devices-Rules/) | Notified 31 Jan 2017; effective 01 Jan 2018 (S.O. 648(E) effective 01 Apr 2020) | 2026-11-02 | Rule 3 (Definitions), Rule 4 & First Schedule Part I (Risk Classification Class A–D), Chapter IV/V (Import/Manufacturing Licensing). |
| **CDSCO Guidance on Medical Device Software (MDSW) under MDR-2017** | [CDSCO Guidance Document on Medical Device Software under MDR-2017](https://cdsco.gov.in/opencms/export/sites/CDSCO_WEB/Pdf-documents/Guidance-document-on-Medical-Device-Software-under-MDR-2017.pdf) & [Draft Guidance (21 Oct 2025)](https://cdsco.gov.in/opencms/resources/UploadCDSCOWeb/2018/UploadPublic_NoticesFiles/Draft%20guidance%20document%20on%20Medical%20Device%20Software%2021%2010%202025.pdf) | Draft published 21 Oct 2025; Final Guidance dated 21 July 2026 | 2026-11-02 | Defines Software as a Medical Device (SaMD) / MDSW, intended purpose evaluation, risk classification (Class A/B/C/D), QMS, and clinical evaluation requirements. |
| **Digital Personal Data Protection (DPDP) Act, 2023** | [MeitY Gazette Text — The Digital Personal Data Protection Act, 2023 (No. 22 of 2023)](https://www.meity.gov.in/static/uploads/2024/06/2bf1f0e9f04e6fb4f8fef35e82c42aa5.pdf) | Presidential Assent & Gazette Notification: 11 Aug 2023 | 2026-11-02 | Sections 4–10 (Lawful purpose, notice, consent, consent withdrawal, data fiduciary obligations, security safeguards, erasure), Section 17(2)(b) (research/statistical exemption subject to standards). |
| **Digital Personal Data Protection (DPDP) Rules, 2025** | [PIB / MeitY Notification of DPDP Rules, 2025](https://www.pib.gov.in/PressReleasePage.aspx?PRID=2190655) & [Gazette Establishment of Data Protection Board (14 Nov 2025)](https://www.meity.gov.in/static/uploads/2025/11/cc217843dc3bcb37b2b05bcc3b4e031f.pdf) | Notified Nov 2025 (phased commencement: DPBI rules immediately; core fiduciary notice/consent/security rules on scheduled 18-month commencement phase) | 2026-11-02 | Phased commencement schedule, itemized privacy notices, verifiable consent, security safeguards (encryption, access logs, backups), and breach notification. |
| **Information Technology Act, 2000 & SPDI Rules, 2011** | [MeitY Digital Personal Data Protection & IT Act Portal](https://www.meity.gov.in/content/digital-personal-data-protection-act-2023) | IT Act 2000 (Sec. 43A, 72A); SPDI Rules notified 11 Apr 2011 | 2026-11-02 | Rule 3 defines "physical, physiological and mental health condition" and "medical records and history" as Sensitive Personal Data or Information (SPDI); remains operative until Section 44(2) of DPDP Act 2023 commences. |
| **ICMR National Ethical Guidelines (2017) & AI in Healthcare Guidelines (2023)** | [ICMR Ethical Guidelines for Application of AI in Biomedical Research and Healthcare (2023)](https://www.icmr.gov.in/icmrobject/custom_data/pdf/Ethical-guidelines/Ethical_Guidelines_AI_Healthcare_2023.pdf) & [ICMR Guidelines Portal](https://www.icmr.gov.in/ethical-guidelines-for-application-of-artificial-intelligence-in-biomedical-research-and-healthcare) | Published May 2023 (building on ICMR National Ethical Guidelines 2017) | 2026-11-02 | Requires Institutional Ethics Committee (IEC) approval for human-participant research, human-in-the-loop (HITL) clinical oversight, bias/drift monitoring, explainability, and data governance. |

---

## 2. CDSCO Medical Device Software (MDSW / SaMD) Assessment

### 2.1 Intended Purpose, Users, Population & Environment
* **Current Project Scope:** Experimental MedTech software proof-of-principle and research workbench for multi-modal pelvic imaging visualization, reproducible 3D anatomical measurement, longitudinal finding correspondence (`ReproTrace`), and source-grounded clinical report structuring across uterine fibroids, endometriosis, ovarian cysts, and PCOS.
* **Intended Users:**
  1. Verified, licensed clinicians (gynecologists, radiologists, reproductive endocrinologists) using the clinician workspace for multi-planar/3D review and longitudinal comparison.
  2. Patients using the patient portal to organize their own records, view source-grounded report summaries, and manage granular clinician sharing consents.
* **Patient Population:** Adolescent and adult female / reproductive-health patients undergoing pelvic ultrasound, pelvic MRI, or endocrine evaluation.
* **Intended Clinical Environment:** Non-emergent outpatient gynecology and radiology review (never acute/life-supporting emergency triage).

### 2.2 Potential MDSW Status & Risk Classification Assessment
* Under the [CDSCO Medical Devices Rules, 2017](https://cdsco.gov.in/opencms/resources/UploadCDSCOWeb/2022/m_device/Medical%20Devices%20Rules,%202017.pdf) and the [CDSCO Guidance Document on Medical Device Software under MDR-2017](https://cdsco.gov.in/opencms/export/sites/CDSCO_WEB/Pdf-documents/Guidance-document-on-Medical-Device-Software-under-MDR-2017.pdf):
  * Functions limited strictly to storing, archiving, transferring, or displaying existing medical records without clinical measurement or interpretation may fall outside MDSW scope.
  * **However**, ReproCare includes **3D AI uterine fibroid segmentation (`SimpleUnet3D`)**, **volumetric physical measurement ($\text{mm}^3$) and longitudinal growth-rate calculation (`ReproTrace`)**, and **condition-specific clinical pathway structuring**. When deployed for clinical decision support, disease monitoring, or surgical/therapeutic planning, these capabilities qualify as **Medical Device Software (MDSW / SaMD)**.
  * **Preliminary Risk Classification Estimate (Requires Professional Regulatory Confirmation):** Software intended to inform clinical management or monitor non-life-threatening reproductive conditions typically maps to **Class B** (moderate-low risk), whereas software whose output drives clinical management or surgical intervention for serious gynecological conditions maps to **Class C** (moderate-high risk) under First Schedule Part I of MDR-2017.
  * **Mandatory Caveat:** Describing software as a "research prototype" or "proof-of-principle" does **not** exempt it from CDSCO licensing (Form MD-5 / MD-9 / MD-15 or Clinical Investigation permission under Chapter VII of MDR-2017) if it is used on real patients to guide clinical care. Formal classification and licensing determination by a qualified Indian Regulatory Affairs professional and CDSCO is required prior to any clinical deployment.

---

## 3. Digital Personal Data & Health-Data Privacy Assessment (DPDP Act 2023, DPDP Rules 2025 & IT Act / SPDI Rules 2011)

### 3.1 Operative Status Verification (As of November 2026)
* **IT Act, 2000 (Section 43A) & SPDI Rules, 2011:** Remain the baseline operative statutory regime until Section 44(2) of the DPDP Act, 2023 is brought into force to replace Section 43A. Medical records and reproductive health data are explicitly classified as Sensitive Personal Data or Information (SPDI).
* **DPDP Act, 2023 & DPDP Rules, 2025:** The [DPDP Act, 2023](https://www.meity.gov.in/static/uploads/2024/06/2bf1f0e9f04e6fb4f8fef35e82c42aa5.pdf) was enacted in August 2023, and the [DPDP Rules, 2025](https://www.pib.gov.in/PressReleasePage.aspx?PRID=2190655) were notified in November 2025 with a phased commencement schedule (immediate establishment of the Data Protection Board of India, with an 18-month transition window to May 2027 for full operational enforcement of Data Fiduciary notice, consent manager, and operational compliance rules).

### 3.2 Technical Controls Implemented in ReproCare

| Privacy Requirement | Technical Implementation in ReproCare | Source File Evidence |
| :--- | :--- | :--- |
| **Purpose Limitation & Granular Consent** | Patients grant/revoke 8 specific permissions (`view_demographics` through `approve_or_reject_findings`) per verified clinician with optional expiry timestamps. | `src/lib/clinic/collaboration.ts` |
| **Immediate Withdrawal Enforcement** | `revokeClinicianConsent()` sets `status = 'revoked'` and immediately blocks all subsequent data/imaging access by that clinician while preserving immutable audit logs. | `src/lib/clinic/collaboration.ts`, `src/lib/imaging/storage.server.ts` |
| **Data Minimisation & PHI Scrubbing** | DICOM uploads scrub direct PHI tags (`validateAndScrubDicomBuffer`); exports enforce DICOM PS3.15 (`deidentifyDicomBytes`) and NIfTI-1 (`deidentifyNiftiBytes`) scrubbing. | `src/lib/imaging/storage.server.ts`, `src/lib/dicom/deidentify.ts` |
| **Security Safeguards & Checksums** | Fail-closed RBAC, SHA-256 integrity checks on every read/backup/restore, server-side-only credentials, and durable audit outbox (`.audit/audit-outbox.jsonl`). | `src/lib/imaging/storage.server.ts` |
| **Retention & Audited Erasure** | `purgeImagingArtifact()` performs atomic two-phase binary erasure with mandatory reason logging while preserving the database provenance tombstone. | `src/lib/imaging/storage.server.ts` |
| **External AI Provider Gate** | External LLM transmission is disabled by default (`local_extractive`) and blocked unless `REPROCARE_LLM_EXTERNAL_PRIVACY_APPROVED=true` and `deidentify()` passes. | `src/lib/reports/llm-interpreter.ts` |

* **Non-Equivalence of Consent:** Patient consent in the collaboration UI does not substitute for statutory Data Fiduciary registration, Data Processing Agreements (DPAs) with cloud/AI processors, CERT-In 6-hour cybersecurity incident reporting obligations, or CDSCO/IEC regulatory approvals.

---

## 4. ICMR Research Ethics Readiness

Under the [ICMR Ethical Guidelines for Application of AI in Biomedical Research and Healthcare (2023)](https://www.icmr.gov.in/icmrobject/custom_data/pdf/Ethical-guidelines/Ethical_Guidelines_AI_Healthcare_2023.pdf) and the ICMR National Ethical Guidelines (2017):
1. **Retrospective Public UMD Dataset:** The [UMD dataset](https://pmc.ncbi.nlm.nih.gov/articles/PMC11035617/) was collected under the ethics approval of the original publishing institution and released publicly under CC BY 4.0. However, **another institution's ethics approval does not cover new human-participant research or clinical validation conducted by ReproCare**.
2. **Requirement for Institutional Ethics Committee (IEC) Review:** Any prospective collection of Indian patient MRI/ultrasound scans, clinical validation study, usability study with patients/clinicians, or retraining on local hospital data requires prior protocol submission and written approval (or documented exemption) from a registered Institutional Ethics Committee (IEC), plus informed consent (or an IEC-approved waiver for retrospective de-identified data).

---

## 5. Medical AI Risk Management File (ISO 14971 Assessment)

### 5.1 Standards Applicability Matrix

*(Note: International standards are voluntary technical benchmarks unless specifically mandated by a CDSCO notification or licence condition under MDR-2017 First Schedule).*

| Standard | Current Edition | Relevance & Applicability to ReproCare |
| :--- | :--- | :--- |
| **ISO 14971** | ISO 14971:2019 | **Directly Relevant:** Risk management lifecycle for medical devices; used below to structure ReproCare's 13-hazard risk matrix. |
| **IEC 62304** | IEC 62304:2006+AMD1:2015 | **Directly Relevant:** Medical device software lifecycle processes (software safety classification, architecture, unit/integration verification, configuration management). |
| **ISO 13485** | ISO 13485:2016 | **Relevant for Commercial Manufacturing:** Quality Management System (QMS) standard required under MDR-2017 Fourth Schedule for licensed Class B/C/D device manufacturers. |
| **IEC 82304-1** | IEC 82304-1:2016 | **Relevant:** Health software product safety, validation, and lifecycle instructions for standalone health software. |
| **IEC 62366-1** | IEC 62366-1:2015+AMD1:2020 | **Relevant:** Usability engineering to prevent use errors in clinician/patient interfaces (e.g., preventing confusion between experimental AI outputs and confirmed findings). |

### 5.2 Thirteen-Hazard Medical AI & Imaging Risk Matrix

| # | Hazard | Clinical Harm Scenario | Pre-Mitigation Severity / Likelihood | Technical Mitigation Implemented in ReproCare | Residual Risk & Required Action |
| :---: | :--- | :--- | :---: | :--- | :--- |
| **1** | **False-Positive Segmentation** | Normal myometrium or bowel artifact segmented as a fibroid, causing unnecessary anxiety or intervention. | Moderate / Possible | Labeled `ai_experimental` (`unreviewed`); requires verified clinician review before becoming a confirmed finding. | Low-Moderate; requires clinical validation on real UMD/multi-scanner data. |
| **2** | **False-Negative Segmentation** | Small submucosal (FIGO 0–2) or pedunculated fibroid missed by 3D U-Net. | Serious / Possible | Original 2D/3D MRI slices remain primary; `failed_cases` tracks false negatives during evaluation; manual seeded/caliper segmentation available. | Moderate; AI must never be used to rule out pathology. |
| **3** | **Incorrect Physical Measurements** | Voxel counts interpreted without anisotropic spacing, producing wrong lesion volume ($\text{mL}$). | Serious / Unlikely | `VolumePatientGeometry` and `evaluate_segmentation_case()` enforce physical $\Delta x \cdot \Delta y \cdot \Delta z$ and 4×4 LPS affine transforms; verified by automated tests. | Low. |
| **4** | **Incorrect 3D Reconstruction** | Missing slices or mixed orientations stacked into a distorted 3D uterus/fibroid mesh. | Serious / Possible | `analyzeSeries()` and `readDicomBytes()` block volume assembly on slice gaps, mixed orientations, or inconsistent `PerFrameFunctionalGroupsSequence`. | Low. |
| **5** | **Wrong Lesion Matching (`ReproTrace`)** | Two distinct fibroids in a multi-fibroid uterus matched as the same lesion across visits. | Moderate / Possible | `matchFindings()` gates on registration quality, anatomical compatibility, 3D shape similarity, and adaptive physical uncertainty; defaults to `provisional: true`. | Low-Moderate; requires clinician confirmation (`accept`/`reject`). |
| **6** | **Registration Failure** | Poor rigid alignment between baseline and follow-up MRI leads to spurious growth rate. | Moderate / Possible | `validateTransformMatrix()` checks $\det(R)=+1$ and orthogonality; `evaluateRegistrationEntry()` blocks matching when `NCC < 0.50` or `residual > 15 mm`. | Low. |
| **7** | **Population Bias** | Model trained on a single East Asian cohort (UMD age 21–86) underperforms on Indian reproductive-age cohorts. | Moderate / Likely | Explicitly documented in `docs/DATASET_GOVERNANCE.md`; per-patient metrics and failure cases tracked. | Moderate; requires multi-center Indian clinical validation. |
| **8** | **Scanner & Protocol Bias** | Model trained on Philips Ingenia $3.0\text{ T}$ sagittal T2WI degrades on $1.5\text{ T}$ or axial scans. | Moderate / Likely | ReproTrace flags `scanner_difference` and `protocol_or_spacing_difference`; percentile/z-score normalization applied. | Moderate; requires multi-vendor training/validation. |
| **9** | **Train/Test Data Leakage** | Slices from the same patient split across train and test sets inflate Dice scores. | Moderate / Unlikely | `create_subject_level_split()` and `verify_zero_split_leakage()` enforce strict subject-level partitioning. | Negligible. |
| **10** | **Model Drift & Silent Overwrite** | Retrained model degrades on subcohorts or silently overwrites an evaluated checkpoint. | Moderate / Unlikely | Non-overwrite guard in `train_umd.py`, SHA-256 `checkpoint_registry.json`, and `rollback_checkpoint()` in `imaging-service/app/models.py`. | Low. |
| **11** | **Cybersecurity & IDOR Threats** | Unauthorized user accesses another patient's DICOM files or deletes audit logs. | Serious / Unlikely | Fail-closed RBAC + consent checks, path-traversal guards, two-phase atomic purge, and durable `.audit/audit-outbox.jsonl`. | Low. |
| **12** | **Incorrect User Reliance (Automation Bias)** | Patient or clinician treats unreviewed AI output or LLM summary as a definitive diagnosis. | Serious / Possible | 6-tier evidence labels (`ai_experimental`), mandatory disclaimers, `validateLlmInterpretationOutput()` blocking diagnostic/treatment claims, and clinician sign-off gates. | Low-Moderate; requires IEC 62366-1 formative usability testing. |
| **13** | **Clinical Pathway Misuse** | Normal MRI used to exclude endometriosis, ovarian cyst labeled benign/malignant, or adolescent diagnosed with PCOS via adult PCOM criteria. | Serious / Unlikely | Programmatic guardrails in `src/lib/clinic/workflows.ts` (`normal_imaging_excludes_endometriosis: false`, `benign_malignant_classified: false`, `adult_criteria_allowed: false` for $<8\text{y}$ post-menarche). | Low. |
