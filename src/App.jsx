import React, { useRef, useState } from "react";
import PdfCanvas from "./components/PdfCanvas";
import KVPane from "./components/KVPane";
import "./styles.css";

/* ---------------- tolerant JSON loader (safe) ---------------- */
function stripCommentsAndTrailingCommas(txt) {
  let s = txt || "";
  // Remove BOM
  s = s.replace(/^\uFEFF/, "");
  // block comments
  s = s.replace(/\/\*[\s\S]*?\*\//g, "");
  // line comments (requires start or whitespace before //)
  s = s.replace(/(^|\s)\/\/.*$/gm, "$1");
  // trailing commas
  s = s.replace(/,\s*([}\]])/g, "$1");
  // convert single quotes to double (best-effort)
  s = s.replace(/'([^'\\]*(\\.[^'\\]*)*)'/g, "\"$1\"");
  return s;
}

function parseMaybeJSON5(text) {
  try {
    return JSON.parse(text);
  } catch (e) {
    try {
      const cleaned = stripCommentsAndTrailingCommas(text);
      return JSON.parse(cleaned);
    } catch (err) {
      console.error("parseMaybeJSON5 failed:", err);
      return null;
    }
  }
}

/* ---------------- extract docAI-ish header + elements (for many shapes) ---------------- */
function saneBBox(b) {
  if (!b || typeof b !== "object") return false;
  const check = (n) => typeof n === "number" && isFinite(n) && Math.abs(n) < 5e6;
  return check(b.x) && check(b.y) && check(b.width) && check(b.height);
}
function guessKeyFromContent(s) {
  const m = String(s).match(/^\s*([A-Za-z][A-Za-z0-9 _\-\/&]*)\s*:\s*/);
  return m ? m[1].trim() : "";
}

function extractDocAI(root) {
  // try many common shapes
  const doc = (root && root.documents && root.documents.length ? root.documents[0] : root) || {};
  // header
  const header = [];
  const meta = (doc.properties && (doc.properties.metadata || doc.properties)) || null;
  if (meta && typeof meta === "object") {
    Object.keys(meta).forEach((k) => {
      const v = meta[k];
      header.push({ key: k, value: (v == null ? "" : (typeof v === "object" ? JSON.stringify(v) : String(v))) });
    });
  }
  // elements
  const elements = [];
  const pages = Array.isArray(doc.pages) ? doc.pages : [];
  pages.forEach((p) => {
    const pageNo = p?.page ?? p?.pageNumber ?? 1;
    const list = Array.isArray(p?.elements) ? p.elements : [];
    list.forEach((el) => {
      const content = String(el?.content ?? "").trim();
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

/* ---------------- App ---------------- */
export default function App() {
  const pdfRef = useRef(null);

  const [pdfData, setPdfData] = useState(null);
  const [header, setHeader] = useState([]);
  const [elements, setElements] = useState([]);

  async function onPickPdf(e) {
    const f = e.target.files?.[0];
    if (!f) return;
    console.log("[App] loading PDF:", f.name);
    const buf = await f.arrayBuffer();
    setPdfData(buf);
    // clear any highlights
    setTimeout(() => pdfRef.current?.clearHighlights?.(), 0);
  }

  async function onPickDocAI(e) {
    const f = e.target.files?.[0];
    if (!f) return;
    console.log("[App] loading DocAI JSON:", f.name);
    const txt = await f.text();
    console.log("[App] raw JSON length:", txt.length);
    const root = parseMaybeJSON5(txt);
    if (!root) {
      alert("Failed to parse DocAI JSON (see console).");
      return;
    }
    console.log("[App] parsed root keys:", Object.keys(root || {}));
    const { header: H, elements: E } = extractDocAI(root);
    console.log("[App] extracted header keys:", H.map(h => h.key));
    console.log("[App] extracted elements count:", E.length, "first:", E[0] || null);
    setHeader(H);
    setElements(E);
  }

  // KV → PDF
  function onHoverRow(row) {
    console.log("[App] hover row:", row && { page: row.page, hasBbox: !!row.bbox });
    pdfRef.current?.showDocAIBbox?.(row);
  }
  function onClickRow(row) {
    console.log("[App] click row:", row && { page: row.page, key: row.key, contentPreview: (row.content||"").slice(0,60) });
    pdfRef.current?.showDocAIBbox?.(row);
    const key = (row.key || "").trim();
    const val = (row.content || "").trim();
    if (key) {
      console.log("[App] calling matchAndHighlight with key");
      pdfRef.current?.matchAndHighlight?.(key, val, { preferredPages: [row.page] });
    } else {
      console.log("[App] calling locateValue (value-only)");
      pdfRef.current?.locateValue?.(val, { preferredPages: [row.page] });
    }
  }

  // test button (quick)
  function runTestHighlight() {
    console.log("[App] test highlight fired");
    pdfRef.current?.locateValue?.("43812", { preferredPages: [1] });
  }

  return (
    <div className="root-grid">
      <aside className="left-col">
        <div className="toolbar">
          <label className="btn">Choose PDF<input type="file" accept="application/pdf" onChange={onPickPdf} style={{display:"none"}}/></label>
          <label className="btn" style={{marginLeft:8}}>Choose DocAI JSON<input type="file" accept=".json,.txt" onChange={onPickDocAI} style={{display:"none"}}/></label>
          <button className="btn" style={{marginLeft:8}} onClick={runTestHighlight}>Test highlight</button>
        </div>

        <div className="header-section">
          <div className="section-title">DocAI Header</div>
          {header.length === 0 ? <div className="muted">No header found</div> :
            <table className="kv-table"><tbody>
              {header.map((h,i) => (<tr key={i}><td className="mono key">{h.key}</td><td className="mono value">{h.value}</td></tr>))}
            </tbody></table>}
        </div>

        <div className="elements-section">
          <div className="section-title">DocAI Elements</div>
          <KVPane elements={elements} onHoverRow={onHoverRow} onClickRow={onClickRow} />
        </div>
      </aside>

      <main className="right-col">
        <div className="hint">Hover row → dashed DocAI bbox • Click row → pink locate</div>
        <PdfCanvas ref={pdfRef} pdfData={pdfData} />
      </main>
    </div>
  );
}