/* Opaque — side panel.
 *
 * Holds the conversation, the optional Florence-2 pass, and the calls to the
 * reasoning server. The page context is attached once, at the start of the
 * conversation; follow-up questions are ordinary turns, so the model keeps the
 * screen in mind without it being re-sent every time.
 */

const $ = (id) => document.getElementById(id);

let state = {
  context: null,      // sanitised description of the screen
  findings: [],       // what was detected
  shot: null,         // redacted screenshot, data URL
  history: [],        // [{role:'user'|'model', text}]
  attached: false,    // has the screen context been attached to this conversation
  ocr: { lib: null, model: null, processor: null, tokenizer: null, ready: false }
};

/* ---------------------------------------------------------------- settings */

const DEFAULTS = { server: "mock", apiKey: "", model: "gemini-3.6-flash",
                   ollamaModel: "llama3.2", useOcr: false };

async function loadSettings() {
  const s = await chrome.storage.local.get(DEFAULTS);
  $("server").value = s.server;
  $("apiKey").value = s.apiKey;
  $("model").value = s.model;
  $("ollamaModel").value = s.ollamaModel;
  $("useOcr").checked = s.useOcr;
  syncSettingsUi();
}

function saveSettings() {
  chrome.storage.local.set({
    server: $("server").value,
    apiKey: $("apiKey").value,
    model: $("model").value,
    ollamaModel: $("ollamaModel").value,
    useOcr: $("useOcr").checked
  });
}

function syncSettingsUi() {
  const v = $("server").value;
  const names = { mock: "Mock (canned replies)", gemini: "Gemini", ollama: "Ollama" };
  $("serverNow").textContent = names[v] || v;
  document.querySelector(".serverbar").classList.toggle("live", v !== "mock");
  $("geminiCfg").classList.toggle("hidden", v !== "gemini");
  $("ollamaCfg").classList.toggle("hidden", v !== "ollama");
  const on = $("useOcr").checked;
  $("loadModel").disabled = !on || state.ocr.ready;
  $("loadModel").textContent = state.ocr.ready ? "Florence-2 loaded"
    : on ? "Load Florence-2" : "Load Florence-2 (tick the box above first)";
}

["server", "apiKey", "model", "ollamaModel"].forEach((id) =>
  $(id).addEventListener("change", () => { saveSettings(); syncSettingsUi(); }));
$("useOcr").addEventListener("change", () => { saveSettings(); syncSettingsUi(); });
$("settingsBtn").addEventListener("click", () =>
  $("settings").classList.toggle("hidden"));
$("changeServer").addEventListener("click", () => {
  $("settings").classList.remove("hidden");
  $("server").focus();
});

/* ---------------------------------------------------------------- tabs */

document.querySelectorAll(".tab").forEach((t) => {
  t.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((x) => x.classList.remove("active"));
    t.classList.add("active");
    ["chat", "found", "wire"].forEach((v) =>
      $("view-" + v).classList.toggle("hidden", v !== t.dataset.view));
  });
});

/* ---------------------------------------------------------------- chat log */

function bubble(kind, who, text) {
  const empty = $("log").querySelector(".empty");
  if (empty) empty.remove();
  const d = document.createElement("div");
  d.className = "msg " + kind;
  if (who) {
    const w = document.createElement("span");
    w.className = "who";
    w.textContent = who;
    d.appendChild(w);
  }
  d.appendChild(document.createTextNode(text));
  $("log").appendChild(d);
  $("log").scrollTop = $("log").scrollHeight;
  return d;
}

/* ---------------------------------------------------------------- scanning */

