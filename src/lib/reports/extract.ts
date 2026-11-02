/**
 * Rule-based structured clinical information extraction from de-identified report text
 * with 4-tier provenance tracking (Sprint 4 Task 2C).
 *
 * Provenance tiers distinguished:
 * 1. `explicitly_stated` — Directly written in the report text with verbatim character offsets.
 * 2. `parser_inferred` — Derived by deterministic rules (e.g., ellipsoid volume from 3-axis lengths
 *    or OCR-recovered text requiring verification).
 * 3. `llm_generated` — Produced by a language model interpretation pass (never treated as a confirmed finding).
 * 4. `clinician_confirmed` — Explicitly reviewed and approved or edited by a verified clinician.
 *
 * Never silently converts an uncertain or negated extraction into a confirmed clinical finding.
 */

export const EXTRACTOR_ID = "anatomybridge-report-rules-1";

export type ExtractionProvenance = ExtractionProvenanceTier;
export type ExtractionProvenanceTier =
  | "explicitly_stated"
  | "parser_inferred"
  | "llm_generated"
  | "clinician_confirmed";

export type Span = { start: number; end: number; text: string; pageNumber?: number };

export type ExtractedMeasurement = Span & {
  values: number[];
  unit: "mm" | "cm" | "ml" | "cc";
  /** Values in mm (lengths) or mL (volumes). */
  normalised: number[];
  dimension: "length" | "volume";
  /** Sentence the measurement sits in, for context. */
  sentence: Span;
  structure: string | null;
  laterality: "left" | "right" | "bilateral" | null;
  anatomicalLocation?: string | null;
  pageNumber: number;
  provenance: ExtractionProvenanceTier;
};

export type ExtractedFinding = {
  structure: string;
  organ: string;
  pathway: "fibroids" | "endometriosis" | "pcos" | "ovarian_cyst" | "general";
  sentence: Span;
  negated: boolean;
  uncertain?: boolean;
  laterality: "left" | "right" | "bilateral" | null;
  anatomicalLocation?: string | null;
  figo: string | null;
  measurementIndexes: number[];
  pageNumber?: number;
  provenance?: ExtractionProvenanceTier;
  reviewStatus?: "unreviewed" | "approved" | "rejected" | "edited";
  reviewedBy?: string | null;
  reviewedAt?: string | null;
  reviewNote?: string | null;
};

export interface StructuredUterineMeasurement {
  text: string;
  dimensionsMm: number[];
  longestMm: number | null;
  volumeMl: number | null;
  endometrialThicknessMm: number | null;
  start: number;
  end: number;
  pageNumber: number;
  provenance: ExtractionProvenanceTier;
}

export interface StructuredFibroidMeasurement {
  index: number;
  text: string;
  dimensionsMm: number[];
  longestMm: number | null;
  volumeMl: number | null;
  volumeMm3: number | null;
  location: string | null;
  laterality: "left" | "right" | "bilateral" | null;
  figo: string | null;
  negated: boolean;
  uncertain: boolean;
  start: number;
  end: number;
  pageNumber: number;
  provenance: ExtractionProvenanceTier;
  reviewStatus: "unreviewed" | "approved" | "rejected" | "edited";
}

export interface StructuredOvarianCystMeasurement {
  text: string;
  laterality: "left" | "right" | "bilateral" | null;
  dimensionsMm: number[];
  longestMm: number | null;
  volumeMl: number | null;
  descriptor: string;
  negated: boolean;
  uncertain: boolean;
  start: number;
  end: number;
  pageNumber: number;
  provenance: ExtractionProvenanceTier;
}

export interface ReportAuthorMetadata {
  statedInSource: boolean;
  roleOrDepartment: string | null;
  institutionRedacted: boolean;
  provenance: ExtractionProvenanceTier;
  note: string;
}

