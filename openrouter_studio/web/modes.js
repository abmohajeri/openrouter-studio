/* =====================================================================
   OpenRouter Studio — model types beyond chat
   Each mode has its own input (composer, attachments, settings) and its
   own output (answers with probabilities, images, audio, video, text,
   similarity maps), matching what the model actually takes and returns.
   ===================================================================== */
"use strict";

const SAMPLE_SENTENCES = "I love programming in Python\nPython is my favourite language\nThe weather is sunny today\nIt is raining outside";

const KINDS = {
  chat: {
    label: "Chat", icon: "chat", run: "Run", runIcon: "arrow_upward", busy: "Thinking…",
    placeholder: "Type something…",
    title: "What can I help you build?",
    text: "Chat with GPT, Gemini, Claude, DeepSeek, Grok and hundreds more. Attach whatever the model can read.",
  },
  image: {
    label: "Image", icon: "image", run: "Generate", runIcon: "auto_awesome", busy: "Generating image…",
    placeholder: "Describe the image you want…",
    needInput: "Describe the image first.",
    title: "Create an image",
    text: "Describe what you want. If the model takes images as input, attach references to edit or restyle them.",
    validate: (text) => (!text ? "Describe the image first." : null),
  },
  video: {
    label: "Video", icon: "movie", run: "Generate", runIcon: "auto_awesome", busy: "Submitting video job…",
    placeholder: "Describe the video scene…",
    title: "Generate a video",
    text: "Describe a scene. Attach an image to use it as the first frame (and a second one as the last frame). Jobs run in the background and usually take 30 seconds to a few minutes.",
    validate: (text) => (!text ? "Describe the video first." : null),
  },
  speech: {
    label: "Speech", icon: "record_voice_over", run: "Speak", runIcon: "volume_up", busy: "Synthesizing speech…",
    placeholder: "Type the text to turn into speech…",
    title: "Turn text into speech",
    text: "Type the text, pick a voice in Run settings, and get an audio file you can play or download.",
    validate: (text) => (!text ? "Type the text to speak first." : null),
  },
  transcription: {
    label: "Transcribe", icon: "subtitles", run: "Transcribe", runIcon: "subtitles", busy: "Transcribing…",
    placeholder: "Attach or record audio, then press Transcribe",
    needInput: "Attach or record audio first.",
    title: "Transcribe audio",
    text: "Record from your microphone or upload an audio file and get the text back. Turn on timestamps in Run settings for segments.",
    validate: (text, atts) => (!atts.some((a) => a.kind === "audio") ? "Attach or record audio first." : null),
  },
  decisions: {
    label: "Decide", icon: "rule", run: "Decide", runIcon: "bolt", busy: "Deciding…",
    placeholder: "Paste the item to judge…",
    needInput: "Paste an item to judge first.",
    title: "Ask a decision model",
    text: "Decision models like Jev don't write text. They read your item and answer your questions with probabilities. That makes them fast, cheap and easy to use in code.",
    validate: validateDecision,
  },
  embeddings: {
    label: "Embed", icon: "scatter_plot", run: "Embed", runIcon: "scatter_plot", busy: "Embedding…",
    placeholder: "One text per line…",
    title: "Compare texts with embeddings",
    text: "Put one text per line. You get a vector for each line and a map of how similar they are.",
    validate: (text) => (!text.trim() ? "Add at least one line of text." : null),
  },
};

/* ---------------------------------------------------------------------
   Decisions: questions builder
   --------------------------------------------------------------------- */

const Q_TYPES = {
  noul: { label: "Yes / No", hint: "Answered with the probability that the answer is yes." },
  choice: { label: "Pick one", hint: "Picks exactly one option, with a probability for each." },
  score: { label: "Score", hint: "Places the item on your scale, from the first level (lowest) to the last." },
  box: { label: "Find in image", hint: "Draws a box around what you describe in the attached image (Jev 1.14+)." },
};

const TEMPLATES = {
  triage: {
    label: "Support ticket triage",
    sample: "My checkout page shows a blank screen after I click Pay. I have tried two browsers.",
    questions: [
      { key: "is_bug", type: "noul", instructions: "Is the customer reporting a software defect?" },
      { key: "team", type: "choice", instructions: "Which team should own this ticket?", options: [
        { name: "payments", desc: "Checkout, billing, or payment processing issues." },
        { name: "frontend", desc: "Rendering, layout, or browser compatibility issues." },
        { name: "account", desc: "Login, permissions, or profile issues." }] },
      { key: "urgency", type: "score", instructions: "How urgent is this ticket?", levels: [
        "Can wait for the next release", "Should be fixed this week", "Blocking revenue right now"] },
    ],
  },
  sentiment: {
    label: "Review sentiment",
    sample: "The battery lasts two days and the screen is gorgeous, but it arrived late and the box was damaged.",
    questions: [
      { key: "sentiment", type: "choice", instructions: "What is the overall sentiment of the review?", options: [
        { name: "positive", desc: "" }, { name: "mixed", desc: "" }, { name: "negative", desc: "" }] },
      { key: "complains_shipping", type: "noul", instructions: "Does the review complain about delivery or shipping?" },
      { key: "stars", type: "score", instructions: "How many stars would this reviewer most likely give?", levels: ["1 star", "2 stars", "3 stars", "4 stars", "5 stars"] },
    ],
  },
  moderation: {
    label: "Content moderation",
    sample: "Check out my new crypto course!!! DM me now to get 10x returns, guaranteed.",
    questions: [
      { key: "spam", type: "noul", instructions: "Is the post spam or unsolicited advertising?" },
      { key: "scam", type: "noul", instructions: "Does the post make a financial promise that is likely a scam?" },
      { key: "toxic", type: "noul", instructions: "Is the post insulting, hateful, or harassing?" },
    ],
  },
  photo: {
    label: "Find something in a photo",
    sample: "Product photo from the listing:",
    questions: [
      { key: "product", type: "box", instructions: "the main product in the photo" },
      { key: "has_people", type: "noul", instructions: "Are there people visible in the photo?" },
    ],
  },
};

const withIds = (qs) => qs.map((q) => ({ id: uid(), options: [], levels: [], instructions: "", ...structuredClone(q) }));
function defaultQuestions() { return withIds(TEMPLATES.triage.questions); }

function loadTemplate(name, fillSample = false) {
  const t = TEMPLATES[name];
  if (!t) return;
  state.chat.questions = withIds(t.questions);
  renderQuestions();
  $("#questionsBox").open = true;
  if (fillSample && !$("#input").value.trim()) {
    $("#input").value = t.sample;
    autosize($("#input"));
  }
  if (name === "photo" && !modelInfo(state.chat.model).input.includes("image")) toast("Pick a decision model with image input (e.g. Jev) for this one.");
  else if (name === "photo") toast("Attach a photo, then press Decide.");
  saveChat();
  updateStats();
}