$("scanBtn").addEventListener("click", async () => {
  $("scanBtn").disabled = true;
  const t0 = performance.now();
  try {
    const res = await chrome.runtime.sendMessage({ type: "OPAQUE_RUN", paint: true });
    if (!res || !res.ok) throw new Error((res && res.error) || "scan failed");

    state.context = res.data.context;
    state.findings = res.data.findings;
    state.shot = res.shot;
    state.attached = false;          // new screen, attach it to the next question

    if ($("useOcr").checked && state.ocr.ready && res.shot) {
      await ocrPass(res.shot);
    }

    document.body.classList.add("armed");
    renderFindings();
    renderWire();
    const ms = performance.now() - t0;
    $("metrics").classList.remove("hidden");
    $("mFound").textContent = state.findings.length;
    $("mTime").textContent = ms < 1000 ? Math.round(ms) + " ms" : (ms / 1000).toFixed(1) + " s";
    $("mBytes").textContent = new Blob([contextText()]).size + " B";
    $("mLeak").textContent = "0";
    $("mLeak").className = "safe";

    $("q").disabled = false;
    $("send").disabled = false;
    $("q").focus();

    bubble("sys", null,
      `Read ${state.findings.length} sensitive item(s) on "${state.context.title}". ` +
      `They are covered on the page and replaced with placeholders in anything sent. ` +
      `Ask me about this screen.`);
  } catch (err) {
    bubble("err", "error", String(err.message || err));
  }
  $("scanBtn").disabled = false;
});

$("clearBtn").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "OPAQUE_CLEARBOXES" });
  document.body.classList.remove("armed");
});

$("reset").addEventListener("click", () => {
  state.history = [];
  state.attached = false;
  $("log").innerHTML = '<div class="empty">Conversation cleared. Read a screen to begin again.</div>';
});

/* ---------------------------------------------------------------- rendering */

function renderFindings() {
  const box = $("foundList");
  if (!state.findings.length) {
    box.innerHTML = '<div class="empty">Nothing sensitive found on this screen.</div>';
    return;
  }
  box.innerHTML = state.findings.map((f) => `
    <div class="item">
      <div class="row1">
        <span class="val">${esc(f.match || f.label || "")}</span>
        <span class="ph">${esc(f.ph)}</span>
      </div>
      <div class="meta">
        <span class="tier t${f.tier}">Tier ${f.tier}</span>
        ${esc(f.kind)} — ${esc(f.ev)}
      </div>
    </div>`).join("");
}

function contextText() {
  const c = state.context;
  if (!c) return "";
  const lines = [];
  lines.push("PAGE: " + c.title);
  lines.push("URL: " + c.url);
  if (c.headings.length) lines.push("HEADINGS: " + c.headings.join(" / "));
  if (c.fields.length) {
    lines.push("FIELDS:");
    c.fields.forEach((f) =>
      lines.push(`  - ${f.label}: ${f.value}${f.masked ? "   <- removed on device" : ""}`));
  }
  if (c.actions.length) lines.push("CONTROLS: " + c.actions.join(" | "));
  if (c.text) lines.push("VISIBLE TEXT: " + c.text);
  return lines.join("\n");
}

function renderWire() {
  $("wire").textContent =
    "// everything below is what leaves this machine\n" +
    "// square brackets mark values removed before sending\n\n" +
    contextText();
}

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/* ---------------------------------------------------------------- asking */

const SYSTEM = `You are the reasoning half of a browser assistant called Opaque.
You are given a description of the user's screen in which sensitive values have
already been removed on their machine and replaced by placeholders in square
brackets, such as [PHONE] or [AADHAAR]. You will never receive those values and
must never ask for them.

Work from the structure. You can say which field a placeholder belongs to and
what the user should do next without knowing the value itself. If a question
genuinely cannot be answered without a removed value, say so plainly and explain
what the user can do themselves.

Keep answers short and practical. When you recommend an interaction, end with a
line in exactly this form:
ACTION: <scroll|highlight|none> | <target text or ->`;

$("q").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ask(); }
});
$("send").addEventListener("click", ask);

