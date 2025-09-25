import React, { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import PdfCanvas from "./components/PdfCanvas.jsx";

/** Minimal styles so the canvas is visible */
const appShell = {
  display: "grid",
  gridTemplateColumns: "340px 1fr",
  height: "100vh",
  background: "#0b1020",
  color: "#cdd3df",
  fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial",
};
const leftPane = { overflow: "auto", borderRight: "1px solid #1b2337", padding: 12 };
const rowCss = {
  display: "grid",
  gridTemplateColumns: "1fr 44px",
  gap: 8,
  padding: "6px 8px",
  borderBottom: "1px dashed #22304d",
  cursor: "pointer",
};
const toolbar = { display: "flex", gap: 8, marginBottom: 10 };

function App() {
  const pdfRef = useRef(null);
  const [pdfData, setPdfData] = useState(null);
  const [elements, setElements] = useState([]);  // DocAI "pages[].elements[]" flatted
  const [header, setHeader] = useState([]);      // DocAI "metadataMap" entries for header

  async function onChoosePdf(e) {
    const f = e.target.files?.[0];
    if (!f) return;
    try {
      const buf = await f.arrayBuffer();
      setPdfData(buf);
      console.log("[PDF] buffer loaded", f.name, buf.byteLength, "bytes");
    } finally {
      e.target.value = "";
    }
  }

  async function onChooseDocAI(e) {
    const f = e.target.files?.[0];
    if (!f) return;
    try {
      const raw = await f.text();
      const json = JSON.parse(raw);

      // Accept both shapes: {documents:[{properties:{metadataMap, pages}}]}
      // or {documents:{properties:{...}}} (some exports wrap differently)
      const doc = Array.isArray(json.documents) ? json.documents[0] : json.documents;
      const props = doc?.properties ?? json?.properties ?? {};
      const metaMap = props?.metadataMap ?? props?.metadata ?? {};

      // header rows: show top-level metadata (parser, mimeType, executionDateTime, ... + metadataMap)
      const headerRows = [];
      for (const k of Object.keys(props)) {
        if (k === "pages" || k === "metadataMap" || k === "metadata") continue;
        headerRows.push({ key: k, value: typeof props[k] === "object" ? "[object]" : String(props[k]) });
      }
      if (metaMap && typeof metaMap === "object") {
        for (const k of Object.keys(metaMap)) {
          headerRows.push({ key: k, value: String(metaMap[k]) });
        }
      }
      setHeader(headerRows);

      // flatten page elements
      const pages = props?.pages ?? [];
      const out = [];
      pages.forEach((pg, i) => {
        (pg?.elements ?? []).forEach((el) => {
          out.push({
            page: el?.page ?? i + 1,
            content: (el?.content ?? "").replace(/\s+/g, " ").trim(),
            bbox: el?.boundingBox ?? el?.boundingbox ?? el?.bbox ?? null,
          });
        });
      });
      console.log("[DOCAI] elements:", out.length);
      setElements(out);
    } catch (err) {
      console.error("Invalid JSON", err);
      alert("Invalid DocAI JSON. See console.");
    } finally {
      e.target.value = "";
    }
  }

  return (
    <div style={appShell}>
      {/* LEFT: header + elements */}
      <div style={leftPane}>
        <div style={toolbar}>
          <label className="btn">
            <input type="file" accept="application/pdf" onChange={onChoosePdf} style={{ display: "none" }} />
            <span className="btnlike">Choose PDF</span>
          </label>
          <label className="btn">
            <input type="file" accept="application/json" onChange={onChooseDocAI} style={{ display: "none" }} />
            <span className="btnlike">Choose DocAI JSON</span>
          </label>
        </div>

        <div style={{ fontWeight: 700, margin: "6px 0 8px" }}>DocAI Header</div>
        <div>
          {header.map((h, i) => (
            <div key={i} style={{ ...rowCss, fontSize: 12, opacity: 0.9 }}>
              <div>
                <div style={{ color: "#86a2ff" }}>{h.key}</div>
                <div style={{ color: "#cdd3df" }}>{h.value}</div>
              </div>
              <div />
            </div>
          ))}
        </div>

        <div style={{ fontWeight: 700, margin: "16px 0 8px" }}>DocAI Elements</div>
        <div style={{ fontSize: 13, color: "#cdd3df" }}>
          <div style={{ marginBottom: 6, opacity: 0.8 }}>Hover: show DocAI bbox • Click: locate true position</div>
          {elements.map((el, i) => (
            <div
              key={i}
              style={rowCss}
              onMouseEnter={() => pdfRef.current && pdfRef.current.showDocAIBbox(el)}
              onMouseLeave={() => pdfRef.current && pdfRef.current.clearDocAIBbox()}
              onClick={() => pdfRef.current && pdfRef.current.locateValue(el.content, el.page)}
              title={`Page ${el.page}`}
            >
              <div style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {el.content || "(empty)"}
              </div>
              <div style={{ textAlign: "right", color: "#8aa0c7" }}>{el.page}</div>
            </div>
          ))}
        </div>
      </div>

      {/* RIGHT: the PDF */}
      <PdfCanvas ref={pdfRef} pdfData={pdfData} />
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);

// lightweight button look
const s = document.createElement("style");
s.textContent = `
  .btnlike { display:inline-block; background:#1b2337; border:1px solid #2a3757; padding:6px 10px; border-radius:6px; }
  .btnlike:hover { background:#22304d; cursor:pointer; }
`;
document.head.appendChild(s);