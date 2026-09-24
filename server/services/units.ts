import crypto from "crypto";
import { db } from "../db";
import { TranslationUnitRow, UnitStatus } from "../../shared/types";
import { sha256 } from "./crypto";
import { glossaryFor } from "./glossary";
import { getLocale } from "./locales";
import { createTranslator, translateWithGlossary } from "./translator";

export interface UnitInput {
  siteId: string;
  kind: "cms" | "page";
  resourceId: string;
  itemId: string;
  localeId: string;
  fieldKey: string;
  label: string;
  source: string;
  /** Text already present in the secondary locale on Webflow (if any). */
  existing?: string;
}

/** Inserts or refreshes one unit by comparing the stored source hash with the current source. */
export function syncUnit(u: UnitInput): "created" | "stale" | "unchanged" {
  const hash = sha256(u.source);
  const row = db.get<Pick<TranslationUnitRow, "id" | "source_hash" | "translated_text">>(
    `SELECT id, source_hash, translated_text FROM translation_units WHERE site_id = ? AND kind = ? AND item_id = ? AND locale_id = ? AND field_key = ?`,
    [u.siteId, u.kind, u.itemId, u.localeId, u.fieldKey]
  );
  if (!row) {
    const alreadyTranslated = !!u.existing && u.existing.trim() !== "" && u.existing !== u.source;
    db.run(
      `INSERT INTO translation_units (id, site_id, kind, resource_id, item_id, locale_id, field_key, label, source_text, source_hash, translated_text, translated_from_hash, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        crypto.randomUUID(), u.siteId, u.kind, u.resourceId, u.itemId, u.localeId, u.fieldKey, u.label, u.source, hash,
        alreadyTranslated ? u.existing : null, alreadyTranslated ? hash : null, alreadyTranslated ? "written" : "missing",
      ]
    );
    return "created";
  }
  if (row.source_hash === hash) return "unchanged";
  db.run(
    `UPDATE translation_units SET source_text = ?, source_hash = ?, label = ?, status = ?, last_error = NULL, updated_at = datetime('now') WHERE id = ?`,
    [u.source, hash, u.label, row.translated_text ? "stale" : "missing", row.id]
  );
  return "stale";
}

export function listUnits(siteId: string, opts: { localeId?: string; status?: string; limit?: number; offset?: number }): { units: TranslationUnitRow[]; total: number } {
  const where = [`site_id = ?`];
  const params: unknown[] = [siteId];
  if (opts.localeId) (where.push(`locale_id = ?`), params.push(opts.localeId));
  if (opts.status && opts.status !== "all") {
    const statuses = opts.status.split(",").filter(Boolean);
    where.push(`status IN (${statuses.map(() => "?").join(",")})`);
    params.push(...statuses);
  }
  const total = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM translation_units WHERE ${where.join(" AND ")}`, params)?.n ?? 0;
  const units = db.all<TranslationUnitRow>(
    `SELECT * FROM translation_units WHERE ${where.join(" AND ")} ORDER BY kind, resource_id, item_id, field_key LIMIT ? OFFSET ?`,
    [...params, Math.min(opts.limit ?? 50, 500), opts.offset ?? 0]
  );
  return { units, total };
}

/** Machine-translates missing/stale/rejected units. Results land as `pending` for human review. */
export async function machineTranslate(siteId: string, localeId: string, unitIds?: string[]): Promise<{ translated: number; failed: number; errors: string[] }> {
  const locale = getLocale(siteId, localeId);
  const primary = db.get<{ tag: string }>(`SELECT tag FROM locales WHERE site_id = ? AND is_primary = 1`, [siteId]);
  if (!locale || locale.is_primary) throw new Error("Unknown secondary locale");
  if (!primary) throw new Error("Primary locale unknown; refresh locales first");

  let units: TranslationUnitRow[];
  if (unitIds && unitIds.length) {
    units = db.all<TranslationUnitRow>(
      `SELECT * FROM translation_units WHERE site_id = ? AND locale_id = ? AND id IN (${unitIds.map(() => "?").join(",")})`,
      [siteId, localeId, ...unitIds]
    );
  } else {
    units = db.all<TranslationUnitRow>(
      `SELECT * FROM translation_units WHERE site_id = ? AND locale_id = ? AND status IN ('missing','stale','rejected')`,
      [siteId, localeId]
    );
  }

  const translator = createTranslator();
  const glossary = glossaryFor(siteId, localeId);
  const result = { translated: 0, failed: 0, errors: [] as string[] };

  // RichText / DOM nodes are HTML; group by format so each provider call is homogeneous.
  const isHtml = (u: TranslationUnitRow) => u.kind === "page" || /<\/?[a-z][\s\S]*>/i.test(u.source_text);
  for (const format of ["html", "text"] as const) {
    const group = units.filter((u) => (format === "html") === isHtml(u));
    for (let i = 0; i < group.length; i += 20) {
      const chunk = group.slice(i, i + 20);
      try {
        const out = await translateWithGlossary(translator, chunk.map((c) => c.source_text), { sourceTag: primary.tag, targetTag: locale.tag, format, glossary });
        db.transaction(() => {
          chunk.forEach((c, idx) => {
            db.run(
              `UPDATE translation_units SET translated_text = ?, translated_from_hash = ?, status = 'pending', provider = ?, last_error = NULL, updated_at = datetime('now') WHERE id = ?`,
              [out[idx], c.source_hash, translator.name, c.id]
            );
          });
        });
        result.translated += chunk.length;
      } catch (err) {
        result.failed += chunk.length;
        result.errors.push(err instanceof Error ? err.message : String(err));
      }
    }
  }
  return result;
}

/** Reviewer edit: replaces the text and keeps the unit pending (or re-opens a rejected one). */
export function editUnit(siteId: string, unitId: string, text: string): boolean {
  return (
    db.run(
      `UPDATE translation_units SET translated_text = ?, translated_from_hash = source_hash, status = 'pending', provider = COALESCE(provider, 'reviewer'), updated_at = datetime('now')
       WHERE id = ? AND site_id = ?`,
      [text, unitId, siteId]
    ).changes > 0
  );
}

export function setStatus(siteId: string, ids: string[], from: UnitStatus[], to: UnitStatus): number {
  if (!ids.length) return 0;
  return db.run(
    `UPDATE translation_units SET status = ?, updated_at = datetime('now') WHERE site_id = ? AND status IN (${from.map(() => "?").join(",")}) AND id IN (${ids.map(() => "?").join(",")})`,
    [to, siteId, ...from, ...ids]
  ).changes;
}

/** Only pending units that actually carry translated text can be approved. */
export function approveUnits(siteId: string, ids: string[]): number {
  if (!ids.length) return 0;
  return db.run(
    `UPDATE translation_units SET status = 'approved', updated_at = datetime('now')
     WHERE site_id = ? AND status = 'pending' AND translated_text IS NOT NULL AND translated_text != '' AND id IN (${ids.map(() => "?").join(",")})`,
    [siteId, ...ids]
  ).changes;
}
