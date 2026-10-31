/** Pull measurement and FIGO phrases out of a stored report. Offsets point at the original text. */

export type ReportSpan = {
  start: number;
  end: number;
  text: string;
  kind: "measurement" | "figo";
};

const PATTERN = /FIGO\s*[0-8]|\d+(?:\.\d+)?\s*cm/gi;

export function extractReportSpans(body: string): ReportSpan[] {
  const spans: ReportSpan[] = [];
  for (const match of body.matchAll(PATTERN)) {
    const text = match[0];
    const start = match.index ?? 0;
    spans.push({
      start,
      end: start + text.length,
      text,
      kind: /^FIGO/i.test(text) ? "figo" : "measurement",
    });
  }
  return spans;
}

export function highlightReport(body: string): { text: string; mark: boolean; kind?: ReportSpan["kind"] }[] {
  const spans = extractReportSpans(body);
  if (!spans.length) return [{ text: body, mark: false }];
  const parts: { text: string; mark: boolean; kind?: ReportSpan["kind"] }[] = [];
  let cursor = 0;
  for (const span of spans) {
    if (span.start < cursor) continue;
    if (span.start > cursor) parts.push({ text: body.slice(cursor, span.start), mark: false });
    parts.push({ text: body.slice(span.start, span.end), mark: true, kind: span.kind });
    cursor = span.end;
  }
  if (cursor < body.length) parts.push({ text: body.slice(cursor), mark: false });
  return parts;
}
