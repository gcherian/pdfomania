import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { GlobalWorkerOptions, getDocument } from "pdfjs-dist";

// worker (vite-friendly)
GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();

/**
 * Props:
 *  - pdfData: ArrayBuffer
 *  - ocrEndpoint: string (e.g. http://localhost:3001/ocr)
 */
const PdfCanvas = forwardRef(function PdfCanvas({ pdfData, ocrEndpoint }, ref) {
  const canvasRef = useRef(null);
  const overlayRef = useRef(null);
  const pdfRef = useRef(null);
  const pageRef = useRef(null);
  const viewportRef = useRef(null);
  const renderTaskRef = useRef(null);

  const [pageNum, setPageNum] = useState(1);
  // OCR tokens across pages: {page, text, x0,y0,x1,y1} in image-pixel coords
  const tokensRef = useRef([]);         // normalized to current viewport
  const scaleMapRef = useRef({});       // page -> {imgW,imgH,canvasW,canvasH,scaleX,scaleY}

  const hoverRectRef = useRef(null);
  const locateRectRef = useRef(null);

  // load pdf
  useEffect(() => {
    if (!pdfData) return;
    load().catch(console.error);
    async function load() {
      clearAll();
      const doc = await getDocument({ data: pdfData }).promise;
      pdfRef.current = doc;
      setPageNum(1);
      await renderPage(1);
      // Pre-OCR first page (sync with current canvas)
      await ocrCurrentPage();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdfData]);

  useEffect(() => {
    if (!pdfRef.current) return;
    renderPage(pageNum).then(()=>ocrCurrentPage()).catch(console.error);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageNum]);

  async function renderPage(p) {
    try { await renderTaskRef.current?.cancel?.(); } catch {}
    const page = await pdfRef.current.getPage(p);
    pageRef.current = page;

    const rot = (page.rotate || 0) % 360;
    const vp1 = page.getViewport({ scale: 1, rotation: rot });
    const maxDisplay = 1400;
    const baseScale = Math.min(1.6, Math.max(0.8, maxDisplay / Math.max(vp1.width, vp1.height)));
    const vp = page.getViewport({ scale: baseScale, rotation: rot });
    viewportRef.current = vp;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    canvas.width = Math.floor(vp.width);
    canvas.height = Math.floor(vp.height);
    canvas.style.width = `${canvas.width}px`;
    canvas.style.height = `${canvas.height}px`;

    const overlay = overlayRef.current;
    overlay.style.width = `${canvas.width}px`;
    overlay.style.height = `${canvas.height}px`;

    renderTaskRef.current = page.render({ canvasContext: ctx, viewport: vp });
    await renderTaskRef.current.promise;
    renderTaskRef.current = null;
    drawOverlay();
  }

  function clearAll() {
    const c = canvasRef.current;
    if (c) c.getContext("2d").clearRect(0,0,c.width,c.height);
    if (overlayRef.current) overlayRef.current.innerHTML = "";
    tokensRef.current = [];
    scaleMapRef.current = {};
    hoverRectRef.current = locateRectRef.current = null;
  }

  async function ocrCurrentPage() {
    if (!ocrEndpoint) return;
    const canvas = canvasRef.current;
    const page = pageNum;

    // send current canvas as PNG to keep coordinates aligned
    const blob = await new Promise(r => canvas.toBlob(r, "image/png"));
    const fd = new FormData();
    fd.append("page", blob, `p${page}.png`);
    fd.append("pageNumber", String(page));

    const resp = await fetch(ocrEndpoint, { method: "POST", body: fd });
    const { tokens, width, height } = await resp.json();

    // record scaling info (OCR coords are image pixels = canvas pixels)
    scaleMapRef.current[page] = { imgW: width, imgH: height, canvasW: canvas.width, canvasH: canvas.height, scaleX: canvas.width/width, scaleY: canvas.height/height };

    // normalize to viewport coords (same as canvas pixels)
    const norm = (tokens || []).map(t => ({
      page: t.page,
      text: t.text,
      x0: t.x0 * scaleMapRef.current[page].scaleX,
      y0: t.y0 * scaleMapRef.current[page].scaleY,
      x1: t.x1 * scaleMapRef.current[page].scaleX,
      y1: t.y1 * scaleMapRef.current[page].scaleY
    }));

    // merge into tokensRef (only this page here)
    tokensRef.current = tokensRef.current.filter(t => t.page !== page).concat(norm);
  }

  function drawOverlay() {
    const overlay = overlayRef.current;
    overlay.innerHTML = "";
    const add = (r, cls) => {
      if (!r || r.page !== pageNum) return;
      const d = document.createElement("div");
      d.className = cls;
      const x = Math.min(r.x0, r.x1), y = Math.min(r.y0, r.y1);
      const w = Math.abs(r.x1 - r.x0), h = Math.abs(r.y1 - r.y0);
      Object.assign(d.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` });
      overlay.appendChild(d);
    };
    if (hoverRectRef.current) add(hoverRectRef.current, "docai-hover");
    if (locateRectRef.current) add(locateRectRef.current, "docai-locate");
  }

  useImperativeHandle(ref, () => ({
    goto: (p) => setPageNum(Math.max(1, Math.min(p, pdfRef.current?.numPages || 1))),
    showDocAIBbox: (row) => { // optional (DocAI bbox, dashed)
      const r = row?.bbox;
      hoverRectRef.current = r ? { page: row.page || pageNum, x0:r.x, y0:r.y, x1:r.x+r.width, y1:r.y+r.height } : null;
      drawOverlay();
    },
    locateValue: async (rect) => { // legacy hook
      locateRectRef.current = rect ? { page: rect.page || pageNum, ...rect } : null;
      drawOverlay();
    },
    tokensForMatching: () => tokensRef.current,   // expose tokens to parent for matching
    setLocateRect: (page, rect) => {              // parent sets final pink rect
      locateRectRef.current = rect ? { page, ...rect } : null;
      if (rect && page !== pageNum) setPageNum(page); else drawOverlay();
    }
  }));

  return (
    <div className="canvas-stage">
      <div className="pagebar">
        <button className="btn" onClick={()=>setPageNum(p=>Math.max(1,p-1))}>Prev</button>
        <button className="btn" onClick={()=>setPageNum(p=>Math.min((pdfRef.current?.numPages||1),p+1))}>Next</button>
        <span>Page {pageNum}{pdfRef.current ? ` / ${pdfRef.current.numPages}` : ""}</span>
      </div>
      <canvas ref={canvasRef} />
      <div ref={overlayRef} className="overlay"></div>
    </div>
  );
});

export default PdfCanvas;