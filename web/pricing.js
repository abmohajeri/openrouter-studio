/* =====================================================================
   OpenRouter Studio — live pricing
   Prices come from OpenRouter's model list (refreshed every 5 minutes)
   and the per-model provider list. Every price is shown in the unit
   that model type is billed in: tokens, characters, seconds, images.
   ===================================================================== */
"use strict";

const M = 1e6;
const CATALOG_REFRESH_MS = 5 * 60 * 1000;

/** A unit price as text: $2, $0.15, $0.0000042 … */
function money(v) {
  if (v == null || Number.isNaN(v)) return "—";
  if (v < 0) return "varies";
  if (v === 0) return "Free";
  if (v >= 100) return "$" + v.toFixed(0);
  if (v >= 1) return "$" + +v.toFixed(2);
  if (v >= 0.01) return "$" + +v.toFixed(3);
  return "$" + +v.toPrecision(2);
}

const nz = (v) => typeof v === "number" && v !== 0;

/** OpenRouter lists `image`/`image_output` per image, but token-billed models put a per-token rate there. */
const perImageOrToken = (v) => (v < 0.0001 ? { value: v * M, unit: "/ 1M image tokens" } : { value: v, unit: "/ image" });

function speechBilling(p) {
  if (nz(p.completion) && !nz(p.prompt)) return "per-second";   // e.g. music/sound models
  if (nz(p.completion) && nz(p.prompt)) return "tokens";         // e.g. Gemini TTS
  return "per-char";                                             // most TTS models
}

/** Video price SKUs look like duration_seconds_with_audio_720p or cents_per_video_output_second_480p. */
function skuInfo(key, value) {
  let k = key.toLowerCase();
  let price = value;
  if (k.startsWith("cents_per_")) { price = value / 100; k = k.slice(10); }
  let unit = "/ second";
  if (/video_tokens/.test(k)) { unit = "/ 1M tokens"; price *= M; }
  else if (/image_input/.test(k)) unit = "/ input image";
  else if (!/second/.test(k)) unit = "";
  const tags = [];
  const res = k.match(/(\d{3,4}p|[124]k)\b/);
  if (res) tags.push(res[1].toUpperCase().replace("P", "p"));
  if (/without_audio/.test(k)) tags.push("no audio");
  else if (/with_audio/.test(k)) tags.push("with audio");
  if (/text_to_video/.test(k)) tags.push("text→video");
  if (/image_to_video/.test(k)) tags.push("image→video");
  if (/with_video_input/.test(k)) tags.push("video input");
  return { key, label: tags.join(" · ") || "standard", price, unit, perSecond: unit === "/ second", res: res?.[1], tags };
}

const BILLABLE = { output_image: "Output image", input_image: "Input image", input_text: "Input text", input_reference: "Reference image" };

