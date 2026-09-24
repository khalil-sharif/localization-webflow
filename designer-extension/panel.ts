// App Panel: vanilla TypeScript, bundled to panel.js by esbuild.config.mjs.
import type { GlossaryRow, LocaleProgress, LocaleRow, ScanSummary, TranslationUnitRow, WritebackSummary, XliffImportSummary } from "../shared/types";

interface Creds { site: string; token: string }

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const PAGE = 20;
let creds: Creds | null = null;
let progress: LocaleProgress[] = [];
let locales: LocaleRow[] = [];
let offset = 0;
let total = 0;

function toast(msg: string): void {
  const t = $("toast");
  t.textContent = msg;
  t.hidden = false;
  setTimeout(() => (t.hidden = true), 3500);
}

function loadCreds(): Creds | null {
  const hash = new URLSearchParams(location.hash.replace(/^#/, ""));
  if (hash.get("site") && hash.get("token")) {
    const c = { site: hash.get("site")!, token: hash.get("token")! };
    try { localStorage.setItem("loc-creds", JSON.stringify(c)); } catch { /* storage unavailable */ }
    history.replaceState(null, "", location.pathname);
    return c;
  }
  try { return JSON.parse(localStorage.getItem("loc-creds") || "null"); } catch { return null; }
}

async function api<T>(path: string, init: RequestInit & { raw?: boolean } = {}): Promise<T> {
  const headers: Record<string, string> = { Authorization: `Bearer ${creds!.token}` };
  if (init.body && !(init.headers as Record<string, string> | undefined)?.["Content-Type"]) headers["Content-Type"] = "application/json";
  const res = await fetch(`/api${path}`, { ...init, headers: { ...headers, ...(init.headers as Record<string, string> | undefined) } });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error || res.statusText);
  }
  return (init.raw ? ((await res.text()) as unknown as T) : await res.json());
}

const el = (tag: string, cls?: string, text?: string): HTMLElement => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

async function guard(fn: () => Promise<void>): Promise<void> {
  try { await fn(); } catch (err) { toast(err instanceof Error ? err.message : String(err)); }
}

// ---- progress + locale pickers -------------------------------------------------------------

function renderProgress(): void {
  const box = $("progress");
  box.replaceChildren();
  if (!progress.length) {
    box.append(el("p", "muted", "No secondary locales found. Add locales in Webflow, then refresh under Locales."));
    return;
  }
  for (const p of progress) {
    const row = el("div", "prog");
    const meta = el("div", "meta");
    meta.append(el("strong", undefined, `${p.displayName} (${p.tag})`), el("span", "muted", `${p.percentComplete}% - ${p.written}/${p.total} written, ${p.pending} pending, ${p.approved} approved, ${p.missing} missing, ${p.stale} stale`));
    const bar = el("div", "bar");
    for (const k of ["written", "approved", "pending"] as const) {
      const seg = el("span", `seg-${k}`);
      seg.style.width = p.total ? `${(p[k] / p.total) * 100}%` : "0";
      bar.append(seg);
    }
    row.append(meta, bar);
    box.append(row);
  }
}

function fillLocaleSelect(sel: HTMLSelectElement, withAll = false): void {
  const prev = sel.value;
  sel.replaceChildren();
  if (withAll) sel.append(new Option("All locales", ""));
  for (const p of progress) sel.append(new Option(`${p.displayName} (${p.tag})`, p.localeId));
  if (prev) sel.value = prev;
}

async function refreshLocales(): Promise<void> {
  const data = await api<{ locales: LocaleRow[]; progress: LocaleProgress[] }>("/locales");
  applyLocales(data);
}
function applyLocales(data: { locales?: LocaleRow[]; progress: LocaleProgress[] }): void {
  if (data.locales) locales = data.locales;
  progress = data.progress;
  renderProgress();
  fillLocaleSelect($("q-locale") as HTMLSelectElement);
  fillLocaleSelect($("x-locale") as HTMLSelectElement);
  fillLocaleSelect($("g-locale") as HTMLSelectElement, true);
  renderSettings();
}

// ---- queue -------------------------------------------------------------------------------------

async function loadQueue(): Promise<void> {
  const localeId = ($("q-locale") as HTMLSelectElement).value;
  const list = $("q-list");
  list.replaceChildren();
  if (!localeId) return;
  const status = ($("q-status") as HTMLSelectElement).value;
  const data = await api<{ units: TranslationUnitRow[]; total: number }>(`/queue?localeId=${encodeURIComponent(localeId)}&status=${encodeURIComponent(status)}&limit=${PAGE}&offset=${offset}`);
  total = data.total;
  $("q-count").textContent = total ? `${offset + 1}-${Math.min(offset + PAGE, total)} of ${total}` : "Nothing to show";
  for (const u of data.units) list.append(renderUnit(u));
}

