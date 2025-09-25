/* Tolerant DocAI parser
 * - Handles multiple schema shapes (documents[], document, pages at various paths)
 * - Extracts content from content/text or textAnchor (using global document.text)
 * - Normalizes bboxes from many formats (rect, LTRB, vertices/polygons, arrays)
 * - Detects normalized coords (0..1) and scales to page size when known
 * - Ignores sentinel/junk values; guards against NaN/Infinity
 */

export type DocAIFlatRow = {
  content: string;
  page: number;
  bbox?: { x: number; y: number; width: number; height: number } | null;
};

type AnyObj = Record<string, any>;

const JUNK_LIMIT = 1e9; // guard absurd sentinel coords

/* ---------------- Public API ---------------- */

export function parseDocAI(raw: AnyObj): { header: { key: string; value: any }[]; elements: DocAIFlatRow[] } {
  const header = extractHeader(raw);
  const { pages, pageSizes, docText } = extractPagesAndText(raw);

  const out: DocAIFlatRow[] = [];

  for (let i = 0; i < pages.length; i++) {
    const p = pages[i] || {};
    const pageNo = numberish(p.page ?? p.pageNumber) ?? i + 1;

    // Try the most structured buckets first
    const buckets: AnyObj[][] = [
      asArray(p.elements),
      asArray(p.paragraphs),
      asArray(p.blocks),
      asArray(p.layout?.paragraphs),
      asArray(p.tokens),
      asArray(p.words),
    ].filter((a) => a.length);

    // If no explicit elements, synthesize from detected text segments (rare)
    const candidates = buckets.length ? buckets.flat() : [p];

    for (const el of candidates) {
      const content =
        stringy(el.content) ??
        stringy(el.text) ??
        textFromTextAnchor(el.textAnchor, docText) ??
        ""; // empty allowed; you said show even keyless/key-empty

      const bbox = normalizeBBox(
        // accept many spellings/containers
        el.boundingBox ?? el.bbox ?? el.box ?? el.location?.boundingBox ?? el.layout?.boundingBox ?? null,
        pageSizes[pageNo] // may help scale normalized coords
      );

      if (!content && !bbox) continue; // nothing to render
      out.push({ content, page: pageNo, bbox });
    }
  }

  return { header, elements: out };
}

/* ---------------- Header extraction ---------------- */

function extractHeader(raw: AnyObj) {
  const header: { key: string; value: any }[] = [];
  const meta =
    pick(raw, ["documents", 0, "properties", "metadata"]) ??
    pick(raw, ["documents", 0, "properties", "metaDataMap"]) ??
    pick(raw, ["document", "properties", "metadata"]) ??
    pick(raw, ["document", "properties", "metaDataMap"]) ??
    pick(raw, ["properties", "metadata"]) ??
    pick(raw, ["metaDataMap"]) ??
    pick(raw, ["metadata"]) ??
    null;

  if (meta && typeof meta === "object") {
    for (const k of Object.keys(meta)) header.push({ key: k, value: meta[k] });
  }
  return header;
}

/* ---------------- Pages + global text ---------------- */

function extractPagesAndText(raw: AnyObj): {
  pages: AnyObj[];
  pageSizes: Record<number, { width: number; height: number } | undefined>;
  docText: string;
} {
  // Prefer Google DocAI doc.text if present
  const docNode = raw?.documents?.[0] ?? raw?.document ?? raw;
  const docText = stringy(docNode?.text) ?? stringy(raw?.text) ?? "";

  // Find pages
  const pages =
    asArray(docNode?.pages) ??
    asArray(raw?.pages) ??
    asArray(raw?.properties?.pages) ??
    [];

  // Capture page sizes if available (helps scale normalized bboxes)
  const pageSizes: Record<number, { width: number; height: number } | undefined> = {};
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i] || {};
    const pg = numberish(p.page ?? p.pageNumber) ?? i + 1;
    const w = numberish(p?.dimension?.width ?? p?.pageSize?.width ?? p?.width);
    const h = numberish(p?.dimension?.height ?? p?.pageSize?.height ?? p?.height);
    if (isFiniteNumber(w) && isFiniteNumber(h)) pageSizes[pg] = { width: w!, height: h! };
  }

  return { pages, pageSizes, docText };
}

/* ---------------- Text helpers ---------------- */

function textFromTextAnchor(anchor: any, docText: string): string | null {
  if (!anchor || !docText) return null;
  // Google DocAI often uses textAnchor.textSegments [{ startIndex, endIndex }]
  const segs = asArray(anchor.textSegments || anchor.segments);
  if (!segs.length) return null;
  try {
    const parts: string[] = [];
    for (const s of segs) {
      const start = numberish(s.startIndex ?? s.start) ?? 0;
      const end = numberish(s.endIndex ?? s.end) ?? start;
      if (end > start && start >= 0 && end <= docText.length) {
        parts.push(docText.slice(start, end));
      }
    }
    const joined = parts.join("").trim();
    return joined || null;
  } catch {
    return null;
  }
}

