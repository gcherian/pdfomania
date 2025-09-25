// src/App.tsx
import React, { useRef, useState } from "react";
import PdfPane, { PdfPaneHandle } from "./components/PdfPane";
import KVPane from "./components/KVPane";
import { parseDocAI, DocAIFlatRow } from "./lib/docai";
import "./theme.css";

export default function App() {
  const pdfRef = useRef<PdfPaneHandle>(null);

  // *** keep PDF and DocAI states independent ***
  const [pdfData, setPdfData] = useState<ArrayBuffer | null>(null);
  const [rows, setRows] = useState<DocAIFlatRow[]>([]);
  const [header, setHeader] = useState<{ key: string; value: string }[]>([]);

  async function onChoosePdf(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    const buf = await f.arrayBuffer();
    setPdfData(buf);                // <-- only touch PDF state
    e.target.value = "";
  }

  async function onChooseDocAI(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    try {
      const raw = JSON.parse(await f.text());
      const parsed = parseDocAI(raw);
      setHeader(parsed.header);     // <-- only touch DocAI state
      setRows(parsed.elements);
    } catch (err) {
      console.error("[DocAI] parse error:", err);
      alert("Invalid DocAI JSON");
    } finally {
      e.target.value = "";
    }
  }

  return (
    <div className="page">
      <div className="topbar">
        <label className="btn"><input type="file" accept="application/pdf" onChange={onChoosePdf}/>Choose PDF</label>
        <label className="btn"><input type="file" accept="application/json" onChange={onChooseDocAI}/>Choose DocAI JSON</label>
        <span className="muted">{rows.length ? `${rows.length} elements` : ""}</span>
      </div>

      <div className="split">
        <div className="left">
          <KVPane
            header={header}
            rows={rows}
            onHover={(r) => pdfRef.current?.showDocAIBbox(r)}
            onClick={(r) => pdfRef.current?.locateValue(r.content)}
          />
        </div>
        <div className="right">
          <PdfPane ref={pdfRef} pdfData={pdfData} />
        </div>
      </div>
    </div>
  );
}

// at top
import React, { useRef, useState } from "react";
import PdfEditCanvas, { type PdfRefHandle } from "./components/PdfEditCanvas";
import KVPane from "./components/KVPane";
import { parseDocAI, type DocAIFlatRow } from "./lib/docai";

// inside component:
const pdfRef = useRef<PdfRefHandle>(null);

const [pdfData, setPdfData] = useState<ArrayBuffer | null>(null);
const [docHeader, setDocHeader] = useState<{key:string;value:any}[]>([]);
const [docRows, setDocRows] = useState<DocAIFlatRow[]>([]);

// file pickers — NOTE: do not clear the other state
async function onChoosePdf(file: File) {
  const buf = await file.arrayBuffer();
  setPdfData(buf); // only PDF state
}
async function onChooseDocAI(file: File) {
  const parsed = parseDocAI(JSON.parse(await file.text()));
  setDocHeader(parsed.header);      // only DocAI state
  setDocRows(parsed.elements);
}

// layout (keep both panes mounted always)
return (
  <div className="split">
    <div className="left-pane">
      <KVPane
        header={docHeader}
        rows={docRows}
        onHover={(row) => pdfRef.current?.showDocAIBbox(row)}
        onClick={(row) => pdfRef.current?.locateValue(row.content)}
      />
    </div>
    <div className="right-pane">
      <PdfEditCanvas ref={pdfRef} pdfData={pdfData} />
    </div>
  </div>
);