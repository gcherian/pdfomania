import React, { useRef, useState } from "react";
import PdfCanvas from "./components/PdfCanvas.jsx";
import KVPane from "./components/KVPane.jsx";
import { findBestWindow, normalize } from "./lib/match.js";

const OCR_ENDPOINT = "http://localhost:3001/ocr";

// JSON5-ish tolerant parse for DocAI dumps
function parseDocAI(text) {
  try { return JSON.parse(text); } catch {}
  // remove comments + trailing commas
  const noComments = text.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
  const noTrailing = noComments.replace(/,\s*([}\]])/g, "$1");
  return JSON.parse(noTrailing);
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

  async function onPickDocAI(e) {
    const f = e.target.files?.[0];
    if (!f) return;
    const text = await f.text();
    const root = parseDocAI(text);
    console.log("[app] raw JSON keys", Object.keys(root || {}));

    // Expect shape like { documents:[{ properties:{ metadataMap:{...} }, pages:[{elements:[{elementType,content,boundingBox,page}]}] }]}
    const doc = (root?.documents && root.documents[0]) || root?.document || root;

    // header
    const meta = doc?.properties?.metadataMap || root?.metaDataMap || {};
    const hdr = Object.entries(meta).map(([k,v])=>({ key:k, value:v }));
    setHeaderRows(hdr);

    // elements
    const els = [];
    const pages = doc?.pages || [];
    pages.forEach((p, idx) => {
      (p.elements || []).forEach(el => {
        if (!el?.content) return;
        const bb = el.boundingBox;
        els.push({
          content: String(el.content || "").replace(/\s+/g, " ").trim(),
          page: el.page || p.page || (idx+1),
          bbox: (bb && isFinite(bb.x) && isFinite(bb.width) && isFinite(bb.height)) ? bb : null
        });
      });
    });
    setElementRows(els);
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