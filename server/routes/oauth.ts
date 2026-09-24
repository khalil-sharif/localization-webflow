import { Router } from "express";
import { db } from "../db";
import { randomToken } from "../services/crypto";
import { tokenStore } from "../services/tokens";
import { discoverLocales } from "../services/locales";
import { webflowClient } from "../services/webflow-client";

const router = Router();

const CLIENT_ID = () => process.env.WEBFLOW_CLIENT_ID || "";
const CLIENT_SECRET = () => process.env.WEBFLOW_CLIENT_SECRET || "";
const REDIRECT_URI = () => process.env.WEBFLOW_REDIRECT_URI || "http://localhost:3000/oauth/callback";
const SCOPES = () => process.env.WEBFLOW_SCOPES || "cms:read,cms:write,sites:read,pages:read,pages:write";
const APP_BASE_URL = () => process.env.APP_PUBLIC_URL || "http://localhost:3000";

// CSRF protection: single-use `state` values valid for 10 minutes.
const pendingStates = new Map<string, number>();
function issueState(): string {
  const now = Date.now();
  for (const [s, t] of pendingStates) if (now - t > 600000) pendingStates.delete(s);
  const state = randomToken(16);
  pendingStates.set(state, now);
  return state;
}

router.get("/authorize", (_req, res) => {
  const params = new URLSearchParams({ client_id: CLIENT_ID(), response_type: "code", redirect_uri: REDIRECT_URI(), scope: SCOPES().split(",").join(" "), state: issueState() });
  res.redirect(`https://webflow.com/oauth/authorize?${params.toString()}`);
});

router.get("/callback", async (req, res) => {
  const code = req.query.code as string | undefined;
  const state = req.query.state as string | undefined;
  if (!code) return void res.status(400).send("Missing authorization code");
  if (!state || !pendingStates.delete(state)) return void res.status(400).send("Invalid or expired state");

  try {
    const tokenRes = await fetch("https://api.webflow.com/oauth/access_token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: CLIENT_ID(), client_secret: CLIENT_SECRET(), code, grant_type: "authorization_code", redirect_uri: REDIRECT_URI() }),
    });
    if (!tokenRes.ok) return void res.status(502).send(`Token exchange failed: ${await tokenRes.text()}`);
    const tokenJson = (await tokenRes.json()) as { access_token: string; refresh_token?: string; scope?: string };

    const sitesRes = await fetch("https://api.webflow.com/v2/sites", { headers: { Authorization: `Bearer ${tokenJson.access_token}` } });
    if (!sitesRes.ok) return void res.status(502).send(`Could not list sites: ${await sitesRes.text()}`);
    const sites = ((await sitesRes.json()) as { sites?: Array<{ id: string }> }).sites || [];
    if (!sites.length) return void res.status(502).send("No site returned for this installation");

    for (const site of sites) {
      // A reinstall keeps the existing admin token so an open panel keeps working.
      db.run(
        `INSERT INTO installations (site_id, scopes, admin_token, installed_at, uninstalled_at) VALUES (?, ?, ?, datetime('now'), NULL)
         ON CONFLICT(site_id) DO UPDATE SET scopes = excluded.scopes, uninstalled_at = NULL,
           admin_token = CASE WHEN installations.admin_token = '' THEN excluded.admin_token ELSE installations.admin_token END`,
        [site.id, tokenJson.scope || SCOPES(), randomToken(32)]
      );
      await tokenStore.save(site.id, { accessToken: tokenJson.access_token, refreshToken: tokenJson.refresh_token });
      await discoverLocales(site.id);
      await registerWebhooks(site.id);
    }

    const first = sites[0].id;
    const inst = db.get<{ admin_token: string }>(`SELECT admin_token FROM installations WHERE site_id = ?`, [first])!;
    // Credentials travel in the URL fragment so they never reach server logs or Referer headers.
    res.redirect(`/designer-extension/index.html#site=${encodeURIComponent(first)}&token=${encodeURIComponent(inst.admin_token)}`);
  } catch (err) {
    res.status(500).send(`Install failed: ${err instanceof Error ? err.message : String(err)}`);
  }
});

/** Registers collection_item_changed and app-uninstall hooks, skipping ones that already exist. */
async function registerWebhooks(siteId: string): Promise<void> {
  const wanted: Array<[string, string]> = [
    ["collection_item_changed", `${APP_BASE_URL()}/webhooks/collection-item-changed`],
    ["app_uninstall", `${APP_BASE_URL()}/webhooks/app-uninstalled`],
  ];
  let existing: Array<{ triggerType: string; url: string }> = [];
  try {
    existing = (await webflowClient.listWebhooks(siteId)).webhooks || [];
  } catch {
    // Listing is best-effort; fall through and try to register.
  }
  for (const [trigger, url] of wanted) {
    if (existing.some((w) => w.triggerType === trigger && w.url === url)) continue;
    try {
      await webflowClient.registerWebhook(siteId, trigger, url);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`Webhook ${trigger} registration failed for ${siteId}:`, err instanceof Error ? err.message : err);
    }
  }
}

export default router;
