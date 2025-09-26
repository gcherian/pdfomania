import React, {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { GlobalWorkerOptions, getDocument } from "pdfjs-dist";

// Use the mjs worker (vite-friendly)
GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url
).toString();

/**
 * Props:
 *  - pdfData: ArrayBuffer | null
 *  - ocrEndpoint: string (e.g. "http://localhost:3001/ocr")
 */
const PdfCanvas = forwardRef(function PdfCanvas({ pdfData, ocrEndpoint }, ref) {
  // --- Refs / state ---------------------------------------------------------
  const canvasRef = useRef(null);
  const overlayRef = useRef(null);

  const pdfRef = useRef(null);
  const pageRef = useRef(null);
  const viewportRef = useRef(null);
  const renderTaskRef = useRef(null);

  const [pageNum, setPageNum] = useState(1);

  // OCR tokens across pages: [{page,text,x0,y0,x1,y1}] in CANVAS pixels
  const tokensRef = useRef([]);

  // pending highlight rects (canvas coordinates)
  const hoverRectRef = useRef(null);  // dashed DocAI bbox (optional)
  const locateRectRef = useRef(null); // solid pink matched rect

  // --- Effects ---------------------------------------------------------------

  // Load PDF when data changes
  useEffect(() => {
    if (!pdfData) return;
    (async () => {
      clearAll();
      try {
        const doc = await getDocument({ data: pdfData }).promise;
        pdfRef.current = doc;
        setPageNum(1);
        await renderPage(1);
        await ocrCurrentPage(); // pre-OCR first page
      } catch (e) {
        console.error("PDF load error:", e);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdfData]);

  // Re-render & OCR when page changes
  useEffect(() => {
    if (!pdfRef.current) return;
    (async () => {
      await renderPage(pageNum);
      await ocrCurrentPage();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageNum]);

  // --- Rendering -------------------------------------------------------------

  async function renderPage(p) {
    try {
      await renderTaskRef.current?.cancel?.();
    } catch {}
    renderTaskRef.current = null;

    const page = await pdfRef.current.getPage(p);
    pageRef.current = page;

    const rot = (page.rotate || 0) % 360;
    const vp1 = page.getViewport({ scale: 1, rotation: rot });
    const maxDisplay = 1400;
    const baseScale = Math.min(
      1.6,
      Math.max(0.8, maxDisplay / Math.max(vp1.width, vp1.height))
    );
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
    if (c) c.getContext("2d").clearRect(0, 0, c.width, c.height);
    if (overlayRef.current) overlayRef.current.innerHTML = "";
    tokensRef.current = [];
    hoverRectRef.current = null;
    locateRectRef.current = null;
  }

  // --- OCR fetch + normalization (robust; includes fallback) -----------------

  async function ocrCurrentPage() {
    if (!ocrEndpoint) return; // allow running without OCR

    const canvas = canvasRef.current;
    const page = pageNum;

    // Send the **current canvas** so the server and client share the same pixel space
    const blob = await new Promise((res) => canvas.toBlob(res, "image/png"));
    const fd = new FormData();
    fd.append("page", blob, `p${page}.png`);
    fd.append("pageNumber", String(page));

    console.log("[ocr] calling", ocrEndpoint, "with POST");
    let data = null;
    try {
      const resp = await fetch(ocrEndpoint, { method: "POST", body: fd });
      if (!resp.ok) {
        console.warn("[ocr] non-OK:", resp.status);
        throw new Error(`HTTP ${resp.status}`);
      }
      data = await resp.json();
    } catch (e) {
      console.warn("[ocr] fetch failed:", e);
      data = null;
    }

    // Accept multiple shapes: {tokens}, {words}, {items}, etc.
    const rawTokens = (data?.tokens || data?.words || data?.items || []).slice();
    const srvW = data?.width ?? canvas.width;
    const srvH = data?.height ?? canvas.height;
    const scaleX = canvas.width / Math.max(1, srvW);
    const scaleY = canvas.height / Math.max(1, srvH);

    const fromServer = rawTokens
      .map((t) => {
        const r = normalizeTokenRect(t);
        return {
          page: Number(t.page ?? page),
          text: String(t.text ?? t.str ?? t.word ?? ""),
          x0: r.x0 * scaleX,
          y0: r.y0 * scaleY,
          x1: r.x1 * scaleX,
          y1: r.y1 * scaleY,
        };
      })
      .filter(okRect);

    let finalTokens = fromServer;

    // If the server returned nothing usable, fall back to pdf.js text tokens
    if (finalTokens.length === 0 && pageRef.current) {
      console.warn("[ocr] 0 tokens from server; using pdf.js fallback");
      const fallback = await tokensFromPdfJsPage(pageRef.current, page);
      console.log("[pdf] fallback tokens p#", page, "=", fallback.length);
      finalTokens = fallback;
    }

    // Replace this page’s tokens
    tokensRef.current = tokensRef.current
      .filter((t) => t.page !== page)
      .concat(finalTokens);

    drawOverlay();
  }

  // --- Overlay ---------------------------------------------------------------

  function drawOverlay() {
    const overlay = overlayRef.current;
    if (!overlay) return;
    overlay.innerHTML = "";

    const put = (r, cls) => {
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
      overlay.appendChild(d);
    };

    if (hoverRectRef.current) put(hoverRectRef.current, "docai-hover");
    if (locateRectRef.current) put(locateRectRef.current, "docai-locate");
  }

  // --- Imperative API for parent --------------------------------------------

  useImperativeHandle(ref, () => ({
    goto: (p) =>
      setPageNum(Math.max(1, Math.min(p || 1, pdfRef.current?.numPages || 1))),

    // Show DocAI bbox as dashed (optional)
    showDocAIBbox: (row) => {
      const r = row?.bbox;
      hoverRectRef.current = r
        ? {
            page: row.page || pageNum,
            x0: r.x,
            y0: r.y,
            x1: r.x + r.width,
            y1: r.y + r.height,
          }
        : null;
      if (r && (row.page || pageNum) !== pageNum) setPageNum(row.page);
      else drawOverlay();
    },

    // Legacy: parent sets final located rect (pink)
    setLocateRect: (page, rect) => {
      locateRectRef.current = rect ? { page, ...rect } : null;
      if (rect && page !== pageNum) setPageNum(page);
      else drawOverlay();
    },

    // Expose tokens for match.js
    tokensForMatching: () => tokensRef.current,
  }));

  // --- Render ----------------------------------------------------------------
  return (
    <div className="canvas-stage">
      <div className="pagebar">
        <button className="btn" onClick={() => setPageNum((p) => Math.max(1, p - 1))}>
          Prev
        </button>
        <button
          className="btn"
          onClick={() =>
            setPageNum((p) => Math.min((pdfRef.current?.numPages || 1), p + 1))
          }
        >
          Next
        </button>
        <span style={{ marginLeft: 8 }}>
          Page {pageNum}
          {pdfRef.current ? ` / ${pdfRef.current.numPages}` : ""}
        </span>
      </div>

      <canvas ref={canvasRef} />
      <div ref={overlayRef} className="overlay" />
    </div>
  );
});

export default PdfCanvas;

/* ===================== helpers (plain JS) ===================== */

function normalizeTokenRect(t) {
  const bx = t.bbox || t.box || null;

  const x0 = pickNum(t.x0, t.left, t.x, bx?.x, bx?.left);
  const y0 = pickNum(t.y0, t.top,  t.y, bx?.y, bx?.top);
  let   x1 = pickNum(t.x1, t.right);
  let   y1 = pickNum(t.y1, t.bottom);

  const w = pickNum(t.w, t.width, bx?.w, bx?.width);
  const h = pickNum(t.h, t.height, bx?.h, bx?.height);

  const _x0 = Number.isFinite(x0) ? x0 : 0;
  const _y0 = Number.isFinite(y0) ? y0 : 0;
  const _x1 = Number.isFinite(x1) ? x1 : (Number.isFinite(w) ? _x0 + w : _x0 + 1);
  const _y1 = Number.isFinite(y1) ? y1 : (Number.isFinite(h) ? _y0 + h : _y0 + 1);

  return { x0: _x0, y0: _y0, x1: _x1, y1: _y1 };
}

function pickNum(...vals) {
  for (const v of vals) {
    const n = typeof v === "string" ? Number(v) : v;
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function okRect(t) {
  const w = Math.abs(t.x1 - t.x0);
  const h = Math.abs(t.y1 - t.y0);
  return w > 0.5 && h > 0.5;
}

async function tokensFromPdfJsPage(page, pageNum) {
  const vp = page.getViewport({ scale: 1, rotation: page.rotate || 0 });
  const tc = await page.getTextContent({ normalizeWhitespace: true });

  const out = [];
  for (const it of tc.items || []) {
    const str = it.str || it.text || "";
    const [a, b, , d, e, f] = it.transform || [1, 0, 0, 1, 0, 0];
    const fontH = Math.hypot(b, d) || Math.abs(d) || Math.abs(b) || 10;
    const chunkW = it.width ?? Math.abs(a) * Math.max(1, str.length);

    const parts = String(str).split(/\s+/).filter(Boolean);
    let x = e, yTop = vp.height - f;
    const totalChars = Math.max(1, str.length);

    for (const part of parts) {
      const frac = part.length / totalChars;
      const w = Math.max(2, chunkW * frac);
      const x0 = x, y0 = Math.max(0, yTop - fontH), x1 = x + w, y1 = yTop;
      x = x1;
      out.push({ page: pageNum, text: part, x0, y0, x1, y1 });
    }
  }
  out.sort((A, B) => (A.y0 === B.y0 ? A.x0 - B.x0 : A.y0 - B.y0));
  return out;
}