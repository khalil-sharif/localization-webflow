import { NextFunction, Request, Response } from "express";
import { db } from "../db";
import { InstallationRow } from "../../shared/types";

export function getInstallation(siteId: string): InstallationRow | undefined {
  return db.get<InstallationRow>(`SELECT * FROM installations WHERE site_id = ? AND uninstalled_at IS NULL`, [siteId]);
}

/** `Authorization: Bearer <admin_token>` or `X-Admin-Token`. Sets res.locals.site. */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (req.method === "OPTIONS") return void next();
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : (req.headers["x-admin-token"] as string | undefined);
  if (!token) return void res.status(401).json({ error: "Missing admin token" });
  const site = db.get<InstallationRow>(`SELECT * FROM installations WHERE admin_token = ? AND uninstalled_at IS NULL`, [token]);
  if (!site) return void res.status(401).json({ error: "Invalid admin token" });
  res.locals.site = site;
  next();
}
