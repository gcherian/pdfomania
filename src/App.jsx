// src/App.jsx
import React, { useRef, useState } from "react";
import PdfCanvas from "./components/PdfCanvas.jsx";
import KVPane from "./components/KVPane.jsx";
import { parseMaybeJSON5, parseDocAI } from "./lib/parsejson.js";

export default function App() {
  const pdfRef = useRef(null);

  const [pdfData, setPdfData] = useState(null);
  const [header, setHeader] = useState([]);   // not shown here, but available
  const [rows, setRows] = useState([]);       // KVPane source

  async function onChoosePdf(ev) {
    const f = ev.target.files?.[0];
    if (!f) return;
    setPdfData(await f.arrayBuffer());
  }

  async function onChooseDocAI(ev) {
    const f = ev.target.files?.[0];
    if (!f) return;
    try {
      const json = await parseMaybeJSON5(f);
      const { header: hdr, elements } = parseDocAI(json);
      console.log("[DOCAI] header keys:", hdr.map(h => h.key));
      console.log("[DOCAI] elements:", elements.length);
      setHeader(hdr);
      setRows(elements);
    } catch (e) {
      alert(e.message || "Failed to parse DocAI JSON");
    }
  }

  return (
    <div style={{ display: "grid", gridTemplateColumns: "320px 1fr", height: "100vh", background: "#0e0f12", color: "#eee" }}>
      {/* Left pane */}
      <div style={{ padding: 12, borderRight: "1px solid #222" }}>
        <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
          <label className="btn">
            Choose PDF
            <input type="file" accept="application/pdf" style={{ display: "none" }} onChange={onChoosePdf} />
          </label>
          <label className="btn">
            Choose DocAI JSON
            <input type="file" accept=".json,.txt" style={{ display: "none" }} onChange={onChooseDocAI} />
          </label>
        </div>

        <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 6 }}>
          Hover: shows DocAI bbox (dashed). Click: finds true location (pink).
        </div>

        <KVPane
          rows={rows}
          onHover={(row) => pdfRef.current?.showDocAIBbox(row)}
          onClick={(row) => {
            // KEY is unknown here (DocAI “elements” are mostly values)
            const key = "";
            pdfRef.current?.matchAndHighlight(key, row.content, {
              preferredPages: row.page ? [row.page] : undefined,
              numericHint: /\d/.test(row.content),
            });
          }}
        />
      </div>

      {/* Right pane (PDF) */}
      <div style={{ position: "relative" }}>
        <PdfCanvas ref={pdfRef} pdfData={pdfData} />
      </div>
    </div>
  );
}