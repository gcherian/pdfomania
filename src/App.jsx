// src/App.tsx
import React, { useRef, useState } from "react";
import KVPane from "./components/KVPane";
import PdfCanvas, { type PdfRefHandle } from "./components/PdfCanvas";
import { parseDocAI } from "./lib/docai";
import { parseMaybeJSON5 } from "./lib/parseJson";

// Types that match what KVPane expects
type DocAIHeaderKV = { key: string; value: any };
type DocAIElement = {
  // parseDocAI() returns at least these; key may be absent for some inputs
  key?: string;
  content?: string;
  value?: string;
  page?: number;
  bbox?: { x: number; y: number; width: number; height: number } | null;
};

export default function App() {
  const pdfRef = useRef<PdfRefHandle | null>(null);

  const [pdfData, setPdfData] = useState<ArrayBuffer | null>(null);
  const [header, setHeader] = useState<DocAIHeaderKV[]>([]);
  const [rows, setRows] = useState<DocAIElement[]>([]);

  // ---- Handlers: file uploads ----
  async function onChoosePdf(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    try {
      const ab = await f.arrayBuffer();
      setPdfData(ab);
      console.log("[PDF] loaded:", f.name, `${ab.byteLength} bytes`);
    } catch (err) {
      console.error("PDF load error:", err);
      alert("Failed to load PDF.");
    } finally {
      e.currentTarget.value = "";
    }
  }

  async function onChooseDocAI(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    try {
      const text = await f.text();
      const raw = parseMaybeJSON5(text);
      const parsed = parseDocAI(raw);
      setHeader(parsed.header || []);
      // Normalize rows to carry a key if present elsewhere
      const elems: DocAIElement[] = (parsed.elements || []).map((el: any) => ({
        key: el.key ?? el.label ?? el.field ?? "",
        content: el.content ?? el.value ?? "",
        page: el.page,
        bbox: el.bbox ?? null,
      }));
      setRows(elems);
      console.log("[DocAI] elements:", elems.length, "header keys:", (parsed.header || []).length);
    } catch (err: any) {
      console.error("DocAI parse error:", err);
      alert(String(err?.message || err) || "Failed to parse DocAI JSON/JSON5.");
    } finally {
      e.currentTarget.value = "";
    }
  }

  // ---- KV → PDF interactions ----
  function handleHover(row: DocAIElement | null) {
    // Show the DocAI-provided bbox as dashed overlay (or clear if null/invalid)
    pdfRef.current?.showDocAIBbox(row as any);
  }

  function handleClick(row: DocAIElement) {
    // Prefer key-aware matching; fall back to value-only
    const key = (row?.key ?? "").trim();
    const val = (row?.content ?? row?.value ?? "").trim();

    if (!val) {
      // nothing to match; just show the DocAI bbox if available
      pdfRef.current?.showDocAIBbox(row as any);
      return;
    }

    pdfRef.current?.matchAndHighlight?.(key, val, {
      preferredPages: row?.page ? [row.page] : undefined,     // tiny page bias if we know it
      numericHint: /^\s*[\d,.\-\/]+\s*$/.test(val),           // zip/amount/id hint
      contextRadiusPx: 140,
      maxWindow: 20
    });
  }

  return (
    <div className="app">
      {/* Top bar */}
      <div className="topbar">
        <div style={{ fontWeight: 700 }}>EDIP — DocAI KV Highlighter</div>
        <div style={{ flex: 1 }} />
        <label className="btn">
          <input
            type="file"
            accept="application/pdf"
            style={{ display: "none" }}
            onChange={onChoosePdf}
          />
          Choose PDF
        </label>
        <label className="btn" style={{ marginLeft: 8 }}>
          <input
            type="file"
            accept="application/json,.json,.json5,text/json"
            style={{ display: "none" }}
            onChange={onChooseDocAI}
          />
          Choose DocAI JSON/JSON5
        </label>
        <div style={{ width: 12 }} />
        <div style={{ color: "#9fb0bd" }}>
          {rows.length ? `${rows.length} elements` : ""}
        </div>
      </div>

      {/* Two-pane body */}
      <div className="body">
        <div className="left">
          <KVPane
            header={header}
            rows={rows as any}
            onHover={handleHover}
            onClick={handleClick}
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