export type DocHeader = Record<string, string | number | boolean | null>;
export type DocElement = {
  content: string;
  page: number;
  bbox?: { x: number; y: number; width: number; height: number } | null;
};

const first = <T>(x: T | T[] | undefined | null): T | undefined =>
  Array.isArray(x) ? x[0] : (x ?? undefined);

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

/** Deep scan for items with elementType + (content|text), tracking nearest page, optional bbox */
function deepCollectElements(
  node: any,
  out: DocElement[] = [],
  pageCtx = 1,
  depth = 0
): DocElement[] {
  if (node == null || depth > 16) return out;

  const arr = Array.isArray(node) ? node : [node];

  for (const item of arr) {
    if (item == null) continue;

    if (Array.isArray(item)) {
      deepCollectElements(item, out, pageCtx, depth + 1);
      continue;
    }
    if (typeof item !== "object") continue;

    // page context
    if (Object.prototype.hasOwnProperty.call(item, "page")) {
      const p = Number((item as any).page);
      if (Number.isFinite(p) && p > 0) pageCtx = p;
    }

    const hasEltType = typeof (item as any).elementType === "string";
    const hasContent = typeof (item as any).content === "string" || typeof (item as any).text === "string";

    if (hasEltType && hasContent) {
      const content = String((item as any).content ?? (item as any).text ?? "").trim();
      const bb = (item as any).boundingBox ?? (item as any).bbox ?? (item as any).bounding_box ?? null;
      let bbox: DocElement["bbox"] = null;

      if (bb && typeof bb === "object") {
        const x = Number(bb.x), y = Number(bb.y), w = Number(bb.width), h = Number(bb.height);
        if ([x, y, w, h].every(Number.isFinite)) bbox = { x, y, width: w, height: h };
      }

      out.push({
        content,
        page: Number.isFinite(Number((item as any).page)) && Number((item as any).page) > 0 ? Number((item as any).page) : pageCtx || 1,
        bbox,
      });
    }

    // common containers
    const kids = [
      (item as any).elements,
      (item as any).paragraphs,
      (item as any).blocks,
      (item as any).formFields,
      (item as any).items,
      (item as any).children,
      (item as any).sections,
      (item as any).pages,
      (item as any).content,
    ];
    for (const k of kids) deepCollectElements(k, out, pageCtx, depth + 1);

    // broad recurse
    for (const v of Object.values(item)) {
      if (v && typeof v === "object") deepCollectElements(v, out, pageCtx, depth + 1);
    }
  }

  return out;
}

export function parseDocAI(raw: any): { header: DocHeader; elements: DocElement[] } {
  const header = findHeader(raw);
  const elements = deepCollectElements(raw).filter(e => (e.content || "").trim().length > 0);

  if (elements.length === 0) {
    const root = first(raw?.document) ?? first(raw?.documents) ?? raw ?? {};
    console.warn("[DocAI] No elements found. Top-level keys:", Object.keys(root || {}));
  }

  return { header, elements };
}