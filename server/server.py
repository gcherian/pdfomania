# server/main.py
from fastapi import FastAPI, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Dict, Any
from PIL import Image
import io, os, json
import pytesseract

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], allow_methods=["*"], allow_headers=["*"]
)

os.makedirs("gt", exist_ok=True)

# ---- /ocr ----
@app.post("/ocr")
async def ocr(page: UploadFile = File(...), pageNumber: int = Form(1)):
    blob = await page.read()
    im = Image.open(io.BytesIO(blob)).convert("RGB")
    w, h = im.size
    data = pytesseract.image_to_data(im, output_type=pytesseract.Output.DICT, config="--psm 6")
    tokens = []
    n = len(data["text"])
    for i in range(n):
      txt = (data["text"][i] or "").strip()
      if not txt: continue
      x, y, bw, bh = data["left"][i], data["top"][i], data["width"][i], data["height"][i]
      tokens.append({ "page": pageNumber, "text": txt, "x0": x, "y0": y, "x1": x+bw, "y1": y+bh })
    return { "tokens": tokens, "width": w, "height": h }

# ---- embeddings (optional stub) ----
class EmbedReq(BaseModel):
    value: str
    k: int = 5
    pageBias: List[int] = []
@app.post("/embed")
def embed(req: EmbedReq):
    # Stub: return empty; client will fallback to fuzzy/tfidf
    return { "candidates": [] }

# ---- store ground truth boxes ----
class GTReq(BaseModel):
    docId: str
    page: int
    x0: float; y0: float; x1: float; y1: float
    key: str | None = None
    value: str | None = None
@app.post("/gt")
def save_gt(r: GTReq):
    path = os.path.join("gt", f"{r.docId}.jsonl")
    with open(path, "a") as f:
        f.write(json.dumps(r.dict()) + "\n")
    return { "ok": True }

# ---- DocAI-like generation from OCR tokens ----
#   Input: one or more page PNGs uploaded as "page"
#   Output: { documents:[{ properties:[{ metadata:{metaDataMap:{...}} }], pages:[{ elements:[{content,boundingBox}]}]}]}
@app.post("/docaiify")
async def docaiify(pages: List[UploadFile] = File(...)):
    doc_pages = []
    for idx, uf in enumerate(pages):
        blob = await uf.read()
        im = Image.open(io.BytesIO(blob)).convert("RGB")
        w,h = im.size
        data = pytesseract.image_to_data(im, output_type=pytesseract.Output.DICT, config="--psm 6")
        elements = []
        n = len(data["text"])
        # group per line → concatenate tokens in same line_num & block_num
        by_line = {}
        for i in range(n):
            txt = (data["text"][i] or "").strip()
            if not txt: continue
            key = (data["block_num"][i], data["par_num"][i], data["line_num"][i])
            by_line.setdefault(key, []).append(i)
        for _, idxs in by_line.items():
            xs = [data["left"][i] for i in idxs]
            ys = [data["top"][i] for i in idxs]
            ws = [data["width"][i] for i in idxs]
            hs = [data["height"][i] for i in idxs]
            x0 = min(xs); y0 = min(ys)
            x1 = max([xs[i] + ws[i] for i in range(len(xs))])
            y1 = max([ys[i] + hs[i] for i in range(len(ys))])
            content = " ".join([(data["text"][i] or "").strip() for i in idxs]).strip()
            if not content: continue
            elements.append({
                "content": content,
                "boundingBox": { "x": x0, "y": y0, "width": x1-x0, "height": y1-y0 },
                "page": idx+1
            })
        doc_pages.append({ "page": idx+1, "width": w, "height": h, "elements": elements })

    out = {
      "documents": [{
        "properties": [{
          "metadata": {
            "metaDataMap": {
              "generator": "WF-DocAI",
              "engine": "tesseract",
              "psm": "6",
              "pages": len(doc_pages)
            }
          }
        }],
        "pages": doc_pages
      }]
    }
    return out
    
    
    
    
    # server.py  (Flask)
# - /health
# - /ocr           (your OCR endpoint unchanged)
# - /normalize-docai  <-- NEW: uses ONLY normalized_vertices (0..1)

import io, os
import numpy as np
from PIL import Image
import cv2
import pytesseract
from flask import Flask, request, jsonify
from flask_cors import CORS

OCR_LANG = os.getenv("OCR_LANG", "eng")
TESSERACT_CONFIG = os.getenv("TESSERACT_CONFIG", "--oem 3 --psm 6")
TARGET_DPI = int(os.getenv("TARGET_DPI", "300"))
THRESH = int(os.getenv("THRESH", "0"))

