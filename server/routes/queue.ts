import { Router } from "express";
import { scanSite } from "../services/scanner";
import { approveUnits, editUnit, listUnits, machineTranslate, setStatus } from "../services/units";
import { localeProgress } from "../services/locales";
import { writeBackApproved } from "../services/writeback";

const router = Router();
const siteOf = (res: { locals: Record<string, any> }) => res.locals.site.site_id as string;
const idsOf = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** Scan CMS + pages for missing / stale content. */
router.post("/scan", async (_req, res, next) => {
  try {
    const summary = await scanSite(siteOf(res));
    res.json({ summary, progress: localeProgress(siteOf(res)) });
  } catch (err) {
    next(err);
  }
});

router.get("/queue", (req, res) => {
  const { units, total } = listUnits(siteOf(res), {
    localeId: req.query.localeId as string | undefined,
    status: (req.query.status as string | undefined) || "missing,stale,pending,rejected,approved",
    limit: Number(req.query.limit) || 50,
    offset: Number(req.query.offset) || 0,
  });
  res.json({ units, total });
});

/** Machine translate; results land as `pending`. */
router.post("/translate", async (req, res, next) => {
  try {
    const localeId = req.body?.localeId;
    if (typeof localeId !== "string") return void res.status(400).json({ error: "localeId required" });
    const result = await machineTranslate(siteOf(res), localeId, idsOf(req.body?.unitIds));
    res.json({ result, progress: localeProgress(siteOf(res)) });
  } catch (err) {
    next(err);
  }
});

/** Reviewer edit. */
router.patch("/units/:id", (req, res) => {
  const text = req.body?.translatedText;
  if (typeof text !== "string") return void res.status(400).json({ error: "translatedText required" });
  if (!editUnit(siteOf(res), req.params.id, text)) return void res.status(404).json({ error: "Unit not found" });
  res.json({ ok: true });
});

router.post("/units/approve", (req, res) => {
  res.json({ approved: approveUnits(siteOf(res), idsOf(req.body?.ids)), progress: localeProgress(siteOf(res)) });
});

router.post("/units/reject", (req, res) => {
  res.json({ rejected: setStatus(siteOf(res), idsOf(req.body?.ids), ["pending", "approved"], "rejected"), progress: localeProgress(siteOf(res)) });
});

/** Write approved translations back to Webflow. */
router.post("/writeback", async (req, res, next) => {
  try {
    const localeId = req.body?.localeId;
    if (typeof localeId !== "string") return void res.status(400).json({ error: "localeId required" });
    const summary = await writeBackApproved(siteOf(res), localeId);
    res.json({ summary, progress: localeProgress(siteOf(res)) });
  } catch (err) {
    next(err);
  }
});

export default router;
