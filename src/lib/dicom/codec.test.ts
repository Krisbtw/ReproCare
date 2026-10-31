import assert from "node:assert/strict";
import test from "node:test";
import dicomParser from "dicom-parser";
import { buildSyntheticMrDicom, readDicom } from "./codec.ts";

test("synthetic DICOM round-trips through dicom-parser without storing the patient name", () => {
  const bytes = buildSyntheticMrDicom();
  const read = readDicom(bytes, (b) => dicomParser.parseDicom(b));
  assert.equal(read.metadata["Modality"], "MR");
  assert.equal(read.metadata["Study date"], "20251102");
  assert.equal(read.metadata["Pixel spacing"], "1.2\\1.2");
  assert.equal(read.renderable, true);
  assert.equal(read.rows, 32);
  assert.equal(read.identifiersWithheld, true);
  assert.equal(read.metadata["Patient name"], undefined);
  assert.ok(read.warnings.some((w) => w.includes("not stored")));
});