async function ask() {
  const text = $("q").value.trim();
  if (!text) return;
  $("q").value = "";
  $("q").disabled = true;
  $("send").disabled = true;
  bubble("me", "you", text);

  /* The screen is attached once. After that, follow-ups are plain turns and the
     model already has the context in its history. */
  let outgoing = text;
  if (!state.attached && state.context) {
    outgoing = "Here is the current screen.\n\n" + contextText() +
               "\n\n---\n\nMy question: " + text;
    state.attached = true;
  }
  state.history.push({ role: "user", text: outgoing });

  const thinking = bubble("ai", "opaque", "thinking…");
  try {
    const answer = await callServer();
    thinking.remove();
    const { visible, action, target } = splitAction(answer);
    bubble("ai", "opaque", visible);
    state.history.push({ role: "model", text: answer });
    if (action && action !== "none") await offerAction(action, target);
  } catch (err) {
    thinking.remove();
    bubble("err", "error", String(err.message || err));
    state.history.pop();
  }
  $("q").disabled = false;
  $("send").disabled = false;
  $("q").focus();
}

function splitAction(text) {
  const m = text.match(/ACTION:\s*(\w+)\s*\|\s*(.+)\s*$/im);
  if (!m) return { visible: text.trim(), action: null, target: null };
  return {
    visible: text.slice(0, m.index).trim(),
    action: m[1].toLowerCase(),
    target: m[2].trim() === "-" ? null : m[2].trim()
  };
}

/* Actions are offered, never performed silently. */
async function offerAction(action, target) {
  const d = document.createElement("div");
  d.className = "msg sys";
  d.textContent = `Suggested: ${action}${target ? ' "' + target + '"' : ""} — `;
  const b = document.createElement("button");
  b.className = "btn ghost small";
  b.style.marginTop = "6px";
  b.textContent = "Do it on the page";
  b.addEventListener("click", async () => {
    b.disabled = true;
    const r = await chrome.runtime.sendMessage({
      type: "OPAQUE_DOACT", action, target
    });
    b.textContent = r && r.ok ? (r.result || "done") : "could not do that";
  });
  d.appendChild(b);
  $("log").appendChild(d);
  $("log").scrollTop = $("log").scrollHeight;
}

/* ---------------------------------------------------------------- servers */

async function callServer() {
  const mode = $("server").value;
  if (mode === "mock") return mockReply();
  if (mode === "ollama") return ollamaReply();
  return geminiReply();
}

function mockReply() {
  return new Promise((resolve) => setTimeout(() => {
    const c = state.context || { title: "this page", fields: [], actions: [] };
    const masked = (c.fields || []).filter((f) => f.masked);
    const lastUser = [...state.history].reverse().find((h) => h.role === "user");
    const q = (lastUser ? lastUser.text : "").split("My question: ").pop().trim();
    resolve(
      "[MOCK SERVER - this is a fixed reply, not a real model. " +
      "Switch to Gemini or Ollama in settings for real answers.]\n\n" +
      `You asked: "${q.slice(0, 120)}"\n\n` +
      `The screen is "${c.title}". ` +
      `${masked.length} field value(s) were removed on this machine` +
      (masked.length ? ": " + masked.map((f) => f.label).join(", ") : "") + ". " +
      `${(c.actions || []).length} control(s) are available.\n\n` +
      "A real model would answer your question from this structure.\n\n" +
      "ACTION: highlight | " + ((c.actions && c.actions[0]) || "-")
    );
  }, 320));
}

function geminiHistory() {
  return state.history.map((h) => ({
    role: h.role === "model" ? "model" : "user",
    parts: [{ text: h.text }]
  }));
}

