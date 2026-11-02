/**
 * Source-Grounded LLM Report Interpretation & Question Answering (Sprint 4 Task 2D).
 *
 * Strict Safety, Grounding & Privacy Guardrails:
 * 1. Privacy Gate: Never sends patient-identifiable data to external LLM providers.
 *    External network requests are disabled by default and only permitted when:
 *    - `REPROCARE_LLM_MODE === "external_authorized"`
 *    - `REPROCARE_LLM_EXTERNAL_PRIVACY_APPROVED === "true"`
 *    - `REPROCARE_LLM_API_KEY` (or `XAI_API_KEY`) is configured
 *    - The input report text has passed `deidentify()` and contains zero residual identifiers.
 *    When external provider arrangements are not established, operates in `local_extractive`
 *    or `disabled` mode without any outbound network transmission.
 * 2. Source Grounding: Every generated summary statement or question answer must cite a
 *    verbatim `sourceQuote` / `verbatimQuote`, `[start, end)` character span, and 1-based `pageNumber`
 *    that literally exists in the supplied report text.
 * 3. No Fabricated Findings: Output validation (`validateLlmInterpretationOutput`) verifies
 *    that every cited quote exists in the source text and that no numeric measurement is
 *    introduced unless it literally appears in the source report.
 * 4. No Autonomous Diagnosis or Treatment: Rejects any output that attempts to diagnose a
 *    condition, infer malignancy/cancer, or prescribe/recommend medication or surgery.
 * 5. Unsupported Questions: When asked a question that cannot be answered from the supplied
 *    report text (e.g., prognosis, unmentioned organs, treatment advice, malignancy),
 *    explicitly returns `status: "insufficient_evidence"` and `supported: false`.
 */

import { deidentify, looksIdentifying } from "./deidentify.ts";
import {
  extractReport,
  pageNumberAtOffset,
  quoteMatches,
  sentences,
  type Extraction,
  type ExtractionProvenanceTier,
} from "./extract.ts";

export type LlmIntegrationMode = "disabled" | "local_extractive" | "external_authorized";

export interface SourceCitation {
  reportId?: string | null;
  quote: string;
  verbatimQuote: string;
  pageNumber: number;
  start: number;
  end: number;
  startOffset: number;
  endOffset: number;
}

export interface GroundedSummaryStatement {
  statement: string;
  category: "finding" | "measurement" | "impression" | "recommendation";
  sourceQuote: string;
  pageNumber: number;
  start: number;
  end: number;
  certainty: "stated" | "uncertain" | "negated";
  uncertain: boolean;
  negated: boolean;
  provenance: ExtractionProvenanceTier;
  clinicianReviewed: boolean;
  citation: SourceCitation;
}

export interface GroundedQuestionAnswer {
  question: string;
  supported: boolean;
  status: "answered" | "answered_from_source" | "insufficient_evidence" | "refused_clinical_advice";
  answer: string;
  reason: string;
  citations: SourceCitation[];
  provenance: ExtractionProvenanceTier;
  clinicianReviewed: boolean;
}

export type ReportQuestionAnswerResult = GroundedQuestionAnswer;

export interface ValidatedLlmReportInterpretation {
  status: "completed" | "insufficient_evidence" | "disabled" | "blocked_by_privacy_gate";
  mode: LlmIntegrationMode;
  provider: string;
  externalDataTransmitted: boolean;
  provenance: "llm_generated";
  clinicianReviewed: boolean;
  reportId?: string | null;
  generatedExplanationSummary: string;
  summaryStatements: GroundedSummaryStatement[];
  claims: GroundedSummaryStatement[];
  answeredQuestion?: GroundedQuestionAnswer | null;
  uncertaintyFlags: string[];
  disclaimer: string;
}

export type LlmInterpretationResult = ValidatedLlmReportInterpretation;

export interface LlmConfig {
  mode: LlmIntegrationMode;
  provider?: string;
  apiUrl: string;
  endpointUrl?: string;
  apiKey: string | null;
  model: string;
  externalPrivacyApproved: boolean;
  privacyGateAllowExternalDeidentified?: boolean;
}

