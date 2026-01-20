const list = document.getElementById("list");
const video = document.getElementById("video");
const overlay = document.getElementById("overlay");
const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const statusText = document.getElementById("statusText");
const lastHit = document.getElementById("lastHit");

const LS_KEY = "opc_collection_v1";

// Sammlung: wir speichern NUR Daten, kein Bild
let collection = JSON.parse(localStorage.getItem(LS_KEY) || "[]");

// Kamera / Loop
let stream = null;
let rafId = null;

// Work canvas (Frames)
const work = document.createElement("canvas");
const wctx = work.getContext("2d", { willReadFrequently: true });

// Stabilitätslogik
let stableCount = 0;
let lastRect = null;
let lastScanAt = 0;
const SCAN_COOLDOWN_MS = 2000;

// OCR Worker (einmal initialisieren, sonst zu langsam)
let ocrReady = false;
let ocrWorker = null;

function save() {
  localStorage.setItem(LS_KEY, JSON.stringify(collection));
}

function render() {
  list.innerHTML = "";
  collection.forEach((c, i) => {
    const li = document.createElement("li");
    li.innerHTML = `<strong>${escapeHtml(c.name || c.cardId)}</strong>
      <div class="meta">${escapeHtml(c.cardId)} • x${c.qty} • ${escapeHtml(c.set || "")}</div>`;
    li.onclick = () => {
      const ok = confirm(`Eintrag löschen?\n\n${c.cardId}`);
      if (!ok) return;
      collection.splice(i, 1);
      save();
      render();
    };
    list.appendChild(li);
  });
}

function setStatus(s, extra="") {
  statusText.textContent = s;
  lastHit.textContent = extra;
}

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

  stopBtn.hidden = true;
  startBtn.hidden = false;

  const octx = overlay.getContext("2d");
  octx.clearRect(0, 0, overlay.width, overlay.height);

  setStatus("bereit");
}

startBtn.onclick = async () => {
  stopAll();
  setStatus("Kamera startet...");

  try {
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

    setStatus("läuft", "Halte die Kartennummer (z.B. OP01-001) sichtbar unten ins Bild.");
    loop();
  } catch (e) {
    alert("Kamera konnte nicht geöffnet werden. Bitte in Safari erlauben. (GitHub Pages = HTTPS ist ok)");
    console.error(e);
    stopAll();
  }
};

stopBtn.onclick = stopAll;

async function ensureOCR() {
  if (ocrReady) return;
  setStatus("OCR wird vorbereitet...");
  ocrWorker = await Tesseract.createWorker("eng");
  // Wir beschränken Zeichen auf das, was wir brauchen → schneller/robuster
  await ocrWorker.setParameters({
    tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-",
  });
  ocrReady = true;
  setStatus("läuft", "OCR bereit.");
}

function loop() {
  wctx.drawImage(video, 0, 0, work.width, work.height);
  const img = wctx.getImageData(0, 0, work.width, work.height);

  const rect = detectCardRect(img, work.width, work.height);
  drawOverlay(rect);
  maybeAutoScan(rect);

  rafId = requestAnimationFrame(loop);
}

function drawOverlay(rect) {
  const octx = overlay.getContext("2d");
  octx.clearRect(0, 0, overlay.width, overlay.height);

  // Zielrahmen
  octx.lineWidth = 4;
  octx.strokeStyle = "rgba(255,255,255,0.25)";
  const padX = overlay.width * 0.10;
  const padY = overlay.height * 0.12;
  octx.strokeRect(padX, padY, overlay.width - 2*padX, overlay.height - 2*padY);

  if (!rect) return;

  // erkannte Karte
  octx.lineWidth = 6;
  octx.strokeStyle = "rgba(37,99,235,0.85)";
  octx.strokeRect(rect.x, rect.y, rect.w, rect.h);
}