/** Rows of [label, price, unit] for the price card. */
function priceRows(m, kind) {
  const p = m.pricing || {};
  const rows = [];
  const add = (label, value, unit, cls = "") => rows.push({ label, value, unit, cls });
  if (p.prompt < 0) return [{ label: "Price", value: -1, unit: "depends on the routed model" }];

  if (kind === "chat" || kind === "decisions" || kind === "embeddings" || kind === "extract") {
    add("Input", (p.prompt || 0) * M, "/ 1M tokens");
    if (kind === "chat") add("Output", (p.completion || 0) * M, "/ 1M tokens");
    if (kind === "decisions") add("Output", 0, "decisions are free", "free");
    if (kind === "extract") add("Output", nz(p.completion) ? p.completion * M : 0, nz(p.completion) ? "/ 1M tokens" : "fields are free", nz(p.completion) ? "" : "free");
    if (nz(p.internal_reasoning) && p.internal_reasoning !== p.completion) add("Thinking", p.internal_reasoning * M, "/ 1M tokens");
    if (nz(p.input_cache_read)) add("Cached input", p.input_cache_read * M, "/ 1M tokens");
    if (nz(p.input_cache_write)) add("Cache write", p.input_cache_write * M, "/ 1M tokens");
    if (nz(p.input_cache_write_1h)) add("Cache write (1h)", p.input_cache_write_1h * M, "/ 1M tokens");
    if (nz(p.image)) { const x = perImageOrToken(p.image); add("Image input", x.value, x.unit); }
    if (nz(p.image_token)) add("Image input", p.image_token * M, "/ 1M image tokens");
    if (nz(p.audio)) add("Audio input", p.audio * M, "/ 1M audio tokens");
    if (nz(p.audio_output)) add("Audio output", p.audio_output * M, "/ 1M audio tokens");
    if (nz(p.web_search)) add("Web search", p.web_search, "/ search");
    if (nz(p.request)) add("Per request", p.request, "/ request");
    for (const o of p.overrides || []) {
      if (o.min_prompt_tokens && (nz(o.prompt) || nz(o.completion))) {
        add(`Over ${fmtTokens(o.min_prompt_tokens)} input`, (o.prompt ?? p.prompt) * M,
          `in · ${money((o.completion ?? p.completion) * M)} out / 1M`);
      }
    }
  } else if (kind === "speech") {
    const how = speechBilling(p);
    if (how === "per-char") add("Text", (p.prompt || 0) * M, "/ 1M characters");
    else if (how === "tokens") { add("Text input", p.prompt * M, "/ 1M tokens"); add("Audio output", p.completion * M, "/ 1M tokens"); }
    else add("Audio", p.completion, "/ second generated");
  } else if (kind === "transcription") {
    if (nz(p.completion)) { add("Audio input", (p.prompt || 0) * M, "/ 1M tokens"); add("Text output", p.completion * M, "/ 1M tokens"); }
    else { add("Audio", (p.prompt || 0) * 60, "/ minute"); add("", (p.prompt || 0) * 3600, "/ hour", "sub"); }
  } else if (kind === "image") {
    const prov = state.providers.key === providersKey() && state.providers.rows?.[0];
    if (prov?.pricing?.length) {
      for (const r of prov.pricing) {
        const unit = r.unit === "token" ? "/ 1M tokens" : r.unit === "megapixel" ? "/ megapixel" : "/ image";
        add((BILLABLE[r.billable] || r.billable) + (r.variant ? ` (${r.variant})` : ""), r.unit === "token" ? r.cost_usd * M : r.cost_usd, unit);
      }
    } else {
      if (nz(p.image_output)) { const x = perImageOrToken(p.image_output); add("Output image", x.value, x.unit); }
      if (nz(p.image_token)) add("Image tokens", p.image_token * M, "/ 1M tokens");
      if (nz(p.prompt)) add("Input text", p.prompt * M, "/ 1M tokens");
      if (!rows.length) add("Price", null, "loading per-image price…");
    }
  } else if (kind === "video") {
    const skus = Object.entries(m.video?.skus || {}).map(([k, v]) => skuInfo(k, v));
    for (const s of skus) add(s.label, s.price, s.unit);
    if (!skus.length) add("Price", null, "not listed. Shown after the run");
  }
  if (p.discount) add("Discount", null, `−${Math.round(p.discount * 100)}% applied`, "free");
  return rows;
}

/** One-line price for the model picker. */
function priceSummary(m, kind) {
  const p = m.pricing || {};
  if (isFree(m) && kind !== "video" && kind !== "image") return "Free";
  if (p.prompt < 0) return "Price varies";
  switch (kind) {
    case "chat": return `${money((p.prompt || 0) * M)} in · ${money((p.completion || 0) * M)} out / 1M`;
    case "decisions": return `${money((p.prompt || 0) * M)} / 1M input · output free`;
    case "extract": return `${money((p.prompt || 0) * M)} / 1M input`;
    case "embeddings": return `${money((p.prompt || 0) * M)} / 1M tokens`;
    case "speech": {
      const how = speechBilling(p);
      return how === "per-char" ? `${money((p.prompt || 0) * M)} / 1M chars`
        : how === "tokens" ? `${money(p.prompt * M)} in · ${money(p.completion * M)} out / 1M` : `${money(p.completion)} / second`;
    }
    case "transcription": return nz(p.completion) ? `${money(p.prompt * M)} / 1M tokens` : `${money((p.prompt || 0) * 60)} / minute`;
    case "image": {
      if (nz(p.image_output)) { const x = perImageOrToken(p.image_output); return `${money(x.value)} ${x.unit}`; }
      return nz(p.image_token) ? `${money(p.image_token * M)} / 1M image tokens` : "see price card";
    }
    case "video": {
      const s = Object.entries(m.video?.skus || {}).map(([k, v]) => skuInfo(k, v)).filter((x) => x.perSecond).sort((a, b) => a.price - b.price)[0];
      return s ? `from ${money(s.price)} / second` : "priced per video";
    }
    default: return "";
  }
}

