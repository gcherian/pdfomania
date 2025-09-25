// Lightweight, context-aware value locator for PDF tokens.
// Works with tokens from pdf.js textContent (page, x0,y0,x1,y1,text).
// Disambiguates identical values (e.g., ZIPs) via nearby context vs. key tags.

export type TokenBox = {
  page: number;
  x0: number; y0: number; x1: number; y1: number;
  text?: string;
};

export type MatchOptions = {
  /** Maximum number of tokens in a candidate span */
  maxWindow?: number; // default 16
  /** Radius (in px) around a candidate to gather context tokens */
  contextRadiusPx?: number; // default 140
  /** If provided, prefer matches on these pages (but not forced) */
  preferredPages?: number[];
  /** If the value is known to be numeric (invoice no., amount, zip), set true */
  numericHint?: boolean;
};

export type MatchResult = {
  page: number;
  rect: { x0: number; y0: number; x1: number; y1: number };
  score: number;
  reason?: string;
  // Top k alternatives for debugging/telemetry
  alternatives?: Array<{
    page: number;
    rect: { x0: number; y0: number; x1: number; y1: number };
    score: number;
    breakdown: ScoreBreakdown;
  }>;
};

type ScoreBreakdown = {
  text: number;
  ctx: number;
  addr: number;
  linePenalty: number; // negative
  pageBias: number;
};

const ABBREV: Record<string, string> = {
  rd: "road", "rd.": "road",
  ave: "avenue", "ave.": "avenue", av: "avenue",
  st: "street", "st.": "street",
  blvd: "boulevard", "blvd.": "boulevard",
  dr: "drive", "dr.": "drive",
  ln: "lane", "ln.": "lane",
  hwy: "highway", "hwy.": "highway",
  ct: "court", "ct.": "court",
  ste: "suite", "ste.": "suite",
  apt: "apartment", "apt.": "apartment",
  fl: "floor", "fl.": "floor",
  po: "po", "p.o.": "po",
};

const CONTEXT_SYNONYMS: Record<string, string[]> = {
  billing: ["bill", "billing", "billed", "invoice to", "invoice", "sold to", "bill-to", "billed to", "remit to", "payer"],
  shipping: ["ship", "shipping", "deliver", "delivery", "consignee", "ship-to", "ship to", "recipient"],
  address: ["address", "addr", "street", "st", "road", "rd", "avenue", "ave", "boulevard", "blvd", "lane", "ln", "drive", "dr", "court", "ct", "suite", "ste", "apartment", "apt", "unit"],
  zip: ["zip", "postal", "postcode", "pin"],
  city: ["city", "town"],
  state: ["state", "province", "region"],
  account: ["account", "acct", "acc", "customer", "cust", "client"],
};

const KEY_HINT_MAP: Array<{ tag: string; needles: RegExp[] }> = [
  { tag: "billing",  needles: [/bill/i, /billing/i, /sold.?to/i, /invoice.?to/i, /remit/i, /payer/i] },
  { tag: "shipping", needles: [/ship/i, /shipping/i, /deliver/i, /consign/i, /recipient/i] },
  { tag: "zip",      needles: [/zip/i, /postal/i, /postcode/i, /\bpin\b/i] },
  { tag: "address",  needles: [/addr/i, /address/i, /street|st\./i, /road|rd\./i, /avenue|ave\.?/i, /boulevard|blvd\.?/i, /suite|ste\.?/i, /apartment|apt\.?/i, /unit/i] },
  { tag: "city",     needles: [/city|town/i] },
  { tag: "state",    needles: [/state|province|region/i] },
  { tag: "account",  needles: [/account|acct|acc|customer|cust|client/i] },
];

// ---------- Normalization helpers ----------

function normWords(s: string): string[] {
  const clean = (s || "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[\u00A0]/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return [];
  return clean.split(" ").map(w => ABBREV[w] ?? w);
}

function normNumeric(s: string): string {
  return (s || "").normalize("NFKC").replace(/[^\d]/g, "");
}

function levRatio(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (!m && !n) return 1;
  const dp: number[] = new Array(n + 1);
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

function unionRect(span: TokenBox[]) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const t of span) {
    x0 = Math.min(x0, t.x0); y0 = Math.min(y0, t.y0);
    x1 = Math.max(x1, t.x1); y1 = Math.max(y1, t.y1);
  }
  return { x0: Math.floor(x0), y0: Math.floor(y0), x1: Math.ceil(x1), y1: Math.ceil(y1) };
}

