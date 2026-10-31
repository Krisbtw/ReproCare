/**
 * Rule-based structured extraction from (already de-identified) report text.
 *
 * Every extracted item carries [start, end) character offsets into the stored text, so the UI can highlight the
 * exact source and the evidence link can quote it verbatim. Nothing is inferred beyond what the text says:
 *   - measurements are copied with their unit and converted to mm only for comparison;
 *   - a FIGO type is only recorded when the text literally writes "FIGO <n>" / "FIGO type <n>";
 *   - a "recommendation" is only a sentence the report author wrote (recommend / advised / suggest / follow-up);
 *     AnatomyBridge never generates one;
 *   - negations ("no", "without", "not seen") are flagged on the finding sentence, not silently dropped.
 *
 * This is not an NLP model and is not validated on real reports.
 */

export const EXTRACTOR_ID = "anatomybridge-report-rules-1";

export type Span = { start: number; end: number; text: string };

export type ExtractedMeasurement = Span & {
  values: number[];
  unit: "mm" | "cm" | "ml" | "cc";
  /** Values in mm (lengths) or mL (volumes). */
  normalised: number[];
  dimension: "length" | "volume";
  /** Sentence the measurement sits in, for context. */
  sentence: Span;
  structure: string | null;
  laterality: "left" | "right" | null;
};

export type ExtractedFinding = {
  structure: string;
  organ: string;
  pathway: "fibroids" | "endometriosis" | "pcos" | "ovarian_cyst" | "general";
  sentence: Span;
  negated: boolean;
  laterality: "left" | "right" | null;
  figo: string | null;
  measurementIndexes: number[];
};

export type Extraction = {
  extractor: string;
  modality: string | null;
  examDate: string | null;
  dateSpan: Span | null;
  measurements: ExtractedMeasurement[];
  findings: ExtractedFinding[];
  figo: Span[];
  recommendations: Span[];
  anatomy: Span[];
  notes: string[];
};

type Term = { re: RegExp; structure: string; organ: string; pathway: ExtractedFinding["pathway"] };

const TERMS: Term[] = [
  { re: /\b(fibroids?|leiomyomas?|myomas?)\b/i, structure: "fibroid", organ: "uterus", pathway: "fibroids" },
  { re: /\b(adenomyosis)\b/i, structure: "adenomyosis", organ: "uterus", pathway: "endometriosis" },
  { re: /\b(endometrioma|chocolate cyst)\b/i, structure: "endometrioma", organ: "ovary", pathway: "endometriosis" },
  { re: /\b(endometriotic|endometriosis|deep infiltrating|DIE\b|nodule)\b/i, structure: "endometriosis lesion", organ: "pelvis", pathway: "endometriosis" },
  { re: /\b(follicles?|polycystic|PCOM)\b/i, structure: "ovarian follicles", organ: "ovary", pathway: "pcos" },
  { re: /\b(cysts?|cystic lesion|dermoid|cystadenoma)\b/i, structure: "ovarian cyst", organ: "ovary", pathway: "ovarian_cyst" },
  { re: /\b(endometrium|endometrial (?:thickness|stripe|lining))\b/i, structure: "endometrium", organ: "uterus", pathway: "general" },
  { re: /\b(uterus|uterine)\b/i, structure: "uterus", organ: "uterus", pathway: "general" },
  { re: /\b(ovary|ovaries)\b/i, structure: "ovary", organ: "ovary", pathway: "general" },
];

const ANATOMY = /\b(uterus|uterine|myometri(?:um|al)|endometri(?:um|al)|cervix|cervical|fundus|fundal|corpus|anterior wall|posterior wall|ovary|ovaries|adnexa(?:l)?|pouch of douglas|rectovaginal|uterosacral|bladder|rectum|sigmoid|fallopian tube|serosa(?:l)?|submucosal|intramural|subserosal|pedunculated)\b/gi;

