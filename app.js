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

function
