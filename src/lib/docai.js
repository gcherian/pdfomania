// src/lib/docai.js
// Tolerant Google DocAI parser -> { header: [{key,value}], elements: [{content,page,bbox?}] }
// Works with shapes like:
// - documents[0].properties[0].metadata.metaDataMap  <-- your case
// - documents[0].properties.metadata.metaDataMap
// - document.properties.metadata.metaDataMap
// - properties.metadata.metaDataMap
// Also supports:
// - pages[].elements[].{ content | text | textAnchor } + boundingBox variants
// - vertices / normalizedVertices polygons, normalized bbox scaling
// - deep-scan fallback if paths are unusual

/* Public API:
 *   parseDocAIText(text: string) -> { header, elements }
 *   parseDocAI(raw: object) -> { header, elements }
 */

export function parseDocAIText(text) {
  let root;
  try {
    root = JSON.parse(text);
  } catch {
    // tolerant parse: strip comments + trailing commas and retry
    const noComments = text.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    const noTrailing = noComments.replace(/,\s*([\]}])/g, "$1");
    root = JSON.parse(noTrailing);
  }
  return parseDocAI(root);
}

export function parseDocAI(raw) {
  const { header } = extractHeader(raw);
  const { elements } = extractElements(raw);
  return { header, elements };
}

/* -------------------------------- Header -------------------------------- */

function extractHeader(root) {
  // doc root: documents[0] OR document OR root
  const doc0 = root?.documents?.[0] ?? root?.document ?? root ?? {};

  // properties may be an object OR an array — handle both
  const props0 = Array.isArray(doc0?.properties) ? doc0.properties[0] : (doc0?.properties ?? {});

  // typical metadata node
  const md = props0?.metadata ?? doc0?.metadata ?? root?.metadata ?? {};

  // primary metaDataMap (support several nearby spots)
  let metaMap =
    md?.metaDataMap ??
    props0?.metaDataMap ??
    doc0?.metaDataMap ??
    root?.metaDataMap ??
    null;

  // small local scan inside props0/md/doc0 if still missing
  if (!metaMap) {
    for (const obj of [props0, md, doc0, root]) {
      if (obj && typeof obj === "object") {
        for (const k of Object.keys(obj)) {
          const v = obj[k];
          if (v && typeof v === "object" && "metaDataMap" in v && v.metaDataMap) {
            metaMap = v.metaDataMap;
            break;
          }
        }
        if (metaMap) break;
      }
    }
  }

  const header =
    metaMap && typeof metaMap === "object"
      ? Object.entries(metaMap).map(([key, value]) => ({
          key,
          value: Array.isArray(value)
            ? value.join(", ")
            : typeof value === "object" && value !== null
            ? JSON.stringify(value)
            : String(value ?? ""),
        }))
      : [];

  return { header };
}

/* ------------------------------- Elements -------------------------------- */

function extractElements(root) {
  const docNode = root?.documents?.[0] ?? root?.document ?? root ?? {};

  // global text (for textAnchor)
  const docText =
    stringy(docNode?.text) ??
    stringy(root?.text) ??
    "";

  // gather pages (several standard paths)
  let pages =
    asArray(docNode?.properties?.pages) ??
    asArray(docNode?.pages) ??
    asArray(root?.pages) ??
    [];

  // If still nothing, deep-scan for nodes that have an elements array
  if (!pages.length) {
    const found = [];
    (function walk(n) {
      if (!n || typeof n !== "object") return;
      if (Array.isArray(n)) return n.forEach(walk);
      if (Array.isArray(n.elements)) found.push(n);
      for (const k of Object.keys(n)) walk(n[k]);
    })(root);
    pages = found;
  }

  // page sizes (for normalized bbox scaling)
  const pageSizes = {};
  pages.forEach((p, idx) => {
    const pg = numberish(p?.page ?? p?.pageNumber) ?? idx + 1;
    const w = numberish(p?.dimension?.width ?? p?.pageSize?.width ?? p?.width);
    const h = numberish(p?.dimension?.height ?? p?.pageSize?.height ?? p?.height);
    if (isFiniteNumber(w) && isFiniteNumber(h)) pageSizes[pg] = { width: w, height: h };
  });

  const out = [];

  pages.forEach((p, idx) => {
    const pageNo = numberish(p?.page ?? p?.pageNumber) ?? idx + 1;

    // Choose the richest bucket available
    const buckets = [
      asArray(p?.elements),
      asArray(p?.paragraphs),
      asArray(p?.blocks),
      asArray(p?.layout?.paragraphs),
      asArray(p?.tokens),
      asArray(p?.words),
    ].filter((a) => a.length);

    const items = buckets.length ? buckets.flat() : [p];

    items.forEach((el) => {
      // content from multiple fields, prefer content/text, fallback to textAnchor+docText
      const content =
        stringy(el?.content) ??
        stringy(el?.text) ??
        textFromTextAnchor(el?.textAnchor ?? el?.text_anchor, docText) ??
        "";

      // normalize a wide variety of bbox shapes
      const bbox = normalizeBBox(
        el?.boundingBox ??
          el?.bbox ??
          el?.box ??
          el?.location?.boundingBox ??
          el?.layout?.boundingBox ??
          el?.layout?.bbox ??
          null,
        pageSizes[pageNo]
      );

      if (!content && !bbox) return; // nothing to show
      out.push({ content: content.trim(), page: pageNo, bbox });
    });
  });

  return { elements: out };
}