function renderUnit(u: TranslationUnitRow): HTMLElement {
  const card = el("div", "unit");
  const label = el("div", "label", u.label || u.field_key);
  label.append(el("span", `badge ${u.status}`, u.status));
  const src = el("div", "src", u.source_text);
  const ta = document.createElement("textarea");
  ta.value = u.translated_text || "";
  ta.placeholder = "Translation";
  const actions = el("div", "row");
  const save = el("button", "btn", "Save edit");
  const approve = el("button", "btn primary", "Approve");
  const reject = el("button", "btn", "Reject");
  save.addEventListener("click", () => guard(async () => { await api(`/units/${u.id}`, { method: "PATCH", body: JSON.stringify({ translatedText: ta.value }) }); toast("Saved as pending"); await afterChange(); }));
  approve.addEventListener("click", () => guard(async () => {
    if (ta.value !== (u.translated_text || "")) await api(`/units/${u.id}`, { method: "PATCH", body: JSON.stringify({ translatedText: ta.value }) });
    const r = await api<{ approved: number; progress: LocaleProgress[] }>("/units/approve", { method: "POST", body: JSON.stringify({ ids: [u.id] }) });
    toast(r.approved ? "Approved" : "Nothing to approve (add a translation first)");
    await afterChange();
  }));
  reject.addEventListener("click", () => guard(async () => { await api("/units/reject", { method: "POST", body: JSON.stringify({ ids: [u.id] }) }); await afterChange(); }));
  actions.append(save, approve, reject);
  card.append(label, src, ta, actions);
  if (u.last_error) card.append(el("div", "err", u.last_error));
  return card;
}

async function afterChange(): Promise<void> {
  await refreshLocales();
  await loadQueue();
}

async function pendingIds(localeId: string): Promise<string[]> {
  const ids: string[] = [];
  for (let o = 0; ; o += 500) {
    const d = await api<{ units: TranslationUnitRow[]; total: number }>(`/queue?localeId=${encodeURIComponent(localeId)}&status=pending&limit=500&offset=${o}`);
    ids.push(...d.units.filter((u) => u.translated_text).map((u) => u.id));
    if (o + 500 >= d.total) break;
  }
  return ids;
}

// ---- glossary + settings -------------------------------------------------------------------

async function loadGlossary(): Promise<void> {
  const { terms } = await api<{ terms: GlossaryRow[] }>("/glossary");
  const list = $("g-list");
  list.replaceChildren();
  for (const t of terms) {
    const row = el("div", "unit row space");
    const loc = t.locale_id ? progress.find((p) => p.localeId === t.locale_id)?.tag || t.locale_id : "all locales";
    row.append(el("span", undefined, t.do_not_translate ? `${t.term} (do not translate) - ${loc}` : `${t.term} -> ${t.translation} - ${loc}`));
    const del = el("button", "btn", "Remove");
    del.addEventListener("click", () => guard(async () => { await api(`/glossary/${t.id}`, { method: "DELETE" }); await loadGlossary(); }));
    row.append(del);
    list.append(row);
  }
  if (!terms.length) list.append(el("p", "muted", "No glossary terms yet."));
}

function renderSettings(): void {
  const list = $("s-list");
  list.replaceChildren();
  for (const l of locales) {
    const row = el("label", "check");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = !!l.translate_enabled;
    cb.disabled = !!l.is_primary || !l.enabled;
    cb.addEventListener("change", () => guard(async () => { await api(`/locales/${l.locale_id}`, { method: "PATCH", body: JSON.stringify({ translateEnabled: cb.checked }) }); await refreshLocales(); }));
    row.append(cb, document.createTextNode(`${l.display_name} (${l.tag})${l.is_primary ? " - primary" : ""}${l.enabled ? "" : " - disabled in Webflow"}`));
    list.append(row);
  }
  $("s-conn").textContent = creds ? `Connected to site ${creds.site}` : "";
}

// ---- wiring --------------------------------------------------------------------------------