export function resolveLlmConfig(overrides?: Partial<LlmConfig>): LlmConfig {
  const envMode = (process.env.REPROCARE_LLM_MODE || "local_extractive")
    .trim()
    .toLowerCase();
  const mode: LlmIntegrationMode =
    overrides?.mode ??
    (overrides?.provider && overrides.provider !== "local_extractive" && overrides.provider !== "disabled"
      ? "external_authorized"
      : envMode === "disabled"
        ? "disabled"
        : envMode === "external_authorized"
          ? "external_authorized"
          : "local_extractive");

  const apiKey =
    overrides?.apiKey !== undefined
      ? overrides.apiKey
      : process.env.REPROCARE_LLM_API_KEY || process.env.XAI_API_KEY || null;

  const externalPrivacyApproved =
    overrides?.externalPrivacyApproved !== undefined
      ? overrides.externalPrivacyApproved
      : overrides?.privacyGateAllowExternalDeidentified !== undefined
        ? overrides.privacyGateAllowExternalDeidentified
        : process.env.REPROCARE_LLM_EXTERNAL_PRIVACY_APPROVED === "true";

  const apiUrl =
    overrides?.apiUrl ||
    overrides?.endpointUrl ||
    process.env.REPROCARE_LLM_API_URL ||
    "https://api.x.ai/v1/chat/completions";

  return {
    mode,
    provider: overrides?.provider || (mode === "local_extractive" ? "local_source_grounded" : "external_llm"),
    apiUrl,
    endpointUrl: apiUrl,
    apiKey,
    model: overrides?.model || process.env.REPROCARE_LLM_MODEL || "grok-4.5",
    externalPrivacyApproved,
    privacyGateAllowExternalDeidentified: externalPrivacyApproved,
  };
}

const UNSUPPORTED_CLINICAL_ADVICE_RE =
  /\b(should I (?:take|have|undergo)|what (?:medication|drug|surgery|treatment|dose)|prescribe|is this (?:cancer|malignant|sarcoma|dangerous|fatal)|will I (?:be infertile|need a hysterectomy)|prognosis|cure)\b/i;

const FORBIDDEN_OUTPUT_CLAIMS_RE =
  /\b(you are diagnosed with|definitive diagnosis of|we recommend starting|you should start|schedule a myomectomy|take \d+(?:\.\d+)?\s*mg|undergo immediate hysterectomy|malignancy is confirmed|leiomyosarcoma confirmed)\b/i;

const MANDATORY_DISCLAIMER =
  "Source-grounded summary of the uploaded report only. Unreviewed AI/automated output is not a medical diagnosis and never recommends treatment.";

/**
 * Validates any candidate LLM interpretation output against the source report text:
 * - Every `sourceQuote` / `verbatimQuote` must literally match `reportText.slice(start, end)`.
 * - Every number in `statement` must appear in `reportText` or equal the cited `pageNumber`.
 * - Rejects any statement or summary containing autonomous diagnostic or treatment claims.
 */
