import { GlossaryRow } from "../../shared/types";
import { protectTerms, restoreTerms } from "./glossary";

export interface TranslateRequest {
  texts: string[];
  sourceTag: string;
  targetTag: string;
  /** All texts are HTML fragments (RichText / DOM text nodes) or plain text. */
  format: "html" | "text";
}

export interface Translator {
  readonly name: string;
  translate(req: TranslateRequest): Promise<string[]>;
}

/** Applies `fn` to every non-blank text segment outside of HTML tags. */
function mapTextNodes(html: string, fn: (text: string) => string): string {
  return html.replace(/(^|>)([^<]+)(?=<|$)/g, (m, lead: string, text: string) => {
    if (!text.trim()) return m;
    const lead1 = text.match(/^\s*/)![0];
    const trail = text.match(/\s*$/)![0];
    return `${lead}${lead1}${fn(text.trim())}${trail}`;
  });
}

/** Deterministic offline provider: prefixes each text segment with the target tag. Great for demos and tests. */
export class MockTranslator implements Translator {
  readonly name = "mock";
  async translate(req: TranslateRequest): Promise<string[]> {
    return req.texts.map((t) => (req.format === "html" ? mapTextNodes(t, (s) => `[${req.targetTag}] ${s}`) : `[${req.targetTag}] ${t}`));
  }
}

/**
 * Generic HTTP provider. Contract:
 *   POST TRANSLATION_API_URL  { source, target, format, texts: string[] }
 *   -> 200 { translations: string[] }  (same length and order)
 * Sends `Authorization: Bearer TRANSLATION_API_KEY` when a key is configured.
 */
export class HttpTranslator implements Translator {
  readonly name = "http";
  constructor(private url: string, private apiKey: string, private batchSize = 20) {}

  async translate(req: TranslateRequest): Promise<string[]> {
    const out: string[] = [];
    for (let i = 0; i < req.texts.length; i += this.batchSize) {
      out.push(...(await this.callBatch(req, req.texts.slice(i, i + this.batchSize))));
    }
    return out;
  }

  private async callBatch(req: TranslateRequest, texts: string[], attempt = 0): Promise<string[]> {
    const res = await fetch(this.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}) },
      body: JSON.stringify({ source: req.sourceTag, target: req.targetTag, format: req.format, texts }),
      signal: AbortSignal.timeout(30000),
    });
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      const ra = Number(res.headers.get("Retry-After"));
      await new Promise((r) => setTimeout(r, (Number.isFinite(ra) && ra > 0 ? ra * 1000 : 1000) * Math.pow(2, attempt)));
      return this.callBatch(req, texts, attempt + 1);
    }
    if (!res.ok) throw new Error(`Translation provider error ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as { translations?: string[] };
    if (!Array.isArray(json.translations) || json.translations.length !== texts.length) {
      throw new Error("Translation provider returned an unexpected number of translations");
    }
    return json.translations;
  }
}

export function createTranslator(): Translator {
  const kind = (process.env.TRANSLATION_PROVIDER || "mock").toLowerCase();
  if (kind === "mock") return new MockTranslator();
  if (kind === "http") {
    const url = process.env.TRANSLATION_API_URL;
    if (!url) throw new Error("TRANSLATION_API_URL is required when TRANSLATION_PROVIDER=http");
    return new HttpTranslator(url, process.env.TRANSLATION_API_KEY || "");
  }
  throw new Error(`Unknown TRANSLATION_PROVIDER "${kind}"`);
}

/** Glossary-aware translation: protect terms -> provider -> restore terms. */
export async function translateWithGlossary(
  translator: Translator,
  texts: string[],
  opts: { sourceTag: string; targetTag: string; format: "html" | "text"; glossary: GlossaryRow[] }
): Promise<string[]> {
  const protectedTexts = texts.map((t) => protectTerms(t, opts.glossary));
  const translated = await translator.translate({ texts: protectedTexts.map((p) => p.text), sourceTag: opts.sourceTag, targetTag: opts.targetTag, format: opts.format });
  return translated.map((t, i) => restoreTerms(t, protectedTexts[i].restore));
}
