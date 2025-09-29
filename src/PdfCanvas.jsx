import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { GlobalWorkerOptions, getDocument } from "pdfjs-dist";

GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();

const PdfCanvas = forwardRef(function PdfCanvas({ pdfData }, ref){
  const canvasRef = useRef(null);
  const overlayRef = useRef(null);
  const pdfRef = useRef(null);
  const renderTaskRef = useRef(null);
  const [pageNum, setPageNum] = useState(1);
  const hoverNormRef = useRef(null); // {page,x0,y0,x1,y1} in 0..1

  useEffect(()=>{
    let cancelled = false;
    (async ()=>{
      clear();
      if (!pdfData) return;
      try { await renderTaskRef.current?.cancel?.(); } catch {}
      const doc = await getDocument({ data: pdfData }).promise;
      if (cancelled) return;
      pdfRef.current = doc;
      setPageNum(1);
      await renderPage(1);
    })();
    return ()=>{ cancelled = true; };
  }, [pdfData]);

  useEffect(()=>{
    if (!pdfRef.current) return;
    (async()=>{ await renderPage(pageNum); })();
  }, [pageNum]);

  useEffect(()=>{
    const c = canvasRef.current;
    if (!c) return;
    const ro = new ResizeObserver(()=>{ syncOverlay(); drawOverlay(); });
    ro.observe(c);
    return ()=> ro.disconnect();
  }, []);

  async function renderPage(p){
    try { await renderTaskRef.current?.cancel?.(); } catch {}
    const page = await pdfRef.current.getPage(p);
    const vp1 = page.getViewport({ scale: 1 });
    const maxW = 1200;
    const scale = Math.min(1.8, Math.max(0.7, maxW/Math.max(vp1.width, vp1.height)));
    const vp = page.getViewport({ scale });
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    canvas.width  = Math.floor(vp.width);
    canvas.height = Math.floor(vp.height);
    canvas.style.width = canvas.width+"px";
    canvas.style.height= canvas.height+"px";
    syncOverlay();
    renderTaskRef.current = page.render({ canvasContext: ctx, viewport: vp });
    await renderTaskRef.current.promise;
    renderTaskRef.current = null;
    drawOverlay();
  }

  function syncOverlay(){
    const overlay = overlayRef.current, canvas = canvasRef.current;
    if (!overlay || !canvas) return;
    const r = canvas.getBoundingClientRect();
    Object.assign(overlay.style, { position:"absolute", left:`${r.left}px`, top:`${r.top}px`, width:`${r.width}px`, height:`${r.height}px` });
  }

  function drawOverlay(){
    const overlay = overlayRef.current, canvas = canvasRef.current;
    if (!overlay || !canvas) return;
    overlay.innerHTML = "";
    const rect = canvas.getBoundingClientRect();

    const addNorm = (r)=>{
      if (!r || r.page !== pageNum) return;
      const d = document.createElement("div");
      d.className = "docai-box";
      const x = Math.min(r.x0, r.x1) * rect.width;
      const y = Math.min(r.y0, r.y1) * rect.height;
      const w = Math.abs(r.x1 - r.x0) * rect.width;
      const h = Math.abs(r.y1 - r.y0) * rect.height;
      Object.assign(d.style, { position:"absolute", left:`${x}px`, top:`${y}px`, width:`${w}px`, height:`${h}px` });
      overlay.appendChild(d);
    };

    if (hoverNormRef.current) addNorm(hoverNormRef.current);
  }

  function clear(){
    const c = canvasRef.current;
    if (c) c.getContext("2d").clearRect(0,0,c.width,c.height);
    if (overlayRef.current) overlayRef.current.innerHTML = "";
    hoverNormRef.current = null;
  }

  useImperativeHandle(ref, ()=> ({
    // r in normalized 0..1 coords
    showNormalizedRect: (r) => { hoverNormRef.current = r ? { ...r } : null; drawOverlay(); }
  }));

  return (
    <div className="canvas-stage">
      <div className="pagebar">
        <button className="btn" onClick={()=>setPageNum(p=>Math.max(1,p-1))}>Prev</button>
        <button className="btn" onClick={()=>setPageNum(p=>Math.min((pdfRef.current?.numPages||1),p+1))}>Next</button>
        <span style={{marginLeft:8}}>Page {pageNum}{pdfRef.current?` / ${pdfRef.current.numPages}`:""}</span>
      </div>
      <canvas ref={canvasRef}/>
      <div ref={overlayRef} className="overlay"/>
    </div>
  );
});

export default PdfCanvas;