function questionsToApi(qs) {
  const out = {};
  for (const q of qs) {
    const key = (q.key || "").trim();
    if (!key) continue;
    const item = { type: q.type };
    if ((q.instructions || "").trim()) item.instructions = q.instructions.trim();
    if (q.type === "choice") {
      item.criteria = Object.fromEntries((q.options || []).filter((o) => o.name.trim()).map((o) => [o.name.trim(), o.desc?.trim() || null]));
    } else if (q.type === "score") {
      item.criteria = (q.levels || []).map((s) => s.trim()).filter(Boolean);
    }
    out[key] = item;
  }
  return out;
}

function validateDecision(text, atts, chat) {
  const qs = chat.questions || [];
  if (!qs.length) return "Add at least one question.";
  const keys = new Set();
  for (const q of qs) {
    const key = (q.key || "").trim();
    if (!key) return "Every question needs a name.";
    if (keys.has(key)) return `Two questions are named “${key}”. Names must be unique.`;
    keys.add(key);
    if ((q.type === "noul" || q.type === "box") && !(q.instructions || "").trim()) return `Write the question for “${key}”.`;
    if (q.type === "choice" && (q.options || []).filter((o) => o.name.trim()).length < 2) return `“${key}” needs at least two options.`;
    if (q.type === "score" && (q.levels || []).filter((s) => s.trim()).length < 2) return `“${key}” needs at least two levels.`;
    if (q.type === "box" && !atts.some((a) => a.kind === "image")) return `“${key}” finds something in an image, so attach an image.`;
  }
  if (!text && !atts.length) return "Paste an item to judge first.";
  return null;
}

function renderQuestions() {
  const qs = state.chat.questions || [];
  const imageOk = modelInfo(state.chat.model).input.includes("image");
  $("#questionList").innerHTML = qs.map((q, i) => `
    <div class="q-card" data-qid="${q.id}">
      <div class="q-top">
        <span class="q-num">${i + 1}</span>
        <input class="q-key" data-f="key" value="${esc(q.key)}" spellcheck="false" placeholder="answer_name" title="Name of this answer">
        <select class="select q-type" data-f="type">
          ${Object.entries(Q_TYPES).filter(([t]) => t !== "box" || imageOk || q.type === "box")
            .map(([t, d]) => `<option value="${t}" ${q.type === t ? "selected" : ""}>${d.label}</option>`).join("")}
        </select>
        <button class="icon-btn small" data-qact="del" title="Remove question"><span class="ms">delete</span></button>
      </div>
      <textarea class="q-instr" data-f="instructions" rows="1" dir="auto"
        placeholder="${q.type === "box" ? "What to find, e.g. “the product in the photo”" : "The question, e.g. “Is the customer reporting a bug?”"}">${esc(q.instructions)}</textarea>
      <div class="q-hint">${Q_TYPES[q.type].hint}</div>
      ${q.type === "choice" ? `<div class="q-list">
          ${(q.options || []).map((o, j) => `<div class="q-opt">
            <input data-o="name" data-i="${j}" value="${esc(o.name)}" placeholder="option" spellcheck="false">
            <input data-o="desc" data-i="${j}" value="${esc(o.desc || "")}" placeholder="what it means (optional)" dir="auto">
            <button class="icon-btn small" data-qact="del-opt" data-i="${j}" title="Remove"><span class="ms">close</span></button></div>`).join("")}
          <button class="ghost-btn small" data-qact="add-opt"><span class="ms">add</span>Add option</button></div>` : ""}
      ${q.type === "score" ? `<div class="q-list">
          ${(q.levels || []).map((l, j) => `<div class="q-opt">
            <span class="lvl">${j}</span>
            <input data-l="${j}" value="${esc(l)}" placeholder="${j === 0 ? "lowest level" : "next level"}" dir="auto">
            <button class="icon-btn small" data-qact="del-lvl" data-i="${j}" title="Remove"><span class="ms">close</span></button></div>`).join("")}
          <button class="ghost-btn small" data-qact="add-lvl"><span class="ms">add</span>Add level</button></div>` : ""}
    </div>`).join("") || '<div class="muted q-empty">No questions yet. Add one or load a template.</div>';
  $$(".q-instr").forEach((ta) => autosize(ta, 200));
  updateQuestionsPreview();
}

function updateQuestionsPreview() {
  const qs = state.chat.questions || [];
  $("#questionsPreview").textContent = qs.length
    ? `${qs.length} question${qs.length > 1 ? "s" : ""}: ${qs.map((q) => q.key || "?").join(", ")}` : "";
}

function bindQuestionEvents() {
  const list = $("#questionList");
  const find = (el) => (state.chat.questions || []).find((q) => q.id === el.closest(".q-card")?.dataset.qid);
  list.addEventListener("input", (e) => {
    const q = find(e.target);
    if (!q) return;
    const t = e.target;
    if (t.dataset.f === "key") {
      const clean = t.value.replace(/\s+/g, "_").replace(/[^\p{L}\p{N}_-]/gu, "");
      if (clean !== t.value) t.value = clean;
      q.key = clean;
    } else if (t.dataset.f === "instructions") { q.instructions = t.value; autosize(t, 200); }
    else if (t.dataset.o) q.options[+t.dataset.i][t.dataset.o] = t.value;
    else if (t.dataset.l !== undefined) q.levels[+t.dataset.l] = t.value;
    updateQuestionsPreview();
    saveChat();
    updateStatsSoon();
  });
  list.addEventListener("change", (e) => {
    const q = find(e.target);
    if (!q || e.target.dataset.f !== "type") return;
    q.type = e.target.value;
    if (q.type === "choice" && !q.options.length) q.options = [{ name: "", desc: "" }, { name: "", desc: "" }];
    if (q.type === "score" && !q.levels.length) q.levels = ["low", "medium", "high"];
    renderQuestions();
    saveChat();
  });
  list.addEventListener("click", (e) => {
    const b = e.target.closest("[data-qact]");
    const q = b && find(b);
    if (!q) return;
    const i = +b.dataset.i;
    switch (b.dataset.qact) {
      case "del": state.chat.questions = state.chat.questions.filter((x) => x !== q); break;
      case "add-opt": q.options.push({ name: "", desc: "" }); break;
      case "del-opt": q.options.splice(i, 1); break;
      case "add-lvl": q.levels.push(""); break;
      case "del-lvl": q.levels.splice(i, 1); break;
    }
    renderQuestions();
    saveChat();
    updateStats();
  });
  $("#addQuestionBtn").addEventListener("click", () => {
    const taken = new Set((state.chat.questions || []).map((q) => q.key));
    let n = taken.size + 1;
    while (taken.has(`question_${n}`)) n++;
    state.chat.questions.push({ id: uid(), key: `question_${n}`, type: "noul", instructions: "", options: [], levels: [] });
    renderQuestions();
    $(`.q-card:last-child .q-instr`)?.focus();
  });
  const sel = $("#templateSelect");
  sel.innerHTML = '<option value="">Load a template…</option>' +
    Object.entries(TEMPLATES).map(([k, t]) => `<option value="${k}">${esc(t.label)}</option>`).join("");
  sel.addEventListener("change", () => {
    if (!sel.value) return;
    if (!(state.chat.questions || []).length || confirm("Replace the current questions with this template?")) loadTemplate(sel.value, true);
    sel.value = "";
  });
}

