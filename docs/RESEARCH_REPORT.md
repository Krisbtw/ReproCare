# AnatomyBridge research report (Part 2 of the master prompt)

Prepared 2026-10-31 from web searches run in this session. Read this first:

- **Source grade** is stated on every row. `primary` = the publisher, repository or official record was seen in a search result. `secondary` = a law-firm note, news item, review site or aggregator. Secondary rows must be confirmed against the primary before anyone presents them.
- **Not opened.** Several publisher pages (PMC, Nature) blocked the fetch tool. Facts came from search-result excerpts, not from reading full papers. No paper's results section was read in full.
- **Not found** means "my searches did not surface it". It is not proof of absence.
- Nothing here is a legal opinion on patents or regulation.

---

## 1. Existing systems

| System | What it does (as seen) | Evidence grade | Longitudinal / source-level evidence tracking | Limit for this project |
|---|---|---|---|---|
| Visible Patient (Ethicon / J&J MedTech) | Surgeon sends CT/MRI; in-house designers build a 3D model; app for viewing. CE-marked and FDA 510(k) cleared planning suite. Marketing lists lung, colorectal, kidney, liver. | secondary (news, J&J MedTech page) | Not seen | Gynaecologic coverage not verified. Service model, not open. |
| 3D Slicer | Free research platform: segmentation, registration, Python, 3D, extensions. BSD-style licence. Docs state it is not approved for clinical use. | primary (Slicer docs) | Possible via extensions; not verified here | Research tool, not a patient-facing evidence record. |
| MONAI | PyTorch framework for medical-imaging deep learning. Apache-2.0. | secondary (open-source roundup, Aug 2026) | n/a | Trains models; no clinical clearance. Version claim ("v1.6") unverified. |
| OHIF Viewer | Web DICOM viewer, MIT. | secondary | Longitudinal measurement tracking was claimed in an earlier session; **not re-verified** | A viewer, not a finding-history store. |
| TotalSegmentator MRI | nnU-Net model, 80 structures, any MRI sequence. Radiology 2025;314(2):e241613. Dice 0.839 on an internal test set of 55 MRI. Code and dataset public. | primary (RSNA, DKFZ record) | No | Whether uterus is among the 80 and whether it has any fibroid class: **not verified**. The 0.839 is an average over 80 structures, not a fibroid score. |
| Simpleware ScanIP Medical | FDA 510(k), CE, ISO 13485 3D segmentation product. AI segmentation listed for ankle, CMF, heart, hip, knee, shoulder, spine. | primary (vendor datasheet) | Compare-with-post-op images mentioned | No reproductive module listed in the datasheet seen. |
| FMRA (Fibroid Mapping Reviewer Application) | 3-D surface rendering of 2-D ultrasound for fibroid mapping, checked against pathology after hysterectomy. Ultrasound Med Biol 2024;50(1):128-133. | primary (PubMed) | Not seen | Ultrasound only; single-time. |
| "Myomatlas" (named in the master prompt) | **Not found.** No product with that name surfaced. | n/a | n/a | Treat as unverified. Remove from the comparison unless the user can give a link. |

Not searched in this session: existing consumer PCOS apps, AI endometriosis platforms, cyst classifiers, commercial longitudinal-annotation tools. Those rows of the master prompt remain open.

## 2. Literature

Types: **P** peer-reviewed, **PP** preprint, **D** dataset paper. Venue and DOI are as seen in search results.

