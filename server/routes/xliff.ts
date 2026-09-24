import { Router } from "express";
import { UnitStatus } from "../../shared/types";
import { exportXliff, importXliff } from "../services/xliff";
import { localeProgress } from "../services/locales";

const router = Router();
const VALID: UnitStatus[] = ["missing", "stale", "pending", "approved", "written", "rejected"];

router.get("/xliff/export", (req, res) => {
  const siteId = res.locals.site.site_id as string;
  const localeId = req.query.localeId as string | undefined;
  if (!localeId) return void res.status(400).json({ error: "localeId required" });
  const statuses = typeof req.query.status === "string" ? (req.query.status.split(",").filter((s): s is UnitStatus => (VALID as string[]).includes(s))) : undefined;
  try {
    const xml = exportXliff(siteId, localeId, statuses && statuses.length ? statuses : undefined);
    res.setHeader("Content-Type", "application/x-xliff+xml; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="translations-${localeId}.xlf"`);
    res.send(xml);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/** Body: raw XLIFF 1.2 XML (Content-Type application/xml). */
router.post("/xliff/import", (req, res) => {
  const siteId = res.locals.site.site_id as string;
  const localeId = req.query.localeId as string | undefined;
  if (!localeId) return void res.status(400).json({ error: "localeId query parameter required" });
  if (typeof req.body !== "string" || !req.body.trim()) return void res.status(400).json({ error: "XLIFF XML body required (Content-Type: application/xml)" });
  try {
    res.json({ summary: importXliff(siteId, localeId, req.body), progress: localeProgress(siteId) });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

export default router;
