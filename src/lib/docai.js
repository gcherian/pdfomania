export type DocHeader = Record<string, string | number | boolean | null>;
export type DocElement = {
  content: string;
  page: number;
  bbox?: { x: number; y: number; width: number; height: number } | null;
};

/** ---- helpers ---- */
const first = <T>(x: T | T[] | undefined | null): T | undefined =>
  Array.isArray(x) ? x[0] : x ?? undefined;

function looksLikeMetaMap(o: any) {
  if (!o || typeof o !== "object" || Array.isArray(o)) return false;
  const ents = Object.entries(o);
  if (!ents.length) return false;
  let scalars = 0;
  for (const [, v] of ents) {
    if (["string", "number", "boolean"].includes(typeof v)) scalars++;
  }
  return scalars >= Math.floor(ents.length * 0.5);
}

/** Find a header-like object in common DocAI shapes */
function findHeader(node: any): DocHeader {
  const root = first(node?.document) ?? first(node?.documents) ?? node ?? {};
  const props0 = first(root?.properties) ?? first(first(root?.documents)?.properties);
  let header =
    props0?.metaDataMap ??
    props0?.metadata ??
    props0?.metadataMap ??
    (looksLikeMetaMap(props0) ? props0 : null);

  if (!header && looksLikeMetaMap(root?.metadata)) header = root.metadata;
  if (!header && looksLikeMetaMap(root?.metaDataMap)) header = root.metaDataMap;

  return (header as DocHeader) || {};
}

/** Deep scan anywhere for elements containing elementType + (content|text) + optional bbox */
function deepCollectElements(
  node: any,
  out: DocElement[] = [],
  pageCtx = 1,
  depth = 0
): DocElement[] {
  if (node == null || depth > 14) return out;

  // Normalize to iterate
  const arr = Array.isArray(node) ? node : [node];

  for (const item of arr) {
    if (item == null) continue;

    if (Array.isArray(item)) {
      deepCollectElements(item, out, pageCtx, depth + 1);
      continue;
    }
    if (typeof item !== "object") continue;

    // track nearest page context if any
    if (Object.prototype.hasOwnProperty.call(item, "page")) {
      const p = Number(item.page);
      if (Number.isFinite(p) && p > 0) pageCtx = p;
    }

    // if this node looks like an "element"
    const hasEltType = typeof item.elementType === "string";
    const hasContent = typeof item.content === "string" || typeof item.text === "string";

    if (hasEltType && hasContent) {
      const content = String(item.content ?? item.text ?? "").trim();
      const bb = item.boundingBox ?? item.bbox ?? item.bounding_box ?? null;
      let bbox: DocElement["bbox"] = null;

      if (bb && typeof bb === "object") {
        const x = Number(bb.x), y = Number(bb.y), w = Number(bb.width), h = Number(bb.height);
        if ([x, y, w, h].every(Number.isFinite)) bbox = { x, y, width: w, height: h };
      }

      out.push({
        content,
        page: Number.isFinite(Number(item.page)) && Number(item.page) > 0 ? Number(item.page) : pageCtx || 1,
        bbox,
      });
    }

    // common containers we’ve seen in variants
    const kids = [
      item.elements,
      item.paragraphs,
      item.blocks,
      item.formFields,
      item.items,
      item.children,
      item.sections,
      item.pages,
      item.content, // sometimes nested objects/arrays live here
    ];
    for (const k of kids) deepCollectElements(k, out, pageCtx, depth + 1);

    // broad recurse through all object fields
    for (const v of Object.values(item)) {
      if (v && typeof v === "object") deepCollectElements(v, out, pageCtx, depth + 1);
    }
  }

  return out;
}

export function parseDocAI(raw: any): { header: DocHeader; elements: DocElement[] } {
  const header = findHeader(raw);
  const elements = deepCollectElements(raw);

  // Final clean: drop empties/whitespace-only
  const cleaned = elements.filter(e => (e.content || "").trim().length > 0);

  // Diagnostics if nothing found
  if (cleaned.length === 0) {
    const root = first(raw?.document) ?? first(raw?.documents) ?? raw ?? {};
    // eslint-disable-next-line no-console
    console.warn(
      "[DocAI] No elements found via deep scan. Top-level keys:",
      Object.keys(root || {})
    );
  }

  return { header, elements: cleaned };
}