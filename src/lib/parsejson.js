// src/lib/parsejson.js
// Tolerant JSON/JSON5 loader + Google DocAI shape extractor

// --- tiny tolerant parser (keeps JSON5-ish basics) ---
function stripCommentsAndTrailingCommas(txt) {
  // remove // and /* */ comments
  txt = txt.replace(/\/\/[^\n\r]*/g, "");
  txt = txt.replace(/\/\*[\s\S]*?\*\//g, "");
  // remove trailing commas in objects/arrays
  txt = txt.replace(/,\s*([}\]])/g, "$1");
  return txt.trim();
}

export function parseMaybeJSON5(blobOrText) {
  return new Promise(async (resolve, reject) => {
    try {
      const text =
        typeof blobOrText === "string"
          ? blobOrText
          : await blobOrText.text?.() || "";

      // first pass: raw JSON
      try {
        return resolve(JSON.parse(text));
      } catch (e) {
        /* fallthrough */
      }

      // second pass: tolerant
      try {
        const cleaned = stripCommentsAndTrailingCommas(text);
        return resolve(JSON.parse(cleaned));
      } catch (e2) {
        return reject(new Error("Unable to parse DocAI JSON (even tolerant)."));
      }
    } catch (e) {
      reject(e);
    }
  });
}

// ---------- DocAI extractor ----------
// We normalize two areas:
//   - header map: documents[0].properties.metaDataMap (or properties)
//   - page elements: documents[0].pages[].elements[] with content + boundingBox
export function parseDocAI(root) {
  if (!root || !root.documents || !root.documents.length) {
    return { header: [], elements: [] };
  }
  const doc = root.documents[0] || {};
  const props = (doc.properties && doc.properties[0]) || doc.properties || {};
  const meta =
    props.metaDataMap ||
    props.metadata ||
    props ||
    {};

  // header (KV table at the top-left)
  const headerKeys = Object.keys(meta || {});
  const header = headerKeys.map((k) => ({
    key: String(k),
    value: meta[k],
  }));

  // elements (left pane list)
  const pages = doc.pages || [];
  const elements = [];
  for (const pg of pages) {
    const pageNum = pg.page || pg.pageNumber || 1;
    const els = pg.elements || [];
    for (const el of els) {
      const content = (el.content || "").toString().trim();
      const bb = el.boundingBox || el.bbox || null;
      let bbox = null;
      if (bb && isFinite(bb.x) && isFinite(bb.y) && isFinite(bb.width) && isFinite(bb.height)) {
        // DocAI often gives absurd int bounds; we still pass them through for dashed “DocAI” box
        bbox = { x: Number(bb.x), y: Number(bb.y), width: Number(bb.width), height: Number(bb.height) };
      }
      if (content) {
        elements.push({ content, page: pageNum, bbox });
      }
    }
  }

  return { header, elements };
}