export function validateLlmInterpretationOutput(
  arg1: string | Record<string, unknown>,
  arg2: ValidatedLlmReportInterpretation | string,
  maybeReportId?: string,
): { valid: boolean; errors: string[]; sanitized: ValidatedLlmReportInterpretation } {
  const reportText = typeof arg1 === "string" ? arg1 : String(arg2 ?? "");
  const rawCandidate = (typeof arg1 === "string" ? arg2 : arg1) as Partial<ValidatedLlmReportInterpretation>;
  const reportId = maybeReportId ?? rawCandidate.reportId ?? null;

  const errors: string[] = [];
  const sourceNumbers = new Set(
    [...reportText.matchAll(/\b\d+(?:\.\d+)?\b/g)].map((m) => m[0]),
  );

  if (
    rawCandidate.generatedExplanationSummary &&
    FORBIDDEN_OUTPUT_CLAIMS_RE.test(rawCandidate.generatedExplanationSummary)
  ) {
    errors.push(
      `Rejected autonomous diagnostic or treatment recommendation in summary: "${rawCandidate.generatedExplanationSummary}".`,
    );
  }

  const inputClaims = rawCandidate.summaryStatements ?? rawCandidate.claims ?? [];
  const validStatements: GroundedSummaryStatement[] = [];

  for (const st of inputClaims) {
    const start = st.start ?? st.citation?.startOffset ?? st.citation?.start ?? 0;
    const end = st.end ?? st.citation?.endOffset ?? st.citation?.end ?? 0;
    const quote = st.sourceQuote ?? st.citation?.verbatimQuote ?? st.citation?.quote ?? "";
    const pageNum = st.pageNumber ?? st.citation?.pageNumber ?? 1;

    if (!quoteMatches(reportText, start, end, quote)) {
      errors.push(
        `Citation quote "${quote.slice(0, 60)}" does not match source report text at offsets [${start}, ${end}).`,
      );
      continue;
    }
    if (FORBIDDEN_OUTPUT_CLAIMS_RE.test(st.statement)) {
      errors.push(
        `Rejected autonomous diagnostic or treatment claim in statement: "${st.statement}".`,
      );
      continue;
    }
    const stmtNumbers = [...st.statement.matchAll(/\b\d+(?:\.\d+)?\b/g)].map((m) => m[0]);
    const ungroundedNum = stmtNumbers.find(
      (n) => !sourceNumbers.has(n) && Number(n) !== pageNum,
    );
    if (ungroundedNum) {
      errors.push(
        `Statement contains ungrounded numeric value '${ungroundedNum}' not present in source report.`,
      );
      continue;
    }
    const citation: SourceCitation = {
      reportId,
      quote,
      verbatimQuote: quote,
      pageNumber: pageNum,
      start,
      end,
      startOffset: start,
      endOffset: end,
    };
    validStatements.push({
      ...st,
      sourceQuote: quote,
      pageNumber: pageNum,
      start,
      end,
      citation,
    });
  }

  const sanitized: ValidatedLlmReportInterpretation = {
    status: rawCandidate.status ?? (validStatements.length > 0 ? "completed" : "insufficient_evidence"),
    mode: rawCandidate.mode ?? "local_extractive",
    provider: rawCandidate.provider ?? "local_source_grounded",
    externalDataTransmitted: Boolean(rawCandidate.externalDataTransmitted),
    provenance: "llm_generated",
    clinicianReviewed: Boolean(rawCandidate.clinicianReviewed),
    reportId,
    generatedExplanationSummary:
      rawCandidate.generatedExplanationSummary && !FORBIDDEN_OUTPUT_CLAIMS_RE.test(rawCandidate.generatedExplanationSummary)
        ? rawCandidate.generatedExplanationSummary
        : validStatements.map((s) => s.statement).join(" "),
    summaryStatements: validStatements,
    claims: validStatements,
    answeredQuestion: rawCandidate.answeredQuestion ?? null,
    uncertaintyFlags: rawCandidate.uncertaintyFlags ?? [],
    disclaimer: MANDATORY_DISCLAIMER,
  };

  return {
    valid: errors.length === 0,
    errors,
    sanitized,
  };
}

/**
 * Answer a user or clinician question strictly from the supplied report text.
 * Supports both positional `(reportText, question, extraction?)` and object input
 * `{ reportId?, deidentifiedText?, reportText?, structuredExtraction?, question }`.
 */