function linePenalty(span: TokenBox[]) {
  if (span.length <= 1) return 0;
  const ys = span.map(t => (t.y0 + t.y1)/2).sort((a,b)=>a-b);
  const spread = ys[ys.length - 1] - ys[0];
  const hs = span.map(t => t.y1 - t.y0);
  const avg = hs.reduce((a,b)=>a+b,0)/Math.max(1,hs.length);
  return Math.max(0, spread - avg * 0.6) / Math.max(1, avg); // 0..(~)
}

// ---------- Key → context hints ----------

function keyHints(key: string): Set<string> {
  const out = new Set<string>();
  for (const { tag, needles } of KEY_HINT_MAP) {
    if (needles.some(r => r.test(key))) out.add(tag);
  }
  // allow dotted keys like "customer.billto.zip"
  const parts = key.split(/[.\[\]_ -]+/);
  for (const p of parts) {
    KEY_HINT_MAP.forEach(({ tag, needles }) => {
      if (needles.some(r => r.test(p))) out.add(tag);
    });
    // extra: explicit bill/ship words in key segments
    if (/\bbill(to)?\b/i.test(p)) out.add("billing");
    if (/\bship(to)?\b/i.test(p)) out.add("shipping");
  }
  return out;
}

function contextTokensNearby(all: TokenBox[], center: TokenBox[], radiusPx: number): string[] {
  if (!center.length) return [];
  // compute bounding rect and expand by radius
  const R = unionRect(center as any);
  const cx0 = R.x0 - radiusPx, cy0 = R.y0 - radiusPx, cx1 = R.x1 + radiusPx, cy1 = R.y1 + radiusPx;
  const hits: string[] = [];
  for (const t of all) {
    const midx = (t.x0 + t.x1) / 2, midy = (t.y0 + t.y1) / 2;
    if (midx >= cx0 && midx <= cx1 && midy >= cy0 && midy <= cy1) {
      const words = normWords(t.text || "");
      hits.push(...words);
    }
  }
  return hits;
}

function contextScore(hints: Set<string>, ctxWords: string[]): number {
  if (!hints.size || !ctxWords.length) return 0;
  const ctx = new Set(ctxWords);
  let hits = 0, wants = 0;

  for (const tag of hints) {
    const syns = CONTEXT_SYNONYMS[tag] || [];
    // any synonym presence counts for the tag
    const got = syns.some(s => {
      const w = normWords(s);
      // treat phrase synonyms — every token must be present (simple AND)
      return w.every(x => ctx.has(x));
    });
    wants += 1;
    if (got) hits += 1;
  }
  if (!wants) return 0;
  return hits / wants; // 0..1
}

function addressShapeBonus(ctxWords: string[], looksNumeric: boolean, raw: string): number {
  // Encourage matches near addressy words when value is address-like or zip-like
  const ctx = new Set(ctxWords);
  const hasAddr = CONTEXT_SYNONYMS.address.some(s => normWords(s).every(x => ctx.has(x)));
  const isZip = looksNumeric && /^\d{5}(-\d{4})?$/.test(raw.replace(/[^\d-]/g, ""));
  const isMoney = looksNumeric && /[\d][\d,]*(\.\d{2})?$/.test(raw);
  if (isZip && hasAddr) return 0.15;
  if (!isZip && !isMoney && hasAddr) return 0.08;
  return 0;
}

function preferredPageBias(page: number, preferred?: number[]): number {
  if (!preferred || !preferred.length) return 0;
  return preferred.includes(page) ? 0.05 : 0;
}

// ---------- Main matching ----------

