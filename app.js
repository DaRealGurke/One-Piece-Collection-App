// ===== Elements =====
const list = document.getElementById("list");
const video = document.getElementById("video");
const overlay = document.getElementById("overlay");
const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const statusText = document.getElementById("statusText");
const lastHit = document.getElementById("lastHit");

// ===== Storage (NO IMAGES STORED) =====
const LS_KEY = "opc_collection_artscan_v2";
let collection = JSON.parse(localStorage.getItem(LS_KEY) || "[]");

// ===== Hash DB =====
let db = null; // [{id, hash}, ...]

// ===== Camera / Loop =====
let stream = null;
let rafId = null;

// Work canvas for analysis (RAM only)
const work = document.createElement("canvas");
const wctx = work.getContext("2d", { willReadFrequently: true });

// Stability for card rectangle
let stableCount = 0;
let lastRect = null;

// Cooldown: avoid adding 10x
let lastScanAt = 0;
const SCAN_INTERVAL_MS = 350;     // how often we attempt matching
const ADD_COOLDOWN_MS = 1200;     // minimum time between adds

// Match threshold (aHash Hamming distance)
const MATCH_THRESHOLD = 12;       // tighter = fewer false positives
const DEBUG_TOP_K = 5;

// ===== UI =====
function setStatus(s, extra = "") {
  statusText.textContent = s;
  lastHit.textContent = extra;
}

function save() {
  localStorage.setItem(LS_KEY, JSON.stringify(collection));
}

function render() {
  list.innerHTML = "";
  for (let i = 0; i < collection.length; i++) {
    const c = collection[i];
    const li = document.createElement("li");
    li.innerHTML = `
      <strong>${escapeHtml(c.name || c.cardId)}</strong>
      <div class="meta">${escapeHtml(c.cardId)} • x${c.qty} • ${escapeHtml(c.set || "")}</div>
    `;
    li.onclick = () => {
      const ok = confirm(`Eintrag löschen?\n\n${c.cardId}`);
      if (!ok) return;
      collection.splice(i, 1);
      save();
      render();
    };
    list.appendChild(li);
  }
}

function addOrInc(cardId) {
  const idx = collection.findIndex(x => x.cardId === cardId);
  if (idx >= 0) collection[idx].qty += 1;
  else collection.unshift({ cardId, qty: 1, createdAt: new Date().toISOString() });
  save();
  render();
}

// ===== Load hashes.json =====
async function loadHashes() {
  const r = await fetch("./hashes.json", { cache: "no-store" });
  if (!r.ok) throw new Error("hashes.json nicht gefunden (404).");
  const data = await r.json();
  if (!Array.isArray(data)) throw new Error("hashes.json hat falsches Format.");
  if (data.length === 0) throw new Error("hashes.json ist leer ([]).");
  return data;
}

// ===== Start/Stop =====
startBtn.onclick = async () => {
  try {
    if (!db) {
      setStatus("lade Datenbank...", "hashes.json wird geladen");
      db = await loadHashes();
      setStatus("bereit", `Datenbank geladen: ${db.length} Karten`);
    }

    setStatus("Kamera startet...");
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false
    });

    video.srcObject = stream;
    await video.play();

    await new Promise(res => {
      if (video.videoWidth) return res();
      video.onloadedmetadata = () => res();
    });

    overlay.width = video.videoWidth;
    overlay.height = video.videoHeight;
    work.width = video.videoWidth;
    work.height = video.videoHeight;

    startBtn.hidden = true;
    stopBtn.hidden = false;

    stableCount = 0;
    lastRect = null;
    lastScanAt = 0;

    setStatus("läuft", "Karte mittig halten – wir erkennen die Karte und matchen das Artwork.");
    loop();
  } catch (e) {
    alert(String(e.message || e));
    console.error(e);
    stopAll();
  }
};

stopBtn.onclick = () => stopAll();

function stopAll() {
  if (rafId) cancelAnimationFrame(rafId);
  rafId = null;

  if (stream) {
    stream.getTracks().forEach(t => t.stop());
    stream = null;
  }
  video.srcObject = null;

  stableCount = 0;
  lastRect = null;

  startBtn.hidden = false;
  stopBtn.hidden = true;

  const octx = overlay.getContext("2d");
  octx.clearRect(0, 0, overlay.width, overlay.height);

  setStatus("bereit");
}