app = Flask(__name__)
CORS(app, supports_credentials=True)

@app.get("/health")
def health():
    return jsonify({"ok": True})

@app.route("/ocr", methods=["POST", "OPTIONS", "GET"])
def ocr():
    if request.method == "OPTIONS":
        return ("", 204)
    if request.method == "GET":
        return jsonify({"ok": True, "msg": "POST an image/png as field 'page'."})
    if "page" not in request.files:
        return jsonify({"error": "missing file field 'page'"}), 422

    f = request.files["page"]
    page_num = int(request.form.get("pageNumber") or "1")

    image = Image.open(io.BytesIO(f.read())).convert("RGB")
    w0, h0 = image.size
    scale = max(1.0, TARGET_DPI / 96.0)
    if scale > 1.01:
        image = image.resize((int(w0*scale), int(h0*scale)), Image.BICUBIC)

    cv = cv2.cvtColor(np.array(image), cv2.COLOR_RGB2BGR)
    if THRESH == 0:
        gray = cv2.cvtColor(cv, cv2.COLOR_BGR2GRAY)
        cv = cv2.adaptiveThreshold(gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 41, 11)
    else:
        gray = cv2.cvtColor(cv, cv2.COLOR_BGR2GRAY)
        _, cv = cv2.threshold(gray, THRESH, 255, cv2.THRESH_BINARY)

    data = pytesseract.image_to_data(cv, lang=OCR_LANG, config=TESSERACT_CONFIG, output_type=pytesseract.Output.DICT)

    tokens = []
    for i in range(len(data["text"])):
        txt = (data["text"][i] or "").strip()
        conf = int(data["conf"][i]) if data["conf"][i] not in ("", "-1") else -1
        if not txt or conf < 50:
            continue
        x = int(data["left"][i]); y = int(data["top"][i])
        w = int(data["width"][i]); h = int(data["height"][i])
        tokens.append({"page": page_num, "text": txt, "x0": x, "y0": y, "x1": x+w, "y1": y+h})

    H, W = cv.shape[:2]
    return jsonify({"page": page_num, "width": int(W), "height": int(H), "tokens": tokens})

def _box_from_norm_vertices(nv):
    xs = [float(v.get("x", 0.0)) for v in nv if isinstance(v, dict)]
    ys = [float(v.get("y", 0.0)) for v in nv if isinstance(v, dict)]
    if not xs or not ys:
        raise ValueError("empty normalized_vertices")
    return min(xs), min(ys), max(xs), max(ys)

@app.post("/normalize-docai")
def normalize_docai():
    root = request.get_json(force=True, silent=True)
    if root is None:
        return jsonify({"error": "invalid JSON"}), 400
    if isinstance(root, list):
        root = (root[0] if root else {})

    documents = root.get("documents", [])
    if not documents:
        return jsonify({"error": "missing documents[]"}), 400

    pages, fields = [], []
    for doc in documents:
        props_list = doc.get("properties", [])
        for props in props_list:
            meta = props.get("metadata") or {}
            mdm = meta.get("metaDataMap") or {}
            pinfo = mdm.get("pageInfo") or {}
            page_number = int(pinfo.get("page_number") or 1)
            dim = pinfo.get("dimension") or {}
            width = int(dim.get("width") or 0)
            height = int(dim.get("height") or 0)
            unit = dim.get("unit") or "pixels"
            if width and height:
                pages.append({"page_number": page_number, "width": width, "height": height, "unit": unit})

            for k, v in props.items():
                if k in {"metadata", "metaData", "meta_data", "_metadata"}:
                    continue
                if not isinstance(v, dict):
                    fields.append({"name": k, "value": str(v), "norm_box": None})
                    continue
                nv = (v.get("bounding_poly") or {}).get("normalized_vertices")
                if isinstance(nv, list) and nv:
                    x0,y0,x1,y1 = _box_from_norm_vertices(nv)
                    fields.append({
                        "name": k,
                        "value": v.get("value") if isinstance(v.get("value"), str) or v.get("value") is None else str(v.get("value")),
                        "norm_box": {"page": page_number, "x0": x0, "y0": y0, "x1": x1, "y1": y1}
                    })
                else:
                    fields.append({"name": k, "value": v.get("value"), "norm_box": None})

    return jsonify({"pages": pages, "fields": fields})

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=3001, debug=False)