const list = document.getElementById("list");
const nameInput = document.getElementById("name");
const preview = document.getElementById("preview");

const video = document.getElementById("video");
const canvas = document.getElementById("canvas");
const scanBtn = document.getElementById("scanBtn");
const captureBtn = document.getElementById("captureBtn");
const addBtn = document.getElementById("addBtn");

let cards = JSON.parse(localStorage.getItem("cards") || "[]");
let stream = null;

function save() {
  localStorage.setItem("cards", JSON.stringify(cards));
}

function render() {
  list.innerHTML = "";

  cards.forEach((c, i) => {
    const li = document.createElement("li");

    const title = document.createElement("strong");
    title.textContent = c.name;

    li.appendChild(title);

    if (c.img) {
      const img = document.createElement("img");
      img.src = c.img;
      img.alt = c.name;
      li.appendChild(img);
    }

    // Tap to delete (simple)
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

async function startCamera() {
  // stop old stream if any
  stopCamera();

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment" }
    });

    video.srcObject = stream;
    video.style.display = "block";
    captureBtn.hidden = false;

    // hide previous preview until captured
    preview.style.display = "none";
    preview.src = "";
  } catch (err) {
    alert("Kamera konnte nicht geöffnet werden. Bitte in Safari erlauben (https erforderlich).");
    console.error(err);
  }
}

function stopCamera() {
  if (!stream) return;
  stream.getTracks().forEach(t => t.stop());
  stream = null;
  video.srcObject = null;
  video.style.display = "none";
  captureBtn.hidden = true;
}

function captureFrame() {
  if (!video.videoWidth || !video.videoHeight) {
    alert("Kamera ist noch nicht bereit. Bitte 1 Sekunde warten und nochmal versuchen.");
    return;
  }

  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;

  const ctx = canvas.getContext("2d");
  ctx.drawImage(video, 0, 0);

  preview.src = canvas.toDataURL("image/png");
  preview.style.display = "block";

  stopCamera();
}

scanBtn.onclick = startCamera;
captureBtn.onclick = captureFrame;

addBtn.onclick = () => {
  const name = (nameInput.value || "").trim();
  const img = preview.src;

  if (!name) {
    alert("Bitte Kartenname eingeben.");
    return;
  }
  if (!img) {
    alert("Bitte zuerst scannen (Scan aufnehmen).");
    return;
  }

  cards.unshift({ name, img, createdAt: new Date().toISOString() });

  nameInput.value = "";
  preview.src = "";
  preview.style.display = "none";

  save();
  render();
};

render();
