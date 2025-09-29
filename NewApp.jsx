import React, { useRef, useState } from "react";
import PdfCanvas from "./components/PdfCanvas.jsx";
import "./styles.css";

function parseDocAI(text){
  let root = JSON.parse(text);
  if (Array.isArray(root)) root = root[0] || {};
  const doc = root.documents?.[0] || {};
  const props = Array.isArray(doc.properties) ? doc.properties[0] : (doc.properties || {});
  const metaMap = props?.metadata?.metaDataMap || {};
  const pinfo = metaMap.pageInfo || {};
  const dim = pinfo.dimension || {};
  const page = {
    number: Number(pinfo.page_number || 1),
    width: Number(dim.width || 0),
    height: Number(dim.height || 0),
    unit: String(dim.unit || "pixels")
  };

  const fields = [];
  Object.entries(props).forEach(([k,v]) => {
    if (k === "metadata") return;
    if (!v || typeof v !== "object") return;
    const nv = v?.bounding_poly?.normalized_vertices;
    if (Array.isArray(nv) && nv.length){
      const xs = nv.map(p=>Number(p.x||0)), ys = nv.map(p=>Number(p.y||0));
      const x0=Math.min(...xs), y0=Math.min(...ys), x1=Math.max(...xs), y1=Math.max(...ys);
      fields.push({ name:k, value: (typeof v.value==="string"?v.value:String(v.value||"")), page: page.number,
        norm:{x0,y0,x1,y1} });
    }
  });
  return { page, fields };
}

export default function App(){
  const pdfRef = useRef(null);
  const [pdfData, setPdfData] = useState(null);
  const [rows, setRows] = useState([]);

  async function onPickPdf(e){
    const f=e.target.files?.[0]; if(!f) return;
    setPdfData(await f.arrayBuffer());
  }
  async function onPickDocAI(e){
    const f=e.target.files?.[0]; if(!f) return;
    const txt = await f.text();
    const { fields } = parseDocAI(txt);
    setRows(fields);
  }

  function handleHover(row){
    pdfRef.current?.showNormalizedRect(
      row ? { page: row.page, x0: row.norm.x0, y0: row.norm.y0, x1: row.norm.x1, y1: row.norm.y1 } : null
    );
  }

  return (
    <div className="wrap">
      <div className="left">
        <div style={{display:"flex",gap:8,marginBottom:8}}>
          <label className="btn">Choose PDF<input type="file" hidden accept="application/pdf" onChange={onPickPdf}/></label>
          <label className="btn">Choose DocAI JSON<input type="file" hidden accept=".json,.txt" onChange={onPickDocAI}/></label>
        </div>
        <div className="list">
          <h4>Fields ({rows.length})</h4>
          {rows.map((r,i)=>(
            <div key={i} className="row" onMouseEnter={()=>handleHover(r)} onMouseLeave={()=>handleHover(null)}>
              <div className="key">{r.name}</div>
              <div className="dim">{r.value}</div>
            </div>
          ))}
        </div>
      </div>
      <div className="right">
        <PdfCanvas ref={pdfRef} pdfData={pdfData} />
      </div>
    </div>
  );
}