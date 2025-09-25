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
} from "pdfjs-dist";
import { matchField, locateByValue, type TokenBox as MatchToken } from "../lib/match";

// ---- pdf.js worker (mjs path works with Vite) ----
GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url
).toString();

// ---- Types ----
export type PdfRefHandle = {
  showDocAIBbox: (row: {
    page?: number;
    bbox?: { x: number; y: number; width: number; height: number } | null;
  } | null) => void;
  matchAndHighlight: (
    key: string,
    value: string,
    opts?: {
      preferredPages?: number[];
      numericHint?: boolean;
      contextRadiusPx?: number;
      maxWindow?: number;
    }
  ) => void;
  locateValue: (
    value: string,
    opts?: {
      preferredPages?: number[];
      numericHint?: boolean;
      contextRadiusPx?: number;
      maxWindow?: number;
    }
  ) => void;
  goto: (page: number) => void;
  clearHighlights: () => void;
};

type Props = {
  pdfData: ArrayBuffer | null;
};

type DocRect = { page: number; x0: number; y0: number; x1: number; y1: number };

// ---- Component ----
const PdfCanvas = forwardRef<PdfRefHandle, Props>(function PdfCanvas(
  { pdfData },
  ref
) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);

  const pdfRef = useRef<PDFDocumentProxy | null>(null);
  const renderTaskRef = useRef<any>(null);
  const pageRef = useRef<PDFPageProxy | null>(null);
  const viewportRef = useRef<any>(null);

  // tokens across all pages for match.ts
  const tokensRef = useRef<MatchToken[]>([]);

  // UI state
  const [pageNum, setPageNum] = useState<number>(1);

  // overlays
  const hoverRectRef = useRef<DocRect | null>(null);   // dashed DocAI rect
  const locateRectRef = useRef<DocRect | null>(null);  // pink matched rect

  // ---------- Load PDF when data changes ----------
  useEffect(() => {
    let cancelled = false;
    (async () => {
      clearAll();
      if (!pdfData) return;

      // cancel prev render task if any
      try { await renderTaskRef.current?.cancel?.(); } catch { /* noop */ }
      renderTaskRef.current = null;

      try {
        const loadingTask = getDocument({ data: pdfData });
        const doc = await loadingTask.promise;
        if (cancelled) return;
        pdfRef.current = doc;

        // extract tokens for all pages (ok for demo/typical page counts)
        const allTokens: MatchToken[] = [];
        for (let p = 1; p <= doc.numPages; p++) {
          const page = await doc.getPage(p);
          const vp = page.getViewport({ scale: 1, rotation: page.rotate || 0 });
          const textContent = await page.getTextContent({ normalizeWhitespace: true });
          const tokens = pageItemsToWordTokens(textContent.items as any[], vp, p);
          allTokens.push(...tokens);
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
    if (!pdfRef.current) return;
    renderPage(pageNum).catch(console.error);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageNum]);

  async function renderPage(p: number) {
    if (!pdfRef.current) return;

    // cancel previous render
    try { await renderTaskRef.current?.cancel?.(); } catch { /* noop */ }
    renderTaskRef.current = null;

    const page = await pdfRef.current.getPage(p);
    pageRef.current = page;

    // scale page to a reasonable max pixel size (keeps quality & perf)
    const rot = (page.rotate || 0) % 360;
    const vp1 = page.getViewport({ scale: 1, rotation: rot });
    const maxDisplay = 1400;
    const baseScale = Math.min(1.6, Math.max(0.8, maxDisplay / Math.max(vp1.width, vp1.height)));
    const vp = page.getViewport({ scale: baseScale, rotation: rot });
    viewportRef.current = vp;

    // canvases
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;
    canvas.width = Math.floor(vp.width);
    canvas.height = Math.floor(vp.height);
    canvas.style.width = `${canvas.width}px`;
    canvas.style.height = `${canvas.height}px`;

    // align overlay
    syncOverlay();

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
    // clear canvas + overlay + state
    const c = canvasRef.current;
    if (c) {
      const g = c.getContext("2d")!;
      g.clearRect(0, 0, c.width, c.height);
    }
    if (overlayRef.current) overlayRef.current.innerHTML = "";
    hoverRectRef.current = null;
    locateRectRef.current = null;
    tokensRef.current = [];
  }

  function syncOverlay() {
    const canvas = canvasRef.current;
    const overlay = overlayRef.current;
    if (!canvas || !overlay) return;
    const cR = canvas.getBoundingClientRect();
    const parentR = overlay.parentElement!.getBoundingClientRect();
    overlay.style.position = "absolute";
    overlay.style.left = `${Math.round(cR.left - parentR.left)}px`;
    overlay.style.top = `${Math.round(cR.top - parentR.top)}px`;
    overlay.style.width = `${Math.floor(cR.width)}px`;
    overlay.style.height = `${Math.floor(cR.height)}px`;
  }

  // keep overlay aligned on canvas resize
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const ro = new ResizeObserver(() => {
      syncOverlay();
      drawOverlay();
    });
    ro.observe(c);
    return () => ro.disconnect();
  }, []);

  // ---------- Tokenization: pdf.js text items -> word-level tokens ----------
  function pageItemsToWordTokens(items: any[], vp: any, page: number): MatchToken[] {
    // items are chunks; we’ll split chunks into words and approximate widths proportionally
    const out: MatchToken[] = [];
    for (const it of items) {
      const str: string = it.str || it.text || "";
      if (!str) continue;

      // Transform matrix: [a, b, c, d, e, f]; e,f = text baseline in viewport coordinates
      // pdf.js renders with y axis down; viewport already adjusted.
      const [a, b, c, d, e, f] = it.transform || [1, 0, 0, 1, 0, 0];
      // font height estimate
      const fontH = Math.hypot(b, d) || Math.abs(d) || Math.abs(b) || 10;
      // baseline y maps to bottom; compute top-left-ish
      const xBase = e;
      const yTop = vp.height - f;

      // The chunk width (in viewport space)
      const chunkWidth = it.width ?? Math.abs(a) * (str.length || 1);

      // Split into words; preserve numeric spans
      const parts = splitIntoWords(str);
      if (!parts.length) continue;

      // Distribute width proportionally by character count (approximation)
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

        out.push({
          page,
          x0,
          y0,
          x1,
          y1,
          text: part,
        });
      }
    }
    // sort reading order
    out.sort((A, B) => (A.y0 === B.y0 ? A.x0 - B.x0 : A.y0 - B.y0));
    return out;
  }

  function splitIntoWords(s: string): string[] {
    // keep numbers (including punctuation within) together; split letters on whitespace/punct; drop empties
    // Example: "43812" or "1,234.56" stays whole; "Main St." -> ["Main","St"]
    const tokens: string[] = [];
    let buf = "";
    const flush = () => { if (buf.trim()) tokens.push(buf); buf = ""; };

    for (const ch of s) {
      if (/\d/.test(ch)) {
        buf += ch;
      } else if (/[.,\-\/]/.test(ch) && /\d/.test(buf.slice(-1))) {
        // number punctuation inside a number
        buf += ch;
      } else if (/\s/.test(ch)) {
        flush();
      } else if (/[A-Za-z]/.test(ch)) {
        buf += ch;
      } else {
        // other punctuation -> split
        flush();
      }
    }
    flush();
    return tokens;
  }

  // ---------- Overlay drawing ----------
  function drawOverlay() {
    const overlay = overlayRef.current;
    const canvas = canvasRef.current;
    if (!overlay || !canvas) return;
    overlay.innerHTML = "";

    const R = canvas.getBoundingClientRect();
    const sx = R.width / canvas.width;
    const sy = R.height / canvas.height;

    const place = (node: HTMLDivElement, r: DocRect) => {
      node.style.position = "absolute";
      node.style.left = `${Math.min(r.x0, r.x1) * sx}px`;
      node.style.top = `${Math.min(r.y0, r.y1) * sy}px`;
      node.style.width = `${Math.abs(r.x1 - r.x0) * sx}px`;
      node.style.height = `${Math.abs(r.y1 - r.y0) * sy}px`;
    };

    const addBox = (r: DocRect, cls: string) => {
      if (!r || r.page !== pageNum) return;
      const d = document.createElement("div");
      d.className = cls;
      place(d, r);
      overlay.appendChild(d);
    };

    if (hoverRectRef.current) addBox(hoverRectRef.current, "docai-hover");
    if (locateRectRef.current) addBox(locateRectRef.current, "docai-locate");
  }

  // ---------- Ref API ----------
  useImperativeHandle(ref, (): PdfRefHandle => ({
    showDocAIBbox: (row) => {
      hoverRectRef.current = null;
      if (!row || !row.bbox) { drawOverlay(); return; }
      const pg = (row.page && Number.isFinite(row.page)) ? (row.page as number) : pageNum;
      const x0 = row.bbox.x;
      const y0 = row.bbox.y;
      const x1 = row.bbox.x + row.bbox.width;
      const y1 = row.bbox.y + row.bbox.height;
      hoverRectRef.current = { page: pg, x0, y0, x1, y1 };
      if (pg !== pageNum) setPageNum(pg);
      else drawOverlay();
    },

    // value-only search (kept for convenience)
    locateValue: (value, opts) => {
      const toks = tokensRef.current || [];
      const res = locateByValue(value || "", toks, opts);
      locateRectRef.current = null;
      if (res) {
        locateRectRef.current = { page: res.page, x0: res.rect.x0, y0: res.rect.y0, x1: res.rect.x1, y1: res.rect.y1 };
        if (res.page !== pageNum) setPageNum(res.page);
        else drawOverlay();
      } else {
        drawOverlay();
      }
    },

    // key-aware matching with fallback
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
        locateRectRef.current = { page: res.page, x0: res.rect.x0, y0: res.rect.y0, x1: res.rect.x1, y1: res.rect.y1 };
        if (res.page !== pageNum) setPageNum(res.page);
        else drawOverlay();
      } else {
        drawOverlay();
      }
    },

    goto: (p: number) => {
      const pg = Math.max(1, Math.min(p || 1, pdfRef.current?.numPages || 1));
      setPageNum(pg);
    },

    clearHighlights: () => {
      hoverRectRef.current = null;
      locateRectRef.current = null;
      drawOverlay();
    },
  }));

  // ---------- UI ----------
  return (
    <div style={{ width: "100%", height: "100%", position: "relative" }}>
      <div style={{ position: "absolute", left: 12, top: 12, zIndex: 10 }}>
        <button
          className="btn"
          onClick={() => setPageNum((p) => Math.max(1, p - 1))}
        >
          Prev
        </button>
        <button
          className="btn"
          style={{ marginLeft: 8 }}
          onClick={() => setPageNum((p) => p + 1)}
        >
          Next
        </button>
        <span style={{ marginLeft: 12, color: "#cfe" }}>
          Page {pageNum}
          {pdfRef.current ? ` / ${pdfRef.current.numPages}` : ""}
        </span>
      </div>

      <div
        className="canvas-stage"
        style={{
          position: "relative",
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <canvas ref={canvasRef} />
        <div ref={overlayRef} className="overlay" />
      </div>
    </div>
  );
});

export default PdfCanvas;