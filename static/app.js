import { PhotoAvatar, AudioPuppeteer } from "./avatar.js";
const $ = (id) => document.getElementById(id);
const DEFAULT_SYSTEM = "你是用戶的親密陪伴者。用繁體中文短句說話，回覆1到4句。";
const store = {
  load() { try { return JSON.parse(localStorage.getItem("pc-settings") || "{}"); } catch { return {}; } },
  save(p) { const n = { ...this.load(), ...p }; localStorage.setItem("pc-settings", JSON.stringify(n)); return n; }
};
const settings = store.load();
$("apiKey").value = settings.apiKey || "";
$("baseUrl").value = settings.baseUrl || "https://api.x.ai/v1";
$("model").value = settings.model || "grok-4-latest";
$("voiceId").value = settings.voiceId || "eve";
$("language").value = settings.language || "zh";
$("persona").value = settings.persona || DEFAULT_SYSTEM;
$("useBrowserTts").checked = Boolean(settings.useBrowserTts);
const avatar = new PhotoAvatar($("stage"));
const puppeteer = new AudioPuppeteer(avatar);
const audioEl = $("speech");
let messages = [];
let recognizing = false;
let rec = null;
const local = () => ["127.0.0.1", "localhost"].includes(location.hostname);
function toast(t) {
  $("toast").textContent = t;
  $("toast").classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => $("toast").classList.remove("show"), 2800);
}
function addBubble(role, text) {
  const el = document.createElement("div");
  el.className = "bubble " + role;
  el.textContent = text;
  $("log").appendChild(el);
  $("log").scrollTop = $("log").scrollHeight;
  return el;
}
function saveForm() {
  store.save({
    apiKey: $("apiKey").value.trim(),
    baseUrl: $("baseUrl").value.trim() || "https://api.x.ai/v1",
    model: $("model").value.trim() || "grok-4-latest",
    voiceId: $("voiceId").value,
    language: $("language").value,
    persona: $("persona").value,
    useBrowserTts: $("useBrowserTts").checked
  });
}
$("saveSettings").onclick = () => { saveForm(); toast("設定已存到這個瀏覽器"); };
$("photo").onchange = async (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  $("dropHint").textContent = "正在偵測臉…";
  try {
    await avatar.loadFile(file);
    $("dropHint").textContent = "已就緒";
    $("frame").classList.add("has-photo");
    toast("臉部網格完成");
  } catch (err) {
    $("dropHint").textContent = err.message || String(err);
    toast(err.message || String(err));
  }
};
const drop = $("frame");
drop.ondragover = (e) => { e.preventDefault(); drop.classList.add("drag"); };
drop.ondragleave = () => drop.classList.remove("drag");
drop.ondrop = (e) => {
  e.preventDefault();
  drop.classList.remove("drag");
  const f = e.dataTransfer.files[0];
  if (f && f.type.startsWith("image/")) {
    $("photo").files = e.dataTransfer.files;
    $("photo").dispatchEvent(new Event("change"));
  }
};
$("debugMesh").onchange = () => { avatar.debug = $("debugMesh").checked; };
function speakBrowser(text) {
  return new Promise((resolve) => {
    if (!window.speechSynthesis) return resolve();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = (store.load().language || "zh").startsWith("zh") ? "zh-TW" : "en-US";
    const zh = speechSynthesis.getVoices().find((v) => v.lang.startsWith("zh"));
    if (zh) u.voice = zh;
    const approx = Math.max(0.8, text.length * 0.13);
    avatar.playSpeech(text, approx);
    u.onend = u.onerror = () => { avatar.stopSpeech(); resolve(); };
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
    const t0 = performance.now();
    const pump = () => {
      if (!speechSynthesis.speaking) return;
      const t = (performance.now() - t0) / (approx * 1000);
      avatar.setAudioEnergy({ rms: 0.25 + 0.2 * Math.abs(Math.sin(t * 18)), flux: 0.1, round: 0.3 });
      requestAnimationFrame(pump);
    };
    requestAnimationFrame(pump);
  });
}
async function speak(text) {
  const s = store.load();
  if (s.useBrowserTts || !s.apiKey) return speakBrowser(text);
  toast("網頁空間請勾選瀏覽器語音，或等 Grok TTS 可用");
  return speakBrowser(text);
}
async function sendText(userText) {
  const text = userText.trim();
  if (!text) return;
  saveForm();
  const s = store.load();
  addBubble("user", text);
  $("composer").value = "";
  if (!s.apiKey) { toast("請先在設定貼上 xAI API key"); return; }
  if (!messages.length) messages.push({ role: "system", content: s.persona || DEFAULT_SYSTEM });
  messages.push({ role: "user", content: text });
  const bot = addBubble("assistant", "……");
  $("send").disabled = true;
  let full = "";
  try {
    const base = (s.baseUrl || "https://api.x.ai/v1").replace(/\/$/, "");
    const res = await fetch(local() ? "/api/chat" : base + "/chat/completions", {
      method: "POST",
      headers: local()
        ? { "Content-Type": "application/json", "X-Api-Key": s.apiKey }
        : { "Content-Type": "application/json", Authorization: "Bearer " + s.apiKey },
      body: JSON.stringify(local()
        ? { baseUrl: base, model: s.model || "grok-4-latest", messages }
        : { model: s.model || "grok-4-latest", stream: true, temperature: 0.9, messages })
    });
    if (!res.ok || !res.body) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const parts = buf.split("\n");
      buf = parts.pop() || "";
      for (const line of parts) {
        const t = line.trim();
        if (!t.startsWith("data:")) continue;
        const data = t.slice(5).trim();
        if (data === "[DONE]") continue;
        try {
          const json = JSON.parse(data);
          if (json.error) throw new Error(json.error);
          const piece = (json.choices && json.choices[0] && json.choices[0].delta && json.choices[0].delta.content) || "";
          if (piece) { full += piece; bot.textContent = full; $("log").scrollTop = $("log").scrollHeight; }
        } catch (e) {
          if (String(e.message).startsWith("chat") || String(e).includes("error")) throw e;
        }
      }
    }
    if (!full) throw new Error("模型沒有回內容");
    messages.push({ role: "assistant", content: full });
    await speak(full);
  } catch (err) {
    bot.textContent = "出錯了：" + (err.message || err);
    toast(err.message || String(err));
  } finally { $("send").disabled = false; }
}
$("send").onclick = () => sendText($("composer").value);
$("composer").onkeydown = (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendText($("composer").value); }
};
$("mic").onclick = () => {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { toast("請用 Chrome 或打字"); return; }
  if (recognizing && rec) { rec.stop(); return; }
  rec = new SR();
  rec.lang = (store.load().language || "zh").startsWith("zh") ? "zh-TW" : "en-US";
  rec.interimResults = true;
  recognizing = true;
  $("mic").classList.add("hot");
  $("mic").textContent = "停";
  let finalText = "";
  rec.onresult = (ev) => {
    let interim = "";
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const p = ev.results[i][0].transcript;
      if (ev.results[i].isFinal) finalText += p; else interim += p;
    }
    $("composer").value = (finalText + interim).trim();
  };
  const stopMic = () => { recognizing = false; $("mic").classList.remove("hot"); $("mic").textContent = "聽"; };
  rec.onerror = stopMic;
  rec.onend = () => { stopMic(); if (finalText.trim()) sendText(finalText); };
  rec.start();
};
$("clearChat").onclick = () => { messages = []; $("log").innerHTML = ""; toast("對話已清空"); };
window.addEventListener("resize", () => avatar._resize());
speechSynthesis.getVoices();
