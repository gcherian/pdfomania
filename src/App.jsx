// src/App.jsx
import React, { useRef, useState } from "react";
import PdfCanvas from "./components/PdfCanvas.jsx";

/* ---------------- Tolerant JSON loader (inline, deterministic) ---------------- */
function parseLooseJSON(text) {
  if (!text) return null;
  // try strict first
  try { return JSON.parse(text); } catch {}
  // permissive cleanup: strip comments, trailing commas, BOM
  const cleaned = text
    .replace(/\/\/[^\n\r]*/g, "")      // // comments
    .replace(/\/\*[\s\S]*?\*\//g, "")  // /* */ comments
    .replace(/,\s*([}\]])/g, "$1")     // trailing commas
    .replace(/\uFEFF/g, "");           // BOM
  try { return JSON.parse(cleaned); } catch { return null; }
}

/* ---------------- DocAI extractor (header + elements) ----------------
   Works with shapes like:
   { documents: [ { properties:{ metaDataMap:{...} }, pages:[ { elements:[...] } ] } ] }
   If pages/elements are nested oddly, we fall back to a light deep-scan.
--------------------------------------------------------------------------- */
function extractDocAI(json) {
  const headerRows = [];   // [{key, value}]
  const elementRows = [];  // [{content, page, bbox|null}]
  if (!json) return { headerRows, elementRows };

  // 1) pick the primary "document"
  const doc = (json.documents && json.documents[0]) || json.document || json;

  // 2) header map (metaDataMap / metadataMap / metaData / metadata)
  let props = doc && doc.properties;
  if (Array.isArray(props)) props = props[0];
  const headerMap =
    (props && (props.metaDataMap || props.metadataMap || props.metaData || props.metadata)) || {};
  for (const k of Object.keys(headerMap)) {
    headerRows.push({ key: String(k), value: headerMap[k] });
  }

  // 3) elements from pages[].elements[]
  const pages = Array.isArray(doc && doc.pages) ? doc.pages : [];
  for (let i = 0; i < pages.length; i++) {
    const pg = pages[i] || {};
    const pageNo = Number(pg.page || pg.pageNumber || i + 1);
    const els = Array.isArray(pg.elements) ? pg.elements : [];
    for (const el of els) {
      const content = String(el?.content ?? el?.text ?? "").trim();
      const bb = el?.boundingBox || el?.bbox || null;
      let bbox = null;
      if (
        bb &&
        Number.isFinite(+bb.x) && Number.isFinite(+bb.y) &&
        Number.isFinite(+bb.width) && Number.isFinite(+bb.height)
      ) {
        bbox = { x: +bb.x, y: +bb.y, width: +bb.width, height: +bb.height };
      }
      if (content) elementRows.push({ content, page: pageNo, bbox });
    }
  }

  // 4) fallback: deep-scan first “elements-like” array if none found
  if (elementRows.length === 0) {
    const q = [doc];
    while (q.length) {
      const node = q.shift();
      if (Array.isArray(node)) {
        for (const it of node) q.push(it);
      } else if (node && typeof node === "object") {
        for (const k of Object.keys(node)) {
          const v = node[k];
          if (Array.isArray(v) && v.length && v.every(o => o && typeof o === "object")) {
            const looks = v.slice(0, 6).some(o => "content" in o || "text" in o);
            if (looks) {
              v.forEach(o => {
                const content = String(o?.content ?? o?.text ?? "").trim();
                if (content) elementRows.push({
                  content, page: Number(o.page || o.pageNumber || 1), bbox: null
                });
              });
              return { headerRows, elementRows };
            }
          }
          q.push(v);
        }
      }
    }
  }

  return { headerRows, elementRows };
}

