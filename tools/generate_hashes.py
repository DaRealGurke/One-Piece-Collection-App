import json
import time
from io import BytesIO

import requests
from PIL import Image

OUT_FILE = "hashes.json"

ALL_SET_CARDS = "https://optcgapi.com/api/allSetCards/"
ALL_ST_CARDS  = "https://optcgapi.com/api/allSTCards/"

SLEEP = 0.05


def fetch_json(url):
    r = requests.get(url, timeout=60)
    r.raise_for_status()
    return r.json()


def normalize_list(data):
    if isinstance(data, list):
        return data
    if isinstance(data, dict) and "results" in data and isinstance(data["results"], list):
        return data["results"]
    return []


def download_image(url):
    r = requests.get(url, timeout=60)
    r.raise_for_status()
    return Image.open(BytesIO(r.content)).convert("RGB")


def crop_artwork(img):
    """
    Robust: mittlerer Artwork-Bereich (weg von Header/Textbox).
    """
    w, h = img.size
    left   = int(w * 0.12)
    right  = int(w * 0.88)
    top    = int(h * 0.18)
    bottom = int(h * 0.72)
    return img.crop((left, top, right, bottom))


def dhash_hex(img, w=9, h=8):
    """
    dHash 64-bit:
    - resize to 9x8 grayscale
    - compare adjacent pixels horizontally (8 comparisons per row * 8 rows = 64 bits)
    returns 16 hex chars
    """
    small = img.resize((w, h), Image.BILINEAR).convert("L")
    px = list(small.getdata())

    bits = []
    for y in range(h):
        row = px[y * w:(y + 1) * w]
        for x in range(w - 1):
            bits.append(1 if row[x] < row[x + 1] else 0)

    out = ""
    for i in range(0, 64, 4):
        nibble = (bits[i] << 3) | (bits[i+1] << 2) | (bits[i+2] << 1) | bits[i+3]
        out += format(nibble, "x")
    return out


def pick_image_url(card):
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
            h = dhash_hex(art)
            out.append({"id": card_id, "hash": h})
            seen.add(card_id)
        except Exception:
            pass

        if idx % 100 == 0:
            print(f"Processed {idx}/{len(all_cards)} | hashes={len(out)}")

        time.sleep(SLEEP)

    out.sort(key=lambda x: x["id"])
    with open(OUT_FILE, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False)

    print(f"Wrote {OUT_FILE} with {len(out)} entries")


if __name__ == "__main__":
    main()
