# User manual (prototype)

Every person, scan and report in the workspace is synthetic. The app does not diagnose, prescribe or claim approval.

## Lenses

The top switch changes the lens between patient, clinician and admin. It is a display and permission switch on your own account, **not** real access control. Anyone signed in can switch it.

## Clinician lens

1. **Studio.** Pick a patient. Select a finding. The schematic slice jumps to the stored slice index and the report quote is highlighted. Open **Versions** to see every version; none is deleted.
2. **Correct a measurement.** Enter three axes in mm and a reason of at least 8 characters. This adds version N+1 and copies one evidence link forward. The old version stays.
3. **Review.** Mark a version, correspondence or discrepancy as verified, rejected or needs more information. A review is a new row.
4. **ReproTrace.** Read correspondence proposals. Accept, reject or defer. Findings are never merged. Read discrepancy labels: measurable difference, method difference, segmentation disagreement, reporting inconsistency, unresolved.
5. **Volume lab.**
   1. Drop a DICOM series (files or a folder) or use the labelled sample.
   2. Read the geometry checks. The lab reports gaps and mixed geometry. It does not repair them.
   3. Click a seed point inside the structure. A classical region-growing mask appears. It is not a trained model.
   4. See the 3D surface and quality checks. Export STL, OBJ and the JSON processing record.
   5. **Record as a finding version** (clinician lens): choose a finding, type a reason, save. Stored: three extents, longest extent, seed slice, note, hash of the processing record. Not stored: pixels, mask, mesh, patient name or ID. Centroid is withheld and the frame is "unavailable" because lab coordinates are not registered to the stored study. The engine therefore leaves this version unpaired and provisional.
6. **Timeline.** Studies, versions, symptoms, cycles and labs in date order.
7. **Export.** JSON export of the synthetic record. Each export writes an audit event.

## Patient lens

- Add symptoms (body region, 0-10 intensity, cycle day, text). They are stored as patient-reported.
- Add cycles and lab values. Labs are stored as entered, with no interpretation.
- Read plain-language explanations. They quote stored report text, or say the source is insufficient.

## What the screens do not do

- No diagnosis, no treatment advice, no malignancy score.
- No absence-of-lesion statement for endometriosis. A negative scan does not rule it out.
- No PCOS label from ovarian images or from AMH.
- No automatic merge of two findings.
- No size change is called progression.
- Trained models (nnU-Net, MONAI, TotalSegmentator) are listed as **not connected**.