function maybeAutoScan(rect) {
  if (!rect) { stableCount = 0; lastRect = null; return; }

  const areaRatio = (rect.w * rect.h) / (work.width * work.height);
  if (areaRatio < 0.12) { stableCount = 0; lastRect = rect; return; }

  if (lastRect) {
    const tol = Math.max(8, Math.round(work.width * 0.01));
    const dx = Math.abs(rect.x - lastRect.x);
    const dy = Math.abs(rect.y - lastRect.y);
    const dw = Math.abs(rect.w - lastRect.w);
    const dh = Math.abs(rect.h - lastRect.h);

    if (dx < tol && dy < tol && dw < tol && dh < tol) stableCount++;
    else stableCount = 0;
  }
  lastRect = rect;

  if (Date.now() - lastScanAt < SCAN_COOLDOWN_MS) return;

  // ~0.5s stabil
  if (stableCount >= 18) {
    stableCount = 0;
    lastScanAt = Date.now();
    autoOCRAndAdd(rect).catch(console.error);
  }
}

// === Hier passiert der “ManaBox”-Moment: Karte erkannt → Code gelesen → Daten geholt → Sammlung +1 ===
async function autoOCRAndAdd(rect) {
  await ensureOCR();
  setStatus("scannt...", "Lese Kartencode...");

  // Wir OCR’en nur den unteren Streifen der Karte (da steht der Code)
  const crop = cropBottomStrip(rect);

  // OCR
  const { data } = await ocrWorker.recognize(crop);
  const raw = (data.text || "").toUpperCase().replace(/\s+/g, " ").trim();

  // Code-Regex (OPxx-xxx, STxx-xxx, EBxx-xxx, PRB-xx?, P-xxx etc. → wir starten pragmatisch)
  const code = extractCardId(raw);

  if (!code) {
    setStatus("läuft", `Kein Code gefunden. OCR: ${raw.slice(0, 80)}`);
    return;
  }

  setStatus("gefunden!", `Code: ${code} (hole Kartendaten...)`);

  // Kartendaten holen (Beispiel: OPTCG API)
  const card = await fetchCardData(code);

  // In Sammlung adden (nur Daten!)
  addOrIncrement({
    cardId: code,
    name: card?.name || code,
    set: card?.set || card?.set_name || "",
  });

  setStatus("läuft", `Hinzugefügt: ${code} • ${card?.name || ""}`);
  try { navigator.vibrate?.(40); } catch {}
}

function cropBottomStrip(rect) {
  // Aus der Karte: untere ~22% (Code-Bereich)
  const stripH = Math.round(rect.h * 0.22);
  const x = clamp(rect.x, 0, work.width-1);
  const y = clamp(rect.y + rect.h - stripH, 0, work.height-1);
  const w = clamp(rect.w, 1, work.width - x);
  const h = clamp(stripH, 1, work.height - y);

  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const cctx = c.getContext("2d");

  cctx.drawImage(work, x, y, w, h, 0, 0, w, h);

  // leichte Kontrast-Hilfe (schnell & simpel)
  const img = cctx.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i=0; i<d.length; i+=4) {
    const v = (d[i]*0.299 + d[i+1]*0.587 + d[i+2]*0.114);
    const vv = v > 150 ? 255 : 0; // binarize
    d[i]=d[i+1]=d[i+2]=vv;
  }
  cctx.putImageData(img, 0, 0);

  return c;
}

function extractCardId(text) {
  // typische Formen:
  // OP01-001, OP-05? (manchmal mit/ohne Bindestrich im OCR) -> wir normalisieren
  // ST05-002
  // EB01-001
  // P-001 (Promos)
  const cleaned = text.replace(/[^A-Z0-9\- ]/g, " ");

  // erst “OP01-001” / “ST05-002” / “EB01-001”
  let m = cleaned.match(/\b(OP|ST|EB)\s*0?(\d{1,2})\s*-\s*(\d{3})\b/);
  if (m) return `${m[1]}${m[2].padStart(2,"0")}-${m[3]}`;

  // “OP01 001” ohne Bindestrich
  m = cleaned.match(/\b(OP|ST|EB)\s*0?(\d{1,2})\s+(\d{3})\b/);
  if (m) return `${m[1]}${m[2].padStart(2,"0")}-${m[3]}`;

  // Promo: P-001 / P 001
  m = cleaned.match(/\bP\s*-\s*(\d{3})\b/);
  if (m) return `P-${m[1]}`;
  m = cleaned.match(/\bP\s+(\d{3})\b/);
  if (m) return `P-${m[1]}`;

  return null;
}