export function answerQuestionFromSourceReport(
  arg1:
    | string
    | {
        reportId?: string | null;
        deidentifiedText?: string;
        reportText?: string;
        structuredExtraction?: Extraction;
        question: string;
      },
  maybeQuestion?: string,
  maybeExtraction?: Extraction,
): GroundedQuestionAnswer {
  const reportText =
    typeof arg1 === "string"
      ? arg1
      : String(arg1.deidentifiedText ?? arg1.reportText ?? "");
  const cleanQ = String(typeof arg1 === "string" ? maybeQuestion : arg1.question ?? "").trim();
  const reportId = typeof arg1 === "string" ? null : (arg1.reportId ?? null);
  const providedExtraction =
    typeof arg1 === "string" ? maybeExtraction : arg1.structuredExtraction;

  if (!cleanQ) {
    return {
      question: "",
      supported: false,
      status: "insufficient_evidence",
      answer: "Insufficient evidence in the source report: no question was provided.",
      reason: "No question was provided.",
      citations: [],
      provenance: "llm_generated",
      clinicianReviewed: false,
    };
  }

  if (UNSUPPORTED_CLINICAL_ADVICE_RE.test(cleanQ)) {
    return {
      question: cleanQ,
      supported: false,
      status: "refused_clinical_advice",
      answer:
        "Insufficient evidence in the source report: ReproCare only summarizes findings written in the report and cannot diagnose conditions, assess malignancy risk, or recommend medications or surgery.",
      reason:
        "ReproCare only summarizes findings written in the report and cannot diagnose conditions or recommend treatment.",
      citations: [],
      provenance: "llm_generated",
      clinicianReviewed: false,
    };
  }

  const ext = providedExtraction ?? extractReport(reportText);
  const sents = sentences(reportText);
  const qLower = cleanQ.toLowerCase();

  const stopWords = new Set([
    "and",
    "not",
    "can",
    "how",
    "who",
    "what",
    "where",
    "when",
    "which",
    "does",
    "did",
    "the",
    "this",
    "that",
    "report",
    "say",
    "about",
    "are",
    "was",
    "were",
    "for",
    "with",
    "from",
    "have",
    "has",
    "there",
    "any",
    "size",
    "measured",
    "stated",
    "reported",
    "patient",
    "patients",
    "level",
    "status",
  ]);
  const keywords = [...qLower.matchAll(/\b[a-z0-9]{3,}\b/g)]
    .map((m) => m[0])
    .filter((w) => !stopWords.has(w));

  if (keywords.length === 0) {
    return {
      question: cleanQ,
      supported: false,
      status: "insufficient_evidence",
      answer: "Insufficient evidence in the source report to answer this question.",
      reason: "The question is too general to match specific statements in the report.",
      citations: [],
      provenance: "llm_generated",
      clinicianReviewed: false,
    };
  }

  const reportLower = reportText.toLowerCase();
  const matchedKeywords = keywords.filter((kw) => {
    if (["fibroid", "fibroids", "myoma", "leiomyoma", "measurements", "classification"].includes(kw)) {
      return /\b(fibroid|leiomyoma|myoma|figo|mm|cm)\b/i.test(reportText);
    }
    if (["cyst", "cysts", "ovary", "ovarian"].includes(kw)) {
      return /\b(cyst|ovar|adnexa)\b/i.test(reportText);
    }
    if (["recommendation", "recommendations", "follow"].includes(kw)) {
      return ext.recommendations.length > 0 || /\b(recommend|follow-up|follow up)\b/i.test(reportText);
    }
    return reportLower.includes(kw);
  });

  if (matchedKeywords.length === 0) {
    return {
      question: cleanQ,
      supported: false,
      status: "insufficient_evidence",
      answer: `Insufficient evidence in the source report: the report does not contain information about ${keywords.join(", ")}.`,
      reason: `Insufficient evidence: The supplied report does not mention '${keywords.join(", ")}'.`,
      citations: [],
      provenance: "llm_generated",
      clinicianReviewed: false,
    };
  }

  const matchedSents = sents.filter((s) => {
    const sLow = s.text.toLowerCase();
    return matchedKeywords.some((kw) => {
      if (kw === "measurements") return /\b(mm|cm)\b/i.test(s.text);
      if (kw === "recommendation" || kw === "recommendations" || kw === "follow") {
        return /\b(recommend|follow-up|follow up|correlation)\b/i.test(s.text);
      }
      return sLow.includes(kw);
    });
  });

  if (matchedSents.length === 0) {
    return {
      question: cleanQ,
      supported: false,
      status: "insufficient_evidence",
      answer: "Insufficient evidence in the source report to answer this question.",
      reason: "Insufficient evidence in the source report to answer this question.",
      citations: [],
      provenance: "llm_generated",
      clinicianReviewed: false,
    };
  }

  const topSents = matchedSents.slice(0, 3);
  const citations: SourceCitation[] = topSents.map((s) => ({
    reportId,
    quote: s.text,
    verbatimQuote: s.text,
    pageNumber: s.pageNumber ?? pageNumberAtOffset(reportText, s.start),
    start: s.start,
    end: s.end,
    startOffset: s.start,
    endOffset: s.end,
  }));

  const answerParts = citations.map((c) => `Page ${c.pageNumber}: "${c.quote}"`);

  return {
    question: cleanQ,
    supported: true,
    status: "answered",
    answer: `Based strictly on the report text — ${answerParts.join(" · ")}. This is an unreviewed summary and not a diagnosis.`,
    reason: `Grounded in ${citations.length} verbatim excerpt(s) from the report.`,
    citations,
    provenance: "llm_generated",
    clinicianReviewed: false,
  };
}

