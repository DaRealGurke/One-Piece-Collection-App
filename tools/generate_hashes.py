import json
import time
from io import BytesIO

import requests
from PIL import Image

# ================= CONFIG =================
OUT_FILE = "hashes.json"

# OPTCG API – englische Karten
ALL_SET_CARDS = "https://optcgapi.com/api/allSetCards/"
ALL_ST_CARDS  = "https://optcgapi.com/api/allSTCards/"

# Schonend für die API
SLEEP = 0.05
# =========================================


def fetch_json(url):
    r = requests.get(url, timeout=60)
    r.raise_for_status()
    return r.json()


def download_image(url):
    r = requests.get(url, timeout=60)
    r.raise_for_status()
    return Image.open(BytesIO(r.content)).convert("RGB")


def crop_artwork(img):
    """
    Grober, robuster Artwork-Crop (funktioniert set-übergreifend):
    - links/rechts: 12%
    - oben: 18%
    - unten: 28%
    """
    w, h = img.size
    left   = int(w * 0.12)
    right  = int(w * 0.88)
    top    = int(h * 0.18)
    bottom = int(h * 0.72)
    return img.crop((left, top, right, bottom))


def ahash_hex(img, size=8):
    """
    aHash (64 bit) → 16 hex chars
    """
    small = img.resize((size, size), Image.BILINEAR).convert("L")
    px = list(small.getdata())
    avg = sum(px) / len(px)

    bits = [(1 if v >= avg else 0) for v in px]

    out = ""
    for i in range(0, 64, 4):
        nibble = (
            (bits[i] << 3)
            | (bits[i + 1] << 2)
            | (bits[i + 2] << 1)
            | bits[i + 3]
        )
        out += format(nibble, "x")
    return out


def pick_image_url(card):
    """
    OPTCG API nutzt 'card_image' für die Bild-URL
    """
    candidates = [
        "card_image",
        "image_url", "image", "img",
        "imageUrl", "imageURL",
        "image_link", "imageLink",
    ]
    for k in candidates:
        v = card.get(k)
        if isinstance(v, str) and v.startswith("http"):
            return v
    return None


def pick_card_id(card):
    """
    OPTCG API nutzt 'card_set_id' (z.B. OP01-001)
    """
    candidates = [
        "card_set_id",
        "card_id", "cardId", "id",
        "code", "card_code", "cardCode",
    ]
    for k in candidates:
        v = card.get(k)
        if isinstance(v, str) and len(v) >= 5:
            return v.strip()
    return None


def normalize_list(data):
    if isinstance(data, list):
        return data
    if isinstance(data, dict) and "results" in data and isinstance(data["results"], list):
        return data["results"]
    return []


def main():
    print("Fetching card lists...")
    set_cards = normalize_list(fetch_json(ALL_SET_CARDS))
    st_cards  = normalize_list(fetch_json(ALL_ST_CARDS))

    all_cards = set_cards + st_cards
    print(f"Total cards received: {len(all_cards)}")

    out = []
    seen = set()

    for idx, card in enumerate(all_cards, start=1):
        card_id = pick_card_id(card)
        if not card_id or card_id in seen:
            continue

        img_url = pick_image_url(card)
        if not img_url:
            continue

        try:
            img = download_image(img_url)
            art = crop_artwork(img)
            h = ahash_hex(art)
            out.append({
                "id": card_id,
                "hash": h
            })
            seen.add(card_id)
        except Exception as e:
            # Einzelne Fehler ignorieren
            pass

        if idx % 100 == 0:
            print(f"Processed {idx}/{len(all_cards)}")

        time.sleep(SLEEP)

    out.sort(key=lambda x: x["id"])

    with open(OUT_FILE, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False)

    print(f"Wrote {OUT_FILE} with {len(out)} entries")


if __name__ == "__main__":
    main()
