# localization-webflow

A Webflow App that manages translations for **Webflow Localization** (secondary locales) across pages and CMS items. It scans for missing or stale content, machine-translates it into a review queue, lets a reviewer approve or edit, then writes approved text back through the Data API. XLIFF 1.2 import/export supports external translators.

Stack: Node.js 20, TypeScript, Express, Webflow Data API v2 (hand-rolled `fetch` client, no SDK), SQLite via a swappable `DbAdapter`, and a vanilla-TypeScript Designer Extension bundled with esbuild.

## Layout

```
server/
  index.ts, db.ts            Express app; DbAdapter interface + SQLite implementation
  routes/                    oauth, webhooks, locales, queue (scan/translate/review/writeback), xliff, glossary
  services/
    webflow-client.ts        typed Data API v2 client, token bucket, 429 backoff, refresh-on-401
    tokens.ts, crypto.ts     encrypted token storage interface (AES-256-GCM)
    locales.ts               locale discovery + per-locale progress
    scanner.ts               CMS + page scan, source-hash comparison
    units.ts                 translation units, machine translation, review actions
    translator.ts            provider interface, deterministic mock, pluggable HTTP provider
    glossary.ts              do-not-translate / glossary protection before + after translation
    writeback.ts             batched write-back of approved units
    xliff.ts                 XLIFF 1.2 parse + serialize, export/import
designer-extension/          App Panel (panel.ts, index.html, panel.css, webflow.json, esbuild.config.mjs)
shared/types.ts              types shared by server and panel
db/schema.sql                installations, locales, translation_units, glossary
```

## OAuth scopes

| Scope | Used for |
| --- | --- |
| `sites:read` | `GET /v2/sites`, `GET /v2/sites/{siteId}` (locales), webhooks |
| `cms:read` | list collections, read collection schema and items (primary + localized) |
| `cms:write` | `PATCH` localized CMS items |
| `pages:read` | list pages, read page DOM (primary + localized) |
| `pages:write` | write localized page DOM text |

## Data API endpoints used

All requests use `Authorization: Bearer <token>` against `https://api.webflow.com/v2`.

```bash
# Locale discovery (response has locales.primary and locales.secondary[])
curl -H "Authorization: Bearer $TOKEN" https://api.webflow.com/v2/sites/$SITE_ID

# Collections and schema
curl -H "Authorization: Bearer $TOKEN" https://api.webflow.com/v2/sites/$SITE_ID/collections
curl -H "Authorization: Bearer $TOKEN" https://api.webflow.com/v2/collections/$COLLECTION_ID

# Items: primary locale, then a secondary locale variant
curl -H "Authorization: Bearer $TOKEN" "https://api.webflow.com/v2/collections/$COLLECTION_ID/items?limit=100&offset=0"
curl -H "Authorization: Bearer $TOKEN" "https://api.webflow.com/v2/collections/$COLLECTION_ID/items?limit=100&offset=0&cmsLocaleId=$CMS_LOCALE_ID"

# Write a localized CMS item
curl -X PATCH -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  "https://api.webflow.com/v2/collections/$COLLECTION_ID/items/$ITEM_ID?cmsLocaleId=$CMS_LOCALE_ID" \
  -d '{"fieldData":{"name":"Bonjour","post-body":"<p>Contenu</p>"}}'

# Pages: list, read DOM (primary / localized), write localized DOM text
curl -H "Authorization: Bearer $TOKEN" "https://api.webflow.com/v2/sites/$SITE_ID/pages?limit=100"
curl -H "Authorization: Bearer $TOKEN" "https://api.webflow.com/v2/pages/$PAGE_ID/dom"
curl -H "Authorization: Bearer $TOKEN" "https://api.webflow.com/v2/pages/$PAGE_ID/dom?localeId=$LOCALE_ID"
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  "https://api.webflow.com/v2/pages/$PAGE_ID/dom?localeId=$LOCALE_ID" \
  -d '{"nodes":[{"nodeId":"abc123","text":"<p>Bonjour</p>"}]}'

# Webhooks (registered on install)
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  https://api.webflow.com/v2/sites/$SITE_ID/webhooks \
  -d '{"triggerType":"collection_item_changed","url":"https://YOUR_HOST/webhooks/collection-item-changed"}'
```

