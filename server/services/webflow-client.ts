// Hand-rolled typed client for Webflow Data API v2 (no SDK dependency).

import { tokenStore } from "./tokens";

const API_BASE = "https://api.webflow.com/v2";
const MAX_RETRIES_429 = 4;

export class WebflowApiError extends Error {
  constructor(public status: number, public body: unknown) {
    super(`Webflow API error ${status}: ${JSON.stringify(body)}`);
  }
}

// ---- typed models -------------------------------------------------------------------------

export interface WebflowLocale {
  id: string;
  cmsLocaleId: string;
  enabled: boolean;
  displayName: string;
  redirect?: boolean;
  subdirectory?: string;
  tag: string;
}
export interface WebflowSite {
  id: string;
  displayName: string;
  shortName?: string;
  locales?: { primary: WebflowLocale; secondary: WebflowLocale[] };
}
export interface WebflowCollectionSummary {
  id: string;
  displayName: string;
  slug: string;
}
export interface WebflowField {
  id: string;
  slug: string;
  displayName: string;
  type: string;
}
export interface WebflowCollection extends WebflowCollectionSummary {
  fields: WebflowField[];
}
export interface WebflowItem {
  id: string;
  cmsLocaleId?: string;
  isArchived?: boolean;
  isDraft?: boolean;
  fieldData: Record<string, unknown>;
}
export interface WebflowPagination {
  limit: number;
  offset: number;
  total: number;
}
export interface WebflowPage {
  id: string;
  title: string;
  slug: string;
  archived?: boolean;
  draft?: boolean;
}
export interface WebflowDomNode {
  id: string;
  type: string;
  text?: { html: string; text: string };
}
export interface WebflowWebhook {
  id: string;
  triggerType: string;
  url: string;
}

// ---- token-bucket limiter (Webflow: 60 requests / minute per key) ---------------------------

class RateLimiter {
  private tokens: number;
  private lastRefill = Date.now();
  private pausedUntil = 0;

  constructor(private capacity = 60, private perMinute = 60) {
    this.tokens = capacity;
  }
  private refill(): void {
    const now = Date.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.lastRefill) / 60000) * this.perMinute);
    this.lastRefill = now;
  }
  /** Called on 429: drain the bucket and pause everyone until Retry-After elapses. */
  penalize(ms: number): void {
    this.tokens = 0;
    this.pausedUntil = Math.max(this.pausedUntil, Date.now() + ms);
  }
  async acquire(): Promise<void> {
    for (;;) {
      const pause = this.pausedUntil - Date.now();
      if (pause > 0) {
        await sleep(pause);
        continue;
      }
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      await sleep(Math.ceil(((1 - this.tokens) / this.perMinute) * 60000));
    }
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const limiters = new Map<string, RateLimiter>();
function limiterFor(siteId: string): RateLimiter {
  let l = limiters.get(siteId);
  if (!l) {
    l = new RateLimiter();
    limiters.set(siteId, l);
  }
  return l;
}

// ---- OAuth refresh ---------------------------------------------------------------------------

/** Exchanges the stored refresh token for a new access token. Returns false if no refresh is possible. */
async function refreshAccessToken(siteId: string): Promise<boolean> {
  const tokens = await tokenStore.get(siteId);
  if (!tokens?.refreshToken) return false;
  const res = await fetch("https://api.webflow.com/oauth/access_token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: process.env.WEBFLOW_CLIENT_ID || "",
      client_secret: process.env.WEBFLOW_CLIENT_SECRET || "",
      grant_type: "refresh_token",
      refresh_token: tokens.refreshToken,
    }),
  });
  if (!res.ok) return false;
  const json = (await res.json()) as { access_token?: string; refresh_token?: string };
  if (!json.access_token) return false;
  await tokenStore.save(siteId, { accessToken: json.access_token, refreshToken: json.refresh_token || tokens.refreshToken });
  return true;
}

// ---- request wrapper ---------------------------------------------------------------------------

