import crypto from "crypto";
import { Router } from "express";
import { db } from "../db";
import { GlossaryRow } from "../../shared/types";

const router = Router();

router.get("/glossary", (_req, res) => {
  res.json({ terms: db.all<GlossaryRow>(`SELECT * FROM glossary WHERE site_id = ? ORDER BY term`, [res.locals.site.site_id]) });
});

/** Body: { term, translation?, localeId?, doNotTranslate? } */
router.post("/glossary", (req, res) => {
  const siteId = res.locals.site.site_id as string;
  const term = typeof req.body?.term === "string" ? req.body.term.trim() : "";
  if (!term) return void res.status(400).json({ error: "term required" });
  const dnt = !!req.body?.doNotTranslate;
  const translation = typeof req.body?.translation === "string" ? req.body.translation : "";
  if (!dnt && !translation) return void res.status(400).json({ error: "translation required unless doNotTranslate is true" });
  const localeId = typeof req.body?.localeId === "string" && req.body.localeId ? req.body.localeId : null;
  // SQLite treats NULLs as distinct in UNIQUE, so replace any existing row for (term, locale) explicitly.
  db.transaction(() => {
    db.run(`DELETE FROM glossary WHERE site_id = ? AND term = ? AND COALESCE(locale_id, '') = ?`, [siteId, term, localeId ?? ""]);
    db.run(`INSERT INTO glossary (id, site_id, term, translation, locale_id, do_not_translate) VALUES (?, ?, ?, ?, ?, ?)`, [crypto.randomUUID(), siteId, term, dnt ? "" : translation, localeId, dnt ? 1 : 0]);
  });
  res.status(201).json({ ok: true });
});

router.delete("/glossary/:id", (req, res) => {
  const changes = db.run(`DELETE FROM glossary WHERE id = ? AND site_id = ?`, [req.params.id, res.locals.site.site_id]).changes;
  res.status(changes ? 200 : 404).json({ ok: changes > 0 });
});

export default router;
