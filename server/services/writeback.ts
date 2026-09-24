import { db } from "../db";
import { TranslationUnitRow, WritebackSummary } from "../../shared/types";
import { getLocale } from "./locales";
import { webflowClient } from "./webflow-client";

const DOM_BATCH = 25;

const groupBy = <T>(rows: T[], key: (r: T) => string): Map<string, T[]> => {
  const m = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    const a = m.get(k);
    if (a) a.push(r);
    else m.set(k, [r]);
  }
  return m;
};

/**
 * Writes approved units back to Webflow. CMS units are grouped per item into one PATCH
 * (`?cmsLocaleId=`); page units are grouped per page into batched DOM updates. The client's
 * token-bucket limiter and 429 backoff throttle the whole run.
 */
export async function writeBackApproved(siteId: string, localeId: string): Promise<WritebackSummary> {
  const locale = getLocale(siteId, localeId);
  if (!locale || locale.is_primary) throw new Error("Unknown secondary locale");
  const summary: WritebackSummary = { written: 0, failed: 0, errors: [] };

  const units = db.all<TranslationUnitRow>(`SELECT * FROM translation_units WHERE site_id = ? AND locale_id = ? AND status = 'approved'`, [siteId, localeId]);

  const markWritten = (ids: string[]) => {
    db.transaction(() => {
      for (const id of ids) {
        db.run(`UPDATE translation_units SET status = 'written', translated_from_hash = source_hash, last_error = NULL, updated_at = datetime('now') WHERE id = ?`, [id]);
      }
    });
    summary.written += ids.length;
  };
  const markFailed = (ids: string[], err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    for (const id of ids) db.run(`UPDATE translation_units SET last_error = ?, updated_at = datetime('now') WHERE id = ?`, [msg.slice(0, 500), id]);
    summary.failed += ids.length;
    summary.errors.push(msg);
  };

  // CMS items
  const cms = units.filter((u) => u.kind === "cms");
  for (const group of groupBy(cms, (u) => `${u.resource_id}|${u.item_id}`).values()) {
    const fieldData: Record<string, unknown> = {};
    for (const u of group) fieldData[u.field_key] = u.translated_text ?? "";
    try {
      await webflowClient.updateItemLocalized(siteId, group[0].resource_id, group[0].item_id, locale.cms_locale_id, fieldData);
      markWritten(group.map((u) => u.id));
    } catch (err) {
      markFailed(group.map((u) => u.id), err);
    }
  }

  // Pages (DOM text nodes)
  const pages = units.filter((u) => u.kind === "page");
  for (const group of groupBy(pages, (u) => u.item_id).values()) {
    for (let i = 0; i < group.length; i += DOM_BATCH) {
      const batch = group.slice(i, i + DOM_BATCH);
      try {
        const res = await webflowClient.updatePageDom(siteId, batch[0].item_id, locale.locale_id, batch.map((u) => ({ nodeId: u.field_key, text: u.translated_text ?? "" })));
        if (res && Array.isArray(res.errors) && res.errors.length) throw new Error(`DOM update reported errors: ${JSON.stringify(res.errors).slice(0, 300)}`);
        markWritten(batch.map((u) => u.id));
      } catch (err) {
        markFailed(batch.map((u) => u.id), err);
      }
    }
  }
  return summary;
}
