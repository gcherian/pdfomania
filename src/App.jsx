import React, { useRef, useState } from "react";
import KVPane from "./components/KVPane.jsx";
import PdfCanvas from "./components/PdfCanvas.jsx";
import "./styles.css";

/**
 * @typedef {{key: string, value: any}} DocAIHeaderKV
 * @typedef {{key?: string, content?: string, value?: string, page?: number,
 *            bbox?: {x:number,y:number,width:number,height:number}|null}} DocAIElement
 */

// ---- tolerant DocAI parser (header + page elements) -----------------
function parseDocAI(json) {
  try {
    const root = json || {};
    const docs = Array.isArray(root.documents) ? root.documents : [];
    const doc = docs[0] || {};
    const props = (doc.properties || {});
    const meta = props.metadata || props.metaData || {};
    const headerKVs = [];
    const mdm = meta.metaDataMap || meta.metadatamap || meta.metadataMap || {};
    Object.keys(mdm).forEach((k) => headerKVs.push({ key: k, value: mdm[k] }));

    const pages = Array.isArray(doc.pages) ? doc.pages : [];
    const elements = [];
    pages.forEach((p, pi) => {
      const els = Array.isArray(p.elements) ? p.elements : [];
      els.forEach((e) => {
        const b = e.boundingBox || e.bbox || null;
        elements.push({
          key: e.key || undefined,
          content: typeof e.content === "string" ? e.content : (e.text || ""),
          value: e.value || undefined,
          page: Number(e.page || p.page || pi + 1),
          bbox: b && Number.isFinite(+b.x) && Number.isFinite(+b.y)
            ? { x: +b.x, y: +b.y, width: +b.width, height: +b.height }
            : null,
        });
      });
    });

    return { headerKVs, elements };
  } catch (e) {
    console.error("[DocAI] parse error:", e);
    return { headerKVs: [], elements: [] };
  }
}

// ---------------------------------------------------------------------
export default function App() {
  const pdfRef = useRef(null);
  const [header, setHeader] = useState([]);     // DocAIHeaderKV[]
  const [elements, setElements] = useState([]); // DocAIElement[]

  const onChoosePdf = async (evt) => {
    const f = evt.target.files?.[0];
    if (!f) return;
    try {
      await pdfRef.current?.loadPdf(f);
    } finally {
      evt.target.value = "";
    }
  };

  const onChooseDocAI = async (evt) => {
    const f = evt.target.files?.[0];
    if (!f) return;
    try {
      const txt = await f.text();
      const json = JSON.parse(txt);
      const { headerKVs, elements } = parseDocAI(json);
      setHeader(headerKVs);
      setElements(elements);
      console.log("[DocAI] header keys:", headerKVs.map(kv => kv.key));
      console.log("[DocAI] elements:", elements.length);
    } catch (e) {
      alert("Invalid JSON");
      console.error(e);
    } finally {
      evt.target.value = "";
    }
  };

  return (
    <div className="app">
      <div className="toolbar">
        <label className="btn">
          <input type="file" accept="application/pdf" onChange={onChoosePdf} hidden />
          Choose PDF
        </label>
        <label className="btn">
          <input type="file" accept="application/json" onChange={onChooseDocAI} hidden />
          Choose DocAI JSON
        </label>
      </div>

      <div className="split">
        {/* LEFT: KV + elements */}
        <div className="left">
          <div className="section-title">DocAI Header</div>
          <table className="kv">
            <thead><tr><th>Key</th><th>Value</th></tr></thead>
            <tbody>
              {header.map((kv, i) => (
                <tr key={kv.key + ":" + i}>
                  <td><code>{kv.key}</code></td>
                  <td>{String(kv.value ?? "")}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="section-title" style={{ marginTop: 12 }}>
            DocAI Elements <span className="muted">Hover: show DocAI box • Click: find true location</span>
          </div>
          <div className="list">
            {elements.map((row, i) => (
              <div
                key={(row.content || row.key || "") + ":" + i}
                className="list-row"
                onMouseEnter={() => pdfRef.current?.showDocAIBbox(row)}
                onMouseLeave={() => pdfRef.current?.showDocAIBbox(null)}
                onClick={() => {
                  pdfRef.current?.showDocAIBbox(null);
                  pdfRef.current?.locateByValue(row.content || "");
                }}
              >
                <div className="cell text">{row.content || row.key || "(empty)"} </div>
                <div className="cell page">p{row.page || "-"}</div>
              </div>
            ))}
          </div>
        </div>

        {/* RIGHT: PDF */}
        <div className="right">
          <PdfCanvas ref={pdfRef} />
        </div>
      </div>
    </div>
  );
}