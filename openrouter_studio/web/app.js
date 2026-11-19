/* =====================================================================
   OpenRouter Studio — core (plain JavaScript, no build step)
   pricing.js: live prices & estimates · modes.js: image/video/speech/
   transcription/decisions/embeddings workspaces
   ===================================================================== */
"use strict";

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DEFAULT_PARAMS = { temperature: 1, top_p: 1, max_tokens: null, stop: [], reasoning: "", seed: null, voice: "", audioFormat: "" };
const NEW_TITLE = "New chat";

// What each input/output modality looks like in the UI.
const MODALITY = {
  text: { icon: "notes", label: "Text" },
  image: { icon: "image", label: "Image" },
  file: { icon: "picture_as_pdf", label: "PDF" },
  audio: { icon: "graphic_eq", label: "Audio" },
  video: { icon: "movie", label: "Video" },
  speech: { icon: "record_voice_over", label: "Speech" },
  transcription: { icon: "subtitles", label: "Transcript" },
  decisions: { icon: "rule", label: "Decisions" },
  embeddings: { icon: "scatter_plot", label: "Vectors" },
  rerank: { icon: "sort", label: "Ranking" },
};

const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); }
    catch { return fallback; }
  },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ } },
};

const state = {
  models: [],          // live model catalog from /api/models
  byId: new Map(),
  catalogUpdated: 0,   // when OpenRouter prices were fetched (epoch seconds)
  aliases: {},
  defaultModel: "",
  chats: [],
  chat: null,
  controller: null,    // AbortController of the running request
  streamingId: null,   // assistant message being produced
  pending: [],         // attachments waiting in the composer
  pickerKind: "all",
  modelFilters: new Set(),
  modelHl: 0,
  keyInfo: null,
  providers: { id: null, rows: null, loading: false },
  vectors: new Map(),  // embeddings kept in memory for copy/download
};

/* ---------------------------------------------------------------------
   Small helpers
   --------------------------------------------------------------------- */

async function api(path, { method = "GET", body, signal } = {}) {
  const init = { method, headers: {}, signal };
  if (method !== "GET") {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body ?? {});
  }
  const res = await fetch(path, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
}

let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 3200);
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); }
  catch {
    const ta = Object.assign(document.createElement("textarea"), { value: text });
    document.body.appendChild(ta); ta.select(); document.execCommand("copy"); ta.remove();
  }
}

