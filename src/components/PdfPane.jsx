import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import * as pdfjsLib from "pdfjs-dist";
import "pdfjs-dist/web/pdf_viewer.css";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url
).toString();

const PdfPane = forwardRef(function PdfPane({ pdfUrl }, ref) {
  const canvasRef = useRef(null);
  const overlayRef = useRef(null);
  const pdfRef = useRef(null);
  const pageRef = useRef(null);
  const viewportRef = useRef(null);
  const renderTaskRef = useRef(null);
  const [pageNum, setPageNum] = useState(1);
  const tokensRef = useRef([]); // [{str,x0,y0,x1,y1}...]

  // load + render
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!pdfUrl) return;
      try {
        if (renderTaskRef.current) { renderTaskRef.current.cancel(); renderTaskRef.current = null; }
        if (pdfRef.current) { try { await pdfRef.current.destroy(); } catch(_){} }
        pdfRef.current = await pdfjsLib.getDocument({ url: pdfUrl }).promise;
        setPageNum(1);
        if (cancelled) return;
        await renderPage(1);
      } catch (err) {
        console.error("PDF load/render error:", err);
      }
    })();
    return () => { cancelled = true; };
  }, [pdfUrl]);

  async function renderPage(n) {
    const pdf = pdfRef.current;
    if (!pdf) return;

    const page = await pdf.getPage(n);
    pageRef.current = page;

    const rot = (page.rotate || 0) % 360;
    const vp1 = page.getViewport({ scale: 1, rotation: rot });
    const baseScale = Math.min(1, 1400 / Math.max(vp1.width, vp1.height));
    const viewport = page.getViewport({ scale: baseScale, rotation: rot });
    viewportRef.current = viewport;

    // canvas sizing
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    canvas.style.width = `${canvas.width}px`;
    canvas.style.height = `${canvas.height}px`;

    overlayRef.current.style.position = "absolute";
    overlayRef.current.style.left = "0px";
    overlayRef.current.style.top = "0px";
    overlayRef.current.style.width = `${canvas.width}px`;
    overlayRef.current.style.height = `${canvas.height}px`;

    // render (cancel any prior)
    if (renderTaskRef.current) try { renderTaskRef.current.cancel(); } catch(_){}

    const task = page.render({ canvasContext: ctx, viewport });
    renderTaskRef.current = task;
    await task.promise;

    // build tokens for text search
    tokensRef.current = await extractTokens(page, viewport);
    drawOverlay(); // clear overlays
  }

  // ---------- helpers ----------
  function drawOverlay() {
    const o = overlayRef.current;
    if (!o) return;
    o.innerHTML = "";
  }
  function placeBox(rect, className) {
    const o = overlayRef.current;
    if (!o) return;
    const d = document.createElement("div");
    d.className = className;
    d.style.position = "absolute";
    d.style.left   = `${rect.x0}px`;
    d.style.top    = `${rect.y0}px`;
    d.style.width  = `${rect.x1 - rect.x0}px`;
    d.style.height = `${rect.y1 - rect.y0}px`;
    o.appendChild(d);
  }
  function validDocAIBBox(b) {
    if (!b) return false;
    const vp = viewportRef.current;
    if (!vp) return false;
    const w = +b.width, h = +b.height, x = +b.x, y = +b.y;
    if (![w,h,x,y].every(Number.isFinite)) return false;
    // reject absurd or negative sizes (your 2147483647 case)
    if (w <= 0 || h <= 0 || w > vp.width*3 || h > vp.height*3) return false;
    if (x < -vp.width || y < -vp.height || x > vp.width*3 || y > vp.height*3) return false;
    return true;
  }

  // ---------- expose API to parent ----------
  useImperativeHandle(ref, () => ({
    async showDocAIBbox(rowOrNull) {
      drawOverlay();
      if (!rowOrNull) return;
      const { bbox, page } = rowOrNull;
      if (page && page !== pageNum) { await renderPage(page); setPageNum(page); }
      if (!validDocAIBBox(bbox)) return; // dashed only if sane
      placeBox({ x0:bbox.x, y0:bbox.y, x1:bbox.x + bbox.width, y1:bbox.y + bbox.height }, "docai");
    },
    async locateValue(raw, pageHint) {
      if (!raw) return;
      const page = pageHint || pageNum;
      if (page !== pageNum) { await renderPage(page); setPageNum(page); }
      const hit = findSpan(raw, tokensRef.current);
      drawOverlay();
      if (hit) placeBox(hit, "pink");
    }
  }));

  return (
    <div style={{position:"relative", overflow:"auto", background:"#0b1220"}}>
      <canvas ref={canvasRef}/>
      <div ref={overlayRef}/>
      <style>{`
        .docai { border: 2px dashed rgba(255,165,0,.9); background: rgba(255,165,0,.10); }
        .pink  { border: 2px solid #ec4899;        background: rgba(236,72,153,.15); box-shadow: 0 0 0 1px rgba(236,72,153,.2) inset; }
      `}</style>
    </div>
  );
});

export default PdfPane;

/* --------- text extraction + matching --------- */
async function extractTokens(page, viewport) {
  const out = [];
  const tc = await page.getTextContent();
  for (const it of tc.items) {
    const t = it.transform; // [a,b,c,d,e,f]
    // map to viewport
    const m = pdfjsLib.Util.transform(viewport.transform, t);
    const x = m[4], yTop = m[5];
    const w = it.width * viewport.scale;
    const h = it.height * viewport.scale;
    const rect = { x0: x, y0: yTop - h, x1: x + w, y1: yTop };
    out.push({ str: it.str || "", ...rect });
  }
  return out;
}

function norm(s) {
  return (s||"").toLowerCase().normalize("NFKC").replace(/\s+/g," ").trim();
}
function findSpan(raw, toks) {
  const want = norm(raw);
  if (!want) return null;
  // sliding window over tokens on page
  for (let i=0;i<toks.length;i++){
    let j=i, acc="";
    while (j<toks.length && acc.length < want.length+4){
      acc = (acc ? acc+" " : "") + norm(toks[j].str);
      if (acc.includes(want)) {
        const rect = union(toks.slice(i,j+1));
        return rect;
      }
      j++;
    }
  }
  return null;
}
function union(span){
  let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity;
  for (const t of span){ x0=Math.min(x0,t.x0); y0=Math.min(y0,t.y0); x1=Math.max(x1,t.x1); y1=Math.max(y1,t.y1); }
  return {x0,y0,x1,y1};
}
