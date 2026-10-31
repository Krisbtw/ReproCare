export function ResearchView() {
  return (
    <div className="space-y-8">
      <header className="space-y-2">
        <p className="text-sm font-medium text-pine">Methods, sources, and limits</p>
        <h1 className="text-3xl text-ink">What this prototype is, and what it is not</h1>
        <p className="max-w-3xl text-ink-soft">
          AnatomyBridge is a research and communication prototype. It organises synthetic records, reads DICOM headers in the browser, and runs an explicit rules engine called ReproTrace. It does not diagnose, prescribe, or claim regulatory approval.
        </p>
      </header>

      <section className="space-y-3">
        <h2 className="text-2xl">Research gap</h2>
        <p className="max-w-3xl text-ink-soft">
          Segmentation datasets, DICOM viewers, and surgical 3D models already exist. What the sources below do not provide as one workflow is an append-only reproductive finding memory that keeps the report quote, the measurement, and the mesh on the same object, refuses to merge uncertain matches, and separates a modality difference from a same-method size change.
        </p>
        <div className="overflow-x-auto rounded-lg border border-line bg-card">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead className="bg-paper text-muted">
              <tr>
                <th className="p-3 font-medium">Existing work</th>
                <th className="p-3 font-medium">What it already does</th>
                <th className="p-3 font-medium">Limit relative to this problem</th>
                <th className="p-3 font-medium">What this prototype adds</th>
              </tr>
            </thead>
            <tbody className="text-ink-soft">
              <tr className="border-t border-line">
                <td className="p-3 text-ink">Visible Patient / VP Planning</td>
                <td className="p-3">DICOM CT or MRI to patient-specific 3D models, built by the company’s own designers. A news report and the J&amp;J MedTech page describe the planning suite as CE-marked and FDA 510(k) cleared. Organs named there: lung, colorectal, kidney, liver. Gynaecologic coverage was not verified.</td>
                <td className="p-3">Public pages reviewed emphasise surgical planning across digestive, thoracic, urological, and pediatric work. They do not describe reproductive finding provenance or versioned discrepancy classes.</td>
                <td className="p-3">Not a competing surgical planner. A source-linked finding record a clinician can correct without deleting history.</td>
              </tr>
              <tr className="border-t border-line">
                <td className="p-3 text-ink">OHIF Viewer</td>
                <td className="p-3">Web DICOM viewer (React, Cornerstone). A longitudinal measurement-tracking mode was noted in an earlier session and was not re-verified.</td>
                <td className="p-3">Measurement tracking is not a reproductive evidence graph, and it does not classify why two numbers disagree.</td>
                <td className="p-3">Rules that label method difference, measurable difference, segmentation disagreement, or reporting inconsistency separately.</td>
              </tr>
              <tr className="border-t border-line">
                <td className="p-3 text-ink">3D Slicer, MONAI, TotalSegmentator MRI</td>
                <td className="p-3">Research segmentation and visualisation. TotalSegmentator MRI (Radiology, 18 Feb 2025) reported Dice 0.839 for 80 structures on an internal MRI test set.</td>
                <td className="p-3">That Dice score is not a fibroid or endometriosis result. No weights from that model are loaded here.</td>
                <td className="p-3">An adapter slot marked not connected. No borrowed accuracy number.</td>
              </tr>
              <tr className="border-t border-line">
                <td className="p-3 text-ink">UMD and UT-EndoMRI</td>
                <td className="p-3">Public MRI datasets with organ or myoma labels.</td>
                <td className="p-3">UMD is sagittal T2 and no linked follow-up exams were seen in the sources read. UT-EndoMRI labels organs and endometrioma, not a full longitudinal lesion identity set.</td>
                <td className="p-3">Synthetic longitudinal cases so the reconciliation rules can be inspected before any real scan is used.</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <article className="space-y-2 rounded-lg border border-line bg-card p-4">
          <h2 className="text-xl">Datasets checked, not downloaded</h2>
          <ul className="list-disc space-y-2 pl-5 text-sm text-ink-soft">
            <li>UMD, Pan and colleagues, Scientific Data, 2024. DOI 10.1038/s41597-024-03170-x. 300 myoma MRI cases, sagittal T2, DICOM and NIfTI, labels for uterine wall, cavity, myoma, and nabothian cyst, FIGO types 0–8. Figshare 10.6084/m9.figshare.23541312, CC BY 4.0. This review did not find linked follow-up exams.</li>
            <li>UT-EndoMRI, Scientific Data, published 24 July 2025. DOI 10.1038/s41597-025-05623-3. Two MRI sets: 51 subjects from multiple centres with three raters, and 81 patients from one site. Uterus and ovary labels for all; endometrioma labels where visible. NIfTI, de-identified. Licence and author list were not read. Not a general implant-tracking set.</li>
            <li>MMOTU, Zhao and colleagues, arXiv:2207.06799. 1,469 two-dimensional ultrasound images and 170 contrast-enhanced images with pixel and class labels (arXiv abstract). Images, not DICOM volumes. Licence not read. Not longitudinal.</li>
            <li>No public PCOS dataset reviewed here links ultrasound, hormones, cycles, and repeat visits at patient level. The PCOS module is therefore a record, not an imaging model.</li>
          </ul>
        </article>
        <article className="space-y-2 rounded-lg border border-line bg-card p-4">
          <h2 className="text-xl">Patents glanced at, not a legal opinion</h2>
          <ul className="list-disc space-y-2 pl-5 text-sm text-ink-soft">
            <li>Earlier prototype text listed US20250331923A1 and US 12,762,705 B2. They were not re-found when the sources were rechecked on 2026-10-31, so they are not repeated here.</li>
            <li>Found instead: US10452813B2, WO2021067624A1, US9081877B2 and others describe linking report findings to image regions and tracking findings across serial exams. Treat those ideas as already filed. Claims and legal status were not read. Not a legal opinion.</li>
            <li>The Egorov pelvic-floor digital-twin paper cited earlier was not re-checked and is left out until it is.</li>
          </ul>
        </article>
      </section>

      <section className="space-y-2">
        <h2 className="text-2xl">Technical contribution</h2>
        <p className="max-w-3xl text-ink-soft">
          ReproTrace is an information model plus a rules engine (version reprotrace-rules-1). Every proposal stays provisional when the coordinate frame is schematic rather than image-registered. Nothing is auto-merged. A size gap is “measurable difference” only when modality and measurement basis match and the relative change exceeds 15%. Ultrasound versus MRI with the same label is “method difference”, never progression. Non-visualization of a finding under 20 mm stays in review. Symptom pins are drawn near the model and labeled patient-reported, with no causal claim.
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="text-2xl">Imaging pipeline that actually runs</h2>
        <ul className="list-disc space-y-2 pl-5 text-sm text-ink-soft">
          <li>Browser DICOM reader using dicom-parser. Uncompressed 8-bit grayscale can be drawn. Compressed transfer syntaxes stop at metadata.</li>
          <li>Patient name and ID are not written to the database.</li>
          <li>Selected finding: ellipsoid label volume, 6-connected component count, cuberille surface. Voxel volume is compared with the analytic ellipsoid. Dice and HD95 are omitted because there is no expert reference mask.</li>
          <li>Sagittal stack in Studio is drawn from the stored slice index and centroid. It is a teaching schematic, not a reconstructed acquisition and not a segmentation model.</li>
          <li>Report phrases such as “4.2 cm” and “FIGO 4” are highlighted by a local pattern match. The offsets refer to the stored text. No number is created.</li>
          <li>A plain-language rewrite, when a language model is configured, receives only the stored excerpt and structured fields. If it is not configured, the screen says so and keeps the excerpt.</li>
          <li>nnU-Net, MONAI, and TotalSegmentator are not executed. Their adapter rows say “not connected”.</li>
        </ul>
      </section>

      <section className="space-y-2">
        <h2 className="text-2xl">Safety and Indian regulatory context</h2>
        <p className="max-w-3xl text-sm text-ink-soft">
          The Digital Personal Data Protection Rules, 2025 carry Gazette number G.S.R. 846(E) dated 13 November 2025. Commentary says the Board rules started at once, Consent Manager rules follow after one year, and most duties after 18 months (about May 2027). A proposal to shorten that was reported in January 2026; commentary from autumn 2026 found no amendment. These are law-firm summaries, not the Gazette, so check MeitY before relying on them. CDSCO issued draft medical-device-software guidance on 21 October 2025, and commentary dated July and August 2026 reports final guidance (CDSCO/MD/GD/MDSW/01/2026.1). The primary document was not opened. Software with a medical purpose can already be a device under the Medical Devices Rules, 2017, so intended use decides. AnatomyBridge’s intended use here is education and structured review of synthetic evidence. It is not licensed, not CE-marked, and not CDSCO-approved. This prototype is not a production data-fiduciary system. Explanations start from stored report text. If that text is missing, the screen says the source is insufficient. A plain-language rewrite, when requested, sends only that excerpt and the structured fields — never a DICOM header or a patient identifier. See docs/RESEARCH_REPORT.md for sources and grades.</p>
      </section>

      <section className="space-y-2">
        <h2 className="text-2xl">Walkthrough</h2>
        <ol className="list-decimal space-y-1 pl-5 text-sm text-ink-soft">
          <li>In Studio, select the anterior fibroid. The schematic slice jumps to the stored index. The report quote is highlighted. Open Versions: the demonstration envelope and the clinician edit both remain.</li>
          <li>On the same card, read “Same label, other study”. Ultrasound versus MRI is a method difference. The later MRI longest-axis change, when basis matches, is a measurable difference, not a progression call.</li>
          <li>Open Timeline to see studies, versions, symptoms, and labs in date order.</li>
          <li>Open ReproTrace. Accept or reject a proposal. The finding rows do not merge.</li>
          <li>Read the ultrasound-versus-MRI flag. It is a method difference, not growth or shrinkage.</li>
          <li>Switch to Aisha and note that limited image quality blocks a “likely same” label.</li>
          <li>Switch the lens to patient. Kavya’s cycles and labs are a record, not a PCOS diagnosis.</li>
          <li>In Studio, load the sample DICOM. The header parses; the name on the file is not stored.</li>
        </ol>
      </section>
    </div>
  );
}
