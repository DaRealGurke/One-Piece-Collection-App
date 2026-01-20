const list = document.getElementById("list");
const nameInput = document.getElementById("name");
const fileInput = document.getElementById("file");
const preview = document.getElementById("preview");

let cards = JSON.parse(localStorage.getItem("cards") || "[]");

function save() {
  localStorage.setItem("cards", JSON.stringify(cards));
}

function render() {
  list.innerHTML = "";
  cards.forEach((c, i) => {
    const li = document.createElement("li");
    li.innerHTML = `<strong>${c.name}</strong><br><img src="${c.img}">`;
    li.onclick = () => {
      cards.splice(i, 1);
      save();
      render();
    };
    list.appendChild(li);
  });
}

document.getElementById("photoBtn").onclick = () => fileInput.click();

fileInput.onchange = e => {
  const file = e.target.files[0];
  if (!file) return;
  const r = new FileReader();
  r.onload = () => preview.src = r.result;
  r.readAsDataURL(file);
};

document.getElementById("addBtn").onclick = () => {
  if (!nameInput.value || !preview.src) return;
  cards.push({ name: nameInput.value, img: preview.src });
  nameInput.value = "";
  preview.src = "";
  save();
  render();
};

render();