// ===== Main loop =====
function loop() {
  wctx.drawImage(video, 0, 0, work.width, work.height);
  const frame = wctx.getImageData(0, 0, work.width, work.height);

  const cardRect = detectCardRect(frame, work.width, work.height);
  drawOverlay(cardRect);

  // stabilize cardRect
  const stableRect = stabilize(cardRect);

  const now = Date.now();
  if (stableRect && (now - lastScanAt) > SCAN_INTERVAL_MS) {
    lastScanAt = now;
    tryMatch(stableRect);
  } else if (!stableRect) {
    setStatus("läuft", "keine Karte erkannt (versuch: mehr Licht / weniger Spiegelung / Karte näher)");
  }

  rafId = requestAnimationFrame(loop);
}

function stabilize(rect) {
  if (!rect) {
    stableCount = 0;
    lastRect = null;
    return null;
  }

  // must be large enough
  const areaRatio = (rect.w * rect.h) / (work.width * work.height);
  if (areaRatio < 0.12) {
    stableCount = 0;
    lastRect = rect;
    return null;
  }

  if (lastRect) {
    const tol = Math.max(10, Math.round(work.width * 0.012)); // ~1.2% width
    const dx = Math.abs(rect.x - lastRect.x);
    const dy = Math.abs(rect.y - lastRect.y);
    const dw = Math.abs(rect.w - lastRect.w);
    const dh = Math.abs(rect.h - lastRect.h);

    if (dx < tol && dy < tol && dw < tol && dh < tol) stableCount++;
    else stableCount = 0;
  } else {
    stableCount = 0;
  }

  lastRect = rect;

  // need a short stability before matching
  if (stableCount < 6) return null; // ~100-200ms depending fps
  return rect;
}

// ===== Matching =====
let lastAddAt = 0;

function tryMatch(cardRect) {
  // Crop artwork INSIDE the detected card
  const art = artworkRectFromCard(cardRect);

  // Draw small crop to canvas (for hashing)
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 192;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(work, art.x, art.y, art.w, art.h, 0, 0, c.width, c.height);

  const qHash = aHashFromCanvas(c);
  const top = topMatches(qHash, db, DEBUG_TOP_K);
  const best = top[0];

  // Always show debug top-k
  setStatus(
    "läuft",
    `Top: ${top.map(t => `${t.id}:${t.d}`).join(" | ")}`
  );

  if (!best) return;

  // Decide add
  if (best.d <= MATCH_THRESHOLD && (Date.now() - lastAddAt) > ADD_COOLDOWN_MS) {
    lastAddAt = Date.now();
    addOrInc(best.id);
    setStatus("Hinzugefügt", `${best.id} (d=${best.d})`);
    try { navigator.vibrate?.(35); } catch {}
  }
}

function artworkRectFromCard(r) {
  // Heuristic artwork area within a One Piece card
  // (works across sets better than using "video center")
  const x = Math.round(r.x + r.w * 0.12);
  const y = Math.round(r.y + r.h * 0.18);
  const w = Math.round(r.w * 0.76);
  const h = Math.round(r.h * 0.50);
  return clampRect({ x, y, w, h }, work.width, work.height);
}

// ===== Hashing (aHash, MUST match your generator) =====
function aHashFromCanvas(canvas) {
  const size = 8;
  const tmp = document.createElement("canvas");
  tmp.width = size;
  tmp.height = size;
  const tctx = tmp.getContext("2d", { willReadFrequently: true });
  tctx.drawImage(canvas, 0, 0, size, size);

  const img = tctx.getImageData(0, 0, size, size).data;
  const gray = new Uint8Array(size * size);

  for (let i = 0; i < size * size; i++) {
    const r = img[i * 4], g = img[i * 4 + 1], b = img[i * 4 + 2];
    gray[i] = (r * 0.299 + g * 0.587 + b * 0.114) | 0;
  }

  let sum = 0;
  for (const v of gray) sum += v;
  const avg = sum / gray.length;

  let bits = "";
  for (const v of gray) bits += (v >= avg) ? "1" : "0";

  let hex = "";
  for (let i = 0; i < 64; i += 4) {
    hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  }
  return hex;
}