## How it works

1. **Install**: `/oauth/authorize` -> Webflow consent -> `/oauth/callback` exchanges the code, stores tokens encrypted (`TokenStore`), discovers locales, registers webhooks, and redirects to the panel with the admin token in the URL fragment.
2. **Scan** (`POST /api/scan`): for each translatable field (PlainText, RichText) and each page text node, a `translation_unit` per secondary locale is created. Text already translated in Webflow is imported as `written`; otherwise the unit is `missing`. The unit stores `sha256(source)`; when a later scan sees a different hash the unit becomes `stale`.
3. **Translate** (`POST /api/translate`): missing/stale/rejected units go through `Translator`. Glossary and do-not-translate terms are swapped for tokens before the provider call and restored after. Output lands as `pending`.
4. **Review**: the panel edits (`PATCH /api/units/:id`), approves or rejects. Only `approved` units can be written.
5. **Write-back** (`POST /api/writeback`): CMS units are grouped into one `PATCH` per item; page units into DOM batches of 25 per page. Successful units become `written`.
6. **Stale detection**: `collection_item_changed` webhooks recompute hashes for the item's units and mark changed ones `stale`. Events for secondary locales (including our own write-backs) are ignored.
7. **XLIFF**: `GET /api/xliff/export?localeId=` and `POST /api/xliff/import?localeId=` (raw XML body). Imports land as `pending`; targets whose source text changed since export are skipped.
8. **Uninstall**: `app_uninstall` webhook purges tokens, locales, glossary and translation data.

## Translation providers

`TRANSLATION_PROVIDER=mock` (default) prefixes each text segment with the target tag, so results are deterministic and offline. `TRANSLATION_PROVIDER=http` posts `{ source, target, format, texts[] }` to `TRANSLATION_API_URL` (Bearer `TRANSLATION_API_KEY`) and expects `{ translations: string[] }` in the same order. Implement `Translator` in `services/translator.ts` to add another provider.

## Rate-limit strategy

- Per-site **token bucket**: capacity 60, refill 60 tokens/minute, matching Webflow's 60 requests/minute limit. Every call awaits a token.
- **429 handling**: waits for the `Retry-After` header value (default 1s), adds exponential backoff (`2^n - 1` seconds) on repeats, pauses all requests for that site while waiting, and gives up after 4 retries.
- **401 handling**: one refresh-token exchange, then the request is retried once. If no refresh token is stored the 401 is surfaced.
- Write-back groups fields per item and DOM nodes per page to minimize request count.

## Local development

```bash
cp .env.example .env         # fill in WEBFLOW_CLIENT_ID / WEBFLOW_CLIENT_SECRET and TOKEN_ENCRYPTION_KEY
npm install
npm run build:panel          # bundles designer-extension/panel.ts -> panel.js
npm run dev                  # http://localhost:3000
```

Webflow must reach your machine for OAuth redirects and webhooks. Expose port 3000 with a tunnel such as ngrok (`ngrok http 3000`; this repo does not start one), then set `APP_PUBLIC_URL` and `WEBFLOW_REDIRECT_URI` to the tunnel URL and register the same redirect URI in your Webflow app settings. Open `/oauth/authorize` to install.

| Variable | Purpose |
| --- | --- |
| `WEBFLOW_CLIENT_ID`, `WEBFLOW_CLIENT_SECRET` | app credentials (secret also verifies webhook signatures) |
| `WEBFLOW_REDIRECT_URI`, `WEBFLOW_SCOPES` | OAuth redirect and scope list |
| `APP_PUBLIC_URL` | base URL used when registering webhooks |
| `TOKEN_ENCRYPTION_KEY` | derives the AES-256-GCM key for stored tokens |
| `TRANSLATION_PROVIDER`, `TRANSLATION_API_URL`, `TRANSLATION_API_KEY` | translation provider |
| `DB_ADAPTER`, `DATABASE_PATH` | persistence (`sqlite` built in) |

## Database adapter

Services use the `DbAdapter` interface in `server/db.ts` (`exec`, `run`, `get`, `all`, `transaction`, positional `?` params). To use another database, implement it and return it from `createAdapter()`; the schema in `db/schema.sql` uses portable types.
