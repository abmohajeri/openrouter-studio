/* =====================================================================
   OpenRouter Studio — structured input & output
   · Input fields: named inputs (e.g. customer_tier, ticket); the composer
     becomes a form. Works with chat (structured), Decide and Extract.
   · Output structure: typed fields (boolean, number, choice, list, date…).
     Chat models get a strict JSON Schema; extraction models get typed
     fields; decision models (Jev) give typed values from probabilities.
   ===================================================================== */
"use strict";

const OUT_TYPES = {
  chat: { text: "Text", number: "Number", integer: "Whole number", boolean: "Yes / No (boolean)", choice: "Choice (one of)", list: "List of text", date: "Date" },
  extract: { text: "Text", number: "Number", date: "Date", time: "Time", datetime: "Date & time", duration: "Duration", list: "List", estimate: "Estimate (range)" },
};
// What each extraction model can return (from OpenRouter's Extractions docs); others get everything.
const EXTRACT_TYPES_BY_MODEL = {
  "inception/mercury-decide": ["text", "list"],
  "scaledown/extract": ["text", "list"],
  "levanto/sage-2": ["text", "number", "date", "time", "datetime", "duration", "list"],
};
const REFERENCE_DATE_MODELS = ["cloudflare/clairic"];
const DURATION_UNITS = ["seconds", "minutes", "hours", "days", "weeks", "months", "years"];

const field = (f) => ({ id: uid(), description: "", optional: false, options: [], ...structuredClone(f) });

const STRUCT_TEMPLATES = {
  triage: {
    label: "Support ticket triage",
    inputs: [{ key: "customer_tier" }, { key: "ticket", long: true }],
    values: { customer_tier: "enterprise", ticket: "My checkout page shows a blank screen after I click Pay. I have tried two browsers." },
    outputs: [
      { key: "summary", type: "text", description: "One-sentence summary of the problem" },
      { key: "is_bug", type: "boolean", description: "Is the customer reporting a software defect?" },
      { key: "team", type: "choice", options: ["payments", "frontend", "account", "other"], description: "Team that should own the ticket" },
      { key: "priority", type: "integer", description: "1 = can wait … 5 = blocking revenue" },
      { key: "tags", type: "list", description: "Short lowercase tags" },
    ],
  },
  contact: {
    label: "Contact details",
    sample: "Hello, this is Maria Lopez from Brightline Labs. Reach me at maria.lopez@example.com or +1 415 555 0134. Could we meet on 2026-11-18?",
    outputs: [
      { key: "name", type: "text" }, { key: "company", type: "text", optional: true },
      { key: "email", type: "text", optional: true }, { key: "phone", type: "text", optional: true },
      { key: "meeting_date", type: "date", optional: true, description: "Proposed meeting date" },
    ],
  },
  actions: {
    label: "Action items from notes (list)",
    many: true,
    sample: "Team sync: Ali will fix the login bug by Friday 2026-11-13. Sara prepares the Q4 report, due 2026-11-20. Someone should book the venue, not urgent.",
    outputs: [
      { key: "task", type: "text" }, { key: "owner", type: "text", optional: true },
      { key: "due_date", type: "date", optional: true }, { key: "urgent", type: "boolean" },
    ],
  },
  review: {
    label: "Product review",
    sample: "Battery easily lasts two days and the screen is gorgeous. Shipping took three weeks though, and the case scratches easily. Still, I'd buy it again.",
    outputs: [
      { key: "sentiment", type: "choice", options: ["positive", "mixed", "negative"] },
      { key: "stars", type: "integer", description: "Likely star rating from 1 to 5" },
      { key: "pros", type: "list" }, { key: "cons", type: "list" },
      { key: "would_recommend", type: "boolean" },
    ],
  },
};

const EXTRACT_TEMPLATES = {
  invoice: {
    label: "Invoice",
    sample: "Invoice INV-2291 issued 2026-09-02, net 30. Contacts: Dana Ruiz, Priya Shah. Total $1080.",
    outputs: [
      { key: "invoice_number", type: "text" },
      { key: "due_date", type: "date", description: "Issue date plus the net payment days" },
      { key: "total", type: "number", decimals: 2, unit: "USD" },
      { key: "contacts", type: "list", items: "text" },
      { key: "days_to_pay", type: "estimate", min: 0, max: 120 },
    ],
  },
  contact: {
    label: "Contact details",
    sample: "Hello, this is Maria Lopez from Brightline Labs. Reach me at maria.lopez@example.com or +1 415 555 0134. Could we meet on 2026-11-18 at 15:00?",
    outputs: [
      { key: "name", type: "text" }, { key: "email", type: "text" }, { key: "phone", type: "text" },
      { key: "meeting", type: "datetime" },
    ],
  },
  listing: {
    label: "Product listing",
    sample: "Aurora 2 desk lamp, now $49.90 (was $69). Ships in 3 to 5 days. Colors: black, sand, olive. Warranty: 2 years.",
    outputs: [
      { key: "price", type: "number", decimals: 2, unit: "USD" },
      { key: "colors", type: "list", items: "text" },
      { key: "warranty", type: "duration", unit: "years" },
      { key: "shipping_days", type: "estimate", min: 1, max: 14 },
    ],
  },
};

