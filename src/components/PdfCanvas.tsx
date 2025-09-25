import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { GlobalWorkerOptions, getDocument } from "pdfjs-dist";

// worker (vite-friendly)
GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();

const PdfCanvas = forwardRef(function PdfCanvas({ pdfData, ocrEndpoint }, ref) {
  const canvasRef = useRef(null);
  const overlayRef = useRef(null);
  const pdfRef = useRef(null);
  const pageRef = useRef(null);
  const viewportRef = useRef(null);
  const renderTaskRef = useRef(null);

  const [pageNum, setPageNum] = useState(1);

  // tokens across pages (viewport coord space)
  const tokensRef = useRef([]);          // [{page,text,x0,y0,x1,y1}]
  const hoverRectRef = useRef(null);
  const locateRectRef = useRef(null);

  useEffect(() => {
    if (!pdfData) return;
    (async () => {
      clearAll();
      const doc = await getDocument({ data: pdfData }).promise;
      pdfRef.current = doc;
      setPageNum(1);
      await renderPage(1);
      await ocrCurrentPage(); // try OCR for current page
    })().catch(console.error);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdfData]);

  useEffect(() => {
    if (!pdfRef.current) return;
    (async () => {
      await renderPage(pageNum);
      await ocrCurrentPage(); // refresh OCR tokens when page changes
    })().catch(console.error);
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

    // ---- fallback tokens from pdf.js textContent (word-ish) ----
    const textContent = await page.getTextContent({ normalizeWhitespace: true });
    const textTokens = buildTextTokens(textContent.items || [], vp, p);
    // replace existing tokens for this page with fallback; OCR (if it comes later) will merge/override
    tokensRef.current = tokensRef.current.filter(t => t.page !== p).concat(textTokens);
    console.log(`[pdf] fallback tokens p${p}:`, textTokens.length, "all:", tokensRef.current.length);

    drawOverlay();
  }

  function clearAll() {
    const c = canvasRef.current;
    if (c) c.getContext("2d").clearRect(0,0,c.width,c.height);
    if (overlayRef.current) overlayRef.current.innerHTML = "";
    tokensRef.current = [];
    hoverRectRef.current = null;
    locateRectRef.current = null;
  }

  // ---- OCR tokens for current canvas image (if server available) ----
  async function ocrCurrentPage() {
    if (!ocrEndpoint) return;
    const canvas = canvasRef.current;
    const page = pageNum;
    const blob = await new Promise(r => canvas.toBlob(r, "image/png"));
    const fd = new FormData();
    fd.append("page", blob, `p${page}.png`);
    fd.append("pageNumber", String(page));

    try {
      const resp = await fetch(ocrEndpoint, { method: "POST", body: fd });
      if (!resp.ok) { console.warn("[ocr] non-OK", resp.status); return; }
      const { tokens = [], width, height } = await resp.json();

      // OCR coords are image pixels == current canvas pixels (we sent the canvas),
      // so just copy them as-is.
      const ocrNorm = tokens.map(t => ({
        page,
        text: t.text ?? "",
        x0: t.x0, y0: t.y0, x1: t.x1, y1: t.y1,
      }));

      // Merge: OCR replaces fallback for this page.
      tokensRef.current = tokensRef.current.filter(t => t.page !== page).concat(ocrNorm);
      console.log(`[ocr] page ${page}: server tokens`, ocrNorm.length, "all:", tokensRef.current.length);
    } catch (e) {
      console.warn("[ocr] fetch failed:", e);
    }
  }

  // ---- pdf.js text items → word-ish tokens ----
  function buildTextTokens(items, vp, page) {
    const out = [];
    for (const it of items) {
      const str = it.str || it.text || "";
      if (!str) continue;

      const [a,b,c,d,e,f] = it.transform || [1,0,0,1,0,0];
      const fontH = Math.hypot(b,d) || Math.abs(d) || 10;
      const xBase = e;
      const yTop = vp.height - f;
      const chunkW = it.width ?? Math.abs(a) * Math.max(1, str.length);

      const parts = splitIntoWords(str);
      const total = Math.max(1, str.length);
      let xCur = xBase;

      for (const part of parts) {
        const w = Math.max(2, chunkW * (part.length/total));
        const x0 = xCur, y0 = Math.max(0, yTop - fontH);
        const x1 = xCur + w, y1 = yTop;
        xCur = x1;
        out.push({ page, text: part, x0, y0, x1, y1 });
      }
    }
    out.sort((A,B) => (A.y0 === B.y0 ? A.x0 - B.x0 : A.y0 - B.y0));
    return out;
  }
  function splitIntoWords(s) {
    const toks = [];
    let buf = "";
    const flush = ()=>{ if (buf.trim()) toks.push(buf); buf=""; };
    for (const ch of s) {
      if (/\d/.test(ch)) buf += ch;
      else if (/[.,\-\/]/.test(ch) && /\d/.test(buf.slice(-1))) buf += ch;
      else if (/\s/.test(ch)) flush();
      else if (/[A-Za-z]/.test(ch)) buf += ch;
      else flush();
    }
    flush();
    return toks;
  }

  function drawOverlay() {
    const overlay = overlayRef.current;
    const canvas = canvasRef.current;
    if (!overlay || !canvas) return;
    overlay.innerHTML = "";

    const add = (r, cls) => {
      if (!r || r.page !== pageNum) return;
      const d = document.createElement("div");
      d.className = cls;
      const x = Math.min(r.x0, r.x1), y = Math.min(r.y0, r.y1);
      const w = Math.abs(r.x1 - r.x0), h = Math.abs(r.y1 - r.y0);
      Object.assign(d.style, { position:"absolute", left:`${x}px`, top:`${y}px`, width:`${w}px`, height:`${h}px` });
      overlay.appendChild(d);
    };
    if (hoverRectRef.current) add(hoverRectRef.current, "docai-hover");
    if (locateRectRef.current) add(locateRectRef.current, "docai-locate");
  }

  useImperativeHandle(ref, () => ({
    goto: (p) => setPageNum(Math.max(1, Math.min(p, pdfRef.current?.numPages || 1))),
    showDocAIBbox: (row) => {
      const r = row?.bbox;
      hoverRectRef.current = r ? { page: row.page || pageNum, x0:r.x, y0:r.y, x1:r.x+r.width, y1:r.y+r.height } : null;
      drawOverlay();
    },
    tokensForMatching: () => tokensRef.current,
    setLocateRect: (page, rect) => {
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
      <div ref={overlayRef} className="overlay" style={{position:"absolute", inset:0, zIndex:2, pointerEvents:"none"}}/>
    </div>
  );
});

export default PdfCanvas;