export function matchField(
  key: string,
  valueRaw: string,
  tokens: TokenBox[],
  opts: MatchOptions = {}
): MatchResult | null {
  const maxWindow = opts.maxWindow ?? 16;
  const radius = opts.contextRadiusPx ?? 140;
  const looksNumeric = opts.numericHint ?? /^[\s\-,$€£₹.\d/]+$/.test(valueRaw || "");

  const target = looksNumeric ? normNumeric(valueRaw) : normWords(valueRaw).join(" ");
  if (!target) return null;

  // Group tokens by page and sort in reading order
  const byPage = new Map<number, TokenBox[]>();
  for (const t of tokens) {
    (byPage.get(t.page) || byPage.set(t.page, []).get(t.page)!).push(t);
  }
  byPage.forEach(arr => arr.sort((a,b) => (a.y0 === b.y0 ? a.x0 - b.x0 : a.y0 - b.y0)));

  const hints = keyHints(key);
  let best: { score: number; page: number; span: TokenBox[]; breakdown: ScoreBreakdown } | null = null;
  const alts: MatchResult["alternatives"] = [];

  byPage.forEach((toks, pg) => {
    const n = toks.length;
    for (let i = 0; i < n; i++) {
      const span: TokenBox[] = [];
      for (let w = 0; w < maxWindow && i + w < n; w++) {
        const t = toks[i + w];
        const token = (t.text || "").trim();
        if (!token) continue;
        span.push(t);

        // crude early pruning for non-numeric: first token should be similar to first word
        if (span.length === 1 && !looksNumeric) {
          const firstWord = target.split(" ")[0] || "";
          const tokenN = normWords(token)[0] || "";
          if (levRatio(firstWord, tokenN) < 0.6) continue;
        }

        // --- Text score ---
        const spanTxt = span.map(x => String(x.text || "")).join(" ");
        const spanN = looksNumeric ? normNumeric(spanTxt) : normWords(spanTxt).join(" ");
        const sText = levRatio(spanN, target); // 0..1

        // --- Context score ---
        const ctxWords = contextTokensNearby(toks, span, radius);
        const sCtx = contextScore(hints, ctxWords); // 0..1

        // --- Address shape bonus ---
        const sAddr = addressShapeBonus(ctxWords, looksNumeric, valueRaw); // 0..0.15

        // --- Line penalty (prefer single-line spans) ---
        const pen = Math.min(0.25, linePenalty(span) * 0.12); // 0..0.25

        // --- Page bias (tiny nudge) ---
        const sPage = preferredPageBias(pg, opts.preferredPages);

        // weight blend
        const score =
          sText * 0.72 +
          sCtx * 0.20 +
          sAddr * 0.08 +
          sPage * 1.0 - // already tiny (0 or 0.05)
          pen;

        const breakdown: ScoreBreakdown = { text: sText, ctx: sCtx, addr: sAddr, linePenalty: -pen, pageBias: sPage };

        if (!best || score > best.score) {
          best = { score, page: pg, span: [...span], breakdown };
        }

        // collect alt candidates (top few)
        pushAlt(alts, {
          page: pg,
          rect: unionRect(span),
          score,
          breakdown
        });
      }
    }
  });

  if (!best) return null;

  // Final result
  const rect = unionRect(best.span);
  // Sort alternates and keep top 5 (excluding the chosen rect pointer)
  alts.sort((a, b) => b.score - a.score);
  const top5 = alts.slice(0, 5);

  return {
    page: best.page,
    rect,
    score: best.score,
    reason: explain(best.breakdown),
    alternatives: top5
  };
}

function pushAlt(arr: NonNullable<MatchResult["alternatives"]>, item: NonNullable<MatchResult["alternatives"]>[number]) {
  // keep a bounded list without duplicates (rough dedupe by rect area and page)
  const area = (r: {x0:number;y0:number;x1:number;y1:number}) => Math.max(1,(r.x1-r.x0)*(r.y1-r.y0));
  for (const a of arr) {
    if (a.page === item.page) {
      const aArea = area(a.rect), iArea = area(item.rect);
      const overlap = intersectArea(a.rect, item.rect);
      // if largely overlapping, keep the higher-scoring one
      if (overlap / Math.min(aArea, iArea) > 0.7) {
        if (item.score > a.score) Object.assign(a, item);
        return;
      }
    }
  }
  arr.push(item);
}
function intersectArea(r1: any, r2: any) {
  const x0 = Math.max(Math.min(r1.x0, r1.x1), Math.min(r2.x0, r2.x1));
  const y0 = Math.max(Math.min(r1.y0, r1.y1), Math.min(r2.y0, r2.y1));
  const x1 = Math.min(Math.max(r1.x0, r1.x1), Math.max(r2.x0, r2.x1));
  const y1 = Math.min(Math.max(r1.y0, r1.y1), Math.max(r2.y0, r2.y1));
  const w = Math.max(0, x1 - x0), h = Math.max(0, y1 - y0);
  return w * h;
}

function explain(b: ScoreBreakdown) {
  const parts: string[] = [];
  parts.push(`text:${fmt(b.text)}`);
  if (b.ctx) parts.push(`ctx:${fmt(b.ctx)}`);
  if (b.addr) parts.push(`addr:+${fmt(b.addr)}`);
  if (b.pageBias) parts.push(`page:+${fmt(b.pageBias)}`);
  if (b.linePenalty) parts.push(`line:${fmt(b.linePenalty)}`);
  return parts.join(" ");
}
function fmt(n: number) { return (Math.round(n*100)/100).toFixed(2); }

// ---------- Convenience: locate by value only (no key) ----------

export function locateByValue(valueRaw: string, tokens: TokenBox[], opts?: MatchOptions): MatchResult | null {
  return matchField("", valueRaw, tokens, opts);
}