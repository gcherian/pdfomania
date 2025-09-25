import React, { useRef, useState } from "react";
import PdfCanvas from "./components/PdfCanvas"; // your existing canvas with ref api
import "./styles.css";                           // keep overlay styles (z-index: 20)

/* ---------------------------
   tolerant parse helpers (inline)
--------------------------- */
function parseMaybeJSON5(text) {
  // 1) try JSON first
  try { return JSON.parse(text); } catch {}
  // 2) very small “tolerant” pass: strip comments + trailing commas
  const noComments = text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|\s)//.*$/gm, "");
  const noTrailingCommas = noComments
    .replace(/,\s*([}\]])/g, "$1");
  return JSON.parse(noTrailingCommas);
}

/* ---------------------------
   in-file DocAI normalizer -> { header, elements }
   (kept here per your request)
--------------------------- */
function normalizeDocAI(doc) {
  const header = [];
  const elements = [];

  if (!doc) return { header, elements };

  // common shapes we saw in your screenshots
  const root = (doc.documents && doc.documents[0]) || doc;
  const props = (root.properties && (root.properties[0] || root.properties)) || {};

  // header / metadata
  const md =
    props.metadata ||
    props.metaDataMap ||
    props.metadatamap ||
    (props.properties && props.properties.metadata) ||
    {};

  Object.entries(md).forEach(([k, v]) => {
    if (v == null) return;
    header.push({ key: String(k), value: typeof v === "object" ? JSON.stringify(v) : String(v) });
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

  const [pdfData, setPdfData] = useState(null);

  // left panel state
  const [docHeader, setDocHeader] = useState([]);     // [{key,value}]
  const [docElements, setDocElements] = useState([]); // [{key|null, content, page, bbox}]

  /* --------- file handlers --------- */
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

  /* --------- layout --------- */
  return (
    <div style={{ display: "grid", gridTemplateColumns: "360px 1fr", height: "100vh", background:"#fff" }}>
      {/* LEFT: KV panel */}
      <div style={{ overflow: "auto", borderRight: "1px solid #e5e7eb", padding: 12 }}>
        {/* Controls */}
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

        {/* Header (optional – you said okay to skip, but we’ll show if parsed) */}
        <div style={{ fontWeight: 700, marginTop: 8, marginBottom: 4 }}>DocAI Header</div>
        {docHeader.length === 0 ? (
          <div style={{ opacity:.6, fontSize:12 }}>No header found.</div>
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

        {/* Elements with hover + click -> highlight on PDF */}
        <div style={{ fontWeight: 700, marginTop: 16, marginBottom: 4 }}>DocAI Elements</div>
        {docElements.length === 0 ? (
          <div style={{ opacity:.6, fontSize:12 }}>No elements found.</div>
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
                  onMouseEnter={() => pdfRef.current?.showDocAIBbox(row)}   // dashed orange (DocAI bbox)
                  onMouseLeave={() => pdfRef.current?.showDocAIBbox(null)}
                  onClick={() =>
                    pdfRef.current?.matchAndHighlight("", row.content, {
                      preferredPages: [row.page],
                      numericHint: /\d/.test(row.content),
                      contextRadiusPx: 28,
                    })
                  }  // pink box (true location)
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
      </div>

      {/* RIGHT: PDF viewer */}
      <div style={{ position: "relative", overflow: "auto" }}>
        <PdfCanvas ref={pdfRef} pdfData={pdfData} />
      </div>
    </div>
  );
}