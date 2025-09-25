import React, { useMemo, useRef, useState } from "react";
import PdfCanvas, { PdfCanvasHandle } from "./PdfCanvas";
import KVPane from "./KVPane";
import { parseDocAI, DocElement, DocHeader } from "./docai";
import JSON5 from "json5";

export default function App() {
  const pdfRef = useRef<PdfCanvasHandle>(null);

  const [pdfUrl, setPdfUrl] = useState<string>("");
  const [header, setHeader] = useState<DocHeader>({});
  const [elements, setElements] = useState<DocElement[]>([]);
  const [status, setStatus] = useState<string>("");

  function sanitizeJsonLoose(text: string) {
    // remove BOM
    let s = text.replace(/^\uFEFF/, "");
    // normalize smart quotes
    s = s.replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"');
    // strip control chars except tab/newline
    s = s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");
    // trailing commas before } or ]
    s = s.replace(/,\s*([}\]])/g, "$1");
    return s;
  }

  function onPdfChosen(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    const url = URL.createObjectURL(f); // blob:
    setPdfUrl(url);
    setTimeout(() => pdfRef.current?.renderPage(1), 0);
    e.currentTarget.value = "";
  }

  async function onDocAIChosen(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    try {
      const rawText = await f.text();
      let parsed: any | null = null;

      // tolerant parse path
      try {
        parsed = JSON5.parse(rawText);
      } catch {
        try {
          parsed = JSON.parse(sanitizeJsonLoose(rawText));
        } catch (err2) {
          console.error("[DocAI] parse failed:", err2);
          setStatus("Could not parse DocAI JSON (see console).");
          setHeader({});
          setElements([]);
          return;
        }
      }

      const { header, elements } = parseDocAI(parsed);
      setHeader(header ?? {});
      setElements(elements ?? []);
      setStatus(`Loaded ${elements?.length ?? 0} elements`);
    } catch (err) {
      console.error("[DocAI] unexpected error:", err);
      setStatus("Unexpected error while loading DocAI JSON (see console).");
      setHeader({});
      setElements([]);
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
            <input type="file" accept="application/json,.json" onChange={onDocAIChosen} />
            Choose DocAI JSON
          </label>
          <span className="status">
            {status || (elements.length ? `${elements.length} elements` : "")}
          </span>
        </div>

        <div className="section">DocAI Header</div>
        <table className="kv">
          <thead><tr><th>Key</th><th>Value</th></tr></thead>
          <tbody>
            {Object.keys(header).length ? (
              Object.entries(header).map(([k, v]) => (
                <tr key={k}>
                  <td><code>{k}</code></td>
                  <td title={String(v)}>{String(v ?? "")}</td>
                </tr>
              ))
            ) : (
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
            pdfRef.current?.locateValue(row.content || "", row.page);
          }}
        />
      </div>
    ),
    [header, elements, status]
  );

  return (
    <div className="shell">
      {left}
      <div className="right">
        <div className="pagebar">
          <span>Page</span>
          <button onClick={() => pdfRef.current?.prev()}>&lt;</button>
          <button onClick={() => pdfRef.current?.next()}>&gt;</button>
          <span className="spacer" />
        </div>
        <PdfCanvas ref={pdfRef} pdfUrl={pdfUrl} />
      </div>
    </div>
  );
}