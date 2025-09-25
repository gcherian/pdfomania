// src/App.jsx
import React, { useRef, useState } from "react";
import KVPane from "./components/KVPane.jsx";
import PdfCanvas from "./components/PdfCanvas.jsx";
import "./styles.css";

/* ---------- tolerant parse (keeps you safe if JSON has extra commas, etc.) ---------- */
function parseMaybeJSON5(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    // very light cleanup; won’t destroy valid JSON
    const cleaned = text
      .replace(/,\s*([}\]])/g, "$1")     // trailing commas
      .replace(/\uFEFF/g, "");           // BOM
    try { return JSON.parse(cleaned); } catch { return null; }
  }
}

/* ---------- pull DocAI header + elements into simple arrays ---------- */
function toHeaderKV(doc) {
  const props = doc?.documents?.[0]?.properties ?? {};
  const m = props.metadata ?? props.metaData ?? {}; // handle both spellings
  const entries = Object.entries(m);
  return entries.map(([key, value]) => ({ key, value }));
}

function toElements(doc) {
  const pages = doc?.documents?.[0]?.pages ?? [];
  const out = [];
  pages.forEach((p, idx) => {
    const pageNo = p.page ?? idx + 1;
    (p.elements ?? []).forEach((el) => {
      out.push({
        content: (el.content || "").trim(),
        page: el.page ?? pageNo,
        bbox: el.boundingBox ?? null
      });
    });
  });
  return out;
}

export default function App() {
  const pdfRef = useRef(null);                    // PdfCanvas imperative API
  const [pdfData, setPdfData] = useState(null);   // ArrayBuffer
  const [headerKV, setHeaderKV] = useState([]);   // [{key, value}]
  const [elements, setElements] = useState([]);   // [{content, page, bbox}]

  /* ---------- file pickers ---------- */
  const onChoosePDF = async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const ab = await f.arrayBuffer();
    setPdfData(ab);
  };

  const onChooseDocAI = async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const txt = await f.text();
    const doc = parseMaybeJSON5(txt);
    if (!doc) {
      alert("Could not parse DocAI JSON (after cleanup).");
      setHeaderKV([]);
      setElements([]);
      return;
    }
    const header = toHeaderKV(doc);
    const elems = toElements(doc);
    setHeaderKV(header);
    setElements(elems);
    // optional: log sizes so you know it loaded
    console.log("[DOCAI] header keys:", header.map(k => k.key));
    console.log("[DOCAI] elements:", elems.length);
  };

  /* ---------- click handlers (left list → right canvas) ---------- */
  const handleRowHover = (row) => {
    // show the DocAI-provided bbox (dashed) if present
    pdfRef.current?.showDocAIBbox?.(row || null);
  };

  const handleRowClick = (row) => {
    // try a value-only match (pink) to locate true position from tokens
    pdfRef.current?.matchAndHighlight?.("", row?.content || "", {
      preferredPages: row?.page ? [row.page] : undefined,
      numericHint: /\d/.test(row?.content || "")
    });
  };

  return (
    <div style={{ display: "grid", gridTemplateColumns: "320px 1fr", height: "100vh" }}>
      {/* LEFT: controls + KV list */}
      <div style={{ padding: 8, overflow: "auto", background: "#0b1020", color: "#dce" }}>
        <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
          <label className="btn">
            Choose PDF
            <input type="file" accept="application/pdf" hidden onChange={onChoosePDF} />
          </label>
          <label className="btn">
            Choose DocAI JSON
            <input type="file" accept=".json,.txt" hidden onChange={onChooseDocAI} />
          </label>
        </div>

        <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 8 }}>
          DocAI Header
        </div>
        <table className="kv-table">
          <thead>
            <tr><th style={{width:120}}>Key</th><th>Value</th></tr>
          </thead>
          <tbody>
            {(headerKV || []).map((row, i) => (
              <tr key={`h-${i}`}>
                <td>{row.key}</td>
                <td title={String(row.value)}>{String(row.value)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div style={{ fontSize: 12, opacity: 0.8, margin: "12px 0 6px" }}>
          DocAI Elements
          <span style={{ opacity: 0.6 }}> — Hover: dashed bbox, Click: pink match</span>
        </div>

        <KVPane
          rows={elements || []}
          onHover={handleRowHover}
          onClick={handleRowClick}
        />
      </div>

      {/* RIGHT: PDF viewer */}
      <div style={{ position: "relative", background: "#0a0f1a" }}>
        <PdfCanvas ref={pdfRef} pdfData={pdfData} />
      </div>
    </div>
  );
}