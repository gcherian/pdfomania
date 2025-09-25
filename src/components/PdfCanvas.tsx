import React, {forwardRef, useEffect, useImperativeHandle, useRef, useState} from "react";
import { GlobalWorkerOptions, getDocument } from "pdfjs-dist";

// vite-friendly worker path
GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();

const PdfCanvas = forwardRef(function PdfCanvas({ pdfData }, ref) {
  const canvasRef = useRef(null);
  const overlayRef = useRef(null);
  const pdfRef = useRef(null);
  const pageRef = useRef(null);
  const viewportRef = useRef(null);
  const renderTaskRef = useRef(null);

  const [pageNum, setPageNum] = useState(1);

  // text tokens for client-side match (no server OCR)
  const tokensByPageRef = useRef(new Map()); // page -> [{page,text,x0,y0,x1,y1}]

  // rects
  const hoverRectRef = useRef(null);   // dashed
  const locateRectRef = useRef(null);  // solid

  useEffect(() => {
    if (!pdfData) return;
    (async () => {
      clearAll();
      const doc = await getDocument({ data: pdfData }).promise;
      pdfRef.current = doc;
      setPageNum(1);
      await renderPage(1);
    })().catch(console.error);
  }, [pdfData]);

  useEffect(() => {
    if (!pdfRef.current) return;
    renderPage(pageNum).catch(console.error);
  }, [pageNum]);

  async function renderPage(p) {
    try { await renderTaskRef.current?.cancel?.(); } catch {}
    const page = await pdfRef.current.getPage(p);
    pageRef.current = page;

    const rot = (page.rotate || 0) % 360;
    const vp1 = page.getViewport({ scale: 1, rotation: rot });
    const maxDisplay = 1400;
    const baseScale = Math.min(1.6, Math.max(0.8, maxDisplay/Math.max(vp1.width, vp1.height)));
    const vp = page.getViewport({ scale: baseScale, rotation: rot });
    viewportRef.current = vp;

    const c = canvasRef.current;
    const ctx = c.getContext("2d");
    c.width = Math.floor(vp.width);
    c.height = Math.floor(vp.height);
    c.style.width = `${c.width}px`;
    c.style.height = `${c.height}px`;

    const ov = overlayRef.current;
    ov.style.width = `${c.width}px`;
    ov.style.height = `${c.height}px`;

    renderTaskRef.current = page.render({ canvasContext: ctx, viewport: vp });
    await renderTaskRef.current.promise;
    renderTaskRef.current = null;

    // build tokens for this page once
    if (!tokensByPageRef.current.has(p)) {
      const textContent = await page.getTextContent({ normalizeWhitespace:true });
      const items = textContent.items || [];
      const tokens = itemsToWordTokens(items, vp, p);
      tokensByPageRef.current.set(p, tokens);
    }

    drawOverlay();
  }

  function clearAll() {
    const c = canvasRef.current;
    if (c) c.getContext("2d").clearRect(0,0,c.width,c.height);
    if (overlayRef.current) overlayRef.current.innerHTML="";
    hoverRectRef.current = locateRectRef.current = null;
    tokensByPageRef.current = new Map();
  }

  // ---- turn text items into word-level boxes (viewport coords) ----
  function itemsToWordTokens(items, vp, page) {
    const out = [];
    for (const it of items) {
      const str = it.str || it.text || "";
      if (!str) continue;

      const [a,b,c,d,e,f] = it.transform || [1,0,0,1,0,0];
      const fontH = Math.hypot(b, d) || Math.abs(d) || 10;
      const xBase = e;
      const yTop = vp.height - f;
      const chunkWidth = it.width ?? Math.abs(a) * (str.length || 1);

      const parts = splitWords(str);
      const total = str.length || 1;
      let x = xBase;
      for (const w of parts) {
        const frac = w.length/total;
        const wpx = Math.max(2, chunkWidth*frac);
        out.push({ page, text:w, x0:x, y0:Math.max(0,yTop-fontH), x1:x+wpx, y1:yTop });
        x += wpx;
      }
    }
    out.sort((A,B)=> (A.y0===B.y0 ? A.x0-B.x0 : A.y0-B.y0));
    return out;
  }
  function splitWords(s){
    const tokens=[]; let buf="";
    const flush=()=>{ if(buf.trim()) tokens.push(buf); buf=""; };
    for(const ch of s){
      if(/\d/.test(ch)) buf+=ch;
      else if(/[.,\-\/]/.test(ch) && /\d/.test(buf.slice(-1))) buf+=ch;
      else if(/\s/.test(ch)) flush();
      else if(/[A-Za-z]/.test(ch)) buf+=ch;
      else flush();
    }
    flush(); return tokens;
  }

  // ---- overlay ----
  function drawOverlay(){
    const ov = overlayRef.current;
    ov.innerHTML="";
    const add = (r, cls)=>{
      if(!r || r.page!==pageNum) return;
      const d = document.createElement("div");
      d.className = cls;
      const x=Math.min(r.x0,r.x1), y=Math.min(r.y0,r.y1);
      const w=Math.abs(r.x1-r.x0), h=Math.abs(r.y1-r.y0);
      Object.assign(d.style,{left:`${x}px`,top:`${y}px`,width:`${w}px`,height:`${h}px`});
      ov.appendChild(d);
    };
    if (hoverRectRef.current) add(hoverRectRef.current,"docai-hover");
    if (locateRectRef.current) add(locateRectRef.current,"docai-locate");
  }

  useImperativeHandle(ref, ()=>({
    goto:(p)=> setPageNum(Math.max(1, Math.min(p, pdfRef.current?.numPages || 1))),
    showDocAIBbox:(row)=>{ // dashed hover
      const r = row?.bbox;
      hoverRectRef.current = r ? { page:row.page||pageNum, x0:r.x, y0:r.y, x1:r.x+r.width, y1:r.y+r.height } : null;
      if (r && row.page && row.page!==pageNum) setPageNum(row.page); else drawOverlay();
    },
    tokensForMatching:()=>{
      const all=[];
      tokensByPageRef.current.forEach(v=>all.push(...v));
      return all;
    },
    setLocateRect:(page, rect)=>{
      locateRectRef.current = rect? {page, ...rect}: null;
      if (rect && page!==pageNum) setPageNum(page); else drawOverlay();
    }
  }));

  return (
    <div className="canvas-stage">
      <div className="pagebar">
        <button className="btn" onClick={()=>setPageNum(p=>Math.max(1,p-1))}>Prev</button>
        <button className="btn" onClick={()=>setPageNum(p=>Math.min((pdfRef.current?.numPages||1),p+1))}>Next</button>
        <span>Page {pageNum}{pdfRef.current?` / ${pdfRef.current.numPages}`:""}</span>
      </div>
      <canvas ref={canvasRef}/>
      <div ref={overlayRef} className="overlay"/>
    </div>
  );
});

export default PdfCanvas;