/* ---------------------------------------------------------------------
   Which chats use which structure
   --------------------------------------------------------------------- */

const isStructuredChat = (chat) => kindOf(chat) === "chat" && !!chat.structured;
const usesOutputs = (chat) => isStructuredChat(chat) || kindOf(chat) === "extract";
const supportsInputs = (chat) => isStructuredChat(chat) || ["decisions", "extract"].includes(kindOf(chat));
const usesInputFields = (chat) => supportsInputs(chat) && (chat.inputs || []).length > 0;

/** How a chat model can be asked for JSON: strict schema, JSON mode, or only by instructions. */
function jsonSupport(m) {
  const p = m.params || [];
  if (p.includes("structured_outputs")) return "schema";
  if (p.includes("response_format")) return "json";
  return "prompt";
}

function outTypesFor(chat) {
  if (kindOf(chat) !== "extract") return OUT_TYPES.chat;
  const allowed = EXTRACT_TYPES_BY_MODEL[chat.model];
  return Object.fromEntries(Object.entries(OUT_TYPES.extract).filter(([t]) => !allowed || allowed.includes(t)));
}

function loadStructTemplate(name) {
  const chat = state.chat;
  const kind = kindOf(chat);
  const t = (kind === "extract" ? EXTRACT_TEMPLATES : STRUCT_TEMPLATES)[name];
  if (!t) return;
  chat.outputs = t.outputs.map(field);
  if (kind !== "extract") chat.many = !!t.many;
  chat.inputs = (t.inputs || []).map((i) => ({ id: uid(), long: false, ...i }));
  chat.inputValues = {};
  for (const i of chat.inputs) chat.inputValues[i.id] = t.values?.[i.key] ?? "";
  if (t.sample && !chat.inputs.length && !$("#input").value.trim()) { $("#input").value = t.sample; autosize($("#input")); }
  renderStructure();
  renderSettings();
  saveChat();
  updateStats();
}

/* ---------------------------------------------------------------------
   Builders: output structure + input fields
   --------------------------------------------------------------------- */

function renderStructure() {
  const chat = state.chat;
  const outBox = $("#outputsBox");
  const inBox = $("#inputsBox");
  outBox.hidden = !usesOutputs(chat);
  inBox.hidden = !supportsInputs(chat);
  if (!outBox.hidden) renderOutputs();
  if (!inBox.hidden) renderInputs();
  renderFieldForm();
}

function renderOutputs() {
  const chat = state.chat;
  const kind = kindOf(chat);
  const types = outTypesFor(chat);
  const outs = chat.outputs || [];
  $("#outputsTitle").textContent = kind === "extract" ? "Fields to extract" : "Output structure";
  $("#outputsHelp").innerHTML = kind === "extract"
    ? "The model finds each field in your text (and attached images or PDFs) and returns a <b>typed value</b> with a confidence."
    : `The model must answer with JSON in exactly this shape: each field gets the type you choose (text, number, <b>boolean</b>, choice, list, date). ${chat.many ? "It returns a <b>list</b> of items." : ""}`;
  $("#outputList").innerHTML = outs.map((f, i) => {
    const typeOpts = Object.entries(types).map(([t, l]) => `<option value="${t}" ${f.type === t ? "selected" : ""}>${l}</option>`).join("")
      + (types[f.type] ? "" : `<option value="${esc(f.type)}" selected>${esc(f.type)} (not supported here)</option>`);
    let extra = "";
    if (f.type === "choice") {
      extra = `<div class="q-list">${(f.options || []).map((o, j) => `<div class="q-opt">
          <input data-opt-i="${j}" value="${esc(o)}" placeholder="option" spellcheck="false">
          <button class="icon-btn small" data-fact="del-opt" data-i="${j}" title="Remove"><span class="ms">close</span></button></div>`).join("")}
        <button class="ghost-btn small" data-fact="add-opt"><span class="ms">add</span>Add option</button></div>`;
    } else if (kind === "extract" && f.type === "number") {
      extra = `<div class="f-extra"><input data-f="unit" value="${esc(f.unit || "")}" placeholder="unit (e.g. USD)">
        <input data-f="decimals" type="number" min="0" max="6" value="${f.decimals ?? ""}" placeholder="decimals"></div>`;
    } else if (kind === "extract" && f.type === "duration") {
      extra = `<div class="f-extra"><select class="select" data-f="unit"><option value="">any unit</option>${DURATION_UNITS.map((u) => `<option ${f.unit === u ? "selected" : ""}>${u}</option>`).join("")}</select></div>`;
    } else if (kind === "extract" && f.type === "list") {
      extra = `<div class="f-extra"><span class="muted small">items are</span><select class="select" data-f="items">${["text", "number", "date"].map((t) => `<option ${(f.items || "text") === t ? "selected" : ""}>${t}</option>`).join("")}</select></div>`;
    } else if (kind === "extract" && f.type === "estimate") {
      extra = `<div class="f-extra"><input data-f="min" type="number" value="${f.min ?? ""}" placeholder="min">
        <input data-f="max" type="number" value="${f.max ?? ""}" placeholder="max"><input data-f="unit" value="${esc(f.unit || "")}" placeholder="unit"></div>`;
    }
    return `<div class="q-card" data-fid="${f.id}">
      <div class="q-top">
        <span class="q-num">${i + 1}</span>
        <input class="q-key" data-f="key" value="${esc(f.key)}" spellcheck="false" placeholder="field_name">
        <select class="select q-type" data-f="type">${typeOpts}</select>
        ${kind === "chat" ? `<label class="mini-toggle" title="Allow the model to return null"><input type="checkbox" data-f="optional" ${f.optional ? "checked" : ""}>optional</label>` : ""}
        <button class="icon-btn small" data-fact="del" title="Remove field"><span class="ms">delete</span></button>
      </div>
      <textarea class="q-instr" data-f="description" rows="1" dir="auto" placeholder="${kind === "extract" ? "Instructions (optional), e.g. “issue date plus the net payment days”" : "What goes here (optional, helps the model)"}">${esc(f.description || "")}</textarea>
      ${extra}
    </div>`;
  }).join("") || '<div class="muted q-empty">No fields yet. Add one or load a template.</div>';
  $$("#outputList .q-instr").forEach((ta) => autosize(ta, 160));
  $("#outputsPreview").textContent = outs.length ? `${outs.length} field${outs.length > 1 ? "s" : ""}${chat.many && kind === "chat" ? " · list" : ""}: ${outs.map((f) => f.key).join(", ")}` : "";
  const tplSel = $("#outputTemplate");
  const tpls = kind === "extract" ? EXTRACT_TEMPLATES : STRUCT_TEMPLATES;
  tplSel.innerHTML = '<option value="">Load a template…</option>' + Object.entries(tpls).map(([k, t]) => `<option value="${k}">${esc(t.label)}</option>`).join("");
  if (kind === "chat") {
    $("#schemaPreview").textContent = JSON.stringify(buildSchema(chat), null, 2);
    $("#schemaDetails").hidden = false;
  } else {
    $("#schemaDetails").hidden = true;
  }
}

