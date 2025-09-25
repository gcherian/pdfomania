// src/lib/parsejson.js

// --- tolerant JSON parser (keeps it small, no JSON5 dep) ---
export function parseMaybeJSON5(text) {
  if (!text) return null;

  // 1) try strict JSON first
  try {
    return JSON.parse(text);
  } catch (_) {}

  // 2) quick tolerance: strip comments, trailing commas
  let s = text;

  // remove // line comments
  s = s.replace(/\/\/[^\n\r]*/g, "");
  // remove /* block comments */
  s = s.replace(/\/\*[\s\S]*?\*\//g, "");
  // remove trailing commas in objects/arrays
  s = s.replace(/,\s*([}\]])/g, "$1");

  // unquote simple keys: {foo: "bar"} -> {"foo":"bar"}
  s = s.replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*:\s*)/g, '$1"$2"$3');

  try {
    return JSON.parse(s);
  } catch (e) {
    console.error("[parseMaybeJSON5] still invalid JSON", e);
    return null;
  }
}

/**
 * Normalizes your DocAI JSON into:
 * {
 *   header: { ...metadataMap fields... },
 *   elements: [{ content, page, bbox? }]
 * }
 *
 * We accept either:
 * - { documents:[{ properties:{ metaDataMap:{...} }, pages:[{elements:[...]}] }]}
 * - or variants where properties/metaDataMap casing differs.
 */
export function parseDocAI(root) {
  if (!root) return { header: {}, elements: [] };

  // pull the first "document"
  const doc =
    (root.documents && root.documents[0]) ||
    root.document ||
    root;

  // header / meta
  const props = (doc.properties) || {};
  const header =
    props.metaDataMap ||
    props.metadataMap ||
    props.metadata ||
    props ||
    {};

  // elements (flatten all pages)
  const pages = Array.isArray(doc.pages) ? doc.pages : [];
  const out = [];

  for (const p of pages) {
    const pageNum =
      p.pageNumber ||
      p.page ||
      pages.indexOf(p) + 1;

    const els = Array.isArray(p.elements) ? p.elements : [];
    for (const el of els) {
      const content = String(el.content ?? el.text ?? "").trim();
      // bbox can be missing or bogus sentinel values; filter those out
      let bbox = null;
      const b = el.boundingBox || el.bbox || null;
      if (b && isFinite(b.x) && isFinite(b.y) && isFinite(b.width) && isFinite(b.height)) {
        // reject insane sentinel values (e.g., 2147483647)
        const big = 1e6;
        if (Math.abs(b.x) < big && Math.abs(b.y) < big && Math.abs(b.width) < big && Math.abs(b.height) < big) {
          bbox = { x: b.x, y: b.y, width: b.width, height: b.height };
        }
      }
      if (content) out.push({ content, page: pageNum, bbox });
    }
  }

  return { header, elements: out };
}