const MEAS = /(\d+(?:\.\d+)?)(?:\s*[x×*]\s*(\d+(?:\.\d+)?))?(?:\s*[x×*]\s*(\d+(?:\.\d+)?))?\s*(mm|cm|ml|mL|cc)\b/g;

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function validDate(y: number, m: number, d: number): string | null {
  if (y < 1950 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
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
      // Only the label right before the date counts (text after the last sentence break or newline).
      const near = before.split(/[.\n;]\s/).pop() ?? before;
      if (/birth|dob|d\.o\.b/.test(near)) continue;
      found.push({
        iso,
        span: { start, end: start + m[0].length, text: m[0] },
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
      ((c === "." || c === ";" || c === "!" || c === "?") && !/\d/.test(text[i + 1] ?? "") && !/\b(Dr|Mr|Mrs|Ms|vs|approx|no|e\.g|i\.e)$/i.test(text.slice(Math.max(0, i - 6), i)));
    if (endHere) {
      const raw = text.slice(start, i + (c === "\n" ? 0 : 1));
      const lead = raw.length - raw.trimStart().length;
      const trimmed = raw.trim();
      if (trimmed) out.push({ start: start + lead, end: start + lead + trimmed.length, text: trimmed });
      start = i + 1;
    }
  }
  const tail = text.slice(start);
  if (tail.trim()) {
    const lead = tail.length - tail.trimStart().length;
    out.push({ start: start + lead, end: start + lead + tail.trim().length, text: tail.trim() });
  }
  return out;
}

function sentenceAt(all: Span[], index: number): Span {
  return all.find((s) => index >= s.start && index < s.end) ?? { start: index, end: index, text: "" };
}

function laterality(text: string): "left" | "right" | null {
  const l = /\bleft\b/i.test(text);
  const r = /\bright\b/i.test(text);
  if (l && !r) return "left";
  if (r && !l) return "right";
  return null;
}

const NEGATION = /\b(no|not|without|absent|negative for|free of|nil)\b[^.;\n]{0,40}$/i;

export function extractReport(text: string): Extraction {
  const notes: string[] = [];
  const sents = sentences(text);
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
    });
  }

  const figo: Span[] = [];
  for (const m of text.matchAll(/\bFIGO\s*(?:type\s*)?([0-8](?:\s*-\s*[0-8])?)\b/gi)) {
    figo.push({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length, text: m[0] });
  }

  const findings: ExtractedFinding[] = [];
  for (const s of sents) {
    const term = TERMS.find((t) => t.re.test(s.text));
    if (!term || term.pathway === "general") continue;
    const hit = term.re.exec(s.text);
    const prefix = hit ? s.text.slice(0, hit.index) : "";
    const negated = NEGATION.test(prefix);
    const figoHere = figo.find((f) => f.start >= s.start && f.end <= s.end);
    findings.push({
      structure: term.structure,
      organ: term.organ,
      pathway: term.pathway,
      sentence: s,
      negated,
      laterality: laterality(s.text),
      figo: figoHere ? figoHere.text.replace(/\D+/g, " ").trim().replace(/\s+/g, "-") : null,
      measurementIndexes: measurements.map((mm, i) => (mm.start >= s.start && mm.end <= s.end ? i : -1)).filter((i) => i >= 0),
    });
  }
  if (findings.some((f) => f.negated)) notes.push("Some finding sentences are negated (for example 'no fibroid'). They are kept and marked, not treated as findings.");

  const recommendations = sents.filter((s) => /\b(recommend|advised?|suggest(?:ed)?|follow[\s-]?up|correlat(?:e|ion)|repeat)\b/i.test(s.text));
  if (recommendations.length) notes.push("Recommendation sentences are quoted from the report author. AnatomyBridge does not create recommendations.");

  const anatomy: Span[] = [];
  for (const m of text.matchAll(ANATOMY)) anatomy.push({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length, text: m[0] });

  const date = findExamDate(text);
  if (!date) notes.push("No examination date was found in the text. Enter it by hand.");
  const modality = findModality(text);
  if (!modality) notes.push("Modality was not stated in the text.");

  return {
    extractor: EXTRACTOR_ID,
    modality,
    examDate: date?.iso ?? null,
    dateSpan: date?.span ?? null,
    measurements,
    findings,
    figo,
    recommendations,
    anatomy,
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
  return Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end <= text.length && start < end && text.slice(start, end) === quote;
}