export type Extraction = {
  extractor: string;
  modality: string | null;
  modalityProvenance?: ExtractionProvenanceTier | null;
  examDate: string | null;
  dateSpan: Span | null;
  examDateProvenance?: ExtractionProvenanceTier | null;
  measurements: ExtractedMeasurement[];
  findings: ExtractedFinding[];
  figo: Span[];
  recommendations: Span[];
  impressions?: Span[];
  anatomy: Span[];
  uterineMeasurements?: StructuredUterineMeasurement[];
  fibroidMeasurements?: StructuredFibroidMeasurement[];
  ovarianCystMeasurements?: StructuredOvarianCystMeasurement[];
  reportAuthorOrInstitution?: ReportAuthorMetadata;
  ocrUsed?: boolean;
  reviewStatus?: "unreviewed" | "reviewed" | "corrected" | "rejected";
  notes: string[];
  anatomicalRegion?: string;
  extractionMethod?: string;
  pageCount?: number;
};

type Term = { re: RegExp; structure: string; organ: string; pathway: ExtractedFinding["pathway"] };

const TERMS: Term[] = [
  { re: /\b(fibroids?|leiomyomas?|myomas?)\b/i, structure: "fibroid", organ: "uterus", pathway: "fibroids" },
  { re: /\b(adenomyosis)\b/i, structure: "adenomyosis", organ: "uterus", pathway: "endometriosis" },
  { re: /\b(endometrioma|chocolate cyst)\b/i, structure: "endometrioma", organ: "ovary", pathway: "endometriosis" },
  {
    re: /\b(endometriotic|endometriosis|deep infiltrating|DIE\b|nodule)\b/i,
    structure: "endometriosis lesion",
    organ: "pelvis",
    pathway: "endometriosis",
  },
  { re: /\b(follicles?|polycystic|PCOM)\b/i, structure: "ovarian follicles", organ: "ovary", pathway: "pcos" },
  {
    re: /\b(cysts?|cystic lesion|dermoid|cystadenoma)\b/i,
    structure: "ovarian cyst",
    organ: "ovary",
    pathway: "ovarian_cyst",
  },
  {
    re: /\b(endometrium|endometrial (?:thickness|stripe|lining))\b/i,
    structure: "endometrium",
    organ: "uterus",
    pathway: "general",
  },
  { re: /\b(nabothian(?:\s+cysts?)?)\b/i, structure: "nabothian cyst", organ: "cervix", pathway: "general" },
  { re: /\b(uterus|uterine)\b/i, structure: "uterus", organ: "uterus", pathway: "general" },
  { re: /\b(ovary|ovaries)\b/i, structure: "ovary", organ: "ovary", pathway: "general" },
];

const ANATOMY =
  /\b(uterus|uterine|myometri(?:um|al)|endometri(?:um|al)|cervix|cervical|fundus|fundal|corpus|anterior wall|posterior wall|ovary|ovaries|adnexa(?:l)?|pouch of douglas|rectovaginal|uterosacral|bladder|rectum|sigmoid|fallopian tube|serosa(?:l)?|submucosal|intramural|subserosal|pedunculated|nabothian)\b/gi;

const LOCATION_PHRASE =
  /\b((?:anterior|posterior|fundal|cervical|left|right|lateral|lower segment|upper corpus)?\s*(?:wall|fundus|cervix|submucosal|intramural|subserosal|pedunculated|broad ligament|uterosacral|adnexal|ovarian)(?:\s+(?:wall|intramural|subserosal|submucosal|pedunculated))?)\b/i;

const MEAS =
  /(\d+(?:\.\d+)?)(?:\s*[x×*]\s*(\d+(?:\.\d+)?))?(?:\s*[x×*]\s*(\d+(?:\.\d+)?))?\s*(mm|cm|ml|mL|cc)\b/g;