/* ---------------------------------------------------------------------
   Per-mode settings (built from what each model says it supports)
   --------------------------------------------------------------------- */

const LANGUAGES = [["", "Detect automatically"], ["en", "English"], ["fa", "Persian (فارسی)"], ["ar", "Arabic"], ["de", "German"],
  ["es", "Spanish"], ["fr", "French"], ["hi", "Hindi"], ["it", "Italian"], ["ja", "Japanese"], ["ko", "Korean"],
  ["nl", "Dutch"], ["pt", "Portuguese"], ["ru", "Russian"], ["tr", "Turkish"], ["uk", "Ukrainian"], ["zh", "Chinese"]];

const optOf = (chat, key, fallback) => (chat.opts?.[key] === undefined ? fallback : chat.opts[key]);
const prettyKey = (k) => k.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

function selectField(key, label, values, current, { note = "", allowDefault = true, labels = {} } = {}) {
  const opts = (allowDefault ? [["", "Model default"]] : []).concat(values.map((v) => [String(v), labels[v] || String(v)]));
  return `<div class="field"><label>${esc(label)}</label>
    <select class="select full" data-opt="${key}" data-type="${typeof values[0] === "number" ? "number" : "text"}">
      ${opts.map(([v, l]) => `<option value="${esc(v)}" ${String(current ?? "") === v ? "selected" : ""}>${esc(l)}</option>`).join("")}
    </select>${note ? `<div class="field-note">${note}</div>` : ""}</div>`;
}
function numberField(key, label, current, { min, max, step = 1, placeholder = "Model default", note = "" } = {}) {
  return `<div class="field"><label>${esc(label)}</label>
    <input class="text-input" type="number" data-opt="${key}" data-type="number" value="${current ?? ""}"
      ${min != null ? `min="${min}"` : ""} ${max != null ? `max="${max}"` : ""} step="${step}" placeholder="${esc(placeholder)}">
    ${note ? `<div class="field-note">${note}</div>` : ""}</div>`;
}
function toggleField(key, label, checked, note = "") {
  return `<div class="field"><label class="toggle"><input type="checkbox" data-opt="${key}" data-type="bool" ${checked ? "checked" : ""}>
    <span class="switch"></span><span>${esc(label)}</span></label>${note ? `<div class="field-note">${note}</div>` : ""}</div>`;
}
function textField(key, label, current, placeholder, note = "", area = false) {
  return `<div class="field"><label>${esc(label)}</label>${area
    ? `<textarea class="text-input area" data-opt="${key}" data-type="text" rows="2" dir="auto" placeholder="${esc(placeholder)}">${esc(current ?? "")}</textarea>`
    : `<input class="text-input" data-opt="${key}" data-type="text" value="${esc(current ?? "")}" placeholder="${esc(placeholder)}">`}
    ${note ? `<div class="field-note">${note}</div>` : ""}</div>`;
}

function speechDefaults(m) {
  const pcmOnly = /^(heygen|google)\//.test(m.id);
  return { voice: m.voices?.[0] || "", format: pcmOnly ? "pcm" : "mp3" };
}

function renderKindSettings() {
  const chat = state.chat;
  const kind = kindOf(chat);
  const m = modelInfo(chat.model);
  const o = chat.opts || {};
  let html = "";
  if (kind === "image") {
    const params = m.image?.params || {};
    for (const [key, d] of Object.entries(params)) {
      if (key === "input_references") continue;
      const label = { n: "Number of images", aspect_ratio: "Aspect ratio", output_format: "File format", output_compression: "Compression (0–100)" }[key] || prettyKey(key);
      if (d.type === "enum") html += selectField(key, label, d.values || [], o[key]);
      else if (d.type === "range") html += numberField(key, label, o[key] ?? (key === "n" ? 1 : ""), { min: d.min, max: d.max, placeholder: key === "n" ? "1" : `${d.min}–${d.max}` });
      else if (d.type === "boolean" && key === "seed") html += numberField("seed", "Seed", o.seed, { placeholder: "Random" });
      else if (d.type === "boolean") html += toggleField(key, label, !!o[key]);
    }
    const refs = params.input_references;
    if (m.input.includes("image") && refs?.max) html += `<div class="field-note boxed"><span class="ms">image</span>Attach up to ${refs.max} reference image${refs.max > 1 ? "s" : ""} to edit or guide the result.</div>`;
    if (!html) html = '<div class="field-note boxed">This model has no extra settings.</div>';
  } else if (kind === "video") {
    const v = m.video || {};
    const dur = optOf(chat, "duration", v.durations?.includes(5) ? 5 : v.durations?.[0]);
    if (v.durations?.length) html += selectField("duration", "Duration", v.durations, dur, { allowDefault: false, labels: Object.fromEntries(v.durations.map((d) => [d, `${d} second${d === 1 ? "" : "s"}`])) });
    if (v.resolutions?.length) html += selectField("resolution", "Resolution", v.resolutions, o.resolution);
    if (v.aspect_ratios?.length) html += selectField("aspect_ratio", "Aspect ratio", v.aspect_ratios, o.aspect_ratio);
    if (v.generate_audio) html += toggleField("generate_audio", "Generate sound", optOf(chat, "generate_audio", true), "Dialogue, ambience and effects, when the model supports it.");
    if (v.seed) html += numberField("seed", "Seed", o.seed, { placeholder: "Random" });
    const frames = v.frame_images || [];
    html += `<div class="field-note boxed"><span class="ms">image</span>${frames.includes("last_frame")
      ? "Attach 1 image to start from it, or 2 images for the first and last frame."
      : frames.includes("first_frame") ? "Attach an image to use it as the first frame."
      : m.input.includes("image") ? "Attached images are used as references." : "This model makes video from text only."}</div>`;
  } else if (kind === "speech") {
    const d = speechDefaults(m);
    const voice = optOf(chat, "voice", d.voice);
    html += m.voices?.length
      ? selectField("voice", "Voice", m.voices, voice, { allowDefault: false })
      : textField("voice", "Voice", voice, "provider default", "This model doesn't list its voices. Leave empty for the default.");
    html += selectField("response_format", "Audio format", ["mp3", "pcm"], optOf(chat, "response_format", d.format),
      { allowDefault: false, labels: { mp3: "MP3", pcm: "PCM → WAV" }, note: "Some providers only return one format. Switch if you get an error." });
    html += numberField("speed", "Speed", optOf(chat, "speed", 1), { min: 0.25, max: 4, step: 0.05, placeholder: "1" });
    html += textField("instructions", "Style instructions", o.instructions, "e.g. cheerful, slow, whispering", "Used by OpenAI, Gemini and Fish Audio voices. Others ignore it.", true);
  } else if (kind === "transcription") {
    html += selectField("language", "Language", LANGUAGES.slice(1).map(([c]) => c), o.language,
      { labels: Object.fromEntries(LANGUAGES), note: "Setting it can improve accuracy." });
    html += toggleField("timestamps", "Timestamps", !!o.timestamps, "Return segments with start and end times.");
  } else if (kind === "embeddings") {
    html += numberField("dimensions", "Dimensions", o.dimensions, { min: 1, placeholder: "Model default", note: "Only some models can shorten their vectors." });
  } else if (kind === "extract") {
    html += renderExtractSettings(chat, m); // structured.js
  } else if (kind === "decisions") {
    html += numberField("threshold", "Yes threshold (%)", optOf(chat, "threshold", 50), { min: 1, max: 99, placeholder: "50",
      note: "A yes/no answer becomes <code>true</code> when its probability is at least this. Used for the typed result (JSON / CSV)." });
    html += `<div class="field-note boxed"><span class="ms">rule</span>Edit the questions at the top of the conversation. Every run answers all of them.</div>`;
    if (m.input.length > 1) html += `<div class="field-note boxed"><span class="ms">attach_file</span>This model can also read ${m.input.filter((x) => x !== "text").map((x) => ({ image: "images", audio: "audio", video: "video", file: "PDFs" }[x] || x)).join(", ")}. Attach them to the item.</div>`;
  }
  $("#kindSettings").innerHTML = html;
  $("#kindSettings").hidden = !html;
}

