import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { GlobalWorkerOptions, getDocument } from "pdfjs-dist";
import "pdfjs-dist/web/pdf_viewer.css";

// point the worker (Vite-friendly)
GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();

/* ---------------- small match utilities (embedded here so app is self-contained) ---------------- */
function norm(s) {
  return (s || "").toString().toLowerCase().normalize("NFKC").replace(/\s+/g, " ").trim();
}
function levRatio(a, b) {
  if (!a && !b) return 1;
  const m = a.length, n = b.length;
  const dp = new Array(n + 1);
  for (let j=0;j<=n;j++) dp[j]=j;
  for (let i=1;i<=m;i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j=1;j<=n;j++){
      const tmp = dp[j];
      dp[j] = Math.min(dp[j]+1, dp[j-1]+1, prev + (a[i-1]===b[j-1]?0:1));
      prev = tmp;
    }
  }
  return 1 - dp[n] / Math.max(1, Math.max(m,n));
}

/* auto-locate by value among tokens (very similar to earlier autoLocateByValue) */
function autoLocateByValue(valueRaw, allTokens, maxWindow=16) {
  const raw = (valueRaw || "").trim();
  if (!raw) return null;
  const looksNumeric = /^[\s\-$€£₹,.\d/]+$/.test(raw);
  const words = looksNumeric ? [raw.replace(/[,$]/g,"").trim()] : norm(raw).split(" ").filter(Boolean);

  // group tokens by page
  const byPage = new Map();
  for (const t of allTokens) {
    (byPage.get(t.page) || byPage.set(t.page, []).get(t.page)).push(t);
  }
  for (const [pg, toks] of byPage) toks.sort((a,b) => (a.y0===b.y0? a.x0-b.x0 : a.y0-b.y0));

  let best = null;
  function spanRect(span) {
    let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity;
    for (const s of span) { x0=Math.min(x0,s.x0); y0=Math.min(y0,s.y0); x1=Math.max(x1,s.x1); y1=Math.max(y1,s.y1); }
    return { x0: Math.floor(x0), y0: Math.floor(y0), x1: Math.ceil(x1), y1: Math.ceil(y1) };
  }

  for (const [pg,toks] of byPage) {
    const n = toks.length;
    for (let i=0;i<n;i++){
      const span=[];
      for (let w=0; w<maxWindow && i+w<n; w++){
        const t = toks[i+w];
        if (!t.text) continue;
        span.push(t);
        const spanTxt = span.map(s=>s.text).join(" ").toLowerCase();
        const spanWords = spanTxt.split(/\s+/).filter(Boolean);
        // coverage heuristic
        let covered = 0; let j=0;
        for (let ii=0; ii<words.length && j<spanWords.length; ){
          if (words[ii] === spanWords[j] || levRatio(words[ii], spanWords[j]) >= 0.8) { covered++; ii++; j++; }
          else j++;
        }
        const coverage = covered / Math.max(1, words.length);
        const fuzz = levRatio(spanWords.join(" "), words.join(" "));
        const score = coverage * 0.7 + fuzz * 0.3;
        if (!best || score > best.score) best = { score, page: pg, span: [...span] };
      }
    }
  }

  if (!best) return null;
  return { page: best.page, rect: spanRect(best.span), score: best.score };
}

