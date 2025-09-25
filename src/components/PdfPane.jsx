import React, { useEffect, useImperativeHandle, useRef, useState, forwardRef } from "react";

// ✅ Correct pdf.js imports (fixes "pdfjs is not defined")
import * as pdfjsLib from "pdfjs-dist";
import { GlobalWorkerOptions } from "pdfjs-dist";
GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url
).toString();

const wrapperCss = {
  position: "relative",
  background: "#0b1020",
  overflow: "auto",
  height: "100vh",
};
const canvasCss = { display: "block", margin: "24px auto", background: "#fff", boxShadow: "0 1px 2px rgba(0,0,0,.25)" };
const overlayCss = { position: "absolute", left: 0, top: 0, pointerEvents: "none" };

function PdfCanvasImpl({ pdfData }, ref) {
  const pdfDoc = useRef(null);
  const page = useRef(null);
  const viewportRef = useRef(null);
  const renderTask = useRef(null);

  const stageRef = useRef(null);
  const canvasRef = useRef(null);
  const overlayRef = useRef(null);

  const [pageNum, setPageNum] = useState(1);

  // ---- LOAD & RENDER ----
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!pdfData) return;

      // cleanup prior
      try { renderTask.current?.cancel(); } catch {}
      try { await pdfDoc.current?.destroy(); } catch {}

      try {
        pdfDoc.current = await pdfjsLib.getDocument({ data: pdfData }).promise;
        setPageNum(1);
        if (!cancelled) await render(1);
      } catch (err) {
        console.error("PDF load/render error:", err);
      }
    })();
    return () => { cancelled = true; };
  }, [pdfData]);

  async function render(num) {
    if (!pdfDoc.current) return;

    // fetch page
    page.current = await pdfDoc.current.getPage(num);

    // choose a scale that makes canvas <= 1400px wide
    const vp1 = page.current.getViewport({ scale: 1.0 });
    const baseScale = Math.min(1, 1400 / Math.max(vp1.width, vp1.height));
    const vp = page.current.getViewport({ scale: baseScale });
    viewportRef.current = vp;

    // size canvas
    const c = canvasRef.current;
    const ctx = c.getContext("2d");
    c.width = Math.floor(vp.width);
    c.height = Math.floor(vp.height);
    c.style.width = `${c.width}px`;
    c.style.height = `${c.height}px`;

    // position overlay to canvas box
    const stageR = stageRef.current.getBoundingClientRect();
    const cR = c.getBoundingClientRect();
    const o = overlayRef.current;
    o.style.left = `${Math.round(cR.left - stageR.left)}px`;
    o.style.top = `${Math.round(cR.top - stageR.top)}px`;
    o.style.width = `${Math.floor(cR.width)}px`;
    o.style.height = `${Math.floor(cR.height)}px`;

    // render
    renderTask.current = page.current.render({ canvasContext: ctx, viewport: vp });
    await renderTask.current.promise;

    clearOverlay();
  }

  // ---- OVERLAY DRAWING ----
  function clearOverlay() {
    const o = overlayRef.current;
    o.innerHTML = "";
  }

  function drawRectCss({ x, y, w, h, color = "#ec4899", dashed = false, label = "" }) {
    const o = overlayRef.current;
    const d = document.createElement("div");
    d.style.position = "absolute";
    d.style.left = `${x}px`;
    d.style.top = `${y}px`;
    d.style.width = `${w}px`;
    d.style.height = `${h}px`;
    d.style.border = `2px solid ${color}`;
    if (dashed) d.style.borderStyle = "dashed";
    d.style.background = color === "#ec4899" ? "rgba(236,72,153,0.14)" : "transparent";
    d.style.boxShadow = "0 0 0 1px rgba(0,0,0,.08) inset";
    o.appendChild(d);

    if (label) {
      const t = document.createElement("div");
      t.textContent = label;
      t.style.position = "absolute";
      t.style.left = `${x}px`;
      t.style.top = `${Math.max(0, y - 18)}px`;
      t.style.padding = "1px 4px";
      t.style.fontSize = "11px";
      t.style.background = "rgba(0,0,0,.55)";
      t.style.color = "#fff";
      t.style.borderRadius = "3px";
      o.appendChild(t);
    }
  }

  // Convert DocAI bbox (which may be absurd) to canvas space safely
  function docaiToCanvas(bbox) {
    if (!bbox || !viewportRef.current) return null;
    const { x, y, width, height } = bbox;
    // Filter obviously bogus values (seen in your sample)
    if (![x, y, width, height].every((n) => Number.isFinite(+n))) return null;
    if (Math.abs(x) > 1e6 || Math.abs(y) > 1e6 || Math.abs(width) > 1e6 || Math.abs(height) > 1e6) return null;
    // Assume DocAI uses page pixel coords (top-left). pdf.js uses same origin after render.
    return { x, y, w: width, h: height };
  }

  // ---- PUBLIC API (used by left list) ----
  useImperativeHandle(ref, () => ({
    async showDocAIBbox(row) {
      if (!viewportRef.current) return;
      clearOverlay();
      const rect = docaiToCanvas(row?.bbox);
      if (!rect) return; // silently ignore junk
      drawRectCss({ ...rect, color: "#f59e0b", dashed: true, label: "DocAI bbox" });
    },
    clearDocAIBbox() {
      clearOverlay();
    },
    async locateValue(q, targetPage) {
      if (!page.current) return;
      if (targetPage && targetPage !== pageNum) {
        await render(targetPage);
        setPageNum(targetPage);
      }
      const text = (q || "").trim();
      if (!text) return;

      // Read pdf.js text items and find a best line match
      const tc = await page.current.getTextContent();
      const vp = viewportRef.current;
      let best = null;

      for (const item of tc.items) {
        const s = String(item.str || "");
        if (!s) continue;

        // Simple contains; could expand to token window matching if needed
        if (s.toLowerCase().includes(text.toLowerCase())) {
          // Compute canvas-space box
          // item.transform = [a,b,c,d,e,f]; text origin is at (e, f) in device space under viewport transform
          const [a, b, c, d, e, f] = item.transform;
          // Width approximation: scaleX * item.width
          const scaleX = Math.hypot(a, b);
          const scaleY = Math.hypot(c, d);
          const w = (item.width || s.length * 6) * scaleX;
          const h = (item.height || 10) * scaleY || Math.max(scaleY * 12, 12);
          const x = e;
          const y = f - h; // adjust because text origin is baseline-ish
          best = { x, y, w, h, str: s };
          break;
        }
      }

      clearOverlay();
      if (best) {
        drawRectCss({ x: best.x, y: best.y, w: best.w, h: best.h, color: "#ec4899", label: "located" });
      } else {
        // fallback: unobtrusive toast in console
        console.warn("No text match for:", text);
      }
    },
  }));

  return (
    <div ref={stageRef} style={wrapperCss}>
      <canvas ref={canvasRef} style={canvasCss} />
      <div ref={overlayRef} style={overlayCss} />
    </div>
  );
}

const PdfCanvas = forwardRef(PdfCanvasImpl);
export default PdfCanvas;