import React, { useRef, useState, useMemo } from "react";
import PdfCanvas from "./components/PdfCanvas";
import KVPane from "./components/KVPane";
import "./styles.css";

/** Tolerant JSON parse (accepts JSON or JSON5-ish with trailing commas) */
function parseMaybeJSON(text) {
  try { return JSON.parse(text); } catch {}
  // ultra-tolerant: remove comments & trailing commas
  const scrub = text
    .replace(/\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/,\s*([}\]])/g, "$1");
  return JSON.parse(scrub);
}

/** Convert DocAI JSON to { headerMap, elements[] } */
function parseDocAI(raw) {
  if (!raw) return { headerMap: {}, elements: [] };

  // Support the structure you showed in screenshots:
  // { documents: [ { properties: { metaDataMap: {...}, ... }, pages: [ { elements: [...] } ] } ] }
  const doc = raw.documents?.[0] || raw.document || raw;

  const props = doc.properties || {};
  const headerMap = (props.metaDataMap || props.metadataMap || props.metaData || {});

  const pages = doc.pages || [];
  const elements = [];
  pages.forEach((p, idx) => {
    const pageNo = Number(p.page) || idx + 1;
    (p.elements || []).forEach((el) => {
      const content = (el.content || "").trim();
      const bb = el.boundingBox || el.bbox || null;

      // keep obviously invalid DocAI boxes out
      const isBad =
        !bb ||
        !isFinite(bb.x) || !isFinite(bb.y) ||
        !isFinite(bb.width) || !isFinite(bb.height) ||
        Math.abs(bb.x) > 1e6 || Math.abs(bb.y) > 1e6 ||
        Math.abs(bb.width) > 1e6 || Math.abs(bb.height) > 1e6;

      elements.push({
        page: pageNo,
        content,
        bbox: isBad ? null : { x: bb.x, y: bb.y, width: bb.width, height: bb.height },
      });
    });
  });

  return { headerMap, elements };
}

export default function App() {
  const pdfRef = useRef(null);

  const [pdfData, setPdfData] = useState(null);              // ArrayBuffer for canvas
  const [docaiHeader, setDocaiHeader] = useState({});        // metaDataMap
  const [docaiElements, setDocaiElements] = useState([]);    // page elements table

  // ---------- file handlers ----------
  const onChoosePdf = async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const buf = await f.arrayBuffer();
    setPdfData(buf);                 // <-- this drives PdfCanvas; no .loadPdf()
  };

  const onChooseDocAI = async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const text = await f.text();
    let raw;
    try { raw = parseMaybeJSON(text); }
    catch (err) {
      alert("Invalid JSON"); console.error(err); return;
    }
    const { headerMap, elements } = parseDocAI(raw);
    setDocaiHeader(headerMap || {});
    setDocaiElements(Array.isArray(elements) ? elements : []);
    console.log("[DOCAI] header keys:", Object.keys(headerMap || {}));
    console.log("[DOCAI] elements:", elements?.length || 0);
  };

  // Actions from the left list into the PDF
  const onRowHover = (row) => {
    // dashed DocAI bbox (only if bbox exists & was not filtered as invalid)
    pdfRef.current?.showDocAIBbox(row || null);
  };

  const onRowClick = (row) => {
    // Try key-aware match; we don’t have key here, so value-only locate,
    // but prefer the page the element came from.
    pdfRef.current?.matchAndHighlight("", row?.content || "", {
      preferredPages: row?.page ? [row.page] : undefined,
      numericHint: /\d/.test(row?.content || "")
    });
  };

  // render header KV as flat array for KVPane
  const headerRows = useMemo(() => {
    return Object.entries(docaiHeader || {}).map(([k, v]) => ({
      key: k,
      content: String(v ?? ""),
      page: 1,
      bbox: null
    }));
  }, [docaiHeader]);

  return (
    <div className="root">
      <div className="topbar">
        <div>
          <label className="btn">
            Choose PDF
            <input type="file" accept="application/pdf" hidden onChange={onChoosePdf} />
          </label>
          <label className="btn" style={{ marginLeft: 8 }}>
            Choose DocAI JSON
            <input type="file" accept=".json,.json5,.txt" hidden onChange={onChooseDocAI} />
          </label>
        </div>
        <div className="status">
          {docaiElements?.length ? `${docaiElements.length} elements` : ""}
        </div>
      </div>

      <div className="stage">
        <div className="left">
          <KVPane
            headerRows={headerRows}
            elementRows={docaiElements}
            onHoverRow={onRowHover}
            onClickRow={onRowClick}
          />
        </div>
        <div className="right">
          <PdfCanvas ref={pdfRef} pdfData={pdfData} />
        </div>
      </div>
    </div>
  );
}