/* ----------------------------- Helpers (bbox) ----------------------------- */

function normalizeBBox(input, pageSize) {
  if (!input) return null;

  // Rect-like (x/y/width/height) or (left/top/right/bottom)
  const r = rectLike(input);
  if (r) return safeRect(r.x, r.y, r.width, r.height, pageSize);

  // LTRB-like x0/y0/x1/y1
  const ltrb = ltrbLike(input);
  if (ltrb) return safeRect(ltrb.x, ltrb.y, ltrb.width, ltrb.height, pageSize);

  // Polygon vertices / normalizedVertices
  const poly = verticesLike(input);
  if (poly) {
    const { x0, y0, x1, y1 } = boundsOf(poly);
    return safeRect(x0, y0, x1 - x0, y1 - y0, pageSize);
  }

  // Array [x0, y0, x1, y1]
  if (Array.isArray(input) && input.length >= 4) {
    const x0 = numberish(input[0]);
    const y0 = numberish(input[1]);
    const x1 = numberish(input[2]);
    const y1 = numberish(input[3]);
    if ([x0, y0, x1, y1].every(isFiniteNumber)) {
      return safeRect(x0, y0, x1 - x0, y1 - y0, pageSize);
    }
  }

  return null;
}

function rectLike(bb) {
  const x = numberish(bb?.x ?? bb?.left);
  const y = numberish(bb?.y ?? bb?.top);
  const w = numberish(bb?.width ?? bb?.w);
  const h = numberish(bb?.height ?? bb?.h);
  if ([x, y, w, h].every(isFiniteNumber)) return { x, y, width: w, height: h };
  return null;
}

function ltrbLike(bb) {
  const left = numberish(bb?.left ?? bb?.x0);
  const top = numberish(bb?.top ?? bb?.y0);
  const right = numberish(bb?.right ?? bb?.x1);
  const bottom = numberish(bb?.bottom ?? bb?.y1);
  if ([left, top, right, bottom].every(isFiniteNumber)) {
    return { x: left, y: top, width: right - left, height: bottom - top };
  }
  return null;
}

function verticesLike(bb) {
  const verts =
    asArray(bb?.vertices) ||
    asArray(bb?.normalizedVertices) ||
    asArray(bb?.normalized_vertices) ||
    null;
  if (!verts || !verts.length) return null;

  const pts = [];
  for (const v of verts) {
    const x = numberish(v?.x);
    const y = numberish(v?.y);
    if ([x, y].every(isFiniteNumber)) pts.push({ x, y });
  }
  return pts.length ? pts : null;
}

function boundsOf(pts) {
  let x0 = +Infinity,
    y0 = +Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const p of pts) {
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x);
    y1 = Math.max(y1, p.y);
  }
  return { x0, y0, x1, y1 };
}

function safeRect(x, y, w, h, pageSize) {
  // reject non-finite or absurd
  if (![x, y, w, h].every(isFinite)) return null;
  if (w <= 0 || h <= 0) return null;

  // treat 0..1 as normalized if pageSize is known
  const looksNorm =
    x >= 0 && x <= 1 && y >= 0 && y <= 1 && w > 0 && w <= 1 && h > 0 && h <= 1;

  if (looksNorm && pageSize && isFiniteNumber(pageSize.width) && isFiniteNumber(pageSize.height)) {
    return {
      x: x * pageSize.width,
      y: y * pageSize.height,
      width: w * pageSize.width,
      height: h * pageSize.height,
    };
  }
  return { x, y, width: w, height: h };
}

/* ------------------------------- Helpers ---------------------------------- */

function asArray(v) {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

function numberish(v) {
  if (v == null) return undefined;
  const n = typeof v === "string" ? Number(v) : v;
  return Number.isFinite(n) ? n : undefined;
}

function isFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}

function stringy(v) {
  if (v == null) return "";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function textFromTextAnchor(anchor, docText) {
  if (!anchor || !docText) return "";
  const segs = asArray(anchor.textSegments || anchor.segments);
  if (!segs.length) return "";
  const parts = [];
  for (const s of segs) {
    const start = numberish(s.startIndex ?? s.start) ?? 0;
    const end = numberish(s.endIndex ?? s.end) ?? start;
    if (end > start && start >= 0 && end <= docText.length) {
      parts.push(docText.slice(start, end));
    }
  }
  return parts.join("").trim();
}