/* ---------------------------------------------------------------------
   Estimates: what the next run will roughly cost, from live prices
   --------------------------------------------------------------------- */

function promptPrice(p, tokens) {
  let price = p.prompt || 0;
  for (const o of p.overrides || []) if (o.min_prompt_tokens && tokens > o.min_prompt_tokens && o.prompt != null) price = o.prompt;
  return price;
}

const MEGAPIXELS = { "512": 0.26, "768": 0.6, "1K": 1, "1.5K": 2.25, "2K": 4, "4K": 16 };

/** Returns { total, text } or null when there's nothing sensible to estimate. */
function estimateFor(kind, m, chat, draft) {
  const p = m.pricing || {};
  if (p.prompt < 0) return { total: null, text: "Price depends on the model the router picks." };
  const text = draft.text || "";
  const atts = draft.attachments || [];
  const o = chat.opts || {};
  switch (kind) {
    case "chat": {
      const tokens = estimateTokens(chat);
      const inCost = tokens * promptPrice(p, tokens);
      return { total: inCost, text: `≈ ${fmtCost(inCost)} to send ~${fmtInt(tokens)} tokens · replies cost ${money((p.completion || 0) * 1000)} per 1K tokens` };
    }
    case "decisions": {
      const qText = JSON.stringify(questionsToApi(chat.questions || [])).length;
      const tokens = Math.round((text.length + qText) / 4) + atts.filter((a) => a.kind === "image").length * 1000;
      const cost = tokens * (p.prompt || 0);
      return { total: cost, text: `≈ ${fmtCost(cost)} per run (~${fmtInt(tokens)} input tokens; answers are free)` };
    }
    case "extract": {
      const tokens = Math.round((text.length + JSON.stringify(extractFieldsToApi(chat.outputs || [])).length) / 4)
        + atts.filter((a) => a.kind === "image" || a.kind === "pdf").length * 1000;
      const cost = tokens * (p.prompt || 0);
      return { total: cost, text: `≈ ${fmtCost(cost)} per run (~${fmtInt(tokens)} input tokens)` };
    }
    case "embeddings": {
      const lines = text.split("\n").filter((s) => s.trim()).length;
      if (!lines) return { total: null, text: `${money((p.prompt || 0) * M)} per 1M tokens. Add texts to see the estimate.` };
      const tokens = Math.round(text.length / 4);
      const cost = tokens * (p.prompt || 0);
      return { total: cost, text: `≈ ${fmtCost(cost)} for ${lines} text${lines === 1 ? "" : "s"} (~${fmtInt(tokens)} tokens)` };
    }
    case "speech": {
      const how = speechBilling(p);
      if (!text && how !== "per-second") return { total: null, text: "Type the text to see the estimate." };
      if (how === "per-char") {
        const cost = text.length * (p.prompt || 0);
        return { total: cost, text: `≈ ${fmtCost(cost)} for ${fmtInt(text.length)} characters` };
      }
      if (how === "tokens") {
        const cost = (text.length / 4) * p.prompt;
        return { total: cost, text: `≈ ${fmtCost(cost)} for the text + ${money(p.completion * M)} per 1M audio tokens` };
      }
      return { total: null, text: `${money(p.completion)} per second of generated audio` };
    }
    case "transcription": {
      const secs = atts.filter((a) => a.kind === "audio").reduce((s, a) => s + (a.duration || 0), 0);
      if (!secs) return { total: null, text: "Attach or record audio to see the estimate." };
      if (nz(p.completion)) return { total: null, text: `${fmtDuration(secs)} of audio, billed by tokens` };
      const cost = secs * (p.prompt || 0);
      return { total: cost, text: `≈ ${fmtCost(cost)} for ${fmtDuration(secs)} of audio` };
    }
    case "image": {
      const n = Number(o.n) || 1;
      const prov = state.providers.key === providersKey() && state.providers.rows?.[0];
      const out = prov?.pricing?.find((r) => r.billable === "output_image" && (!r.variant || !o.resolution || r.variant.toLowerCase() === String(o.resolution).toLowerCase()))
        || prov?.pricing?.find((r) => r.billable === "output_image");
      if (out?.unit === "image") return { total: out.cost_usd * n, text: `≈ ${fmtCost(out.cost_usd * n)} for ${n} image${n > 1 ? "s" : ""}` };
      if (out?.unit === "megapixel") {
        const mp = MEGAPIXELS[o.resolution] || 1;
        return { total: out.cost_usd * mp * n, text: `≈ ${fmtCost(out.cost_usd * mp * n)} for ${n} × ~${mp} MP` };
      }
      if (out?.unit === "token") return { total: null, text: `Billed by tokens: ${money(out.cost_usd * M)} per 1M image tokens` };
      if (nz(p.image_output) && p.image_output >= 0.0001) return { total: p.image_output * n, text: `≈ ${fmtCost(p.image_output * n)} for ${n} image${n > 1 ? "s" : ""}` };
      return { total: null, text: "The exact price is shown after the image is made." };
    }
    case "video": {
      const v = m.video || {};
      const dur = Number(o.duration) || (v.durations?.includes(5) ? 5 : v.durations?.[0]) || 5;
      const sku = bestVideoSku(m, o, atts.some((a) => a.kind === "image"));
      if (!sku) return { total: null, text: "The exact price is shown when the video is done." };
      return { total: sku.price * dur, text: `≈ ${fmtCost(sku.price * dur)} for ${dur}s (${money(sku.price)}/s${sku.label !== "standard" ? ", " + sku.label : ""})` };
    }
    default: return null;
  }
}

