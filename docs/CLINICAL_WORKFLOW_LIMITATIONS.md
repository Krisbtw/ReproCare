# ReproCare / AnatomyBridge — Clinical Workflows, OCR/Report Intelligence & Evidence Limitations

**Last Updated:** 2026-11-02  
**Primary Modules:** `src/lib/clinic/workflows.ts`, `src/lib/clinic/pcos-context.ts`, `src/lib/reports/ocr.ts`, `src/lib/reports/extract.ts`, `src/lib/reports/llm-interpreter.ts`, `src/lib/reports/store.ts`

---

## 1. Six-Tier Evidence Provenance Architecture

Every clinical record, measurement, report extraction, AI output, and pathway entry in ReproCare is tagged with an immutable `ConditionEvidenceTier` (`src/lib/clinic/workflows.ts`) and rendered distinctly in `getUnifiedPatientHistory()`:

| Tier # | `ConditionEvidenceTier` | Source & Clinical Meaning | Can Auto-Promote to Confirmed Assessment? |
| :---: | :--- | :--- | :---: |
| **1** | `patient_reported` | Patient-logged symptoms, pain scores, menstrual bleeding dates, and self-reported history | **No** |
| **2** | `imaging_observation` | Original DICOM studies/series and manual caliper/seeded voxel measurements | **No** (requires clinician review) |
| **3** | `report_extracted` | Verbatim quotes and rule-extracted values from uploaded PDF/DOCX/TXT clinical reports | **No** (requires clinician review) |
| **4** | `ai_experimental` | Unconfirmed 3D U-Net segmentation masks and source-grounded LLM report explanations | **Never** |
| **5** | `clinician_reviewed` | Findings or report extractions inspected and edited/approved by a verified clinician | **Only via explicit clinician sign-off** |
| **6** | `clinician_confirmed_assessment` | Pathway assessments explicitly confirmed (`confirmAssessment: true`) by an authorized verified clinician | Terminal clinician-signed tier |

---

## 2. Four Condition-Specific Reproductive Healthcare Pathways

ReproCare maintains four separate condition-specific clinical modules in `src/lib/clinic/workflows.ts` and **never** forces them into a single shared AI model:

### 2.1 Uterine Fibroids (`fibroids`)
* **Supported Evidence:** Pelvic MRI / ultrasound studies, 3D segmentation masks (`SimpleUnet3D` or seeded manual segmentation), 3-axis dimensions (`axes_mm`), physical volume (`volume_mm3`), FIGO leiomyoma subclassification (`0`, `1`, `2`, `3`, `4`, `5`, `6`, `7`, `8`, `2-5`), bleeding/bulk symptoms, and ReproTrace longitudinal comparison.
* **Safety Guardrails:**
  * Rejects invalid or invented FIGO codes (`VALID_FIGO_LEIOMYOMA_CODES`).
  * Never auto-assigns a confirmed FIGO classification from AI segmentation alone (`figo_source` must be `"not_assigned"`, `"report_stated"`, or `"clinician_entered"`, and `clinically_confirmed` remains `false` until a verified clinician calls `reviewFibroidPathwayAssessment(..., { decision: "confirm" })`).

### 2.2 Endometriosis (`endometriosis`)
* **Supported Evidence:** Dysmenorrhea/dyspareunia/pelvic pain symptom timelines, menstrual history, clinical imaging/pathology reports, anatomical lesion sites, and surgical history (`not_performed`, `laparoscopy_confirmed`, `laparoscopy_negative`, `clinical_working_assessment`).
* **Safety Guardrails:**
  * **Normal Imaging Never Excludes Endometriosis:** Every record enforces `normal_imaging_excludes_endometriosis: false` and attaches an explicit clinical limitation note stating that superficial peritoneal endometriosis and fine adhesions are frequently invisible on standard ultrasound and MRI.
  * **Symptoms Never Localize Lesions:** Enforces `symptom_infers_lesion_location: false`; pain severity does not establish anatomical lesion depth or rASRM stage.

