import test from "node:test";
import assert from "node:assert/strict";
import { listZip, readZipEntry } from "./zip.ts";
import { extractReportText, docxXmlToText, textFromContentStream, sniffKind } from "./text.ts";
import { deidentify, looksIdentifying } from "./deidentify.ts";
import { extractReport, findExamDate, longestMm, quoteMatches, sentences } from "./extract.ts";
import { buildDocx, buildPdf, buildZip, SAMPLE_REPORT_LINES } from "./fixtures.ts";

const enc = new TextEncoder();

test("zip: lists and inflates stored and deflated entries", async () => {
  const z = await buildZip([
    { name: "a.txt", data: enc.encode("stored body"), store: true },
    { name: "b.txt", data: enc.encode("deflated body ".repeat(50)) },
  ]);
  const entries = listZip(z);
  assert.deepEqual(entries.map((e) => [e.name, e.method]), [["a.txt", 0], ["b.txt", 8]]);
  assert.equal(new TextDecoder().decode((await readZipEntry(z, "a.txt"))!), "stored body");
  assert.equal(new TextDecoder().decode((await readZipEntry(z, "b.txt"))!), "deflated body ".repeat(50));
  assert.equal(await readZipEntry(z, "missing.txt"), null);
});

test("zip: refuses an entry that inflates beyond the limit (zip-bomb guard)", async () => {
  const z = await buildZip([{ name: "big.txt", data: new Uint8Array(200_000) }]);
  await assert.rejects(() => readZipEntry(z, "big.txt", 10_000), /size limit/);
});

test("zip: not a zip is refused", () => {
  assert.throws(() => listZip(enc.encode("hello world, not a zip at all")), /Not a ZIP/);
});

test("docx: paragraph text, tabs and entities; tracked deletions dropped", () => {
  const xml = `<w:body><w:p><w:r><w:t>Fibroid 5 &amp; 6</w:t></w:r><w:r><w:tab/><w:t>FIGO 4</w:t></w:r></w:p><w:p><w:del><w:r><w:t>DELETED</w:t></w:r></w:del><w:r><w:t xml:space="preserve">Second line</w:t></w:r></w:p></w:body>`;
  assert.equal(docxXmlToText(xml), "Fibroid 5 & 6\tFIGO 4\nSecond line\n");
});

test("docx: end-to-end extraction from a generated Word file", async () => {
  const bytes = await buildDocx(SAMPLE_REPORT_LINES);
  const r = await extractReportText("follow-up.docx", bytes);
  assert.equal(r.kind, "docx");
  assert.equal(r.usable, true);
  assert.match(r.text, /5\.6 x 4\.2 x 3\.3 cm, FIGO 4/);
  assert.match(r.text, /SYNTHETIC DEMONSTRATION REPORT/);
});

test("pdf: content stream operators Tj, TJ with kerning, ' and T*", () => {
  const cs = "BT /F1 12 Tf 10 10 Td (Uterus enlarged) Tj T* [(Fib) -20 (roid) -400 (5.6) ( cm)] TJ (next) ' ET";
  assert.equal(textFromContentStream(cs), "Uterus enlarged\nFibroid 5.6 cm\nnext\n");
});

test("pdf: FlateDecode and uncompressed generated PDFs both extract", async () => {
  for (const uncompressed of [false, true]) {
    const bytes = await buildPdf(SAMPLE_REPORT_LINES, { uncompressed });
    assert.equal(sniffKind(bytes), "pdf");
    const r = await extractReportText("report.pdf", bytes);
    assert.equal(r.usable, true, `uncompressed=${uncompressed}`);
    assert.match(r.text, /intramural fibroid in the anterior wall measures 5\.6 x 4\.2 x 3\.3 cm, FIGO 4/);
    assert.match(r.text, /Exam date: 14\/03\/2026/);
  }
});

test("text: extension/content mismatch is refused, not parsed", async () => {
  await assert.rejects(() => extractReportText("report.pdf", enc.encode("plain text pretending")), /does not look like/);
  await assert.rejects(() => extractReportText("report.exe", enc.encode("x")), /Only \.txt/);
  const docx = await buildDocx(["hi"]);
  await assert.rejects(() => extractReportText("report.txt", docx), /does not look like/);
});

test("text: UTF-8 with BOM, Latin-1 fallback warns", async () => {
  const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...enc.encode("Endometrium 8 mm thick. Uterus anteverted normal size.")]);
  const a = await extractReportText("a.txt", bom);
  assert.equal(a.text.startsWith("Endometrium"), true);
  assert.equal(a.warnings.length, 0);
  const latin = new Uint8Array([...enc.encode("Ovary measures 3 cm caf"), 0xe9, ...enc.encode(" and more text here.")]);
  const b = await extractReportText("b.txt", latin);
  assert.match(b.text, /café/);
  assert.ok(b.warnings.some((w) => /Latin-1/.test(w)));
});

test("text: a near-empty file is marked not usable", async () => {
  const r = await extractReportText("tiny.txt", enc.encode("ok"));
  assert.equal(r.usable, false);
});

