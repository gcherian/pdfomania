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

async function onPickDocAI(e) {
  const f = e.target.files?.[0];
  if (!f) return;
  const text = await f.text();
  const root = parseDocAI(JSON.parse(text));   // docai.js already flattens

  console.log("[app] parsed header", root.header);
  console.log("[app] parsed elements", root.elements?.length);

  setHeaderRows(root.header || []);
  setElementRows(root.elements || []);
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