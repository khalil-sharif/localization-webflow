-- localization-webflow: local persistence schema (SQLite-shaped; portable to Postgres with minor type changes)
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS installations (
  site_id           TEXT PRIMARY KEY,
  access_token_enc  TEXT NOT NULL DEFAULT '',   -- AES-256-GCM encrypted (see services/crypto.ts)
  refresh_token_enc TEXT NOT NULL DEFAULT '',
  scopes            TEXT NOT NULL,
  admin_token       TEXT NOT NULL,              -- bearer secret for the App Panel
  installed_at      TEXT NOT NULL DEFAULT (datetime('now')),
  uninstalled_at    TEXT,
  last_scan_at      TEXT
);

CREATE TABLE IF NOT EXISTS locales (
  site_id           TEXT NOT NULL REFERENCES installations(site_id) ON DELETE CASCADE,
  locale_id         TEXT NOT NULL,              -- Webflow locale id (used by Pages endpoints)
  cms_locale_id     TEXT NOT NULL,              -- Webflow cmsLocaleId (used by CMS endpoints)
  tag               TEXT NOT NULL,              -- BCP-47, e.g. fr-FR
  display_name      TEXT NOT NULL,
  subdirectory      TEXT NOT NULL DEFAULT '',
  is_primary        INTEGER NOT NULL DEFAULT 0,
  enabled           INTEGER NOT NULL DEFAULT 1, -- as reported by Webflow
  translate_enabled INTEGER NOT NULL DEFAULT 1, -- local per-locale setting: include in queue / machine translation
  PRIMARY KEY (site_id, locale_id)
);

CREATE TABLE IF NOT EXISTS translation_units (
  id                   TEXT PRIMARY KEY,
  site_id              TEXT NOT NULL REFERENCES installations(site_id) ON DELETE CASCADE,
  kind                 TEXT NOT NULL CHECK (kind IN ('cms','page')),
  resource_id          TEXT NOT NULL,           -- collection id (cms) or page id (page)
  item_id              TEXT NOT NULL,           -- CMS item id (cms) or page id (page)
  locale_id            TEXT NOT NULL,           -- secondary locale (locales.locale_id)
  field_key            TEXT NOT NULL,           -- CMS field slug or DOM node id
  label                TEXT NOT NULL DEFAULT '',
  source_text          TEXT NOT NULL,
  source_hash          TEXT NOT NULL,           -- sha256 of current primary-locale text
  translated_text      TEXT,
  translated_from_hash TEXT,                    -- source hash the translation was made from
  status               TEXT NOT NULL DEFAULT 'missing'
                       CHECK (status IN ('missing','stale','pending','approved','written','rejected')),
  provider             TEXT,
  last_error           TEXT,
  updated_at           TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (site_id, kind, item_id, locale_id, field_key)
);
CREATE INDEX IF NOT EXISTS idx_units_queue ON translation_units (site_id, locale_id, status);
CREATE INDEX IF NOT EXISTS idx_units_item ON translation_units (site_id, item_id);

CREATE TABLE IF NOT EXISTS glossary (
  id              TEXT PRIMARY KEY,
  site_id         TEXT NOT NULL REFERENCES installations(site_id) ON DELETE CASCADE,
  term            TEXT NOT NULL,
  translation     TEXT NOT NULL DEFAULT '',
  locale_id       TEXT,                         -- NULL = applies to every locale
  do_not_translate INTEGER NOT NULL DEFAULT 0,  -- 1 = keep the term verbatim
  UNIQUE (site_id, term, locale_id)
);
