# Indian Ethical & Regulatory Readiness Assessment for ReproCare

**Document ID:** `REPROCARE-REG-INDIA-003`  
**Scope:** Research & Development (Sprint 2) vs. Future Clinical Validation & Deployment in India

> **Important Notice:** ReproCare's AI segmentation module is currently an **experimental research prototype** and is **not** a certified or clinically validated medical device. This document maps the applicable Indian ethical, data-protection, and medical-device regulatory frameworks and distinguishes engineering controls implemented now from requirements that mandate external legal, regulatory, and Institutional Ethics Committee (IEC) review.

---

## 1. Applicable Indian Frameworks Verified

### 1.1 ICMR National Ethical Guidelines for Biomedical and Health Research Involving Human Participants (2017)
- **Authority:** Indian Council of Medical Research (ICMR), Department of Health Research, Government of India (published October 2017).
- **Key Provisions Relevant to ReproCare:**
  - All biomedical research involving human participants or their biological/medical data requires prior review and approval by an **Institutional Ethics Committee (IEC)** registered with the National Ethics Committee Registry for Biomedical and Health Research (NECRBHR / DHR).
  - Research on secondary/retrospective medical records or imaging datasets requires IEC review; a waiver of informed consent may only be granted by an IEC when data are fully anonymised and cannot be linked back to individuals (Section 5).
  - International collaboration or transfer of sensitive health data requires appropriate regulatory approvals (including Health Ministry's Screening Committee — HMSC, where applicable).

### 1.2 ICMR Ethical Guidelines for Application of Artificial Intelligence in Biomedical Research and Healthcare (2023)
- **Authority:** Indian Council of Medical Research (ICMR), published 2023.
- **Key Principles Relevant to ReproCare:**
  - **Autonomy & Human-in-the-Loop ("Human Agency and Oversight"):** AI systems in healthcare must not replace clinical judgement. Clinicians must retain final authority to review, verify, or reject AI outputs.
  - **Safety, Reliability & Scientific Validity:** AI models must be trained on representative, bias-audited data and evaluated transparently across subgroups and failure modes before clinical use.
  - **Transparency & Explainability:** Model architecture, training data provenance, version identifiers, and known limitations must be disclosed to clinicians.
  - **Accountability & Auditability:** Every AI inference and clinician decision must be logged in an immutable audit trail.

### 1.3 Digital Personal Data Protection Act, 2023 (DPDP Act, 2023)
- **Authority:** Ministry of Electronics and Information Technology (MeitY), Government of India (Act No. 22 of 2023; enacted August 11, 2023).
- **Key Provisions Relevant to ReproCare:**
  - Applies to the processing of digital personal data within India (or outside India if offering goods/services to Data Principals in India).
  - Requires a clear **Data Fiduciary** notice and free, specific, informed, unconditional, and unambiguous **consent** from the Data Principal (patient) for processing personal health data, with the right to withdraw consent, access, correct, and erase data.
  - **Research & Statistical Exemption (Section 17(2)(b)):** Certain provisions do not apply where personal data are processed necessary for research, archiving, or statistical purposes **only if** the personal data are not used to take any decision specific to a Data Principal and such processing is carried out in accordance with standards prescribed under the DPDP Rules.

### 1.4 CDSCO Medical Devices Rules, 2017 (MDR 2017) & Software as a Medical Device (SaMD) Guidance
- **Authority:** Central Drugs Standard Control Organization (CDSCO), Directorate General of Health Services, Ministry of Health and Family Welfare (G.S.R. 78(E), effective January 1, 2018; mandatory licensing regime for Class A/B from October 2022 and Class C/D from October 2023).
- **Key Provisions Relevant to ReproCare:**
  - Under the First Schedule of MDR 2017, software intended by its manufacturer to be used for human beings for diagnosis, prevention, monitoring, treatment, or alleviation of disease is regulated as a **Medical Device (SaMD)** under risk classes **Class A (low risk), Class B (low-moderate risk), Class C (moderate-high risk), or Class D (high risk)**.
  - Software used purely for general wellness, administrative workflow, or non-clinical laboratory/academic research (not used on patients for clinical care) falls outside clinical deployment licensing until intended for clinical diagnostic/therapeutic use.
  - Clinical investigation of an investigational medical device/SaMD in India requires prior permission from the Central Licensing Authority (CLA) under Chapter VII of MDR 2017 and compliance with ISO 13485 (Quality Management System), ISO 14971 (Risk Management), and IEC 62304 (Medical Device Software Lifecycle).

---

## 2. Four-Tier Regulatory-Readiness Matrix

| Requirement Area | 1. Applicable Now (Implemented in Sprint 2 R&D) | 2. Applicable Before Clinical Deployment / Trials | 3. Dependent on Intended Use & CDSCO Risk Class | 4. Requires External Legal, Ethical or Clinical Review |
| :--- | :--- | :--- | :--- | :--- |
| **Model Honesty & Human Oversight (ICMR AI 2023)** | Experimental badges in `VolumeLab`; refusal to return fabricated masks (`503`); mandatory clinician confirmation checkbox before recording any AI finding version; immutable `audit_events` logging. | Multi-reader clinical usability study verifying clinicians do not over-rely on AI contours (automation bias testing). | Whether AI segmentation is positioned as a passive visualization aid (Class B) vs. quantitative diagnostic/surgical planning tool (Class C). | Clinical workflow sign-off by qualified OB-GYN and radiology leads. |
| **Dataset Provenance & Licensing (UMD / CC BY 4.0)** | Verified UMD provenance documented in `docs/DATASET_PROVENANCE.md` and `app/dataset_governance.py`; raw clinical data excluded from repository. | Local Indian multi-centre MRI validation cohort to assess domain shift across Indian scanners and patient demographics. | Scope of commercial distribution vs. in-house academic research tool. | Legal review of third-party dataset licences prior to any commercial distribution. |
| **Privacy & Data Protection (DPDP Act 2023 & ICMR 2017)** | DICOM PHI tag scrubbing (`app/series.py`, `app/privacy.py`); hard block on training with identifiable/production patient data; server-side API key isolation. | Formal DPDP Data Fiduciary notice, multilingual consent management workflow, Data Protection Impact Assessment (DPIA), and data retention/erasure SLAs. | Whether hosted as a hospital-internal on-premise tool vs. cloud SaaS processing identifiable patient data. | Data Protection Officer (DPO) and Indian legal counsel review of DPDP Rules compliance. |
| **Ethics Committee Governance (ICMR 2017 / 2023)** | `--ethics-approval-ref` gate enforced in `train_umd.py` for any non-public research dataset. | Prior approval from a DHR/NECRBHR-registered Institutional Ethics Committee (IEC) and CTRI registration before any prospective clinical study. | Retrospective anonymised validation vs. prospective interventional study. | Formal review and approval letter from the participating hospital's IEC. |
| **Medical Device Regulation (CDSCO MDR 2017)** | Clear disclaimer in UI, API, and checkpoints (`is_clinical_grade: False`); traceable model versioning, SHA-256 checksums, and reproducible test suites. | ISO 13485 QMS, IEC 62304 software lifecycle documentation, ISO 14971 risk management file, cybersecurity validation, and CDSCO Form MD-3/MD-7/MD-22 submissions. | Official classification determination by CDSCO (Class B vs. Class C SaMD). | Regulatory affairs specialist and CDSCO Central/State Licensing Authority review. |
