import { db } from "../db";
import { TranslationUnitRow, UnitStatus, XliffImportSummary } from "../../shared/types";
import { getLocale } from "./locales";

export interface XliffUnit {
  id: string;
  resname?: string;
  source: string;
  target?: string;
  state?: string;
}
export interface XliffDocument {
  original: string;
  sourceLanguage: string;
  targetLanguage: string;
  units: XliffUnit[];
}

const escapeXml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

const unescapeXml = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, "&");

/** Serializes a document as XLIFF 1.2. */
export function serializeXliff(doc: XliffDocument): string {
  const units = doc.units
    .map((u) => {
      const state = u.state ? ` state="${escapeXml(u.state)}"` : "";
      const target = u.target !== undefined ? `\n        <target xml:lang="${escapeXml(doc.targetLanguage)}"${state}>${escapeXml(u.target)}</target>` : "";
      return `      <trans-unit id="${escapeXml(u.id)}"${u.resname ? ` resname="${escapeXml(u.resname)}"` : ""}>\n        <source xml:lang="${escapeXml(doc.sourceLanguage)}">${escapeXml(u.source)}</source>${target}\n      </trans-unit>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<xliff version="1.2" xmlns="urn:oasis:names:tc:xliff:document:1.2">
  <file original="${escapeXml(doc.original)}" source-language="${escapeXml(doc.sourceLanguage)}" target-language="${escapeXml(doc.targetLanguage)}" datatype="html">
    <body>
${units}
    </body>
  </file>
</xliff>
`;
}

function attrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of raw.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) out[m[1]] = unescapeXml(m[2] ?? m[3] ?? "");
  return out;
}

function textOf(inner: string): string {
  const cdata = inner.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  return cdata ? cdata[1] : unescapeXml(inner);
}

/** Parses XLIFF 1.2 (first <file> only). Tolerates CDATA and single-quoted attributes. */
export function parseXliff(xml: string): XliffDocument {
  const file = xml.match(/<file\b([^>]*)>/);
  if (!file) throw new Error("Not an XLIFF 1.2 document: missing <file>");
  const fa = attrs(file[1]);
  const units: XliffUnit[] = [];
  for (const m of xml.matchAll(/<trans-unit\b([^>]*)>([\s\S]*?)<\/trans-unit>/g)) {
    const ua = attrs(m[1]);
    if (!ua.id) continue;
    const src = m[2].match(/<source\b[^>]*>([\s\S]*?)<\/source>/);
    const tgt = m[2].match(/<target\b([^>]*)>([\s\S]*?)<\/target>/);
    units.push({
      id: ua.id,
      resname: ua.resname,
      source: src ? textOf(src[1]) : "",
      target: tgt ? textOf(tgt[2]) : undefined,
      state: tgt ? attrs(tgt[1]).state : undefined,
    });
  }
  return { original: fa.original || "", sourceLanguage: fa["source-language"] || "", targetLanguage: fa["target-language"] || "", units };
}

/** Exports a locale's units (default: everything that still needs translation) as XLIFF 1.2. */
export function exportXliff(siteId: string, localeId: string, statuses: UnitStatus[] = ["missing", "stale", "rejected", "pending"]): string {
  const locale = getLocale(siteId, localeId);
  const primary = db.get<{ tag: string }>(`SELECT tag FROM locales WHERE site_id = ? AND is_primary = 1`, [siteId]);
  if (!locale || !primary) throw new Error("Unknown locale");
  const rows = db.all<TranslationUnitRow>(
    `SELECT * FROM translation_units WHERE site_id = ? AND locale_id = ? AND status IN (${statuses.map(() => "?").join(",")}) ORDER BY kind, resource_id, item_id, field_key`,
    [siteId, localeId, ...statuses]
  );
  return serializeXliff({
    original: siteId,
    sourceLanguage: primary.tag,
    targetLanguage: locale.tag,
    units: rows.map((r) => ({
      id: r.id,
      resname: r.label,
      source: r.source_text,
      target: r.translated_text ?? "",
      state: r.translated_text ? "translated" : "new",
    })),
  });
}

/** Imports translated targets. Imported text lands as `pending` so a reviewer can still approve/edit it. */
export function importXliff(siteId: string, localeId: string, xml: string): XliffImportSummary {
  const doc = parseXliff(xml);
  const summary: XliffImportSummary = { imported: 0, skippedEmpty: 0, skippedUnknown: 0, skippedSourceChanged: 0 };
  db.transaction(() => {
    for (const u of doc.units) {
      if (!u.target || !u.target.trim() || u.state === "new" || u.state === "needs-translation") {
        summary.skippedEmpty++;
        continue;
      }
      const row = db.get<Pick<TranslationUnitRow, "id" | "source_text" | "source_hash">>(
        `SELECT id, source_text, source_hash FROM translation_units WHERE id = ? AND site_id = ? AND locale_id = ?`,
        [u.id, siteId, localeId]
      );
      if (!row) {
        summary.skippedUnknown++;
        continue;
      }
      if (row.source_text !== u.source) {
        summary.skippedSourceChanged++;
        continue;
      }
      db.run(
        `UPDATE translation_units SET translated_text = ?, translated_from_hash = ?, status = 'pending', provider = 'xliff', last_error = NULL, updated_at = datetime('now') WHERE id = ?`,
        [u.target, row.source_hash, row.id]
      );
      summary.imported++;
    }
  });
  return summary;
}
