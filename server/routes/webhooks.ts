import crypto from "crypto";
import { NextFunction, Request, Response, Router } from "express";
import { db } from "../db";
import { sha256 } from "../services/crypto";
import { tokenStore } from "../services/tokens";
import { TranslationUnitRow } from "../../shared/types";

const router = Router();

/**
 * Verifies Webflow's `x-webflow-signature` (HMAC-SHA256 of `${timestamp}:${rawBody}` keyed with the
 * app client secret) when the header is present. Requests older than 5 minutes are rejected.
 */
function verifySignature(req: Request, res: Response, next: NextFunction): void {
  const signature = req.headers["x-webflow-signature"] as string | undefined;
  const timestamp = req.headers["x-webflow-timestamp"] as string | undefined;
  const secret = process.env.WEBFLOW_CLIENT_SECRET || "";
  if (!signature || !timestamp) {
    // Unsigned deliveries are only tolerated when no client secret is configured (local dev).
    return secret ? void res.status(401).json({ error: "Missing signature" }) : next();
  }
  if (Math.abs(Date.now() - Number(timestamp)) > 5 * 60 * 1000) return void res.status(401).json({ error: "Stale timestamp" });
  const raw = (req as Request & { rawBody?: string }).rawBody || "";
  const expected = crypto.createHmac("sha256", secret).update(`${timestamp}:${raw}`).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return void res.status(401).json({ error: "Bad signature" });
  next();
}

const siteIdOf = (body: any): string | undefined => body?.payload?.siteId || body?.siteId;

/**
 * collection_item_changed: recompute source hashes for the changed item. Units whose source text
 * changed become `stale` (or `missing` if never translated). Events carrying a secondary cmsLocaleId
 * are our own write-backs (or localized edits) and are ignored.
 */
router.post("/collection-item-changed", verifySignature, (req, res) => {
  const payload = req.body?.payload || req.body || {};
  const siteId = siteIdOf(req.body) as string | undefined;
  const itemId = (payload.id || payload._id) as string | undefined;
  if (!siteId || !itemId) return void res.status(400).json({ error: "Missing siteId or item id" });

  const secondary = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM locales WHERE site_id = ? AND is_primary = 0 AND cms_locale_id = ?`, [siteId, payload.cmsLocaleId || ""]);
  if (payload.cmsLocaleId && secondary && secondary.n > 0) return void res.status(200).json({ ok: true, ignored: "secondary-locale change" });

  const units = db.all<TranslationUnitRow>(`SELECT * FROM translation_units WHERE site_id = ? AND kind = 'cms' AND item_id = ?`, [siteId, itemId]);
  const fieldData = (payload.fieldData || null) as Record<string, unknown> | null;
  let marked = 0;

  db.transaction(() => {
    for (const u of units) {
      let sourceText = u.source_text;
      let hash = u.source_hash;
      if (fieldData) {
        const v = fieldData[u.field_key];
        if (typeof v !== "string") continue; // field not part of this event
        sourceText = v;
        hash = sha256(v);
        if (hash === u.source_hash) continue;
      }
      // Without fieldData we cannot diff, so every translated unit of the item is conservatively marked stale.
      const status = u.translated_text ? "stale" : "missing";
      db.run(`UPDATE translation_units SET source_text = ?, source_hash = ?, status = ?, updated_at = datetime('now') WHERE id = ?`, [sourceText, hash, status, u.id]);
      marked++;
    }
  });
  res.status(200).json({ ok: true, marked });
});

/** On uninstall: purge stored tokens, per-site config, locales, glossary and translation data. */
router.post("/app-uninstalled", verifySignature, async (req, res) => {
  const siteId = siteIdOf(req.body);
  if (!siteId || typeof siteId !== "string") return void res.status(400).json({ error: "Missing siteId" });
  await tokenStore.purge(siteId);
  db.transaction(() => {
    db.run(`DELETE FROM translation_units WHERE site_id = ?`, [siteId]);
    db.run(`DELETE FROM glossary WHERE site_id = ?`, [siteId]);
    db.run(`DELETE FROM locales WHERE site_id = ?`, [siteId]);
    db.run(`UPDATE installations SET uninstalled_at = datetime('now'), admin_token = '' WHERE site_id = ?`, [siteId]);
  });
  res.status(200).json({ ok: true });
});

export default router;
