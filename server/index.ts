import "dotenv/config";
import express, { NextFunction, Request, Response } from "express";
import path from "path";
import { migrate, ROOT } from "./db";
import oauthRoutes from "./routes/oauth";
import webhookRoutes from "./routes/webhooks";
import localeRoutes from "./routes/locales";
import queueRoutes from "./routes/queue";
import xliffRoutes from "./routes/xliff";
import glossaryRoutes from "./routes/glossary";
import { requireAdmin } from "./services/auth";

migrate();

const app = express();
app.set("trust proxy", true);

// Keep the raw body so webhook signatures can be verified byte-for-byte.
app.use(
  express.json({
    limit: "1mb",
    verify: (req, _res, buf) => {
      (req as Request & { rawBody?: string }).rawBody = buf.toString("utf-8");
    },
  })
);
app.use(express.text({ type: ["application/xml", "text/xml", "application/x-xliff+xml"], limit: "10mb" }));

app.use("/oauth", oauthRoutes);
app.use("/webhooks", webhookRoutes);

// Everything under /api is for the App Panel and requires the per-site admin token.
app.use("/api", (req: Request, res: Response, next: NextFunction) => {
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Admin-Token");
  if (req.method === "OPTIONS") return void res.sendStatus(204);
  next();
});
app.use("/api", requireAdmin, localeRoutes, queueRoutes, xliffRoutes, glossaryRoutes);

app.use("/designer-extension", express.static(path.join(ROOT, "designer-extension")));
app.get("/health", (_req, res) => res.json({ ok: true }));

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  // eslint-disable-next-line no-console
  console.error(err);
  res.status(500).json({ error: err instanceof Error ? err.message : "Internal server error" });
});

const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`localization-webflow server listening on :${PORT}`);
});
