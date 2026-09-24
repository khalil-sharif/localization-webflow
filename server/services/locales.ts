import { db } from "../db";
import { LocaleProgress, LocaleRow } from "../../shared/types";
import { webflowClient } from "./webflow-client";

/** Discovers primary + secondary locales from GET /v2/sites/{siteId} and upserts them, keeping local settings. */
export async function discoverLocales(siteId: string): Promise<LocaleRow[]> {
  const site = await webflowClient.getSite(siteId);
  const all = site.locales ? [{ ...site.locales.primary, primary: true }, ...site.locales.secondary.map((l) => ({ ...l, primary: false }))] : [];
  db.transaction(() => {
    for (const l of all) {
      db.run(
        `INSERT INTO locales (site_id, locale_id, cms_locale_id, tag, display_name, subdirectory, is_primary, enabled)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(site_id, locale_id) DO UPDATE SET cms_locale_id = excluded.cms_locale_id, tag = excluded.tag,
           display_name = excluded.display_name, subdirectory = excluded.subdirectory, is_primary = excluded.is_primary, enabled = excluded.enabled`,
        [siteId, l.id, l.cmsLocaleId, l.tag, l.displayName, l.subdirectory || "", l.primary ? 1 : 0, l.enabled ? 1 : 0]
      );
    }
    const ids = all.map((l) => l.id);
    if (ids.length) {
      db.run(`DELETE FROM locales WHERE site_id = ? AND locale_id NOT IN (${ids.map(() => "?").join(",")})`, [siteId, ...ids]);
    }
  });
  return listLocales(siteId);
}

export function listLocales(siteId: string): LocaleRow[] {
  return db.all<LocaleRow>(`SELECT * FROM locales WHERE site_id = ? ORDER BY is_primary DESC, display_name`, [siteId]);
}

/** Secondary locales that are enabled in Webflow and switched on locally. */
export function activeSecondaryLocales(siteId: string): LocaleRow[] {
  return db.all<LocaleRow>(`SELECT * FROM locales WHERE site_id = ? AND is_primary = 0 AND enabled = 1 AND translate_enabled = 1`, [siteId]);
}

export function getLocale(siteId: string, localeId: string): LocaleRow | undefined {
  return db.get<LocaleRow>(`SELECT * FROM locales WHERE site_id = ? AND locale_id = ?`, [siteId, localeId]);
}

export function localeProgress(siteId: string): LocaleProgress[] {
  const counts = db.all<{ locale_id: string; status: string; n: number }>(
    `SELECT locale_id, status, COUNT(*) AS n FROM translation_units WHERE site_id = ? GROUP BY locale_id, status`,
    [siteId]
  );
  return listLocales(siteId)
    .filter((l) => !l.is_primary)
    .map((l) => {
      const by: Record<string, number> = {};
      for (const c of counts) if (c.locale_id === l.locale_id) by[c.status] = c.n;
      const total = Object.values(by).reduce((a, b) => a + b, 0);
      const written = by.written || 0;
      return {
        localeId: l.locale_id,
        tag: l.tag,
        displayName: l.display_name,
        translateEnabled: !!l.translate_enabled,
        total,
        missing: by.missing || 0,
        stale: by.stale || 0,
        pending: by.pending || 0,
        approved: by.approved || 0,
        written,
        rejected: by.rejected || 0,
        percentComplete: total === 0 ? 100 : Math.round((written / total) * 100),
      };
    });
}