/** Pick the per-second price that matches the chosen resolution, audio and input type. */
function bestVideoSku(m, o, hasImage) {
  const skus = Object.entries(m.video?.skus || {}).map(([k, v]) => skuInfo(k, v)).filter((s) => s.perSecond);
  if (!skus.length) return null;
  const res = String(o.resolution || "").toLowerCase();
  const audio = o.generate_audio !== false && m.video?.generate_audio;
  const score = (s) => {
    let n = 0;
    if (s.res) n += res && s.res === res ? 3 : -2;
    if (s.tags.includes("with audio")) n += audio ? 1 : -3;
    if (s.tags.includes("no audio")) n += audio ? -3 : 1;
    if (s.tags.includes("image→video")) n += hasImage ? 1 : -3;
    if (s.tags.includes("text→video")) n += hasImage ? -3 : 1;
    if (s.tags.includes("video input")) n -= 3;
    return n;
  };
  return skus.sort((a, b) => score(b) - score(a) || a.price - b.price)[0];
}

/** Running cost of a streaming chat reply: estimated input + what has been generated so far. */
function liveChatCost(msg) {
  const m = modelInfo(msg.model);
  const p = m.pricing || {};
  if (p.prompt < 0) return 0;
  const inTok = msg.meta.promptEstimate || 0;
  const outTok = (msg.content || "").length / 4;
  const thinkTok = (msg.reasoning || "").length / 4;
  return inTok * promptPrice(p, inTok) + outTok * (p.completion || 0) + thinkTok * (p.internal_reasoning || p.completion || 0);
}

function liveFootHTML(m) {
  if ((m.kind || "chat") === "chat") {
    const out = Math.round(((m.content || "").length + (m.reasoning || "").length) / 4);
    return `<span class="live-cost" title="Estimated live from OpenRouter prices; the exact cost appears when the reply ends">
      <span class="live-dot"></span>≈ ${fmtCost(liveChatCost(m))} so far · ~${fmtInt(out)} tokens out</span>`;
  }
  return m.meta?.estimate != null
    ? `<span class="live-cost"><span class="live-dot"></span>≈ ${fmtCost(m.meta.estimate)} estimated</span>` : "";
}

/* ---------------------------------------------------------------------
   Price card, estimate box, providers
   --------------------------------------------------------------------- */