/* ================================ App ================================ */
export default function App() {
  const pdfRef = useRef(null);
  const [pdfData, setPdfData] = useState(null);     // ArrayBuffer for PdfCanvas
  const [headerRows, setHeaderRows] = useState([]); // DocAI header display (optional)
  const [kvRows, setKvRows] = useState([]);         // DocAI elements list (left pane)

  async function onChoosePdf(e) {
    const f = e.target.files?.[0];
    if (!f) return;
    const ab = await f.arrayBuffer();
    setPdfData(ab);
    console.log("[PDF] bytes:", ab.byteLength);
  }

  async function onChooseDocAI(e) {
    const f = e.target.files?.[0];
    if (!f) return;
    const text = await f.text();
    const json = parseLooseJSON(text);
    if (!json) {
      alert("Could not parse DocAI JSON.");
      setHeaderRows([]); setKvRows([]);
      return;
    }
    const { headerRows: H, elementRows: E } = extractDocAI(json);
    console.log("[DocAI] header keys:", H.map(h => h.key));
    console.log("[DocAI] elements:", E.length);
    setHeaderRows(H);
    setKvRows(E);
  }

  return (
    <div style={{ display: "grid", gridTemplateColumns: "360px 1fr", height: "100vh", background: "#fff", color: "#111" }}>
      {/* LEFT: controls + KV */}
      <div style={{ borderRight: "1px solid #ddd", display: "flex", flexDirection: "column", minWidth: 0 }}>
        <div style={{ padding: 10, display: "flex", gap: 8, borderBottom: "1px solid #eee" }}>
          <label className="btn">
            Choose PDF
            <input type="file" accept="application/pdf" hidden onChange={onChoosePdf} />
          </label>
          <label className="btn">
            Choose DocAI JSON
            <input type="file" accept=".json,.txt" hidden onChange={onChooseDocAI} />
          </label>
        </div>

        {/* Header (optional – helps to verify DocAI parsed) */}
        <div style={{ padding: "8px 10px", fontWeight: 600 }}>DocAI Header</div>
        <div style={{ maxHeight: 160, overflow: "auto", borderTop: "1px solid #eee", borderBottom: "1px solid #eee" }}>
          {headerRows.length === 0 ? (
            <div style={{ padding: 10, color: "#777" }}>No header found.</div>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr style={{ background: "#f7f7f7" }}>
                  <th style={{ textAlign: "left", padding: "6px 8px", width: 140 }}>Key</th>
                  <th style={{ textAlign: "left", padding: "6px 8px" }}>Value</th>
                </tr>
              </thead>
              <tbody>
                {headerRows.map((r, i) => (
                  <tr key={i}>
                    <td style={{ padding: "6px 8px", borderTop: "1px solid #f0f0f0" }}>{r.key}</td>
                    <td style={{ padding: "6px 8px", borderTop: "1px solid #f0f0f0", color: "#222" }}>
                      {typeof r.value === "object" ? JSON.stringify(r.value) : String(r.value ?? "")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Elements (this is the KV list we’re restoring) */}
        <div style={{ padding: "8px 10px", fontWeight: 600 }}>DocAI Elements</div>
        <div style={{ flex: 1, overflow: "auto" }}>
          {kvRows.length === 0 ? (
            <div style={{ padding: 10, color: "#777" }}>No elements found.</div>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr style={{ background: "#f7f7f7" }}>
                  <th style={{ textAlign: "left", padding: "6px 8px" }}>Content</th>
                  <th style={{ width: 48, textAlign: "right", padding: "6px 8px" }}>Page</th>
                </tr>
              </thead>
              <tbody>
                {kvRows.map((row, i) => (
                  <tr
                    key={i}
                    style={{ borderTop: "1px solid #f0f0f0" }}
                    // We will wire hover/click later; keeping passive for now
                    // onMouseEnter={() => pdfRef.current?.showDocAIBbox(row)}
                    // onMouseLeave={() => pdfRef.current?.showDocAIBbox(null)}
                    // onClick={() => pdfRef.current?.matchAndHighlight("", row.content, { preferredPages: [row.page] })}
                  >
                    <td style={{
                      padding: "6px 8px",
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      maxWidth: 260
                    }}>
                      {row.content}
                    </td>
                    <td style={{ padding: "6px 8px", textAlign: "right", color: "#444" }}>
                      {row.page || ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* RIGHT: PDF viewer (unchanged) */}
      <div style={{ position: "relative", background: "#fff" }}>
        <PdfCanvas ref={pdfRef} pdfData={pdfData} />
      </div>
    </div>
  );
}