function hammingHex(a, b) {
  let dist = 0;
  for (let i = 0; i < a.length; i++) {
    const x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    dist += ((x & 1) + ((x >> 1) & 1) + ((x >> 2) & 1) + ((x >> 3) & 1));
  }
  return dist;
}

function topMatches(queryHash, db, k = 5) {
  const best = [];
  for (const item of db) {
    const d = hammingHex(queryHash, item.hash);
    let inserted = false;
    for (let i = 0; i < best.length; i++) {
      if (d < best[i].d) {
        best.splice(i, 0, { id: item.id, d });
        inserted = true;
        break;
      }
    }
    if (!inserted) best.push({ id: item.id, d });
    if (best.length > k) best.pop();
  }
  return best;
}

// ===== Card rectangle detection (edge-based heuristic) =====
function detectCardRect(imageData, W, H) {
  const DS = 3;
  const w = Math.floor(W / DS);
  const h = Math.floor(H / DS);

  const data = imageData.data;
  const gray = new Uint8Array(w * h);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx = x * DS;
      const sy = y * DS;
      const idx = (sy * W + sx) * 4;
      const r = data[idx], g = data[idx + 1], b = data[idx + 2];
      gray[y * w + x] = (r * 0.299 + g * 0.587 + b * 0.114) | 0;
    }
  }

  const mag = new Uint16Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;

      const gx =
        -gray[i - w - 1] - 2 * gray[i - 1] - gray[i + w - 1] +
         gray[i - w + 1] + 2 * gray[i + 1] + gray[i + w + 1];

      const gy =
        -gray[i - w - 1] - 2 * gray[i - w] - gray[i - w + 1] +
         gray[i + w - 1] + 2 * gray[i + w] + gray[i + w + 1];

      mag[i] = Math.abs(gx) + Math.abs(gy);
    }
  }

  // adaptive threshold
  let sum = 0, cnt = 0;
  for (let i = 0; i < mag.length; i += 29) { sum += mag[i]; cnt++; }
  const mean = sum / cnt;
  const thresh = mean * 2.2;

  const marginX = Math.floor(w * 0.05);
  const marginY = Math.floor(h * 0.06);

  let minX = w, minY = h, maxX = 0, maxY = 0, hits = 0;

  for (let y = marginY; y < h - marginY; y++) {
    for (let x = marginX; x < w - marginX; x++) {
      const i = y * w + x;
      if (mag[i] > thresh) {
        hits++;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (hits < (w * h) * 0.002) return null;

  const x = minX * DS;
  const y = minY * DS;
  const rw = (maxX - minX) * DS;
  const rh = (maxY - minY) * DS;

  // must resemble portrait card ratio
  const ratio = rw / rh;
  if (ratio < 0.55 || ratio > 0.95) return null;

  // must be large
  if (rw < W * 0.25 || rh < H * 0.25) return null;

  return clampRect({ x, y, w: rw, h: rh }, W, H);
}

// ===== Overlay drawing =====
function drawOverlay(cardRect) {
  const octx = overlay.getContext("2d");
  octx.clearRect(0, 0, overlay.width, overlay.height);

  // Guide frame
  octx.lineWidth = 4;
  octx.strokeStyle = "rgba(255,255,255,0.20)";
  const padX = overlay.width * 0.12;
  const padY = overlay.height * 0.10;
  octx.strokeRect(padX, padY, overlay.width - 2 * padX, overlay.height - 2 * padY);

  if (!cardRect) return;

  // Card rect
  octx.lineWidth = 6;
  octx.strokeStyle = "rgba(37,99,235,0.85)";
  octx.strokeRect(cardRect.x, cardRect.y, cardRect.w, cardRect.h);

  // Artwork rect inside card
  const art = artworkRectFromCard(cardRect);
  octx.lineWidth = 5;
  octx.strokeStyle = "rgba(34,197,94,0.75)";
  octx.strokeRect(art.x, art.y, art.w, art.h);
}

// ===== Helpers =====
function clampRect(r, W, H) {
  const x = clamp(r.x, 0, W - 1);
  const y = clamp(r.y, 0, H - 1);
  const w = clamp(r.w, 1, W - x);
  const h = clamp(r.h, 1, H - y);
  return { x, y, w, h };
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, m => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[m]));
}

// ===== init =====
render();
setStatus("bereit");