function bindKindSettingsEvents() {
  const box = $("#kindSettings");
  const update = (e) => {
    const t = e.target.closest("[data-opt]");
    if (!t) return;
    let v = t.type === "checkbox" ? t.checked : t.value;
    if (t.dataset.type === "number" && v !== "") v = Number(v);
    if (v === "") v = undefined;
    state.chat.opts[t.dataset.opt] = v;
    saveChat();
    updateStats();
    if (t.dataset.opt === "threshold") renderMessages(); // typed true/false values depend on it
  };
  box.addEventListener("change", update);
  box.addEventListener("input", (e) => { if (e.target.matches("input[type=text], textarea, input:not([type])")) update(e); });
}

/* ---------------------------------------------------------------------
   Running a task (everything except chat)
   --------------------------------------------------------------------- */

function buildDecisionState(user) {
  const media = (user.attachments || []).filter((a) => ["image", "audio", "video", "pdf"].includes(a.kind));
  if (!media.length) return user.fields || user.content; // input fields go in as a JSON object
  const text = user.fields ? fieldsAsLines(user.fields) : user.content;
  const parts = text ? [text] : [];
  for (const a of media) parts.push(attachmentToPart(a));
  return parts;
}

function imageParams(chat, m) {
  const out = {};
  for (const [key, d] of Object.entries(m.image?.params || {})) {
    const v = chat.opts[key];
    if (key === "input_references" || v === undefined || v === "") continue;
    if (d.type === "enum" && d.values?.length && !d.values.includes(v)) continue; // left over from another model
    if (key === "n" && Number(v) <= 1) continue;
    out[key] = d.type === "boolean" && key !== "seed" ? !!v : v;
  }
  return out;
}

function videoRequest(user, chat, m) {
  const v = m.video || {};
  const o = chat.opts;
  const params = {};
  // settings can be left over from another model: only send values this model offers
  const offers = (list, val) => !list?.length || list.map(String).includes(String(val));
  const defDur = v.durations?.includes(5) ? 5 : v.durations?.[0];
  let dur = optOf(chat, "duration", defDur);
  if (!offers(v.durations, dur)) dur = defDur;
  if (dur) params.duration = Number(dur);
  if (o.resolution && offers(v.resolutions, o.resolution)) params.resolution = o.resolution;
  if (o.aspect_ratio && offers(v.aspect_ratios, o.aspect_ratio)) params.aspect_ratio = o.aspect_ratio;
  if (v.generate_audio) params.generate_audio = optOf(chat, "generate_audio", true);
  if (o.seed !== undefined && o.seed !== "") params.seed = Number(o.seed);
  const images = (user.attachments || []).filter((a) => a.kind === "image").map((a) => a.data);
  const body = { model: chat.model, prompt: user.content, params };
  const fi = v.frame_images || [];
  if (images.length && fi.includes("first_frame")) {
    body.frames = [{ url: images[0], frame_type: "first_frame" }];
    if (images[1] && fi.includes("last_frame")) body.frames.push({ url: images[1], frame_type: "last_frame" });
  } else if (images.length) {
    body.references = images;
  }
  return body;
}

function speechRequest(user, chat, m) {
  const d = speechDefaults(m);
  let voice = optOf(chat, "voice", d.voice);
  if (m.voices?.length && !m.voices.includes(voice)) voice = d.voice; // voice of a previous model
  let format = optOf(chat, "response_format", d.format);
  if (d.format === "pcm") format = "pcm"; // these models only return raw PCM
  const body = { model: chat.model, input: user.content, voice: voice || undefined, response_format: format };
  const speed = Number(optOf(chat, "speed", 1));
  if (speed && speed !== 1) body.speed = speed;
  if ((chat.opts.instructions || "").trim()) body.instructions = chat.opts.instructions.trim();
  return body;
}

function cosineMatrix(vectors) {
  const norms = vectors.map((v) => Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1);
  return vectors.map((a, i) => vectors.map((b, j) => {
    let dot = 0;
    for (let k = 0; k < a.length; k++) dot += a[k] * b[k];
    return +(dot / (norms[i] * norms[j])).toFixed(4);
  }));
}

