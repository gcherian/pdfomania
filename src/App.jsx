import React, { useMemo, useRef, useState } from "react";
import PdfCanvas from "./components/PdfCanvas.jsx";
import KVPane from "./components/KVPane.jsx";
import "./styles.css";

/* -------------------------------------------------------
   1) Tolerant JSON/JSON5 parser kept in this file
------------------------------------------------------- */
function stripCommentsAndTrailingCommas(txt) {
  // remove BOM
  let s = txt.replace(/^\uFEFF/, "");
  // /* ... */ blocks
  s = s.replace(/\/\*[\s\S]*?\*\//g, "");
  // // line comments
  s = s.replace(/(^|\s)\/\/.*$/gm, "");
  // trailing commas before } or ]
  s = s.replace(/,\s*([}\]])/g, "$1");
  return s;
}

function parseMaybeJSON5(text) {
  try { return JSON.parse(text); } catch {}
  try { return JSON.parse(stripCommentsAndTrailingCommas(text)); } catch (e) {
    console.error("[DOCAI] tolerant parse failed:", e);
    return null;
  }
}

/* -------------------------------------------------------
   2) DocAI shape normalizer (robust to nesting)
------------------------------------------------------- */
function isKVObject(o) {
  if (!o || typeof o !== "object" || Array.isArray(o)) return false;
  let keys = Object.keys(o);
  if (!keys.length) return false;
  let strish = 0, deep = 0;
  for (const k of keys) {
    const v = o[k];
    if (v == null) continue;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") strish++;
    else if (typeof v === "object") deep++;
  }
  // prefer mostly flat, string-like objects
  return strish >= 3 && deep <= strish;
}

function firstWhere(root, pred) {
  let found = null;
  (function dfs(n) {
    if (found || n == null) return;
    if (pred(n)) { found = n; return; }
    if (Array.isArray(n)) { for (const x of n) dfs(x); return; }
    if (typeof n === "object") { for (const k in n) dfs(n[k]); }
  })(root);
  return found;
}

function findElementsArray(root) {
  // look for { elements: [ { content, ... } ] }
  let arr = null;
  (function dfs(n) {
    if (arr || n == null) return;
    if (typeof n === "object" && !Array.isArray(n)) {
      if (Array.isArray(n.elements) && n.elements.length) {
        const it = n.elements[0];
        if (it && typeof it === "object" && "content" in it) { arr = n.elements; return; }
      }
      for (const k in n) dfs(n[k]);
    } else if (Array.isArray(n)) {
      for (const x of n) dfs(x);
    }
  })(root);
  return arr || [];
}

function normBBox(bbox) {
  if (!bbox || typeof bbox !== "object") return null;
  const x = Number(bbox.x ?? bbox.left ?? bbox.x0);
  const y = Number(bbox.y ?? bbox.top ?? bbox.y0);
  const w = Number(bbox.width  ?? (bbox.x1 != null && bbox.x != null ? bbox.x1 - bbox.x : bbox.right  != null && bbox.left != null ? bbox.right - bbox.left : null));
  const h = Number(bbox.height ?? (bbox.y1 != null && bbox.y != null ? bbox.y1 - bbox.y : bbox.bottom != null && bbox.top  != null ? bbox.bottom - bbox.top : null));
  if (![x,y,w,h].every(Number.isFinite)) return null;
  // guard against the "2147483647" sentinel
  if (Math.abs(x) > 1e7 || Math.abs(y) > 1e7 || Math.abs(w) > 1e7 || Math.abs(h) > 1e7) return null;
  if (w <= 0 || h <= 0) return null;
  return { x, y, width: w, height: h };
}

function cleanContent(s) {
  return (s ?? "").toString().replace(/\s+/g, " ").trim();
}

/** Accepts a parsed DocAI JSON and returns {headerKV, rows} */
function parseDocAIObject(obj) {
  if (!obj || typeof obj !== "object") return { headerKV: [], rows: [] };

  // Try common spots for metadata/header
  const candidates = [
    obj?.documents?.[0]?.properties?.metaDataMap,
    obj?.documents?.[0]?.properties,
    obj?.document?.[0]?.properties?.metaDataMap,
    obj?.properties?.metaDataMap,
  ].filter(Boolean);

  let headerObj = candidates.find(isKVObject);
  if (!headerObj) {
    // brute-force: first flat-ish object that looks like KV
    headerObj = firstWhere(obj, isKVObject) || {};
  }

  const headerKV = Object.entries(headerObj)
    .map(([k, v]) => ({ key: k, value: v }))
    .sort((a, b) => a.key.localeCompare(b.key));

  // Find elements everywhere
  const elements = findElementsArray(obj);

  const rows = elements.map((el) => ({
    key: null, // unknown in this JSON shape
    content: cleanContent(el.content),
    page: Number(el.page ?? 1),
    bbox: normBBox(el.boundingBox ?? el.bbox ?? null),
  })).filter(r => r.content);

  return { headerKV, rows };
}

/* -------------------------------------------------------
   3) App component
------------------------------------------------------- */
export default function App() {
  const pdfRef = useRef(null);
  const [pdfData, setPdfData] = useState(null);
  const [headerKV, setHeaderKV] = useState([]);
  const [elements, setElements] = useState([]);

  // ----- file load helpers -----
  function onChoosePDF(ev) {
    const f = ev.target.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => setPdfData(reader.result);
    reader.readAsArrayBuffer(f);
  }

  function onChooseDocAI(ev) {
    const f = ev.target.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result || "");
      const obj = parseMaybeJSON5(text);
      if (!obj) {
        alert("Could not parse DocAI JSON. Open dev console for details.");
        return;
      }
      const { headerKV, rows } = parseDocAIObject(obj);
      console.log("[DOCAI] header keys:", headerKV.map(k => k.key));
      console.log("[DOCAI] elements:", rows.length);
      setHeaderKV(headerKV);
      setElements(rows);
    };
    reader.readAsText(f);
  }

  // ----- click / hover handlers for KV list -----
  function onHoverRow(row) {
    // show DocAI-provided (possibly junk) bbox as dashed overlay
    pdfRef.current?.showDocAIBbox(row);
  }

  function onClickRow(row) {
    // prefer value-only locate (robust) with page hint
    pdfRef.current?.matchAndHighlight(row.key || "", row.content || "", {
      preferredPages: [row.page].filter(Boolean),
      contextRadiusPx: 12,
    });
  }

  return (
    <div className="app-shell">
      <aside className="left-pane">
        <div className="toolbar">
          <label className="btn">
            Choose PDF
            <input type="file" accept="application/pdf" onChange={onChoosePDF} hidden />
          </label>
          <label className="btn" style={{ marginLeft: 8 }}>
            Choose DocAI JSON
            <input type="file" accept=".json,.txt" onChange={onChooseDocAI} hidden />
          </label>
        </div>

        <KVPane
          header={headerKV}
          elements={elements}
          onHover={onHoverRow}
          onClick={onClickRow}
        />
      </aside>

      <main className="right-pane">
        <PdfCanvas ref={pdfRef} pdfData={pdfData} />
      </main>
    </div>
  );
}