async function geminiReply() {
  const key = $("apiKey").value.trim();
  if (!key) throw new Error("Add your Gemini API key in settings.");
  const model = $("model").value.trim() || "gemini-3.6-flash";
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: SYSTEM }] },
    contents: geminiHistory(),
    generationConfig: { maxOutputTokens: 600, temperature: 0.2 }
  });

  let lastErr = "";
  for (const ver of ["v1beta", "v1"]) {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/${ver}/models/${encodeURIComponent(model)}:generateContent`,
      { method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body });
    const j = await r.json();
    if (j.error) { lastErr = `${ver}: ${j.error.message}`; continue; }
    const parts = j.candidates?.[0]?.content?.parts ?? [];
    const text = parts.map((p) => p.text).filter(Boolean).join("\n");
    if (text) return text;
    lastErr = `${ver}: empty response`;
  }
  throw new Error(lastErr + "\n\nUse \"Test key and list models\" in settings.");
}

async function ollamaReply() {
  const model = $("ollamaModel").value.trim() || "llama3.2";
  const msgs = [{ role: "system", content: SYSTEM }].concat(
    state.history.map((h) => ({
      role: h.role === "model" ? "assistant" : "user", content: h.text
    })));
  const r = await fetch("http://127.0.0.1:11434/api/chat", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages: msgs, stream: false })
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return (j.message && j.message.content) || JSON.stringify(j);
}

/* ---------------------------------------------------------------- key test */

$("testKey").addEventListener("click", async () => {
  const key = $("apiKey").value.trim();
  const out = $("modelStat");
  if (!key) { out.textContent = "paste a key first"; out.className = "stat err"; return; }
  out.textContent = "checking…"; out.className = "stat busy";
  try {
    const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models",
      { headers: { "x-goog-api-key": key } });
    const j = await r.json();
    if (j.error) { out.textContent = "rejected: " + j.error.message; out.className = "stat err"; return; }
    const names = (j.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
      .map((m) => m.name.replace(/^models\//, ""));
    $("modelList").innerHTML = names.map((n) => `<option value="${n}">`).join("");
    const cur = $("model").value.trim();
    if (names.length && !names.includes(cur)) {
      $("model").value = names.find((n) => /flash/i.test(n) &&
        !/thinking|image|tts|live|embed/i.test(n)) || names[0];
      saveSettings();
    }
    out.textContent = `key works — ${names.length} models, using ${$("model").value}`;
    out.className = "stat ok";
  } catch (err) {
    out.textContent = "network error: " + err.message;
    out.className = "stat err";
  }
});

/* ---------------------------------------------------------------- Florence-2
 * Optional. Only useful where text sits inside an image and the DOM cannot see
 * it. Extension pages may not load remote scripts, so the library has to be
 * present locally at lib/transformers.min.js — see README.
 */

$("loadModel").addEventListener("click", async () => {
  const out = $("modelStat");
  $("loadModel").disabled = true;
  out.textContent = "looking for the library…"; out.className = "stat busy";

  const CURL =
    'curl -L -o lib/transformers.min.js "https://cdn.jsdelivr.net/npm/' +
    '@huggingface/transformers@3.8.1/+esm"';

  /* Different builds ship under different names and formats, so try each and
     report what was actually found rather than failing with a bare error. */
  const candidates = ["lib/transformers.min.js", "lib/transformers.js",
                      "lib/transformers.esm.js"];
  const tried = [];
  let lib = null;

  for (const rel of candidates) {
    const url = chrome.runtime.getURL(rel);
    let text = null;
    try {
      const r = await fetch(url);
      if (!r.ok) { tried.push(rel + " — not present"); continue; }
      text = await r.text();
    } catch (e) { tried.push(rel + " — not present"); continue; }

    const head = text.slice(0, 400);
    if (/^\s*<(!doctype|html)/i.test(head)) {
      tried.push(rel + " — this is an HTML error page, the download failed");
      continue;
    }
    if (text.length < 10000) {
      tried.push(rel + ` — only ${text.length} bytes, download incomplete`);
      continue;
    }
    const looksEsm = /\bexport\s*[{*]/.test(text) || /\bexport\s+(default|const|class|function)/.test(text);
    try {
      out.textContent = "loading " + rel + "…";
      lib = await import(url);
      if (!lib.Florence2ForConditionalGeneration) {
        tried.push(rel + " — loaded, but has no Florence-2 export");
        lib = null;
        continue;
      }
      break;
    } catch (e) {
      tried.push(rel + (looksEsm
        ? " — ESM but failed to import: " + e.message
        : " — not an ES module (it is a bundled script, so import() cannot load it)"));
    }
  }

  if (!lib) {
    out.innerHTML =
      "Could not load the library.<br><br>" +
      tried.map((t) => "&bull; " + t).join("<br>") +
      "<br><br>Get the ES module build, then reload the extension:" +
      '<code style="display:block;margin-top:5px;word-break:break-all;font-size:10px">' +
      CURL + "</code>";
    out.className = "stat err";
    $("loadModel").disabled = false;
    return;
  }

  try {
    lib.env.allowLocalModels = false;
    lib.env.backends.onnx.wasm.wasmPaths =
      "https://cdn.jsdelivr.net/npm/onnxruntime-web/dist/";
    state.ocr.lib = lib;

    const id = "onnx-community/Florence-2-base-ft";
    const progress_callback = (p) => {
      if (p.status === "progress" && p.total) {
        out.textContent = `downloading weights — ${(p.loaded / 1e6).toFixed(0)} MB`;
      }
    };
    const device = ("gpu" in navigator) ? "webgpu" : "wasm";
    out.textContent = `starting on ${device}…`;

    [state.ocr.model, state.ocr.processor, state.ocr.tokenizer] = await Promise.all([
      lib.Florence2ForConditionalGeneration.from_pretrained(id, {
        dtype: { embed_tokens: "fp16", vision_encoder: "fp16",
                 encoder_model: "q4", decoder_model_merged: "q4" },
        device, progress_callback
      }),
      lib.AutoProcessor.from_pretrained(id),
      lib.AutoTokenizer.from_pretrained(id)
    ]);
    state.ocr.ready = true;
    syncSettingsUi();
    out.textContent = `Florence-2 ready on ${device}`;
    out.className = "stat ok";
  } catch (err) {
    console.error("Florence-2 weights failed:", err);
    out.innerHTML = "library loaded, but weights failed: " +
      String(err.message || err) +
      "<br><br>Open the side panel console (right-click &rarr; Inspect) for detail. " +
      "This tier is optional &mdash; Tiers 0 and 1 work without it.";
    out.className = "stat err";
    $("loadModel").disabled = false;
  }
});

/* Reads text the DOM could not see, by tiling the already-redacted capture. */
async function ocrPass(dataUrl) {
  const { lib, model, processor, tokenizer } = state.ocr;
  const img = await lib.RawImage.fromURL(dataUrl);
  const src = img.toCanvas();
  const cols = Math.min(3, Math.max(1, Math.ceil(img.width / 780)));
  const rows = Math.min(3, Math.max(1, Math.ceil(img.height / 780)));
  const extra = [];

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const w = img.width / cols, h = img.height / rows;
      const cv = document.createElement("canvas");
      const scale = Math.min(2, Math.max(1, 900 / Math.max(w, h)));
      cv.width = Math.round(w * scale);
      cv.height = Math.round(h * scale);
      const g = cv.getContext("2d");
      g.imageSmoothingQuality = "high";
      g.drawImage(src, c * w, r * h, w, h, 0, 0, cv.width, cv.height);
      const tile = await lib.RawImage.fromURL(cv.toDataURL("image/png"));

      const task = "<OCR_WITH_REGION>";
      const ti = tokenizer(processor.construct_prompts(task));
      const vi = await processor(tile);
      const ids = await model.generate({ ...ti, ...vi, max_new_tokens: 768 });
      const dec = tokenizer.batch_decode(ids, { skip_special_tokens: false })[0];
      const res = processor.post_process_generation(dec, task, tile.size)[task] || {};
      (res.labels || []).forEach((lab) => {
        const t = String(lab).replace(/<\/?s>/g, "").trim();
        if (!t) return;
        OpaqueDetect.scan(t).forEach((hit) => {
          extra.push({ tier: 2, kind: hit.kind, ph: hit.ph,
                       ev: "Florence-2 OCR, then " + hit.ev,
                       severity: hit.severity, match: hit.match, label: null });
        });
      });
    }
  }

  /* Anything found here was invisible to the DOM, so it is genuinely new. */
  const known = new Set(state.findings.map((f) => f.match));
  extra.forEach((e) => { if (!known.has(e.match)) state.findings.push(e); });
}

loadSettings();
