// App.jsx (top)
import React, { useRef, useState } from "react";
import PdfCanvas from "./components/PdfCanvas";
import KVPane from "./components/KVPane";

export default function App() {
  const pdfRef = useRef(null);      // <— THIS is what PdfCanvas exposes
  const [elements, setElements] = useState([]);      // DocAI page elements you already have
  const [header, setHeader] = useState([]);          // DocAI header you already have
  const [pdfData, setPdfData] = useState(null);      // your PDF ArrayBuffer
  // ...


  // ---- KV → hover (DocAI bbox only) ----
  const handleHoverRow = (row) => {
    console.log("[KV→PDF] hover", { page: row.page, bbox: row.bbox, content: row.content?.slice(0,50) });
    pdfRef.current?.showDocAIBbox?.(row);
  };

  // ---- KV → click (true location) ----
  const handleClickRow = (row) => {
    console.log("[KV→PDF] click", { key: row.key, content: row.content?.slice(0,50), page: row.page, bbox: row.bbox });

    // 1) always show DocAI-box (dashed) if valid
    pdfRef.current?.showDocAIBbox?.(row);

    // 2) try key-aware match; if key missing, locate by value
    const key = (row.key || "").trim();
    const val = (row.content || "").trim();

    if (key) {
      console.log("[KV→PDF] matchAndHighlight(key,val) firing…");
      pdfRef.current?.matchAndHighlight?.(key, val, {
        preferredPages: row.page ? [row.page] : undefined,
        contextRadiusPx: 16,
      });
    } else {
      console.log("[KV→PDF] locateValue(val) firing…");
      pdfRef.current?.locateValue?.(val, {
        preferredPages: row.page ? [row.page] : undefined,
        contextRadiusPx: 16,
      });
    }
  };

//
  return (
    <div className="app">
      <div className="left">
        <KVPane
          header={header}
          elements={elements}
          onHoverRow={handleHoverRow}
          onClickRow={handleClickRow}
        />
      </div>
      <div className="right">
        <PdfCanvas ref={pdfRef} pdfData={pdfData} />
      </div>
    </div>
  );
}

//KV
// KVPane.jsx – inside the .map(row => …)
<div
  key={i}
  className="kv-row"
  title="Hover: DocAI bbox | Click: find true location"
  onMouseEnter={() => {
    console.log("[KVPane] hover row", row);
    onHoverRow?.(row);
  }}
  onClick={() => {
    console.log("[KVPane] click row", row);
    onClickRow?.(row);
  }}
>
  <div className="kv-content">{row.content}</div>
  <div className="kv-page">{row.page || ""}</div>
</div>

export default function KVPane({ header = [], elements = [], onHoverRow, onClickRow }) {
  // render header table + elements table…
}


//PC

// in useImperativeHandle(ref, …)
showDocAIBbox: (row) => {
  console.log("[PdfCanvas] showDocAIBbox()", row);
  // …existing code…
},

matchAndHighlight: (key, value, opts) => {
  console.log("[PdfCanvas] matchAndHighlight()", { key, value, opts });
  // …existing code…
},

locateValue: (value, opts) => {
  console.log("[PdfCanvas] locateValue()", { value, opts });
  // …existing code…
},

// 

.canvas-stage { position: relative; background: #fff; }
.canvas-stage canvas { position: relative; z-index: 0; }
.overlay { position: absolute; inset: 0; z-index: 50; pointer-events: none; }
.docai-hover  { border:2px dashed #f59e0b; background:rgba(245,158,11,.12); }
.docai-locate { outline:3px solid #ec4899; background:rgba(236,72,153,.18); }
.kv-row { cursor: pointer; }

.overlay { background: rgba(255,0,0,.05); }

//debug

if (res) {
  console.log("[PdfCanvas] placing pink at", res);
  locateRectRef.current = { page: res.page, x0: res.rect.x0, y0: res.rect.y0, x1: res.rect.x1, y1: res.rect.y1 };
  // …
}

