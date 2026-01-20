const list = document.getElementById("list");
const video = document.getElementById("video");
const overlay = document.getElementById("overlay");
const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const statusText = document.getElementById("statusText");
const lastHit = document.getElementById("lastHit");

const LS_KEY = "opc_collection_artscan_v1";
let collection = JSON.parse(localStorage.getItem(LS_KEY) || "[]");

let db = null;            // hashes.json
let stream = null;
let rafId = null;

const work = document.createElement("canvas");
const wctx = work.getContext("2d", { willReadFrequently: true });

let lastScanAt = 0;
const COOLDOWN_MS = 900;

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
      save(); render();
    };
    list.appendChild(li);
  }
}
function setStatus(s, extra="") {
  statusText.textContent = s;
  lastHit.textContent = extra;
}

async function loadHashes() {
  const r = await fetch("./hashes.json", { cache: "no-store" });
  if (!r.ok) throw new Error("hashes.json nicht gefunden");
  const data = await r.json();
  if (!Array.isArray(data)) throw new Error("hashes.json Format falsch");
  return data;
}

function stopAll() {
  if (rafId) cancelAnimationFrame(rafId);
  rafId = null;

  if (stream) {
    stream.getTracks().forEach(t => t.stop());
    stream = null;
  }
  video.srcObject = null;

  stopBtn.hidden = true;
  startBtn.hidden = false;

  const octx = overlay.getContext("2d");
  octx.clearRect(0, 0, overlay.width, overlay.height);

  setStatus("bereit");
}

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

    setStatus("läuft", "Karte mittig halten – wird automatisch erkannt.");
    loop();
  } catch (e) {
    alert("Start fehlgeschlagen. Prüfe: hashes.json vorhanden + Kamera in Safari erlaubt.");
    console.error(e);
    stopAll();
  }
};

stopBtn.onclick = stopAll;

function loop() {
  wctx.drawImage(video, 0, 0, work.width, work.height);

  drawGuide();

  if (Date.now() - lastScanAt > COOLDOWN_MS) {
    lastScanAt = Date.now();
    scanFrame();
  }

  rafId = requestAnimationFrame(loop);
}

function drawGuide() {
  const octx = overlay.getContext("2d");
  octx.clearRect(0, 0, overlay.width, overlay.height);

  // Zielrahmen für Karte (UI)
  octx.lineWidth = 5;
  octx.strokeStyle = "rgba(255,255,255,0.22)";
  const padX = overlay.width * 0.12;
  const padY = overlay.height * 0.10;
  octx.strokeRect(padX, padY, overlay.width - 2*padX, overlay.height - 2*padY);

  // Artwork-Fenster (wo wir hashen)
  const art = artworkRect();
  octx.lineWidth = 6;
  octx.strokeStyle = "rgba(37,99,235,0.85)";
  octx.strokeRect(art.x, art.y, art.w, art.h);
}

function artworkRect() {
  // Wir nehmen einen stabilen Bereich in der Kartenmitte (Artwork),
  // relativ zum Video. Das ist “ManaBox-like” (art-based).
  const W = work.width, H = work.height;

  const x = Math.round(W * 0.22);
  const y = Math.round(H * 0.20);
  const w = Math.round(W * 0.56);
  const h = Math.round(H * 0.42);

  return { x, y, w, h };
}

function scanFrame() {
  // crop artwork to canvas
  const r = artworkRect();
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 192;
  const ctx = c.getContext("2d");
  ctx.drawImage(work, r.x, r.y, r.w, r.h, 0, 0, c.width, c.height);

  // compute hash
  const q = aHashFromCanvas(c);

  // match
  const best = bestMatch(q, db);

  // Threshold: je kleiner desto besser. 0 = identisch.
  // aHash ist simpel, daher konservativ:
  if (!best || best.d > 10) {
    setStatus("läuft", `kein Match (d=${best ? best.d : "?"})`);
    return;
  }

  // add to collection
  addOrInc(best.id);

  setStatus("Hinzugefügt", `${best.id} (d=${best.d})`);
  try { navigator.vibrate?.(30); } catch {}
}

function addOrInc(cardId) {
  const idx = collection.findIndex(x => x.cardId === cardId);
  if (idx >= 0) collection[idx].qty += 1;
  else collection.unshift({ cardId, qty: 1 });
  save();
  render();
}

// --- Hashing ---
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
    const r = img[i*4], g = img[i*4+1], b = img[i*4+2];
    gray[i] = (r*0.299 + g*0.587 + b*0.114) | 0;
  }

  let sum = 0;
  for (const v of gray) sum += v;
  const avg = sum / gray.length;

  let bits = "";
  for (const v of gray) bits += (v >= avg) ? "1" : "0";

  let hex = "";
  for (let i = 0; i < 64; i += 4) {
    hex += parseInt(bits.slice(i, i+4), 2).toString(16);
  }
  return hex;
}

function hammingHex(a, b) {
  let dist = 0;
  for (let i = 0; i < a.length; i++) {
    const x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    dist += ((x & 1) + ((x>>1)&1) + ((x>>2)&1) + ((x>>3)&1));
  }
  return dist;
}

function bestMatch(queryHash, db) {
  let best = null;
  for (const item of db) {
    const d = hammingHex(queryHash, item.hash);
    if (!best || d < best.d) best = { id: item.id, d };
  }
  return best;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, m => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[m]));
}

render();
setStatus("bereit");
