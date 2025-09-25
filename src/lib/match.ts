export type Token = {
  page: number;
  x0: number; y0: number; x1: number; y1: number;
  text: string;
};

const ABBREV: Record<string, string> = {
  rd:"road","rd.":"road", ave:"avenue","ave.":"avenue", av:"avenue",
  st:"street","st.":"street", blvd:"boulevard","blvd.":"boulevard",
  dr:"drive","dr.":"drive", ln:"lane","ln.":"lane", hwy:"highway","hwy.":"highway",
  ct:"court","ct.":"court",
};

const norm = (s: string) =>
  (s || "").toLowerCase().normalize("NFKC").replace(/[\u00a0]/g," ")
    .replace(/[^\p{L}\p{N}\s]/gu," ").replace(/\s+/g," ").trim();

const normNum = (s: string) =>
  (s || "").toLowerCase().normalize("NFKC").replace(/[,$]/g,"")
    .replace(/\s+/g," ").trim();

function levRatio(a: string, b: string) {
  const m=a.length, n=b.length;
  if (!m && !n) return 1;
  const dp = new Array(n+1).fill(0).map((_,j)=>j);
  for (let i=1;i<=m;i++){
    let prev=dp[0]; dp[0]=i;
    for (let j=1;j<=n;j++){
      const tmp=dp[j];
      dp[j]=Math.min(dp[j]+1, dp[j-1]+1, prev+(a[i-1]===b[j-1]?0:1));
      prev=tmp;
    }
  }
  return 1 - dp[n]/Math.max(1, Math.max(m,n));
}

function unionRect(span: Token[]) {
  let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity;
  for (const t of span){ x0=Math.min(x0,t.x0); y0=Math.min(y0,t.y0); x1=Math.max(x1,t.x1); y1=Math.max(y1,t.y1); }
  return { x0: Math.floor(x0), y0: Math.floor(y0), x1: Math.ceil(x1), y1: Math.ceil(y1) };
}
function linePenalty(span: Token[]) {
  if (span.length<=1) return 0;
  const ys = span.map(t=>(t.y0+t.y1)/2).sort((a,b)=>a-b);
  const spread = ys[ys.length-1]-ys[0];
  const hs = span.map(t=>t.y1-t.y0);
  const avg = hs.reduce((a,b)=>a+b,0)/Math.max(1,hs.length);
  return Math.max(0, spread - avg*0.6) / Math.max(1, avg);
}

export function locateBestSpan(all: Token[], targetRaw: string, maxWindow=16) {
  const raw = (targetRaw||"").trim();
  if (!raw) return null;

  const looksNumeric = /^[\s\-$€£₹,.\d/]+$/.test(raw);
  const words = looksNumeric ? [normNum(raw)] : norm(raw).split(" ").map(w=>ABBREV[w] ?? w);

  const byPage = new Map<number, Token[]>();
  for (const t of all) (byPage.get(t.page) ?? byPage.set(t.page, []).get(t.page)!).push(t);
  byPage.forEach(a=>a.sort((a,b)=> (a.y0===b.y0? a.x0-b.x0 : a.y0-b.y0)));

  function scoreSpan(span: Token[]) {
    const txt = span.map(t=>t.text||"").join(" ").toLowerCase().normalize("NFKC").replace(/[^\p{L}\p{N}\s]/gu," ");
    const spanWords = txt.split(/\s+/).filter(Boolean).map(w=>ABBREV[w] ?? w);

    if (looksNumeric) {
      return levRatio(spanWords.join(" "), words.join(" ")) - Math.min(0.25, linePenalty(span)*0.12);
    }
    let covered=0, j=0;
    for (let i=0;i<words.length && j<spanWords.length;){
      if (words[i]===spanWords[j] || levRatio(words[i], spanWords[j])>=0.8){ covered++; i++; j++; }
      else j++;
    }
    const coverage = covered/Math.max(1, words.length);
    const fuzz = levRatio(spanWords.join(" "), words.join(" "));
    return coverage*0.75 + fuzz*0.35 - Math.min(0.25, linePenalty(span)*0.12);
  }

  let best: {score:number;page:number;span:Token[]} | null = null;
  byPage.forEach((toks, pg) => {
    const n = toks.length;
    for (let i=0;i<n;i++){
      const span: Token[] = [];
      for (let w=0; w<maxWindow && i+w<n; w++){
        const tok = toks[i+w];
        if (!tok.text?.trim()) continue;
        span.push(tok);

        if (span.length===1 && !looksNumeric){
          const first = words[0];
          const tokenN = (tok.text||"").toLowerCase().replace(/[^\p{L}\p{N}\s]/gu,"");
          if (levRatio(first, tokenN) < 0.6) continue;
        }

        const s = scoreSpan(span);
        if (!best || s > best.score) best = { score: s, page: pg, span: [...span] };
      }
    }
  });
  if (!best) return null;
  return { page: best.page, rect: unionRect(best.span), score: best.score };
}