| Study | Year | Type | What it is | Use / numbers seen | Relevance and limits |
|---|---|---|---|---|---|
| Pan H, Chen M, Bai W, Li B, et al. Large-scale uterine myoma MRI dataset covering all FIGO types with pixel-level annotations. *Sci Data* 11:410. DOI 10.1038/s41597-024-03170-x | 2024 | D, P | UMD. 300 cases, sagittal T2, 6,845 slices, labels: wall, cavity, myoma, nabothian cyst. FIGO 0-8 plus hybrid. All patients had surgery; classes checked against surgical and pathology records. | Age 49.73 ± 12.96. 11 doctors annotated and reviewed. | Primary fibroid dataset. Single time point per case as far as seen. |
| Saleem TJ, Yaqub M. Deep Learning-Based Automated Segmentation of Uterine Myomas. arXiv 2508.11010 | 2025 | PP | nnU-Net v2 on UMD, 246 train / 54 test. | Test Dice: wall 0.86 ± 0.05, cavity 0.79 ± 0.10, myoma 0.70 ± 0.27, nabothian cyst 0.68 ± 0.38. | Preprint. Wide SD on myoma shows unstable lesion segmentation. Whether weights are released: not checked. |
| (UT-EndoMRI) *A Multi-Modal Pelvic MRI Dataset for Deep Learning-Based Pelvic Organ Segmentation in Endometriosis*. *Sci Data*. DOI 10.1038/s41597-025-05623-3, published 2025-07-24 | 2025 | D, P | Multicentre set of 51 subjects with three raters, plus single-centre set of 81 patients (Philips Ingenia 1.5 T). Uterus and ovary labels for all; endometrioma label where visible. Delivered as NIfTI, de-identified. | Baselines with nnU-Net and RAovSeg. | Not a general lesion set. Licence not seen. Author list not seen (an earlier app string named "Liang"; unverified, removed). |
| Akinci D'Antonoli T, et al. TotalSegmentator MRI. *Radiology* 314(2):e241613. DOI 10.1148/radiol.241613 | 2025 | P | See section 1. Trained on 616 MRI + 527 CT. | Dice 0.839 internal; 0.862 vs 0.759 and 0.838 vs 0.560 against two public models on subsets. | Not specific to fibroids. |
| Zhao Q, Lyu S, Bai W, et al. MMOTU. arXiv 2207.06799. Journal version appears to be Lyu S et al., *Pattern Recognition* 2025, DOI 10.1016/j.patcog.2025.112311 (title changed; confirm) | 2022 / 2025 | PP / P | 1,469 2-D ultrasound and 170 CEUS ovarian tumour images, pixel and image labels, eight classes. | | 2-D images, not DICOM volumes. Not longitudinal. |
| Potočnik B, et al. Public database for validation of follicle detection on 3D ultrasound of ovaries. *Comput Methods Programs Biomed* 196:105621. DOI 10.1016/j.cmpb.2020.105621 | 2020 | D, P | USOVA3D: annotated 3-D ovarian ultrasound, ovary and follicles by two gynaecologists. Login needed. | | Closest to PCOS follicle work. Access terms not read. |
| Borna et al. AI-powered diagnosis of ovarian conditions: a newly introduced ultrasound dataset. *Front Physiol* 16. DOI 10.3389/fphys.2025.1520898 | 2025 | D, P | Ultrasound images of Normal, PCO, Dominant Follicle. Article is CC BY. | | Image-level labels. Patient linkage not checked. |
| Application of ML and AI in the diagnosis and classification of PCOS: a systematic review. *Front Endocrinol*. DOI 10.3389/fendo.2023.1106625 | 2023 | P | 31 observational studies. Only 10 used standard diagnostic criteria. About half used ultrasound. | AUC 73-100%; accuracy 89-100% (press summaries). | Review warns validation is weak. Press figures, not read in the paper. |
| Teede HJ, et al. 2023 International Evidence-based Guideline for PCOS. *Fertil Steril*. DOI 10.1016/j.fertnstert.2023.07.025 | 2023 | P (guideline) | Adults: two of three (ovulatory dysfunction, hyperandrogenism, polycystic morphology by ultrasound **or** AMH). Do not use both ultrasound and AMH. Adolescents: need both ovulatory dysfunction and hyperandrogenism; ultrasound not recommended. | | Directly limits the PCOS module. See section 7. |
| Avery JC, et al. Noninvasive diagnostic imaging for endometriosis part 1. *Fertil Steril* 121(2):164-188. DOI 10.1016/j.fertnstert.2023.12.008 | 2024 | P | Systematic review. A negative specialist TVUS cannot exclude endometriosis. AI "still evolving". | | Backs the "absence of lesion is not exclusion" rule. |
| Haber M, et al. Bridging the gap between AI and clinical readiness in endometriosis diagnosis. *J Minim Invasive Gynecol* 2026. DOI 10.1016/j.jmig.2026.04.016 | 2026 | P | Systematic review of MRI/US AI. Up to 94.32% accuracy (MRI), AUC 0.90 (US) reported in abstract. | | Abstract only. Title itself says clinical readiness is lacking. |
| Cai J, et al. Deep Lesion Tracker. arXiv 2012.04872 | 2020 | PP | Siamese tracker using appearance and anatomy; 3,891 lesion pairs from DeepLesion; mean centre error 7 mm. | | CT oncology. Needs a learned model; not reproductive. |
| Mukherjee S, et al. Image registration based automated lesion correspondence pipeline for longitudinal CT data. arXiv 2404.16544 | 2024 | PP | Rigid registration plus adaptive Hungarian matching; metastatic breast cancer trials. | Checked on 25 patients. | Closest in spirit to ReproTrace matching. CT, oncology. |
| Alabed S, et al. LLMs for simplifying radiology reports. *Lancet Digit Health* 8(2):100960. DOI 10.1016/j.landig.2025.100960 | 2026 | P | 38 studies, 12,922 simplified reports. Patients rated them clearer. Error rate 7.2% (13 studies), clinically significant errors 0.9% (2 studies). | | Supports mandatory clinician review before patient release. No real-deployment studies in the review. |
| Munro MG, et al. FIGO classification (PALM-COEIN). *Int J Gynaecol Obstet* 113(1):3-13, DOI 10.1016/j.ijgo.2010.11.011; 2018 revision 143(3):393-408, DOI 10.1002/ijgo.12666 | 2011 / 2018 | P | FIGO leiomyoma types 0-8 and hybrid. | | Laughlin-Tommaso 2017 (IJGO 139:143-148) is cited as showing real agreement problems. |

