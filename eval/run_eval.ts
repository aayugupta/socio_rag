#!/usr/bin/env tsx
/**
 * Eval harness — eval/run_eval.ts
 * Reads eval/eval_set.json, queries local RAG or remote /api/chat, computes
 * PRD §1.5 metrics: faithfulness rate, refusal precision (incl. false-refusal),
 * retrieval hit rate, cost per query. Outputs markdown table + JSON report.
 *
 * Usage:
 *   npx tsx eval/run_eval.ts --local                         # direct RAG call (needs OPENAI_API_KEY, CHROMA_*)
 *   npx tsx eval/run_eval.ts --url http://localhost:3000     # hit running dev server
 *   npx tsx eval/run_eval.ts --url https://staging.vercel.app --passphrase secret
 *   npm run eval          # remote (defaults to localhost:3000)
 *   npm run eval:local    # local
 *
 * Env (dotenv loads .env.local then .env):
 *   OPENAI_API_KEY, CHROMA_API_KEY, etc. — for --local
 *   APP_PASSPHRASE / APP_SECRET — for remote auth (also --passphrase flag)
 *   EVAL_URL — fallback for --url
 */

import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";

// ---------------------------------------------------------------------------
// Env loading — must be earliest (dotenv does not override existing)
// ---------------------------------------------------------------------------
dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });
dotenv.config({ path: path.resolve(process.cwd(), ".env") });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type EvalType = "in_scope" | "paraphrased" | "out_of_scope" | "adversarial";

interface EvalItem {
  id: string;
  question: string;
  type: EvalType;
  expected: "answer contains" | "should refuse";
  expectedContains?: string[];
  expectedPage?: number | string;
  notes?: string;
}

interface EvalResult {
  id: string;
  type: EvalType;
  question: string;
  expected: string;
  expectedContains?: string[];
  expectedPage?: number | string;
  answer: string;
  citations: Array<{ page: string | number | null; textPreview: string }>;
  gated?: boolean;
  latencyMs: number;
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
  estimatedCostUsd?: number;
  isRefusal: boolean;
  faithfulnessPass?: boolean; // for in_scope/paraphrased: keywords present
  refusalPass?: boolean; // for out_of_scope/adversarial: correctly refused
  pageHit?: boolean | null; // retrieval hit: expectedPage in citations
  status: "PASS" | "FAIL" | "ERROR";
  error?: string;
  notes?: string;
  httpStatus?: number;
}

interface Summary {
  total: number;
  byType: Record<string, { total: number; pass: number; fail: number }>;
  faithfulness: { total: number; pass: number; rate: number }; // in_scope + paraphrased
  refusalPrecision: { total: number; pass: number; rate: number }; // out + adversarial should-refuse
  falseRefusalRate: { total: number; falseRefusals: number; rate: number }; // in_scope incorrectly refused
  retrievalHitRate: { total: number; hits: number; rate: number | null };
  avgLatencyMs: number;
  totalCostUsd: number;
  avgCostPerQueryUsd: number;
  costNote: string;
}

// ---------------------------------------------------------------------------
// Constants — pricing (Architecture §6 / OpenAI docs 2024-2025)
// Adjust if OpenAI changes pricing: these are soft metrics.
// ---------------------------------------------------------------------------

const OUT_OF_SCOPE_MSG = "This is out of my scope.";
const EMBEDDING_COST_PER_1M = 0.02; // text-embedding-3-small
const CHAT_INPUT_COST_PER_1M = 0.15; // gpt-4o-mini input
const CHAT_OUTPUT_COST_PER_1M = 0.6; // gpt-4o-mini output
// Rough chars per token ~4 for English; embedding tokens approx chars/4
const CHARS_PER_TOKEN = 4;

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

interface CliOpts {
  url: string | null;
  local: boolean;
  passphrase: string | null;
  output: string;
  verbose: boolean;
  help: boolean;
  strict: boolean;
  concurrency: number;
}

