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