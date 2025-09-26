import React, {
  forwardRef, useEffect, useImperativeHandle, useRef, useState
} from "react";
import { GlobalWorkerOptions, getDocument } from "pdfjs-dist";

/* --- Vite-friendly worker path --- */
GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url
).toString();

/**
 * Props:
 *  - pdfData: ArrayBuffer | null
 *  - ocrEndpoint: string (e.g. "http://localhost:3001/ocr")  // POST only
 */
const PdfCanvas = forwardRef(function PdfCanvas({ pdfData, ocrEndpoint }, ref) {
  /* ----- DOM refs ----- */
  const canvasRef = useRef(null);
  const overlayRef = useRef(null);

  /* ----- pdf.js refs ----- */
  const pdfRef = useRef(null);
  const pageRef = useRef(null);
  const viewportRef = useRef(null);
  const renderTaskRef = useRef(null);

  /* ----- state ----- */
  const [pageNum, setPageNum] = useState(1);

  /* ----- data shared with App for matching ----- */
  // tokens: [{page, text, x0,y0,x1,y1}] in *canvas pixels* (viewport coords)
  const tokensRef = useRef([]);

  // rectangles to draw
  const hoverRectRef = useRef(null);   // dashed DocAI bbox (optional)
  const locateRectRef = useRef(null);  // pink “true” match

  const log = (...a) => console.log("[pdf]", ...a);

  /* =================== Effects =================== */

  // Load PDF when data changes
  useEffect(() => {
    (async () => {
      clearAll();
      if (!pdfData) return;
      try {
        const doc = await getDocument({ data: pdfData }).promise;
        pdfRef.current = doc;
        setPageNum(1); // triggers render + OCR
        log("loaded doc:", doc.numPages, "pages");
      } catch (err) {
        console.error("[pdf] load error:", err);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdfData]);

  // Render & OCR when page changes
  useEffect(() => {
    if (!pdfRef.current) return;
    (async () => {
      try {
        await renderPage(pageNum);
        await ocrCurrentPage(); // auto-ocr right after a successful render
      } catch (err) {
        console.error("[pdf] render/ocr error:", err);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageNum]);

  /* =================== Core: render page =================== */
  async function renderPage(p) {
    const doc = pdfRef.current;
    if (!doc) return;

    // cancel any in-flight render
    try { await renderTaskRef.current?.cancel?.(); } catch {}
    renderTaskRef.current = null;

    const page = await doc.getPage(p);
    pageRef.current = page;

    const rot = (page.rotate || 0) % 360;
    const vp1 = page.getViewport({ scale: 1, rotation: rot });
    const baseScale = Math.min(1.6, Math.max(0.8, 1400 / Math.max(vp1.width, vp1.height)));
    const vp = page.getViewport({ scale: baseScale, rotation: rot });
    viewportRef.current = vp;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    canvas.width = Math.floor(vp.width);
    canvas.height = Math.floor(vp.height);
    canvas.style.width = `${canvas.width}px`;
    canvas.style.height = `${canvas.height}px`;

    // keep overlay aligned
    const overlay = overlayRef.current;
    overlay.style.width = `${canvas.width}px`;
    overlay.style.height = `${canvas.height}px`;

    renderTaskRef.current = page.render({ canvasContext: ctx, viewport: vp });
    log("rendering page", p, "→", canvas.width, "x", canvas.height);
    await renderTaskRef.current.promise;
    renderTaskRef.current = null;

    drawOverlay();
  }

  /* =================== OCR =================== */
  async function ocrCurrentPage() {
    const endpoint = (ocrEndpoint || "").trim();
    if (!endpoint) {
      log("ocr: endpoint missing → skip");
      return;
    }
    const canvas = canvasRef.current;
    if (!canvas) return;
    const page = pageNum;

    // Send the **rendered canvas** as PNG so coordinates align exactly
    const blob = await new Promise((r) => canvas.toBlob(r, "image/png"));
    const fd = new FormData();
    fd.append("page", blob, `p${page}.png`);
    fd.append("pageNumber", String(page));

    log("ocr: POST", endpoint, "page", page);
    const resp = await fetch(endpoint, { method: "POST", body: fd });
    if (!resp.ok) {
      console.warn("ocr: server responded", resp.status);
      return;
    }
    const { tokens = [], width, height } = await resp.json();

    // OCR coords = image pixels = our canvas pixels (we rendered that image),
    // so we can keep them as-is.
    const norm = tokens.map((t) => ({
      page: t.page || page,
      text: t.text || "",
      x0: t.x0, y0: t.y0, x1: t.x1, y1: t.y1,
    }));

    // Replace tokens for this page
    tokensRef.current = tokensRef.current.filter((t) => t.page !== page).concat(norm);
    log("ocr: received", norm.length, "tokens (page", page + ")");
  }

  /* =================== Overlay =================== */
  function drawOverlay() {
    const overlay = overlayRef.current;
    const canvas = canvasRef.current;
    if (!overlay || !canvas) return;

    overlay.innerHTML = "";
    const place = (node, r) => {
      const x = Math.min(r.x0, r.x1), y = Math.min(r.y0, r.y1);
      const w = Math.abs(r.x1 - r.x0), h = Math.abs(r.y1 - r.y0);
      Object.assign(node.style, {
        position: "absolute", left: `${x}px`, top: `${y}px`,
        width: `${w}px`, height: `${h}px`,
      });
    };
    const add = (r, cls) => {
      if (!r || r.page !== pageNum) return;
      const d = document.createElement("div");
      d.className = cls;
      place(d, r);
      overlay.appendChild(d);
    };

    if (hoverRectRef.current) add(hoverRectRef.current, "docai-hover");
    if (locateRectRef.current) add(locateRectRef.current, "docai-locate");
  }

  /* keep overlay aligned on canvas resize (zoom, layout, etc.) */
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const ro = new ResizeObserver(() => drawOverlay());
    ro.observe(c);
    return () => ro.disconnect();
  }, []);

  /* =================== Ref API for App.jsx =================== */
  useImperativeHandle(ref, () => ({
    goto: (p) => setPageNum(Math.max(1, Math.min(p || 1, pdfRef.current?.numPages || 1))),
    // Optional DocAI dashed bbox
    showDocAIBbox: (row) => {
      const bb = row?.bbox || null;
      hoverRectRef.current = bb
        ? { page: row.page || pageNum, x0: bb.x, y0: bb.y, x1: bb.x + bb.width, y1: bb.y + bb.height }
        : null;
      drawOverlay();
    },
    // Tokens to drive matching in App.jsx
    tokensForMatching: () => tokensRef.current,
    // App.jsx sets the final pink rectangle
    setLocateRect: (page, rect) => {
      locateRectRef.current = rect ? { page, ...rect } : null;
      if (rect && page !== pageNum) setPageNum(page); else drawOverlay();
    },
    // (Optional) force OCR explicitly if you want a button
    forceOCR: () => ocrCurrentPage(),
  }));

  /* =================== UI =================== */
  return (
    <div className="canvas-stage">
      <div className="pagebar">
        <button className="btn" onClick={() => setPageNum((p) => Math.max(1, p - 1))}>Prev</button>
        <button className="btn" onClick={() => setPageNum((p) => Math.min((pdfRef.current?.numPages || 1), p + 1))}>Next</button>
        <span>Page {pageNum}{pdfRef.current ? ` / ${pdfRef.current.numPages}` : ""}</span>
      </div>

      <canvas ref={canvasRef} />
      <div ref={overlayRef} className="overlay" style={{ position: "absolute", inset: 0, zIndex: 2, pointerEvents: "none" }} />
    </div>
  );
});

export default PdfCanvas;