const TASKS = {
  async decisions(msg, user, chat, m, signal) {
    msg.questions = structuredClone(chat.questions);
    const res = await api("/api/decisions", { method: "POST", signal, body: {
      model: chat.model, state: buildDecisionState(user), questions: questionsToApi(chat.questions) } });
    msg.answers = res.answers || {};
    msg.meta.usage = res.usage;
    msg.meta.seconds = res.seconds;
    msg.meta.servedBy = res.model;
    if (res.annotations?.length) msg.citations = res.annotations.map((a) => a.url_citation).filter(Boolean);
  },
  async image(msg, user, chat, m, signal) {
    const references = (user.attachments || []).filter((a) => a.kind === "image").map((a) => a.data);
    const res = await api("/api/images", { method: "POST", signal, body: {
      model: chat.model, prompt: user.content, params: imageParams(chat, m), references } });
    msg.images = res.images;
    msg.meta.usage = res.usage;
    msg.meta.seconds = res.seconds;
  },
  async speech(msg, user, chat, m, signal) {
    const body = speechRequest(user, chat, m);
    const res = await api("/api/speech", { method: "POST", signal, body });
    msg.audio = res.url;
    msg.voice = body.voice;
    msg.meta.generationId = res.generation_id;
    msg.meta.seconds = res.seconds;
  },
  async transcription(msg, user, chat, m, signal) {
    const audio = (user.attachments || []).find((a) => a.kind === "audio");
    const res = await api("/api/transcribe", { method: "POST", signal, body: {
      model: chat.model, audio: audio.data, format: audio.format || "wav",
      language: chat.opts.language || undefined, timestamps: !!chat.opts.timestamps } });
    msg.content = res.text || "";
    msg.segments = (res.segments || []).map((s) => ({ start: s.start, end: s.end, text: s.text, speaker: s.speaker }));
    msg.language = res.language;
    msg.meta.usage = res.usage;
    msg.meta.seconds = res.seconds;
    if (!msg.content) msg.meta.error = "No speech was found in the audio.";
  },
  async video(msg, user, chat, m, signal) {
    const res = await api("/api/videos", { method: "POST", signal, body: videoRequest(user, chat, m) });
    msg.video = { id: res.id, status: res.status || "pending", started: Date.now() };
  },
  async embeddings(msg, user, chat, m, signal) {
    const lines = user.content.split("\n").map((s) => s.trim()).filter(Boolean);
    const res = await api("/api/embeddings", { method: "POST", signal, body: {
      model: chat.model, input: lines, dimensions: chat.opts.dimensions || undefined } });
    state.vectors.set(msg.id, res.vectors);
    msg.embedding = {
      count: res.vectors.length,
      dims: res.vectors[0]?.length || 0,
      labels: lines.map((l) => (l.length > 80 ? l.slice(0, 77) + "…" : l)),
      matrix: cosineMatrix(res.vectors),
      preview: res.vectors.map((v) => v.slice(0, 6).map((x) => +x.toFixed(4))),
    };
    msg.meta.usage = res.usage;
    msg.meta.seconds = res.seconds;
  },
};

async function runTask(user) {
  const chat = state.chat;
  const kind = kindOf(chat);
  const m = modelInfo(chat.model);
  const est = estimateFor(kind, m, chat, { text: user.content, attachments: user.attachments || [] });
  const msg = { id: uid(), role: "assistant", kind, model: chat.model, content: "", created: Date.now(), meta: { started: Date.now(), estimate: est?.total ?? null } };
  chat.messages.push(msg);
  state.streamingId = msg.id;
  const el = messageEl(msg);
  $("#messages").appendChild(el);
  $("#empty").hidden = true;
  scrollToBottom();

  const controller = new AbortController();
  state.controller = controller;
  setRunning(true);
  try {
    await TASKS[kind](msg, user, chat, m, controller.signal);
  } catch (e) {
    if (e.name === "AbortError") msg.meta.stopped = true;
    else msg.meta.error = e.message || String(e);
  } finally {
    msg.meta.seconds ||= +((Date.now() - msg.meta.started) / 1000).toFixed(1);
    state.controller = null;
    state.streamingId = null;
    setRunning(false);
    if (el.isConnected) {
      el.replaceWith(messageEl(msg));
      scrollToBottom();
    }
    if (state.chat === chat) updateStats();
    saveChat(chat);
    refreshCreditsSoon();
    if (msg.video && !msg.meta.error) pollVideo(msg, chat);
    if (msg.meta.generationId) fetchExactCost(msg, chat);
  }
}

/** Speech responses don't include the price; ask OpenRouter for it once the request is logged. */
async function fetchExactCost(msg, chat) {
  for (const wait of [1500, 4000, 10000]) {
    await sleep(wait);
    try {
      const g = await api(`/api/generation?id=${encodeURIComponent(msg.meta.generationId)}`);
      if (g.total_cost != null) {
        msg.meta.cost = g.total_cost;
        if (state.chat === chat) { repaintMessage(msg); updateStats(); }
        if (!isStaleChat(chat)) saveChat(chat);
        return;
      }
    } catch { /* not ready yet */ }
  }
}

/** True when this chat object was deleted, or the same chat has been re-opened as a newer object. */
function isStaleChat(chat) {
  return !!chat.deleted || (state.chat?.id === chat.id && state.chat !== chat)
    || (chat.messages.length > 0 && !state.chats.some((c) => c.id === chat.id));
}

const polling = new Map(); // message id -> the newest {msg, chat} objects for that video job
const VIDEO_RUNNING = ["pending", "in_progress", "queued", "processing"];

/** Video jobs run on OpenRouter; check their status until they finish (also after a reload). */
async function pollVideo(firstMsg, firstChat) {
  const id = firstMsg.id;
  const running = polling.has(id);
  polling.set(id, { msg: firstMsg, chat: firstChat }); // re-opening a chat hands the loop its new objects
  if (running) return;
  let msg = firstMsg, chat = firstChat;
  let failures = 0;
  try {
    for (;;) {
      ({ msg, chat } = polling.get(id));
      if (!VIDEO_RUNNING.includes(msg.video.status)) break;
      await sleep(6000);
      ({ msg, chat } = polling.get(id));
      if (!chat.messages.includes(msg) || chat.deleted || !state.chats.some((c) => c.id === chat.id)) return; // deleted meanwhile
      let s;
      try { s = await api(`/api/videos/${encodeURIComponent(msg.video.id)}`); failures = 0; }
      catch (e) {
        if (++failures >= 5) { msg.meta.error = "Lost contact with the video job: " + e.message; msg.video.status = "failed"; }
        continue;
      }
      if (!s.status) s.status = "failed";
      const changed = s.status !== msg.video.status;
      msg.video.status = s.status;
      if (s.status === "completed") {
        msg.video.urls = Array.from({ length: s.count || 1 }, (_, i) => `/api/videos/${encodeURIComponent(msg.video.id)}/content?index=${i}`);
        msg.meta.usage = s.usage || msg.meta.usage;
        msg.meta.seconds = +((Date.now() - msg.video.started) / 1000).toFixed(0);
      } else if (["failed", "cancelled", "expired"].includes(s.status)) {
        msg.meta.error = typeof s.error === "string" ? s.error : s.error?.message || `The video job ${s.status}.`;
      }
      if (changed && state.chat === chat) repaintMessage(msg);
    }
  } finally {
    polling.delete(id);
    if (state.chat === chat) { repaintMessage(msg); updateStats(); }
    if (!isStaleChat(chat)) saveChat(chat);
    if (msg.video.status === "completed") { toast("Your video is ready 🎬"); refreshCreditsSoon(); }
  }
}