function renderPriceCard() {
  if (!state.chat) return;
  const kind = kindOf(state.chat);
  const m = modelInfo(state.chat.model);
  const rows = priceRows(m, kind);
  $("#priceRows").innerHTML = rows.map((r) => `
    <div class="price-row ${r.cls}">
      <span>${esc(r.label)}</span>
      <span><b>${r.value == null ? "" : money(r.value)}</b> <span class="muted">${esc(r.unit)}</span></span>
    </div>`).join("") || '<div class="muted">No price listed.</div>';
  renderUpdatedLabel();
  renderProviders();
}

function renderUpdatedLabel() {
  if (!state.catalogUpdated) { $("#priceUpdated").textContent = "loading…"; return; }
  const s = Math.max(0, Math.round(Date.now() / 1000 - state.catalogUpdated));
  $("#priceUpdated").textContent = s < 60 ? "updated just now" : `updated ${Math.round(s / 60)} min ago`;
}

function renderEstimate() {
  if (!state.chat) return;
  const kind = kindOf(state.chat);
  const m = modelInfo(state.chat.model);
  const draft = draftText(state.chat);
  const est = estimateFor(kind, m, state.chat, { text: draft, attachments: state.pending });
  $("#estimateBox").innerHTML = est ? `<span class="ms">calculate</span><span>${esc(est.text)}</span>` : "";
  const hint = $("#tokenHint");
  if (est?.total != null && (draft || state.pending.length || kind === "chat" && state.chat.messages.length)) {
    hint.textContent = `≈ ${fmtCost(est.total)}`;
    hint.title = est.text;
  } else {
    hint.textContent = kind === "chat" || kind === "decisions" || kind === "speech" ? "Enter to run · Shift+Enter for a new line"
      : kind === "embeddings" ? "One text per line · Ctrl+Enter to run" : "";
    hint.title = "";
  }
}

const providersKey = () => `${state.chat?.model}|${kindOf(state.chat) === "image" ? "image" : "model"}`;

async function loadProviders() {
  if (!state.chat) return;
  const key = providersKey();
  if (state.providers.key === key && (state.providers.rows || state.providers.loading)) return;
  state.providers = { key, rows: null, loading: true };
  renderProviders();
  const image = kindOf(state.chat) === "image";
  try {
    const rows = await api(`/api/providers?model=${encodeURIComponent(state.chat.model)}&image=${image ? 1 : 0}`);
    if (state.providers.key === key) state.providers = { key, rows, loading: false };
  } catch (e) {
    if (state.providers.key === key) state.providers = { key, rows: [], loading: false, error: e.message };
  }
  if (state.providers.key === key) { renderPriceCard(); renderEstimate(); }
}

function renderProviders() {
  const box = $("#providersBox");
  const pv = state.providers;
  if (pv.key !== providersKey()) { box.hidden = true; return; }
  if (pv.loading) { box.hidden = false; $("#providersCount").textContent = "loading…"; $("#providerRows").innerHTML = ""; return; }
  const rows = pv.rows || [];
  box.hidden = !rows.length;
  $("#providersCount").textContent = `${rows.length} live`;
  const image = kindOf(state.chat) === "image";
  const sorted = image ? rows : [...rows].sort((a, b) => (a.pricing.prompt ?? 1e9) - (b.pricing.prompt ?? 1e9));
  $("#providerRows").innerHTML = sorted.map((r) => {
    let price;
    if (image) {
      price = (r.pricing || []).filter((x) => x.billable === "output_image")
        .map((x) => `${money(x.unit === "token" ? x.cost_usd * M : x.cost_usd)} ${x.unit === "token" ? "/ 1M tok" : "/ " + x.unit}${x.variant ? ` (${x.variant})` : ""}`).join(", ") || "—";
    } else {
      const p = r.pricing || {};
      price = nz(p.completion) ? `${money(p.prompt * M)} in · ${money(p.completion * M)} out` : `${money((p.prompt || 0) * M)} in`;
    }
    const up = r.uptime == null ? "" : `<span class="uptime ${r.uptime >= 99 ? "good" : r.uptime >= 90 ? "ok" : "bad"}" title="Uptime, last 30 minutes">${Math.round(r.uptime)}%</span>`;
    const tags = [r.tier && r.tier !== "standard" ? r.tier : "", r.quantization && r.quantization !== "unknown" ? r.quantization : "", r.pricing?.discount ? `−${Math.round(r.pricing.discount * 100)}%` : ""]
      .filter(Boolean).map((t) => `<span class="tag">${esc(t)}</span>`).join("");
    return `<div class="provider-row"><div><b>${esc(r.provider || "?")}</b>${tags}</div><div><span>${esc(price)}</span>${up}</div></div>`;
  }).join("");
}

