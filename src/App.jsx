import React, { useRef, useState } from "react";
import PdfCanvas from "./components/PdfCanvas.jsx";
import KVPane from "./components/KVPane.jsx";
import { findBestWindow, normalize } from "./lib/match.js";

const OCR_ENDPOINT = "http://localhost:3001/ocr";

// --- tolerant JSON5-ish parse (unchanged) ---
function parseDocAI(text) {
  try { return JSON.parse(text); } catch {}
  const noComments = text.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
  const noTrailing = noComments.replace(/,\s*([}\]])/g, "$1");
  return JSON.parse(noTrailing);
}

// ---------- helpers for many DocAI variants ----------
const asArray = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const isFiniteNum = (n) => typeof n === "number" && Number.isFinite(n);

function pick(o, path) {
  let cur = o;
  for (const k of path) {
    if (cur == null) return undefined;
    cur = cur[k];
  }
  return cur;
}

// normalize bbox if present & sane; otherwise return null
function normalizeBBox(bb) {
  if (!bb || typeof bb !== "object") return null;
  // accept rect-like
  let x = bb.x ?? bb.left, y = bb.y ?? bb.top, w = bb.width ?? bb.w, h = bb.height ?? bb.h;
  if (![x,y,w,h].every(isFiniteNum)) return null;
  if (Math.abs(x) > 1e9 || Math.abs(y) > 1e9 || Math.abs(w) > 1e9 || Math.abs(h) > 1e9) return null;
  if (w <= 0 || h <= 0) return null;
  return { x, y, width: w, height: h };
}

// Find a doc node and a properties node no matter how they’re nested
function getDocNodes(root) {
  const doc = root?.documents?.[0] ?? root?.document ?? root ?? {};
  // properties may be an object or an array; prefer the first objecty item
  let props = doc.properties;
  if (Array.isArray(props)) {
    props = props.find((p) => p && typeof p === "object") ?? props[0];
  }
  return { doc, props: props || {} };
}

// App.jsx (keep this helper local)
function parseLooseJson(text) {
  // strip BOM
  const t0 = text.replace(/^\uFEFF/, "");
  // remove // and /* */ comments
  const t1 = t0.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/g, "");
  // remove trailing commas
  const t2 = t1.replace(/,\s*([}\]])/g, "$1");
  return JSON.parse(t2);
}
export default function App() {
  const pdfRef = useRef(null);
  const [pdfData, setPdfData] = useState(null);

  const [headerRows, setHeaderRows] = useState([]);     // [{key,value}]
  const [elementRows, setElementRows] = useState([]);   // [{content,page,bbox?}]

  async function onPickPdf(e) {
    const f = e.target.files?.[0];
    if (!f) return;
    setPdfData(await f.arrayBuffer());
  }

// ---------- REPLACE your onPickDocAI with this ----------
async function onPickDocAI(e) {
  const f = e.target.files?.[0];
  if (!f) return;

  const text = await f.text();
  const root = parseDocAI(text);
  console.log("[app] raw JSON keys =", Object.keys(root || {}));

  const { doc, props } = getDocNodes(root);

  // ---- Header (metadata/metaDataMap in various places) ----
  const meta =
    props?.metadata?.metaDataMap ??
    props?.metaDataMap ??
    doc?.properties?.metaDataMap ?? // if properties wasn’t an array in other dumps
    root?.metaDataMap ??
    root?.metadata ??
    {};

  const header = Object.entries(meta || {}).map(([key, value]) => ({ key, value }));
  setHeaderRows(header);
  console.log("[app] parsed header =", header);

  // ---- Elements (pages/elements under props or doc) ----
  const pages =
    asArray(props?.pages) // most likely for your screenshot
      .concat(asArray(doc?.pages))
      .filter(Boolean);

  const elements = [];
  pages.forEach((p, pIdx) => {
    const pageNo = p?.page ?? p?.pageNumber ?? pIdx + 1;
    asArray(p?.elements).forEach((el) => {
      const content =
        (typeof el?.content === "string" && el.content.trim()) ||
        (typeof el?.text === "string" && el.text.trim()) ||
        ""; // keep if content exists, even with null bbox

      const bb = normalizeBBox(el?.boundingBox ?? el?.bbox ?? el?.box);
      if (!content && !bb) return;

      elements.push({
        content: content.replace(/\s+/g, " ").trim(),
        page: pageNo,
        bbox: bb ?? null,
      });
    });
  });

  setElementRows(elements);
  console.log("[app] parsed elements =", elements.length);
}
  
  function handleHover(row) {
    pdfRef.current?.showDocAIBbox(row); // dashed (optional)
  }

  async function handleClick(row) {
    if (!row?.content) return;
    // get OCR tokens from the PDF canvas
    const tokens = pdfRef.current?.tokensForMatching?.() || [];
    if (!tokens.length) return;

    // try to bias to the same page (if DocAI gave one)
    const preferredPages = row.page ? [row.page] : [];
    const best = findBestWindow(tokens, row.content, { preferredPages, maxWindow: 12 });

    if (best) {
      pdfRef.current?.setLocateRect(best.page, { x0:best.rect.x0, y0:best.rect.y0, x1:best.rect.x1, y1:best.rect.y1 });
    } else {
      // clear highlight
      pdfRef.current?.setLocateRect(preferredPages[0] ?? 1, null);
    }
  }

  return (
    <div className="wrap">
      <KVPane
        header={headerRows}
        elements={elementRows}
        onHover={handleHover}
        onClick={handleClick}
      />
      <div className="right">
        <div className="toolbar" style={{ position:"absolute", left:8, top:8, zIndex:10 }}>
          <label className="btn">
            Choose PDF
            <input type="file" accept="application/pdf" hidden onChange={onPickPdf} />
          </label>
          <label className="btn">
            Choose DocAI JSON
            <input type="file" accept=".json,.txt" hidden onChange={onPickDocAI} />
          </label>
        </div>

        <PdfCanvas ref={pdfRef} pdfData={pdfData} ocrEndpoint={OCR_ENDPOINT} />
      </div>
    </div>
  );
}