function renderInputs() {
  const chat = state.chat;
  const ins = chat.inputs || [];
  $("#inputList").innerHTML = ins.map((f) => `
    <div class="in-row" data-iid="${f.id}">
      <span class="ms">input</span>
      <input class="q-key" data-i="key" value="${esc(f.key)}" spellcheck="false" placeholder="field_name">
      <label class="mini-toggle"><input type="checkbox" data-i="long" ${f.long ? "checked" : ""}>long text</label>
      <button class="icon-btn small" data-iact="del" title="Remove"><span class="ms">close</span></button>
    </div>`).join("");
  $("#inputsPreview").textContent = ins.length ? `${ins.length} field${ins.length > 1 ? "s" : ""}: ${ins.map((f) => f.key).join(", ")}` : "off: one text box";
  $("#inputsHelp").textContent = ins.length
    ? `The composer is now a form. ${kindOf(chat) === "decisions" ? "Jev gets them as a JSON object in its state." : kindOf(chat) === "extract" ? "They're sent as “name: value” lines." : "The model gets them as a JSON object."}`
    : "Optional: split your input into named fields (like customer_tier and ticket). The composer turns into a form.";
}

/** The composer becomes a form when the chat has input fields. */
function renderFieldForm() {
  const chat = state.chat;
  const active = usesInputFields(chat);
  $("#fieldForm").hidden = !active;
  $("#input").hidden = active;
  if (!active) return;
  chat.inputValues ||= {};
  $("#fieldForm").innerHTML = chat.inputs.map((f) => `
    <label class="ff-row"><span class="ff-key">${esc(f.key || "?")}</span>
      ${f.long ? `<textarea data-ff="${f.id}" rows="2" dir="auto" placeholder="${esc(f.key)}…">${esc(chat.inputValues[f.id] || "")}</textarea>`
        : `<input data-ff="${f.id}" dir="auto" value="${esc(chat.inputValues[f.id] || "")}" placeholder="${esc(f.key)}…">`}
    </label>`).join("");
}

/** {name: value} of the form, skipping empty values. */
function formValues(chat) {
  const out = {};
  for (const f of chat.inputs || []) {
    const v = (chat.inputValues?.[f.id] || "").trim();
    if (f.key.trim() && v) out[f.key.trim()] = v;
  }
  return out;
}

const fieldsAsLines = (fields) => Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join("\n");

