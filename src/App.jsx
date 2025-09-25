// App.tsx — keep your existing UI; just ensure these parts exist.
import React, { useRef, useState } from "react";
import PdfEditCanvas, { type PdfHandle } from "./PdfEditCanvas";

export default function App() {
  const pdfRef = useRef<PdfHandle>(null);
  const [rows, setRows] = useState<any[]>([]); // your DocAI elements list

  const onChoosePdf = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) await pdfRef.current?.loadPdf(f);
    (e.target as HTMLInputElement).value = "";
  };

  const onChooseDocAI = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const raw = JSON.parse(await f.text());

    // *** NORMALIZE your doc to [{content, page, boundingBox?}] ***
    const header = raw?.documents?.[0]?.properties?.metadataMap ?? {};
    const elements = raw?.documents?.[0]?.properties?.pages?.elements ?? [];
    const flat = Array.isArray(elements) ? elements.map((el: any) => ({
      content: String(el?.content ?? "").trim(),
      page: Number(el?.page ?? 1),
      boundingBox: el?.boundingBox || null
    })) : [];

    console.log("[DocAI] header keys:", Object.keys(header || {}));
    console.log("[DocAI] elements:", flat.length);
    setRows(flat);
    (e.target as HTMLInputElement).value = "";
  };

  return (
    <div style={{ display: "grid", gridTemplateColumns: "360px 1fr", height: "100vh" }}>
      {/* LEFT: list */}
      <div style={{ overflow: "auto", borderRight: "1px solid #222", padding: 8 }}>
        <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
          <label className="btn">
            <input type="file" accept="application/pdf" onChange={onChoosePdf} style={{ display: "none" }} />
            Choose PDF
          </label>
          <label className="btn">
            <input type="file" accept="application/json" onChange={onChooseDocAI} style={{ display: "none" }} />
            Choose DocAI JSON
          </label>
        </div>

        <div className="section-title">DocAI Elements</div>
        {!rows.length ? (
          <div className="muted">Upload DocAI JSON…</div>
        ) : (
          <table style={{ width: "100%", fontSize: 12 }}>
            <thead><tr><th>Content</th><th style={{ width: 40 }}>Pg</th></tr></thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}
                  onMouseEnter={() => pdfRef.current?.showDocAIBbox(r)}
                  onClick={() => pdfRef.current?.locateValue(r.content, r.page)}
                  style={{ cursor: "pointer" }}>
                  <td style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.content}</td>
                  <td>{r.page || 1}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* RIGHT: canvas */}
      <PdfEditCanvas ref={pdfRef} />
    </div>
  );
}