/* ---------------------------------------------------------------------
   Live catalog refresh
   --------------------------------------------------------------------- */

async function loadCatalog(force = false) {
  try {
    const data = await api("/api/models" + (force ? "?refresh=1" : ""));
    const first = !state.models.length;
    const before = state.chat && state.byId.get(state.chat.model);
    state.models = data.models;
    state.byId = new Map(state.models.map((m) => [m.id, m]));
    state.catalogUpdated = data.updated;
    const after = state.chat && state.byId.get(state.chat.model);
    if (before && after && JSON.stringify(before.pricing) !== JSON.stringify(after.pricing)) {
      toast(`Live price update for ${shortName(after)}: ${priceSummary(after, kindOf(state.chat))}`);
    }
    if (first && state.chat) {
      if (!state.controller) renderMessages();
      renderHeader();
      renderWorkspace();
      renderSettings();
    } else {
      renderModelBits();
    }
    if (!$("#modelModal").hidden) { renderKindTabs(); renderModelList(); }
    updateStats();
    loadProviders();
  } catch (e) {
    toast("Could not load the model list: " + e.message);
  }
}

function startPriceTimers() {
  setInterval(() => loadCatalog(), CATALOG_REFRESH_MS);
  setInterval(renderUpdatedLabel, 15000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && Date.now() / 1000 - state.catalogUpdated > CATALOG_REFRESH_MS / 1000) loadCatalog();
  });
}

function bindPricingEvents() {
  $("#refreshPricesBtn").addEventListener("click", async (e) => {
    const icon = $(".ms", e.currentTarget);
    icon.classList.add("spin");
    state.providers.key = null;
    await loadCatalog(true);
    icon.classList.remove("spin");
    toast("Prices refreshed from OpenRouter");
  });
  $("#providersBox").addEventListener("toggle", () => { if ($("#providersBox").open) loadProviders(); });
}

/* ---------------------------------------------------------------------
   Usage & limits of your API key (live from OpenRouter)
   --------------------------------------------------------------------- */

/** Dollar amounts for usage: $25.50, $0.0042 … */
function usd(v) {
  v = Number(v || 0);
  if (v === 0) return "$0";
  if (Math.abs(v) < 0.01) return "$" + v.toFixed(4);
  return "$" + v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** When a daily / weekly / monthly limit starts over (OpenRouter counts in UTC, weeks start Monday). */
function nextReset(kind) {
  const now = new Date();
  const y = now.getUTCFullYear(), m = now.getUTCMonth(), d = now.getUTCDate();
  if (kind === "daily") return new Date(Date.UTC(y, m, d + 1));
  if (kind === "weekly") return new Date(Date.UTC(y, m, d + 7 - ((now.getUTCDay() + 6) % 7)));
  if (kind === "monthly") return new Date(Date.UTC(y, m + 1, 1));
  return null;
}

function fmtWhen(date) {
  if (!date) return "";
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(+d)) return "";
  const hours = (d - Date.now()) / 36e5;
  const rel = hours < 0 ? "" : hours < 1 ? "in under an hour" : hours < 48 ? `in ${Math.round(hours)} h` : `in ${Math.round(hours / 24)} days`;
  const abs = d.toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  return rel ? `${abs} (${rel})` : abs;
}

/** The short version for the sidebar button. */
function keySummary(k) {
  const sub = k.usage_daily != null ? `Today ${usd(k.usage_daily)} · Month ${usd(k.usage_monthly)}` : "";
  if (k.limit != null) {
    const left = k.limit_remaining ?? Math.max(0, k.limit - (k.usage || 0));
    const pct = k.limit > 0 ? Math.min(100, ((k.limit - left) / k.limit) * 100) : 100;
    return { main: `<b>${usd(left)}</b> left of ${usd(k.limit)}`, sub, pct, warn: pct >= 90 };
  }
  if (k.account?.total_credits != null) {
    const left = k.account.total_credits - k.account.total_usage;
    return { main: `<b>${usd(left)}</b> credits left`, sub, pct: null, warn: left < 1 };
  }
  return { main: `<b>${usd(k.usage)}</b> used · no limit`, sub, pct: null, warn: false };
}

