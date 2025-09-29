// src/lib/predictors.js
// Minimal model registry for matching spans: fuzzy, tfidf, embeddings (server).

import { locateByValue, matchField } from "./match.js";

// --- simple TF-IDF over a local “document” that is the span vs. target ---
function tfidfScore(spanText, target) {
  // bag of words; cosine over term weights
  const tok = s => (s||"").toLowerCase().normalize("NFKC").replace(/[^\p{L}\p{N}\s]/gu," ").split(/\s+/).filter(Boolean);
  const a = tok(spanText), b = tok(target);
  if (!a.length || !b.length) return 0;
  const set = new Set([...a, ...b]);
  // corpus of 2 docs -> idf ~ log(2/(df)) ∈ {log2,0}
  const tf = (arr) => {
    const m = new Map(); arr.forEach(w=>m.set(w,(m.get(w)||0)+1));
    return m;
  };
  const ta = tf(a), tb = tf(b);
  let dot=0, na=0, nb=0;
  for (const w of set) {
    const idf = (b.includes(w) && a.includes(w)) ? Math.log(2/2) : Math.log(2/1); // 0 or ln2
    const wa = (ta.get(w)||0) * idf;
    const wb = (tb.get(w)||0) * idf;
    dot += wa*wb; na += wa*wa; nb += wb*wb;
  }
  return dot / Math.max(1e-6, Math.sqrt(na)*Math.sqrt(nb));
}

// --- fuzzy (Levenshtein ratio already inside match.ts) ---
function fuzzy(tokens, key, value, opts) {
  // use your key-aware scorer first, then value-only fallback (unchanged)
  return matchField(key||"", value||"", tokens, opts) || locateByValue(value||"", tokens, opts);
}

// --- tfidf model: reuse your sliding-window search but replace text score weight ---
export function predictBest_tfidf(tokens, value, opts) {
  // cheap wrapper: call value-only locate, but boost spans by tfidf similarity
  const res = locateByValue(value||"", tokens, { ...opts, maxWindow: (opts?.maxWindow ?? 16) });
  if (!res) return null;
  const spanText = value; // target vs itself gives 1; keep as tie-breaker later
  return { ...res, score: Math.max(res.score, tfidfScore(spanText, value||"")) };
}

// --- embeddings via server ---
export async function predictBest_embed(tokens, value, opts, { embedEndpoint }) {
  if (!embedEndpoint || !value) return locateByValue(value, tokens, opts);
  // Ask server for top-k candidates (it can pre-index tokens by span strings)
  const body = JSON.stringify({ value, k: 5, pageBias: opts?.preferredPages||[] });
  const resp = await fetch(embedEndpoint, { method:"POST", headers:{ "Content-Type":"application/json" }, body });
  if (!resp.ok) return locateByValue(value, tokens, opts);
  const { candidates } = await resp.json(); // [{page,x0,y0,x1,y1,score},...]
  if (!candidates?.length) return locateByValue(value, tokens, opts);
  const c = candidates[0];
  return { page: c.page, rect:{ x0:c.x0,y0:c.y0,x1:c.x1,y1:c.y1 }, score:c.score, reason:"embed" };
}

// --- facade used from App.jsx ---
export async function predictBest(tokens, { model, key, value, opts, embedEndpoint }) {
  switch ((model||"fuzzy").toLowerCase()) {
    case "tfidf":   return predictBest_tfidf(tokens, value, opts);
    case "embed":   return predictBest_embed(tokens, value, opts, { embedEndpoint });
    case "fuzzy":
    default:        return fuzzy(tokens, key, value, opts);
  }
}


// top
import { predictBest } from "./lib/predictors.js";

export default function App() {
  const [model, setModel] = useState("fuzzy"); // "fuzzy" | "tfidf" | "embed"
  // ...

  async function handleClick(row) {
    if (!row?.content) return;
    const tokens = pdfRef.current?.tokensForMatching?.() || [];
    const preferredPages = row.page ? [row.page] : [];
    const res = await predictBest(tokens, {
      model,
      key: row.key || "",        // if you keep keys later
      value: row.content || "",
      opts: { preferredPages, maxWindow: 16, contextRadiusPx: 140 },
      embedEndpoint: "http://localhost:3001/embed"
    });
    if (res) pdfRef.current?.setLocateRect(res.page, res.rect);
  }

  return (
    <div className="wrap">
      <KVPane /* ... */ onClick={handleClick} />
      <div className="right">
        <div className="toolbar" style={{ position:"absolute", left:8, top:8, zIndex:10, display:"flex", gap:8 }}>
          {/* existing buttons... */}
          <select value={model} onChange={e=>setModel(e.target.value)} className="btn">
            <option value="fuzzy">Fuzzy</option>
            <option value="tfidf">TF-IDF</option>
            <option value="embed">Embeddings</option>
          </select>
          <label className="btn">
            Show OCR boxes
            <input type="checkbox" onChange={e=>pdfRef.current?.toggleTokenBoxes(e.target.checked)} />
          </label>
        </div>
        <PdfCanvas ref={pdfRef} pdfData={pdfData} ocrEndpoint={OCR_ENDPOINT} />
      </div>
    </div>
  );
}