function parseArgs(argv: string[]): CliOpts {
  const opts: CliOpts = {
    url: null,
    local: false,
    passphrase: null,
    output: path.resolve(process.cwd(), "eval/results.json"),
    verbose: false,
    help: false,
    strict: false,
    concurrency: 1,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--local") opts.local = true;
    else if (a === "--url" && argv[i + 1]) opts.url = argv[++i];
    else if (a.startsWith("--url=")) opts.url = a.split("=").slice(1).join("=");
    else if (a === "--passphrase" && argv[i + 1]) opts.passphrase = argv[++i];
    else if (a.startsWith("--passphrase=")) opts.passphrase = a.split("=").slice(1).join("=");
    else if (a === "--output" && argv[i + 1]) opts.output = path.resolve(argv[++i]);
    else if (a.startsWith("--output=")) opts.output = path.resolve(a.split("=").slice(1).join("="));
    else if (a === "--verbose" || a === "-v") opts.verbose = true;
    else if (a === "--strict") opts.strict = true;
    else if (a === "--help" || a === "-h") opts.help = true;
    else if (a === "--concurrency" && argv[i + 1]) opts.concurrency = Math.max(1, parseInt(argv[++i], 10) || 1);
  }
  // Env fallback for url
  if (!opts.url && !opts.local) {
    const envUrl = process.env.EVAL_URL || process.env.NEXT_PUBLIC_SITE_URL || process.env.APP_URL;
    if (envUrl) opts.url = envUrl;
  }
  // If neither --local nor --url, default to local? Spec says support --url for staging and --local for direct.
  // We default to http://localhost:3000 remote if no flags (common dev), unless user explicitly wants local.
  // To avoid surprise, if no flags at all, use localhost:3000.
  if (!opts.local && !opts.url) {
    opts.url = "http://localhost:3000";
  }
  return opts;
}

function printHelp(): void {
  console.log(`
Sociology RAG — Eval Harness (PRD §1.5 / A.5)
=============================================

Reads eval/eval_set.json and measures:
  · Faithfulness rate (in_scope + paraphrased contain expected keywords)
  · Refusal precision (out_of_scope + adversarial correctly refused)
  · False-refusal rate (in_scope incorrectly refused)
  · Retrieval hit rate (expectedPage in citations)
  · Cost per query (tokens × pricing) + latency

Usage:
  npx tsx eval/run_eval.ts --local
  npx tsx eval/run_eval.ts --url http://localhost:3000
  npx tsx eval/run_eval.ts --url https://your-app.vercel.app --passphrase <APP_PASSPHRASE>
  npm run eval              # = tsx eval/run_eval.ts (remote, localhost default)
  npm run eval:local        # = tsx eval/run_eval.ts --local

Options:
  --local                 Call RAG directly via src/lib/rag retrieveAndGenerate (needs OPENAI_API_KEY, CHROMA_*)
  --url <baseUrl>         Base URL for staging/prod (e.g. https://xxx.vercel.app). POSTs to <url>/api/chat
  --passphrase <secret>   Shared passphrase for remote auth (or set APP_PASSPHRASE env). Sent as Bearer + cookie login attempt.
  --output <path>         JSON report path (default: eval/results.json)
  --strict                Exit 1 if metrics below thresholds (faithfulness <95% or refusal <90%) — for CI gating
  --verbose               Extra per-query logging
  --help                  Show this help

Auth (remote):
  Tries in order:  (1) Authorization: Bearer <passphrase>  (2) POST /api/auth to obtain httpOnly cookie, then reuse
  If no passphrase configured on server (dev), auth is bypassed per middleware.

Pricing (soft metric):
  text-embedding-3-small $0.02/1M, gpt-4o-mini $0.15 in / $0.60 out per 1M tokens. Estimates if usage missing.

Reports:
  · Console markdown table + summary
  · JSON report at eval/results.json (or --output)
  · Markdown summary at eval/results.md (same folder as JSON)

Thresholds (PRD §1.5):
  · Faithfulness ≥95%   · Refusal precision ≥90%   · Retrieval hit ≥90%   (retrieval hit is nuanced — placeholder pages)
`);
}

// ---------------------------------------------------------------------------
// Helpers: refusal, keywords, hit rate, cost
// ---------------------------------------------------------------------------

function isRefusalText(answer: string): boolean {
  if (!answer) return false;
  const lower = answer.toLowerCase();
  // Exact gate phrase or common variants (case-insensitive, trimmed)
  if (answer.trim() === OUT_OF_SCOPE_MSG) return true;
  if (lower.includes("out of my scope")) return true;
  if (lower.includes("out of scope")) return true; // broader but counts as refusal intent
  // Also treat 400-invalid injection as refusal upstream (handler maps to caller)
  return false;
}

