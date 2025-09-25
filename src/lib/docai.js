export function parseDocAI(raw) {
  const header = [];
  const safe = (o, p) => {
    try {
      return p.reduce((cur, k) => (cur ? cur[k] : undefined), o);
    } catch {
      return undefined;
    }
  };

  const meta = safe(raw, ["documents", 0, "properties", "metadata"]) ||
               safe(raw, ["documents", 0, "properties", "metaDataMap"]) ||
               safe(raw, ["properties", "metadata"]) ||
               safe(raw, ["metadata"]) ||
               {};
  if (meta && typeof meta === "object") {
    for (const k of Object.keys(meta)) header.push({ key: k, value: meta[k] });
  }

  const rows = [];
  const pages = safe(raw, ["documents", 0, "pages"]) || raw.pages || [];
  for (let i = 0; i < (pages || []).length; i++) {
    const p = pages[i];
    const pageNo = Number(p?.page ?? p?.pageNumber ?? i + 1) || i + 1;
    const elems = p?.elements || p?.paragraphs || [];
    for (const el of elems) {
      const content = String(el?.content ?? el?.text ?? "").trim();
      const bb = el?.boundingBox ?? el?.bbox ?? el?.box ?? null;
      const bbox = normalizeBBox(bb);
      if (content) rows.push({ content, page: pageNo, bbox });
    }
  }
  return { header, elements: rows };
}

function normalizeBBox(bb) {
  if (!bb) return null;
  const x = Number(bb.x ?? bb.left ?? bb[0]);
  const y = Number(bb.y ?? bb.top ?? bb[1]);
  const width = Number(bb.width ?? bb.w ?? bb[2]);
  const height = Number(bb.height ?? bb.h ?? bb[3]);
  if (![x, y, width, height].every(isFinite)) return null;
  // guard sentinel values like 2147483647
  if (Math.abs(x) > 1e6 || Math.abs(y) > 1e6) return null;
  return { x, y, width, height };
}