### 2.3 Ovarian Cysts (`cyst` / `ovarian_cyst`)
* **Supported Evidence:** Ovarian laterality (`left`, `right`, `bilateral`), 3-axis measurements and maximum diameter (`max_diameter_mm`), clinician-documented morphology category (`simple_unilocular`, `hemorrhagic_classic`, `endometrioma_ground_glass`, `dermoid_mature_teratoma`, `multilocular`, `solid_component_or_papillary`, `indeterminate_incomplete`), and longitudinal diameter delta tracking against prior cyst records on the same ovary.
* **Safety Guardrails:**
  * **No Autonomous Malignancy or O-RADS Risk Scoring:** Enforces `benign_malignant_classified: false` and rejects any input text or AI summary attempting to issue an unvalidated benign/malignant diagnosis or invented cancer probability score.

### 2.4 Polycystic Ovary Syndrome (`pcos`)
* **Supported Evidence:** Menstrual cycle history, clinical hyperandrogenism, biochemical hormone panel (`totalTestosteroneNgDl`, `freeAndrogenIndex`, `shbgNmolL`, `amhNgMl`, `lhIuL`, `fshIuL`, `tshMiuL`, `prolactinNgMl`, `seventeenOhProgesteroneNgDl`), metabolic context (`bmiKgM2`, `fastingGlucoseMgDl`, `hba1cPct`, `bloodPressureMmHg`, `lipidNotes`), exclusion of mimicking endocrinopathies (thyroid disease, hyperprolactinemia, non-classic CAH), and supporting ovarian ultrasound records.
* **Safety Guardrails:**
  * **Adult vs Adolescent Separation (`src/lib/clinic/pcos-context.ts`):** Computes gynecological age ($\text{currentYear} - \text{menarcheYear}$). For adolescents or patients $< 8\text{ years}$ post-menarche (`adolescent_or_within_8y_menarche`), `adult_criteria_allowed` is set to `false` and adult polycystic ovarian morphology (PCOM) ultrasound criteria are blocked per the 2023 International Evidence-Based PCOS Guideline.
  * **No Diagnosis from Ovarian Appearance Alone:** Enforces `ultrasound_used_as_supporting_only: true` and `diagnosis_from_ovarian_appearance_alone_blocked: true`. Attempting to confirm PCOS from ultrasound appearance without endocrine/ovulatory criteria and exclusion of mimickers throws an explicit validation error.

---

## 3. Clinical Report Ingestion, OCR & LLM Limitations

1. **OCR Capabilities & Limitations (`src/lib/reports/ocr.ts`):**
   - Detects per-page whether a PDF contains native extractable text vs scanned raster image XObjects.
   - Integrates `/usr/bin/tesseract` (`recognizeImageWithTesseract`) for standard PNG, JPEG, TIFF, BMP, and Netpbm image streams alongside deterministic 5×7 grayscale raster glyph recognition (`recognizeGrayscaleRaster`) and PDF `/ActualText` layers.
   - Preserves `1..N` page numbering and never silently drops unreadable pages (`ocrFailed: true` + clinician warning).
   - **No Handwriting Claim:** Explicitly sets `handwritingSupported: false` and `ocrAccuracyClaimed: false`; handwritten clinical notes are not supported and require manual clinician reading of the preserved source document.
2. **Source-Grounded LLM Guardrails (`src/lib/reports/llm-interpreter.ts`):**
   - Operates in `local_extractive` mode by default without external network calls.
   - Every summary statement or Q&A answer is validated by `validateLlmInterpretationOutput()` to ensure its `sourceQuote` literally matches `reportText.slice(start, end)` on the cited `pageNumber` and contains no ungrounded numbers or diagnostic/treatment claims.
   - Clinicians can inspect, edit, approve, or reject extracted fields (`reviewAndEditReportExtraction`, `decideExtractedFinding`) while the original report text and binary artifact remain immutable.