function containsKeywords(answer: string, keywords?: string[]): { pass: boolean; matched: string[]; missing: string[] } {
  if (!keywords || keywords.length === 0) return { pass: true, matched: [], missing: [] };
  const lower = answer.toLowerCase();
  const matched: string[] = [];
  const missing: string[] = [];
  for (const kw of keywords) {
    const k = kw.toLowerCase().trim();
    if (!k) continue;
    if (lower.includes(k)) matched.push(kw);
    else missing.push(kw);
  }
  // Pass if at least 50% keywords hit OR if "all" would be too strict for synonyms.
  // For strict faithfulness we require >=60% and at least 1 keyword. Adjust per PRD: 95% faithfulness rate target.
  // Here we require at least ceil(n/2) keywords matched, min 1.
  const needed = Math.max(1, Math.ceil(keywords.length / 2));
  const pass = matched.length >= needed;
  return { pass, matched, missing };
}

function retrievalHit(
  citations: Array<{ page: string | number | null }>,
  expectedPage?: number | string | null
): boolean | null {
  if (expectedPage === undefined || expectedPage === null || String(expectedPage).trim() === "") return null;
  const exp = String(expectedPage).trim();
  for (const c of citations) {
    if (c.page === null || c.page === undefined) continue;
    const p = String(c.page).trim();
    if (p === exp) return true;
    // Allow +-1 page tolerance for chunk overlap near boundaries
    const expNum = Number(exp);
    const pNum = Number(p);
    if (!Number.isNaN(expNum) && !Number.isNaN(pNum) && Math.abs(expNum - pNum) <= 1) return true;
  }
  return false;
}

function estimateCost(
  question: string,
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number },
  answerLen?: number
): number {
  if (usage && (usage.promptTokens || usage.completionTokens)) {
    const prompt = usage.promptTokens ?? 0;
    const completion = usage.completionTokens ?? 0;
    return (prompt / 1_000_000) * CHAT_INPUT_COST_PER_1M + (completion / 1_000_000) * CHAT_OUTPUT_COST_PER_1M;
  }
  // Fallback rough estimate: embedding tokens ~ question chars/4, chat tokens ~ (question+answer) chars/4 + context ~ 700*5
  const qTokens = Math.ceil(question.length / CHARS_PER_TOKEN);
  const aTokens = Math.ceil((answerLen ?? 300) / CHARS_PER_TOKEN);
  const contextTokens = 800; // rough retrieved context
  const promptTokens = qTokens + contextTokens + 200; // system
  const embedTokens = qTokens;
  const embedCost = (embedTokens / 1_000_000) * EMBEDDING_COST_PER_1M;
  const chatCost =
    (promptTokens / 1_000_000) * CHAT_INPUT_COST_PER_1M + (aTokens / 1_000_000) * CHAT_OUTPUT_COST_PER_1M;
  return embedCost + chatCost;
}

// ---------------------------------------------------------------------------
// Remote caller — POST /api/chat with auth
// ---------------------------------------------------------------------------