function meterHTML(pct) {
  const cls = pct >= 90 ? "danger" : pct >= 70 ? "warnc" : "";
  return `<div class="meter big ${cls}"><div style="width:${Math.max(0, Math.min(100, pct)).toFixed(1)}%"></div></div>`;
}

function moneyBar(label, value, max) {
  return `<div class="pbar money"><span class="pbar-label" title="${esc(label)}">${esc(label)}</span>
    <div class="pbar-track"><i style="width:${max ? Math.max(2, (value / max) * 100) : 0}%"></i></div><span class="pbar-val">${usd(value)}</span></div>`;
}

const SCOPE_LABEL = { key: "This key", member: "Your member budget", workspace: "Workspace budget", organization: "Organization budget" };

function renderUsage(loading = false) {
  const body = $("#usageBody");
  const k = state.keyInfo;
  if (!k) {
    body.innerHTML = loading ? '<div class="ml-empty">Loading from OpenRouter…</div>'
      : '<div class="usage-section warn">Couldn\'t read your API key. Use “Change key” to check it.</div>';
    return;
  }
  const out = [];

  // the key itself
  const badges = [k.is_free_tier ? "Free tier" : "Paid", k.is_management_key ? "Management key" : "",
    k.expires_at ? `Expires ${new Date(k.expires_at).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}` : "Never expires"]
    .filter(Boolean).map((b) => `<span class="tag">${esc(b)}</span>`).join("");
  out.push(`<div class="key-line"><span class="ms">key</span><code>${esc(k.label || "API key")}</code>${badges}</div>`);

  // spending limit
  if (k.limit != null) {
    const left = k.limit_remaining ?? Math.max(0, k.limit - (k.usage || 0));
    const used = k.limit - left;
    const pct = k.limit > 0 ? (used / k.limit) * 100 : 100;
    const reset = k.limit_reset;
    out.push(`<section class="usage-section">
      <div class="us-head"><span class="ms">speed</span><b>Spending limit</b>
        <span class="muted">${reset ? `Resets ${esc(reset)}${nextReset(reset) ? ` · next ${esc(fmtWhen(nextReset(reset)))}` : ""}` : "Never resets"}</span></div>
      <div class="us-big"><b>${usd(used)}</b> used of ${usd(k.limit)}</div>
      ${meterHTML(pct)}
      <div class="us-row"><span><b>${usd(left)}</b> left</span><span>${Math.round(pct)}% used</span></div>
      ${pct >= 90 ? `<div class="us-note danger"><span class="ms">warning</span>Almost at the limit. Requests fail with “402” once it's used up${reset ? " until it resets" : ""}.</div>` : ""}
      ${k.include_byok_in_limit ? '<div class="muted small">Usage through your own provider keys (BYOK) counts toward this limit.</div>' : ""}
    </section>`);
  } else {
    out.push(`<section class="usage-section">
      <div class="us-head"><span class="ms">all_inclusive</span><b>No spending limit on this key</b></div>
      <div class="muted small">It can spend up to your account balance. You can add a daily, weekly or monthly limit on OpenRouter.</div>
    </section>`);
  }

  // usage over time
  const tiles = [["Today", k.usage_daily], ["This week", k.usage_weekly], ["This month", k.usage_monthly], ["All time", k.usage]]
    .filter(([, v]) => v != null);
  out.push(`<section class="usage-section">
    <div class="us-head"><span class="ms">payments</span><b>Spent with this key</b><span class="muted">UTC days · weeks start Monday</span></div>
    <div class="usage-tiles">${tiles.map(([l, v]) => `<div class="tile"><span>${l}</span><b>${usd(v)}</b></div>`).join("")}</div>
    ${k.byok_usage ? `<div class="muted small">Plus ${usd(k.byok_usage)} billed to your own provider keys (BYOK).</div>` : ""}
  </section>`);

  // budgets set by guardrails (member / workspace / organization)
  const budgets = k.budgets?.length ? k.budgets : k.effective_budget ? [k.effective_budget] : [];
  if (budgets.length) {
    const eff = k.effective_budget;
    out.push(`<section class="usage-section">
      <div class="us-head"><span class="ms">savings</span><b>Budgets</b><span class="muted">set by guardrails</span></div>
      ${budgets.map((b) => {
        const pct = b.limit_usd ? (b.spend_usd / b.limit_usd) * 100 : 0;
        const first = eff && b.scope === eff.scope && b.guardrail_id === eff.guardrail_id;
        return `<div class="budget">
          <div class="us-row"><span><b>${esc(SCOPE_LABEL[b.scope] || prettyKey(b.scope || "budget"))}</b>${first ? ' <span class="tag">applies first</span>' : ""}</span>
            <span>${usd(b.spend_usd)} of ${usd(b.limit_usd)}</span></div>
          ${meterHTML(pct)}
          <div class="muted small">${usd(b.remaining_usd)} left · ${b.reset_interval ? `resets ${esc(b.reset_interval)}${b.resets_at ? ` · next ${esc(fmtWhen(b.resets_at))}` : ""}` : "lifetime budget"}</div>
        </div>`;
      }).join("")}
    </section>`);
  }

  // free models
  const f = k.free_model_daily_requests;
  if (f && f.limit) {
    out.push(`<section class="usage-section">
      <div class="us-head"><span class="ms">redeem</span><b>Free-model requests today</b><span class="muted">resets ${esc(fmtWhen(nextReset("daily")))}</span></div>
      <div class="us-row"><span><b>${fmtInt(f.used)}</b> of ${fmtInt(f.limit)} used</span><span>${fmtInt(f.remaining)} left</span></div>
      ${meterHTML((f.used / f.limit) * 100)}
    </section>`);
  }

  // account balance
  if (k.account?.total_credits != null) {
    const left = k.account.total_credits - k.account.total_usage;
    out.push(`<section class="usage-section">
      <div class="us-head"><span class="ms">account_balance_wallet</span><b>Account balance</b>
        <a class="muted small" href="https://openrouter.ai/settings/credits" target="_blank" rel="noopener">Buy credits ↗</a></div>
      <div class="us-big"><b>${usd(left)}</b> left</div>
      <div class="muted small">${usd(k.account.total_credits)} bought · ${usd(k.account.total_usage)} used in total</div>
    </section>`);
  } else {
    out.push(`<div class="muted small us-foot"><span class="ms">info</span>Your account balance is only readable with a management key. You can see it at
      <a href="https://openrouter.ai/settings/credits" target="_blank" rel="noopener">openrouter.ai/settings/credits</a>.</div>`);
  }

  // what this app spent, from the exact costs saved in your chats
  const s = state.spend;
  if (s?.runs) {
    const max = s.by_model[0]?.cost || 0;
    out.push(`<section class="usage-section">
      <div class="us-head"><span class="ms">graphic_eq</span><b>Spent in this app</b><span class="muted">${fmtInt(s.runs)} run${s.runs === 1 ? "" : "s"} in saved chats</span></div>
      <div class="usage-tiles two"><div class="tile"><span>Today</span><b>${usd(s.today)}</b></div><div class="tile"><span>All saved chats</span><b>${usd(s.total)}</b></div></div>
      <div class="by-model">${s.by_model.map((r) => moneyBar(shortName(modelInfo(r.model)), r.cost, max)).join("")}</div>
      <div class="by-kind">${Object.entries(s.by_kind).sort((a, b) => b[1] - a[1]).map(([kind, v]) =>
        `<span class="tag"><span class="ms">${(KINDS[kind] || KINDS.chat).icon}</span>${(KINDS[kind] || KINDS.chat).label} ${usd(v)}</span>`).join("")}</div>
    </section>`);
  }
  body.innerHTML = out.join("");
}

async function loadSpend() {
  try { state.spend = await api("/api/spend"); } catch { state.spend = null; }
}

async function openUsage(e) {
  openModal("usageModal");
  const icon = e?.currentTarget?.id === "usageRefreshBtn" ? $(".ms", e.currentTarget) : null;
  icon?.classList.add("spin");
  renderUsage(true);
  await Promise.all([loadCredits(), loadSpend()]);
  renderUsage();
  icon?.classList.remove("spin");
}
