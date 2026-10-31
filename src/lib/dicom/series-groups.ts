/**
 * Groups a mixed pile of DICOM files by series, so a whole study folder can be dropped in and one series chosen.
 * Only header fields needed for the choice are read. Patient name and ID are never read. The parser is injected.
 */
import type { DataSetLike } from "./codec.ts";

export type SeriesGroup = {
  /** Series Instance UID, or "unknown" when a file has none. */
  uid: string;
  description: string | null;
  modality: string | null;
  rows: number;
  cols: number;
  files: { name: string; bytes: Uint8Array }[];
};

export type GroupResult = {
  groups: SeriesGroup[];
  unreadable: { name: string; reason: string }[];
};

function clean(raw: string | undefined): string | null {
  if (raw == null) return null;
  const t = raw.replace(/\0/g, "").trim();
  return t.length ? t : null;
}

export function groupBySeries(
  files: { name: string; bytes: Uint8Array }[],
  parse: (b: Uint8Array) => DataSetLike,
): GroupResult {
  const byUid = new Map<string, SeriesGroup>();
  const unreadable: GroupResult["unreadable"] = [];
  for (const f of files) {
    try {
      const ds = parse(f.bytes);
      const uid = clean(ds.string("x0020000e")) ?? "unknown";
      let g = byUid.get(uid);
      if (!g) {
        g = {
          uid,
          description: clean(ds.string("x0008103e")),
          modality: clean(ds.string("x00080060")),
          rows: ds.uint16("x00280010") ?? 0,
          cols: ds.uint16("x00280011") ?? 0,
          files: [],
        };
        byUid.set(uid, g);
      }
      g.files.push(f);
    } catch (e) {
      unreadable.push({ name: f.name, reason: e instanceof Error ? e.message : "Could not be read as DICOM." });
    }
  }
  // Largest series first: it is usually the one that was meant.
  const groups = [...byUid.values()].sort((a, b) => b.files.length - a.files.length);
  return { groups, unreadable };
}