async function fetchCardData(cardId) {
  // OPTCG API Beispiele: /api/sets/card/OP01-001/ und auch /api/decks/card/{card_id}/ :contentReference[oaicite:2]{index=2}
  // Wir versuchen erst “sets”, dann “decks”, dann “promos”.
  const tries = [
    `https://optcgapi.com/api/sets/card/${encodeURIComponent(cardId)}/`,
    `https://optcgapi.com/api/decks/card/${encodeURIComponent(cardId)}/`,
    `https://optcgapi.com/api/promos/card/${encodeURIComponent(cardId)}/`
  ];

  for (const url of tries) {
    try {
      const r = await fetch(url, { method: "GET" });
      if (!r.ok) continue;
      const json = await r.json();
      // API liefert je nach Endpoint Struktur; wir nehmen “best effort”
      return json;
    } catch {}
  }
  return null;
}

function addOrIncrement(card) {
  const idx = collection.findIndex(x => x.cardId === card.cardId);
  if (idx >= 0) collection[idx].qty += 1;
  else collection.unshift({ ...card, qty: 1, createdAt: new Date().toISOString() });
  save();
  render();
}

/**
 * Simple Rechteck-Erkennung (wie vorher): gut genug, um “Karte im Bild” zu stabilisieren.
 */
function detectCardRect(imageData, W, H) {
  const DS = 3;
  const w = Math.floor(W / DS);
  const h = Math.floor(H / DS);

  const gray = new Uint8Array(w * h);
  const data = imageData.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx = x * DS, sy = y * DS;
      const idx = (sy * W + sx) * 4;
      const r = data[idx], g = data[idx+1], b = data[idx+2];
      gray[y*w+x] = (r*0.299 + g*0.587 + b*0.114) | 0;
    }
  }

  const mag = new Uint16Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y*w+x;
      const gx =
        -gray[i-w-1] - 2*gray[i-1] - gray[i+w-1] +
         gray[i-w+1] + 2*gray[i+1] + gray[i+w+1];
      const gy =
        -gray[i-w-1] - 2*gray[i-w] - gray[i-w+1] +
         gray[i+w-1] + 2*gray[i+w] + gray[i+w+1];
      mag[i] = Math.abs(gx) + Math.abs(gy);
    }
  }

  let sum=0,cnt=0;
  for (let i=0;i<mag.length;i+=23){ sum+=mag[i]; cnt++; }
  const mean = sum/cnt;
  const thresh = mean*2.2;

  const marginX = Math.floor(w*0.05);
  const marginY = Math.floor(h*0.06);

  let minX=w, minY=h, maxX=0, maxY=0, hits=0;

  for (let y=marginY;y<h-marginY;y++){
    for (let x=marginX;x<w-marginX;x++){
      const i=y*w+x;
      if (mag[i] > thresh){
        hits++;
        if (x<minX) minX=x;
        if (y<minY) minY=y;
        if (x>maxX) maxX=x;
        if (y>maxY) maxY=y;
      }
    }
  }

  if (hits < (w*h)*0.002) return null;

  const x = minX*DS;
  const y = minY*DS;
  const rw = (maxX-minX)*DS;
  const rh = (maxY-minY)*DS;

  const ratio = rw/rh;
  if (ratio < 0.55 || ratio > 0.95) return null;
  if (rw < W*0.25 || rh < H*0.25) return null;

  return { x, y, w: rw, h: rh };
}

function clamp(v, lo, hi){ return Math.max(lo, Math.min(hi, v)); }
function escapeHtml(s){ return String(s).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }

render();