test("deid: labelled identifiers, phone, email, Aadhaar-like, honorific names removed; dates and measurements kept", () => {
  const input = [
    "Patient Name: Priya Example",
    "MRN: AB-99812",
    "DOB: 02/04/1991",
    "Mobile: +91 98765 43210",
    "Contact priya.example@mail.test",
    "Aadhaar: 1234 5678 9012",
    "Referred by: Dr. R. Example",
    "Exam date: 14/03/2026. Fibroid 5.6 x 4.2 cm, FIGO 4. Seen by Mrs Anita Sample.",
  ].join("\n");
  const r = deidentify(input);
  for (const leaked of ["Priya Example", "AB-99812", "02/04/1991", "98765", "priya.example@mail.test", "1234 5678 9012", "R. Example", "Anita Sample"]) {
    assert.equal(r.text.includes(leaked), false, `leaked: ${leaked}\n${r.text}`);
  }
  assert.match(r.text, /Exam date: 14\/03\/2026/);
  assert.match(r.text, /5\.6 x 4\.2 cm, FIGO 4/);
  assert.equal(looksIdentifying(r.text), false);
  assert.ok(r.redactions.length >= 7);
  assert.ok(r.redactions.every((x) => typeof x.original_length === "number" && !("value" in x)));
});

test("extract: measurements, FIGO, modality, date, findings, recommendations with exact offsets", () => {
  const text = deidentify(SAMPLE_REPORT_LINES.join("\n")).text;
  const x = extractReport(text);
  assert.equal(x.modality, "MR");
  assert.equal(x.examDate, "2026-03-14");
  const m0 = x.measurements[0];
  assert.deepEqual(m0.values, [5.6, 4.2, 3.3]);
  assert.equal(m0.unit, "cm");
  assert.deepEqual(m0.normalised.map((n) => Number(n.toFixed(1))), [56, 42, 33]);
  assert.equal(longestMm(m0), 56);
  assert.equal(m0.structure, "fibroid");
  assert.equal(quoteMatches(text, m0.start, m0.end, m0.text), true);
  assert.deepEqual(x.figo.map((f) => f.text), ["FIGO 4", "FIGO 6"]);
  const fibroids = x.findings.filter((f) => f.structure === "fibroid" && !f.negated);
  assert.equal(fibroids.length >= 2, true);
  assert.equal(fibroids[0].figo, "4");
  const endo = x.findings.find((f) => f.structure === "endometrioma");
  assert.equal(endo?.negated, true, "No endometrioma is seen -> negated");
  assert.equal(x.recommendations.length, 1);
  assert.match(x.recommendations[0].text, /^Recommend clinical correlation/);
  for (const f of x.findings) assert.equal(quoteMatches(text, f.sentence.start, f.sentence.end, f.sentence.text), true);
});

test("extract: FIGO is only recorded when literally written", () => {
  const x = extractReport("Intramural fibroid in the posterior wall 3 cm.");
  assert.equal(x.figo.length, 0);
  assert.equal(x.findings[0].figo, null);
});

test("extract: dates — day-first numeric, ISO, month names; birth dates ignored; invalid rejected", () => {
  assert.equal(findExamDate("DOB 01/02/1990. Study date 05/06/2025")?.iso, "2025-06-05");
  assert.equal(findExamDate("Report 2026-01-31")?.iso, "2026-01-31");
  assert.equal(findExamDate("Scan performed on 3rd Feb 2025")?.iso, "2025-02-03");
  assert.equal(findExamDate("31/02/2025 only"), null);
});

test("extract: sentence splitter keeps decimals and Dr. together", () => {
  const s = sentences("Fibroid 4.2 cm. Seen by Dr. X today; ovary normal");
  assert.deepEqual(s.map((x) => x.text), ["Fibroid 4.2 cm.", "Seen by Dr. X today;", "ovary normal"]);
});

test("extract: volume units are kept as volumes, not lengths", () => {
  const x = extractReport("Left ovarian volume 12.5 ml with 14 follicles.");
  assert.equal(x.measurements[0].dimension, "volume");
  assert.equal(longestMm(x.measurements[0]), null);
  assert.equal(x.measurements[0].laterality, "left");
});

test("quoteMatches rejects offsets that do not reproduce the quote", () => {
  assert.equal(quoteMatches("abc def", 0, 3, "abc"), true);
  assert.equal(quoteMatches("abc def", 1, 3, "abc"), false);
  assert.equal(quoteMatches("abc def", -1, 3, "abc"), false);
  assert.equal(quoteMatches("abc def", 0, 99, "abc"), false);
});

test("detects scanned PDF limitations and handles FIGO class / nabothian cyst extraction", () => {
  const sample = "Pelvic MRI reveals an anterior intramural leiomyoma, FIGO class 3, measuring 4.2 x 3.8 x 3.5 cm. Small nabothian cyst in the cervix.";
  const ext = extractReport(sample);
  assert.equal(ext.figo.length, 1);
  assert.equal(ext.figo[0].text, "FIGO class 3");
  assert.equal(ext.findings.some((f) => f.structure === "fibroid"), true);
  assert.equal(ext.anatomy.some((a) => a.text === "cervix"), true);
});
