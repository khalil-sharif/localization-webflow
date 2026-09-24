// Types shared by the server and the Designer Extension panel.

export type UnitKind = "cms" | "page";
export type UnitStatus = "missing" | "stale" | "pending" | "approved" | "written" | "rejected";

export interface InstallationRow {
  site_id: string;
  access_token_enc: string;
  refresh_token_enc: string;
  scopes: string;
  admin_token: string;
  installed_at: string;
  uninstalled_at: string | null;
  last_scan_at: string | null;
}

export interface LocaleRow {
  site_id: string;
  locale_id: string;
  cms_locale_id: string;
  tag: string;
  display_name: string;
  subdirectory: string;
  is_primary: number;
  enabled: number;
  translate_enabled: number;
}

export interface TranslationUnitRow {
  id: string;
  site_id: string;
  kind: UnitKind;
  resource_id: string;
  item_id: string;
  locale_id: string;
  field_key: string;
  label: string;
  source_text: string;
  source_hash: string;
  translated_text: string | null;
  translated_from_hash: string | null;
  status: UnitStatus;
  provider: string | null;
  last_error: string | null;
  updated_at: string;
}

export interface GlossaryRow {
  id: string;
  site_id: string;
  term: string;
  translation: string;
  locale_id: string | null;
  do_not_translate: number;
}

export interface LocaleProgress {
  localeId: string;
  tag: string;
  displayName: string;
  translateEnabled: boolean;
  total: number;
  missing: number;
  stale: number;
  pending: number;
  approved: number;
  written: number;
  rejected: number;
  /** Percentage of units already written back and current (0-100). */
  percentComplete: number;
}

export interface ScanSummary {
  collections: number;
  items: number;
  pages: number;
  unitsCreated: number;
  unitsMarkedStale: number;
  errors: string[];
}

export interface WritebackSummary {
  written: number;
  failed: number;
  errors: string[];
}

export interface XliffImportSummary {
  imported: number;
  skippedEmpty: number;
  skippedUnknown: number;
  skippedSourceChanged: number;
}
