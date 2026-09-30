const FACE_MODEL = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
const WASM_ROOT = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.17/wasm";
const lerp = (a,b,t)=>a+(b-a)*t;
const clamp = (v,lo,hi)=>Math.max(lo,Math.min(hi,v));

export class PhotoAvatar {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.img = null;
    this.mouth = null;
    this.ready = false;
    this.talk = { open: 0, energy: 0 };
    this.speaking = false;
    this.debug = false;
    this._t0 = performance.now();
    this._blinkUntil = 0;
    this._nextBlink = 1200;
    this._raf = 0;
    this._lm = null;
  }
  async initLandmarker() {
    if (this._lm) return this._lm;
    const mod = await import("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.17/+esm");
    const vision = await mod.FilesetResolver.forVisionTasks(WASM_ROOT);
    this._lm = await mod.FaceLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: FACE_MODEL },
      runningMode: "IMAGE",
      numFaces: 1
    });
    return this._lm;
  }
  async loadFile(file) {
    const url = URL.createObjectURL(file);
    try { await this.loadUrl(url); } finally { URL.revokeObjectURL(url); }
  }
  async loadUrl(url) {
    const img = await new Promise((res, rej) => {
      const el = new Image();
      el.onload = () => res(el);
      el.onerror = () => rej(new Error("圖片讀取失敗"));
      el.src = url;
    });
    await this.initLandmarker();
    const det = this._lm.detect(img);
    if (!det.faceLandmarks || !det.faceLandmarks[0]) throw new Error("沒偵測到臉，請換正面清楚照片");
    const lm = det.faceLandmarks[0];
    const w = img.naturalWidth, h = img.naturalHeight;
    const p = (i) => ({ x: lm[i].x * w, y: lm[i].y * h });
    const L = p(61), R = p(291), U = p(13), D = p(14);
    this.img = img;
    this.mouth = {
      x: Math.min(L.x, R.x) - 8,
      y: Math.min(U.y, D.y) - 10,
      w: Math.abs(R.x - L.x) + 16,
      h: Math.max(18, Math.abs(D.y - U.y) + 24)
    };
    this.ready = true;
    this._resize();
    this.start();
  }
  _resize() {
    if (!this.img) return;
    const wrap = this.canvas.parentElement;
    const maxW = wrap ? wrap.clientWidth : 720;
    const maxH = wrap ? wrap.clientHeight : 720;
    const s = Math.min(maxW / this.img.naturalWidth, maxH / this.img.naturalHeight, 1);
    this.canvas.width = Math.round(this.img.naturalWidth * s);
    this.canvas.height = Math.round(this.img.naturalHeight * s);
  }
  setAudioEnergy(sample) {
    const rms = clamp(sample.rms || 0, 0, 1);
    this.talk.open = lerp(this.talk.open, clamp(rms * 1.4, 0, 1), 0.4);
    this.talk.energy = rms;
    this.speaking = rms > 0.04;
  }
  playSpeech(text, dur) { this.speaking = true; this._speechT0 = performance.now(); this._speechDur = Math.max(0.4, dur || 1); }
  stopSpeech() { this.speaking = false; this.talk.open = 0; this.talk.energy = 0; }
  start() {
    if (this._raf) return;
    const tick = (now) => { this._raf = requestAnimationFrame(tick); this.draw(now); };
    this._raf = requestAnimationFrame(tick);
  }
  draw(now) {
    if (!this.ready) return;
    this._resize();
    const ctx = this.ctx, img = this.img, t = (now - this._t0) / 1000;
    const sx = this.canvas.width / img.naturalWidth;
    const sy = this.canvas.height / img.naturalHeight;
    const amp = this.speaking ? 0.35 : 1;
    const swayX = Math.sin(t * 0.7) * 6 * amp;
    const swayY = Math.sin(t * 1.15) * 4 * amp;
    const roll = Math.sin(t * 0.45) * 0.012 * amp;
    if (now > this._nextBlink) { this._blinkUntil = now + 120; this._nextBlink = now + 2500 + Math.random() * 3000; }
    const blink = now < this._blinkUntil ? Math.sin(clamp((this._blinkUntil - now) / 120, 0, 1) * Math.PI) : 0;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.save();
    ctx.translate(this.canvas.width / 2 + swayX, this.canvas.height / 2 + swayY);
    ctx.rotate(roll);
    ctx.scale(sx, sy);
    ctx.translate(-img.naturalWidth / 2, -img.naturalHeight / 2);
    ctx.drawImage(img, 0, 0);
    const m = this.mouth;
    const open = this.talk.open;
    if (open > 0.04 && m) {
      ctx.save();
      ctx.beginPath();
      ctx.ellipse(m.x + m.w / 2, m.y + m.h / 2, m.w * 0.42, m.h * (0.25 + open * 0.7), 0, 0, Math.PI * 2);
      ctx.clip();
      ctx.fillStyle = "rgba(40,18,22,0.55)";
      ctx.fillRect(m.x, m.y, m.w, m.h);
      ctx.restore();
    }
    if (blink > 0.15) {
      ctx.fillStyle = "rgba(20,16,18," + (0.35 * blink) + ")";
      ctx.fillRect(0, img.naturalHeight * 0.32, img.naturalWidth, img.naturalHeight * 0.08);
    }
    ctx.restore();
  }
}

export class AudioPuppeteer {
  constructor(avatar) { this.avatar = avatar; this.ctx = null; this.analyser = null; this.src = null; }
  attach(audioEl) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!this.ctx) this.ctx = new AC();
    if (this.ctx.state === "suspended") this.ctx.resume();
    if (this.src) try { this.src.disconnect(); } catch (e) {}
    this.src = this.ctx.createMediaElementSource(audioEl);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.src.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);
    this._time = new Uint8Array(this.analyser.fftSize);
    const step = () => {
      requestAnimationFrame(step);
      if (!this.analyser) return;
      this.analyser.getByteTimeDomainData(this._time);
      let s = 0;
      for (let i = 0; i < this._time.length; i++) { const v = (this._time[i] - 128) / 128; s += v * v; }
      this.avatar.setAudioEnergy({ rms: Math.min(1, Math.sqrt(s / this._time.length) * 3.2) });
    };
    requestAnimationFrame(step);
  }
}
