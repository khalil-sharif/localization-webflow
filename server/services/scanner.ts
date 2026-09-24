import { db } from "../db";
import { ScanSummary } from "../../shared/types";
import { activeSecondaryLocales, discoverLocales } from "./locales";
import { syncUnit } from "./units";
import { webflowClient, WebflowItem } from "./webflow-client";

const TRANSLATABLE_FIELD_TYPES = new Set(["PlainText", "RichText"]);
const PAGE_SIZE = 100;

const asText = (v: unknown): string => (typeof v === "string" ? v : "");

/**
 * Scans CMS items and page DOM text nodes; creates missing units and marks units stale when the
 * primary-locale source hash changed since the translation was made.
 */
export async function scanSite(siteId: string): Promise<ScanSummary> {
  const summary: ScanSummary = { collections: 0, items: 0, pages: 0, unitsCreated: 0, unitsMarkedStale: 0, errors: [] };
  await discoverLocales(siteId);
  const locales = activeSecondaryLocales(siteId);
  if (!locales.length) return summary;

  const record = (r: "created" | "stale" | "unchanged") => {
    if (r === "created") summary.unitsCreated++;
    else if (r === "stale") summary.unitsMarkedStale++;
  };

  // ---- CMS -------------------------------------------------------------------------------
  const { collections } = await webflowClient.listCollections(siteId);
  for (const summ of collections) {
    try {
      const collection = await webflowClient.getCollection(siteId, summ.id);
      summary.collections++;
      const fields = collection.fields.filter((f) => TRANSLATABLE_FIELD_TYPES.has(f.type) && f.slug !== "slug");
      if (!fields.length) continue;

      for (let offset = 0; ; offset += PAGE_SIZE) {
        const primary = await webflowClient.listItems(siteId, collection.id, { limit: PAGE_SIZE, offset });
        const items = primary.items.filter((i) => !i.isArchived);
        summary.items += items.length;

        // Localized variants, so text already translated in Webflow is not reported as missing.
        const localized = new Map<string, Map<string, WebflowItem>>();
        for (const loc of locales) {
          const res = await webflowClient.listItems(siteId, collection.id, { limit: PAGE_SIZE, offset, cmsLocaleId: loc.cms_locale_id });
          localized.set(loc.locale_id, new Map(res.items.map((i) => [i.id, i])));
        }

        db.transaction(() => {
          for (const item of items) {
            for (const field of fields) {
              const source = asText(item.fieldData[field.slug]);
              if (!source.trim()) continue;
              for (const loc of locales) {
                record(
                  syncUnit({
                    siteId, kind: "cms", resourceId: collection.id, itemId: item.id, localeId: loc.locale_id, fieldKey: field.slug,
                    label: `${collection.displayName} / ${asText(item.fieldData["name"]) || item.id} / ${field.displayName}`,
                    source, existing: asText(localized.get(loc.locale_id)?.get(item.id)?.fieldData[field.slug]),
                  })
                );
              }
            }
          }
        });

        const total = primary.pagination?.total ?? 0;
        if (primary.items.length < PAGE_SIZE || offset + PAGE_SIZE >= total) break;
      }
    } catch (err) {
      summary.errors.push(`collection ${summ.displayName}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ---- Pages -------------------------------------------------------------------------------
  for (let offset = 0; ; offset += PAGE_SIZE) {
    let list;
    try {
      list = await webflowClient.listPages(siteId, offset, PAGE_SIZE);
    } catch (err) {
      summary.errors.push(`pages: ${err instanceof Error ? err.message : String(err)}`);
      break;
    }
    for (const page of list.pages.filter((p) => !p.archived)) {
      try {
        const primaryNodes = await allNodes(siteId, page.id);
        const textNodes = primaryNodes.filter((n) => n.type === "text" && n.text?.html?.trim());
        if (!textNodes.length) continue;
        summary.pages++;
        for (const loc of locales) {
          const localizedNodes = new Map((await allNodes(siteId, page.id, loc.locale_id)).map((n) => [n.id, n]));
          db.transaction(() => {
            for (const node of textNodes) {
              record(
                syncUnit({
                  siteId, kind: "page", resourceId: page.id, itemId: page.id, localeId: loc.locale_id, fieldKey: node.id,
                  label: `Page / ${page.title || page.slug}`, source: node.text!.html, existing: localizedNodes.get(node.id)?.text?.html,
                })
              );
            }
          });
        }
      } catch (err) {
        summary.errors.push(`page ${page.title || page.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const total = list.pagination?.total ?? 0;
    if (list.pages.length < PAGE_SIZE || offset + PAGE_SIZE >= total) break;
  }

  db.run(`UPDATE installations SET last_scan_at = datetime('now') WHERE site_id = ?`, [siteId]);
  return summary;
}

async function allNodes(siteId: string, pageId: string, localeId?: string) {
  const nodes = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const res = await webflowClient.getPageDom(siteId, pageId, { localeId, offset, limit: PAGE_SIZE });
    nodes.push(...res.nodes);
    const total = res.pagination?.total ?? 0;
    if (res.nodes.length < PAGE_SIZE || offset + PAGE_SIZE >= total) break;
  }
  return nodes;
}