async function request<T>(
  siteId: string,
  method: string,
  urlPath: string,
  opts: { body?: unknown; query?: Record<string, string | number | undefined> } = {},
  state = { retries429: 0, refreshed: false }
): Promise<T> {
  const tokens = await tokenStore.get(siteId);
  if (!tokens) throw new Error(`No active installation for site ${siteId}`);

  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(opts.query || {})) if (v !== undefined && v !== "") qs.set(k, String(v));
  const url = `${API_BASE}${urlPath}${qs.toString() ? `?${qs.toString()}` : ""}`;

  const limiter = limiterFor(siteId);
  await limiter.acquire();
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${tokens.accessToken}`, "Content-Type": "application/json", Accept: "application/json" },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });

  if (res.status === 401 && !state.refreshed) {
    state.refreshed = true;
    if (await refreshAccessToken(siteId)) return request<T>(siteId, method, urlPath, opts, state);
  }
  if (res.status === 429 && state.retries429 < MAX_RETRIES_429) {
    const retryAfterSec = Number(res.headers.get("Retry-After"));
    const base = Number.isFinite(retryAfterSec) && retryAfterSec > 0 ? retryAfterSec * 1000 : 1000;
    // Honor Retry-After, then add exponential backoff on repeated 429s.
    const waitMs = base + (Math.pow(2, state.retries429) - 1) * 1000;
    limiter.penalize(waitMs);
    state.retries429 += 1;
    return request<T>(siteId, method, urlPath, opts, state);
  }
  if (!res.ok) throw new WebflowApiError(res.status, await res.json().catch(() => ({})));
  if (res.status === 204) return undefined as unknown as T;
  return (await res.json()) as T;
}

export const webflowClient = {
  getSite(siteId: string): Promise<WebflowSite> {
    return request(siteId, "GET", `/sites/${siteId}`);
  },
  listCollections(siteId: string): Promise<{ collections: WebflowCollectionSummary[] }> {
    return request(siteId, "GET", `/sites/${siteId}/collections`);
  },
  getCollection(siteId: string, collectionId: string): Promise<WebflowCollection> {
    return request(siteId, "GET", `/collections/${collectionId}`);
  },
  /** Without cmsLocaleId returns primary-locale items; with it, that locale's variant of each item. */
  listItems(
    siteId: string,
    collectionId: string,
    opts: { limit?: number; offset?: number; cmsLocaleId?: string } = {}
  ): Promise<{ items: WebflowItem[]; pagination?: WebflowPagination }> {
    return request(siteId, "GET", `/collections/${collectionId}/items`, {
      query: { limit: opts.limit ?? 100, offset: opts.offset ?? 0, cmsLocaleId: opts.cmsLocaleId },
    });
  },
  updateItemLocalized(siteId: string, collectionId: string, itemId: string, cmsLocaleId: string, fieldData: Record<string, unknown>): Promise<WebflowItem> {
    return request(siteId, "PATCH", `/collections/${collectionId}/items/${itemId}`, { query: { cmsLocaleId }, body: { fieldData } });
  },
  listPages(siteId: string, offset = 0, limit = 100): Promise<{ pages: WebflowPage[]; pagination?: WebflowPagination }> {
    return request(siteId, "GET", `/sites/${siteId}/pages`, { query: { limit, offset } });
  },
  getPageDom(siteId: string, pageId: string, opts: { localeId?: string; offset?: number; limit?: number } = {}): Promise<{ nodes: WebflowDomNode[]; pagination?: WebflowPagination }> {
    return request(siteId, "GET", `/pages/${pageId}/dom`, { query: { localeId: opts.localeId, limit: opts.limit ?? 100, offset: opts.offset ?? 0 } });
  },
  updatePageDom(siteId: string, pageId: string, localeId: string, nodes: Array<{ nodeId: string; text: string }>): Promise<{ errors?: unknown[] }> {
    return request(siteId, "POST", `/pages/${pageId}/dom`, { query: { localeId }, body: { nodes } });
  },
  listWebhooks(siteId: string): Promise<{ webhooks: WebflowWebhook[] }> {
    return request(siteId, "GET", `/sites/${siteId}/webhooks`);
  },
  registerWebhook(siteId: string, triggerType: string, url: string): Promise<WebflowWebhook> {
    return request(siteId, "POST", `/sites/${siteId}/webhooks`, { body: { triggerType, url } });
  },
};
