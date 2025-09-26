import React, {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import {
  GlobalWorkerOptions,
  getDocument,
} from "pdfjs-dist";

// --- pdf.js worker (vite/webpack friendly)
GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url
).toString();

const PdfCanvas = forwardRef(function PdfCanvas(
  { pdfData, ocrEndpoint }, // ocrEndpoint optional; safe to be undefined
  ref
) {
  // DOM
  const canvasRef = useRef(null);
  const overlayRef = useRef(null);

  // pdf.js
  const pdfRef = useRef(null);
  const pageRef = useRef(null);
  const viewportRef = useRef(null);
  const renderTaskRef = useRef(null);

  // state
  const [pageNum, setPageNum] = useState(1);

  // highlights
  const hoverRectRef = useRef(null);   // dashed DocAI bbox
  const locateRectRef = useRef(null);  // pink matched bbox

  // OCR tokens (optional)
  const tokensRef = useRef([]);        // [{page,text,x0,y0,x1,y1}]

  /* ---------------- lifecycle ---------------- */

  // load a new PDF
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!pdfData) { clearAll(); return; }
      clearAll();

      try {
        const doc = await getDocument({ data: pdfData }).promise;
        if (cancelled) return;
        pdfRef.current = doc;
        setPageNum(1);
        await renderPage(1);
        await ocrCurrentPage(); // safe if ocrEndpoint is undefined
      } catch (e) {
        console.error("[pdf] load error:", e);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdfData]);

  // change page
  useEffect(() => {
    (async () => {
      if (!pdfRef.current) return;
      await renderPage(pageNum);
      await ocrCurrentPage();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageNum]);

  /* ---------------- helpers ---------------- */

  function clearAll() {
    // pixels
    const c = canvasRef.current;
    if (c) {
      const g = c.getContext("2d");
      if (g) g.clearRect(0, 0, c.width, c.height);
    }
    // overlay boxes
    const ov = overlayRef.current;
    if (ov) ov.innerHTML = "";

    // in-memory state
    hoverRectRef.current = null;
    locateRectRef.current = null;
    tokensRef.current = [];
  }

  async function renderPage(p) {
    try { await renderTaskRef.current?.cancel?.(); } catch {}
    renderTaskRef.current = null;

    const doc = pdfRef.current;
    if (!doc) return;

    const page = await doc.getPage(p);
    pageRef.current = page;

    const rot = (page.rotate || 0) % 360;
    // compute a predictable display scale (keeps good quality)
    const vp1 = page.getViewport({ scale: 1, rotation: rot });
    const maxDim = 1400;
    const scale = Math.min(1.75, Math.max(0.7, maxDim / Math.max(vp1.width, vp1.height)));
    const vp = page.getViewport({ scale, rotation: rot });
    viewportRef.current = vp;

    // size canvas
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    canvas.width = Math.floor(vp.width);
    canvas.height = Math.floor(vp.height);
    canvas.style.width = `${canvas.width}px`;
    canvas.style.height = `${canvas.height}px`;

    // size overlay to exact canvas pixels
    const ov = overlayRef.current;
    ov.style.position = "absolute";
    ov.style.left = "0";
    ov.style.top = "0";
    ov.style.width = `${canvas.width}px`;
    ov.style.height = `${canvas.height}px`;

    // render
    renderTaskRef.current = page.render({ canvasContext: ctx, viewport: vp });
    try {
      await renderTaskRef.current.promise;
    } finally {
      renderTaskRef.current = null;
      drawOverlay(); // redraw boxes after page render
    }
  }

  function drawOverlay() {
    const ov = overlayRef.current;
    if (!ov) return;
    ov.innerHTML = "";

    const place = (r, cls) => {
      if (!r || r.page !== pageNum) return;
      const d = document.createElement("div");
      d.className = cls;
      const x = Math.min(r.x0, r.x1);
      const y = Math.min(r.y0, r.y1);
      const w = Math.abs(r.x1 - r.x0);
      const h = Math.abs(r.y1 - r.y0);
      Object.assign(d.style, {
        position: "absolute",
        left: `${x}px`,
        top: `${y}px`,
        width: `${w}px`,
        height: `${h}px`,
      });
      ov.appendChild(d);
    };

    if (hoverRectRef.current) place(hoverRectRef.current, "docai-hover");
    if (locateRectRef.current) place(locateRectRef.current, "docai-locate");
  }

  // optional OCR fetch (safe no-op if no endpoint)
  async function ocrCurrentPage() {
    if (!ocrEndpoint) return;                // no OCR configured
    const canvas = canvasRef.current;
    if (!canvas) return;

    const blob = await new Promise((res) => canvas.toBlob(res, "image/png"));
    const fd = new FormData();
    fd.append("page", blob, `p${pageNum}.png`);
    fd.append("pageNumber", String(pageNum));

    try {
      const resp = await fetch(ocrEndpoint, { method: "POST", body: fd });
      if (!resp.ok) { console.warn("[ocr] bad response", resp.status); return; }
      const { tokens = [], width, height } = await resp.json();

      // our canvas pixels are the coordinate system; if OCR returns image pixels
      // equal to the canvas size (we sent the canvas), we can use them 1:1
      const norm = tokens.map(t => ({
        page: t.page ?? pageNum,
        text: t.text ?? "",
        x0: t.x0, y0: t.y0, x1: t.x1, y1: t.y1,
      }));

      // replace tokens for this page
      tokensRef.current = tokensRef.current.filter(t => t.page !== pageNum).concat(norm);
    } catch (e) {
      console.warn("[ocr] fetch failed:", e);
    }
  }

  /* ---------------- expose ref API ---------------- */

  useImperativeHandle(ref, () => ({
    goto: (p) => {
      const max = pdfRef.current?.numPages || 1;
      setPageNum(Math.max(1, Math.min(p || 1, max)));
    },

    // dashed DocAI bbox (from KV list hover)
    showDocAIBbox: (row) => {
      const bb = row?.bbox;
      if (bb) {
        hoverRectRef.current = {
          page: row.page || pageNum,
          x0: bb.x, y0: bb.y,
          x1: bb.x + bb.width,
          y1: bb.y + bb.height,
        };
      } else {
        hoverRectRef.current = null;
      }
      drawOverlay();
    },

    // expose OCR tokens for matching
    tokensForMatching: () => tokensRef.current || [],

    // final pink rect (from matching logic in App.jsx)
    setLocateRect: (page, rect) => {
      locateRectRef.current = rect ? { page, ...rect } : null;
      if (rect && page !== pageNum) setPageNum(page);
      else drawOverlay();
    },

    clearHighlights: () => {
      hoverRectRef.current = null;
      locateRectRef.current = null;
      drawOverlay();
    },
  }));

  /* ---------------- UI ---------------- */

  return (
    <div className="canvas-stage">
      <div className="pagebar">
        <button className="btn" onClick={() => setPageNum(p => Math.max(1, p - 1))}>Prev</button>
        <button className="btn" onClick={() => setPageNum(p => Math.min((pdfRef.current?.numPages || 1), p + 1))}>Next</button>
        <span style={{ marginLeft: 8 }}>
          Page {pageNum}{pdfRef.current ? ` / ${pdfRef.current.numPages}` : ""}
        </span>
      </div>

      <canvas ref={canvasRef} />
      <div ref={overlayRef} className="overlay" />
    </div>
  );
});

export default PdfCanvas;