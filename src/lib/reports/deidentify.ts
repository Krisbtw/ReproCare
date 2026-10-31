/**
 * Rule-based de-identification of report text before it is stored or sent anywhere.
 *
 * What it removes (replaced by a bracketed tag, so the reader can see that something was removed):
 *   - labelled identifiers: "Name:", "Patient:", "MRN:", "UHID:", "Hospital no", "ID:", "Aadhaar", "ABHA", "Phone",
 *     "Mobile", "Email", "Address", "DOB" / "Date of birth", "Referred by" / "Referring physician"
 *   - e-mail addresses, Indian and international phone numbers, 12-digit Aadhaar-like numbers, 14-digit ABHA-like numbers
 *   - honorific + capitalised name sequences ("Dr. A. Sharma", "Mrs Priya Nair")
 *
 * What it deliberately keeps: examination and report dates (needed for the timeline), measurements, anatomy.
 *
 * Honest limit: this is pattern matching, not a validated de-identification tool. Unlabelled names in free text
 * can survive. The upload screen shows the redacted preview and requires the person to confirm it before saving.
 */

export type Redaction = { kind: string; original_length: number };

export type DeidResult = {
  text: string;
  redactions: Redaction[];
  method: string;
};

export const DEID_METHOD = "anatomybridge-deid-rules-1";

type Rule = { kind: string; re: RegExp; keepLabel?: boolean };

// Labelled lines: keep the label, replace the value up to end of line (or the next label separator).
const LABELS: Rule[] = [
  { kind: "NAME", re: /\b((?:patient(?:'s)?\s+)?name|patient)\s*[:\-]\s*([^\n|;]{1,80})/gi, keepLabel: true },
  { kind: "ID", re: /\b(MRN|UHID|IP\s*no\.?|OP\s*no\.?|hospital\s*(?:no|number|id)\.?|patient\s*id|reg(?:istration)?\s*no\.?|accession\s*(?:no|number)?\.?)\s*[:#\-]?\s*([A-Z0-9][A-Z0-9\-/]{2,30})/gi, keepLabel: true },
  { kind: "AADHAAR", re: /\b(aadhaa?r(?:\s*no\.?)?)\s*[:\-]?\s*([0-9][0-9 \-]{10,16}[0-9])/gi, keepLabel: true },
  { kind: "ABHA", re: /\b(ABHA(?:\s*(?:no|number|id|address))?\.?)\s*[:\-]?\s*([A-Za-z0-9.@\-]{6,40})/gi, keepLabel: true },
  { kind: "DOB", re: /\b(DOB|D\.O\.B\.?|date\s+of\s+birth|birth\s*date)\s*[:\-]?\s*([0-9]{1,4}[\/.\- ][0-9A-Za-z]{1,9}[\/.\- ][0-9]{2,4})/gi, keepLabel: true },
  { kind: "ADDRESS", re: /\b(address)\s*[:\-]\s*([^\n]{1,160})/gi, keepLabel: true },
  { kind: "PHONE", re: /\b(phone|mobile|mob\.?|tel\.?|contact(?:\s*no\.?)?)\s*[:\-]?\s*(\+?[0-9][0-9 ()\-]{6,18}[0-9])/gi, keepLabel: true },
  { kind: "CLINICIAN", re: /\b(referred\s+by|referring\s+(?:physician|doctor|clinician)|reported\s+by|signed\s+by|consultant)\s*[:\-]?\s*([^\n|;]{1,80})/gi, keepLabel: true },
];

const FREE: Rule[] = [
  { kind: "EMAIL", re: /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g },
  { kind: "ABHA", re: /\b\d{2}-\d{4}-\d{4}-\d{4}\b/g },
  { kind: "AADHAAR", re: /\b\d{4}[ \-]\d{4}[ \-]\d{4}\b/g },
  { kind: "PHONE", re: /(?:\+91[\s\-]?)?\b[6-9]\d{4}[\s\-]?\d{5}\b/g },
  { kind: "PHONE", re: /\+\d{1,3}[\s\-]?\(?\d{2,4}\)?[\s\-]?\d{3,4}[\s\-]?\d{3,4}\b/g },
  { kind: "NAME", re: /\b(?:Dr|Mr|Mrs|Ms|Miss|Smt|Shri|Prof)\.?\s+(?:[A-Z]\.\s*){0,3}[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2}/g },
];

export function deidentify(input: string): DeidResult {
  const redactions: Redaction[] = [];
  let text = input;
  for (const rule of LABELS) {
    text = text.replace(rule.re, (_m, label: string, value: string) => {
      const trimmed = value.trim();
      if (!trimmed || /^\[[A-Z]+ REMOVED\]$/.test(trimmed)) return `${label}: ${trimmed}`;
      redactions.push({ kind: rule.kind, original_length: trimmed.length });
      return `${label}: [${rule.kind} REMOVED]`;
    });
  }
  for (const rule of FREE) {
    text = text.replace(rule.re, (m: string) => {
      redactions.push({ kind: rule.kind, original_length: m.length });
      return `[${rule.kind} REMOVED]`;
    });
  }
  return { text, redactions, method: DEID_METHOD };
}

/** Second pass used as a safety check in tests and before any external call: true if an obvious identifier survived. */
export function looksIdentifying(text: string): boolean {
  return FREE.some((r) => new RegExp(r.re.source, r.re.flags.replace("g", "")).test(text));
}
