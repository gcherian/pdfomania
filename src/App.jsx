// src/App.jsx
import React, { useRef, useState } from "react";
import PdfCanvas from "./components/PdfCanvas";
import KVPane from "./components/KVPane";

// -----------------------------
// Tolerant JSON loader (no deps)
// -----------------------------
function parseMaybeJSON5(text) {
  if (!text || typeof text !== "string") throw new Error("empty JSON text");

  // 1) remove // line comments
  const noLine = text.replace(/(^|\s)\/\/.*$/gm, "");

  // 2) remove /* block comments */
  const noBlock = noLine.replace(/\/\*[\s\S]*?\*\//g, "");

  // 3) remove trailing commas in objects & arrays
  const noTrailingCommas = noBlock
    .replace(/,\s*([}\]])/g, "$1");

  // 4) allow single quotes: convert to double quotes safely when it looks like JSON keys/strings
  // NOTE: keeps apostrophes inside words/numbers intact (best-effort)
  const withDquotes = noTrailingCommas
    .replace(/'([^'\\]*(\\.[^'\\]*)*)'/g, "\"$1\"");

  // 5) parse
  return JSON.parse(withDquotes);
}

// -----------------------------------
// DocAI extractor (kept inside App.jsx)
// -----------------------------------
function extractDocAI(docaiRoot) {
  // Supports shapes like:
  // { documents: [ { properties: {...}, pages: [{ elements: [ { elementType, content, boundingBox, page } ] }] } ] }
  // Some dumps may be directly { properties, pages } without an outer array.
  let doc = null;

  if (docaiRoot?.documents?.length) doc = docaiRoot.documents[0];
  else if (docaiRoot?.documents) doc = docaiRoot.documents;
  else doc = docaiRoot;

  const header = [];
  const elements = [];

  // ---- header: prefer properties.metadata, else flatten properties
  const meta = doc?.properties?.metadata ?? doc?.properties ?? null;
  if (meta && typeof meta === "object") {
    for (const k of Object.keys(meta)) {
      // skip nullish or giant objects in header view
      const v = meta[k];
      if (v == null) continue;
      const isPlain = typeof v !== "object" || Array.isArray(v);
      header.push({ key: k, value: isPlain ? String(v) : "[object Object]" });
    }
  }

  // ---- elements: paragraphs from pages[].elements[]
  const rawPages = doc?.pages || [];
  for (const p of rawPages) {
    const pageNo = p?.page || p?.pageNumber || null;
    const list = p?.elements || [];
    for (const el of list) {
      const content = el?.content ?? "";
      if (!content || typeof content !== "string") continue;
      const bbox = el?.boundingBox || null;
      elements.push({
        key: guessKeyFromContent(content),
        content,
        page: el?.page ?? pageNo ?? 1,
        bbox: saneBBox(bbox) ? bbox : null, // discard absurd sentinel boxes
      });
    }
  }

  return { header, elements };
}

function saneBBox(b) {
  if (!b) return false;
  const bad = (n) =>
    typeof n !== "number" ||
    !isFinite(n) ||
    Math.abs(n) > 5_000_000; // kill 2147483647 sentinels
  return !(bad(b.x) || bad(b.y) || bad(b.width) || bad(b.height));
}

// very light key guess: "Key: value" → "Key"
function guessKeyFromContent(s) {
  const m = String(s).match(/^\s*([A-Za-z][A-Za-z0-9 _\-\/&]*)\s*:\s*/);
  return m ? m[1].trim() : "";
}

// -----------------------------
// Main Component
// -----------------------------
export default function App() {
  const pdfRef = useRef(null);

  const [pdfData, setPdfData] = useState(null);
  const [header, setHeader] = useState([]);     // [{key,value}]
  const [elements, setElements] = useState([]); // [{key,content,page,bbox}]

  // -----------------------------
  // File pickers
  // -----------------------------
  const onPickPdf = async (ev) => {
    const f = ev.target.files?.[0];
    if (!f) return;
    const buf = await f.arrayBuffer();
    console.log("[PDF] loaded", f.name, buf.byteLength, "bytes");
    setPdfData(buf);
    // reset highlights when loading a new pdf
    setTimeout(() => pdfRef.current?.clearHighlights?.(), 0);
  };

  const onPickDocAI = async (ev) => {
    const f = ev.target.files?.[0];
    if (!f) return;
    const txt = await f.text();
    let root;
    try {
      root = parseMaybeJSON5(txt);
    } catch (e) {
      console.error("[DocAI] parse error:", e);
      alert("Invalid JSON/JSON5 for DocAI.\n\n" + e.message);
      return;
    }
    const { header: H, elements: E } = extractDocAI(root);
    console.log("[DocAI] header keys:", H.map((r) => r.key));
    console.log("[DocAI] elements count:", E.length);
    setHeader(H);
    setElements(E);
  };

  // -----------------------------
  // KV → PDF bridge
  // -----------------------------
  const handleHoverRow = (row) => {
    // dashed DocAI bbox (only if valid)
    console.log("[KV→PDF] hover", row);
    pdfRef.current?.showDocAIBbox?.(row);
  };

  const handleClickRow = (row) => {
    console.log("[KV→PDF] click", row);

    // always show dashed if present
    pdfRef.current?.showDocAIBbox?.(row);

    const key = (row.key || "").trim();
    const val = (row.content || "").trim();

    if (key) {
      console.log("[KV→PDF] matchAndHighlight(key,val) …");
      pdfRef.current?.matchAndHighlight?.(key, val, {
        preferredPages: row.page ? [row.page] : undefined,
        contextRadiusPx: 16,
      });
    } else {
      console.log("[KV→PDF] locateValue(val) …");
      pdfRef.current?.locateValue?.(val, {
        preferredPages: row.page ? [row.page] : undefined,
        contextRadiusPx: 16,
      });
    }
  };

  // simple page controls (delegated to PdfCanvas)
  const gotoPrev = () => pdfRef.current?.goto?.(-1 + Number.NaN) || pdfRef.current?.goto?.((pdfRef.current?.__pageNum || 1) - 1);
  const gotoNext = () => pdfRef.current?.goto?.((pdfRef.current?.__pageNum || 1) + 1);

  return (
    <div className="app-root" style={{ display: "grid", gridTemplateColumns: "360px 1fr", height: "100vh" }}>
      {/* LEFT – controls + KV */}
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
          <button className="btn" onClick={gotoPrev}>Prev</button>
          <button className="btn" onClick={gotoNext}>Next</button>
        </div>

        <div style={{ overflow: "auto", flex: 1 }}>
          <div style={{ padding: "8px 10px", borderBottom: "1px solid #1f2937", fontWeight: 600 }}>DocAI Header</div>
          {header?.length ? (
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

          <div style={{ padding: "8px 10px", borderTop: "1px solid #1f2937", fontWeight: 600 }}>DocAI Elements</div>
          {elements?.length ? (
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

      {/* RIGHT – PDF */}
      <div style={{ position: "relative", background: "#0b1220" }}>
        <div style={{ position: "absolute", left: 12, top: 8, zIndex: 5, color: "#cfe3ff" }}>
          <span style={{ fontSize: 12, opacity: 0.8 }}>Hover: dashed DocAI bbox • Click: find true (pink)</span>
        </div>
        <PdfCanvas ref={pdfRef} pdfData={pdfData} />
      </div>
    </div>
  );
}