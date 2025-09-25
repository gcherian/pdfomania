import React, { useRef, useState } from "react";
import PdfCanvas from "./components/PdfCanvas";
import KVPane from "./components/KVPane";
import "./styles.css";

/* ---------------- string-aware tolerant JSON loader ----------------
   - Keeps http://, https://, file paths, etc.
   - Removes //line and /* block * / comments only OUTSIDE strings
   - Removes trailing commas only OUTSIDE strings
------------------------------------------------------------------- */
function parseMaybeJSON5(text) {
  // First try pure JSON
  try {
    return JSON.parse(text);
  } catch (_) {}

  // Clean comments & trailing commas with a tiny state machine
  const s = text ?? "";
  let out = "";
  let i = 0, n = s.length;
  let inStr = false, strQuote = "";
  let inBlockComment = false, inLineComment = false;

  const peek = (k=0) => (i + k < n ? s[i + k] : "");
  const next = () => s[i++];

  while (i < n) {
    const c = next();

    // handle exiting comments
    if (inBlockComment) {
      if (c === "*" && peek() === "/") { i++; inBlockComment = false; }
      continue;
    }
    if (inLineComment) {
      if (c === "\n" || c === "\r") { inLineComment = false; out += c; }
      continue;
    }

    if (inStr) {
      out += c;
      if (c === "\\" && i < n) { out += next(); } // escape
      else if (c === strQuote) { inStr = false; strQuote = ""; }
      continue;
    }

    // not in string/comment
    if (c === '"' || c === "'") { inStr = true; strQuote = c; out += c; continue; }

    // start of comment?
    if (c === "/" && peek() === "*") { i++; inBlockComment = true; continue; }
    if (c === "/" && peek() === "/") { i++; inLineComment = true; continue; }

    out += c;
  }

  // remove trailing commas (outside strings) e.g., {"a":1,}
  // Also handles arrays: [1,2,]
  let out2 = "";
  inStr = false; strQuote = "";
  for (let j = 0; j < out.length; j++) {
    const ch = out[j];
    if (inStr) {
      out2 += ch;
      if (ch === "\\" && j + 1 < out.length) { out2 += out[++j]; }
      else if (ch === strQuote) { inStr = false; strQuote = ""; }
      continue;
    }
    if (ch === '"' || ch === "'") { inStr = true; strQuote = ch; out2 += ch; continue; }

    if (ch === ",") {
      // lookahead to next non-space
      let k = j + 1;
      while (k < out.length && /\s/.test(out[k])) k++;
      const nxt = out[k];
      if (nxt === "}" || nxt === "]") {
        // skip this comma
        continue;
      }
    }
    out2 += ch;
  }

  try {
    return JSON.parse(out2);
  } catch (err) {
    console.error("parseMaybeJSON5 failed after cleaning:", err);
    return null;
  }
}

/* ---------------- extract docAI-ish header + elements ----------------
Supports these shapes (we’ve seen all in your screenshots):
- root.documents[0].properties.metaDataMap
- root.documents[0].properties.metadata
- root.properties.metaDataMap
- root.properties.metadata
- pages under root.documents[0].pages OR root.pages
Each page: elements[{ content, boundingBox:{x,y,width,height}, page }]
------------------------------------------------------------------- */
function saneBBox(b) {
  if (!b || typeof b !== "object") return false;
  const ok = (v) => typeof v === "number" && isFinite(v) && Math.abs(v) < 5e6;
  return ok(b.x) && ok(b.y) && ok(b.width) && ok(b.height);
}
function guessKeyFromContent(s) {
  const m = String(s).match(/^\s*([A-Za-z][A-Za-z0-9 _\-\/&]*)\s*:\s*/);
  return m ? m[1].trim() : "";
}
function firstDoc(root) {
  if (!root) return null;
  if (Array.isArray(root?.documents) && root.documents.length) return root.documents[0];
  if (Array.isArray(root)) return root[0] || null;
  return root;
}
function getMeta(obj) {
  if (!obj || typeof obj !== "object") return null;
  // common keys we saw: metaDataMap, metadata (and occasionally nested in properties)
  if (obj.metaDataMap && typeof obj.metaDataMap === "object") return obj.metaDataMap;
  if (obj.metadata && typeof obj.metadata === "object") return obj.metadata;
  return null;
}
function extractDocAI(root) {
  const doc = firstDoc(root) || {};
  // header
  const props = doc.properties || doc;
  const meta = getMeta(props) || getMeta(doc) || {};
  const header = Object.keys(meta).map((k) => ({
    key: k,
    value: meta[k] == null ? "" : (typeof meta[k] === "object" ? JSON.stringify(meta[k]) : String(meta[k]))
  }));

  // elements
  const pages = Array.isArray(doc.pages) ? doc.pages : (Array.isArray(root.pages) ? root.pages : []);
  const elements = [];
  pages.forEach((p, idx) => {
    const pageNo = Number.isFinite(p?.page) ? p.page : Number.isFinite(p?.pageNumber) ? p.pageNumber : (idx + 1);
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
    setTimeout(() => pdfRef.current?.clearHighlights?.(), 0);
  }

  async function onPickDocAI(e) {
    const f = e.target.files?.[0];
    if (!f) return;
    console.log("[App] loading DocAI JSON:", f.name);
    const raw = await f.text();
    console.log("[App] raw JSON length:", raw.length, "preview:", raw.slice(0, 120).replace(/\n/g,"⏎"));
    const root = parseMaybeJSON5(raw);
    console.log("[App] parsed root is", root ? "OK" : "NULL");
    console.log("[App] parsed root keys:", Object.keys(root || {}));
    if (!root) {
      alert("Failed to parse DocAI JSON (see console for the first 120 chars).");
      return;
    }
    const { header: H, elements: E } = extractDocAI(root);
    console.log("[App] extracted header keys:", H.map(h => h.key));
    console.log("[App] extracted elements count:", E.length, "first:", E[0] || null);
    setHeader(H);
    setElements(E);
  }

  function onHoverRow(row) {
    pdfRef.current?.showDocAIBbox?.(row);
  }
  function onClickRow(row) {
    pdfRef.current?.showDocAIBbox?.(row);
    const key = (row.key || "").trim();
    const val = (row.content || "").trim();
    if (key) pdfRef.current?.matchAndHighlight?.(key, val, { preferredPages: [row.page] });
    else pdfRef.current?.locateValue?.(val, { preferredPages: [row.page] });
  }

  function runTestHighlight() {
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