const fmtInt = (n) => Number(n || 0).toLocaleString("en-US");
function fmtTokens(n) {
  if (!n) return "?";
  if (n >= 1e6) return +(n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return Math.round(n / 1e3) + "K";
  return String(n);
}
function fmtCost(c) {
  if (!c) return "$0";
  if (c < 0.0001) return "<$0.0001";
  return "$" + (c < 0.01 ? c.toFixed(4) : c < 1 ? c.toFixed(3) : c.toFixed(2));
}
const fmtMoney = (v) => "$" + Number(v || 0).toFixed(2);
function fmtSize(b) {
  if (b < 1024) return b + " B";
  if (b < 1048576) return Math.round(b / 1024) + " KB";
  return (b / 1048576).toFixed(1) + " MB";
}
function fmtDuration(s) {
  s = Math.max(0, Math.round(s || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function autosize(ta, max = window.innerHeight * 0.4) {
  ta.style.height = "auto";
  ta.style.height = Math.min(ta.scrollHeight, max) + "px";
}

/* ---------------------------------------------------------------------
   Models
   --------------------------------------------------------------------- */

function modelInfo(id) {
  return state.byId.get(id) || {
    id, name: id, input: ["text"], output: ["text"], modes: ["chat"], params: [],
    pricing: {}, context: null, created: 0, voices: null,
  };
}
const isFree = (m) => m.id.endsWith(":free") ||
  (Object.keys(m.pricing || {}).length > 0 && Object.entries(m.pricing).every(([k, v]) => k === "overrides" || !v) &&
   !Object.values(m.video?.skus || {}).some((v) => v > 0)); // video prices live in their own SKU list
const canThink = (m) => (m.params || []).includes("reasoning") || !!m.reasoning;
const shortName = (m) => (m.name || m.id).replace(/^[^:]{1,40}:\s*/, "");
const aliasOf = (id) => Object.keys(state.aliases).find((a) => state.aliases[a] === id);
const kindOf = (chat) => chat?.kind || "chat";

/** Input -> output icons for a model in a given mode. */
function ioFor(m, kind, structured = false) {
  if (kind === "chat" && structured) return { input: m.input, output: ["json"] };
  const out = kind === "chat" ? m.output.filter((o) => ["text", "audio", "image"].includes(o))
    : kind === "image" ? ["image"] : kind === "video" ? ["video"]
    : kind === "speech" ? ["audio"] : [kind];
  const input = kind === "speech" || kind === "embeddings" ? ["text"]
    : kind === "transcription" ? ["audio"] : m.input;
  return { input, output: out.length ? out : ["text"] };
}

function ioStripHTML(m, kind, labels = false, structured = false) {
  const { input, output } = ioFor(m, kind, structured);
  const chip = (x) => {
    const d = MODALITY[x] || { icon: "help", label: x };
    return `<span class="io-chip" title="${esc(d.label)}"><span class="ms">${d.icon}</span>${labels ? esc(d.label) : ""}</span>`;
  };
  return `<span class="io-group">${input.map(chip).join("")}</span><span class="ms io-arrow">arrow_forward</span>` +
    `<span class="io-group out">${output.map(chip).join("")}</span>`;
}

function modelTagsHTML(m) {
  const tags = [];
  if (isFree(m)) tags.push('<span class="tag free">Free</span>');
  if (canThink(m)) tags.push('<span class="tag think"><span class="ms">psychology</span>Thinking</span>');
  if (m.modes.length > 1) tags.push(`<span class="tag"><span class="ms">swap_horiz</span>${m.modes.map((k) => KINDS[k].label).join(" + ")}</span>`);
  return tags.join("");
}

/* ---------------------------------------------------------------------
   Chats: create / open / save / delete
   --------------------------------------------------------------------- */

function newChatObject(kind = "chat", model = null, from = null) {
  const last = store.get("lastSettings", null);
  const byKind = store.get("lastModelByKind", {});
  const chat = {
    id: uid(),
    title: NEW_TITLE,
    created: Date.now(),
    updated: Date.now(),
    kind,
    model: model || byKind[kind] || (kind === "chat" ? last?.model : null) || defaultModelFor(kind),
    system: "",
    params: { ...DEFAULT_PARAMS, ...(last?.params || {}), stop: [...(last?.params?.stop || [])] },
    opts: {},
    questions: [],
    structured: false,  // chat: answer with JSON in the output structure
    many: false,        // chat: a list of items instead of one object
    outputs: [],        // output structure (chat) / fields to extract (extract)
    inputs: [],         // named input fields; the composer becomes a form
    inputValues: {},
    messages: [],
  };
  if (from) { // "New chat" keeps the current model, settings, questions and structure
    Object.assign(chat, structuredClone({ kind: from.kind, model: from.model, params: from.params, opts: from.opts || {},
      questions: from.questions || [], structured: !!from.structured, many: !!from.many, outputs: from.outputs || [],
      inputs: from.inputs || [], inputValues: from.inputValues || {} }));
  }
  ensureKindDefaults(chat);
  return chat;
}

function ensureKindDefaults(chat) {
  if (chat.kind === "decisions" && !chat.questions.length) chat.questions = defaultQuestions();
  if (chat.kind === "extract" && !chat.outputs.length) chat.outputs = EXTRACT_TEMPLATES.invoice.outputs.map(field);
}

function defaultModelFor(kind) {
  if (kind === "chat") return state.defaultModel;
  if (kind === "decisions" && state.byId.has(state.aliases.jev)) return state.aliases.jev;
  const list = state.models.filter((m) => m.modes.includes(kind)).sort((a, b) => b.created - a.created);
  return (list.find((m) => !isFree(m)) || list[0] || { id: state.defaultModel }).id;
}

function normalizeChat(c) {
  c.params = { ...DEFAULT_PARAMS, ...(c.params || {}) };
  c.messages ||= [];
  c.system ||= "";
  c.title ||= "Untitled";
  c.kind ||= "chat";
  c.model ||= state.defaultModel;
  c.opts ||= {};
  c.questions ||= [];
  c.outputs ||= [];
  c.inputs ||= [];
  c.inputValues ||= {};
  return c;
}

function newChat() {
  stopRun();
  flushSave();
  state.chat = newChatObject("chat", null, state.chat);
  state.pending = [];
  store.set("lastChat", null);
  renderAll();
  closeDrawers();
  $("#input").focus();
}

let openSeq = 0;
async function openChat(id) {
  closeDrawers();
  if (state.chat?.id === id) return;
  stopRun();
  flushSave();
  const token = ++openSeq;
  try {
    const loaded = normalizeChat(await api(`/api/chats/${encodeURIComponent(id)}`));
    if (token !== openSeq) return; // the user clicked another chat meanwhile
    state.chat = loaded;
    store.set("lastChat", id);
    state.pending = [];
    renderAll();
    scrollToBottom();
    resumeJobs(state.chat);
  } catch (e) {
    toast("Could not open chat: " + e.message);
  }
}

let saveTimer = null;
let saveTarget = null;

function saveChat(chat = state.chat) {
  if (!chat || chat.deleted || (!chat.messages.length && !chat.system.trim())) return; // don't save empty or deleted chats
  chat.updated = Date.now();
  if (saveTarget && saveTarget !== chat) flushSave();
  saveTarget = chat;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 400);
  upsertChatSummary(chat);
}

function flushSave(keepalive = false) {
  clearTimeout(saveTimer);
  const chat = saveTarget;
  saveTarget = null;
  if (!chat || chat.deleted) return;
  const body = JSON.stringify(chat);
  // Browsers refuse keepalive requests over 64 KB; send big chats normally and hope the page lives long enough.
  if (keepalive && body.length > 60000) keepalive = false;
  fetch(`/api/chats/${encodeURIComponent(chat.id)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body,
    keepalive,
  }).then((r) => { if (!r.ok) throw new Error(r.statusText); if (state.chat === chat) store.set("lastChat", chat.id); })
    .catch((e) => toast("Saving failed: " + e.message));
}

function upsertChatSummary(chat) {
  const summary = { id: chat.id, title: chat.title, updated: chat.updated, model: chat.model, kind: kindOf(chat) };
  state.chats = [summary, ...state.chats.filter((c) => c.id !== chat.id)];
  renderChatList();
}

async function loadChatList() {
  try { state.chats = await api("/api/chats"); }
  catch (e) { toast("Could not load chats: " + e.message); }
  renderChatList();
}

async function deleteChat(id) {
  const c = state.chats.find((x) => x.id === id);
  if (!confirm(`Delete “${c?.title || "this chat"}” and the files it generated?`)) return;
  const open = state.chat?.id === id ? state.chat : null;
  if (open) { open.deleted = true; stopRun(); } // a running reply must not save the chat back afterwards
  if (saveTarget?.id === id) { clearTimeout(saveTimer); saveTarget = null; }
  try { await api(`/api/chats/${encodeURIComponent(id)}`, { method: "DELETE" }); }
  catch (e) { if (open) delete open.deleted; return toast("Delete failed: " + e.message); }
  state.chats = state.chats.filter((x) => x.id !== id);
  if (state.chat?.id === id) newChat(); else renderChatList();
}

function makeTitle(text, attachments) {
  const line = (text || "").trim().split("\n")[0].replace(/\s+/g, " ");
  if (line) return line.length > 60 ? line.slice(0, 57) + "…" : line;
  return attachments?.[0]?.name || "Untitled";
}

/** Switch the open chat to another mode. A chat with messages keeps its mode; we start a new one. */
function switchKind(kind, model) {
  const chat = state.chat;
  model ||= modelInfo(chat.model).modes.includes(kind) ? chat.model : null;
  if (chat.messages.length) {
    stopRun();
    flushSave();
    state.chat = newChatObject(kind, model);
    state.pending = [];
    toast(`Started a new ${KINDS[kind].label} chat. Each mode has its own input and output.`);
  } else {
    chat.kind = kind;
    chat.model = model || newChatObject(kind).model;
    ensureKindDefaults(chat);
  }
  renderAll();
}

/* ---------------------------------------------------------------------
   Rendering: sidebar
   --------------------------------------------------------------------- */

function renderChatList() {
  const q = $("#chatSearch").value.trim().toLowerCase();
  const list = state.chats.filter((c) => !q || c.title.toLowerCase().includes(q));
  const el = $("#chatList");
  if (!list.length) {
    el.innerHTML = `<div class="chat-list-empty">${q ? "No matching chats." : "Your saved chats will appear here."}</div>`;
    return;
  }
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const day = 864e5;
  const groups = {};
  for (const c of list) {
    const t = c.updated || 0;
    const g = t >= today ? "Today" : t >= today - day ? "Yesterday"
      : t >= today - 7 * day ? "Previous 7 days" : t >= today - 30 * day ? "Previous 30 days" : "Older";
    (groups[g] ||= []).push(c);
  }
  el.innerHTML = Object.entries(groups).map(([g, items]) =>
    `<div class="chat-group">${g}</div>` + items.map((c) => `
      <div class="chat-item ${c.id === state.chat?.id ? "active" : ""}" data-id="${esc(c.id)}" role="button" tabindex="0" title="${esc(c.title)}">
        <span class="ms chat-kind">${(KINDS[c.kind] || KINDS.chat).icon}</span>
        <span class="chat-item-title">${esc(c.title)}</span>
        <button class="chat-item-del" data-del="${esc(c.id)}" title="Delete chat"><span class="ms">delete</span></button>
      </div>`).join("")).join("");
}

async function loadCredits() {
  const btn = $("#creditsBtn");
  const meter = $("#creditsMeter");
  try {
    const k = await api("/api/key");
    state.keyInfo = k;
    const sum = keySummary(k); // pricing.js
    $("#creditsText").innerHTML = sum.main;
    $("#creditsSub").textContent = sum.sub;
    meter.hidden = sum.pct == null;
    if (sum.pct != null) $("i", meter).style.width = `${sum.pct}%`;
    btn.classList.toggle("warn", sum.warn);
  } catch {
    state.keyInfo = null;
    $("#creditsText").textContent = "API key not working";
    $("#creditsSub").textContent = "";
    meter.hidden = true;
    btn.classList.add("warn");
  }
  if (!$("#usageModal").hidden) renderUsage();
}
let creditsTimer;
const refreshCreditsSoon = () => { clearTimeout(creditsTimer); creditsTimer = setTimeout(loadCredits, 2500); };

/* ---------------------------------------------------------------------
   Rendering: header, workspace, settings, stats
   --------------------------------------------------------------------- */

function renderAll() {
  renderHeader();
  renderWorkspace();
  renderSettings();
  renderMessages();
  renderChatList();
  renderPending();
  updateStats();
  loadProviders();
}

function renderHeader() {
  const chat = state.chat;
  const kind = kindOf(chat);
  const m = modelInfo(chat.model);
  $("#chatTitle").value = chat.title;
  $("#systemInput").value = chat.system;
  $("#systemBox").open = false;
  updateSystemPreview();
  document.title = `${chat.title} · OpenRouter Studio`;
  $("#kindBadge").innerHTML = `<span class="ms">${KINDS[kind].icon}</span><span class="hide-sm">${KINDS[kind].label}</span>`;
  const sw = $("#modeSwitch");
  sw.hidden = m.modes.length < 2;
  sw.innerHTML = m.modes.map((k) =>
    `<button data-kind="${k}" class="${k === kind ? "on" : ""}" title="${KINDS[k].label} mode"><span class="ms">${KINDS[k].icon}</span><span class="hide-sm">${KINDS[k].label}</span></button>`).join("");
}

/** Composer, empty state and top cards follow the chat's mode and the model's inputs. */
function renderWorkspace() {
  const chat = state.chat;
  const kind = kindOf(chat);
  const k = viewOf(chat);
  const m = modelInfo(chat.model);
  const st = isStructuredChat(chat);
  $("#systemBox").hidden = kind !== "chat";
  $("#questionsBox").hidden = kind !== "decisions";
  if (kind === "decisions") renderQuestions();
  renderStructure(); // structured.js: input fields, output structure, form composer
  $("#structChip").hidden = kind !== "chat";
  $("#structChip").classList.toggle("on", st);

  $("#input").placeholder = k.placeholder;
  $("#runLabel").textContent = k.run;
  $("#runIcon").textContent = k.runIcon;
  const accepted = acceptedInputs(kind, m);
  $("#attachBtn").hidden = accepted.size === 0;
  $("#attachBtn").title = "Attach " + [...accepted].map((a) => ({ image: "images", pdf: "PDFs", audio: "audio", video: "video", text: "text files" }[a])).join(", ");
  $("#fileInput").accept = acceptAttr(accepted);
  $("#micBtn").hidden = !accepted.has("audio") || !navigator.mediaDevices?.getUserMedia;
  $("#composerIO").innerHTML = ioStripHTML(m, kind, false, st);
  $("#composerIO").title = `${shortName(m)} accepts ${ioFor(m, kind, st).input.map((x) => MODALITY[x]?.label || x).join(", ")} and returns ${ioFor(m, kind, st).output.map((x) => MODALITY[x]?.label || x).join(", ")}`;
  $("#chipModelIcon").textContent = k.icon;

  // empty state
  $("#emptyIcon").textContent = k.icon;
  $("#emptyTitle").textContent = k.title;
  $("#emptyText").textContent = k.text;
  $("#emptyIO").innerHTML = ioStripHTML(m, kind, true, st);
  $("#suggestions").innerHTML = (k.suggestions || []).map((s, i) =>
    `<button data-sug="${i}"><span class="ms">${s.icon}</span><span>${esc(s.label || s.text)}</span></button>`).join("");

  // drop attachments the new model can't take
  const before = state.pending.length;
  state.pending = state.pending.filter((a) => accepted.has(a.kind));
  if (state.pending.length < before) { toast(`Removed attachments ${shortName(m)} can't read.`); renderPending(); }
}

function updateSystemPreview() {
  const s = state.chat.system.trim().replace(/\s+/g, " ");
  $("#systemPreview").textContent = s ? `— ${s}` : "";
}

function renderSettings() {
  const chat = state.chat;
  const kind = kindOf(chat);
  const p = chat.params;
  $("#chatSettings").hidden = kind !== "chat";
  if (kind === "chat") {
    $("#temperature").value = p.temperature;
    $("#temperatureNum").value = p.temperature;
    $("#topP").value = p.top_p;
    $("#topPNum").value = p.top_p;
    $("#maxTokens").value = p.max_tokens ?? "";
    $("#seed").value = p.seed ?? "";
    renderStops();
    const how = jsonSupport(modelInfo(chat.model));
    $("#structuredToggle").checked = !!chat.structured;
    $("#structuredNote").textContent = how === "schema"
      ? "Answers come back as JSON in your output structure. This model enforces it (strict JSON Schema)."
      : how === "json" ? "This model has a JSON mode. The structure is sent as instructions and checked afterwards."
      : "This model has no JSON mode. The structure is sent as instructions and checked afterwards.";
    $("#manyRow").hidden = !chat.structured;
    $("#manyToggle").checked = !!chat.many;
  }
  renderKindSettings(); // modes.js
  renderModelBits();
}

function renderModelBits() {
  if (!state.chat) return;
  const chat = state.chat;
  const kind = kindOf(chat);
  const m = modelInfo(chat.model);
  const name = shortName(m);
  $("#modelName").textContent = name;
  $("#modelId").textContent = m.id;
  $("#chipModelName").textContent = name;
  $("#emptyModelName").textContent = name;
  const io = ioFor(m, kind, isStructuredChat(chat));
  const label = (x) => `<span class="io-chip labeled"><span class="ms">${(MODALITY[x] || {}).icon || "help"}</span>${esc((MODALITY[x] || {}).label || x)}</span>`;
  $("#modelIO").innerHTML = `<div><span class="io-title">Input</span>${io.input.map(label).join("")}</div>
    <div><span class="io-title">Output</span>${io.output.map(label).join("")}</div>`;
  const meta = [];
  if (m.context) meta.push(`<span class="tag"><span class="ms">data_object</span>${fmtTokens(m.context)} context</span>`);
  $("#modelTags").innerHTML = meta.join("") + modelTagsHTML(m);

  if (kind === "chat") {
    // thinking efforts come from the model itself (e.g. low / medium / high)
    const efforts = m.reasoning?.supported_efforts?.length ? m.reasoning.supported_efforts : ["low", "medium", "high"];
    const order = ["minimal", "low", "medium", "high", "xhigh", "max"];
    const sorted = [...efforts].sort((a, b) => order.indexOf(a) - order.indexOf(b));
    $("#reasoning").innerHTML = ["", ...sorted].map((v) =>
      `<button data-v="${v}" class="${(chat.params.reasoning || "") === v ? "on" : ""}">${v ? v[0].toUpperCase() + v.slice(1) : "Auto"}</button>`).join("");
    $("#reasoning").style.gridTemplateColumns = `repeat(${sorted.length + 1}, 1fr)`;
    const thinking = canThink(m);
    $("#thinkingField").hidden = !thinking;
    $("#thinkingNote").textContent = m.reasoning?.mandatory
      ? `This model always thinks. Auto uses its default (${m.reasoning.default_effort || "medium"}).`
      : "How much the model reasons before answering. Auto lets the model decide.";

    const audioOut = m.output.includes("audio");
    $("#audioOutField").hidden = !audioOut;
    if (audioOut) {
      const voices = m.voices?.length ? m.voices : m.id.startsWith("openai/")
        ? ["alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer", "verse"] : [];
      $("#audioVoice").hidden = !voices.length;
      $("#audioVoice").innerHTML = voices.map((v) => `<option ${v === chat.params.voice ? "selected" : ""}>${esc(v)}</option>`).join("");
      $("#audioFormat").value = chat.params.audioFormat || (m.id.startsWith("openai/") ? "pcm16" : "wav");
    }
  }
  renderPriceCard(); // pricing.js
}

function renderStops() {
  const wrap = $("#stopChips");
  $$(".chip", wrap).forEach((c) => c.remove());
  const input = $("#stopInput");
  state.chat.params.stop.forEach((s, i) => {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.innerHTML = `${esc(JSON.stringify(s).slice(1, -1))}<button data-stop="${i}" title="Remove"><span class="ms">close</span></button>`;
    wrap.insertBefore(chip, input);
  });
}

function estimateTokens(chat) {
  let chars = chat.system.length + draftText(chat).length;
  if (isStructuredChat(chat)) chars += JSON.stringify(buildSchema(chat)).length;
  let extra = 0;
  const count = (a) => { if (a.kind === "text") chars += a.data.length; else extra += a.kind === "pdf" ? 1500 : 1000; };
  for (const m of chat.messages) {
    if ((m.kind || "chat") !== "chat" && m.role === "assistant") continue;
    chars += (m.content || "").length;
    (m.attachments || []).forEach(count);
  }
  state.pending.forEach(count);
  return Math.round(chars / 4) + extra;
}

/** What the composer currently holds: the text box, or the form's values. */
function draftText(chat) {
  if (!usesInputFields(chat)) return $("#input").value;
  const v = formValues(chat);
  return Object.keys(v).length ? (kindOf(chat) === "extract" ? fieldsAsLines(v) : JSON.stringify(v, null, 2)) : "";
}

const viewOf = (chat) => (isStructuredChat(chat) ? STRUCT_CHAT_VIEW : KINDS[kindOf(chat)]);

const msgCost = (m) => m.meta?.usage?.cost ?? m.meta?.cost ?? 0;

function updateStats() {
  const chat = state.chat;
  if (!chat) return;
  const kind = kindOf(chat);
  const info = modelInfo(chat.model);
  const cost = chat.messages.reduce((s, m) => s + msgCost(m), 0);
  $("#chatCost").textContent = fmtCost(cost);
  if (kind === "chat") {
    const last = chat.messages.at(-1);
    let tokens, exact = false;
    if (last?.role === "assistant" && last.meta?.usage && !$("#input").value && !state.pending.length) {
      tokens = (last.meta.usage.prompt_tokens || 0) + (last.meta.usage.completion_tokens || 0);
      exact = true;
    } else {
      tokens = estimateTokens(chat);
    }
    $("#tokenLabel").textContent = "Token count";
    $("#tokenCount").textContent = `${exact ? "" : "~"}${fmtInt(tokens)}${info.context ? " / " + fmtInt(info.context) : ""}`;
    $("#tokenMeter").style.width = info.context ? Math.min(100, (tokens / info.context) * 100) + "%" : "0%";
  } else {
    const runs = chat.messages.filter((m) => m.role === "assistant").length;
    $("#tokenLabel").textContent = "Runs in this chat";
    $("#tokenCount").textContent = fmtInt(runs);
    $("#tokenMeter").style.width = "0%";
  }
  renderEstimate(); // pricing.js (composer hint + settings box)
}

/* ---------------------------------------------------------------------
   Rendering: messages
   --------------------------------------------------------------------- */

function renderMarkdown(text, live = false) {
  if (!window.marked || !window.DOMPurify) {
    return `<p style="white-space:pre-wrap">${esc(text)}</p>`;
  }
  const tpl = document.createElement("template");
  tpl.innerHTML = DOMPurify.sanitize(marked.parse(text, { gfm: true, breaks: false }));
  tpl.content.querySelectorAll("pre > code").forEach((code) => {
    const lang = (code.className.match(/language-([\w+#.-]+)/) || [])[1] || "";
    if (window.hljs) {
      try {
        let html = null;
        if (lang && hljs.getLanguage(lang)) html = hljs.highlight(code.textContent, { language: lang, ignoreIllegals: true }).value;
        else if (!live) html = hljs.highlightAuto(code.textContent).value;
        if (html !== null) { code.innerHTML = html; code.classList.add("hljs"); }
      } catch { /* leave it plain */ }
    }
    const pre = code.parentElement;
    const block = document.createElement("div");
    block.className = "code-block";
    block.innerHTML = `<div class="code-head"><span>${esc(lang || "code")}</span>
      <button data-copy-code><span class="ms">content_copy</span>Copy</button></div>`;
    pre.replaceWith(block);
    block.appendChild(pre);
  });
  tpl.content.querySelectorAll("a[href]").forEach((a) => { a.target = "_blank"; a.rel = "noopener noreferrer"; });
  tpl.content.querySelectorAll("p, li, h1, h2, h3, h4, blockquote, td, th").forEach((el) => el.setAttribute("dir", "auto"));
  const div = document.createElement("div");
  div.appendChild(tpl.content);
  return div.innerHTML;
}

const ATTACH_ICON = { pdf: "picture_as_pdf", text: "description", audio: "graphic_eq", video: "movie" };

function attachmentsHTML(atts = []) {
  if (!atts.length) return "";
  return `<div class="attach-row">${atts.map((a) => {
    if (a.kind === "image") return `<img class="attach-thumb" src="${esc(a.data)}" alt="${esc(a.name)}" title="${esc(a.name)}">`;
    if (a.kind === "audio") return `<div class="attach-media"><span class="attach-file"><span class="ms">graphic_eq</span><span>${esc(a.name)}</span></span><audio controls preload="none" src="${esc(a.data)}"></audio></div>`;
    if (a.kind === "video") return `<video class="attach-video" controls preload="metadata" src="${esc(a.data)}" title="${esc(a.name)}"></video>`;
    return `<span class="attach-file" title="${esc(a.name)}"><span class="ms">${ATTACH_ICON[a.kind] || "description"}</span><span>${esc(a.name)}</span></span>`;
  }).join("")}</div>`;
}

function actionsHTML(isUser) {
  return `
    <button data-act="edit" title="Edit"><span class="ms">edit</span></button>
    <button data-act="rerun" title="${isUser ? "Run from here" : "Run again"}"><span class="ms">${isUser ? "play_arrow" : "refresh"}</span></button>
    <button data-act="copy" title="Copy"><span class="ms">content_copy</span></button>
    <button data-act="delete" class="danger" title="Delete"><span class="ms">delete</span></button>`;
}

function footHTML(m) {
  const u = m.meta?.usage || {};
  const parts = [];
  if (m.meta?.stopped) parts.push(`<span><span class="ms">stop_circle</span>Stopped</span>`);
  const inTok = u.prompt_tokens ?? u.input_tokens;
  const outTok = u.completion_tokens ?? u.output_tokens;
  if (u.seconds != null) parts.push(`<span title="Audio length"><span class="ms">graphic_eq</span>${fmtDuration(u.seconds)} audio</span>`);
  if (inTok != null) parts.push(`<span title="Input / output tokens"><span class="ms">token</span>${fmtInt(inTok)} in${outTok != null ? ` · ${fmtInt(outTok)} out` : ""}</span>`);
  const cost = msgCost(m);
  if (u.cost != null || m.meta?.cost != null) parts.push(`<span class="exact-cost" title="Exact cost reported by OpenRouter"><span class="ms">payments</span>${fmtCost(cost)}</span>`);
  else if (m.meta?.estimate) parts.push(`<span title="Estimated from live prices"><span class="ms">payments</span>≈ ${fmtCost(m.meta.estimate)}</span>`);
  if (m.meta?.seconds) parts.push(`<span title="Time"><span class="ms">timer</span>${m.meta.seconds}s</span>`);
  return parts.join("");
}

function messageEl(m) {
  const el = document.createElement("div");
  const kind = m.kind || "chat";
  el.className = `msg ${m.role} kind-${kind}`;
  el.dataset.id = m.id;
  const isUser = m.role === "user";
  const busy = state.streamingId === m.id;
  const info = isUser ? null : modelInfo(m.model || state.chat.model);
  el.innerHTML = `
    <div class="msg-head">
      <div class="avatar"><span class="ms">${isUser ? "person" : (KINDS[kind] || KINDS.chat).icon}</span></div>
      <span class="role">${isUser ? "You" : esc(shortName(info))}</span>
      ${isUser ? "" : `<span class="role-sub">${esc(info.id)}</span>`}
      <div class="msg-actions">${busy ? "" : actionsHTML(isUser)}</div>
    </div>
    <div class="msg-content">
      ${isUser ? attachmentsHTML(m.attachments) : kind === "chat" ? `
        <details class="thoughts" hidden>
          <summary><span class="ms">psychology</span><span class="thoughts-label">Thoughts</span><span class="ms chevron">expand_more</span></summary>
          <div class="md"></div>
        </details>` : ""}
      <div class="msg-body ${isUser ? "" : "md"}" dir="auto"></div>
      <div class="msg-error" hidden></div>
      <div class="msg-foot"></div>
    </div>`;
  if (isUser && m.fields) {
    $(".msg-body", el).innerHTML = `<div class="kv user-kv">${Object.entries(m.fields).map(([k, v]) =>
      `<div class="kv-row"><span class="kv-key">${esc(k)}</span><span class="kv-val textv" dir="auto">${esc(v)}</span></div>`).join("")}</div>`;
  } else if (isUser) {
    const body = $(".msg-body", el);
    body.textContent = m.content;
    body.hidden = !m.content;
  } else {
    paintAssistant(el, m);
  }
  return el;
}

function paintAssistant(el, m) {
  const busy = state.streamingId === m.id;
  const kind = m.kind || "chat";
  const body = $(".msg-body", el);
  if (kind === "chat") {
    const th = $(".thoughts", el);
    if (m.reasoning) {
      th.hidden = false;
      $(".md", th).innerHTML = renderMarkdown(m.reasoning, busy);
      const thinkingNow = busy && !m.content;
      const label = $(".thoughts-label", th);
      label.textContent = thinkingNow ? "Thinking…" : "Thoughts";
      label.classList.toggle("thinking-dot", thinkingNow);
      if (!th.dataset.touched) th.open = thinkingNow;
    }
    let html;
    if (m.schema) { // structured output: raw JSON while streaming, a typed result when done
      html = busy ? (m.content ? `<div class="json-live"><span class="ms spin">progress_activity</span>Receiving JSON…</div><pre class="json-stream">${esc(m.content)}</pre>`
        : '<div class="typing"><i></i><i></i><i></i></div>') : m.content ? renderStructuredChat(m) : "";
    } else {
      html = m.content ? renderMarkdown(m.content, busy)
        : busy && !m.reasoning ? '<div class="typing"><i></i><i></i><i></i></div>' : "";
    }
    if (m.audio) html += `<div class="audio-out"><audio controls src="${esc(m.audio)}"></audio><a class="ghost-btn" href="${esc(m.audio)}" download><span class="ms">download</span></a></div>`;
    body.innerHTML = html;
  } else {
    body.classList.remove("md");
    body.innerHTML = busy ? taskPlaceholderHTML(m) : renderOutput(m); // modes.js
  }

  const err = $(".msg-error", el);
  if (m.meta?.error) {
    err.hidden = false;
    err.innerHTML = `<span class="ms">error</span><div>${esc(m.meta.error)}</div><button data-act="rerun">Retry</button>`;
  } else {
    err.hidden = true;
  }
  $(".msg-foot", el).innerHTML = busy ? liveFootHTML(m) : footHTML(m);
}

function repaintMessage(m) {
  const el = $(`.msg[data-id="${m.id}"]`);
  if (el) el.replaceWith(messageEl(m));
}

function renderMessages() {
  const box = $("#messages");
  box.innerHTML = "";
  for (const m of state.chat.messages) box.appendChild(messageEl(m));
  $("#empty").hidden = state.chat.messages.length > 0;
}

const scroller = () => $("#scroll");
const isNearBottom = () => { const s = scroller(); return s.scrollHeight - s.scrollTop - s.clientHeight < 140; };
const scrollToBottom = () => { const s = scroller(); s.scrollTop = s.scrollHeight; };

let paintQueued = false;
let lastPaint = 0;
function schedulePaint(m) {
  if (paintQueued) return;
  paintQueued = true;
  const wait = Math.max(0, 60 - (performance.now() - lastPaint));
  setTimeout(() => requestAnimationFrame(() => {
    paintQueued = false;
    lastPaint = performance.now();
    const el = $(`.msg[data-id="${m.id}"]`);
    if (!el || state.streamingId !== m.id) return;
    const stick = isNearBottom();
    paintAssistant(el, m);
    if (stick) scrollToBottom();
  }), wait);
}

/* ---------------------------------------------------------------------
   Running chat models (streaming)
   --------------------------------------------------------------------- */

function attachmentToPart(f) {
  if (f.kind === "image") return { type: "image_url", image_url: { url: f.data } };
  if (f.kind === "pdf") return { type: "file", file: { filename: f.name, file_data: f.data } };
  if (f.kind === "audio") return { type: "input_audio", input_audio: { data: f.data.split(",")[1], format: f.format || "wav" } };
  if (f.kind === "video") return { type: "video_url", video_url: { url: f.data } };
  return null;
}

function userToApi(m) {
  const files = m.attachments || [];
  if (!files.length) return { role: "user", content: m.content };
  let text = m.content;
  for (const f of files) if (f.kind === "text") text += `\n\n--- ${f.name} ---\n${f.data}`;
  const parts = [{ type: "text", text: text.trim() || "(see attached)" }];
  for (const f of files) { const p = attachmentToPart(f); if (p) parts.push(p); }
  return { role: "user", content: parts };
}

function buildApiMessages(chat) {
  const out = [];
  const info = modelInfo(chat.model);
  const system = [chat.system.trim(), isStructuredChat(chat) ? schemaInstruction(chat, info) : ""].filter(Boolean).join("\n\n");
  if (system) out.push({ role: "system", content: system });
  for (const m of chat.messages) {
    if (m.role === "assistant") {
      if ((m.kind || "chat") === "chat" && m.content) out.push({ role: "assistant", content: m.content });
    } else out.push(userToApi(m));
  }
  return out;
}

function buildParams(chat, info) {
  const p = chat.params;
  const out = { temperature: p.temperature };
  if (p.top_p < 1) out.top_p = p.top_p;
  if (p.max_tokens) out.max_tokens = p.max_tokens;
  if (p.stop?.length) out.stop = p.stop;
  if (p.seed !== null && p.seed !== "" && !Number.isNaN(Number(p.seed))) out.seed = Number(p.seed);
  if (p.reasoning && canThink(info)) out.reasoning = { effort: p.reasoning };
  if (isStructuredChat(chat)) Object.assign(out, structuredParams(chat, info));
  if (info.output.includes("audio")) {
    out.modalities = ["text", "audio"];
    out.audio = { format: $("#audioFormat").value || (info.id.startsWith("openai/") ? "pcm16" : "wav") };
    // the remembered voice may belong to another model: only send it if this model offers it
    const offered = $$("#audioVoice option").map((o) => o.value);
    const voice = offered.includes(p.voice) ? p.voice : $("#audioVoice").value;
    if (voice && !$("#audioVoice").hidden) out.audio.voice = voice;
  }
  // PDFs work on every model: if it can't read files itself, OpenRouter's free parser turns them into text.
  const hasPdf = chat.messages.some((m) => (m.attachments || []).some((a) => a.kind === "pdf"));
  if (hasPdf && !info.input.includes("file")) out.plugins = [{ id: "file-parser", pdf: { engine: "cloudflare-ai" } }];
  return out;
}

function setRunning(on) {
  const k = KINDS[kindOf(state.chat)];
  $("#runBtn").classList.toggle("stop", on);
  $("#runIcon").textContent = on ? "stop" : k.runIcon;
  $("#runLabel").textContent = on ? "Stop" : k.run;
}

function stopRun() { state.controller?.abort(); }

async function onRun() {
  if (state.controller) return stopRun();
  if (recorder) await stopRecording();
  const chat = state.chat;
  const kind = kindOf(chat);
  const input = $("#input");
  const form = usesInputFields(chat);
  const fields = form ? formValues(chat) : null;
  if (form && !Object.keys(fields).length && !state.pending.length) return toast("Fill in at least one input field.");
  const text = form ? draftText(chat) : input.value.trim();
  if (isStructuredChat(chat) && !(chat.outputs || []).some((f) => f.key.trim())) return toast("Add at least one output field.");
  const problem = viewOf(chat).validate?.(text, state.pending, chat);
  if (problem) return toast(problem);
  if (text || state.pending.length) {
    const attachments = state.pending;
    chat.messages.push({ id: uid(), role: "user", content: text, attachments, created: Date.now(), ...(form ? { fields } : {}) });
    const titleText = form ? Object.values(fields).sort((a, b) => b.length - a.length)[0] : text; // the longest field reads best
    if (chat.title === NEW_TITLE) { chat.title = makeTitle(titleText, attachments); renderHeader(); }
    state.pending = [];
    if (!form) input.value = ""; // form values stay, so you can tweak one field and run again
    autosize(input);
    renderPending();
    renderMessages();
    saveChat(chat);
  }
  if (chat.messages.at(-1)?.role !== "user") return toast(KINDS[kind].needInput || "Type a message first.");
  scrollToBottom();
  if (kind === "chat") await generate();
  else await runTask(chat.messages.at(-1)); // modes.js
}

async function generate() {
  const chat = state.chat;
  const model = chat.model;
  const info = modelInfo(model);
  const history = buildApiMessages(chat);
  const msg = { id: uid(), role: "assistant", kind: "chat", content: "", reasoning: "", model, meta: {}, created: Date.now() };
  msg.meta.promptEstimate = estimateTokens(chat);
  if (isStructuredChat(chat)) msg.schema = { outputs: structuredClone(chat.outputs.filter((f) => f.key.trim())), many: !!chat.many };
  chat.messages.push(msg);
  state.streamingId = msg.id;
  const el = messageEl(msg);
  $("#messages").appendChild(el);
  $("#empty").hidden = true;
  scrollToBottom();

  const controller = new AbortController();
  state.controller = controller;
  setRunning(true);
  const started = performance.now();

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages: history, params: buildParams(chat, info) }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      throw new Error(d.error || `HTTP ${res.status}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 2);
        if (!line.startsWith("data:")) continue;
        let ev;
        try { ev = JSON.parse(line.slice(5)); } catch { continue; } // skip one bad line, keep the reply
        handleEvent(msg, ev);
      }
      schedulePaint(msg);
    }
    if (!msg.content && !msg.meta.error && !msg.reasoning && !msg.audio) msg.meta.error = "The model returned an empty answer.";
    if (msg.schema && msg.content) finishStructured(msg);
  } catch (e) {
    if (e.name === "AbortError") msg.meta.stopped = true;
    else msg.meta.error = e.message || String(e);
  } finally {
    msg.meta.seconds ||= +((performance.now() - started) / 1000).toFixed(1);
    if (!msg.meta.usage) msg.meta.estimate = liveChatCost(msg); // keep a price even when stopped early
    state.controller = null;
    state.streamingId = null;
    setRunning(false);
    if (state.chat === chat) {
      // look the node up again: a re-render during the run may have replaced `el`
      const stick = isNearBottom();
      repaintMessage(msg);
      if (stick) scrollToBottom();
      updateStats();
    }
    saveChat(chat);
    refreshCreditsSoon();
  }
}

function handleEvent(msg, ev) {
  if (ev.type === "content" || ev.type === "transcript") msg.content += ev.text;
  else if (ev.type === "reasoning") msg.reasoning += ev.text;
  else if (ev.type === "audio") msg.audio = ev.url;
  else if (ev.type === "done") {
    msg.meta.usage = ev.usage || null;
    msg.meta.servedBy = ev.model;
    msg.meta.seconds = ev.seconds;
    if (ev.stopped) msg.meta.stopped = true;
  } else if (ev.type === "error") msg.meta.error = ev.message;
}

function rerun(m) {
  if (state.controller) return;
  const msgs = state.chat.messages;
  const i = msgs.indexOf(m);
  const cut = m.role === "user" ? i + 1 : i;
  const dropped = msgs.length - cut - (m.role === "user" ? 0 : 1);
  if (dropped > 0 && !confirm(`This removes the ${dropped} message${dropped > 1 ? "s" : ""} below it. Continue?`)) return;
  state.chat.messages = msgs.slice(0, cut);
  renderMessages();
  const last = state.chat.messages.at(-1);
  if (last?.role !== "user") { saveChat(); return toast("There is no input to run."); }
  if (kindOf(state.chat) === "chat") generate(); else runTask(last);
}

function startEdit(el, m) {
  const body = $(".msg-body", el);
  const box = document.createElement("div");
  box.className = "edit-box";
  const editable = m.role === "user" || (m.kind || "chat") === "chat" || m.kind === "transcription";
  if (!editable) return toast("This output can't be edited. Edit your input instead.");
  box.innerHTML = `<textarea dir="auto"></textarea>
    <div class="edit-actions">
      <button class="ghost-btn" data-edit="cancel">Cancel</button>
      ${m.role === "user"
        ? '<button class="ghost-btn" data-edit="save">Save</button><button class="primary-btn" data-edit="run">Save &amp; run</button>'
        : '<button class="primary-btn" data-edit="save">Save</button>'}
    </div>`;
  const ta = $("textarea", box);
  ta.value = m.fields ? JSON.stringify(m.fields, null, 2) : m.content;
  body.hidden = false;
  body.replaceWith(box);
  $(".msg-actions", el).style.visibility = "hidden";
  autosize(ta, window.innerHeight * 0.6);
  ta.focus();
  ta.addEventListener("input", () => autosize(ta, window.innerHeight * 0.6));

  const finish = (act) => {
    if (act === "run" && state.controller) return toast("Stop the current run first.");
    if (act !== "cancel") {
      if (m.fields) {
        try { m.fields = JSON.parse(ta.value); } catch { return toast("Keep it valid JSON, like {\"name\": \"value\"}."); }
        m.content = kindOf(state.chat) === "extract" ? fieldsAsLines(m.fields) : JSON.stringify(m.fields, null, 2);
      } else m.content = ta.value;
      if (m.schema && m.role === "assistant") finishStructured(m);
      saveChat();
    }
    if (act === "run") {
      const i = state.chat.messages.indexOf(m);
      state.chat.messages = state.chat.messages.slice(0, i + 1);
      renderMessages();
      if (kindOf(state.chat) === "chat") generate(); else runTask(m);
    } else {
      el.replaceWith(messageEl(m));
      updateStats();
    }
  };
  box.addEventListener("click", (e) => {
    const act = e.target.closest("[data-edit]")?.dataset.edit;
    if (act) finish(act);
  });
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Escape") finish("cancel");
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) finish(m.role === "user" ? "run" : "save");
  });
}

/* ---------------------------------------------------------------------
   Attachments (filtered by what the model accepts) + microphone
   --------------------------------------------------------------------- */

/** Which attachment kinds the current model can take in this mode. */
function acceptedInputs(kind, m) {
  const has = (x) => m.input.includes(x);
  const s = new Set();
  if (kind === "chat") {
    s.add("text"); s.add("pdf"); // PDFs are parsed for models without native file input
    if (has("image")) s.add("image");
    if (has("audio")) s.add("audio");
    if (has("video")) s.add("video");
  } else if (kind === "image") {
    if (has("image") && (m.image?.params?.input_references?.max ?? 1) > 0) s.add("image");
  } else if (kind === "video") {
    if (has("image")) s.add("image");
  } else if (kind === "transcription") {
    s.add("audio");
  } else if (kind === "extract") {
    if (has("image")) s.add("image");
    if (has("file")) s.add("pdf");
  } else if (kind === "decisions") {
    if (has("image")) s.add("image");
    if (has("audio")) s.add("audio");
    if (has("video")) s.add("video");
  }
  return s;
}

function acceptAttr(accepted) {
  const parts = [];
  if (accepted.has("image")) parts.push("image/png,image/jpeg,image/webp,image/gif");
  if (accepted.has("pdf")) parts.push("application/pdf,.pdf");
  if (accepted.has("audio")) parts.push("audio/*,.mp3,.wav,.m4a,.ogg,.flac,.aac,.webm,.opus");
  if (accepted.has("video")) parts.push("video/mp4,video/mpeg,video/quicktime,video/webm");
  if (accepted.has("text")) parts.push("text/*,.md,.csv,.json,.py,.js,.ts,.html,.css,.xml,.yaml,.yml,.log,.sql,.java,.c,.cpp,.go,.rs,.rb,.php,.sh");
  return parts.join(",");
}

const readDataURL = (file) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(r.result);
  r.onerror = () => reject(r.error);
  r.readAsDataURL(file);
});

/** Decision models want PNG/JPEG between 256 and 1568 px per side, so resize/convert in the browser. */
function normalizeImage(dataUrl, { min = 256, max = 1568 } = {}) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      let scale = 1;
      if (Math.min(w, h) < min) scale = min / Math.min(w, h);
      if (Math.max(w, h) * scale > max) scale = max / Math.max(w, h);
      const png = dataUrl.startsWith("data:image/png");
      if (scale === 1 && (png || dataUrl.startsWith("data:image/jpeg"))) return resolve(dataUrl);
      const c = document.createElement("canvas");
      c.width = Math.round(w * scale);
      c.height = Math.round(h * scale);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      resolve(c.toDataURL(png ? "image/png" : "image/jpeg", 0.92));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

function mediaDuration(url, tag) {
  return new Promise((resolve) => {
    const el = document.createElement(tag);
    el.preload = "metadata";
    el.style.display = "none";
    const cleanup = () => { try { el.remove(); } catch { /* already removed */ } };
    const done = (dur) => { resolve(dur); cleanup(); };
    el.onloadedmetadata = () => done(Number.isFinite(el.duration) ? el.duration : null);
    el.onerror = () => done(null);
    el.src = url;
    document.body.appendChild(el);
    setTimeout(() => done(null), 4000);
  });
}

function classify(file) {
  const t = file.type || "";
  if (t.startsWith("image/")) return "image";
  if (t === "application/pdf" || /\.pdf$/i.test(file.name)) return "pdf";
  if (t.startsWith("audio/") || /\.(mp3|wav|m4a|ogg|flac|aac|opus)$/i.test(file.name)) return "audio";
  if (t.startsWith("video/") || /\.(mp4|mov|mpeg|webm)$/i.test(file.name)) return "video";
  return "text";
}

async function addFiles(files) {
  const kind = kindOf(state.chat);
  const m = modelInfo(state.chat.model);
  const accepted = acceptedInputs(kind, m);
  for (const f of files) {
    const type = classify(f);
    if (!accepted.has(type)) {
      toast(`${shortName(m)} can't take ${MODALITY[type === "pdf" ? "file" : type]?.label.toLowerCase() || type} input here.`);
      continue;
    }
    if (f.size > 25 * 1024 * 1024) { toast(`${f.name} is larger than 25 MB.`); continue; }
    try {
      const item = { name: f.name || `pasted-${type}`, kind: type, size: f.size };
      if (type === "text") {
        const text = await f.text();
        if (text.slice(0, 4000).includes("\u0000")) { toast(`${f.name}: this file type isn't supported.`); continue; }
        item.data = text;
      } else {
        item.data = await readDataURL(f);
        if (type === "pdf") item.data = item.data.replace(/^data:[^;,]*/, "data:application/pdf");
        if (type === "image" && (kind === "decisions" || kind === "extract")) item.data = await normalizeImage(item.data);
        if (type === "audio") {
          item.format = (f.name.match(/\.([a-z0-9]+)$/i)?.[1] || f.type.split("/")[1] || "wav").toLowerCase().replace("mpeg", "mp3").replace("x-wav", "wav");
          item.duration = await mediaDuration(item.data, "audio");
        }
        if (type === "video") item.duration = await mediaDuration(item.data, "video");
      }
      state.pending.push(item);
    } catch {
      toast(`Could not read ${f.name}.`);
    }
  }
  renderPending();
  updateStats();
}

function renderPending() {
  $("#pending").innerHTML = state.pending.map((a, i) => `
    <div class="pending-item" title="${esc(a.name)}">
      ${a.kind === "image" ? `<img src="${esc(a.data)}" alt="">`
        : `<span class="file-ico"><span class="ms">${ATTACH_ICON[a.kind] || "description"}</span></span>`}
      <div style="min-width:0"><div class="pi-name">${esc(a.name)}</div>
        <div class="pi-size">${fmtSize(a.size)}${a.duration ? " · " + fmtDuration(a.duration) : ""}</div></div>
      <button data-remove="${i}" title="Remove"><span class="ms">close</span></button>
    </div>`).join("");
}

// --- microphone: record, then convert to 16 kHz mono WAV (a format every audio model reads)

let recorder = null;
let recTimer = null;

async function toggleRecording() {
  if (recorder) return stopRecording();
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch { return toast("Microphone permission was denied."); }
  const chunks = [];
  const rec = new MediaRecorder(stream);
  recorder = rec;
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  rec.done = new Promise((resolve) => {
    rec.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      try {
        // `recorder` is already null here (stopRecording clears it first), so use the local reference.
        const wav = await blobToWav(new Blob(chunks, { type: rec.mimeType }));
        const file = new File([wav], `recording-${new Date().toTimeString().slice(0, 8).replace(/:/g, "")}.wav`, { type: "audio/wav" });
        await addFiles([file]);
      } catch (e) {
        toast("Could not process the recording: " + e.message);
      }
      resolve();
    };
  });
  rec.start();
  const started = Date.now();
  $("#recording").hidden = false;
  $("#micBtn").classList.add("recording-on");
  recTimer = setInterval(() => { $("#recTime").textContent = fmtDuration((Date.now() - started) / 1000); }, 250);
}

async function stopRecording() {
  if (!recorder) return;
  const r = recorder;
  recorder = null;
  clearInterval(recTimer);
  $("#recording").hidden = true;
  $("#micBtn").classList.remove("recording-on");
  r.stop();
  await r.done;
}

async function blobToWav(blob) {
  const ctx = new AudioContext();
  const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
  ctx.close();
  const rate = 16000;
  const offline = new OfflineAudioContext(1, Math.ceil(decoded.duration * rate), rate);
  const src = offline.createBufferSource();
  src.buffer = decoded;
  src.connect(offline.destination);
  src.start();
  const pcm = (await offline.startRendering()).getChannelData(0);
  const buf = new ArrayBuffer(44 + pcm.length * 2);
  const v = new DataView(buf);
  const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF"); v.setUint32(4, 36 + pcm.length * 2, true); str(8, "WAVE"); str(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, "data"); v.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, pcm[i])) * 0x7fff, true);
  return new Blob([buf], { type: "audio/wav" });
}

function lightbox(src) {
  const lb = document.createElement("div");
  lb.className = "lightbox";
  lb.innerHTML = `<img src="${esc(src)}" alt="">`;
  lb.addEventListener("click", () => lb.remove());
  document.body.appendChild(lb);
}

/* ---------------------------------------------------------------------
   Model picker (tabs per model type)
   --------------------------------------------------------------------- */

function openModelPicker(kind) {
  openModal("modelModal");
  state.pickerKind = kind || kindOf(state.chat);
  const s = $("#modelSearch");
  s.value = "";
  state.modelHl = 0;
  renderKindTabs();
  renderModelList();
  setTimeout(() => s.focus(), 30);
  if (!state.models.length) loadCatalog();
}

function renderKindTabs() {
  const counts = { all: state.models.length };
  for (const m of state.models) for (const k of m.modes) counts[k] = (counts[k] || 0) + 1;
  const tabs = [["all", "All", "apps"], ...Object.entries(KINDS).map(([k, d]) => [k, d.label, d.icon])];
  $("#kindTabs").innerHTML = tabs.map(([k, label, icon]) =>
    `<button data-kind="${k}" class="${state.pickerKind === k ? "on" : ""}"><span class="ms">${icon}</span>${label}<span class="tab-count">${counts[k] || 0}</span></button>`).join("");
}

function filteredModels(q) {
  const words = q.split(/\s+/).filter(Boolean);
  const list = state.models.filter((m) => {
    if (state.pickerKind !== "all" && !m.modes.includes(state.pickerKind)) return false;
    for (const f of state.modelFilters) {
      if (f === "free" && !isFree(m)) return false;
      if (["image", "file", "audio", "video"].includes(f) && !m.input.includes(f)) return false;
      if (f === "reasoning" && !canThink(m)) return false;
    }
    if (!words.length) return true;
    const hay = `${m.name} ${m.id} ${aliasOf(m.id) || ""} ${m.modes.map((k) => KINDS[k].label).join(" ")}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
  const sort = $("#modelSort").value;
  const price = (m) => { const p = m.pricing || {}; return (p.prompt ?? 1e9) + (p.completion ?? 0); };
  const sorters = {
    newest: (a, b) => b.created - a.created,
    name: (a, b) => shortName(a).localeCompare(shortName(b)),
    cheap: (a, b) => price(a) - price(b),
    context: (a, b) => (b.context || 0) - (a.context || 0),
  };
  return list.sort(sorters[sort] || sorters.newest);
}

function renderModelList() {
  const q = $("#modelSearch").value.trim().toLowerCase();
  const el = $("#modelList");
  if (!state.models.length) {
    el.innerHTML = '<div class="ml-empty">Loading models…</div>';
    return;
  }
  const current = state.chat.model;
  const tabKind = state.pickerKind;
  let idx = 0;
  const item = (m) => {
    const alias = aliasOf(m.id);
    const kind = tabKind !== "all" && m.modes.includes(tabKind) ? tabKind : m.modes[0];
    const html = `
      <button class="model-item ${m.id === current ? "selected" : ""} ${idx === state.modelHl ? "hl" : ""}" data-model="${esc(m.id)}" data-kind="${kind}" data-idx="${idx}">
        <div class="mi-top"><span class="mi-name">${esc(shortName(m))}</span>
          <span class="mi-kind"><span class="ms">${KINDS[kind].icon}</span>${KINDS[kind].label}</span>
          <span class="mi-tags">${modelTagsHTML(m)}</span></div>
        <div class="mi-id">${esc(m.id)}${alias ? ` · alias <b>${esc(alias)}</b>` : ""}</div>
        <div class="mi-meta">
          <span class="io-strip">${ioStripHTML(m, kind)}</span>
          ${m.context && ["chat", "decisions", "embeddings"].includes(kind) ? `<span><span class="ms">data_object</span>${fmtTokens(m.context)} ctx</span>` : ""}
          <span><span class="ms">payments</span>${esc(priceSummary(m, kind))}</span>
        </div>
      </button>`;
    idx++;
    return html;
  };

  const list = filteredModels(q);
  let html = "";
  if (q.includes("/") && !state.byId.has(q)) {
    html += `<div class="ml-group">Custom</div>` + item({ ...modelInfo(q), name: `Use “${q}”` });
  }
  if (!q && !state.modelFilters.size) {
    const ok = (id) => state.byId.has(id) && (tabKind === "all" || state.byId.get(id).modes.includes(tabKind));
    const recent = store.get("recentModels", []).filter(ok).map((id) => state.byId.get(id));
    const featured = [...new Set(Object.values(state.aliases))].filter(ok).map((id) => state.byId.get(id));
    if (recent.length) html += `<div class="ml-group">Recently used</div>` + recent.map(item).join("");
    if (featured.length) html += `<div class="ml-group">Featured</div>` + featured.map(item).join("");
    html += `<div class="ml-group">${tabKind === "all" ? "All models" : KINDS[tabKind].label + " models"} · ${list.length}</div>`;
  } else {
    html += `<div class="ml-group">${list.length} model${list.length === 1 ? "" : "s"}</div>`;
  }
  html += list.map(item).join("");
  if (!list.length && !html.includes("model-item")) html += '<div class="ml-empty">No models match. Tip: paste a full id like <code>openai/gpt-5.5</code>.</div>';
  el.innerHTML = html;
}

function moveModelHl(delta) {
  const items = $$("#modelList .model-item");
  if (!items.length) return;
  state.modelHl = (state.modelHl + delta + items.length) % items.length;
  items.forEach((b) => b.classList.toggle("hl", +b.dataset.idx === state.modelHl));
  items[state.modelHl].scrollIntoView({ block: "nearest" });
}

function selectModel(id, kind) {
  const m = modelInfo(id);
  const chat = state.chat;
  kind ||= m.modes.includes(kindOf(chat)) ? kindOf(chat) : m.modes[0];
  const recent = store.get("recentModels", []).filter((x) => x !== id);
  store.set("recentModels", [id, ...recent].slice(0, 5));
  const byKind = store.get("lastModelByKind", {});
  byKind[kind] = id;
  store.set("lastModelByKind", byKind);
  closeModal("modelModal");
  if (kind !== kindOf(chat)) return switchKind(kind, id);
  chat.model = id;
  rememberSettings();
  renderHeader();
  renderWorkspace();
  renderSettings();
  updateStats();
  saveChat();
  loadProviders();
  toast(`Model: ${shortName(m)}`);
}

/* ---------------------------------------------------------------------
   Settings changes
   --------------------------------------------------------------------- */

function rememberSettings() {
  if (kindOf(state.chat) === "chat") store.set("lastSettings", { model: state.chat.model, params: state.chat.params });
}

function setParam(key, value) {
  state.chat.params[key] = value;
  rememberSettings();
  saveChat();
  updateStats();
}

function bindSlider(rangeId, numId, key, min, max) {
  const range = $("#" + rangeId);
  const num = $("#" + numId);
  range.addEventListener("input", () => { num.value = range.value; setParam(key, Number(range.value)); });
  num.addEventListener("change", () => {
    const v = Math.min(max, Math.max(min, Number(num.value) || 0));
    num.value = v; range.value = v; setParam(key, v);
  });
}

/* ---------------------------------------------------------------------
   API key modal
   --------------------------------------------------------------------- */

function openKeyModal() {
  openModal("keyModal");
  $("#keyError").textContent = "";
  $("#keyInput").value = "";
  const k = state.keyInfo;
  const rows = [];
  if (k) {
    if (k.label) rows.push(["Key", esc(k.label)]);
    if (k.account?.total_credits != null) rows.push(["Credits left", fmtMoney(k.account.total_credits - k.account.total_usage)]);
    rows.push(["Used by this key", fmtMoney(k.usage)]);
    if (k.limit != null) rows.push(["Key limit", fmtMoney(k.limit)]);
  }
  $("#keyInfo").innerHTML = rows.map(([a, b]) => `<div><span class="muted">${a}</span><b>${b}</b></div>`).join("");
  $("#saveKeyBtn").textContent = k ? "Replace key" : "Save key";
  setTimeout(() => $("#keyInput").focus(), 30);
}

async function saveKey() {
  const key = $("#keyInput").value.trim();
  if (!key) { $("#keyError").textContent = "Please paste your key."; return; }
  const btn = $("#saveKeyBtn");
  if (btn.disabled) return; // already checking
  btn.disabled = true;
  btn.textContent = "Checking…";
  try {
    await api("/api/key", { method: "POST", body: { key } });
    closeModal("keyModal");
    toast("API key saved ✓");
    loadCredits();
  } catch (e) {
    $("#keyError").textContent = e.message;
  } finally {
    btn.disabled = false;
    btn.textContent = state.keyInfo ? "Replace key" : "Save key";
  }
}

/* ---------------------------------------------------------------------
   Get code / export
   --------------------------------------------------------------------- */

function py(v, ind = 0) {
  const pad = " ".repeat(ind);
  const pad2 = " ".repeat(ind + 4);
  if (v === null || v === undefined) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  if (typeof v === "number" || typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) {
    return v.length ? `[\n${v.map((x) => pad2 + py(x, ind + 4)).join(",\n")},\n${pad}]` : "[]";
  }
  const entries = Object.entries(v);
  return entries.length
    ? `{\n${entries.map(([k, x]) => `${pad2}${JSON.stringify(k)}: ${py(x, ind + 4)}`).join(",\n")},\n${pad}}`
    : "{}";
}

const PLACEHOLDER = {
  image_url: "<image URL or data:image/...;base64,...>",
  file: "<data:application/pdf;base64,...>",
  audio: "<base64 audio>",
  video: "<video URL or data:video/mp4;base64,...>",
};

function chatCode(lang) {
  const chat = state.chat;
  const info = modelInfo(chat.model);
  const messages = buildApiMessages(chat).map((m) => typeof m.content === "string" ? m : {
    role: m.role,
    content: m.content.map((p) => p.type === "text" ? p
      : p.type === "image_url" ? { type: "image_url", image_url: { url: PLACEHOLDER.image_url } }
      : p.type === "file" ? { type: "file", file: { filename: p.file.filename, file_data: PLACEHOLDER.file } }
      : p.type === "input_audio" ? { type: "input_audio", input_audio: { data: PLACEHOLDER.audio, format: p.input_audio.format } }
      : { type: "video_url", video_url: { url: PLACEHOLDER.video } }),
  });
  const draft = $("#input").value.trim();
  if (draft || !messages.some((m) => m.role === "user")) messages.push({ role: "user", content: draft || "Hello!" });
  const params = buildParams(chat, info);
  const body = { model: chat.model, messages, ...params };

  if (lang === "json") return JSON.stringify(body, null, 2);
  if (lang === "curl") return curlFor("v1/chat/completions", body);
  if (lang === "requests") return requestsFor("v1/chat/completions", body, '["choices"][0]["message"]["content"]');
  if (isStructuredChat(chat)) {
    const last = messages.filter((m) => m.role === "user").at(-1);
    const sys = messages.find((m) => m.role === "system")?.content;
    return `from openrouter_client import OpenRouterClient

client = OpenRouterClient()  # reads OPENROUTER_API_KEY from .env

schema = ${py(buildSchema(chat))}

result = client.ask_json(
    ${py(typeof last?.content === "string" ? last.content : "Your input here", 4)},
    schema,
    model=${JSON.stringify(chat.model)},${sys && jsonSupport(info) === "schema" ? `\n    system=${py(sys, 4)},` : ""}
)
print(result)  # a dict with your fields, already typed (bool, int, list, ...)
`;
  }
  const kwargs = Object.entries(params).map(([k, v]) => `\n    ${k}=${py(v, 4)},`).join("");
  return `from openrouter_client import OpenRouterClient

client = OpenRouterClient()  # reads OPENROUTER_API_KEY from .env

messages = ${py(messages)}

reply = client.chat(
    messages,
    model=${JSON.stringify(chat.model)},${kwargs}
)
print(reply)
`;
}

function curlFor(path, body) {
  return `curl https://openrouter.ai/api/${path} \\
  -H "Authorization: Bearer $OPENROUTER_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '${JSON.stringify(body, null, 2).replace(/'/g, "'\\''")}'`;
}

function requestsFor(path, body, pick) {
  return `import os
import requests

response = requests.post(
    "https://openrouter.ai/api/${path}",
    headers={"Authorization": f"Bearer {os.environ['OPENROUTER_API_KEY']}"},
    json=${py(body, 4)},
)
response.raise_for_status()
print(response.json()${pick})
`;
}

function showCode(lang) {
  $$("#codeTabs button").forEach((b) => b.classList.toggle("on", b.dataset.lang === lang));
  const kind = kindOf(state.chat);
  const code = kind === "chat" ? chatCode(lang) : kind === "extract" ? extractCode(lang) : taskCode(kind, lang);
  const out = $("#codeOut");
  out.textContent = code;
  out.className = "";
  if (window.hljs) {
    const hl = { wrapper: "python", requests: "python", curl: "bash", json: "json" }[lang];
    out.innerHTML = hljs.highlight(code, { language: hl }).value;
    out.classList.add("hljs");
  }
  $("#codeNote").textContent = lang === "wrapper"
    ? "Run this from the project folder, it uses openrouter_client.py."
    : "Set OPENROUTER_API_KEY in your environment first.";
}

function exportChat() {
  const c = state.chat;
  if (!c.messages.length) return toast("Nothing to export yet.");
  let md = `# ${c.title}\n\n`;
  if (c.system.trim()) md += `> **System instructions:** ${c.system.trim().replace(/\n/g, "\n> ")}\n\n`;
  for (const m of c.messages) {
    const who = m.role === "user" ? "You" : `${shortName(modelInfo(m.model || c.model))} (\`${m.model || c.model}\`)`;
    const files = (m.attachments || []).map((a) => `📎 ${a.name}`).join("  ");
    md += `## ${who}\n\n${files ? files + "\n\n" : ""}${m.role === "user" || (m.kind || "chat") === "chat" ? m.content : outputMarkdown(m)}\n\n`;
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([md], { type: "text/markdown" }));
  a.download = (c.title.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "").slice(0, 50) || "chat") + ".md";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/* ---------------------------------------------------------------------
   Modals, drawers, theme
   --------------------------------------------------------------------- */

function openModal(id) { $("#" + id).hidden = false; }
function closeModal(id) { $("#" + id).hidden = true; }

const isNarrow = () => window.matchMedia("(max-width: 1180px)").matches;

function toggleSettings() {
  const app = $("#app");
  if (isNarrow()) {
    app.classList.toggle("settings-open");
  } else {
    app.classList.toggle("settings-closed");
    store.set("settingsClosed", app.classList.contains("settings-closed"));
  }
}

function closeDrawers() { $("#app").classList.remove("sidebar-open", "settings-open"); }

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  $("#themeIcon").textContent = theme === "dark" ? "light_mode" : "dark_mode";
  $("#hljsTheme").href = `https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/${theme === "dark" ? "github-dark" : "github"}.min.css`;
}

/* ---------------------------------------------------------------------
   Events
   --------------------------------------------------------------------- */

function bindEvents() {
  // sidebar
  $("#newChatBtn").addEventListener("click", newChat);
  $("#chatSearch").addEventListener("input", renderChatList);
  $("#chatList").addEventListener("click", (e) => {
    const del = e.target.closest("[data-del]");
    if (del) { e.stopPropagation(); return deleteChat(del.dataset.del); }
    const item = e.target.closest(".chat-item");
    if (item) openChat(item.dataset.id);
  });
  $("#chatList").addEventListener("keydown", (e) => {
    const item = e.target.closest(".chat-item");
    if (item && e.key === "Enter") openChat(item.dataset.id);
  });
  $("#keyBtn").addEventListener("click", openKeyModal);
  $("#creditsBtn").addEventListener("click", openUsage);
  $("#usageRefreshBtn").addEventListener("click", openUsage);
  $("#changeKeyBtn").addEventListener("click", () => { closeModal("usageModal"); openKeyModal(); });
  $("#themeBtn").addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    applyTheme(next);
    try { localStorage.setItem("theme", next); } catch { /* ignore */ } // raw string: read by index.html
  });

  // top bar
  $("#menuBtn").addEventListener("click", () => $("#app").classList.toggle("sidebar-open"));
  $("#settingsBtn").addEventListener("click", toggleSettings);
  $("#closeSettingsBtn").addEventListener("click", toggleSettings);
  $("#scrim").addEventListener("click", closeDrawers);
  $("#modeSwitch").addEventListener("click", (e) => {
    const b = e.target.closest("[data-kind]");
    if (b && b.dataset.kind !== kindOf(state.chat)) switchKind(b.dataset.kind, state.chat.model);
  });
  $("#chatTitle").addEventListener("input", (e) => {
    state.chat.title = e.target.value || "Untitled";
    document.title = `${state.chat.title} · OpenRouter Studio`;
    saveChat();
  });
  $("#chatTitle").addEventListener("keydown", (e) => { if (e.key === "Enter") e.target.blur(); });
  $("#codeBtn").addEventListener("click", () => { openModal("codeModal"); showCode("wrapper"); });
  $("#codeTabs").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) showCode(b.dataset.lang); });
  $("#copyCodeBtn").addEventListener("click", () => { copyText($("#codeOut").textContent); toast("Code copied"); });
  $("#exportBtn").addEventListener("click", exportChat);

  // system instructions
  $("#systemInput").addEventListener("input", (e) => {
    state.chat.system = e.target.value;
    updateSystemPreview();
    updateStats();
    saveChat();
  });

  // empty state
  $("#emptyModelBtn").addEventListener("click", () => openModelPicker());
  $("#suggestions").addEventListener("click", (e) => {
    const b = e.target.closest("[data-sug]");
    if (!b) return;
    const s = viewOf(state.chat).suggestions[+b.dataset.sug];
    if (s.action) return s.action();
    const input = $("#input");
    input.value = s.text;
    autosize(input);
    input.focus();
    updateStats();
  });

  // messages
  $("#messages").addEventListener("click", (e) => {
    const copyBtn = e.target.closest("[data-copy-code]");
    if (copyBtn) {
      copyText($("pre", copyBtn.closest(".code-block")).innerText);
      copyBtn.innerHTML = '<span class="ms">check</span>Copied';
      setTimeout(() => { copyBtn.innerHTML = '<span class="ms">content_copy</span>Copy'; }, 1500);
      return;
    }
    if (e.target.closest(".thoughts summary")) { e.target.closest(".thoughts").dataset.touched = "1"; return; }
    const img = e.target.closest(".attach-thumb, .gallery img");
    if (img) return lightbox(img.src);
    if (handleOutputClick(e)) return; // modes.js (copy transcript, download vectors, …)
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const el = btn.closest(".msg");
    const m = state.chat.messages.find((x) => x.id === el.dataset.id);
    if (!m) return;
    switch (btn.dataset.act) {
      case "copy": copyText(copyTextFor(m)); toast("Copied"); break;
      case "edit": startEdit(el, m); break;
      case "rerun": rerun(m); break;
      case "delete":
        state.chat.messages = state.chat.messages.filter((x) => x !== m);
        renderMessages(); updateStats(); saveChat();
        break;
    }
  });

  // composer
  const input = $("#input");
  input.addEventListener("input", () => { autosize(input); updateStatsSoon(); });
  input.addEventListener("keydown", (e) => {
    const multiLine = kindOf(state.chat) === "embeddings";
    if (e.key === "Enter" && !e.isComposing && ((!e.shiftKey && !multiLine) || e.ctrlKey || e.metaKey)) { e.preventDefault(); onRun(); }
  });
  input.addEventListener("paste", (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) { e.preventDefault(); addFiles(files); }
  });
  $("#runBtn").addEventListener("click", onRun);
  $("#attachBtn").addEventListener("click", () => $("#fileInput").click());
  $("#micBtn").addEventListener("click", toggleRecording);
  $("#fileInput").addEventListener("change", (e) => { addFiles([...e.target.files]); e.target.value = ""; });
  $("#pending").addEventListener("click", (e) => {
    const b = e.target.closest("[data-remove]");
    if (b) { state.pending.splice(+b.dataset.remove, 1); renderPending(); updateStats(); }
  });
  $("#chipModelBtn").addEventListener("click", () => openModelPicker());

  // drag & drop files anywhere on the conversation
  const main = $(".main");
  const composer = $("#composer");
  let dragDepth = 0;
  main.addEventListener("dragenter", (e) => { if (e.dataTransfer?.types.includes("Files")) { dragDepth++; composer.classList.add("dragging"); } });
  main.addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; composer.classList.remove("dragging"); } });
  main.addEventListener("dragover", (e) => e.preventDefault());
  main.addEventListener("drop", (e) => {
    e.preventDefault();
    dragDepth = 0;
    composer.classList.remove("dragging");
    if (e.dataTransfer?.files.length) addFiles([...e.dataTransfer.files]);
  });

  // chat settings panel
  $("#modelBtn").addEventListener("click", () => openModelPicker());
  bindSlider("temperature", "temperatureNum", "temperature", 0, 2);
  bindSlider("topP", "topPNum", "top_p", 0, 1);
  $("#maxTokens").addEventListener("change", (e) => setParam("max_tokens", parseInt(e.target.value, 10) || null));
  $("#seed").addEventListener("change", (e) => setParam("seed", e.target.value === "" ? null : parseInt(e.target.value, 10)));
  $("#audioVoice").addEventListener("change", (e) => setParam("voice", e.target.value));
  $("#audioFormat").addEventListener("change", (e) => setParam("audioFormat", e.target.value));
  $("#reasoning").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    $$("#reasoning button").forEach((x) => x.classList.toggle("on", x === b));
    setParam("reasoning", b.dataset.v);
  });
  $("#stopInput").addEventListener("keydown", (e) => {
    const stops = state.chat.params.stop;
    if (e.key === "Enter" && e.target.value) {
      e.preventDefault();
      const v = e.target.value.replace(/\\n/g, "\n");
      if (stops.length >= 4) return toast("Up to 4 stop sequences.");
      if (!stops.includes(v)) setParam("stop", [...stops, v]);
      e.target.value = "";
      renderStops();
    } else if (e.key === "Backspace" && !e.target.value && stops.length) {
      setParam("stop", stops.slice(0, -1));
      renderStops();
    }
  });
  $("#stopChips").addEventListener("click", (e) => {
    const b = e.target.closest("[data-stop]");
    if (b) {
      setParam("stop", state.chat.params.stop.filter((_, i) => i !== +b.dataset.stop));
      renderStops();
    } else {
      $("#stopInput").focus();
    }
  });
  $("#resetBtn").addEventListener("click", () => {
    state.chat.params = { ...DEFAULT_PARAMS, stop: [] };
    state.chat.opts = {};
    rememberSettings();
    renderSettings();
    updateStats();
    saveChat();
    toast("Settings reset");
  });

  // model picker
  $("#kindTabs").addEventListener("click", (e) => {
    const b = e.target.closest("[data-kind]");
    if (!b) return;
    state.pickerKind = b.dataset.kind;
    state.modelHl = 0;
    renderKindTabs();
    renderModelList();
    $("#modelSearch").focus();
  });
  $("#modelSearch").addEventListener("input", () => { state.modelHl = 0; renderModelList(); });
  $("#modelSearch").addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); moveModelHl(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); moveModelHl(-1); }
    else if (e.key === "Enter") {
      e.preventDefault();
      const b = $(`#modelList .model-item[data-idx="${state.modelHl}"]`);
      if (b) selectModel(b.dataset.model, b.dataset.kind);
    }
  });
  $("#modelFilters").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    const f = b.dataset.f;
    if (state.modelFilters.has(f)) state.modelFilters.delete(f); else state.modelFilters.add(f);
    b.classList.toggle("on", state.modelFilters.has(f));
    state.modelHl = 0;
    renderModelList();
    $("#modelSearch").focus();
  });
  $("#modelSort").addEventListener("change", () => { state.modelHl = 0; renderModelList(); });
  $("#modelList").addEventListener("click", (e) => {
    const b = e.target.closest(".model-item");
    if (b) selectModel(b.dataset.model, b.dataset.kind);
  });

  // key modal
  $("#saveKeyBtn").addEventListener("click", saveKey);
  $("#keyInput").addEventListener("keydown", (e) => { if (e.key === "Enter") saveKey(); });

  // generic modal closing
  $$(".modal").forEach((modal) => {
    modal.addEventListener("mousedown", (e) => { if (e.target === modal) modal.hidden = true; });
    $$("[data-close]", modal).forEach((b) => b.addEventListener("click", () => { modal.hidden = true; }));
  });

  // keyboard shortcuts
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      const open = $$(".modal").find((m) => !m.hidden);
      if (open) { open.hidden = true; return; }
      document.querySelector(".lightbox")?.remove();
      closeDrawers();
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); openModelPicker(); }
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && document.activeElement?.id === "systemInput") { e.preventDefault(); onRun(); }
  });

  window.addEventListener("beforeunload", () => flushSave(true));
  bindModeEvents();    // modes.js
  bindStructureEvents(); // structured.js
  bindPricingEvents(); // pricing.js
}

let statsTimer;
const updateStatsSoon = () => { clearTimeout(statsTimer); statsTimer = setTimeout(updateStats, 250); };

/* ---------------------------------------------------------------------
   Start
   --------------------------------------------------------------------- */

async function init() {
  applyTheme(document.documentElement.dataset.theme || "dark");
  bindEvents();
  if (store.get("settingsClosed", false) && !isNarrow()) $("#app").classList.add("settings-closed");

  let status;
  try {
    status = await api("/api/status");
  } catch {
    toast("Can't reach the local server. Is app.py running?");
    return;
  }
  state.aliases = status.aliases || {};
  state.defaultModel = status.default_model;
  state.chat = newChatObject("chat");
  renderAll();
  await loadCatalog(); // pricing.js: live models + prices
  await loadChatList();

  const lastId = store.get("lastChat", null);
  if (lastId && state.chats.some((c) => c.id === lastId)) await openChat(lastId);

  if (status.has_key) loadCredits();
  else {
    $("#creditsText").textContent = "No API key yet";
    $("#creditsBtn").classList.add("warn");
    openKeyModal();
  }
  startPriceTimers(); // pricing.js
  $("#input").focus();
}

document.addEventListener("DOMContentLoaded", init);