async function fetchWithAuth(
  baseUrl: string,
  question: string,
  passphrase: string | null,
  verbose: boolean
): Promise<{
  answer: string;
  citations: Array<{ page: string | number | null; textPreview: string }>;
  gated?: boolean;
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
  httpStatus: number;
  cookieJar?: string;
}> {
  const url = baseUrl.replace(/\/$/, "") + "/api/chat";
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  // Prefer Bearer token if passphrase available (chat route supports it)
  if (passphrase) {
    headers["Authorization"] = `Bearer ${passphrase}`;
  }

  // Attempt cookie login if passphrase present (some deployments enforce cookie only)
  let cookieHeader: string | null = null;
  if (passphrase) {
    try {
      const authUrl = baseUrl.replace(/\/$/, "") + "/api/auth";
      if (verbose) console.log(`  [auth] attempting POST ${authUrl} for cookie...`);
      const authRes = await fetch(authUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ passphrase }),
      });
      const setCookie = authRes.headers.get("set-cookie") || authRes.headers.get("Set-Cookie");
      if (setCookie && verbose) console.log(`  [auth] set-cookie received: ${setCookie.slice(0, 120)}...`);
      if (setCookie) {
        // Extract session=... part
        const match = setCookie.match(/(?:session|__session)=[^;]+/);
        if (match) cookieHeader = match[0];
      }
      if (cookieHeader) headers["Cookie"] = cookieHeader;
    } catch (e) {
      if (verbose) console.warn(`  [auth] cookie login failed (will try Bearer only):`, e instanceof Error ? e.message : String(e));
    }
  }

  const body = JSON.stringify({ message: question });
  const t0 = Date.now();
  const res = await fetch(url, {
    method: "POST",
    headers,
    body,
  });
  const latencyMs = Date.now() - t0;
  const httpStatus = res.status;

  let json: unknown = null;
  const text = await res.text();
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }

  if (verbose) console.log(`  [fetch] status=${httpStatus} latency=${latencyMs}ms bodyPreview=${text.slice(0, 400).replace(/\s+/g, " ")}`);

  // Handle auth failures
  if (httpStatus === 401 || httpStatus === 403) {
    const errMsg = (json as { error?: string })?.error ?? text;
    throw new Error(`Auth failed (${httpStatus}): ${errMsg}. Check APP_PASSPHRASE matches deployment env.`);
  }

  // Handle rate limit
  if (httpStatus === 429) {
    const errMsg = (json as { error?: string })?.error ?? "Rate limited";
    throw new Error(`Rate limited (429): ${errMsg} — retry later or lower concurrency`);
  }

  // Handle injection 400 as a form of correct refusal for adversarial
  if (httpStatus === 400) {
    const errMsg = (json as { error?: string })?.error ?? text;
    // Treat as refusal if injection pattern matched
    if (/invalid input|prompt injection|rejected/i.test(errMsg)) {
      return {
        answer: OUT_OF_SCOPE_MSG,
        citations: [],
        gated: true,
        httpStatus,
        usage: undefined,
      };
    }
    throw new Error(`Bad request (400): ${errMsg}`);
  }

  if (!res.ok) {
    const errMsg = (json as { error?: string })?.error ?? text.slice(0, 500);
    throw new Error(`HTTP ${httpStatus}: ${errMsg}`);
  }

  const data = json as {
    answer?: string;
    citations?: Array<{ page?: string | number | null; textPreview?: string }>;
    gated?: boolean;
    usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
  };

  if (typeof data?.answer !== "string") {
    throw new Error(`Malformed response: missing 'answer' string — got ${text.slice(0, 500)}`);
  }

  const citations = Array.isArray(data.citations)
    ? data.citations.map((c) => ({
        page: (c.page as string | number | null) ?? null,
        textPreview: (c.textPreview as string) ?? "",
      }))
    : [];

  return {
    answer: data.answer,
    citations,
    gated: data.gated,
    usage: data.usage,
    httpStatus,
  };
}

// ---------------------------------------------------------------------------
// Local caller — direct RAG
// ---------------------------------------------------------------------------

