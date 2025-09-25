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
  PDFDocumentProxy,
  PDFPageProxy,
} from "pdfjs-dist";
import { locateBestSpan, Token } from "./match";

// pdf.js worker (ESM)
GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url
).toString();

export type PdfCanvasHandle = {
  renderPage: (n: number) => Promise<void>;
  prev: () => Promise<void>;
  next: () => Promise<void>;
  showDocAIBbox: (row: any | null) => void;
  locateValue: (text: string, pageHint?: number) => Promise<void>;
};

type Props = { pdfUrl: string };

export default forwardRef<PdfCanvasHandle, Props>(function PdfCanvas(
  { pdfUrl },
  ref
) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const pageRef = useRef<PDFPageProxy | null>(null);
  const [pageNum, setPageNum] = useState(1);
  const [pageCount, setPageCount] = useState(1);
  const [scale] = useState(1.5);
  const viewportRef = useRef<any>(null);
  const tokensRef = useRef<Record<number, Token[]>>({});
  const renderTaskRef = useRef<any>(null);

  useEffect(() => {
    if (!pdfUrl) return;
    (async () => {
      try {
        if (renderTaskRef.current) {
          try { await renderTaskRef.current.cancel(); } catch {}
          renderTaskRef.current = null;
        }
        if (pdf) {
          try { await pdf.destroy(); } catch {}
        }
        const doc = await getDocument(pdfUrl).promise;
        setPdf(doc);
        setPageCount(doc.numPages);
        setPageNum(1);
        await renderPage(1);
      } catch (e) {
        console.error("PDF load error:", e);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdfUrl]);

  async function renderPage(n: number) {
    if (!pdf) return;
    if (renderTaskRef.current) {
      try { await renderTaskRef.current.cancel(); } catch {}
      renderTaskRef.current = null;
    }
    const c = canvasRef.current!;
    const ctx = c.getContext("2d")!;

    const page = await pdf.getPage(n);
    pageRef.current = page;

    const rotation = (page.rotate || 0) % 360;
    const vp1 = page.getViewport({ scale: 1, rotation });
    const baseScale = Math.min(1, 1400 / Math.max(vp1.width, vp1.height));
    const viewport = page.getViewport({ scale: baseScale * scale, rotation });
    viewportRef.current = viewport;

    c.width = Math.floor(viewport.width);
    c.height = Math.floor(viewport.height);
    c.style.width = `${c.width}px`;
    c.style.height = `${c.height}px`;

    // align overlay to canvas box
    alignOverlay();

    const task = page.render({ canvasContext: ctx, viewport });
    renderTaskRef.current = task;
    await task.promise.catch(() => {});
    renderTaskRef.current = null;

    await extractTokens(n);
    clearOverlays();
    setPageNum(n);
  }

  async function extractTokens(n: number) {
    if (!pageRef.current || !viewportRef.current) return;
    const text = await pageRef.current.getTextContent({
      normalizeWhitespace: true,
      disableCombineTextItems: false
    });
    // @ts-ignore
    const Util = (await import("pdfjs-dist")).Util;
    const vp = viewportRef.current;

    const toks: Token[] = [];
    for (const it of text.items as any[]) {
      // map text item to canvas-space rect using viewport.transform
      const tr = Util.transform(vp.transform, it.transform);
      const x = tr[4];
      const yTop = tr[5];
      const w = it.width * vp.scale;
      const h = it.height * vp.scale;
      toks.push({ page: n, x0: x, y0: yTop - h, x1: x + w, y1: yTop, text: it.str || "" });
    }
    // sort in reading order (y asc, then x asc)
    toks.sort((A,B)=> (A.y0===B.y0 ? A.x0-B.x0 : A.y0-B.y0));
    tokensRef.current[n] = toks;
  }

  function alignOverlay() {
    const ov = overlayRef.current!;
    const c = canvasRef.current!;
    ov.style.position = "absolute";
    ov.style.left = c.offsetLeft + "px";
    ov.style.top = c.offsetTop + "px";
    ov.style.width = c.clientWidth + "px";
    ov.style.height = c.clientHeight + "px";
  }

  function clearOverlays() {
    const ov = overlayRef.current!;
    ov.innerHTML = "";
  }
  function drawBox(r: {x0:number;y0:number;x1:number;y1:number}, style: "pink" | "dash") {
    const ov = overlayRef.current!;
    const el = document.createElement("div");
    el.className = style === "pink" ? "hl-pink" : "hl-dash";
    el.style.left = `${Math.min(r.x0, r.x1)}px`;
    el.style.top = `${Math.min(r.y0, r.y1)}px`;
    el.style.width = `${Math.abs(r.x1 - r.x0)}px`;
    el.style.height = `${Math.abs(r.y1 - r.y0)}px`;
    ov.appendChild(el);
  }

  function sanitizeDocAIBbox(b: any) {
    if (!b) return null;
    const x = +b.x, y = +b.y, w = +b.width, h = +b.height;
    if (![x,y,w,h].every(Number.isFinite)) return null;
    if (w <= 0 || h <= 0) return null;
    // reject absurd outliers
    const cap = 1e6;
    if (Math.abs(x) > cap || Math.abs(y) > cap || Math.abs(w) > cap || Math.abs(h) > cap) return null;
    // DocAI assumed already in rendered-pixel space for this demo
    return { x0: x, y0: y, x1: x + w, y1: y + h };
  }

  async function locateValue(text: string, pageHint?: number) {
    if (!text) return;
    const all = Object.values(tokensRef.current).flat();
    const hit = locateBestSpan(all, text);
    clearOverlays();
    if (!hit) return;
    // ensure correct page rendered before drawing
    if (pageHint && pageHint !== pageNum) await renderPage(pageHint);
    else if (hit.page !== pageNum) await renderPage(hit.page);

    drawBox(hit.rect, "pink");

    // center scroll if possible
    const scroller = canvasRef.current?.parentElement?.parentElement;
    if (scroller) {
      const cx = (hit.rect.x0 + hit.rect.x1) / 2;
      const cy = (hit.rect.y0 + hit.rect.y1) / 2;
      scroller.scrollTo({
        left: Math.max(0, cx - scroller.clientWidth / 2),
        top: Math.max(0, cy - scroller.clientHeight / 2),
        behavior: "smooth"
      });
    }
  }

  function showDocAIBbox(row: any | null) {
    // keep any pink, but clear previous dashed
    const ov = overlayRef.current!;
    [...ov.querySelectorAll(".hl-dash")].forEach(n => n.remove());
    if (!row?.bbox) return;
    const r = sanitizeDocAIBbox(row.bbox);
    if (!r) return;
    drawBox(r, "dash");
  }

  useImperativeHandle(ref, () => ({
    renderPage,
    prev: async () => { if (pageNum > 1) await renderPage(pageNum - 1); },
    next: async () => { if (pdf && pageNum < pdf.numPages) await renderPage(pageNum + 1); },
    showDocAIBbox,
    locateValue
  }));

  useEffect(() => {
    const onResize = () => alignOverlay();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  return (
    <div className="pdf-stage">
      <div className="pdf-scroll">
        <div className="pdf-layer">
          <canvas ref={canvasRef} />
          <div ref={overlayRef} className="overlay" />
        </div>
      </div>
    </div>
  );
});