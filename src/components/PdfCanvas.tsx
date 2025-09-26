import React, {
  forwardRef, useEffect, useImperativeHandle,
  useRef, useState
} from "react";
import { GlobalWorkerOptions, getDocument } from "pdfjs-dist";

// worker (vite-friendly)
GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url
).toString();

/**
 * Props:
 *  - pdfData: ArrayBuffer|null
 *  - ocrEndpoint: string | undefined
 */
const PdfCanvas = forwardRef(function PdfCanvas({ pdfData, ocrEndpoint }, ref) {
  // canvas & overlay
  const stageRef    = useRef(null);
  const canvasRef   = useRef(null);
  const overlayRef  = useRef(null);

  // pdf.js
  const pdfRef         = useRef(null);
  const pageRef        = useRef(null);
  const renderTaskRef  = useRef(null);
  const viewportRef    = useRef(null);

  // state
  const [pageNum, setPageNum] = useState(1);
  const [showOCR, setShowOCR] = useState(false);
  const [showDocAI, setShowDocAI] = useState(false);

  // highlights
  const hoverRectRef  = useRef(null);  // DocAI dashed
  const locateRectRef = useRef(null);  // pink final

  // OCR tokens (in canvas pixel space)
  // { page, text, x0,y0,x1,y1 } — coordinates match current canvas pixels
  const tokensRef     = useRef([]);

  /* ----------------------------- Effects ----------------------------- */

  // load PDF when data changes
  useEffect(() => {
    let cancelled = false;
    (async () => {
      clearAll();
      if (!pdfData) return;

      try { await renderTaskRef.current?.cancel?.(); } catch {}
      renderTaskRef.current = null;

      try {
        const doc = await getDocument({ data: pdfData }).promise;
        if (cancelled) return;
        pdfRef.current = doc;
        setPageNum(1);
        await renderPage(1);
        await ocrCurrentPage(); // warm OCR for page 1
      } catch (e) {
        console.error("[pdf] load error:", e);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdfData]);

  // re-render & OCR when page changes
  useEffect(() => {
    if (!pdfRef.current) return;
    (async () => {
      await renderPage(pageNum);
      await ocrCurrentPage();
    })().catch(console.error);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageNum]);

  // keep overlay aligned with canvas resize / zoom
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const ro = new ResizeObserver(() => {
      syncOverlayToCanvas();
      drawOverlay();
    });
    ro.observe(c);
    return () => ro.disconnect();
  }, []);

  /* ------------------------- Render / OCR --------------------------- */

  async function renderPage(p) {
    try { await renderTaskRef.current?.cancel?.(); } catch {}
    const page = await pdfRef.current.getPage(p);
    pageRef.current = page;

    // scale to a sensible width
    const rot = (page.rotate || 0) % 360;
    const vp1 = page.getViewport({ scale: 1, rotation: rot });
    const maxDisplay = 1400;
    const scale = Math.min(1.6, Math.max(0.8, maxDisplay / Math.max(vp1.width, vp1.height)));
    const vp = page.getViewport({ scale, rotation: rot });
    viewportRef.current = vp;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");

    // set the canvas buffer size to viewport pixels
    canvas.width  = Math.floor(vp.width);
    canvas.height = Math.floor(vp.height);
    // and let CSS size be auto (we position overlay by CSS px via getBoundingClientRect)
    canvas.style.width  = `${canvas.width}px`;
    canvas.style.height = `${canvas.height}px`;

    syncOverlayToCanvas();

    renderTaskRef.current = page.render({ canvasContext: ctx, viewport: vp });
    await renderTaskRef.current.promise;
    renderTaskRef.current = null;

    drawOverlay();
  }

  async function ocrCurrentPage() {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // If no server, skip quietly (match will fall back to pdf.js text if you add it later)
    if (!ocrEndpoint) return;

    // Send current canvas as PNG — coords we get back will be image pixels
    const blob = await new Promise(res => canvas.toBlob(res, "image/png"));
    const fd = new FormData();
    fd.append("page", blob, `p${pageNum}.png`);
    fd.append("pageNumber", String(pageNum));

    try {
      const resp = await fetch(ocrEndpoint, { method: "POST", body: fd });
      if (!resp.ok) { console.warn("[ocr] HTTP", resp.status); return; }
      const { tokens, width, height } = await resp.json();

      // Our canvas pixels == PNG pixels we sent → no further transform
      // Keep only current page tokens for this page
      const filtered = (tokens || []).map(t => ({
        page: pageNum,
        text: t.text,
        x0: t.x0, y0: t.y0, x1: t.x1, y1: t.y1
      }));

      tokensRef.current = tokensRef.current.filter(t => t.page !== pageNum).concat(filtered);
      drawOverlay();
    } catch (e) {
      console.warn("[ocr] fetch failed:", e);
    }
  }

  function clearAll() {
    const c = canvasRef.current;
    if (c) c.getContext("2d").clearRect(0, 0, c.width, c.height);
    if (overlayRef.current) overlayRef.current.innerHTML = "";
    hoverRectRef.current = null;
    locateRectRef.current = null;
    tokensRef.current = [];
  }

  /* --------------------- Overlay placement & draw -------------------- */

  function syncOverlayToCanvas() {
    const overlay = overlayRef.current;
    const canvas  = canvasRef.current;
    if (!overlay || !canvas) return;

    // Position overlay exactly over the painted canvas area in CSS pixels
    const r = canvas.getBoundingClientRect();
    const parent = stageRef.current?.getBoundingClientRect();
    const left = parent ? r.left - parent.left : r.left;
    const top  = parent ? r.top  - parent.top  : r.top;

    overlay.style.position = "absolute";
    overlay.style.left  = `${Math.round(left)}px`;
    overlay.style.top   = `${Math.round(top)}px`;
    overlay.style.width = `${Math.round(r.width)}px`;
    overlay.style.height= `${Math.round(r.height)}px`;
  }

  function drawOverlay() {
    const overlay = overlayRef.current;
    const canvas  = canvasRef.current;
    if (!overlay || !canvas) return;

    overlay.innerHTML = "";

    // canvas pixel space → CSS pixel space scale
    const rect = canvas.getBoundingClientRect();
    const sx = rect.width  / canvas.width;
    const sy = rect.height / canvas.height;

    // util to add a div box
    const addBox = (r, cls) => {
      if (!r || r.page !== pageNum) return;
      const d = document.createElement("div");
      d.className = cls;
      const x = Math.min(r.x0, r.x1) * sx;
      const y = Math.min(r.y0, r.y1) * sy;
      const w = Math.abs(r.x1 - r.x0) * sx;
      const h = Math.abs(r.y1 - r.y0) * sy;
      Object.assign(d.style, {
        position: "absolute",
        left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px`
      });
      overlay.appendChild(d);
    };

    // Debug layers
    if (showOCR) {
      for (const t of tokensRef.current) {
        if (t.page !== pageNum) continue;
        addBox(t, "ocr-token"); // thin outline for each token
      }
    }
    if (showDocAI && hoverRectRef.current) addBox(hoverRectRef.current, "docai-hover");

    // Final pink match
    if (locateRectRef.current) addBox(locateRectRef.current, "docai-locate");
  }

  /* -------------------------- Ref API -------------------------- */

  useImperativeHandle(ref, () => ({
    goto: (p) => setPageNum(Math.max(1, Math.min(p || 1, pdfRef.current?.numPages || 1))),

    // dashed DocAI bbox from KV hover
    showDocAIBbox: (row) => {
      if (!row || !row.bbox) { hoverRectRef.current = null; drawOverlay(); return; }
      const r = row.bbox;
      hoverRectRef.current = {
        page: row.page || pageNum,
        x0: r.x, y0: r.y, x1: r.x + r.width, y1: r.y + r.height
      };
      drawOverlay();
    },

    // provide OCR tokens to the matcher (already in canvas pixels)
    tokensForMatching: () => tokensRef.current,

    // parent sets the final pink rectangle
    setLocateRect: (page, rect) => {
      locateRectRef.current = rect ? { page, ...rect } : null;
      if (rect && page !== pageNum) setPageNum(page); else drawOverlay();
    }
  }));

  /* ---------------------------- UI ---------------------------- */

  return (
    <div ref={stageRef} className="canvas-stage">
      <div className="pagebar">
        <button className="btn" onClick={()=>setPageNum(p=>Math.max(1,p-1))}>Prev</button>
        <button className="btn" onClick={()=>setPageNum(p=>Math.min((pdfRef.current?.numPages||1),p+1))}>Next</button>
        <span style={{ marginLeft: 8 }}>Page {pageNum}{pdfRef.current ? ` / ${pdfRef.current.numPages}` : ""}</span>
        <label style={{ marginLeft: 16, fontSize:12, display:"flex", alignItems:"center", gap:6 }}>
          <input type="checkbox" checked={showOCR} onChange={e=>{ setShowOCR(e.target.checked); drawOverlay(); }} />
          OCR boxes
        </label>
        <label style={{ marginLeft: 10, fontSize:12, display:"flex", alignItems:"center", gap:6 }}>
          <input type="checkbox" checked={showDocAI} onChange={e=>{ setShowDocAI(e.target.checked); drawOverlay(); }} />
          DocAI boxes
        </label>
      </div>

      <canvas ref={canvasRef} />
      <div ref={overlayRef} className="overlay" />
    </div>
  );
});

export default PdfCanvas;