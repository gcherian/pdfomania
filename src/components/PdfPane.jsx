import React, { useEffect, useRef, useImperativeHandle, forwardRef, useState } from "react";
import { GlobalWorkerOptions, getDocument } from "pdfjs-dist";
import { locateValue } from "../lib/match.js";

GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();

/**
 * Props:
 *  - pdfData: ArrayBuffer | null
 *
 * Exposed methods (via ref):
 *  - showDocAIBbox(row|null)
 *  - locateValue(text)
 */

const PdfCanvas = forwardRef(function PdfCanvas({ pdfData }, ref) {
  const canvasRef = useRef(null);
  const overlayRef = useRef(null);
  const pdfRef = useRef(null);
  const renderTaskRef = useRef(null);
  const pageRef = useRef(null);
  const viewportRef = useRef(null);

  const [pageNum, setPageNum] = useState(1);
  const tokensRef = useRef([]); // [{page,x0,y0,x1,y1,text}]
  const hoverRectRef = useRef(null);
  const locateRectRef = useRef(null);

  // load doc when pdfData changes
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!pdfData) {
        pdfRef.current = null;
        clearCanvas();
        tokensRef.current = [];
        return;
      }
      // cancel previous render
      if (renderTaskRef.current && renderTaskRef.current.cancel) {
        try { await renderTaskRef.current.cancel(); } catch {}
        renderTaskRef.current = null;
      }
      try {
        const loadingTask = getDocument({ data: pdfData });
        pdfRef.current = await loadingTask.promise;
        if (cancelled) return;
        setPageNum(1);
        // pre-extract tokens for all pages (small docs only — fine for demo)
        const allTokens = [];
        for (let p = 1; p <= pdfRef.current.numPages; p++) {
          const pg = await pdfRef.current.getPage(p);
          const vp = pg.getViewport({ scale: 1 });
          const text = await pg.getTextContent({ normalizeWhitespace: true });
          const toks = itemsToTokens(text.items, vp, p);
          allTokens.push(...toks);
        }
        tokensRef.current = allTokens;
        // render page 1
        await renderPage(1);
      } catch (err) {
        console.error("PDF load/render error:", err);
      }
    })();
    return () => { cancelled = true; };
  }, [pdfData]);

  useEffect(() => {
    if (!pdfRef.current) return;
    renderPage(pageNum).catch(console.error);
  }, [pageNum]);

  async function renderPage(p) {
    if (!pdfRef.current) return;
    // cancel previous
    if (renderTaskRef.current && renderTaskRef.current.cancel) {
      try { await renderTaskRef.current.cancel(); } catch {}
      renderTaskRef.current = null;
    }

    const page = await pdfRef.current.getPage(p);
    pageRef.current = page;
    const rot = (page.rotate || 0) % 360;
    const vp1 = page.getViewport({ scale: 1, rotation: rot });
    const maxDisplay = 1400;
    const baseScale = Math.min(1, maxDisplay / Math.max(vp1.width, vp1.height));
    const vp = page.getViewport({ scale: baseScale, rotation: rot });

    viewportRef.current = vp;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    canvas.width = Math.floor(vp.width);
    canvas.height = Math.floor(vp.height);
    canvas.style.width = `${canvas.width}px`;
    canvas.style.height = `${canvas.height}px`;

    // align overlay to canvas
    syncOverlay();

    renderTaskRef.current = page.render({ canvasContext: ctx, viewport: vp });
    try {
      await renderTaskRef.current.promise;
    } finally {
      // after render completes, re-sync overlay
      renderTaskRef.current = null;
      syncOverlay();
      drawOverlay();
    }
  }

  function clearCanvas() {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    ctx.clearRect(0, 0, c.width, c.height);
    if (overlayRef.current) overlayRef.current.innerHTML = "";
  }

  function syncOverlay() {
    const canvas = canvasRef.current;
    const overlay = overlayRef.current;
    if (!canvas || !overlay) return;
    const cR = canvas.getBoundingClientRect();
    overlay.style.position = "absolute";
    overlay.style.left = `${Math.round(cR.left - overlay.parentElement.getBoundingClientRect().left)}px`;
    overlay.style.top = `${Math.round(cR.top - overlay.parentElement.getBoundingClientRect().top)}px`;
    overlay.style.width = `${Math.floor(cR.width)}px`;
    overlay.style.height = `${Math.floor(cR.height)}px`;
  }

  function itemsToTokens(items, vp, page) {
    const toks = [];
    // convert item transform to canvas coords
    for (const it of items) {
      // it.transform = [a, b, c, d, e, f] — e,f is translate
      const [a, b, c, d, e, f] = it.transform;
      // in viewport coordinates: use viewport.transform to map
      // simpler approach: use vp.convertToViewportPoint for position? Not all pdfjs versions expose
      // We approximate: x = e, y = f, then convert to canvas coordinates via vp
      const x = e;
      const yBaseline = f;
      const fontH = Math.abs(d || b || 10);
      // compute canvas y: pdf text baseline -> vp.height - baseline
      const yTop = vp.height - yBaseline;
      const x0 = x;
      const y0 = Math.max(0, yTop - fontH);
      const x1 = x + (it.width || 0);
      const y1 = yTop;
      toks.push({ page, x0, y0, x1, y1, text: it.str || "" });
    }
    toks.sort((A, B) => (A.y0 === B.y0 ? A.x0 - B.x0 : A.y0 - B.y0));
    return toks;
  }

  function drawOverlay() {
    const overlay = overlayRef.current;
    const canvas = canvasRef.current;
    if (!overlay || !canvas) return;
    overlay.innerHTML = "";

    // draw docai hover
    const h = hoverRectRef.current;
    if (h && h.page === pageNum) {
      const div = document.createElement("div");
      div.className = "docai-hover";
      placeCss(div, h.x0, h.y0, h.x1, h.y1);
      overlay.appendChild(div);
    }
    // draw locate
    const L = locateRectRef.current;
    if (L && L.page === pageNum) {
      const div = document.createElement("div");
      div.className = "locate";
      placeCss(div, L.x0, L.y0, L.x1, L.y1);
      overlay.appendChild(div);
    }
  }

  function placeCss(node, x0, y0, x1, y1) {
    const overlay = overlayRef.current;
    const canvas = canvasRef.current;
    if (!overlay || !canvas) return;
    const R = canvas.getBoundingClientRect();
    const sx = R.width / canvas.width;
    const sy = R.height / canvas.height;
    node.style.position = "absolute";
    node.style.left = `${Math.min(x0, x1) * sx}px`;
    node.style.top = `${Math.min(y0, y1) * sy}px`;
    node.style.width = `${Math.abs(x1 - x0) * sx}px`;
    node.style.height = `${Math.abs(y1 - y0) * sy}px`;
  }

  // exposed API
  useImperativeHandle(ref, () => ({
    showDocAIBbox(row) {
      hoverRectRef.current = null;
      if (!row || !row.bbox) {
        drawOverlay();
        return;
      }
      const bb = row.bbox;
      // convert to two-corner rect in PDF canvas coords.
      const x0 = bb.x, y0 = bb.y;
      const x1 = bb.x + bb.width, y1 = bb.y + bb.height;
      hoverRectRef.current = { page: row.page || 1, x0, y0, x1, y1 };
      if (row.page && row.page !== pageNum) setPageNum(row.page);
      else drawOverlay();
    },
    locateValue(raw) {
      // use token matcher
      const all = tokensRef.current || [];
      const res = locateValue(raw, all);
      locateRectRef.current = null;
      if (res) {
        const r = res.rect;
        locateRectRef.current = { page: res.page, x0: r.x0, y0: r.y0, x1: r.x1, y1: r.y1 };
        if (res.page && res.page !== pageNum) setPageNum(res.page);
        else drawOverlay();
      } else {
        // no match — clear
        drawOverlay();
      }
    }
  }));

  // make sure overlay tracks canvas on resize
  useEffect(() => {
    const ro = new ResizeObserver(() => {
      syncOverlay();
      drawOverlay();
    });
    if (canvasRef.current) ro.observe(canvasRef.current);
    return () => ro.disconnect();
  }, []);

  // pagebar controls are simple — show current page
  return (
    <div style={{ width: "100%", height: "100%", position: "relative" }} className="canvas-wrap">
      <div className="canvas-stage" style={{ width: "100%", height: "100%" }}>
        <div className="pagebar">
          <button className="btn" onClick={() => setPageNum(p => Math.max(1, p - 1))}>Prev</button>
          <button className="btn" onClick={() => setPageNum(p => p + 1)}>Next</button>
          <div style={{ color: "#cfe" , marginLeft: 8, alignSelf: "center" }}>Page {pageNum}{pdfRef.current ? ` / ${pdfRef.current.numPages}` : ""}</div>
        </div>

        <canvas ref={canvasRef} />
        <div ref={overlayRef} className="overlay" />
      </div>
    </div>
  );
});

export default PdfCanvas;