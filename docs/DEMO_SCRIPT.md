# Demonstration script (about 8 minutes)

Say first: "Everything is synthetic. This is a record and review prototype. It does not diagnose. No trained model is running."

Not browser-tested by the author. Rehearse once before presenting and fix any step that fails.

| Min | Do | Say |
|---|---|---|
| 0:00 | Sign in. Clinician lens. Studio, patient Meera. | "Fibroid pathway, synthetic record." |
| 0:45 | Select the anterior fibroid. | "Slice jumps to the stored index. The report quote is highlighted. Nothing is made up. If no source exists, it says so." |
| 1:45 | Versions. Correct a measurement with a reason. | "This is version 2. Version 1 is still here. Corrections never overwrite." |
| 3:00 | ReproTrace. Open a proposal. | "Likely same, uncertain or needs review. It never merges. Frames are schematic, so proposals stay provisional." |
| 4:00 | Ultrasound vs MRI flag. | "Different method, same label. Called method difference, not growth." |
| 4:45 | Switch to Aisha. | "Limited image quality blocks a 'likely same' label. An unseen finding stays in review." |
| 5:30 | Volume lab, sample series. Click a seed. | "Classical region growing. Not a model. Mesh quality and volume are checked against the known synthetic shape." |
| 6:30 | Record as finding version. | "Extents and a hash of the processing record. No pixels. Not auto-matched because coordinates are not registered." |
| 7:15 | Patient lens, Kavya. | "Cycles and labs are a record. The 2023 PCOS guideline is why no image or hormone value becomes a label." |
| 7:45 | Methods page. | "What was verified, what was not. Dice scores and accuracy are not claimed. No real MRI was run yet." |

## Likely questions

- *Is the segmentation AI?* No. Region growing. The model slot says not connected.
- *Accuracy?* None measured on real data. Only synthetic checks exist.
- *Is anything new?* Linking findings to images and tracking over time appear in earlier patents and products. The narrow idea is the conservative record layer (see `RESEARCH_REPORT.md`, section 6). It is not validated.
- *Regulated?* Not approved. Intended use is education and review of synthetic data. See the Methods page and `RESEARCH_REPORT.md` section 5.