function bindStructureEvents() {
  const cleanKey = (t) => { const c = t.value.replace(/\s+/g, "_").replace(/[^\p{L}\p{N}_-]/gu, ""); if (c !== t.value) t.value = c; return c; };
  const outs = $("#outputList");
  const findOut = (el) => (state.chat.outputs || []).find((f) => f.id === el.closest("[data-fid]")?.dataset.fid);
  const changed = (rerender) => { if (rerender) renderOutputs(); else { $("#schemaPreview").textContent = JSON.stringify(buildSchema(state.chat), null, 2); } saveChat(); updateStatsSoon(); };
  outs.addEventListener("input", (e) => {
    const f = findOut(e.target);
    if (!f) return;
    const t = e.target;
    if (t.dataset.optI !== undefined) f.options[+t.dataset.optI] = t.value;
    else if (t.dataset.f === "key") f.key = cleanKey(t);
    else if (t.dataset.f === "description") { f.description = t.value; autosize(t, 160); }
    else if (["unit", "decimals", "min", "max"].includes(t.dataset.f)) f[t.dataset.f] = t.type === "number" ? (t.value === "" ? undefined : Number(t.value)) : t.value;
    else return;
    changed(false);
  });
  outs.addEventListener("change", (e) => {
    const f = findOut(e.target);
    if (!f) return;
    const t = e.target;
    if (t.dataset.f === "type") {
      f.type = t.value;
      if (f.type === "choice" && !f.options.length) f.options = ["", ""];
      changed(true);
    } else if (t.dataset.f === "optional") { f.optional = t.checked; changed(false); }
    else if (t.dataset.f === "items" || (t.tagName === "SELECT" && t.dataset.f === "unit")) { f[t.dataset.f] = t.value || undefined; changed(false); }
  });
  outs.addEventListener("click", (e) => {
    const b = e.target.closest("[data-fact]");
    const f = b && findOut(b);
    if (!f) return;
    if (b.dataset.fact === "del") state.chat.outputs = state.chat.outputs.filter((x) => x !== f);
    if (b.dataset.fact === "add-opt") f.options.push("");
    if (b.dataset.fact === "del-opt") f.options.splice(+b.dataset.i, 1);
    changed(true);
  });
  $("#addOutputBtn").addEventListener("click", () => {
    const chat = state.chat;
    chat.outputs ||= [];
    chat.outputs.push(field({ key: `field_${chat.outputs.length + 1}`, type: "text" }));
    changed(true);
    $("#outputList .q-card:last-child .q-key")?.select();
  });
  $("#outputTemplate").addEventListener("change", (e) => {
    const v = e.target.value;
    e.target.value = "";
    if (v && (!(state.chat.outputs || []).length || confirm("Replace the current fields with this template?"))) loadStructTemplate(v);
  });
  $("#copySchemaBtn").addEventListener("click", (e) => { e.preventDefault(); copyText($("#schemaPreview").textContent); toast("JSON Schema copied"); });

  const ins = $("#inputList");
  const findIn = (el) => (state.chat.inputs || []).find((f) => f.id === el.closest("[data-iid]")?.dataset.iid);
  ins.addEventListener("input", (e) => {
    const f = findIn(e.target);
    if (!f || e.target.dataset.i !== "key") return;
    f.key = cleanKey(e.target);
    renderFieldForm();
    $("#inputsPreview").textContent = `${state.chat.inputs.length} fields: ${state.chat.inputs.map((x) => x.key).join(", ")}`;
    saveChat();
  });
  ins.addEventListener("change", (e) => {
    const f = findIn(e.target);
    if (!f || e.target.dataset.i !== "long") return;
    f.long = e.target.checked;
    renderFieldForm();
    saveChat();
  });
  ins.addEventListener("click", (e) => {
    const b = e.target.closest("[data-iact]");
    const f = b && findIn(b);
    if (!f) return;
    state.chat.inputs = state.chat.inputs.filter((x) => x !== f);
    renderInputs(); renderFieldForm(); saveChat(); updateStats();
  });
  $("#addInputBtn").addEventListener("click", () => {
    const chat = state.chat;
    chat.inputs ||= [];
    const first = !chat.inputs.length;
    chat.inputs.push({ id: uid(), key: first ? "text" : `field_${chat.inputs.length + 1}`, long: first });
    if (first && $("#input").value.trim()) { chat.inputValues = { [chat.inputs[0].id]: $("#input").value.trim() }; $("#input").value = ""; }
    renderInputs(); renderFieldForm(); saveChat();
    $("#inputList .in-row:last-child .q-key")?.select();
  });

  const form = $("#fieldForm");
  form.addEventListener("input", (e) => {
    const id = e.target.dataset.ff;
    if (!id) return;
    state.chat.inputValues[id] = e.target.value;
    if (e.target.tagName === "TEXTAREA") autosize(e.target, 200);
    saveChatSoon();
    updateStatsSoon();
  });
  form.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.isComposing) return;
    if (e.target.tagName === "INPUT" || e.ctrlKey || e.metaKey) { e.preventDefault(); onRun(); }
  });

  const setStructured = (on) => {
    const chat = state.chat;
    chat.structured = on;
    // start from an example structure; templates from the empty state also add input fields
    if (on && !(chat.outputs || []).length) chat.outputs = STRUCT_TEMPLATES.triage.outputs.map(field);
    renderWorkspace(); renderSettings(); saveChat(); updateStats();
    if (on) toast("Structured output on: the model answers with typed JSON in your output structure.");
  };
  $("#structuredToggle").addEventListener("change", (e) => setStructured(e.target.checked));
  $("#structChip").addEventListener("click", () => setStructured(!state.chat.structured));
  $("#manyToggle").addEventListener("change", (e) => { state.chat.many = e.target.checked; renderOutputs(); saveChat(); });
}