function resumeJobs(chat) {
  for (const m of chat.messages) {
    if (m.video && VIDEO_RUNNING.includes(m.video.status)) pollVideo(m, chat);
  }
}

/* ---------------------------------------------------------------------
   Output views
   --------------------------------------------------------------------- */

const pct = (p) => `${Math.round((p || 0) * 100)}%`;

function bar(label, p, cls = "", title = "") {
  return `<div class="pbar ${cls}" title="${esc(title || label)}">
    <span class="pbar-label" dir="auto">${esc(label)}</span>
    <div class="pbar-track"><i style="width:${Math.max(0, Math.min(100, (p || 0) * 100))}%"></i></div>
    <span class="pbar-val">${pct(p)}</span></div>`;
}

function inputImageFor(m) {
  const msgs = state.chat.messages;
  for (let i = msgs.indexOf(m) - 1; i >= 0; i--) {
    if (msgs[i].role === "user") return (msgs[i].attachments || []).find((a) => a.kind === "image")?.data;
  }
  return null;
}

function renderDecision(m) {
  const qs = m.questions || [];
  const cards = Object.entries(m.answers || {}).map(([key, a]) => {
    const q = qs.find((x) => x.key === key) || {};
    const head = `<div class="ans-head"><b>${esc(key)}</b><span class="ans-type">${esc(Q_TYPES[a.type]?.label || a.type)}</span>
      ${a.confidence != null ? `<span class="ans-conf" title="How sure the model is">confidence ${pct(a.confidence)}</span>` : ""}</div>
      ${q.instructions ? `<div class="ans-q" dir="auto">${esc(q.instructions)}</div>` : ""}`;
    let body = "";
    if (a.type === "noul") {
      const yes = a.noul >= (state.chat.opts?.threshold ?? 50) / 100; // same threshold as the typed result
      const th = (state.chat.opts?.threshold ?? 50) / 100;
      body = `<div class="ans-verdict ${yes ? "yes" : "no"}"><span class="ms">${yes ? "check_circle" : "cancel"}</span>${yes ? "Yes" : "No"}
          <code class="bool-code" title="Typed value at a ${Math.round(th * 100)}% threshold">${a.noul >= th}</code></div>
        ${bar("Yes", a.noul, yes ? "win" : "")}${bar("No", 1 - a.noul, yes ? "" : "win lose")}`;
    } else if (a.type === "choice") {
      const probs = Object.entries(a.probabilities || { [a.choice]: a.confidence ?? 1 }).sort((x, y) => y[1] - x[1]);
      const desc = (q.options || []).find((o) => o.name === a.choice)?.desc;
      body = `<div class="ans-verdict pick"><span class="ms">task_alt</span>${esc(a.choice)}${desc ? `<span class="muted"> · ${esc(desc)}</span>` : ""}</div>
        ${probs.map(([k, p]) => bar(k, p, k === a.choice ? "win" : "")).join("")}`;
    } else if (a.type === "score") {
      const legend = a.legend ? Object.entries(a.legend).sort((x, y) => x[0] - y[0]).map(([, v]) => v) : (q.levels || []);
      const max = Math.max(1, legend.length - 1);
      const nearest = legend[Math.round(a.score)] ?? "";
      body = `<div class="ans-verdict pick"><span class="ms">speed</span>${esc(nearest)}<span class="muted"> · score ${(+a.score).toFixed(2)} of ${max}</span></div>
        <div class="scale"><i style="left:${(a.score / max) * 100}%"></i></div>
        ${legend.map((label, i) => bar(`${i} · ${label}`, a.probabilities?.[i] ?? a.probabilities?.[String(i)] ?? 0, i === Math.round(a.score) ? "win" : "")).join("")}`;
    } else if (a.type === "box") {
      const b = a.box || {};
      const img = inputImageFor(m);
      body = img ? `<div class="box-wrap"><img src="${esc(img)}" alt=""><div class="box-rect" style="top:${b.top * 100}%;left:${b.left * 100}%;width:${(b.right - b.left) * 100}%;height:${(b.bottom - b.top) * 100}%"><span>${esc(key)}</span></div></div>` : "";
      body += `<div class="muted small">top ${pct(b.top)} · left ${pct(b.left)} · bottom ${pct(b.bottom)} · right ${pct(b.right)}</div>`;
    } else if (a.type === "refusal") {
      body = `<div class="ans-verdict no"><span class="ms">block</span>The model declined this question.</div>`;
    } else {
      body = `<pre class="raw">${esc(JSON.stringify(a, null, 2))}</pre>`;
    }
    return `<div class="ans">${head}${body}</div>`;
  }).join("");
  const cites = (m.citations || []).filter((c) => /^https?:\/\//i.test(c?.url || "")).map((c) => `<a href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.title || c.url)}</a>`).join(" · ");
  const typed = decisionTyped(m);
  const head = `<div class="struct-head"><span class="tag"><span class="ms">data_object</span>Typed result</span>
    <code class="typed-inline" title="Yes/no answers become booleans, choices strings, scores numbers">${esc(JSON.stringify(typed))}</code>${resultToolbar()}</div>`;
  return `${head}<div class="answers">${cards || '<div class="muted">No answers returned.</div>'}</div>${cites ? `<div class="muted small cites">Sources: ${cites}</div>` : ""}`;
}

function renderEmbedding(m) {
  const e = m.embedding;
  if (!e) return "";
  const cell = (v, i, j) => {
    const t = Math.max(0, Math.min(1, (v - 0.2) / 0.8)); // spread the usual 0.2–1 range over the colour scale
    return `<td style="--heat:${t.toFixed(3)}" class="${i === j ? "self" : ""}" title="${esc(e.labels[i])} ↔ ${esc(e.labels[j])}">${v.toFixed(2)}</td>`;
  };
  const table = e.count > 1 ? `<div class="heat-wrap"><table class="heat">
      <tr><th></th>${e.labels.map((_, j) => `<th>${j + 1}</th>`).join("")}</tr>
      ${e.matrix.map((row, i) => `<tr><th class="row-label" dir="auto" title="${esc(e.labels[i])}"><span>${i + 1}</span>${esc(e.labels[i])}</th>${row.map((v, j) => cell(v, i, j)).join("")}</tr>`).join("")}
    </table></div>
    ${mostSimilar(e)}` : `<div class="vec-preview">[${e.preview[0].join(", ")}, …]</div>`;
  const inMemory = state.vectors.has(m.id);
  return `<div class="embed-head"><span class="tag"><span class="ms">scatter_plot</span>${e.count} vector${e.count > 1 ? "s" : ""} × ${fmtInt(e.dims)} dimensions</span>
    ${inMemory ? `<button class="ghost-btn small" data-out="copy-vectors"><span class="ms">content_copy</span>Copy vectors</button>
    <button class="ghost-btn small" data-out="download-vectors"><span class="ms">download</span>JSON</button>` : `<span class="muted small">Run again to get the raw vectors.</span>`}</div>${table}`;
}

function mostSimilar(e) {
  let best = null;
  for (let i = 0; i < e.count; i++) for (let j = i + 1; j < e.count; j++) {
    if (!best || e.matrix[i][j] > best.v) best = { i, j, v: e.matrix[i][j] };
  }
  return best ? `<div class="muted small">Most similar: <b>${best.i + 1}</b> and <b>${best.j + 1}</b> (${best.v.toFixed(2)}). 1.00 means the same meaning.</div>` : "";
}

function renderOutput(m) {
  switch (m.kind) {
    case "decisions": return m.answers ? renderDecision(m) : "";
    case "extract": return renderExtract(m); // structured.js
    case "embeddings": return renderEmbedding(m);
    case "image":
      return (m.images || []).length ? `<div class="gallery n${Math.min(m.images.length, 4)}">${m.images.map((img, i) => `
        <figure><img src="${esc(img.url)}" alt="Generated image ${i + 1}" loading="lazy">
          <a class="fig-btn" href="${esc(img.url)}" download title="Download"><span class="ms">download</span></a></figure>`).join("")}</div>` : "";
    case "speech":
      return m.audio ? `<div class="audio-out big"><span class="ms">record_voice_over</span>
        <audio controls src="${esc(m.audio)}"></audio>
        <a class="ghost-btn" href="${esc(m.audio)}" download title="Download"><span class="ms">download</span></a></div>
        ${m.voice ? `<div class="muted small">Voice: ${esc(m.voice)}</div>` : ""}` : "";
    case "transcription": {
      if (!m.content) return "";
      const segs = (m.segments || []).length ? `<div class="segments">${m.segments.map((s) =>
        `<div class="seg"><span class="seg-time">${fmtDuration(s.start)}</span>${s.speaker ? `<span class="tag">${esc(s.speaker)}</span>` : ""}<span dir="auto">${esc(s.text)}</span></div>`).join("")}</div>` : "";
      return `<div class="transcript" dir="auto">${esc(m.content)}</div>${m.language ? `<div class="muted small">Language: ${esc(m.language)}</div>` : ""}${segs}`;
    }
    case "video": {
      const v = m.video;
      if (!v) return "";
      if (v.status === "completed") {
        return (v.urls || []).map((u) => `<div class="video-out"><video controls playsinline preload="metadata" src="${esc(u)}"></video>
          <a class="ghost-btn small" href="${esc(u)}" download="video.mp4"><span class="ms">download</span>Download</a></div>`).join("");
      }
      if (["failed", "cancelled", "expired"].includes(v.status)) return "";
      return `<div class="job"><div class="job-anim"><span class="ms">movie</span></div><div>
        <b>Generating video…</b><div class="muted small">Status: ${esc(String(v.status || "unknown").replace("_", " "))} · <span class="job-elapsed" data-start="${v.started}">0:00</span> elapsed · usually 30 s to a few minutes</div>
        <div class="muted small">You can keep working. This updates by itself, even after a reload.</div></div></div>`;
    }
    default: return "";
  }
}

function taskPlaceholderHTML(m) {
  return `<div class="task-run kind-${m.kind}"><div class="shimmer"></div>
    <div class="task-meta"><span class="ms spin">progress_activity</span><span>${esc(KINDS[m.kind].busy)}</span>
    <span class="task-elapsed" data-start="${m.meta.started}" data-secs="1">0.0s</span></div></div>`;
}

function outputMarkdown(m) {
  const abs = (u) => (u.startsWith("/") ? location.origin + u : u);
  switch (m.kind) {
    case "decisions":
      return "| question | answer |\n|---|---|\n" + Object.entries(m.answers || {}).map(([k, a]) =>
        `| ${k} | ${a.type === "noul" ? `yes ${pct(a.noul)}` : a.type === "choice" ? `${a.choice} (${pct(a.confidence)})`
          : a.type === "score" ? `score ${(+a.score).toFixed(2)}` : a.type === "box" ? JSON.stringify(a.box) : a.type} |`).join("\n");
    case "image": return (m.images || []).map((i) => `![image](${abs(i.url)})`).join("\n");
    case "speech": return m.audio ? `[audio](${abs(m.audio)})` : "";
    case "video": return (m.video?.urls || []).map((u) => `[video](${abs(u)})`).join("\n") || `video job ${m.video?.id} (${m.video?.status})`;
    case "transcription": return m.content;
    case "embeddings": return m.embedding ? `${m.embedding.count} vectors × ${m.embedding.dims} dims\n\n` +
      m.embedding.matrix.map((r, i) => `${i + 1}. ${m.embedding.labels[i]}: ${r.map((v) => v.toFixed(2)).join(" ")}`).join("\n") : "";
    default: return m.content || "";
  }
}

function copyTextFor(m) {
  if (m.role === "assistant" && typedResult(m) != null) return JSON.stringify(typedResult(m), null, 2);
  if (m.role === "user" || (m.kind || "chat") === "chat" || m.kind === "transcription") return m.content;
  if (m.kind === "decisions") return JSON.stringify(m.answers, null, 2);
  return outputMarkdown(m);
}

function handleOutputClick(e) {
  const b = e.target.closest("[data-out]");
  if (!b) return false;
  const id = b.closest(".msg")?.dataset.id;
  const msg = state.chat.messages.find((x) => x.id === id);
  if (msg && handleStructuredClick(b, msg)) return true; // structured.js: copy / JSON / CSV
  const vectors = state.vectors.get(id);
  if (!vectors) return true;
  const json = JSON.stringify(vectors);
  if (b.dataset.out === "copy-vectors") { copyText(json); toast("Vectors copied as JSON"); }
  if (b.dataset.out === "download-vectors") {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([json], { type: "application/json" }));
    a.download = "embeddings.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  return true;
}

/* ---------------------------------------------------------------------
   Get code for each mode
   --------------------------------------------------------------------- */

function lastInput() {
  const draft = $("#input").value.trim();
  const user = [...state.chat.messages].reverse().find((x) => x.role === "user");
  return { content: draft || user?.content || "", attachments: draft ? state.pending : user?.attachments || [] };
}

function taskCode(kind, lang) {
  const chat = state.chat;
  const m = modelInfo(chat.model);
  const user = lastInput();
  const model = JSON.stringify(chat.model);
  let path, body, wrapper, pick = "";
  switch (kind) {
    case "decisions": {
      const st = buildDecisionState(user);
      const stateForCode = Array.isArray(st) ? st.map((p) => (typeof p === "string" ? p
        : p.type === "image_url" ? { type: "image_url", image_url: { url: PLACEHOLDER.image_url } }
        : p.type === "input_audio" ? { type: "input_audio", input_audio: { data: PLACEHOLDER.audio, format: p.input_audio.format } }
        : { type: "video_url", video_url: { url: PLACEHOLDER.video } })) : (st || "Paste the item to judge here.");
      const questions = questionsToApi(chat.questions);
      path = "alpha/decisions";
      body = { model: chat.model, state: stateForCode, questions };
      pick = '["answers"]';
      wrapper = `result = client.decide(
    state=${py(stateForCode, 4)},
    questions=${py(questions, 4)},
    model=${model},
)
for name, answer in result["answers"].items():
    print(name, answer)
print("cost:", result["usage"]["cost"])`;
      break;
    }
    case "image": {
      const params = imageParams(chat, m);
      path = "v1/images";
      body = { model: chat.model, prompt: user.content || "A watercolor fox", ...params };
      pick = '["data"][0]["media_type"]';
      wrapper = `import base64

result = client.generate_image(${JSON.stringify(body.prompt)}, model=${model}${Object.entries(params).map(([k, v]) => `, ${k}=${py(v)}`).join("")})
for i, image in enumerate(result["data"]):
    with open(f"image_{i}.png", "wb") as f:
        f.write(base64.b64decode(image["b64_json"]))
print("cost:", result["usage"]["cost"])`;
      break;
    }
    case "speech": {
      const r = speechRequest({ content: user.content || "Hello from OpenRouter!" }, chat, m);
      path = "v1/audio/speech";
      body = Object.fromEntries(Object.entries(r).filter(([, v]) => v !== undefined));
      const ext = body.response_format === "pcm" ? "wav" : "mp3";
      if (lang === "curl") return curlFor(path, body) + ` \\\n  --output speech.${body.response_format === "pcm" ? "pcm" : "mp3"}`;
      if (lang === "requests") return requestsFor(path, body, "").replace("print(response.json())", `open("speech.${body.response_format === "pcm" ? "pcm" : "mp3"}", "wb").write(response.content)`);
      wrapper = `${ext === "wav" ? "from openrouter_client import pcm16_to_wav\n\n" : ""}audio, info = client.speech(${JSON.stringify(body.input)}, model=${model}${body.voice ? `, voice=${JSON.stringify(body.voice)}` : ""}, response_format=${JSON.stringify(body.response_format)})
with open("speech.${ext}", "wb") as f:
    f.write(${ext === "wav" ? "pcm16_to_wav(audio)" : "audio"})`;
      break;
    }
    case "transcription": {
      const fmt = user.attachments.find((a) => a.kind === "audio")?.format || "wav";
      path = "v1/audio/transcriptions";
      body = { model: chat.model, input_audio: { data: PLACEHOLDER.audio, format: fmt } };
      if (chat.opts.language) body.language = chat.opts.language;
      pick = '["text"]';
      wrapper = `with open("audio.${fmt}", "rb") as f:
    result = client.transcribe(f.read(), ${JSON.stringify(fmt)}, model=${model}${chat.opts.language ? `, language=${JSON.stringify(chat.opts.language)}` : ""})
print(result["text"])`;
      break;
    }
    case "video": {
      const r = videoRequest({ content: user.content || "A drone shot over mountains", attachments: [] }, chat, m);
      path = "v1/videos";
      body = { model: chat.model, prompt: r.prompt, ...r.params };
      pick = '["id"]';
      wrapper = `import time

job = client.create_video(${JSON.stringify(r.prompt)}, model=${model}${Object.entries(r.params).map(([k, v]) => `, ${k}=${py(v)}`).join("")})
while (status := client.get_video(job["id"]))["status"] in ("pending", "in_progress"):
    time.sleep(10)
if status["status"] == "completed":
    data, _ = client.download_video(job["id"])
    open("video.mp4", "wb").write(data)
print(status["status"], status.get("usage"))`;
      break;
    }
    case "embeddings": {
      const lines = (user.content || SAMPLE_SENTENCES).split("\n").map((s) => s.trim()).filter(Boolean);
      path = "v1/embeddings";
      body = { model: chat.model, input: lines };
      if (chat.opts.dimensions) body.dimensions = chat.opts.dimensions;
      pick = '["data"][0]["embedding"][:5]';
      wrapper = `result = client.embed(${py(lines)}, model=${model})
vectors = [row["embedding"] for row in result["data"]]
print(len(vectors), "vectors of", len(vectors[0]), "dimensions")`;
      break;
    }
  }
  if (lang === "json") return JSON.stringify(body, null, 2);
  if (lang === "curl") return curlFor(path, body);
  if (lang === "requests") return requestsFor(path, body, pick);
  return `from openrouter_client import OpenRouterClient

client = OpenRouterClient()  # reads OPENROUTER_API_KEY from .env

${wrapper}
`;
}

/* ---------------------------------------------------------------------
   Events + a small ticker for "elapsed" counters
   --------------------------------------------------------------------- */

function bindModeEvents() {
  bindQuestionEvents();
  bindKindSettingsEvents();
  setInterval(() => {
    for (const el of $$(".task-elapsed[data-start], .job-elapsed[data-start]")) {
      const s = (Date.now() - Number(el.dataset.start)) / 1000;
      el.textContent = el.dataset.secs ? `${s.toFixed(1)}s` : fmtDuration(s);
    }
  }, 200);
}
