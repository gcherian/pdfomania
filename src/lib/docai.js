// Tolerant parser for the structure you shared in screenshots.
export function parseDocAI(raw) {
  const header = [];
  const elements = [];

  const doc = raw?.documents?.[0] || raw?.document || raw;
  const props = doc?.properties || {};
  const meta = props.metaDataMap || props.metadata || props.metaData || {};
  const pages = doc?.pages || props?.pages || raw?.pages || [];

  // header rows
  for (const k of Object.keys(meta)) {
    header.push({ key: k, value: meta[k] });
  }

  // page elements (paragraphs with bbox) — your shape: pages[].elements[] with
  // { elementType: "paragraph", content: "...", boundingBox:{x,y,width,height}, page: 1 }
  for (let pIdx=0; pIdx<pages.length; pIdx++) {
    const p = pages[pIdx];
    const arr = p?.elements || p?.paragraphs || [];
    for (const it of arr) {
      const bb = it.boundingBox || it.bbox || it.bounding_box || null;
      elements.push({
        page: it.page ?? p.page ?? (pIdx+1),
        content: it.content ?? it.text ?? "",
        bbox: bb ? {
          x: +bb.x ?? +bb.left ?? 0,
          y: +bb.y ?? +bb.top ?? 0,
          width: +bb.width ?? +bb.w ?? 0,
          height: +bb.height ?? +bb.h ?? 0
        } : null
      });
    }
  }

  return { header, elements };
}
