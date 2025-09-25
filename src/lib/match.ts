// a compact matcher: given value and a list of tokens (with page,x0,y0,x1,y1,text)
// returns best {page, rect:{x0,y0,x1,y1}, score} or null

function norm(s) {
  return (s || "").toLowerCase().normalize("NFKC").replace(/[\u00A0]/g, " ").replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
}

function levRatio(a, b) {
  const m = a.length, n = b.length;
  if (!m && !n) return 1;
  const dp = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return 1 - dp[n] / Math.max(1, Math.max(m, n));
}

function unionRect(span) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const t of span) {
    x0 = Math.min(x0, t.x0);
    y0 = Math.min(y0, t.y0);
    x1 = Math.max(x1, t.x1);
    y1 = Math.max(y1, t.y1);
  }
  return { x0: Math.floor(x0), y0: Math.floor(y0), x1: Math.ceil(x1), y1: Math.ceil(y1) };
}

export function locateValue(valueRaw, allTokens, maxWindow = 20) {
  const raw = (valueRaw || "").trim();
  if (!raw) return null;
  const looksNumeric = /^[\s\-,$€£₹.\d/]+$/.test(raw);
  const words = looksNumeric ? [raw.replace(/[,\s]/g, "")] : norm(raw).split(" ").filter(Boolean);

  const byPage = new Map();
  for (const t of allTokens) {
    if (!byPage.has(t.page)) byPage.set(t.page, []);
    byPage.get(t.page).push(t);
  }
  byPage.forEach(arr => arr.sort((a,b)=> (a.y0 === b.y0 ? a.x0 - b.x0 : a.y0 - b.y0)));

  let best = null;
  byPage.forEach((toks, pg) => {
    const n = toks.length;
    for (let i=0;i<n;i++){
      const span = [];
      for (let w=0; w<maxWindow && i + w < n; w++){
        const tok = toks[i + w];
        const tokenText = (tok.text || "").trim();
        if (!tokenText) continue;
        span.push({ ...tok, text: tokenText });
        // score
        const txt = span.map(x => x.text).join(" ");
        const s = looksNumeric ? levRatio(txt.replace(/[,\s]/g,""), words.join("")) : levRatio(norm(txt), words.join(" "));
        // small penalty for multi-line
        const ys = span.map(s => (s.y0 + s.y1)/2).sort((a,b)=>a-b);
        const spread = ys[ys.length - 1] - ys[0] || 0;
        const hs = span.map(s => s.y1 - s.y0);
        const avg = hs.reduce((a,b)=>a+b,0)/Math.max(1,hs.length);
        const penalty = Math.max(0, spread - avg*0.6)/Math.max(1,avg);
        const score = s - Math.min(0.25, penalty * 0.12);
        if (!best || score > best.score) best = { score, page: pg, rect: unionRect(span) };
      }
    }
  });

  if (!best || best.score < 0.55) return null;
  return best;
}