import React, { useRef, useState } from "react";
import PdfCanvas from "./components/PdfCanvas.jsx";
import KVPane from "./components/KVPane.jsx";
import "./styles.css";

/* ---------------- tolerant DocAI text → {header,elements} ---------------- */
/* ---------------- tolerant DocAI text → {header,elements} ---------------- */
function parseDocAIText(text) {
  // JSON5-ish: strip comments/trailing commas, then parse
  let root = null;
  try { root = JSON.parse(text); }
  catch {
    const noComments = text.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    const noTrailing = noComments.replace(/,\s*([}\]])/g, "$1");
    root = JSON.parse(noTrailing);
  }

  // ---- HEADER ----
  const docNode = root?.documents?.[0] ?? root?.document ?? root ?? {};
  const propsNode = firstDefined(
    // properties may be an array or object
    Array.isArray(docNode?.properties) ? docNode.properties[0] : docNode?.properties,
    Array.isArray(root?.properties) ? root.properties[0] : root?.properties
  );

  const metaMap =
    propsNode?.metadata?.metaDataMap ??
    propsNode?.metaDataMap ??
    root?.metaDataMap ??
    docNode?.metaDataMap ??
    {};
  const header = Object.entries(metaMap || {}).map(([key, value]) => ({ key, value }));

  // ---- ELEMENTS ----
  // We’ll search widely for page-like nodes that contain an `elements` array.
  const pageLikeArrays = findAllPagesArrays(root);
  const elements = [];

  pageLikeArrays.forEach((pages, i) => {
    pages.forEach((p, idx) => {
      const pageNo = numberish(p?.page ?? p?.pageNumber) ?? idx + 1;
      const arrs = firstNonEmpty(
        asArray(p?.elements),
        asArray(p?.paragraphs),
        asArray(p?.blocks),
        asArray(p?.layout?.paragraphs),
        asArray(p?.tokens),
        asArray(p?.words)
      );

      arrs.forEach((el) => {
        const raw = (el?.content ?? el?.text ?? "").toString();
        const content = raw.replace(/\s+/g, " ").trim(); // keep it simple
        if (!content) return;

        const bbRaw =
          el?.boundingBox ??
          el?.bbox ??
          el?.box ??
          el?.location?.boundingBox ??
          el?.layout?.boundingBox ??
          null;

        const bbox = normalizeBBoxLoose(bbRaw); // null if empty/absurd
        elements.push({ content, page: pageNo, bbox });
      });
    });
  });

  // Diagnostics (helps when count is 0)
  console.log("[docai] pageArrays:", pageLikeArrays.length,
              "pages total:", pageLikeArrays.reduce((a,p)=>a+(p?.length||0),0),
              "elements parsed:", elements.length);

  return { header, elements };
}

/* ---------------- utilities used above ---------------- */
function firstDefined(...vals) {
  for (const v of vals) if (v !== undefined && v !== null) return v;
  return undefined;
}
function firstNonEmpty(...arrs) {
  for (const a of arrs) if (Array.isArray(a) && a.length) return a;
  return [];
}
function asArray(v) { return Array.isArray(v) ? v : v ? [v] : []; }
function numberish(v) { if (v == null) return undefined; const n=typeof v==="string"?Number(v):v; return Number.isFinite(n)?n:undefined; }

/** Find arrays that look like "pages" anywhere in the object */
function findAllPagesArrays(root) {
  const hits = [];

  // common direct paths
  const direct = [
    asArray(root?.documents?.[0]?.properties?.pages),
    asArray(root?.documents?.[0]?.properties?.[0]?.pages),
    asArray(root?.documents?.[0]?.pages),
    asArray(root?.document?.pages),
    asArray(root?.pages),
    asArray(root?.properties?.pages),
    asArray(root?.properties?.[0]?.pages),
  ].filter(a => Array.isArray(a) && a.length);
  hits.push(...direct);

  // deep search fallback (in case schema differs)
  const seen = new Set();
  (function walk(node){
    if (!node || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) { node.forEach(walk); return; }
    // Heuristic: array value whose items have element/paragraph-like arrays
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (Array.isArray(v) && v.length && looksLikePagesArray(v)) hits.push(v);
      else walk(v);
    }
  })(root);

  // de-duplicate by reference
  return Array.from(new Set(hits));
}
function looksLikePagesArray(arr){
  // A "page" usually has an `elements` / `paragraphs` / `blocks` array or a `page`/`pageNumber`
  return arr.some(p =>
    p && typeof p === "object" &&
    (Array.isArray(p.elements) || Array.isArray(p.paragraphs) || Array.isArray(p.blocks) ||
     "page" in p || "pageNumber" in p));
}

/** BBox normalizer that tolerates {}, negative/absurd sentinel values */
function normalizeBBoxLoose(bb) {
  if (!bb || typeof bb !== "object") return null;

  // [x,y,w,h] or [x0,y0,x1,y1]
  if (Array.isArray(bb) && bb.length >= 4) {
    const x0 = numberish(bb[0]), y0 = numberish(bb[1]);
    const x1 = numberish(bb[2]), y1 = numberish(bb[3]);
    if (isFinite(x0) && isFinite(y0) && isFinite(x1) && isFinite(y1)) {
      const w = x1 - x0, h = y1 - y0;
      if (w > 0 && h > 0 && sane(x0,y0,w,h)) return { x: x0, y: y0, width: w, height: h };
    }
  }

  // rect/ltrb variants
  const x = numberish(bb.x ?? bb.left ?? bb.x0);
  const y = numberish(bb.y ?? bb.top ?? bb.y0);
  const w = numberish(bb.width ?? bb.w ?? ((bb.right!=null && bb.left!=null) ? (bb.right - bb.left) : undefined));
  const h = numberish(bb.height ?? bb.h ?? ((bb.bottom!=null && bb.top!=null) ? (bb.bottom - bb.top) : undefined));

  if ([x,y,w,h].every(Number.isFinite) && w > 0 && h > 0 && sane(x,y,w,h)) {
    return { x, y, width: w, height: h };
  }

  // otherwise, treat as missing bbox
  return null;
}

function sane(x,y,w,h){
  const LIM = 1e8; // reject 2147483647, etc.
  return [x,y,w,h].every(v => Math.abs(v) < LIM);
}
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