let saveSoonTimer;
const saveChatSoon = () => { clearTimeout(saveSoonTimer); saveSoonTimer = setTimeout(() => saveChat(), 600); };

/* ---------------------------------------------------------------------
   Chat models: JSON Schema, parsing, checking
   --------------------------------------------------------------------- */

function fieldSchema(f) {
  let s;
  switch (f.type) {
    case "number": s = { type: "number" }; break;
    case "integer": s = { type: "integer" }; break;
    case "boolean": s = { type: "boolean" }; break;
    case "choice": s = { type: "string", enum: (f.options || []).map((o) => o.trim()).filter(Boolean) }; break;
    case "list": s = { type: "array", items: { type: "string" } }; break;
    default: s = { type: "string" };
  }
  const desc = [f.description?.trim(), f.type === "date" ? "Date as YYYY-MM-DD" : ""].filter(Boolean).join(". ");
  if (desc) s.description = desc;
  if (f.optional) {
    s.type = [s.type, "null"];
    if (s.enum) s.enum = [...s.enum, null];
  }
  return s;
}

/** Strict JSON Schema for the output structure (all fields required; optional ones may be null). */
function buildSchema(chat) {
  const outs = (chat.outputs || []).filter((f) => f.key.trim());
  const obj = {
    type: "object",
    properties: Object.fromEntries(outs.map((f) => [f.key.trim(), fieldSchema(f)])),
    required: outs.map((f) => f.key.trim()),
    additionalProperties: false,
  };
  return chat.many
    ? { type: "object", properties: { items: { type: "array", items: obj } }, required: ["items"], additionalProperties: false }
    : obj;
}

/** Extra request parameters for a structured chat run. */
function structuredParams(chat, m) {
  const how = jsonSupport(m);
  if (how === "schema") {
    return {
      response_format: { type: "json_schema", json_schema: { name: "result", strict: true, schema: buildSchema(chat) } },
      provider: { require_parameters: true }, // only route to providers that enforce the schema
    };
  }
  return how === "json" ? { response_format: { type: "json_object" } } : {};
}

/** For models without strict schemas, the shape is described in the system message instead. */
function schemaInstruction(chat, m) {
  if (jsonSupport(m) === "schema") return "";
  return `Reply with only a JSON object (no prose, no code fences) that matches this JSON Schema exactly:\n${JSON.stringify(buildSchema(chat))}`;
}

function parseJsonReply(text) {
  let t = (text || "").trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  const tries = [t];
  const starts = [t.indexOf("{"), t.indexOf("[")].filter((i) => i >= 0);
  const start = starts.length ? Math.min(...starts) : -1;
  const end = Math.max(t.lastIndexOf("}"), t.lastIndexOf("]"));
  if (start >= 0 && end > start) {
    const inner = t.slice(start, end + 1);
    tries.push(inner, inner.replace(/,\s*([}\]])/g, "$1"));
  }
  for (const x of tries) { try { return JSON.parse(x); } catch { /* next */ } }
  throw new Error("The reply isn't valid JSON.");
}

function checkValue(v, f) {
  if (v === null || v === undefined) return f.optional ? null : "is missing";
  const ok = {
    text: typeof v === "string",
    date: typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v),
    number: typeof v === "number",
    integer: Number.isInteger(v),
    boolean: typeof v === "boolean",
    choice: typeof v === "string" && (f.options || []).map((o) => o.trim()).includes(v),
    list: Array.isArray(v),
  }[f.type];
  return ok === false ? `should be ${OUT_TYPES.chat[f.type].toLowerCase()}` : null;
}

/** Parse + check a finished structured reply; stores {data, error, issues} on the message. */
function finishStructured(msg) {
  try {
    let data = parseJsonReply(msg.content);
    if (msg.schema.many && data && !Array.isArray(data)) data = Array.isArray(data.items) ? data.items : [data];
    const rows = msg.schema.many ? data : [data];
    const issues = [];
    rows.forEach((row, i) => {
      if (!row || typeof row !== "object") { issues.push(`${msg.schema.many ? `item ${i + 1}` : "reply"} is not an object`); return; }
      for (const f of msg.schema.outputs) {
        const problem = checkValue(row[f.key], f);
        if (problem) issues.push(`${msg.schema.many ? `item ${i + 1} · ` : ""}${f.key} ${problem}`);
      }
    });
    msg.structured = { data, issues };
  } catch (e) {
    msg.structured = { error: e.message };
  }
}

/* ---------------------------------------------------------------------
   Showing typed results
   --------------------------------------------------------------------- */