/* ---------------- actual component ---------------- */
const PdfCanvas = forwardRef(function PdfCanvas({ pdfData }, ref) {
  const hostRef = useRef(null);
  const canvasRef = useRef(null);
  const overlayRef = useRef(null);

  const pdfRef = useRef(null);
  const pageRef = useRef(null);
  const viewportRef = useRef(null);
  const renderTaskRef = useRef(null);

  const [pageNum, setPageNum] = useState(1);
  const tokensRef = useRef([]);  // tokens across all pages

  const hoverRectRef = useRef(null);   // dashed DocAI bbox (doc coords)
  const locateRectRef = useRef(null);  // pink match bbox (doc coords)

  // load pdf and build tokens
  useEffect(() => {
    let cancelled=false;
    (async () => {
      clearAll();
      if (!pdfData) return;
      try { await renderTaskRef.current?.cancel?.(); } catch {}
      renderTaskRef.current = null;
      const loading = getDocument({ data: pdfData });
      const doc = await loading.promise;
      if (cancelled) return;
      pdfRef.current = doc;
      // build tokens
      const allTokens = [];
      for (let p=1;p<=doc.numPages;p++){
        const pg = await doc.getPage(p);
        const rot = (pg.rotate || 0) % 360;
        const vp = pg.getViewport({ scale: 1, rotation: rot });
        const textContent = await pg.getTextContent({ normalizeWhitespace: true });
        const items = textContent.items || [];
        for (const it of items){
          const str = it.str || "";
          if (!str) continue;
          const [a,b,c,d,e,f] = it.transform || [1,0,0,1,0,0];
          const fontH = Math.hypot(b,d) || Math.abs(d) || Math.abs(b) || 10;
          const xBase = e;
          const yTop = vp.height - f;
          const chunkWidth = it.width ?? Math.abs(a) * Math.max(1, str.length || 1);
          // rough split words
          const parts = str.split(/\s+/).filter(Boolean);
          const totalChars = Math.max(1, str.length);
          let xCursor = xBase;
          for (const part of parts) {
            const frac = part.length / totalChars;
            const w = Math.max(3, chunkWidth * frac);
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
    })();
    return () => { cancelled=true; };
  }, [pdfData]);

  // render page when pageNum updates
  useEffect(() => {
    if (!pdfRef.current) return;
    renderPage(pageNum).catch(console.error);
  }, [pageNum]);

  async function renderPage(p) {
    if (!pdfRef.current) return;
    try { await renderTaskRef.current?.cancel?.(); } catch {}
    renderTaskRef.current = null;
    const pg = await pdfRef.current.getPage(p);
    pageRef.current = pg;
    const rot = (pg.rotate || 0) % 360;
    const vp1 = pg.getViewport({ scale: 1, rotation: rot });
    const maxDisplay = 1400;
    const baseScale = Math.min(1.6, Math.max(0.8, maxDisplay / Math.max(vp1.width, vp1.height)));
    const vp = pg.getViewport({ scale: baseScale, rotation: rot });
    viewportRef.current = vp;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    canvas.width = Math.floor(vp.width);
    canvas.height = Math.floor(vp.height);
    canvas.style.width = `${canvas.width}px`;
    canvas.style.height = `${canvas.height}px`;
    canvas.style.zIndex = 0;

    syncOverlay();
    renderTaskRef.current = pg.render({ canvasContext: ctx, viewport: vp });
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
    if (c) c.getContext("2d").clearRect(0,0,c.width,c.height);
    if (overlayRef.current) overlayRef.current.innerHTML = "";
    hoverRectRef.current = null;
    locateRectRef.current = null;
    tokensRef.current = [];
  }

  function syncOverlay() {
    const canvas = canvasRef.current;
    const overlay = overlayRef.current;
    if (!canvas || !overlay) return;
    overlay.style.position = "absolute";
    overlay.style.left = "0";
    overlay.style.top = "0";
    overlay.style.width = `${canvas.width}px`;
    overlay.style.height = `${canvas.height}px`;
    overlay.style.zIndex = 9999;
  }

  function drawOverlay() {
    const overlay = overlayRef.current;
    const canvas = canvasRef.current;
    if (!overlay || !canvas) return;
    overlay.innerHTML = "";
    const place = (node, r) => {
      node.style.position = "absolute";
      node.style.left = `${Math.min(r.x0, r.x1)}px`;
      node.style.top = `${Math.min(r.y0, r.y1)}px`;
      node.style.width = `${Math.abs(r.x1 - r.x0)}px`;
      node.style.height = `${Math.abs(r.y1 - r.y0)}px`;
    };
    const addBox = (r, cls) => {
      if (!r || r.page !== pageNum) return;
      const d = document.createElement("div");
      d.className = cls;
      place(d, r);
      overlay.appendChild(d);
    };
    if (hoverRectRef.current) addBox(hoverRectRef.current, "docai-hover");
    if (locateRectRef.current) addBox(locateRectRef.current, "docai-locate");
  }

  // small locator that consumes tokensRef.current
  function locateByValue(value, opts) {
    try {
      const toks = tokensRef.current || [];
      return autoLocateByValue(value, toks, (opts && opts.maxWindow) || 16);
    } catch (e) {
      console.error("locateByValue error:", e);
      return null;
    }
  }

  // export ref API
  useImperativeHandle(ref, () => ({
    showDocAIBbox: (row) => {
      hoverRectRef.current = null;
      if (!row || !row.bbox) { drawOverlay(); return; }
      // convert doc bbox (x,y,w,h) assumed in page-space to rect with x0..x1
      const x0 = Number(row.bbox.x || 0);
      const y0 = Number(row.bbox.y || 0);
      const x1 = Number((row.bbox.x || 0) + (row.bbox.width || 0));
      const y1 = Number((row.bbox.y || 0) + (row.bbox.height || 0));
      hoverRectRef.current = { page: row.page || 1, x0, y0, x1, y1 };
      if (hoverRectRef.current.page !== pageNum) setPageNum(hoverRectRef.current.page);
      else drawOverlay();
    },

    locateValue: (value, opts) => {
      locateRectRef.current = null;
      const res = locateByValue(value, opts);
      if (res) {
        locateRectRef.current = { page: res.page, x0: res.rect.x0, y0: res.rect.y0, x1: res.rect.x1, y1: res.rect.y1 };
        if (res.page !== pageNum) setPageNum(res.page);
        else drawOverlay();
      } else drawOverlay();
      return res;
    },

    matchAndHighlight: (key, value, opts) => {
      // For now: simple fallback: prefer locate by value (we can add key-aware logic later)
      locateRectRef.current = null;
      const res = locateByValue(value, opts);
      if (res) {
        locateRectRef.current = { page: res.page, x0: res.rect.x0, y0: res.rect.y0, x1: res.rect.x1, y1: res.rect.y1 };
        if (res.page !== pageNum) setPageNum(res.page);
        else drawOverlay();
      } else drawOverlay();
      return res;
    },

    goto: (p) => {
      if (!pdfRef.current) return;
      const pg = Math.max(1, Math.min(p || 1, pdfRef.current.numPages || 1));
      setPageNum(pg);
    },

    clearHighlights: () => {
      hoverRectRef.current = null;
      locateRectRef.current = null;
      drawOverlay();
    },

    // expose some internals for debugging
    __debug: () => ({ tokensCount: tokensRef.current.length, pageNum }),
  }));

  // overlay alignment on resize
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

  return (
    <div ref={hostRef} className="canvas-stage" style={{ width: "100%", height: "100%", position: "relative", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <canvas ref={canvasRef} />
      <div ref={overlayRef} className="overlay" />
      <div style={{ position: "absolute", left: 12, top: 12, zIndex: 10000 }}>
        <button className="btn" onClick={() => setPageNum(p => Math.max(1, p - 1))}>Prev</button>
        <button className="btn" style={{marginLeft:8}} onClick={() => setPageNum(p => p + 1)}>Next</button>
        <span style={{marginLeft:12, color:"#222", background:"#fff", padding:"3px 6px", borderRadius:6}}>Page {pageNum}{pdfRef.current ? ` / ${pdfRef.current.numPages}` : ""}</span>
      </div>
    </div>
  );
});

export default PdfCanvas;