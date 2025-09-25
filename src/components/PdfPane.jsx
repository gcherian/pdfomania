// PdfEditCanvas.tsx  — stable v1
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
  type PDFDocumentProxy,
  type PDFPageProxy,
  type RenderTask,
} from "pdfjs-dist";
import "pdfjs-dist/web/pdf_viewer.css";

// IMPORTANT: keep this workerSrc exactly like this for Vite
GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url
).toString();

export type PdfHandle = {
  loadPdf: (src: File | string) => Promise<void>;
  showDocAIBbox: (row: { page: number; boundingBox?: { x: number; y: number; width: number; height: number } | null }) => void;
  locateValue: (content: string, pageHint?: number) => Promise<void>;
  clearOverlays: () => void;
};

type Rect = { x0: number; y0: number; x1: number; y1: number };

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

const PdfEditCanvas = forwardRef<PdfHandle, { fitWidth?: number }>(
  function PdfEditCanvas({ fitWidth = 980 }, ref) {
    const stageRef = useRef<HTMLDivElement | null>(null);
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const overlayRef = useRef<HTMLDivElement | null>(null);

    const pdfRef = useRef<PDFDocumentProxy | null>(null);
    const pageRef = useRef<PDFPageProxy | null>(null);
    const renderTaskRef = useRef<RenderTask | null>(null);
    const urlRevokeRef = useRef<string | null>(null);

    const [page, setPage] = useState(1);
    const [pageCount, setPageCount] = useState(0);

    const ocrW = useRef(0); // PDF space width
    const ocrH = useRef(0); // PDF space height

    /** ---- helpers ---- */
    function clearOverlay() {
      const o = overlayRef.current;
      if (o) o.innerHTML = "";
    }
    function addBox(rect: Rect, css: Partial<CSSStyleDeclaration>) {
      const o = overlayRef.current;
      if (!o) return;
      const R = o.getBoundingClientRect();
      if (R.width === 0 || R.height === 0) return;

      const sx = R.width / ocrW.current;
      const sy = R.height / ocrH.current;
      const d = document.createElement("div");
      const x = Math.min(rect.x0, rect.x1) * sx;
      const y = Math.min(rect.y0, rect.y1) * sy;
      const w = Math.abs(rect.x1 - rect.x0) * sx;
      const h = Math.abs(rect.y1 - rect.y0) * sy;

      d.style.position = "absolute";
      d.style.left = `${x}px`;
      d.style.top = `${y}px`;
      d.style.width = `${w}px`;
      d.style.height = `${h}px`;
      Object.assign(d.style, css);
      o.appendChild(d);
    }

    async function render(pageNum = page) {
      if (!pdfRef.current || !canvasRef.current) return;

      // cancel any in-flight render task
      if (renderTaskRef.current) {
        try {
          renderTaskRef.current.cancel();
        } catch {}
        renderTaskRef.current = null;
      }

      clearOverlay();

      const pg = await pdfRef.current.getPage(pageNum);
      pageRef.current = pg;

      // compute scale to fit width
      const baseVp = pg.getViewport({ scale: 1 });
      const scale = Math.min(2.5, fitWidth / baseVp.width);
      const vp = pg.getViewport({ scale });

      const canvas = canvasRef.current;
      const ctx = canvas.getContext("2d")!;
      canvas.width = Math.floor(vp.width);
      canvas.height = Math.floor(vp.height);
      canvas.style.width = `${canvas.width}px`;
      canvas.style.height = `${canvas.height}px`;

      // Track "ocr space" for the overlay mapping (PDF coordinate space)
      ocrW.current = baseVp.width;
      ocrH.current = baseVp.height;

      // position overlay to match canvas
      if (overlayRef.current) {
        overlayRef.current.style.position = "absolute";
        overlayRef.current.style.left = canvas.style.left || "0px";
        overlayRef.current.style.top = canvas.style.top || "0px";
        overlayRef.current.style.width = `${canvas.width}px`;
        overlayRef.current.style.height = `${canvas.height}px`;
      }

      renderTaskRef.current = pg.render({ canvasContext: ctx, viewport: vp });
      await renderTaskRef.current.promise;
      renderTaskRef.current = null;
    }

    /** ---- public API ---- */
    useImperativeHandle(ref, () => ({
      async loadPdf(src: File | string) {
        // revoke earlier blob url
        if (urlRevokeRef.current) {
          URL.revokeObjectURL(urlRevokeRef.current);
          urlRevokeRef.current = null;
        }
        const url = src instanceof File ? URL.createObjectURL(src) : src;
        if (src instanceof File) urlRevokeRef.current = url;

        const doc = await getDocument(url).promise;
        pdfRef.current = doc;
        setPage(1);
        setPageCount(doc.numPages);
        await render(1);
      },

      showDocAIBbox(row) {
        if (!row?.boundingBox || !overlayRef.current) return;

        // guard: DocAI sometimes returns sentinel 2147483647-ish values
        const b = row.boundingBox;
        const bad =
          !isFinite(b.x) ||
          !isFinite(b.y) ||
          !isFinite(b.width) ||
          !isFinite(b.height) ||
          Math.abs(b.x) > ocrW.current * 20 ||
          Math.abs(b.y) > ocrH.current * 20;

        clearOverlay();
        if (bad) return;

        const rect: Rect = {
          x0: clamp(b.x, 0, ocrW.current),
          y0: clamp(b.y, 0, ocrH.current),
          x1: clamp(b.x + b.width, 0, ocrW.current),
          y1: clamp(b.y + b.height, 0, ocrH.current),
        };
        addBox(rect, {
          border: "2px dashed rgba(255, 215, 0, 0.9)",
          background: "rgba(255, 215, 0, 0.08)",
          pointerEvents: "none",
        });
      },

      async locateValue(content: string, pageHint?: number) {
        if (!pdfRef.current) return;
        const p = pageHint || page;
        const pg = await pdfRef.current.getPage(p);
        const tc = await pg.getTextContent();

        // naive full-string match; union all matches into one box
        const needle = (content || "").replace(/\s+/g, " ").trim();
        if (!needle) return;

        // accumulate rects
        const rects: Rect[] = [];
        let buf = "";
        let startIndex = -1;

        // Map each textChunk to absolute positions in "ocr space"
        const baseVp = pg.getViewport({ scale: 1 });
        const transformQuad = (tx: any) => {
          // tx.transform: [a, b, c, d, e, f]
          const [a, b, c, d, e, f] = tx.transform;
          const w = tx.width;
          const h = tx.height;
          const x0 = e;
          const y0 = f - h;
          const x1 = e + w;
          const y1 = f;
          return { x0, y0, x1, y1 };
        };

        // Flatten stream of items to a string with indexes
        const items = tc.items as any[];
        for (let i = 0; i < items.length; i++) {
          const it = items[i];
          const t = (it.str || "").replace(/\s+/g, " ");
          if (!t) continue;

          // streaming substring search
          if (startIndex < 0) {
            const pos = (buf + t).indexOf(needle);
            if (pos >= 0) startIndex = pos;
          }
          buf += t;

          if (startIndex >= 0 && buf.length <= startIndex + needle.length) {
            // still collecting…
          }
        }

        if (startIndex < 0) return;

        // Second pass: collect the quads that cover the found substring
        let consumed = 0;
        let need = needle.length;
        let begun = false;

        for (const it of items) {
          const t = (it.str || "").replace(/\s+/g, " ");
          if (!t) continue;

          const next = consumed + t.length;
          if (!begun && next > startIndex) begun = true;

          if (begun) {
            const cover = Math.min(need, next - Math.max(consumed, startIndex));
            if (cover > 0) {
              const q = transformQuad(it);
              rects.push(q);
              need -= cover;
              if (need <= 0) break;
            }
          }
          consumed = next;
        }

        if (!rects.length) return;
        clearOverlay();

        const union = rects.reduce(
          (acc, r) => ({
            x0: Math.min(acc.x0, r.x0),
            y0: Math.min(acc.y0, r.y0),
            x1: Math.max(acc.x1, r.x1),
            y1: Math.max(acc.y1, r.y1),
          }),
          { x0: rects[0].x0, y0: rects[0].y0, x1: rects[0].x1, y1: rects[0].y1 }
        );

        addBox(union, {
          border: "2px solid rgba(236,72,153,0.95)",
          background: "rgba(236,72,153,0.18)",
          boxShadow: "0 0 0 1px rgba(236,72,153,0.2) inset",
          pointerEvents: "none",
        });

        // center view on the union
        const o = overlayRef.current!;
        const R = o.getBoundingClientRect();
        const cx = ((union.x0 + union.x1) / 2) * (R.width / ocrW.current);
        const cy = ((union.y0 + union.y1) / 2) * (R.height / ocrH.current);
        const sc = stageRef.current!;
        sc.scrollTo({
          left: Math.max(0, cx - sc.clientWidth / 2),
          top: Math.max(0, cy - sc.clientHeight / 2),
          behavior: "smooth",
        });
      },

      clearOverlays() {
        clearOverlay();
      },
    }));

    // Re-render on page change
    useEffect(() => {
      render(page);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [page]);

    // Cleanup blob url on unmount
    useEffect(() => {
      return () => {
        if (urlRevokeRef.current) URL.revokeObjectURL(urlRevokeRef.current);
        if (renderTaskRef.current) {
          try {
            renderTaskRef.current.cancel();
          } catch {}
        }
      };
    }, []);

    return (
      <div
        ref={stageRef}
        style={{
          position: "relative",
          overflow: "auto",
          width: "100%",
          height: "100%",
          background: "#0b0e14",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: 6 }}>
          <span className="muted">Page {page} / {Math.max(1, pageCount)}</span>
          <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1}>Prev</button>
          <button onClick={() => setPage((p) => Math.min(pageCount || 1, p + 1))} disabled={page >= pageCount}>Next</button>
        </div>
        <div style={{ position: "relative" }}>
          <canvas ref={canvasRef} />
          <div ref={overlayRef} style={{ position: "absolute", left: 0, top: 0, zIndex: 10 }} />
        </div>
      </div>
    );
  }
);

