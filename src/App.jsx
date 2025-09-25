// src/App.jsx
import React, { useRef, useState } from "react";
import PdfCanvas from "./components/PdfCanvas.jsx";

// ---------------- tolerant JSON loader ----------------
function parseMaybeJSON(text) {
  // strip BOM
  if (text && text.charCodeAt(0) === 0xFEFF) text = text.slice(1);

  // try strict first
  try { return JSON.parse(text); } catch {}

  // tolerate comments & trailing commas
  let s = text
    .replace(/\/\/.*$/gm, "")              // line comments
    .replace(/\/\*[\s\S]*?\*\//g, "")      // block comments
    .replace(/,\s*([}\]])/g, "$1");        // trailing commas

  // tolerate single-quoted strings
  s = s.replace(/'([^'\\]*(\\.[^'\\]*)*)'/g, (_, inner) => {
    return `"${inner.replace(/"/g, '\\"')}"`;
  });

  // tolerate bare keys  foo: "bar" -> "foo": "bar"
  s = s.replace(/([{,\s])([A-Za-z0-9_.$-]+)\s*:/g, '$1"$2":');

  return JSON.parse(s);
}

// ---------------- schema-agnostic DocAI extractor ----------------
function parseDocAI(raw) {
  if (!raw) return { headerMap: {}, elements: [] };
  const isObj = (x) => x && typeof x === "object" && !Array.isArray(x);

  // 1) find an array that looks like page elements anywhere in the tree
  let elements = null;
  const q = [raw];
  while (q.length) {
    const n = q.shift();
    if (Array.isArray(n)) {
      for (const it of n) q.push(it);
    } else if (isObj(n)) {
      for (const k of Object.keys(n)) {
        const v = n[k];
        if (Array.isArray(v) && v.length && v.every((o) => isObj(o))) {
          const looks = v.slice(0, 8).some(
            (o) => "content" in o || "text" in o || "boundingBox" in o || "bbox" in o
          );
          if (looks) { elements = v; break; }
        }
      }
      if (elements) break;
      for (const k of Object.keys(n)) q.push(n[k]);
    }
  }

  // 2) find a header-like map (prefer metaDataMap / metadataMap)
  let headerMap = {};
  const cand = [];
  const q2 = [raw];
  while (q2.length) {
    const n = q2.shift();
    if (isObj(n)) {
      const keys = Object.keys(n);
      const mdKey = keys.find((k) => /meta.*data.*map/i.test(k));
      if (mdKey && isObj(n[mdKey])) { headerMap = n[mdKey]; break; }

      // primitive-heavy small object -> candidate
      const primCnt = keys.filter((k) => {
        const v = n[k];
        return v == null || ["string","number","boolean"].includes(typeof v);
      }).length;
      if (keys.length && primCnt / keys.length > 0.7 && keys.length >= 3) cand.push(n);

      for (const k of keys) q2.push(n[k]);
    } else if (Array.isArray(n)) {
      for (const it of n) q2.push(it);
    }
  }
  if (!Object.keys(headerMap).length && cand.length) {
    headerMap = cand.sort((a,b)=>Object.keys(b).length-Object.keys(a).length)[0];
  }

  // 3) normalize elements
  const norm = [];
  (elements || []).forEach((el) => {
    const content = String(el.content ?? el.text ?? "").trim();
    const bb = el.boundingBox || el.bbox || null;

    const invalid =
      !bb ||
      !isFinite(bb.x) || !isFinite(bb.y) ||
      !isFinite(bb.width) || !isFinite(bb.height) ||
      Math.abs(bb.x) > 1e6 || Math.abs(bb.y) > 1e6 ||
      Math.abs(bb.width) > 1e6 || Math.abs(bb.height) > 1e6;

    const page =
      Number(el.page) ||
      Number(el.pageNumber) ||
      Number(el.p) ||
      1;

    norm.push({
      page,
      content,
      bbox: invalid ? null : { x: bb.x, y: bb.y, width: bb.width, height: bb.height },
    });
  });

  return { headerMap, elements: norm };
}

// ======================================================

export default function App() {
  const pdfRef = useRef(null);

  const [pdfData, setPdfData] = useState(null);
  const [headerMap, setHeaderMap] = useState({});
  const [elements, setElements] = useState([]);

  // ---------- handlers ----------
  const onChoosePdf = async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const buf = await f.arrayBuffer();
    setPdfData(buf);
  };

  const onChooseDocAI = async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    try {
      const text = await f.text();
      const raw = parseMaybeJSON(text);
      const { headerMap: hm, elements: els } = parseDocAI(raw);
      setHeaderMap(hm || {});
      setElements(Array.isArray(els) ? els : []);
      console.log("[DOCAI] header keys:", Object.keys(hm || {}));
      console.log("[DOCAI] elements:", (els || []).length);
    } catch (err) {
      alert("Invalid JSON. Check console for details.");
      console.error(err);
    }
  };

  // derive a display list for header
  const headerRows = Object.entries(headerMap || {}).map(([k, v]) => ({
    key: k,
    value: typeof v === "object" ? JSON.stringify(v) : String(v ?? ""),
  }));

  return (
    <div style={{ display: "flex", height: "100vh", background: "#0f1220", color: "#cfe" }}>
      {/* Left pane: controls + KV + elements */}
      <div style={{ width: 360, borderRight: "1px solid #223", overflow: "hidden", display: "flex", flexDirection: "column" }}>
        <div style={{ padding: 10, display: "flex", gap: 8 }}>
          <label className="btn">
            Choose PDF
            <input type="file" accept="application/pdf" style={{ display: "none" }} onChange={onChoosePdf} />
          </label>
          <label className="btn">
            Choose DocAI JSON
            <input type="file" accept=".json,.txt" style={{ display: "none" }} onChange={onChooseDocAI} />
          </label>
        </div>

        <div style={{ padding: "8px 10px", fontWeight: 600, borderTop: "1px solid #223" }}>DocAI Header</div>
        <div style={{ height: 180, overflow: "auto", borderTop: "1px solid #223" }}>
          {headerRows.length === 0 ? (
            <div style={{ padding: 10, color: "#89a" }}>No header loaded.</div>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr style={{ color: "#9bd" }}>
                  <th style={{ textAlign: "left", padding: "6px 8px", borderBottom: "1px solid #223" }}>Key</th>
                  <th style={{ textAlign: "left", padding: "6px 8px", borderBottom: "1px solid #223" }}>Value</th>
                </tr>
              </thead>
              <tbody>
                {headerRows.map((r) => (
                  <tr key={r.key}>
                    <td style={{ padding: "6px 8px", borderBottom: "1px dashed #233" }}>{r.key}</td>
                    <td style={{ padding: "6px 8px", borderBottom: "1px dashed #233", color: "#def" }}>{r.value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div style={{ padding: "8px 10px", fontWeight: 600, borderTop: "1px solid #223" }}>
          DocAI Elements <span style={{ color: "#89a", fontWeight: 400 }}>— Hover: show DocAI bbox • Click: find true location</span>
        </div>
        <div style={{ flex: 1, overflow: "auto", borderTop: "1px solid #223" }}>
          {elements.length === 0 ? (
            <div style={{ padding: 10, color: "#89a" }}>No DocAI page elements found.</div>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr style={{ color: "#9bd" }}>
                  <th style={{ textAlign: "left", padding: "6px 8px", borderBottom: "1px solid #223" }}>Content</th>
                  <th style={{ textAlign: "right", padding: "6px 8px", borderBottom: "1px solid #223", width: 40 }}>Page</th>
                </tr>
              </thead>
              <tbody>
                {elements.map((row, i) => (
                  <tr
                    key={i}
                    style={{ cursor: "pointer" }}
                    onMouseEnter={() => {
                      // dashed DocAI bbox (only if valid)
                      pdfRef.current?.showDocAIBbox(row);
                    }}
                    onMouseLeave={() => {
                      pdfRef.current?.showDocAIBbox(null);
                    }}
                    onClick={() => {
                      // pink true location from text match
                      const value = (row?.content || "").trim();
                      pdfRef.current?.locateValue(value, {
                        preferredPages: [row.page || 1],
                        contextRadiusPx: 22,
                        maxWindow: 80,
                      });
                    }}
                  >
                    <td style={{ padding: "6px 8px", borderBottom: "1px dashed #233", color: "#dfe" }}>
                      {row.content || <i style={{ color: "#789" }}>(empty)</i>}
                    </td>
                    <td style={{ padding: "6px 8px", borderBottom: "1px dashed #233", textAlign: "right", color: "#bcd" }}>
                      {row.page || 1}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* Right pane: PDF viewer */}
      <div style={{ flex: 1, position: "relative" }}>
        <PdfCanvas ref={pdfRef} pdfData={pdfData} />
      </div>
    </div>
  );
}