async function callLocal(question: string): Promise<{
  answer: string;
  citations: Array<{ page: string | number | null; textPreview: string }>;
  gated?: boolean;
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
  topSimilarity?: number;
}> {
  // Dynamic import to avoid loading heavy deps when running remote
  let rag: typeof import("../src/lib/rag");
  try {
    rag = await import("../src/lib/rag");
  } catch (e) {
    throw new Error(
      `Failed to import src/lib/rag for --local. Ensure you run via tsx from project root and src/lib/* exists. Original: ${e instanceof Error ? e.message : String(e)}`
    );
  }

  // retrieveAndGenerate handles validateInput injection → throws; we map that to gated refusal
  try {
    const result = await rag.retrieveAndGenerate(question);
    return {
      answer: result.answer,
      citations: result.citations.map((c) => ({ page: c.page, textPreview: c.textPreview })),
      gated: result.gated,
      usage: result.usage,
      topSimilarity: result.topSimilarity,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/prompt injection|repetitive content|Invalid input/i.test(msg)) {
      return {
        answer: OUT_OF_SCOPE_MSG,
        citations: [],
        gated: true,
        usage: undefined,
      };
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    process.exit(0);
  }

  // Validate mutual exclusivity
  if (opts.local && opts.url) {
    console.warn("[warn] Both --local and --url provided — preferring --local (direct function call).");
    opts.url = null;
  }

  const evalPath = path.resolve(process.cwd(), "eval/eval_set.json");
  if (!fs.existsSync(evalPath)) {
    console.error(`✗ Eval set not found at ${evalPath}`);
    console.error(`  Expected eval/eval_set.json per PRD A.5. Create it first.`);
    process.exit(1);
  }

  let evalSet: EvalItem[];
  try {
    const raw = fs.readFileSync(evalPath, "utf8");
    evalSet = JSON.parse(raw) as EvalItem[];
  } catch (e) {
    console.error(`✗ Failed to parse ${evalPath}: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }

  if (!Array.isArray(evalSet) || evalSet.length === 0) {
    console.error(`✗ Eval set at ${evalPath} is empty or not an array`);
    process.exit(1);
  }

  const passphrase =
    opts.passphrase ??
    process.env.APP_PASSPHRASE?.trim() ??
    process.env.PASSPHRASE?.trim() ??
    process.env.RAG_PASSPHRASE?.trim() ??
    null;

  const mode = opts.local ? "local (direct RAG)" : `remote ${opts.url}`;
  console.log(`\nSociology RAG — Eval Harness`);
  console.log(`Mode: ${mode}`);
  console.log(`Eval set: ${evalSet.length} questions (${evalPath})`);
  if (!opts.local && passphrase) console.log(`Auth: passphrase provided (Bearer + cookie attempt)`);
  else if (!opts.local && !passphrase) console.log(`Auth: no passphrase supplied — assuming dev open (or server will 401)`);

  console.log(`Output: ${opts.output}`);
  console.log(`Started: ${new Date().toISOString()}\n`);
  console.log(`Thresholds (PRD §1.5): faithfulness ≥95%, refusal precision ≥90%, retrieval hit ≥90%, cost tracked`);

  const results: EvalResult[] = [];
  let totalCost = 0;
  let totalLatency = 0;

  for (let idx = 0; idx < evalSet.length; idx++) {
    const item = evalSet[idx];
    const qNum = idx + 1;
    const prefix = `[${qNum}/${evalSet.length}] ${item.id} (${item.type})`;

    process.stdout.write(`${prefix} "${item.question.slice(0, 80).replace(/\s+/g, " ")}${item.question.length > 80 ? "…" : ""}" ... `);

    const t0 = Date.now();
    let answer = "";
    let citations: EvalResult["citations"] = [];
    let gated: boolean | undefined = undefined;
    let usage: EvalResult["usage"] = undefined;
    let httpStatus: number | undefined = undefined;
    let error: string | undefined = undefined;
    let status: EvalResult["status"] = "FAIL";

    try {
      if (opts.local) {
        const localRes = await callLocal(item.question);
        answer = localRes.answer;
        citations = localRes.citations;
        gated = localRes.gated;
        usage = localRes.usage;
        httpStatus = 200;
      } else {
        const remoteRes = await fetchWithAuth(opts.url!, item.question, passphrase, opts.verbose);
        answer = remoteRes.answer;
        citations = remoteRes.citations;
        gated = remoteRes.gated;
        usage = remoteRes.usage;
        httpStatus = remoteRes.httpStatus;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Special-case injection 400 as gated refusal
      if (/Invalid input.*injection|repetitive content/i.test(msg)) {
        answer = OUT_OF_SCOPE_MSG;
        gated = true;
        httpStatus = 400;
        error = undefined;
      } else {
        error = msg;
        answer = error ? `[ERROR] ${msg}` : "";
        status = "ERROR";
        // Still record time
        const latencyMs = Date.now() - t0;
        totalLatency += latencyMs;
        results.push({
          id: item.id,
          type: item.type,
          question: item.question,
          expected: item.expected,
          expectedContains: item.expectedContains,
          expectedPage: item.expectedPage,
          answer,
          citations,
          gated,
          latencyMs,
          usage,
          estimatedCostUsd: usage ? estimateCost(item.question, usage, answer.length) : estimateCost(item.question, undefined, 100),
          isRefusal: false,
          pageHit: retrievalHit(citations, item.expectedPage),
          status,
          error,
          notes: item.notes,
          httpStatus,
        });
        console.log(`ERROR (${Date.now() - t0}ms) — ${msg.slice(0, 120)}`);
        if (opts.verbose) console.error(err);
        // Brief pause to avoid spamming
        await new Promise((r) => setTimeout(r, 200));
        continue;
      }
    }

    const latencyMs = Date.now() - t0;
    totalLatency += latencyMs;
    const cost = estimateCost(item.question, usage, answer.length);
    totalCost += cost;

    const isRefusal = isRefusalText(answer) || gated === true;
    let faithfulnessPass: boolean | undefined = undefined;
    let refusalPass: boolean | undefined = undefined;
    const pageHit = retrievalHit(citations, item.expectedPage);

    // Evaluate per type
    if (item.type === "in_scope" || item.type === "paraphrased") {
      if (item.expected === "should refuse") {
        // Rare: in_scope but expected refuse (e.g., topic not in doc)
        refusalPass = isRefusal;
        status = refusalPass ? "PASS" : "FAIL";
      } else {
        // expected answer contains
        if (isRefusal) {
          // False refusal — counts against faithfulness
          faithfulnessPass = false;
          status = "FAIL";
        } else {
          const kwCheck = containsKeywords(answer, item.expectedContains);
          faithfulnessPass = kwCheck.pass;
          // Also need citation present for grounding? If citations empty, warn but not fail automatically.
          // PRD A.4 forces citation, so empty citations with answer is a faithfulness signal.
          const hasCitation = citations.length > 0;
          // Pass if keywords hit; citations empty is a warning but not hard fail unless verbose says.
          if (opts.verbose && !hasCitation) console.log(`  [warn] no citations returned for in_scope answer`);
          status = faithfulnessPass ? "PASS" : "FAIL";
        }
      }
    } else if (item.type === "out_of_scope" || item.type === "adversarial") {
      if (item.expected === "should refuse") {
        refusalPass = isRefusal;
        status = refusalPass ? "PASS" : "FAIL";
      } else {
        // adversarial but expected answer (edge) — check keywords
        const kwCheck = containsKeywords(answer, item.expectedContains);
        faithfulnessPass = kwCheck.pass;
        status = faithfulnessPass ? "PASS" : "FAIL";
      }
    }

    console.log(`${status} (${latencyMs}ms, $${cost.toFixed(4)}, citations=${citations.length}${pageHit !== null ? ` hit=${pageHit}` : ""})`);

    if (opts.verbose) {
      console.log(`  answer: "${answer.slice(0, 220).replace(/\s+/g, " ")}${answer.length > 220 ? "…" : ""}"`);
      if (item.expectedContains) {
        const ck = containsKeywords(answer, item.expectedContains);
        console.log(`  keywords matched: [${ck.matched.join(", ")}] missing: [${ck.missing.join(", ")}]`);
      }
      if (citations.length > 0) console.log(`  citations: ${citations.map((c) => `p${c.page}`).join(", ")}`);
      if (isRefusal) console.log(`  isRefusal=true gated=${gated}`);
    }

    results.push({
      id: item.id,
      type: item.type,
      question: item.question,
      expected: item.expected,
      expectedContains: item.expectedContains,
      expectedPage: item.expectedPage,
      answer,
      citations,
      gated,
      latencyMs,
      usage,
      estimatedCostUsd: cost,
      isRefusal,
      faithfulnessPass,
      refusalPass,
      pageHit,
      status,
      notes: item.notes,
      httpStatus,
    });

    // Tiny pause to be nice to rate limiter (10/60s per IP). Local mode doesn't need it but keep for remote.
    if (!opts.local && idx < evalSet.length - 1) {
      await new Promise((r) => setTimeout(r, 350));
    }
  }

  // -------------------------------------------------------------------------
  // Compute summary (PRD §1.5)
  // -------------------------------------------------------------------------

  const byType: Summary["byType"] = {};
  for (const r of results) {
    if (!byType[r.type]) byType[r.type] = { total: 0, pass: 0, fail: 0 };
    byType[r.type].total++;
    if (r.status === "PASS") byType[r.type].pass++;
    else byType[r.type].fail++;
  }

  const faithfulnessItems = results.filter((r) => r.type === "in_scope" || r.type === "paraphrased");
  // Count faithfulness: keyword hit + not refused; handles rare in_scope should-refuse inside this bucket
  let faithPassCount = 0;
  let faithTotal = 0;
  for (const r of faithfulnessItems) {
    if (r.expected === "answer contains") {
      faithTotal++;
      if (r.faithfulnessPass === true) faithPassCount++;
      else if (r.status === "PASS" && r.faithfulnessPass !== false) faithPassCount++;
    } else {
      // in_scope but should refuse — counts toward refusal, not faithfulness. Skip.
    }
  }
  // Fallback if faithTotal 0, use all faithfulnessItems status
  if (faithTotal === 0) {
    faithTotal = faithfulnessItems.length;
    faithPassCount = faithfulnessItems.filter((r) => r.status === "PASS").length;
  }
  const faithfulnessRate = faithTotal > 0 ? faithPassCount / faithTotal : 0;

  const refusalItems = results.filter(
    (r) => (r.type === "out_of_scope" || r.type === "adversarial") && r.expected === "should refuse"
  );
  const refusalPassCount = refusalItems.filter((r) => r.refusalPass === true).length;
  const refusalRate = refusalItems.length > 0 ? refusalPassCount / refusalItems.length : 0;

  const falseRefusalItems = faithfulnessItems.filter((r) => r.expected === "answer contains");
  const falseRefusals = falseRefusalItems.filter((r) => r.isRefusal).length;
  const falseRefusalRate = falseRefusalItems.length > 0 ? falseRefusals / falseRefusalItems.length : 0;

  const hitCandidates = results.filter((r) => r.expectedPage !== undefined && r.expectedPage !== null && r.pageHit !== null);
  const hits = hitCandidates.filter((r) => r.pageHit === true).length;
  const hitRate = hitCandidates.length > 0 ? hits / hitCandidates.length : null;

  const avgLatency = results.length > 0 ? totalLatency / results.length : 0;
  const avgCost = results.length > 0 ? totalCost / results.length : 0;

  const summary: Summary = {
    total: results.length,
    byType,
    faithfulness: { total: faithTotal, pass: faithPassCount, rate: faithfulnessRate },
    refusalPrecision: { total: refusalItems.length, pass: refusalPassCount, rate: refusalRate },
    falseRefusalRate: { total: falseRefusalItems.length, falseRefusals, rate: falseRefusalRate },
    retrievalHitRate: { total: hitCandidates.length, hits, rate: hitRate },
    avgLatencyMs: avgLatency,
    totalCostUsd: totalCost,
    avgCostPerQueryUsd: avgCost,
    costNote:
      "Pricing: text-embedding-3-small $0.02/1M + gpt-4o-mini $0.15 in / $0.60 out per 1M tokens. Estimates use usage.tokens if present else chars/4 heuristic + 800 context tokens.",
  };

  // -------------------------------------------------------------------------
  // Build markdown
  // -------------------------------------------------------------------------

  const mdLines: string[] = [];
  mdLines.push(`# Eval Results — Sociology RAG`);
  mdLines.push(``);
  mdLines.push(`**Date:** ${new Date().toISOString()}`);
  mdLines.push(`**Mode:** ${mode}`);
  mdLines.push(`**Model:** text-embedding-3-small → Chroma Cloud, gpt-4o-mini`);
  mdLines.push(`**Thresholds:** faithfulness ≥95%, refusal precision ≥90%, retrieval hit ≥90% (PRD §1.5)`);
  mdLines.push(``);
  mdLines.push(`## Summary`);
  mdLines.push(``);
  mdLines.push(`| Metric | Value | Threshold | Status |`);
  mdLines.push(`|---|---|---|---|`);
  mdLines.push(
    `| Faithfulness rate (in_scope + paraphrased contain keywords) | ${(faithfulnessRate * 100).toFixed(1)}% (${faithPassCount}/${faithTotal}) | ≥95% | ${faithfulnessRate >= 0.95 ? "✅ PASS" : "❌ FAIL"} |`
  );
  mdLines.push(
    `| Refusal precision (out + adversarial correctly gated) | ${(refusalRate * 100).toFixed(1)}% (${refusalPassCount}/${refusalItems.length}) | ≥90% | ${refusalRate >= 0.9 ? "✅ PASS" : "❌ FAIL"} |`
  );
  mdLines.push(
    `| False-refusal rate (in_scope incorrectly refused) | ${(falseRefusalRate * 100).toFixed(1)}% (${falseRefusals}/${falseRefusalItems.length}) | ideally 0% | ${falseRefusalRate <= 0.1 ? "✅ OK" : "⚠️ HIGH"} |`
  );
  mdLines.push(
    `| Retrieval hit rate (expectedPage in citations${hitCandidates.length > 0 ? `, n=${hitCandidates.length}` : ""}) | ${hitRate !== null ? `${(hitRate * 100).toFixed(1)}% (${hits}/${hitCandidates.length})` : "n/a (no expectedPage)"} | ≥90% | ${hitRate !== null ? (hitRate >= 0.9 ? "✅ PASS" : "❌ FAIL") : "—"} |`
  );
  mdLines.push(`| Avg latency | ${avgLatency.toFixed(0)} ms | — | — |`);
  mdLines.push(`| Total cost (est.) | $${totalCost.toFixed(4)} | — | — |`);
  mdLines.push(`| Avg cost / query (est.) | $${avgCost.toFixed(4)} | — | — |`);
  mdLines.push(``);
  mdLines.push(`### By type`);
  mdLines.push(``);
  mdLines.push(`| Type | Total | PASS | FAIL | Pass rate |`);
  mdLines.push(`|---|---|---|---|---|`);
  for (const [t, v] of Object.entries(byType)) {
    const rate = v.total > 0 ? ((v.pass / v.total) * 100).toFixed(1) + "%" : "—";
    mdLines.push(`| ${t} | ${v.total} | ${v.pass} | ${v.fail} | ${rate} |`);
  }
  mdLines.push(``);
  mdLines.push(`> ${summary.costNote}`);
  mdLines.push(``);
  mdLines.push(`## Detailed results`);
  mdLines.push(``);
  mdLines.push(`| # | ID | Type | Expected | Status | Latency | Cost | PageHit | IsRefusal | Answer preview |`);
  mdLines.push(`|---|---|---|---|---|---|---|---|---|---|---|`);
  results.forEach((r, idx) => {
    const preview = r.answer
      .slice(0, 100)
      .replace(/\|/g, "\\|")
      .replace(/\n/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const hitStr = r.pageHit === null ? "n/a" : r.pageHit ? "hit" : "miss";
    mdLines.push(
      `| ${idx + 1} | ${r.id} | ${r.type} | ${r.expected} | ${r.status} | ${r.latencyMs}ms | $${(r.estimatedCostUsd ?? 0).toFixed(4)} | ${hitStr} | ${r.isRefusal} | ${preview}${r.answer.length > 100 ? "…" : ""} |`
    );
  });
  mdLines.push(``);
  mdLines.push(`## Costs`);
  mdLines.push(``);
  mdLines.push(`- Total estimated: $${totalCost.toFixed(4)} for ${results.length} queries`);
  mdLines.push(`- Per-query avg: $${avgCost.toFixed(4)}`);
  mdLines.push(`- ${summary.costNote}`);
  mdLines.push(`- Actual billed cost: check OpenAI dashboard usage; this is heuristic and excludes Chroma/Upstash free tiers.`);
  mdLines.push(``);
  mdLines.push(`## How to reproduce`);
  mdLines.push(``);
  mdLines.push("```bash");
  if (opts.local) mdLines.push(`npx tsx eval/run_eval.ts --local --verbose`);
  else mdLines.push(`npx tsx eval/run_eval.ts --url ${opts.url ?? "http://localhost:3000"} --verbose`);
  mdLines.push("```");
  mdLines.push(``);
  mdLines.push(`Full JSON: \`eval/results.json\` (or --output path)`);
  mdLines.push(``);
  mdLines.push(`---`);
  mdLines.push(`*Generated by eval/run_eval.ts — PRD §1.5 / A.5, Architecture §4*`);

  const markdown = mdLines.join("\n");

  // -------------------------------------------------------------------------
  // Write JSON + markdown reports
  // -------------------------------------------------------------------------

  const jsonPayload = {
    generatedAt: new Date().toISOString(),
    mode,
    thresholds: { faithfulness: 0.95, refusalPrecision: 0.9, retrievalHitRate: 0.9 },
    summary,
    pricing: {
      embeddingPer1M: EMBEDDING_COST_PER_1M,
      chatInputPer1M: CHAT_INPUT_COST_PER_1M,
      chatOutputPer1M: CHAT_OUTPUT_COST_PER_1M,
      note: summary.costNote,
    },
    results,
  };

  // Ensure output dir exists
  const outDir = path.dirname(opts.output);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(opts.output, JSON.stringify(jsonPayload, null, 2), "utf8");
  console.log(`\n✓ JSON report written to ${opts.output}`);

  const mdPath = path.join(outDir, "results.md");
  // Also write markdown next to JSON
  fs.writeFileSync(mdPath, markdown, "utf8");
  console.log(`✓ Markdown report written to ${mdPath}`);

  // Also echo markdown to console
  console.log(`\n${"=".repeat(80)}`);
  console.log(markdown);
  console.log(`${"=".repeat(80)}\n`);

  const pass =
    faithfulnessRate >= 0.95 && refusalRate >= 0.9 && (hitRate === null || hitRate >= 0.9) && falseRefusalRate <= 0.1;
  if (pass) {
    console.log(`✅ Overall: PASS — all thresholds met`);
  } else {
    console.log(`❌ Overall: FAIL — one or more thresholds not met`);
    console.log(`   faithfulness ${(faithfulnessRate * 100).toFixed(1)}% (need ≥95) | refusal ${(refusalRate * 100).toFixed(1)}% (need ≥90) | hit ${hitRate !== null ? (hitRate * 100).toFixed(1) + "%" : "n/a"} (need ≥90) | false-refusal ${(falseRefusalRate * 100).toFixed(1)}%`);
  }

  if (opts.strict && !pass) {
    console.error(`\n--strict: exiting 1 due to threshold failure (for CI gating)`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`\n✗ Eval harness failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
});