/**
 * Interpret a clinical report using the configured LLM service (or deterministic
 * source-anchored extractive interpreter when external LLM is disabled or not privacy-authorized).
 */
export async function interpretReportWithLlm(input: {
  reportText?: string;
  deidentifiedText?: string;
  structuredExtraction?: Extraction;
  reportId?: string | null;
  question?: string | null;
  clinicianReviewed?: boolean;
  configOverrides?: Partial<LlmConfig>;
}): Promise<ValidatedLlmReportInterpretation> {
  const config = resolveLlmConfig(input.configOverrides);
  const rawInputText = String(input.deidentifiedText ?? input.reportText ?? "").trim();

  if (config.mode === "disabled") {
    return {
      status: "disabled",
      mode: "disabled",
      provider: "disabled",
      externalDataTransmitted: false,
      provenance: "llm_generated",
      clinicianReviewed: false,
      reportId: input.reportId ?? null,
      generatedExplanationSummary: "LLM report interpretation is disabled by configuration.",
      summaryStatements: [],
      claims: [],
      answeredQuestion: null,
      uncertaintyFlags: ["LLM report interpretation is disabled by configuration."],
      disclaimer: MANDATORY_DISCLAIMER,
    };
  }

  // Privacy Gate: If an external provider is requested AND rawInputText contains unredacted PHI (or privacy approval is missing), block external transmission immediately!
  if (
    config.mode === "external_authorized" &&
    (!config.externalPrivacyApproved || looksIdentifying(rawInputText))
  ) {
    return {
      status: "blocked_by_privacy_gate",
      mode: "external_authorized",
      provider: config.provider ?? "external_blocked",
      externalDataTransmitted: false,
      provenance: "llm_generated",
      clinicianReviewed: false,
      reportId: input.reportId ?? null,
      generatedExplanationSummary:
        "Blocked by privacy gate: patient-identifiable data or unapproved external provider configuration detected. No data was transmitted.",
      summaryStatements: [],
      claims: [],
      answeredQuestion: null,
      uncertaintyFlags: [
        "External LLM transmission blocked by privacy gate (identifiable patterns detected or external privacy gate not approved).",
      ],
      disclaimer: MANDATORY_DISCLAIMER,
    };
  }

  if (rawInputText.length < 20) {
    return {
      status: "insufficient_evidence",
      mode: config.mode,
      provider: config.provider ?? "local_source_grounded",
      externalDataTransmitted: false,
      provenance: "llm_generated",
      clinicianReviewed: false,
      reportId: input.reportId ?? null,
      generatedExplanationSummary: "Source report text is insufficient (<20 characters).",
      summaryStatements: [],
      claims: [],
      answeredQuestion: null,
      uncertaintyFlags: ["Source report text is insufficient (<20 characters)."],
      disclaimer: MANDATORY_DISCLAIMER,
    };
  }

  const deid = deidentify(rawInputText);
  const safeText = deid.text;
  const extraction = input.structuredExtraction ?? extractReport(safeText);

  const summaryStatements: GroundedSummaryStatement[] = [];
  const uncertaintyFlags: string[] = [];

  for (const f of extraction.findings) {
    const pageNum = f.pageNumber ?? pageNumberAtOffset(safeText, f.sentence.start);
    const certainty: GroundedSummaryStatement["certainty"] = f.negated
      ? "negated"
      : f.uncertain
        ? "uncertain"
        : "stated";

    if (f.uncertain) {
      uncertaintyFlags.push(
        `Page ${pageNum}: Report statement expresses clinical uncertainty ("${f.sentence.text}").`,
      );
    }

    const prefix = f.negated
      ? `Page ${pageNum} states absence/negation of ${f.structure}`
      : f.uncertain
        ? `Page ${pageNum} notes uncertain/possible ${f.structure}`
        : `Page ${pageNum} describes ${f.structure}${f.figo ? ` (FIGO ${f.figo})` : ""}`;

    const citation: SourceCitation = {
      reportId: input.reportId ?? null,
      quote: f.sentence.text,
      verbatimQuote: f.sentence.text,
      pageNumber: pageNum,
      start: f.sentence.start,
      end: f.sentence.end,
      startOffset: f.sentence.start,
      endOffset: f.sentence.end,
    };

    summaryStatements.push({
      statement: `${prefix}: "${f.sentence.text}"`,
      category: "finding",
      sourceQuote: f.sentence.text,
      pageNumber: pageNum,
      start: f.sentence.start,
      end: f.sentence.end,
      certainty,
      uncertain: Boolean(f.uncertain),
      negated: f.negated,
      provenance: "llm_generated",
      clinicianReviewed: Boolean(input.clinicianReviewed),
      citation,
    });
  }

  for (const rec of extraction.recommendations) {
    const pageNum = rec.pageNumber ?? pageNumberAtOffset(safeText, rec.start);
    const citation: SourceCitation = {
      reportId: input.reportId ?? null,
      quote: rec.text,
      verbatimQuote: rec.text,
      pageNumber: pageNum,
      start: rec.start,
      end: rec.end,
      startOffset: rec.start,
      endOffset: rec.end,
    };
    summaryStatements.push({
      statement: `Page ${pageNum} records the report author's follow-up note: "${rec.text}"`,
      category: "recommendation",
      sourceQuote: rec.text,
      pageNumber: pageNum,
      start: rec.start,
      end: rec.end,
      certainty: "stated",
      uncertain: false,
      negated: false,
      provenance: "llm_generated",
      clinicianReviewed: Boolean(input.clinicianReviewed),
      citation,
    });
  }

  const answeredQuestion = input.question
    ? answerQuestionFromSourceReport(safeText, input.question, extraction)
    : null;

  const summaryText =
    summaryStatements.length > 0
      ? summaryStatements.map((s) => s.statement).join(" ")
      : "No structured clinical findings or recommendations were identified in the report text.";

  const candidate: ValidatedLlmReportInterpretation = {
    status:
      summaryStatements.length > 0 || (answeredQuestion && answeredQuestion.supported)
        ? "completed"
        : "insufficient_evidence",
    mode: "local_extractive",
    provider: config.provider ?? "local_source_grounded",
    externalDataTransmitted: false,
    provenance: "llm_generated",
    clinicianReviewed: Boolean(input.clinicianReviewed),
    reportId: input.reportId ?? null,
    generatedExplanationSummary: summaryText,
    summaryStatements,
    claims: summaryStatements,
    answeredQuestion,
    uncertaintyFlags,
    disclaimer: MANDATORY_DISCLAIMER,
  };

  const validated = validateLlmInterpretationOutput(safeText, candidate, input.reportId ?? undefined);
  return validated.sanitized;
}
