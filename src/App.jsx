// src/App.tsx
import React, { useRef, useState } from "react";
import PdfCanvas, { type PdfRefHandle } from "./components/PdfCanvas";
import KVPane from "./components/KVPane";

// ---------- Types that KVPane & PdfCanvas expect ----------
export type DocAIHeaderKV = { key: string; value: string };
export type DocAIElement = {
  key: string;              // may be empty if keyless
  content: string;          // full text DocAI gave for this line/para
  page: number;             // 1-based
  bbox: { x: number; y: number; width: number; height: number } | null; // DocAI bbox (may be junk)
};

// ---------- Tolerant JSON (inline, no deps) ----------
function parseMaybeJSON5(text: string): any {
  if (!text) throw new Error("Empty JSON");
  // remove // line comments
  let s = text.replace(/(^|\s)\/\/.*$/gm, "");
  // remove /* ... */ block comments
  s = s.replace(/\/\*[\s\S]*?\*\//g, "");
  // drop trailing commas (objects & arrays)
  s = s.replace(/,\s*([}\]])/g, "$1");
  // allow single-quoted strings
  s = s.replace(/'([^'\\]*(\\.[^'\\]*)*)'/g, "\"$1\"");
  return JSON.parse(s);
}

// ---------- DocAI → header/elements (for your current dumps) ----------
function saneBBox(b: any): b is { x: number; y: number; width: number; height: number } {
  if (!b) return false;
  const bad = (n: any) =>
    typeof n !== "number" || !isFinite(n) || Math.abs(n) > 5_000_000;
  return !(bad(b.x) || bad(b.y) || bad(b.width) || bad(b.height));
}

function guessKeyFromContent(s: string): string {
  const m = String(s).match(/^\s*([A-Za-z][A-Za-z0-9 _\-\/&]*)\s*:\s*/);
  return m ? m[1].trim() : "";
}

function extractDocAI(root: any): { header: DocAIHeaderKV[]; elements: DocAIElement[] } {
  // Support both {documents:[{properties,pages}]} and {properties,pages}
  const doc =
    (root?.documents?.length ? root.documents[0] : root?.documents) ?? root ?? {};

  const header: DocAIHeaderKV[] = [];
  const elements: DocAIElement[] = [];

  // header from properties.metadata or properties
  const meta = doc?.properties?.metadata ?? doc?.properties ?? null;
  if (meta && typeof meta === "object") {
    for (const k of Object.keys(meta)) {
      const v = (meta as any)[k];
      if (v == null) continue;
      header.push({ key: k, value: typeof v === "object" ? "[object Object]" : String(v) });
    }
  }

  // elements from pages[].elements[]
  const pages = Array.isArray(doc?.pages) ? doc.pages : [];
  for (const p of pages) {
    const pageNo = p?.page ?? p?.pageNumber ?? 1;
    const els = Array.isArray(p?.elements) ? p.elements : [];
    for (const el of els) {
      const content = String(el?.content ?? "");
      if (!content) continue;
      const bbox = saneBBox(el?.boundingBox) ? el.boundingBox : null;
      elements.push({
        key: guessKeyFromContent(content),
        content,
        page: Number.isFinite(el?.page) ? el.page : pageNo,
        bbox,
      });
    }
  }

  return { header, elements };
}

