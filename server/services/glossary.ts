import { db } from "../db";
import { GlossaryRow } from "../../shared/types";

export function glossaryFor(siteId: string, localeId: string): GlossaryRow[] {
  return db.all<GlossaryRow>(`SELECT * FROM glossary WHERE site_id = ? AND (locale_id IS NULL OR locale_id = ?)`, [siteId, localeId]);
}

export interface ProtectedText {
  text: string;
  /** placeholder token -> text to restore after translation */
  restore: Map<string, string>;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Before translation: replace do-not-translate terms and glossary terms with opaque tokens so the
 * provider cannot alter them. Longest terms are matched first.
 */
export function protectTerms(text: string, glossary: GlossaryRow[]): ProtectedText {
  const restore = new Map<string, string>();
  let out = text;
  const sorted = [...glossary].filter((g) => g.term.trim()).sort((a, b) => b.term.length - a.term.length);
  sorted.forEach((g, i) => {
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(g.term)}(?![\\p{L}\\p{N}])`, "giu");
    out = out.replace(re, (match) => {
      const token = `{{gl${i}_${restore.size}}}`;
      restore.set(token, g.do_not_translate ? match : g.translation || match);
      return token;
    });
  });
  return { text: out, restore };
}

/** After translation: put the verbatim terms / approved glossary translations back. */
export function restoreTerms(translated: string, restore: Map<string, string>): string {
  let out = translated;
  for (const [token, value] of restore) out = out.split(token).join(value);
  // Providers occasionally add spaces inside braces; tolerate that.
  out = out.replace(/\{\{\s*gl(\d+)_(\d+)\s*\}\}/g, (m, a, b) => restore.get(`{{gl${a}_${b}}}`) ?? m);
  return out;
}
