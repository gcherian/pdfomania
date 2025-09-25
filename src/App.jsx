import React, { useRef, useState } from "react";
import PdfCanvas from "./components/PdfCanvas.jsx";
import KVPane from "./components/KVPane.jsx";
import { parseDocAI } from "./lib/docai.js";

export default function App() {
  const pdfRef = useRef(null);
  const [pdfData, setPdfData] = useState(null);
  const [docai, setDocai] = useState({ header: [], elements: [] });

  async function onChoosePdf(e) {
    const f = e.target.files?.[0];
    if (!f) return;
    const ab = await f.arrayBuffer();
    setPdfData(ab);
    e.target.value = "";
    console.log("[PDF] loaded", f.name, ab.byteLength, "bytes");
  }

  async function onChooseDocAI(e) {
    const f = e.target.files?.[0];
    if (!f) return;
    try {
      const txt = await f.text();
      const json = JSON.parse(txt);
      const parsed = parseDocAI(json);
      setDocai(parsed);
      console.log("[DocAI] parsed elements:", parsed.elements.length);
    } catch (err) {
      console.error("Invalid JSON", err);
      alert("Invalid DocAI JSON");
    } finally {
      e.target.value = "";
    }
  }

  return (
    <div className="app">
      <div className="topbar">
        <div style={{fontWeight:700}}>EDIP — KV Highlighter</div>
        <div style={{flex:1}} />
        <label className="btn">
          <input type="file" accept="application/pdf" onChange={onChoosePdf} style={{display:"none"}} />
          Choose PDF
        </label>
        <label className="btn" style={{marginLeft:8}}>
          <input type="file" accept="application/json" onChange={onChooseDocAI} style={{display:"none"}} />
          Choose DocAI JSON
        </label>
        <div style={{width:12}} />
        <div style={{color:"#9fb0bd"}}>{docai.elements.length ? `${docai.elements.length} elements` : ""}</div>
      </div>

      <div className="body">
        <div className="left">
          <KVPane
            header={docai.header}
            rows={docai.elements}
            onHover={(r) => {
              try { pdfRef.current?.showDocAIBbox(r); } catch {}
            }}
            onClick={(r) => {
              try { pdfRef.current?.locateValue(r.content); } catch {}
            }}
          />
        </div>

        <div className="right">
          <div className="canvas-wrap">
            <PdfCanvas ref={pdfRef} pdfData={pdfData} />
          </div>
        </div>
      </div>
    </div>
  );
}