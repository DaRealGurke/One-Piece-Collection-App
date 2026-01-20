const list = document.getElementById("list");
const video = document.getElementById("video");
const overlay = document.getElementById("overlay");
const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");

let cards = JSON.parse(localStorage.getItem("cards") || "[]");
let stream = null;
let rafId = null;

// interne Canvas für Bildanalyse
const work = document.createElement("canvas");
const wctx = work.getContext("2d", { willReadFrequently: true });

let lastCaptureAt = 0;
const CAPTURE_COOLDOWN_MS = 2500;

// Stabilitätslogik
let stableCount = 0;
let lastRect = null;

function save() {
  localStorage.setItem("cards", JSON.stringify(cards));
}

function render() {
  list.innerHTML = "";
  cards.forEach((c, i) => {
    const li = document.createElement("li");
    const strong = document.createElement("strong");
    strong.textContent = c.name;
    li.appendChild(strong);

    const img = document.createElement("img");
    img.src = c.img;
    img.alt = c.name;
    li.appendChild(img);

    li.onclick = () => {
      const ok = confirm(`Karte löschen?\n\n${c.name}`);
      if (!ok) return;
      cards.splice(i, 1);
      save();
      render();
    };

    list.appendChild(li);
  });
}

function now() {
  return Date.now();
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

  // Overlay clear
  const octx = overlay.getContext("2d");
  octx.clearRect(0, 0, overlay.width, overlay.height);
}

async function startCamera() {
  stopAll();

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: "environment",
        width: { ideal: 1280 },
        height: { ideal: 720 }
      },
      audio: false
    });

    video.srcObject = stream;
    await video.play();

    startBtn.hidden = true;
    stopBtn.hidden = false;

    // Canvas Größen auf Videodimensionen setzen (nachdem Metadata da ist)
    await new Promise(res => {
      if (video.videoWidth) return res();
      video.onloadedmetadata = () => res();
    });

    // Overlay an Videogröße koppeln (wichtig: echte Pixel, nicht CSS)
    overlay.width = video.videoWidth;
    overlay.height = video.videoHeight;

    // work canvas ebenfalls
    work.width = video.videoWidth;
    work.height = video.videoHeight;

    loop();
  } catch (e) {
    alert("Kamera konnte nicht geöffnet werden. Bitte Kamera erlauben (Safari) und HTTPS nutzen (GitHub Pages ist ok).");
    console.error(e);
    stopAll();
  }
}

startBtn.onclick = startCamera;
stopBtn.onclick = stopAll;

function loop() {
  // Frame holen
  wctx.drawImage(video, 0, 0, work.width, work.height);
  const img = wctx.getImageData(0, 0, work.width, work.height);

  // Karte finden (vereinfachte Rechteck-Erkennung)
  const rect = detectCardRect(img, work.width, work.height);

  // Overlay zeichnen
  drawOverlay(rect);

  // Stabilität prüfen und ggf. auto-capture
  maybeAutoCapture(rect);

  rafId = requestAnimationFrame(loop);
}

function drawOverlay(rect) {
  const octx = overlay.getContext("2d");
  octx.clearRect(0, 0, overlay.width, overlay.height);

  // Zielrahmen (UI-Hilfe)
  octx.lineWidth = 4;
  octx.strokeStyle = "rgba(255,255,255,0.25)";
  const padX = overlay.width * 0.10;
  const padY = overlay.height * 0.12;
  octx.strokeRect(padX, padY, overlay.width - 2*padX, overlay.height - 2*padY);

  if (!rect) return;

  // Erkanntes Rechteck
  octx.lineWidth = 6;
  octx.strokeStyle = "rgba(37,99,235,0.85)";
  octx.strokeRect(rect.x, rect.y, rect.w, rect.h);
}

