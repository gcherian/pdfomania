import React, { useMemo, useRef, useState } from "react";
import PdfCanvas, { PdfCanvasHandle } from "./PdfCanvas";
import { parseDocAI, DocElement, DocHeader } from "./docai";
import KVPane from "./KVPane";

export default function App() {
  const pdfRef = useRef<PdfCanvasHandle>(null);
  const [pdfUrl, setPdfUrl] = useState<string>("");
  const [header, setHeader] = useState<DocHeader>({});
  const [elements, setElements] = useState<DocElement[]>([]);

  const count = elements.length;

  function onPdfChosen(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    const url = URL.createObjectURL(f);
    setPdfUrl(url);
    // next tick to ensure canvas picks it up
    setTimeout(() => pdfRef.current?.renderPage(1), 0);
    e.currentTarget.value = "";
  }

  async function onDocAIChosen(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    try {
      const raw = JSON.parse(await f.text());
      const parsed = parseDocAI(raw);
      setHeader(parsed.header);
      setElements(parsed.elements);
      console.log("[DOcAI] header keys:", Object.keys(parsed.header));
      console.log("[DOcAI] elements:", parsed.elements.length);
    } catch (err) {
      console.error("Invalid JSON:", err);
      alert("Invalid JSON. See console for details.");
    } finally {
      e.currentTarget.value = "";
    }
  }

  const left = useMemo(
    () => (
      <div className="left">
        <div className="title">DocAI KV Highlighter</div>

        <div className="toolbar">
          <label className="btn">
            <input type="file" accept="application/pdf" onChange={onPdfChosen} />
            Choose PDF
          </label>
          <label className="btn">
            <input type="file" accept="application/json" onChange={onDocAIChosen} />
            Choose DocAI JSON
          </label>
          <span className="muted">{count ? `${count} elements` : ""}</span>
        </div>

        <div className="section">DocAI Header</div>
        <table className="kv">
          <thead><tr><th>Key</th><th>Value</th></tr></thead>
          <tbody>
            {Object.entries(header).map(([k, v]) => (
              <tr key={k}>
                <td><code>{k}</code></td>
                <td title={String(v)}>{String(v ?? "")}</td>
              </tr>
            ))}
            {!Object.keys(header).length && (
              <tr><td colSpan={2} className="muted">Upload DocAI JSON…</td></tr>
            )}
          </tbody>
        </table>

        <div className="section">DocAI Elements</div>
        <KVPane
          rows={elements}
          onHover={(row) => pdfRef.current?.showDocAIBbox(row)}
          onLeave={() => pdfRef.current?.showDocAIBbox(null)}
          onClick={(row) => {
            pdfRef.current?.showDocAIBbox(row);
            pdfRef.current?.locateValue(row.content || "");
          }}
        />
      </div>
    ),
    [header, elements, count]
  );

  return (
    <div className="shell">
      {left}
      <div className="right">
        <div className="pagebar">
          <span>Page</span>
          <button onClick={() => pdfRef.current?.prev()}>&lt;</button>
          <span className="pagebadge">{/* page text set internally */}</span>
          <button onClick={() => pdfRef.current?.next()}>&gt;</button>
          <span className="spacer" />
        </div>
        <PdfCanvas ref={pdfRef} pdfUrl={pdfUrl} />
      </div>
    </div>
  );
}