**Topics with nothing verified.** Evidence provenance, uncertainty-aware segmentation, versioned anatomical records, cross-modal (US vs MRI) fibroid correspondence, ovarian cyst follow-up AI, 3-D pelvic digital twin papers. I did not search these properly. Do not cite anything for them from this file. An earlier app string cites an Egorov pelvic-floor digital-twin paper; it was not re-verified.

## 3. Patent landscape (not exhaustive, not a freedom-to-operate view)

Legal status, expiry, and claim text were **not read** for any row. Jurisdiction comes from the number prefix. Dates are given only where the result showed them.

| Number | Title (as seen) | What the excerpt describes | Overlap to check |
|---|---|---|---|
| US10452813B2 / WO2018093865A1 | Medical image identification and interpretation | AI finds anatomy and anomalies in new images using past images and reports. Tracking module logs findings and user edits. Findings tracked across serial exams. Algorithm version control. | Finding tracking and edit history are **already described**. |
| WO2021067624A1 | AI-assisted medical image interpretation and report generation | Report finding text linked back to its location in the image; bidirectional linking. | Report-to-image linking exists. |
| US9081877B2 | Medical image interpretation system | Extracts a region term from a report and links the image region to the sentence. | Same. |
| US10276265 and US10460838 (USPTO full-text results; titles "Automated anatomically-based reporting of medical images via image annotation") | | Data structure for tracking anatomical findings across studies, with size/position/type parameters. | Cross-study finding tracking exists. Which number carries which text was not matched. |
| US20180055468A1 (IBM) | Tracking anatomical findings within medical images | Filed 2016-08-31, published 2018-03-01 (as listed in a citation table). | Same area. |
| US9020235B2 | Systems and methods for viewing and analyzing anatomical structures | Landmark-by-landmark linking across views and time. | Registration-based linking. |
| US20070076931A1, US20100114597A1 | Display of medical findings; medical imaging reporting | Finding points on a body view open associated data; report matching by anatomic site. | Older linking art. |
| US12020375 (USPTO PDF seen) | Method for generating a 3D printable model of patient-specific anatomy | 2-D images to segmentation to mesh to printable model. | Segmentation-to-mesh pipelines are standard. |

Carry-forward items in the app (US20250331923A1; US 12,762,705 B2) were **not re-found** in this session. Their lines in the app now say so.

**Reading.** Linking a report finding to an image region, tracking findings over serial exams, and logging edits all appear in earlier filings. Do not claim any of those as new. Only a patent attorney can say whether a narrower combination is free to use.

## 4. Datasets for the four conditions

| Dataset | Modality | Size (as seen) | Labels | Patient-linked follow-up? | Format | Access and licence | First-prototype fit |
|---|---|---|---|---|---|---|---|
| UMD (figshare 23541312, v3, 2024-01-18, 4.43 GB) | Sagittal T2 MRI | 300 cases, 6,845 slices | Wall, cavity, myoma, nabothian cyst | **No evidence of it.** Each case looks like one study. | DICOM and NIfTI raw; NIfTI labels | Figshare record lists CC BY 4.0 (also shown in NLM catalog). Anonymised. | **Best for fibroids.** Not for longitudinal. |
| UT-EndoMRI | Multi-sequence pelvic MRI | 51 multicentre + 81 single-centre | Uterus, ovary, endometrioma | Not stated | NIfTI | Licence not seen. | Second choice; endometrioma only. |
| MMOTU | 2-D US and CEUS | 1,469 + 170 | Pixel and class labels (8 classes) | No | Images | Google Drive via GitHub. Licence not seen. | Cysts: images only, no volume. |
| USOVA3D | 3-D ovarian US | not recorded here | Ovary, follicles | Not stated | Volumes | Login required. Terms not read. | Possible for PCOS follicle volumes after access terms are read. |
| Borna 2025 ultrasound set | 2-D US | not recorded here | Normal / PCO / Dominant follicle | Not checked | Images | Paper is CC BY; dataset licence not separately seen. | Classification only. |
| PCOSGen-test (Zenodo 14591782) | 2-D US | 1,468 images | General and specific labels | No | Images | Open on Zenodo; licence text not seen. | Challenge test set. |
| "PCOS Dataset" (figshare 27682557) | 2-D US | 12,680 images | | | | Says images are "sourced from publicly available datasets". | **Avoid.** Possible duplicates and unclear provenance. |

