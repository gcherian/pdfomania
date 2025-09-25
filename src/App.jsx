// src/App.jsx
import React, { useRef, useState } from "react";
import PdfCanvas from "./components/PdfCanvas";   // your existing canvas
import KVPane from "./components/KVPane";         // the simple table list

// ---------------- tolerant JSON (inline, no deps) ----------------
function parseMaybeJSON5(text) {
  if (!text) throw new Error("Empty JSON");

  // Strip /* ... */ comments
  let s = text.replace(/\/\*[\s\S]*?\*\//g, "");

  // Strip // line comments (but keep http:// etc by requiring line start or whitespace before //)
  s = s.replace(/(^|\s)\/\/.*$/gm, "$1");

  // Allow trailing commas in objects/arrays
  s = s.replace(/,\s*([}\]])/g, "$1");

  // Allow single quotes → double quotes
  s = s.replace(/'([^'\\]*(\\.[^'\\]*)*)'/g, "\"$1\"");

  return JSON.parse(s);
}

// ---------------- DocAI → header/elements ----------------
function saneBBox(b) {
  if (!b) return false;
  const bad = (n) => typeof n !== "number" || !isFinite(n) || Math.abs(n) > 5_000_000;
  return !(bad(b.x) || bad(b.y) || bad(b.width) || bad(b.height));
}

function guessKeyFromContent(s) {
  const m = String(s).match(/^\s*([A-Za-z][A-Za-z0-9 _\-\/&]*)\s*:\s*/);
  return m ? m[1].trim() : "";
}

function extractDocAI(root) {
  // accept {documents:[{…}]} or a single {…}
  const doc = (root && root.documents && root.documents.length ? root.documents[0] : root) || {};

  const header = [];
  const meta = (doc.properties && (doc.properties.metadata || doc.properties)) || null;
  if (meta && typeof meta === "object") {
    Object.keys(meta).forEach((k) => {
      const v = meta[k];
      if (v == null) return;
      header.push({ key: k, value: typeof v === "object" ? "[object Object]" : String(v) });
    });
  }

  const elements = [];
  const pages = Array.isArray(doc.pages) ? doc.pages : [];
  pages.forEach((p) => {
    const pageNo = p?.page || p?.pageNumber || 1;
    const els = Array.isArray(p?.elements) ? p.elements : [];
    els.forEach((el) => {
      const content = String(el?.content ?? "");
      if (!content) return;
      const bbox = saneBBox(el?.boundingBox) ? el.boundingBox : null;
      elements.push({
        key: guessKeyFromContent(content),
        content,
        page: Number.isFinite(el?.page) ? el.page : pageNo,
        bbox,
      });
    });
  });

  return { header, elements };
}

// ---------------- App ----------------
export default function App() {
  const pdfRef = useRef(null);

  const [pdfData, setPdfData] = useState(null);
  const [header, setHeader] = useState([]);
  const [elements, setElements] = useState([]);

  // PDF picker
  const onPickPdf = async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const buf = await f.arrayBuffer();
    setPdfData(buf);
    setTimeout(() => pdfRef.current?.clearHighlights?.(), 0);
  };

  // DocAI JSON picker
  const onPickDocAI = async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    try {
      const txt = await f.text();
      const root = parseMaybeJSON5(txt);
      const { header: H, elements: E } = extractDocAI(root);
      console.log("[DocAI] header keys:", H.map((r) => r.key));
      console.log("[DocAI] elements:", E.length);
      setHeader(H);
      setElements(E);
    } catch (err) {
      console.error("[DocAI] parse error:", err);
      alert("DocAI JSON parse failed:\n" + (err?.message || err));
    }
  };

  // KV → PDF hover/click
  const handleHoverRow = (row) => {
    pdfRef.current?.showDocAIBbox?.(row);  // dashed bbox if present
  };

  const handleClickRow = (row) => {
    // dashed bbox first (if any)
    pdfRef.current?.showDocAIBbox?.(row);

    const key = (row.key || "").trim();
    const val = (row.content || "").trim();

    // Prefer key+value; PdfCanvas will fallback to value-only internally if needed
    if (key) {
      pdfRef.current?.matchAndHighlight?.(key, val, {
        preferredPages: [row.page],
        contextRadiusPx: 16,
      });
    } else {
      pdfRef.current?.locateValue?.(val, {
        preferredPages: [row.page],
        contextRadiusPx: 16,
      });
    }
  };

  // page controls (delegated)
  const prev = () => pdfRef.current?.goto?.(((pdfRef.current || {}).__pageNum || 1) - 1);
  const next = () => pdfRef.current?.goto?.(((pdfRef.current || {}).__pageNum || 1) + 1);

  return (
    <div style={{ display: "grid", gridTemplateColumns: "360px 1fr", height: "100vh" }}>
      {/* LEFT: controls + KV */}
      <div style={{ borderRight: "1px solid #1f2937", background: "#0b1220", color: "#cfe3ff", display: "flex", flexDirection: "column" }}>
        <div style={{ padding: 8, display: "flex", gap: 8, alignItems: "center", borderBottom: "1px solid #1f2937" }}>
          <label className="btn">
            Choose PDF
            <input type="file" accept="application/pdf" style={{ display: "none" }} onChange={onPickPdf} />
          </label>
          <label className="btn">
            Choose DocAI JSON
            <input type="file" accept=".json,.json5,.txt" style={{ display: "none" }} onChange={onPickDocAI} />
          </label>
          <button className="btn" onClick={prev}>Prev</button>
          <button className="btn" onClick={next}>Next</button>
        </div>

        {/* Header */}
        <div style={{ overflow: "auto", flex: 1 }}>
          <div style={{ padding: "8px 10px", borderBottom: "1px solid #1f2937", fontWeight: 600 }}>DocAI Header</div>
          {header.length ? (
            <table className="kv-table">
              <thead><tr><th style={{width:160}}>Key</th><th>Value</th></tr></thead>
              <tbody>
                {header.map((r, i) => (
                  <tr key={`h-${i}`}>
                    <td className="mono">{r.key}</td>
                    <td className="mono" style={{ whiteSpace: "pre-wrap" }}>{r.value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div style={{ padding: "8px 10px", color: "#9fb3d8" }}>No header found.</div>
          )}

          {/* Elements */}
          <div style={{ padding: "8px 10px", borderTop: "1px solid #1f2937", fontWeight: 600 }}>DocAI Elements</div>
          {elements.length ? (
            <KVPane
              header={header}
              elements={elements}
              onHoverRow={handleHoverRow}
              onClickRow={handleClickRow}
            />
          ) : (
            <div style={{ padding: "8px 10px", color: "#9fb3d8" }}>No elements found.</div>
          )}
        </div>
      </div>

      {/* RIGHT: PDF */}
      <div style={{ position: "relative", background: "#0b1220" }}>
        <div style={{ position: "absolute", left: 12, top: 8, zIndex: 5, color: "#cfe3ff" }}>
          <span style={{ fontSize: 12, opacity: 0.8 }}>Hover: dashed DocAI bbox • Click: pink (true)</span>
        </div>
        <PdfCanvas ref={pdfRef} pdfData={pdfData} />
      </div>
    </div>
  );
}