import { Router } from "express";
import { db } from "../db";
import { discoverLocales, getLocale, listLocales, localeProgress } from "../services/locales";

const router = Router();

/** Locales with per-locale progress. */
router.get("/locales", (_req, res) => {
  const siteId = res.locals.site.site_id as string;
  res.json({ locales: listLocales(siteId), progress: localeProgress(siteId) });
});

/** Re-discover locales from GET /v2/sites/{siteId}. */
router.post("/locales/refresh", async (_req, res, next) => {
  try {
    const siteId = res.locals.site.site_id as string;
    await discoverLocales(siteId);
    res.json({ locales: listLocales(siteId), progress: localeProgress(siteId) });
  } catch (err) {
    next(err);
  }
});

/** Per-locale settings (local): include the locale in scans / machine translation. */
router.patch("/locales/:localeId", (req, res) => {
  const siteId = res.locals.site.site_id as string;
  const locale = getLocale(siteId, req.params.localeId);
  if (!locale) return void res.status(404).json({ error: "Locale not found" });
  const enabled = req.body?.translateEnabled;
  if (typeof enabled !== "boolean") return void res.status(400).json({ error: "translateEnabled (boolean) required" });
  db.run(`UPDATE locales SET translate_enabled = ? WHERE site_id = ? AND locale_id = ?`, [enabled ? 1 : 0, siteId, locale.locale_id]);
  res.json({ ok: true });
});

export default router;