// ---------- App ----------
const App: React.FC = () => {
  const pdfRef = useRef<PdfRefHandle | null>(null);

  const [pdfData, setPdfData] = useState<ArrayBuffer | null>(null);
  const [header, setHeader] = useState<DocAIHeaderKV[]>([]);
  const [elements, setElements] = useState<DocAIElement[]>([]);

  // PDF picker
  const onPickPdf: React.ChangeEventHandler<HTMLInputElement> = async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const buf = await f.arrayBuffer();
    setPdfData(buf);
    // clear any existing highlights on new PDF
    setTimeout(() => pdfRef.current?.clearHighlights?.(), 0);
  };

  // DocAI JSON picker
  const onPickDocAI: React.ChangeEventHandler<HTMLInputElement> = async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const txt = await f.text();
    try {
      const root = parseMaybeJSON5(txt);
      const { header: H, elements: E } = extractDocAI(root);
      console.log("[DocAI] header keys:", H.map((r) => r.key));
      console.log("[DocAI] elements:", E.length);
      setHeader(H);
      setElements(E);
    } catch (err: any) {
      console.error("[DocAI] parse error:", err);
      alert("DocAI JSON parse failed:\n" + err?.message);
    }
  };

  // KV → PDF bridge
  const handleHoverRow = (row: DocAIElement) => {
    // dashed DocAI bbox (only if present/valid)
    pdfRef.current?.showDocAIBbox?.(row);
  };

  const handleClickRow = (row: DocAIElement) => {
    // show dashed if present
    pdfRef.current?.showDocAIBbox?.(row);

    const key = (row.key || "").trim();
    const val = (row.content || "").trim();

    if (key) {
      // key-aware match first; PdfCanvas falls back to value-only if needed
      pdfRef.current?.matchAndHighlight?.(key, val, {
        preferredPages: [row.page],
        contextRadiusPx: 16,
      });
    } else {
      // value-only
      pdfRef.current?.locateValue?.(val, {
        preferredPages: [row.page],
        contextRadiusPx: 16,
      });
    }
  };

  // simple page controls (delegated to PdfCanvas)
  const prev = () => pdfRef.current?.goto?.((pdfRef.current as any)?.__pageNum - 1 || 1);
  const next = () => pdfRef.current?.goto?.(((pdfRef.current as any)?.__pageNum || 1) + 1);

  return (
    <div className="app-root" style={{ display: "grid", gridTemplateColumns: "360px 1fr", height: "100vh" }}>
      {/* LEFT: controls + KV */}
      <div style={{ borderRight: "1px solid #1f2937", background: "#0b1220", color: "#cfe3ff", display: "flex", flexDirection: "column" }}>
        <div style={{ padding: 8, display: "flex", gap: 8, alignItems: "center", borderBottom: "1px solid #1f2937" }}>
          <label className="btn">
            Choose PDF
            <input type="file" accept="application/pdf" style={{ display: "none" }} onChange={onPickPdf} />
          </label>
          <label className="btn">
            Choose DocAI JSON
            <input type="file" accept=".json,.json5,.txt" style={{ display: "none" }} onChange={onPickDocAI} />
          </label>
          <button className="btn" onClick={prev}>Prev</button>
          <button className="btn" onClick={next}>Next</button>
        </div>

        {/* Header */}
        <div style={{ overflow: "auto", flex: 1 }}>
          <div style={{ padding: "8px 10px", borderBottom: "1px solid #1f2937", fontWeight: 600 }}>DocAI Header</div>
          {header.length ? (
            <table className="kv-table">
              <thead><tr><th style={{width:160}}>Key</th><th>Value</th></tr></thead>
              <tbody>
                {header.map((r, i) => (
                  <tr key={`h-${i}`}>
                    <td className="mono">{r.key}</td>
                    <td className="mono" style={{ whiteSpace: "pre-wrap" }}>{r.value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div style={{ padding: "8px 10px", color: "#9fb3d8" }}>No header found.</div>
          )}

          {/* Elements */}
          <div style={{ padding: "8px 10px", borderTop: "1px solid #1f2937", fontWeight: 600 }}>DocAI Elements</div>
          {elements.length ? (
            <KVPane
              header={header}
              elements={elements}
              onHoverRow={handleHoverRow}
              onClickRow={handleClickRow}
            />
          ) : (
            <div style={{ padding: "8px 10px", color: "#9fb3d8" }}>No elements found.</div>
          )}
        </div>
      </div>

      {/* RIGHT: PDF */}
      <div style={{ position: "relative", background: "#0b1220" }}>
        <div style={{ position: "absolute", left: 12, top: 8, zIndex: 5, color: "#cfe3ff" }}>
          <span style={{ fontSize: 12, opacity: 0.8 }}>Hover: dashed DocAI bbox • Click: find true (pink)</span>
        </div>
        <PdfCanvas ref={pdfRef} pdfData={pdfData} />
      </div>
    </div>
  );
};

export default App;