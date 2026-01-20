import json
import math
import time
from io import BytesIO

import requests
from PIL import Image

# ---- CONFIG ----
OUT = "hashes.json"

# OPTCG API endpoints (documented on their site) :contentReference[oaicite:3]{index=3}
ALL_SET_CARDS = "https://optcgapi.com/api/allSetCards/"
ALL_ST_CARDS  = "https://optcgapi.com/api/allSTCards/"
# Promos lassen wir erstmal weg (du wolltest EN-only, “Basis” wie ManaBox; kann man später ergänzen)

# Schonend sein (API betreibt jemand privat, bitte nicht hammern) :contentReference[oaicite:4]{index=4}
SLEEP_BETWEEN_DOWNLOADS = 0.05


def fetch_json(url: str):
  r = requests.get(url, timeout=60)
  r.raise_for_status()
  return r.json()


def download_image(url: str) -> Image.Image:
  r = requests.get(url, timeout=60)
  r.raise_for_status()
  return Image.open(BytesIO(r.content)).convert("RGB")


def crop_artwork(img: Image.Image) -> Image.Image:
  """
  Kartenbild enthält Border/Text. Wir nehmen einen robusten Mittelbereich:
  - links/rechts: 12%
  - oben: 18% (nimmt Header weg)
  - unten: 28% (nimmt Textbox/ID weg)
  Das ist absichtlich grob, damit es über Sets hinweg stabil ist.
  """
  w, h = img.size
  left = int(w * 0.12)
  right = int(w * 0.88)
  top = int(h * 0.18)
  bottom = int(h * 0.72)
  return img.crop((left, top, right, bottom))


def ahash_hex(img: Image.Image, size: int = 8) -> str:
  """
  aHash: downscale to 8x8 grayscale, compare each pixel to average.
  Returns 64-bit as 16 hex chars.
  """
  small = img.resize((size, size), Image.BILINEAR).convert("L")
  px = list(small.getdata())
  avg = sum(px) / len(px)
  bits = [(1 if v >= avg else 0) for v in px]

  # bits -> hex
  out = ""
  for i in range(0, 64, 4):
    nibble = (bits[i] << 3) | (bits[i+1] << 2) | (bits[i+2] << 1) | bits[i+3]
    out += format(nibble, "x")
  return out


def pick_image_url(card: dict) -> str | None:
  """
  OPTCG API liefert je nach Endpoint Felder unterschiedlich.
  Wir versuchen typische Keys.
  """
  for key in ("image_url", "image", "img", "imageUrl", "image_link", "imageLink", "art_url", "artUrl"):
    if key in card and isinstance(card[key], str) and card[key].startswith("http"):
      return card[key]
  return None


def pick_card_id(card: dict) -> str | None:
  for key in ("card_id", "cardId", "id", "Card ID", "cardID"):
    if key in card and isinstance(card[key], str) and len(card[key]) >= 5:
      return card[key].strip()
  # manche APIs nennen es "Image ID"
  if "image_id" in card and isinstance(card["image_id"], str):
    return card["image_id"].strip()
  return None


def main():
  set_cards = fetch_json(ALL_SET_CARDS)
  st_cards = fetch_json(ALL_ST_CARDS)

  all_cards = []
  if isinstance(set_cards, list):
    all_cards.extend(set_cards)
  elif isinstance(set_cards, dict) and "results" in set_cards and isinstance(set_cards["results"], list):
    all_cards.extend(set_cards["results"])

  if isinstance(st_cards, list):
    all_cards.extend(st_cards)
  elif isinstance(st_cards, dict) and "results" in st_cards and isinstance(st_cards["results"], list):
    all_cards.extend(st_cards["results"])

  out = []
  seen = set()

  for c in all_cards:
    card_id = pick_card_id(c)
    if not card_id or card_id in seen:
      continue

    img_url = pick_image_url(c)
    if not img_url:
      # Wenn API bei manchen Karten keine URL liefert, überspringen wir erstmal.
      continue

    try:
      img = download_image(img_url)
      art = crop_artwork(img)
      h = ahash_hex(art)
      out.append({"id": card_id, "hash": h})
      seen.add(card_id)
    except Exception:
      # robust bleiben (einzelne Fehler nicht killen)
      pass

    time.sleep(SLEEP_BETWEEN_DOWNLOADS)

  out.sort(key=lambda x: x["id"])

  with open(OUT, "w", encoding="utf-8") as f:
    json.dump(out, f, ensure_ascii=False)

  print(f"Wrote {OUT} with {len(out)} entries")


if __name__ == "__main__":
  main()
