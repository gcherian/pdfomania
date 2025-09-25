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
import { matchField, locateByValue } from "../lib/match";

// ---- pdf.js worker (Vite-compatible mjs path) ----
GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url
).toString();

function splitIntoWords(s) {
  const tokens = [];
  let buf = "";
  const flush = () => { if (buf.trim()) tokens.push(buf); buf = ""; };

  for (const ch of s) {
    if (/\d/.test(ch)) {
      buf += ch;
    } else if (/[.,\-\/]/.test(ch) && /\d/.test(buf.slice(-1))) {
      buf += ch; // numeric punctuation stays within number
    } else if (/\s/.test(ch)) {
      flush();
    } else if (/[A-Za-z]/.test(ch)) {
      buf += ch;
    } else {
      flush();
    }
  }
  flush();
  return tokens;
}

const PdfCanvas = forwardRef(function PdfCanvas({ pdfData }, ref) {
  const hostRef = useRef(null);         // container
  const canvasRef = useRef(null);       // pdf.js target
  const overlayRef = useRef(null);      // highlight layer (absolute above canvas)

  const pdfDocRef = useRef(null);
  const renderTaskRef = useRef(null);
  const pageRef = useRef(null);
  const viewportRef = useRef(null);

  const [pageNum, setPageNum] = useState(1);

  // highlight state (doc-space, not CSS pixels)
  const hoverRectRef = useRef(null);    // dashed (DocAI bbox)
  const locateRectRef = useRef(null);   // pink (true position)

  // tokens (all pages) for matching
  const tokensRef = useRef([]);         // [{page,x0,y0,x1,y1,text}, ...]

  // ---------- Load PDF when data changes ----------
  useEffect(() => {
    let cancelled = false;
    (async () => {
      clearAll();
      if (!pdfData) return;

      try { await renderTaskRef.current?.cancel?.(); } catch {}
      renderTaskRef.current = null;

      try {
        const loadingTask = getDocument({ data: pdfData });
        const doc = await loadingTask.promise;
        if (cancelled) return;
        pdfDocRef.current = doc;

        // build tokens for all pages (fine for typical doc sizes)
        const allTokens = [];
        for (let p = 1; p <= doc.numPages; p++) {
          const page = await doc.getPage(p);
          const rot = (page.rotate || 0) % 360;
          const vp = page.getViewport({ scale: 1, rotation: rot });
          const textContent = await page.getTextContent({ normalizeWhitespace: true });

          // pdf.js gives mixed granularity; split to rough "word" tokens
          const items = textContent.items || [];
          for (const it of items) {
            const str = it.str || it.text || "";
            if (!str) continue;

            const [a,b,c,d,e,f] = it.transform || [1,0,0,1,0,0];
            const fontH = Math.hypot(b, d) || Math.abs(d) || Math.abs(b) || 10;
            const xBase = e;
            const yTop = vp.height - f; // convert baseline to top-ish

            const chunkWidth = it.width ?? Math.abs(a) * Math.max(1, str.length);
            const parts = splitIntoWords(str);
            const totalChars = str.length || 1;
            let xCursor = xBase;

            for (const part of parts) {
              const frac = part.length / totalChars;
              const w = Math.max(2, chunkWidth * frac);
              const x0 = xCursor;
              const y0 = Math.max(0, yTop - fontH);
              const x1 = xCursor + w;
              const y1 = yTop;
              xCursor = x1;

              allTokens.push({ page: p, x0, y0, x1, y1, text: part });
            }
          }
        }
        tokensRef.current = allTokens;

        setPageNum(1);
        await renderPage(1);
      } catch (err) {
        console.error("PDF load error:", err);
      }
    })();

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdfData]);

  // ---------- Render when page changes ----------
  useEffect(() => {
    if (!pdfDocRef.current) return;
    renderPage(pageNum).catch(console.error);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageNum]);

  async function renderPage(p) {
    if (!pdfDocRef.current) return;

    try { await renderTaskRef.current?.cancel?.(); } catch {}
    renderTaskRef.current = null;

    const page = await pdfDocRef.current.getPage(p);
    pageRef.current = page;

    // scale to sensible size
    const rot = (page.rotate || 0) % 360;
    const vp1 = page.getViewport({ scale: 1, rotation: rot });
    const maxDisplay = 1400;
    const baseScale = Math.min(1.6, Math.max(0.8, maxDisplay / Math.max(vp1.width, vp1.height)));
    const vp = page.getViewport({ scale: baseScale, rotation: rot });
    viewportRef.current = vp;

    // canvas sizing
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    canvas.width = Math.floor(vp.width);
    canvas.height = Math.floor(vp.height);
    // stacking order: canvas underlay
    canvas.style.position = "relative";
    canvas.style.zIndex = "0";
    canvas.style.display = "block";
    canvas.style.background = "#fff";

    // ensure overlay aligns and is on top
    syncOverlay();
    overlayRef.current.style.zIndex = "50"; // above canvas

    renderTaskRef.current = page.render({ canvasContext: ctx, viewport: vp });
    try {
      await renderTaskRef.current.promise;
    } finally {
      renderTaskRef.current = null;
      syncOverlay();
      drawOverlay();
    }
  }

  function clearAll() {
    const c = canvasRef.current;
    if (c) {
      const g = c.getContext("2d");
      g.clearRect(0, 0, c.width, c.height);
    }
    if (overlayRef.current) overlayRef.current.innerHTML = "";
    hoverRectRef.current = null;
    locateRectRef.current = null;
    tokensRef.current = [];
  }

  function syncOverlay() {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    const overlay = overlayRef.current;
    if (!host || !canvas || !overlay) return;

    host.style.position = "relative";
    host.style.display = "flex";
    host.style.alignItems = "center";
    host.style.justifyContent = "center";

    // size overlay to canvas pixel size; place above it
    overlay.style.position = "absolute";
    overlay.style.pointerEvents = "none";
    overlay.style.width = `${canvas.width}px`;
    overlay.style.height = `${canvas.height}px`;
  }

  // keep overlay aligned on container resize
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const ro = new ResizeObserver(() => {
      syncOverlay();
      drawOverlay();
    });
    ro.observe(host);
    return () => ro.disconnect();
  }, []);

  // ---------- overlay drawing ----------
  function drawOverlay() {
    const overlay = overlayRef.current;
    const canvas = canvasRef.current;
    const vp = viewportRef.current;
    if (!overlay || !canvas || !vp) return;

    // Clear previous boxes
    overlay.innerHTML = "";

    const place = (node, r) => {
      // r is in viewport units (same as canvas)
      const x = Math.min(r.x0, r.x1);
      const y = Math.min(r.y0, r.y1);
      const w = Math.abs(r.x1 - r.x0);
      const h = Math.abs(r.y1 - r.y0);
      node.style.position = "absolute";
      node.style.left = `${x}px`;
      node.style.top = `${y}px`;
      node.style.width = `${w}px`;
      node.style.height = `${h}px`;
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

  // ---------- utils ----------
  function bboxToRect(b, page) {
    if (!b) return null;
    const x0 = Number(b.x ?? b.left ?? b.x0);
    const y0 = Number(b.y ?? b.top ?? b.y0);
    const x1 = Number(
      b.x1 ?? (b.x != null && b.width != null ? b.x + b.width : (b.right != null ? b.right : NaN))
    );
    const y1 = Number(
      b.y1 ?? (b.y != null && b.height != null ? b.y + b.height : (b.bottom != null ? b.bottom : NaN))
    );
    if (![x0, y0, x1, y1].every(Number.isFinite)) return null;
    return { page: page || pageNum, x0, y0, x1, y1 };
  }

  // ---------- ref API ----------
  useImperativeHandle(ref, () => ({
    showDocAIBbox: (row) => {
      hoverRectRef.current = null;
      if (!row || !row.bbox) { drawOverlay(); return; }

      // Reject absurd sentinel coordinates
      const big = 1e7;
      if (Math.abs(row.bbox.x) > big || Math.abs(row.bbox.y) > big) {
        drawOverlay();
        return;
      }

      const rect = bboxToRect(row.bbox, row.page);
      if (!rect) { drawOverlay(); return; }
      hoverRectRef.current = rect;

      if (rect.page !== pageNum) setPageNum(rect.page);
      else drawOverlay();
    },

    matchAndHighlight: (key, value, opts) => {
      const toks = tokensRef.current || [];
      let res = null;
      if (key && key.trim()) {
        res = matchField(key, value || "", toks, opts);
        if (!res || res.score < 0.58) {
          res = locateByValue(value || "", toks, opts);
        }
      } else {
        res = locateByValue(value || "", toks, opts);
      }

      locateRectRef.current = null;
      if (res) {
        locateRectRef.current = {
          page: res.page,
          x0: res.rect.x0, y0: res.rect.y0, x1: res.rect.x1, y1: res.rect.y1
        };
        if (res.page !== pageNum) setPageNum(res.page);
        else drawOverlay();
      } else {
        drawOverlay();
      }
    },

    locateValue: (value, opts) => {
      const toks = tokensRef.current || [];
      const res = locateByValue(value || "", toks, opts);
      locateRectRef.current = null;
      if (res) {
        locateRectRef.current = {
          page: res.page,
          x0: res.rect.x0, y0: res.rect.y0, x1: res.rect.x1, y1: res.rect.y1
        };
        if (res.page !== pageNum) setPageNum(res.page);
        else drawOverlay();
      } else {
        drawOverlay();
      }
    },

    goto: (p) => {
      const N = pdfDocRef.current?.numPages || 1;
      const pg = Math.max(1, Math.min(p || 1, N));
      setPageNum(pg);
    },

    clearHighlights: () => {
      hoverRectRef.current = null;
      locateRectRef.current = null;
      drawOverlay();
    },
  }));

  return (
    <div
      ref={hostRef}
      className="canvas-stage"
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#fff",
      }}
    >
      <canvas ref={canvasRef} />
      {/* overlay is after canvas in DOM with higher z-index */}
      <div ref={overlayRef} className="overlay" />
      <div
        style={{
          position: "absolute",
          left: 12,
          top: 12,
          zIndex: 60,
          display: "flex",
          gap: 8,
        }}
      >
        <button className="btn" onClick={() => setPageNum((p) => Math.max(1, p - 1))}>
          Prev
        </button>
        <button className="btn" onClick={() => setPageNum((p) => p + 1)}>
          Next
        </button>
        <span style={{ color: "#222", background:"#fff", padding:"2px 6px", borderRadius:6 }}>
          Page {pageNum}{pdfDocRef.current ? ` / ${pdfDocRef.current.numPages}` : ""}
        </span>
      </div>
    </div>
  );
});

export default PdfCanvas;