export default PdfEditCanvas;

// add near imports:
import React, { forwardRef, useImperativeHandle, useRef, useState } from "react";

// export a handle type so App can call these:
export type PdfRefHandle = {
  showDocAIBbox: (row: { page: number; bbox?: {x:number;y:number;width:number;height:number} | null }) => void;
  locateValue: (text: string) => void;
};

// wrap your component with forwardRef
const PdfEditCanvas = forwardRef<PdfRefHandle, Props>(function PdfEditCanvas(props, ref) {
  // ... your existing state/refs
  const [hoverRect, setHoverRect] = useState<EditRect | null>(null);

  // expose methods (uses your existing utilities)
  useImperativeHandle(ref, () => ({
    showDocAIBbox(row) {
      const b = row?.bbox;
      if (!b || !isFinite(b.x) || !isFinite(b.y) || !isFinite(b.width) || !isFinite(b.height)) {
        setHoverRect(null);
        return;
      }
      if (row.page && props.page !== row.page) props.onPageChange?.(row.page); // or setPage(row.page)
      setHoverRect({
        page: row.page,
        x0: b.x, y0: b.y,
        x1: b.x + b.width, y1: b.y + b.height,
      });
    },
    locateValue(text) {
      if (!text?.trim()) return;
      const hit = autoLocateByValue(text, props.tokens || []); // you already have this
      if (hit) {
        // reuse your existing selection logic
        props.onSelectRect?.({ page: hit.page, ...hit.rect });
      }
    },
  }));

  // in your drawOverlay() (or equivalent), add dashed hover box:
  if (hoverRect && hoverRect.page === props.page) {
    const d = document.createElement("div");
    d.className = "docai-hover";
    placeCss(d, hoverRect.x0, hoverRect.y0, hoverRect.x1, hoverRect.y1);
    overlay.appendChild(d);
  }

  // ensure CSS exists
  // .overlay .docai-hover { border:2px dashed rgba(255,165,0,0.95); background:transparent; pointer-events:none; }

  return (/* your existing JSX */);
});

export default PdfEditCanvas;

// keep this near where you call render()
renderTaskRef.current?.cancel();
renderTaskRef.current = page.render({ canvasContext: ctx, viewport });
await renderTaskRef.current.promise;