function typedValue(v, type) {
  if (v === null || v === undefined) return '<span class="nullv">null</span>';
  if (typeof v === "boolean") return `<span class="boolv ${v}"><span class="ms">${v ? "check_circle" : "cancel"}</span>${v}</span>`;
  if (typeof v === "number") return `<span class="numv">${v.toLocaleString("en-US", { maximumFractionDigits: 6 })}</span>`;
  if (Array.isArray(v)) return v.length ? v.map((x) => `<span class="chipv" dir="auto">${esc(typeof x === "object" ? JSON.stringify(x) : x)}</span>`).join("") : '<span class="nullv">[ ]</span>';
  if (typeof v === "object") return `<code>${esc(JSON.stringify(v))}</code>`;
  if (type === "choice") return `<span class="choicev">${esc(v)}</span>`;
  if (["date", "time", "datetime"].includes(type)) return `<span class="datev"><span class="ms">event</span>${esc(v)}</span>`;
  return `<span class="textv" dir="auto">${esc(v)}</span>`;
}

function typeBadge(type, kind = "chat") {
  return `<span class="type-badge">${esc(((kind === "extract" ? OUT_TYPES.extract : OUT_TYPES.chat)[type] || type).replace(" (boolean)", "").replace(" (one of)", ""))}</span>`;
}

function resultToolbar(extraBtns = "") {
  return `<div class="struct-actions">
    <button class="ghost-btn small" data-out="copy-json"><span class="ms">content_copy</span>Copy JSON</button>
    <button class="ghost-btn small" data-out="download-json"><span class="ms">download</span>JSON</button>
    <button class="ghost-btn small" data-out="download-csv"><span class="ms">table_view</span>CSV</button>${extraBtns}</div>`;
}

function renderStructuredChat(m) {
  const s = m.structured;
  const outs = m.schema.outputs;
  if (!s || s.error) {
    return `<div class="struct-error"><span class="ms">data_alert</span>${esc(s?.error || "No JSON yet.")}</div>
      <pre class="json-stream">${esc(m.content)}</pre>`;
  }
  const status = s.issues.length
    ? `<span class="tag warnt"><span class="ms">warning</span>${s.issues.length} problem${s.issues.length > 1 ? "s" : ""}</span>`
    : '<span class="tag okt"><span class="ms">verified</span>matches the structure</span>';
  let body;
  if (m.schema.many) {
    body = `<div class="struct-table-wrap"><table class="struct-table">
      <tr><th>#</th>${outs.map((f) => `<th>${esc(f.key)}${typeBadge(f.type)}</th>`).join("")}</tr>
      ${(s.data || []).map((row, i) => `<tr><td class="muted">${i + 1}</td>${outs.map((f) => `<td>${typedValue(row?.[f.key], f.type)}</td>`).join("")}</tr>`).join("")}
    </table></div><div class="muted small">${(s.data || []).length} item${(s.data || []).length === 1 ? "" : "s"}</div>`;
  } else {
    body = `<div class="kv">${outs.map((f) => `<div class="kv-row"><span class="kv-key">${esc(f.key)}${typeBadge(f.type)}</span>
      <span class="kv-val">${typedValue(s.data?.[f.key], f.type)}</span></div>`).join("")}</div>`;
  }
  return `<div class="struct"><div class="struct-head"><span class="tag"><span class="ms">data_object</span>Structured output</span>${status}${resultToolbar()}</div>
    ${body}
    ${s.issues.length ? `<ul class="issues">${s.issues.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
    <details class="raw-json"><summary>Raw JSON</summary><pre>${esc(JSON.stringify(s.data, null, 2))}</pre></details></div>`;
}

/** Decision answers as plain typed values: booleans, choices, scores, boxes. */
function decisionTyped(m) {
  const th = (state.chat.opts?.threshold ?? 50) / 100;
  const out = {};
  for (const [k, a] of Object.entries(m.answers || {})) {
    if (a.type === "noul") out[k] = a.noul >= th;
    else if (a.type === "choice") out[k] = a.choice;
    else if (a.type === "score") out[k] = +(+a.score).toFixed(2);
    else if (a.type === "box") out[k] = a.box;
    else out[k] = null;
  }
  return out;
}

/** The typed value each message stands for (used by copy / JSON / CSV). */
function typedResult(m) {
  if (m.kind === "decisions") return decisionTyped(m);
  if (m.kind === "extract") return Object.fromEntries(Object.entries(m.answers || {}).map(([k, a]) => [k, a.value ?? null]));
  if (m.structured && !m.structured.error) return m.structured.data;
  return null;
}

function toCSV(data) {
  const rows = Array.isArray(data) ? data : [data];
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r || {})))];
  const cell = (v) => {
    const s = v === null || v === undefined ? "" : Array.isArray(v) ? v.join("; ") : typeof v === "object" ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(","), ...rows.map((r) => cols.map((c) => cell(r?.[c])).join(","))].join("\n");
}

function download(name, text, type) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/** Copy / JSON / CSV buttons on structured results. Returns true when handled. */
function handleStructuredClick(b, m) {
  const data = typedResult(m);
  if (data == null) return false;
  const json = JSON.stringify(data, null, 2);
  if (b.dataset.out === "copy-json") { copyText(json); toast("Copied as JSON"); }
  else if (b.dataset.out === "download-json") download("result.json", json, "application/json");
  else if (b.dataset.out === "download-csv") download("result.csv", toCSV(data), "text/csv");
  else return false;
  return true;
}

/* ---------------------------------------------------------------------
   Extract mode (extraction models: typed fields with confidence)
   --------------------------------------------------------------------- */

KINDS.extract = {
  label: "Extract", icon: "table_view", run: "Extract", runIcon: "manage_search", busy: "Extracting…",
  placeholder: "Paste the text to pull fields out of…",
  needInput: "Paste some text first.",
  title: "Pull typed fields out of text",
  text: "Extraction models read text (and images or PDFs) and return typed fields: text, numbers, dates, lists and estimates, each with a confidence. Build your fields above or load a template.",
  validate: (text, atts, chat) => {
    const outs = chat.outputs || [];
    if (!outs.length) return "Add at least one field to extract.";
    const keys = new Set();
    for (const f of outs) {
      if (!f.key.trim()) return "Every field needs a name.";
      if (keys.has(f.key)) return `Two fields are named “${f.key}”.`;
      keys.add(f.key);
      if (f.type === "estimate" && (f.min == null || f.max == null)) return `“${f.key}” needs a min and max.`;
      if (!outTypesFor(chat)[f.type]) return `This model can't return “${f.type}” fields (“${f.key}”).`;
    }
    if (!text && !atts.length && !usesInputFields(chat)) return "Paste some text first.";
    return null;
  },
  suggestions: Object.entries(EXTRACT_TEMPLATES).map(([k, t]) => ({
    icon: { invoice: "receipt_long", contact: "contact_mail", listing: "sell" }[k] || "table_view",
    label: `Try: ${t.label.toLowerCase()}`,
    action: () => { $("#input").value = ""; loadStructTemplate(k); $("#input").value = t.sample; autosize($("#input")); updateStats(); },
  })),
};
MODALITY.extract = { icon: "table_view", label: "Fields" };
MODALITY.json = { icon: "data_object", label: "JSON" };