/* ---------------- BBox normalization ---------------- */

type PageSize = { width: number; height: number };

function normalizeBBox(input: any, pageSize?: PageSize | undefined) {
  if (!input) return null;

  // 1) Rect formats
  const rect = rectLike(input);
  if (rect) return safeRect(rect.x, rect.y, rect.width, rect.height, pageSize);

  // 2) LTRB formats
  const ltrb = ltrbLike(input);
  if (ltrb) return safeRect(ltrb.x, ltrb.y, ltrb.width, ltrb.height, pageSize);

  // 3) Vertex polygon formats (DocAI "vertices" or "normalizedVertices")
  const poly = verticesLike(input);
  if (poly) {
    const { x0, y0, x1, y1 } = boundsOf(poly);
    return safeRect(x0, y0, x1 - x0, y1 - y0, pageSize);
  }

  // 4) Fallback: array [x0,y0,x1,y1]
  if (Array.isArray(input) && input.length >= 4) {
    const x0 = numberish(input[0]);
    const y0 = numberish(input[1]);
    const x1 = numberish(input[2]);
    const y1 = numberish(input[3]);
    if (isFiniteNumber(x0) && isFiniteNumber(y0) && isFiniteNumber(x1) && isFiniteNumber(y1)) {
      return safeRect(x0!, y0!, x1! - x0!, y1! - y0!, pageSize);
    }
  }

  return null;
}

function rectLike(bb: any): { x: number; y: number; width: number; height: number } | null {
  const x = numberish(bb.x ?? bb.left);
  const y = numberish(bb.y ?? bb.top);
  const w = numberish(bb.width ?? bb.w);
  const h = numberish(bb.height ?? bb.h);
  if ([x, y, w, h].every(isFiniteNumber)) return { x: x!, y: y!, width: w!, height: h! };
  return null;
}

function ltrbLike(bb: any): { x: number; y: number; width: number; height: number } | null {
  const left = numberish(bb.left ?? bb.x0);
  const top = numberish(bb.top ?? bb.y0);
  const right = numberish(bb.right ?? bb.x1);
  const bottom = numberish(bb.bottom ?? bb.y1);
  if ([left, top, right, bottom].every(isFiniteNumber)) {
    return { x: left!, y: top!, width: right! - left!, height: bottom! - top! };
  }
  return null;
}

function verticesLike(bb: any): Array<{ x: number; y: number }> | null {
  const verts =
    asArray(bb.vertices) ||
    asArray(bb.normalizedVertices) ||
    asArray(bb.normalized_vertices) ||
    null;
  if (!verts || !verts.length) return null;

  const pts: Array<{ x: number; y: number }> = [];
  for (const v of verts) {
    const x = numberish(v.x);
    const y = numberish(v.y);
    if ([x, y].every(isFiniteNumber)) pts.push({ x: x!, y: y! });
  }
  return pts.length ? pts : null;
}

function boundsOf(pts: Array<{ x: number; y: number }>) {
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

function safeRect(x: number, y: number, w: number, h: number, pageSize?: PageSize) {
  // Reject non-finite or absurd values
  if (![x, y, w, h].every(isFinite)) return null;
  if ([x, y, w, h].some((v) => Math.abs(v) > JUNK_LIMIT)) return null;
  if (w <= 0 || h <= 0) return null;

  // If the values look normalized (0..1) and we know page size, scale them
  const looksNormalized =
    x >= 0 && x <= 1 && y >= 0 && y <= 1 && w > 0 && w <= 1 && h > 0 && h <= 1;

  if (looksNormalized && pageSize) {
    const X = x * pageSize.width;
    const Y = y * pageSize.height;
    const W = w * pageSize.width;
    const H = h * pageSize.height;
    return { x: X, y: Y, width: W, height: H };
  }
  return { x, y, width: w, height: h };
}

/* ---------------- Utilities ---------------- */

function asArray<T = any>(v: any): T[] {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

function pick(o: any, path: (string | number)[]): any {
  let cur = o;
  for (const k of path) {
    if (cur == null) return undefined;
    cur = cur[k as any];
  }
  return cur;
}

function numberish(v: any): number | undefined {
  if (v == null) return undefined;
  const n = typeof v === "string" ? Number(v) : v;
  return Number.isFinite(n) ? n : undefined;
}

function stringy(v: any): string | null {
  if (v == null) return null;
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return null;
  }
}

function isFiniteNumber(v: any): v is number {
  return typeof v === "number" && Number.isFinite(v);
}