function showTab(name: string): void {
  document.querySelectorAll<HTMLElement>(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  document.querySelectorAll<HTMLElement>(".pane").forEach((p) => (p.hidden = p.id !== `pane-${name}`));
  if (name === "glossary") void guard(loadGlossary);
}

function start(): void {
  $("connect-card").hidden = true;
  $("main").hidden = false;
  void guard(async () => { await refreshLocales(); await loadQueue(); });
}

function init(): void {
  creds = loadCreds();
  $("conn-save").addEventListener("click", () => {
    const site = ($("conn-site") as HTMLInputElement).value.trim();
    const token = ($("conn-token") as HTMLInputElement).value.trim();
    if (!site || !token) return toast("Site ID and token are required");
    creds = { site, token };
    try { localStorage.setItem("loc-creds", JSON.stringify(creds)); } catch { /* ignore */ }
    start();
  });
  $("s-disconnect").addEventListener("click", () => {
    try { localStorage.removeItem("loc-creds"); } catch { /* ignore */ }
    location.reload();
  });
  document.querySelectorAll<HTMLElement>(".tab").forEach((t) => t.addEventListener("click", () => showTab(t.dataset.tab!)));

  $("q-locale").addEventListener("change", () => { offset = 0; void guard(loadQueue); });
  $("q-status").addEventListener("change", () => { offset = 0; void guard(loadQueue); });
  $("q-prev").addEventListener("click", () => { offset = Math.max(0, offset - PAGE); void guard(loadQueue); });
  $("q-next").addEventListener("click", () => { if (offset + PAGE < total) { offset += PAGE; void guard(loadQueue); } });

  $("q-scan").addEventListener("click", () => guard(async () => {
    toast("Scanning... this can take a while on large sites");
    const r = await api<{ summary: ScanSummary; progress: LocaleProgress[] }>("/scan", { method: "POST" });
    toast(`Scanned ${r.summary.items} items, ${r.summary.pages} pages: ${r.summary.unitsCreated} new, ${r.summary.unitsMarkedStale} stale${r.summary.errors.length ? `, ${r.summary.errors.length} errors` : ""}`);
    await afterChange();
  }));
  $("q-translate").addEventListener("click", () => guard(async () => {
    const localeId = ($("q-locale") as HTMLSelectElement).value;
    const r = await api<{ result: { translated: number; failed: number; errors: string[] } }>("/translate", { method: "POST", body: JSON.stringify({ localeId }) });
    toast(`Translated ${r.result.translated}, failed ${r.result.failed}${r.result.errors[0] ? `: ${r.result.errors[0]}` : ""}`);
    await afterChange();
  }));
  $("q-approve-all").addEventListener("click", () => guard(async () => {
    const localeId = ($("q-locale") as HTMLSelectElement).value;
    const ids = await pendingIds(localeId);
    const r = await api<{ approved: number }>("/units/approve", { method: "POST", body: JSON.stringify({ ids }) });
    toast(`Approved ${r.approved}`);
    await afterChange();
  }));
  $("q-writeback").addEventListener("click", () => guard(async () => {
    const localeId = ($("q-locale") as HTMLSelectElement).value;
    toast("Writing back approved translations...");
    const r = await api<{ summary: WritebackSummary }>("/writeback", { method: "POST", body: JSON.stringify({ localeId }) });
    toast(`Written ${r.summary.written}, failed ${r.summary.failed}${r.summary.errors[0] ? `: ${r.summary.errors[0]}` : ""}`);
    await afterChange();
  }));

  $("x-export").addEventListener("click", () => guard(async () => {
    const localeId = ($("x-locale") as HTMLSelectElement).value;
    const xml = await api<string>(`/xliff/export?localeId=${encodeURIComponent(localeId)}`, { raw: true });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([xml], { type: "application/x-xliff+xml" }));
    a.download = `translations-${localeId}.xlf`;
    a.click();
    URL.revokeObjectURL(a.href);
  }));
  $("x-import").addEventListener("click", () => guard(async () => {
    const localeId = ($("x-locale") as HTMLSelectElement).value;
    const file = ($("x-file") as HTMLInputElement).files?.[0];
    if (!file) return toast("Choose an .xlf file first");
    const r = await api<{ summary: XliffImportSummary }>(`/xliff/import?localeId=${encodeURIComponent(localeId)}`, { method: "POST", body: await file.text(), headers: { "Content-Type": "application/xml" } });
    const s = r.summary;
    $("x-status").textContent = `Imported ${s.imported}; skipped: ${s.skippedEmpty} empty, ${s.skippedUnknown} unknown, ${s.skippedSourceChanged} with changed source.`;
    await afterChange();
  }));

  $("g-add").addEventListener("click", () => guard(async () => {
    const term = ($("g-term") as HTMLInputElement).value;
    const translation = ($("g-translation") as HTMLInputElement).value;
    const localeId = ($("g-locale") as HTMLSelectElement).value;
    const doNotTranslate = ($("g-dnt") as HTMLInputElement).checked;
    await api("/glossary", { method: "POST", body: JSON.stringify({ term, translation, localeId: localeId || undefined, doNotTranslate }) });
    ($("g-term") as HTMLInputElement).value = "";
    ($("g-translation") as HTMLInputElement).value = "";
    await loadGlossary();
  }));

  $("s-refresh").addEventListener("click", () => guard(async () => {
    applyLocales(await api("/locales/refresh", { method: "POST" }));
    toast("Locales refreshed");
  }));

  if (creds) start();
  else $("connect-card").hidden = false;
}

init();