const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  sept: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function validDate(y: number, m: number, d: number): string | null {
  if (y < 1950 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

/**
 * Determine which 1-based page number a character offset belongs to.
 * Recognizes `[Page N]` markers or form-feed `\f` characters.
 */
export function pageNumberAtOffset(text: string, offset: number): number {
  let page = 1;
  const head = text.slice(0, Math.max(0, offset));
  const markerMatches = [...head.matchAll(/\[Page\s+(\d+)\]/gi)];
  if (markerMatches.length > 0) {
    const last = markerMatches[markerMatches.length - 1];
    const parsed = Number.parseInt(last[1], 10);
    if (Number.isFinite(parsed) && parsed >= 1) return parsed;
  }
  for (let i = 0; i < head.length; i++) {
    if (head[i] === "\f") page += 1;
  }
  return page;
}

/** First date in the text near an exam/report label, else the first date at all. Day-first (Indian convention) for numeric dates. */
export function findExamDate(text: string): { iso: string; span: Span } | null {
  const patterns: { re: RegExp; parse: (m: RegExpMatchArray) => string | null }[] = [
    { re: /\b(\d{4})-(\d{2})-(\d{2})\b/g, parse: (m) => validDate(+m[1], +m[2], +m[3]) },
    { re: /\b(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})\b/g, parse: (m) => validDate(+m[3], +m[2], +m[1]) },
    {
      re: /\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\.?,?\s+(\d{4})\b/gi,
      parse: (m) => validDate(+m[3], MONTHS[m[2].toLowerCase()], +m[1]),
    },
  ];
  const found: { iso: string; span: Span; labelled: boolean }[] = [];
  for (const p of patterns) {
    for (const m of text.matchAll(p.re)) {
      const iso = p.parse(m);
      if (!iso) continue;
      const start = m.index ?? 0;
      const before = text.slice(Math.max(0, start - 40), start).toLowerCase();
      const near = before.split(/[.\n;]\s/).pop() ?? before;
      if (/birth|dob|d\.o\.b/.test(near)) continue;
      found.push({
        iso,
        span: {
          start,
          end: start + m[0].length,
          text: m[0],
          pageNumber: pageNumberAtOffset(text, start),
        },
        labelled: /(exam|study|scan|report|date|performed|acquired)/.test(near),
      });
    }
  }
  if (!found.length) return null;
  found.sort((a, b) => Number(b.labelled) - Number(a.labelled) || a.span.start - b.span.start);
  return { iso: found[0].iso, span: found[0].span };
}

export function findModality(text: string): string | null {
  if (/\b(MRI|MR imaging|magnetic resonance)\b/i.test(text)) return "MR";
  if (/\b(transvaginal|TVS|TVUS|ultrasound|ultrasonograph|sonograph|USG)\b/i.test(text)) return "US";
  if (/\b(CT|computed tomography)\b/.test(text)) return "CT";
  return null;
}

/** Sentence boundaries that do not split decimals ("4.2 cm") or abbreviations like "Dr." */
export function sentences(text: string): Span[] {
  const out: Span[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    const endHere =
      c === "\n" ||
      ((c === "." || c === ";" || c === "!" || c === "?") &&
        !/\d/.test(text[i + 1] ?? "") &&
        !/\b(Dr|Mr|Mrs|Ms|vs|approx|no|e\.g|i\.e)$/i.test(text.slice(Math.max(0, i - 6), i)));
    if (endHere) {
      const raw = text.slice(start, i + (c === "\n" ? 0 : 1));
      const lead = raw.length - raw.trimStart().length;
      const trimmed = raw.trim();
      if (trimmed) {
        const sOffset = start + lead;
        out.push({
          start: sOffset,
          end: sOffset + trimmed.length,
          text: trimmed,
          pageNumber: pageNumberAtOffset(text, sOffset),
        });
      }
      start = i + 1;
    }
  }
  const tail = text.slice(start);
  if (tail.trim()) {
    const lead = tail.length - tail.trimStart().length;
    const sOffset = start + lead;
    out.push({
      start: sOffset,
      end: sOffset + tail.trim().length,
      text: tail.trim(),
      pageNumber: pageNumberAtOffset(text, sOffset),
    });
  }
  return out;
}

function sentenceAt(all: Span[], index: number): Span {
  return (
    all.find((s) => index >= s.start && index < s.end) ?? {
      start: index,
      end: index,
      text: "",
      pageNumber: 1,
    }
  );
}

function laterality(text: string): "left" | "right" | "bilateral" | null {
  if (/\b(bilateral|both ovaries|both adnexa)\b/i.test(text)) return "bilateral";
  const l = /\bleft\b/i.test(text);
  const r = /\bright\b/i.test(text);
  if (l && !r) return "left";
  if (r && !l) return "right";
  return null;
}

function findAnatomicalLocationPhrase(text: string): string | null {
  const m = LOCATION_PHRASE.exec(text);
  return m ? m[1].trim().replace(/\s+/g, " ") : null;
}

const NEGATION =
  /\b(no|not|without|absent|negative for|free of|nil|no evidence of|ruled out|unlikely|cannot identify|unremarkable for)\b[^.;\n]{0,50}$/i;
const UNCERTAINTY =
  /\b(cannot (?:rule out|exclude)|possible|equivocal|suggestive of|suspicious for|indeterminate|questionable|differential includes)\b/i;

export function extractReport(
  text: string,
  options?: { ocrUsed?: boolean; rawTextForMetadata?: string; pages?: any[]; pageCount?: number },
): Extraction {
  const notes: string[] = [];
  const sents = sentences(text);
  const baseProvenance: ExtractionProvenanceTier = options?.ocrUsed
    ? "parser_inferred"
    : "explicitly_stated";

  const measurements: ExtractedMeasurement[] = [];
  for (const m of text.matchAll(MEAS)) {
    const start = m.index ?? 0;
    const unitRaw = m[4].toLowerCase();
    const unit = (unitRaw === "ml" ? "ml" : unitRaw) as ExtractedMeasurement["unit"];
    const values = [m[1], m[2], m[3]].filter((v): v is string => v != null).map(Number);
    const dimension = unit === "ml" || unit === "cc" ? "volume" : "length";
    const normalised = values.map((v) => (unit === "cm" ? v * 10 : v));
    const sentence = sentenceAt(sents, start);
    const term = TERMS.find((t) => t.re.test(sentence.text));
    const pageNumber = pageNumberAtOffset(text, start);
    measurements.push({
      start,
      end: start + m[0].length,
      text: m[0],
      values,
      unit,
      normalised,
      dimension,
      sentence,
      structure: term?.structure ?? null,
      laterality: laterality(sentence.text),
      anatomicalLocation: findAnatomicalLocationPhrase(sentence.text),
      pageNumber,
      provenance: baseProvenance,
    });
  }

  const figo: Span[] = [];
  for (const m of text.matchAll(/\bFIGO\s*(?:type\s*|class\s*)?([0-8](?:\s*-\s*[0-8])?)\b/gi)) {
    const start = m.index ?? 0;
    figo.push({
      start,
      end: start + m[0].length,
      text: m[0],
      pageNumber: pageNumberAtOffset(text, start),
    });
  }

  const findings: ExtractedFinding[] = [];
  for (const s of sents) {
    const term = TERMS.find((t) => t.re.test(s.text));
    if (!term || term.pathway === "general") continue;
    const hit = term.re.exec(s.text);
    const prefix = hit ? s.text.slice(0, hit.index) : "";
    const negated = NEGATION.test(prefix);
    const uncertain = UNCERTAINTY.test(s.text);
    const figoHere = figo.find((f) => f.start >= s.start && f.end <= s.end);
    findings.push({
      structure: term.structure,
      organ: term.organ,
      pathway: term.pathway,
      sentence: s,
      negated,
      uncertain,
      laterality: laterality(s.text),
      anatomicalLocation: findAnatomicalLocationPhrase(s.text),
      figo: figoHere ? figoHere.text.replace(/\D+/g, " ").trim().replace(/\s+/g, "-") : null,
      measurementIndexes: measurements
        .map((mm, i) => (mm.start >= s.start && mm.end <= s.end ? i : -1))
        .filter((i) => i >= 0),
      pageNumber: s.pageNumber ?? 1,
      provenance: uncertain || options?.ocrUsed ? "parser_inferred" : "explicitly_stated",
      reviewStatus: "unreviewed",
    });
  }

  if (findings.some((f) => f.negated))
    notes.push(
      "Some finding sentences are negated (for example 'no fibroid'). They are kept and marked, not treated as findings.",
    );
  if (findings.some((f) => f.uncertain))
    notes.push(
      "Some finding statements express clinical uncertainty (e.g. 'cannot rule out'). They are explicitly marked for clinician review.",
    );

  const recommendations = sents.filter((s) =>
    /\b(recommend|advised?|suggest(?:ed)?|follow[\s-]?up|correlat(?:e|ion)|repeat)\b/i.test(s.text),
  );
  if (recommendations.length)
    notes.push(
      "Recommendation sentences are quoted from the report author. AnatomyBridge does not create recommendations.",
    );

  const impressions = sents.filter((s) =>
    /\b(impression|conclusion|summary|opinion)\s*:/i.test(s.text),
  );

  const anatomy: Span[] = [];
  for (const m of text.matchAll(ANATOMY)) {
    const start = m.index ?? 0;
    anatomy.push({
      start,
      end: start + m[0].length,
      text: m[0],
      pageNumber: pageNumberAtOffset(text, start),
    });
  }

  // Build structured uterine, fibroid, and ovarian cyst measurement collections
  const uterineMeasurements: StructuredUterineMeasurement[] = [];
  const fibroidMeasurements: StructuredFibroidMeasurement[] = [];
  const ovarianCystMeasurements: StructuredOvarianCystMeasurement[] = [];

  measurements.forEach((m, idx) => {
    const sentLower = m.sentence.text.toLowerCase();
    const isNegated = NEGATION.test(m.sentence.text);
    const isUncertain = UNCERTAINTY.test(m.sentence.text);

    if (m.structure === "uterus" || m.structure === "endometrium") {
      const isEndometrium = m.structure === "endometrium" || /\bendometri/i.test(sentLower);
      const dims = m.dimension === "length" ? m.normalised : [];
      const volMl =
        m.dimension === "volume"
          ? m.normalised[0]
          : dims.length === 3
            ? Number(((Math.PI / 6) * (dims[0] / 10) * (dims[1] / 10) * (dims[2] / 10)).toFixed(1))
            : null;
      uterineMeasurements.push({
        text: m.text,
        dimensionsMm: dims,
        longestMm: dims.length ? Math.max(...dims) : null,
        volumeMl: volMl,
        endometrialThicknessMm: isEndometrium && dims.length === 1 ? dims[0] : null,
        start: m.start,
        end: m.end,
        pageNumber: m.pageNumber,
        provenance: m.dimension === "volume" || dims.length < 3 ? baseProvenance : "parser_inferred",
      });
    } else if (m.structure === "fibroid") {
      const dims = m.dimension === "length" ? m.normalised : [];
      const longest = dims.length ? Math.max(...dims) : null;
      const ellipsoidVolMm3 =
        dims.length === 3
          ? Math.round((4 / 3) * Math.PI * (dims[0] / 2) * (dims[1] / 2) * (dims[2] / 2))
          : null;
      const volMl =
        m.dimension === "volume"
          ? m.normalised[0]
          : ellipsoidVolMm3 != null
            ? Number((ellipsoidVolMm3 / 1000).toFixed(2))
            : null;
      const volMm3 =
        m.dimension === "volume" ? Math.round(m.normalised[0] * 1000) : ellipsoidVolMm3;
      const figoInSent = figo.find(
        (f) => f.start >= m.sentence.start && f.end <= m.sentence.end,
      );
      fibroidMeasurements.push({
        index: fibroidMeasurements.length + 1,
        text: m.text,
        dimensionsMm: dims,
        longestMm: longest,
        volumeMl: volMl,
        volumeMm3: volMm3,
        location: m.anatomicalLocation ?? findAnatomicalLocationPhrase(m.sentence.text),
        laterality: m.laterality,
        figo: figoInSent
          ? figoInSent.text.replace(/\D+/g, " ").trim().replace(/\s+/g, "-")
          : null,
        negated: isNegated,
        uncertain: isUncertain,
        start: m.start,
        end: m.end,
        pageNumber: m.pageNumber,
        provenance: isUncertain || options?.ocrUsed ? "parser_inferred" : "explicitly_stated",
        reviewStatus: "unreviewed",
      });
    } else if (m.structure === "ovarian cyst" || m.structure === "endometrioma") {
      const dims = m.dimension === "length" ? m.normalised : [];
      const longest = dims.length ? Math.max(...dims) : null;
      const volMl = m.dimension === "volume" ? m.normalised[0] : null;
      ovarianCystMeasurements.push({
        text: m.text,
        laterality: m.laterality,
        dimensionsMm: dims,
        longestMm: longest,
        volumeMl: volMl,
        descriptor: m.structure,
        negated: isNegated,
        uncertain: isUncertain,
        start: m.start,
        end: m.end,
        pageNumber: m.pageNumber,
        provenance: isUncertain || options?.ocrUsed ? "parser_inferred" : "explicitly_stated",
      });
    }
    void idx;
  });

  // Detect whether report author / department / institution cues exist in the text
  const roleMatch =
    /\b(radiologist|consultant|sonographer|gynaecologist|gynecologist|department of radiology|imaging centre|diagnostic centre|reported by)\b/i.exec(
      text,
    );
  const hasRedactedAuthor = /\[(NAME|DOCTOR|INSTITUTION|HOSPITAL)\s+REMOVED\]/i.test(text);
  const reportAuthorOrInstitution: ReportAuthorMetadata = {
    statedInSource: Boolean(roleMatch || hasRedactedAuthor),
    roleOrDepartment: roleMatch ? roleMatch[0] : null,
    institutionRedacted: hasRedactedAuthor,
    provenance: roleMatch ? "explicitly_stated" : "parser_inferred",
    note:
      roleMatch || hasRedactedAuthor
        ? "Author/institution role detected; direct personal and institutional identifiers are redacted for privacy."
        : "No report author or institution header was stated in the text.",
  };

  const date = findExamDate(text);
  if (!date) notes.push("No examination date was found in the text. Enter it by hand.");
  const modality = findModality(text);
  if (!modality) notes.push("Modality was not stated in the text.");
  if (options?.ocrUsed) {
    notes.push(
      "Text includes OCR-recovered content from scanned pages; all extracted measurements carry 'parser_inferred' provenance until confirmed by a clinician.",
    );
  }

  return {
    extractor: EXTRACTOR_ID,
    modality,
    modalityProvenance: modality ? baseProvenance : null,
    examDate: date?.iso ?? null,
    dateSpan: date?.span ?? null,
    examDateProvenance: date ? baseProvenance : null,
    measurements,
    findings,
    figo,
    recommendations,
    impressions,
    anatomy,
    uterineMeasurements,
    fibroidMeasurements,
    ovarianCystMeasurements,
    reportAuthorOrInstitution,
    ocrUsed: Boolean(options?.ocrUsed),
    reviewStatus: "unreviewed",
    notes,
  };
}

/** Longest length (mm) written in a measurement, or null for volumes. */
export function longestMm(m: ExtractedMeasurement): number | null {
  if (m.dimension !== "length" || !m.normalised.length) return null;
  return Math.max(...m.normalised);
}

/** Verify that a stored quote is literally present at the stored offsets. Used before an evidence link is saved. */
export function quoteMatches(text: string, start: number, end: number, quote: string): boolean {
  return (
    Number.isInteger(start) &&
    Number.isInteger(end) &&
    start >= 0 &&
    end <= text.length &&
    start < end &&
    text.slice(start, end) === quote
  );
}
