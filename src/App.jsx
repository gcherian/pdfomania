import React, { useRef, useState } from "react";
import PdfCanvas from "./components/PdfCanvas";     // keep your existing PdfCanvas with ref API
import "./styles.css";

/* ---------------------------
   tolerant JSON/JSON5-ish parser (inline)
--------------------------- */
function parseMaybeJSON5(text) {
  // 1) try strict JSON first
  try { return JSON.parse(text); } catch {}

  // 2) loosen: remove /* block */ and // line comments, then trailing commas
  const noBlock = text.replace(/\/\*[\s\S]*?\*\//g, "");
  // NOTE: escape the two slashes ↓↓↓
  const noLine  = noBlock.replace(/(^|\s)\/\/.*$/gm, "");
  const noTrail = noLine.replace(/,\s*([}\]])/g, "$1");

  return JSON.parse(noTrail);
}

/* ---------------------------
   normalize DocAI JSON into {header, elements}
--------------------------- */
function normalizeDocAI(doc) {
  const header = [];
  const elements = [];

  if (!doc) return { header, elements };

  const root  = (doc.documents && doc.documents[0]) || doc;
  const props = (root.properties && (root.properties[0] || root.properties)) || {};

  // header-ish metadata
  const md =
    props.metadata ||
    props.metaDataMap ||
    props.metadatamap ||
    (props.properties && props.properties.metadata) ||
    {};

  Object.entries(md).forEach(([k, v]) => {
    if (v == null) return;
    header.push({
      key: String(k),
      value: typeof v === "object" ? JSON.stringify(v) : String(v),
    });
  });

  // page elements
  const pages = props.pages || root.pages || [];
  pages.forEach((pg, idx) => {
    const pageNo = Number.isFinite(pg?.page) ? pg.page : idx + 1;
    const els = pg?.elements || [];
    els.forEach((e) => {
      const text = (e?.content || "").replace(/\s+/g, " ").trim();
      if (!text) return;
      const bb = e.boundingBox || e.bbox || null;
      elements.push({
        key: null,
        content: text,
        page: pageNo,
        bbox: bb
          ? { x: +bb.x || 0, y: +bb.y || 0, width: +bb.width || 0, height: +bb.height || 0 }
          : null,
      });
    });
  });

  return { header, elements };
}

/* ---------------------------
   App
--------------------------- */
export default function App() {
  const pdfRef = useRef(null);

  const [pdfData, setPdfData]         = useState(null);
  const [docHeader, setDocHeader]     = useState([]);   // [{key,value}]
  const [docElements, setDocElements] = useState([]);   // [{key|null, content, page, bbox}]

  async function onChoosePdf(e) {
    const f = e.target.files?.[0];
    if (!f) return;
    const buf = await f.arrayBuffer();
    setPdfData(buf);
  }

  async function onChooseDocAI(e) {
    const f = e.target.files?.[0];
    if (!f) return;
    try {
      const text = await f.text();
      const raw = parseMaybeJSON5(text);
      const { header, elements } = normalizeDocAI(raw);
      setDocHeader(header);
      setDocElements(elements);
      console.log("[DOcAI] header keys:", header.map(h => h.key));
      console.log("[DOcAI] elements:", elements.length);
    } catch (err) {
      console.error(err);
      alert("Could not parse DocAI JSON. Check structure.");
    }
  }

  return (
    <div style={{ display: "grid", gridTemplateColumns: "360px 1fr", height: "100vh", background: "#fff" }}>
      {/* LEFT: KV panel */}
      <aside style={{ overflow: "auto", borderRight: "1px solid #e5e7eb", padding: 12 }}>
        <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
          <label className="btn">
            Choose PDF
            <input type="file" accept="application/pdf" style={{ display: "none" }} onChange={onChoosePdf} />
          </label>
          <label className="btn">
            Choose DocAI JSON
            <input type="file" accept=".json,.txt" style={{ display: "none" }} onChange={onChooseDocAI} />
          </label>
        </div>

        <div style={{ fontWeight: 700, margin: "8px 0 4px" }}>DocAI Header</div>
        {docHeader.length === 0 ? (
          <div className="muted">No header found.</div>
        ) : (
          <table className="kv">
            <thead>
              <tr><th>Key</th><th>Value</th></tr>
            </thead>
            <tbody>
              {docHeader.map((kv, i) => (
                <tr key={i}>
                  <td>{kv.key}</td>
                  <td>{kv.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div style={{ fontWeight: 700, margin: "16px 0 4px" }}>DocAI Elements</div>
        {docElements.length === 0 ? (
          <div className="muted">No elements found.</div>
        ) : (
          <table className="kv">
            <thead>
              <tr>
                <th>Content</th>
                <th style={{ width: 42, textAlign: "right" }}>Page</th>
              </tr>
            </thead>
            <tbody>
              {docElements.map((row, i) => (
                <tr
                  key={i}
                  className="row-hover"
                  onMouseEnter={() => pdfRef.current?.showDocAIBbox(row)}   // dashed orange bbox
                  onMouseLeave={() => pdfRef.current?.showDocAIBbox(null)}
                  onClick={() =>
                    pdfRef.current?.matchAndHighlight("", row.content, {
                      preferredPages: [row.page],
                      numericHint: /\d/.test(row.content),
                      contextRadiusPx: 28,
                    })
                  }  // pink true location
                >
                  <td title={row.content} style={{ maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis" }}>
                    {row.content}
                  </td>
                  <td style={{ textAlign: "right" }}>{row.page}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </aside>

      {/* RIGHT: PDF viewer */}
      <main style={{ position: "relative", overflow: "auto" }}>
        <PdfCanvas ref={pdfRef} pdfData={pdfData} />
      </main>
    </div>
  );
}