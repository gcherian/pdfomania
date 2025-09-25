import React, { useRef, useState } from "react";
import PdfCanvas from "./components/PdfCanvas.jsx";
import KVPane from "./components/KVPane.jsx";
import "./styles.css";

/* ---------------- tolerant DocAI text → {header,elements} ---------------- */
function parseDocAIText(text){
  let root=null;
  try{ root = JSON.parse(text); }catch{
    const noComments = text.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm,"");
    const noTrailing = noComments.replace(/,\s*([}\]])/g,"$1");
    root = JSON.parse(noTrailing);
  }
  const doc = root?.documents?.[0] ?? root?.document ?? root ?? {};
  const propsArr = Array.isArray(doc?.properties) ? doc.properties : [doc.properties].filter(Boolean);
  const props = propsArr[0] || {};

  // header
  const meta = props?.metadata?.metaDataMap ?? props?.metaDataMap ?? root?.metaDataMap ?? {};
  const header = Object.entries(meta).map(([key,value])=>({key, value}));

  // elements
  const elements=[];
  const pages = Array.isArray(props?.pages) ? props.pages : (Array.isArray(doc?.pages)?doc.pages:[]);
  pages.forEach((p, idx)=>{
    const pageNo = p?.page ?? p?.pageNumber ?? (idx+1);
    (p?.elements || []).forEach(el=>{
      const content = (el?.content ?? el?.text ?? "").toString();
      if (!content.trim()) return;
      const bb = normalizeBBox(el?.boundingBox ?? el?.bbox ?? el?.box);
      elements.push({ content: content.replace(/\s+/g," ").trim(), page: pageNo, bbox: bb ?? null });
    });
  });

  return { header, elements };
}

function normalizeBBox(bb){
  if (!bb) return null;
  const x = num(bb.x ?? bb.left ?? bb.x0);
  const y = num(bb.y ?? bb.top ?? bb.y0);
  const w = num(bb.width ?? bb.w ?? (bb.right!=null && bb.left!=null ? bb.right - bb.left : null));
  const h = num(bb.height ?? bb.h ?? (bb.bottom!=null && bb.top!=null ? bb.bottom - bb.top : null));
  if ([x,y,w,h].every(v=>Number.isFinite(v) && v>0)) return { x, y, width:w, height:h };
  return null;
}
const num = (v)=> typeof v==="string" ? Number(v) : v;

/* ---------------- simple text-based matcher (no server OCR) -------------- */
function normWords(s){
  return (s||"").toLowerCase().normalize("NFKC").replace(/[^\p{L}\p{N}\s]/gu," ").replace(/\s+/g," ").trim().split(" ").filter(Boolean);
}
function lev(a,b){
  const m=a.length,n=b.length; if(!m&&!n)return 1;
  const dp=new Array(n+1); for(let j=0;j<=n;j++)dp[j]=j;
  for(let i=1;i<=m;i++){ let prev=dp[0]; dp[0]=i;
    for(let j=1;j<=n;j++){ const t=dp[j];
      dp[j]=Math.min(dp[j]+1, dp[j-1]+1, prev+(a[i-1]===b[j-1]?0:1));
      prev=t;
    }
  }
  return 1 - dp[n]/Math.max(1,Math.max(m,n));
}
function findBestWindow(tokens, value, {preferredPages=[], maxWindow=12}={}){
  const target = normWords(value).join(" ");
  if (!target) return null;

  // group by page
  const map=new Map(); tokens.forEach(t=>{const a=map.get(t.page)||[];a.push(t);map.set(t.page,a);});
  map.forEach(arr=>arr.sort((A,B)=> (A.y0===B.y0?A.x0-B.x0:A.y0-B.y0)));

  let best=null;
  map.forEach((toks, pg)=>{
    for(let i=0;i<toks.length;i++){
      const span=[];
      for(let w=0; w<maxWindow && i+w<toks.length; w++){
        span.push(toks[i+w]);
        const txt = span.map(s=>s.text||"").join(" ");
        const score = lev(normWords(txt).join(" "), target) + (preferredPages.includes(pg)?0.03:0);
        if (!best || score>best.score) best = { page:pg, rect:unionRect(span), score };
      }
    }
  });
  return best;
}
function unionRect(span){
  let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity;
  span.forEach(t=>{ x0=Math.min(x0,t.x0); y0=Math.min(y0,t.y0); x1=Math.max(x1,t.x1); y1=Math.max(y1,t.y1); });
  return { x0:Math.floor(x0), y0:Math.floor(y0), x1:Math.ceil(x1), y1:Math.ceil(y1) };
}

/* ---------------- App ---------------- */
export default function App(){
  const pdfRef = useRef(null);
  const [pdfData, setPdfData] = useState(null);
  const [headerRows, setHeaderRows] = useState([]);
  const [elementRows, setElementRows] = useState([]);

  async function onPickPdf(e){
    const f=e.target.files?.[0]; if(!f) return;
    setPdfData(await f.arrayBuffer());
  }
  async function onPickDocAI(e){
    const f=e.target.files?.[0]; if(!f) return;
    const text = await f.text();
    const { header, elements } = parseDocAIText(text);
    console.log("[app] parsed header =", header);
    console.log("[app] parsed elements =", elements.length);
    setHeaderRows(header);
    setElementRows(elements);
  }

  function handleHover(row){
    pdfRef.current?.showDocAIBbox(row);
  }
  async function handleClick(row){
    if (!row?.content) return;
    // Prefer DocAI bbox if present
    if (row.bbox){
      const r = { x0:row.bbox.x, y0:row.bbox.y, x1:row.bbox.x+row.bbox.width, y1:row.bbox.y+row.bbox.height };
      pdfRef.current?.setLocateRect(row.page||1, r);
      return;
    }
    // Fallback: client-side token match
    const toks = pdfRef.current?.tokensForMatching?.() || [];
    if (!toks.length) return;
    const preferred = row.page ? [row.page] : [];
    const best = findBestWindow(toks, row.content, { preferredPages: preferred, maxWindow:12 });
    if (best){
      pdfRef.current?.setLocateRect(best.page, best.rect);
    }
  }

  return (
    <div className="wrap">
      <KVPane
        header={headerRows}
        elements={elementRows}
        onHover={handleHover}
        onClick={handleClick}
      />
      <div className="right">
        <div className="toolbar" style={{position:"absolute",left:8,top:8,zIndex:10}}>
          <label className="btn">
            Choose PDF
            <input type="file" accept="application/pdf" hidden onChange={onPickPdf}/>
          </label>
          <label className="btn" style={{marginLeft:8}}>
            Choose DocAI JSON
            <input type="file" accept=".json,.txt" hidden onChange={onPickDocAI}/>
          </label>
        </div>
        <PdfCanvas ref={pdfRef} pdfData={pdfData}/>
      </div>
    </div>
  );
}