function extractFieldsToApi(outs) {
  const out = {};
  for (const f of outs) {
    const item = { type: f.type };
    if (f.description?.trim()) item.instructions = f.description.trim();
    if (f.type === "number") {
      if (f.unit) item.unit = f.unit;
      if (f.decimals != null && f.decimals !== "") item.decimals = Number(f.decimals);
    }
    if (f.type === "duration" && f.unit) item.unit = f.unit;
    if (f.type === "list") item.items = f.items || "text";
    if (f.type === "estimate") {
      item.min = Number(f.min);
      item.max = Number(f.max);
      if (f.unit) item.unit = f.unit;
    }
    out[f.key.trim()] = item;
  }
  return out;
}

function buildExtractRequest(user, chat) {
  let text = user.fields ? fieldsAsLines(user.fields) : user.content || "";
  const assets = {};
  const count = { image: 0, pdf: 0 };
  for (const a of user.attachments || []) {
    if (a.kind !== "image" && a.kind !== "pdf") continue;
    const key = `${a.kind === "pdf" ? "document" : "image"}_${++count[a.kind]}`;
    const [head, b64] = a.data.split(",");
    assets[key] = { type: a.kind === "pdf" ? "document" : "image", format: a.kind === "pdf" ? "pdf" : head.includes("png") ? "png" : "jpg", data_base64: b64 };
  }
  const keys = Object.keys(assets);
  // every asset has to be named in the state text
  if (keys.length) text = text ? `${text}\n\nAttached: ${keys.join(", ")}` : keys.length === 1 ? keys[0] : `Attached: ${keys.join(", ")}`;
  const body = { model: chat.model, state: text, fields: extractFieldsToApi(chat.outputs) };
  if (keys.length) body.assets = assets;
  const hasDates = chat.outputs.some((f) => ["date", "datetime", "estimate"].includes(f.type));
  if (REFERENCE_DATE_MODELS.includes(chat.model) && hasDates) body.reference_date = chat.opts.reference_date || new Date().toISOString().slice(0, 10);
  return body;
}

TASKS.extract = async (msg, user, chat, m, signal) => {
  const body = buildExtractRequest(user, chat);
  msg.outputs = structuredClone(chat.outputs);
  msg.stateText = user.fields ? fieldsAsLines(user.fields) : user.content || "";
  const res = await api("/api/extract", { method: "POST", signal, body });
  msg.answers = res.answers || {};
  msg.truncated = !!res.truncated;
  msg.meta.usage = res.usage;
  msg.meta.seconds = res.seconds;
};

/** Input text with the parts each field came from highlighted (spans are in code points). */
function highlightSpans(text, answers, keys) {
  const chars = Array.from(text || "");
  const marks = [];
  keys.forEach((k, i) => {
    const a = answers[k] || {};
    for (const sp of [a.span, ...(a.spans || [])]) if (Array.isArray(sp) && sp[1] > sp[0]) marks.push({ s: sp[0], e: sp[1], i, k });
  });
  if (!marks.length) return "";
  marks.sort((a, b) => a.s - b.s);
  let html = "";
  let pos = 0;
  for (const mk of marks) {
    if (mk.s < pos) continue; // skip overlaps
    html += esc(chars.slice(pos, mk.s).join(""));
    html += `<mark class="hl c${mk.i % 6}" title="${esc(mk.k)}">${esc(chars.slice(mk.s, mk.e).join(""))}</mark>`;
    pos = mk.e;
  }
  return `<div class="hl-text" dir="auto">${html}${esc(chars.slice(pos).join(""))}</div>`;
}

