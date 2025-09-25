// Very small fuzzy matcher over OCR tokens (TokenBox[])
export function normalize(s) {
  return (s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function findBestWindow(tokens, query, opts = {}) {
  const q = normalize(query);
  if (!q) return null;

  const preferredPages = opts.preferredPages || [];
  const qWords = q.split(/\s+/);
  const maxWindow = Math.max(opts.maxWindow || 8, qWords.length);

  let best = null;

  // group tokens by page
  const byPage = tokens.reduce((m,t)=>{ (m[t.page] ||= []).push(t); return m; }, {});
  for (const pg of Object.keys(byPage).map(n=>+n).sort((a,b)=>a-b)) {
    const pageTokens = byPage[pg];
    // precompute normalized
    const norm = pageTokens.map(t => normalize(t.text));

    for (let i=0; i<pageTokens.length; i++) {
      let buf = "", boxes = [];
      for (let w=0; w<maxWindow && (i+w)<pageTokens.length; w++) {
        buf += (w? " ":"") + norm[i+w];
        boxes.push(pageTokens[i+w]);
        // quick filter: require all numbers in q to appear in buf
        const nums = q.match(/\d[\d,.\-]*/g) || [];
        const numsOk = nums.every(n => buf.includes(n.replace(/[^0-9]/g,"")));
        if (!numsOk) continue;

        const score = jaccard(q.split(" "), buf.split(" ")) + (preferredPages.includes(pg)? 0.05:0);
        if (!best || score > best.score) {
          best = { page: pg, score, rect: union(boxes) };
        }
      }
    }
  }
  return best && best.score >= 0.35 ? best : null;
}

function jaccard(a, b) {
  const A = new Set(a), B = new Set(b);
  const inter = [...A].filter(x=>B.has(x)).length;
  const unionSz = new Set([...a, ...b]).size || 1;
  return inter / unionSz;
}

function union(boxes) {
  const x0 = Math.min(...boxes.map(b=>b.x0));
  const y0 = Math.min(...boxes.map(b=>b.y0));
  const x1 = Math.max(...boxes.map(b=>b.x1));
  const y1 = Math.max(...boxes.map(b=>b.y1));
  return { x0, y0, x1, y1 };
}