No public dataset found that links one woman's repeated MRI, report, symptoms and labs. So **longitudinal behaviour cannot be validated on real data yet**. Honest options: synthetic pairs (current), or simulate a follow-up by editing UMD labels, clearly labelled as simulated.

## 5. Indian regulatory context (secondary sources only)

- **DPDP Rules 2025.** Gazette G.S.R. 846(E), dated 13 Nov 2025 (some outlets say published 14 Nov). Rules 1, 2, 17-21 in force at once; Rule 4 (Consent Managers) after one year, about 13 Nov 2026; Rules 3, 5-16, 22, 23 after 18 months, about 13 May 2027. MeitY floated cutting 18 months to 12 in Jan 2026; commentary dated Sept-Oct 2026 says no amendment was found. **Re-check on meity.gov.in before presenting.** Sources: law-firm notes (S.S. Rana, AZB via Mondaq, Mirvo Legal, The Privacy Labs).
- **CDSCO software guidance.** Draft guidance on medical device software issued 21 Oct 2025. Final guidance reported published 21 July 2026, reference CDSCO/MD/GD/MDSW/01/2026.1 (NatLawReview, Mondaq, a news summary). Software with a medical purpose is already a device under the Medical Devices Rules 2017, with Class A-D risk tiers. **Primary CDSCO document not opened.** Intended-use wording still decides.
- Research-ethics requirements (ICMR, institutional ethics committee): **not searched**.

## 6. Research gap assessment

**Already established (do not claim):** report-to-image linking; finding tracking over serial exams; edit logs; segmentation-to-mesh; web DICOM viewing; surgical 3-D planning products; registration-based lesion matching in CT oncology; LLM report simplification.

**Candidate contributions worth testing:**

1. A correspondence output that has an explicit "uncertain" state, never merges automatically, and stays provisional when the two findings are not in a common registered frame.
2. A discrepancy taxonomy that separates measurable change, method difference, segmentation disagreement, reporting inconsistency and unresolved uncertainty, and refuses to call any of them progression.
3. An append-only finding object that keeps report quote, measurement, mask-derived numbers and mesh reference together, with reviewer corrections kept as new versions.
4. Patient-reported symptom pins kept visibly separate from clinician findings, with no causal claim.
5. Application to reproductive conditions with the PCOS guideline respected (imaging is not the diagnosis).

**What is still missing to call any of this a finding:** no real longitudinal data; no reader study; no comparison against the registration-based matchers above; no check of whether the patent claims cover the narrow combination. Until then it is a design with a working prototype, not a demonstrated advance.

**Differentiation as stated:** "AnatomyBridge's engine does not try to be a better segmenter or tracker. It adds a conservative record layer over findings: uncertain matches stay unmerged, modality differences are not called progression, and every correction is a new version." That statement is a design claim. It has no validation behind it.

## 7. Feasibility and recommended MVP

- **Done and run (synthetic only):** DICOM series checks, classical region growing, marching-tetrahedra mesh, STL/OBJ export, Dice/HD95 code, ReproTrace rules, lab-to-version link.
- **Next step with real value:** run UMD cases through the Volume lab, then compare the classical mask to UMD labels with the existing Dice/HD95 code. This gives a real, honest baseline number. Whether a pretrained UMD nnU-Net exists to download: **not verified**; otherwise training needs a GPU and a separate Python service.
- **PCOS module check against the 2023 guideline.** Needed: an adolescent flag that suppresses any "ovarian morphology" display as supporting evidence; no ultrasound-plus-AMH double use; copy that PCOS is not an ovary-only condition. Current app text already says imaging alone is not a diagnosis. An adolescent/age-unknown note is now implemented (2026-10-31, `pcos-context.ts`) using an app-chosen age line, because first-period date is not stored. No ultrasound-plus-AMH double use is possible since the app applies no threshold.
- **Not feasible here:** browser test; model training; GPU inference.