function renderExtract(m) {
  if (!m.answers) return "";
  const outs = m.outputs || [];
  const keys = Object.keys(m.answers);
  const rows = keys.map((k, i) => {
    const a = m.answers[k];
    const f = outs.find((x) => x.key === k) || { type: a.type };
    let val;
    if (a.value === null || a.value === undefined) {
      val = `<span class="nullv">not found</span>${a.guess != null ? `<span class="muted small"> · best guess ${esc(Array.isArray(a.guess) ? a.guess.join(", ") : a.guess)}</span>` : ""}`;
    } else if (a.type === "estimate" || f.type === "estimate") {
      val = `${typedValue(a.value, "number")}${f.unit ? ` <span class="muted">${esc(f.unit)}</span>` : ""}
        ${a.p10 != null ? `<span class="muted small"> · likely ${esc(a.p10)}–${esc(a.p90)}</span>` : ""}${a.mean != null ? `<span class="muted small"> · mean ${(+a.mean).toFixed(1)}</span>` : ""}`;
    } else {
      val = typedValue(a.value, f.type) + (f.unit && typeof a.value === "number" ? ` <span class="muted">${esc(f.unit)}</span>` : "") +
        (a.unit && a.type === "duration" ? ` <span class="muted">${esc(a.unit)}</span>` : "");
    }
    const conf = a.confidence ?? (a.p_null != null ? 1 - a.p_null : null);
    return `<div class="kv-row"><span class="kv-key"><i class="dot c${i % 6}"></i>${esc(k)}${typeBadge(f.type, "extract")}</span>
      <span class="kv-val">${val}</span>
      ${conf != null ? `<span class="kv-conf" title="Confidence"><span class="mini-bar"><i style="width:${Math.round(conf * 100)}%"></i></span>${Math.round(conf * 100)}%</span>` : ""}</div>`;
  }).join("");
  return `<div class="struct"><div class="struct-head"><span class="tag"><span class="ms">table_view</span>Extracted fields</span>
      ${m.truncated ? '<span class="tag warnt"><span class="ms">content_cut</span>input was truncated</span>' : ""}${resultToolbar()}</div>
    <div class="kv conf">${rows}</div>
    ${highlightSpans(m.stateText, m.answers, keys)}</div>`;
}

function renderExtractSettings(chat, m) {
  let html = `<div class="field-note boxed"><span class="ms">table_view</span>Edit the fields at the top of the conversation.
    ${EXTRACT_TYPES_BY_MODEL[m.id] ? `This model returns: ${EXTRACT_TYPES_BY_MODEL[m.id].join(", ")}.` : "This model supports every field type."}</div>`;
  if (REFERENCE_DATE_MODELS.includes(m.id)) {
    html += `<div class="field"><label>Reference date</label>
      <input class="text-input" type="date" data-opt="reference_date" data-type="text" value="${esc(chat.opts.reference_date || new Date().toISOString().slice(0, 10))}">
      <div class="field-note">“Today” for relative dates like “net 30” or “next Tuesday”.</div></div>`;
  }
  return html;
}

function extractCode(lang) {
  const chat = state.chat;
  const user = lastInput();
  const sample = user.content || Object.values(EXTRACT_TEMPLATES)[0].sample;
  const body = buildExtractRequest({ content: sample, attachments: [] }, chat);
  if (lang === "json") return JSON.stringify(body, null, 2);
  if (lang === "curl") return curlFor("alpha/extractions", body);
  if (lang === "requests") return requestsFor("alpha/extractions", body, '["answers"]');
  return `from openrouter_client import OpenRouterClient

client = OpenRouterClient()  # reads OPENROUTER_API_KEY from .env

result = client.extract(
    state=${py(body.state, 4)},
    fields=${py(body.fields, 4)},
    model=${JSON.stringify(chat.model)},${body.reference_date ? `\n    reference_date=${JSON.stringify(body.reference_date)},` : ""}
)
for name, answer in result["answers"].items():
    print(name, answer.get("value"), answer.get("confidence"))
`;
}

/** The empty state and suggestions for chat with structured output on. */
const STRUCT_CHAT_VIEW = {
  ...KINDS.chat,
  placeholder: "Paste the text to analyze…",
  title: "Get typed, structured answers",
  text: "Define the output structure above: text, numbers, booleans, choices, lists, dates. The model has to answer with JSON in exactly that shape, and you get a typed result to copy as JSON or CSV.",
  suggestions: Object.entries(STRUCT_TEMPLATES).map(([k, t]) => ({
    icon: { triage: "support_agent", contact: "contact_mail", actions: "checklist", review: "reviews" }[k] || "data_object",
    label: `Try: ${t.label.toLowerCase()}`,
    action: () => { $("#input").value = ""; loadStructTemplate(k); },
  })),
};