function maybeAutoCapture(rect) {
  if (!rect) {
    stableCount = 0;
    lastRect = null;
    return;
  }

  // Muss groß genug sein
  const area = rect.w * rect.h;
  const frameArea = work.width * work.height;
  const areaRatio = area / frameArea;

  // Karte sollte merklich im Bild sein (z.B. > 12%)
  if (areaRatio < 0.12) {
    stableCount = 0;
    lastRect = rect;
    return;
  }

  // Stabilität: Rechteck darf sich nur wenig bewegen / ändern
  if (lastRect) {
    const dx = Math.abs(rect.x - lastRect.x);
    const dy = Math.abs(rect.y - lastRect.y);
    const dw = Math.abs(rect.w - lastRect.w);
    const dh = Math.abs(rect.h - lastRect.h);

    const tol = Math.max(8, Math.round(work.width * 0.01)); // 1% Breite oder min 8px

    if (dx < tol && dy < tol && dw < tol && dh < tol) stableCount++;
    else stableCount = 0;
  } else {
    stableCount = 0;
  }

  lastRect = rect;

  // Cooldown
  if (now() - lastCaptureAt < CAPTURE_COOLDOWN_MS) return;

  // Wenn ~0.4-0.6s stabil (je nach FPS) -> capture
  if (stableCount >= 18) {
    lastCaptureAt = now();
    stableCount = 0;
    autoCaptureAndAdd(rect);
  }
}

function autoCaptureAndAdd(rect) {
  // Crop um das Rechteck herum (kleiner Rand)
  const pad = Math.round(Math.min(rect.w, rect.h) * 0.03);
  const x = clamp(rect.x - pad, 0, work.width - 1);
  const y = clamp(rect.y - pad, 0, work.height - 1);
  const w = clamp(rect.w + 2*pad, 1, work.width - x);
  const h = clamp(rect.h + 2*pad, 1, work.height - y);

  const crop = document.createElement("canvas");
  crop.width = w;
  crop.height = h;
  const cctx = crop.getContext("2d");
  cctx.drawImage(work, x, y, w, h, 0, 0, w, h);

  const dataUrl = crop.toDataURL("image/jpeg", 0.9);

  // Name: erstmal automatisch (Zeitstempel). Später ersetzen wir das durch OCR/DB.
  const name = `Karte ${new Date().toLocaleString("de-DE")}`;

  cards.unshift({ name, img: dataUrl, createdAt: new Date().toISOString() });
  save();
  render();

  // Optional: kleines Feedback
  try { navigator.vibrate?.(60); } catch {}
}

/**
 * Vereinfachte Karten-Erkennung:
 * - Downsample + Kanten (Sobel lite)
 * - Schwellenwert -> Edge-Maske
 * - Bounding Box der stärksten Kantenregion (heuristisch)
 *
 * Das ist KEIN Computer-Vision-Monster, aber für "Rechteck groß im Bild" erstaunlich brauchbar.
 */
function detectCardRect(imageData, W, H) {
  // Downsample für Speed
  const DS = 3; // 2-4 ok
  const w = Math.floor(W / DS);
  const h = Math.floor(H / DS);

  // Graustufen
  const gray = new Uint8Array(w * h);
  const data = imageData.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx = x * DS;
      const sy = y * DS;
      const idx = (sy * W + sx) * 4;
      const r = data[idx], g = data[idx + 1], b = data[idx + 2];
      gray[y * w + x] = (r * 0.299 + g * 0.587 + b * 0.114) | 0;
    }
  }

  // einfache Gradientenstärke (Sobel-lite)
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

  // adaptiver Threshold: nimm obere Kante der Verteilung (heuristisch)
  // sample ein paar Werte
  let sum = 0, cnt = 0;
  for (let i = 0; i < mag.length; i += 23) { sum += mag[i]; cnt++; }
  const mean = sum / cnt;
  const thresh = mean * 2.2; // tunable

  // Bounding Box der Edge-Pixel, aber nur in "mittlerem" Bereich (Rauschen am Rand vermeiden)
  const marginX = Math.floor(w * 0.05);
  const marginY = Math.floor(h * 0.06);

  let minX = w, minY = h, maxX = 0, maxY = 0;
  let hits = 0;

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

  // Zu wenig Kanten -> nix gefunden
  if (hits < (w * h) * 0.002) return null;

  // Box zurück auf Originalgröße
  const x = minX * DS;
  const y = minY * DS;
  const rw = (maxX - minX) * DS;
  const rh = (maxY - minY) * DS;

  // Heuristik: Karte sollte ungefähr ein Rechteck mit sinnvoller Ratio sein
  const ratio = rw / rh;
  if (ratio < 0.55 || ratio > 0.95) {
    // OP Karten sind eher hochkant ~0.72 (breite/hoehe)
    // Wenn es komplett daneben liegt, nicht verwenden
    return null;
  }

  // Mindestgröße
  if (rw < W * 0.25 || rh < H * 0.25) return null;

  return { x, y, w: rw, h: rh };
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

render();
