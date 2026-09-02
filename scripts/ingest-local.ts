#!/usr/bin/env tsx
/**
 * Local ingestion pipeline — scripts/ingest-local.ts:1
 * Alternative local vector store for offline dev WITHOUT Chroma Cloud.
 * Uses Chroma in-memory / local persist at ./chroma_db (or JSON fallback).
 * Useful for friends who want free local prototyping (PRD original local Chroma).
 *
 * Same splitting logic as ingest.ts but stores locally:
 *   PDF → RecursiveCharacterTextSplitter (700/120) → OpenAI embeddings → local Chroma or ./chroma_db json
 *
 * Usage:
 *   npm run ingest:local              # ingest to ./chroma_db
 *   npx tsx scripts/ingest-local.ts --dry-run
 *   npx tsx scripts/ingest-local.ts --pdf ./data/Sociology.pdf
 *
 * Env: OPENAI_API_KEY (unless --dry-run). No CHROMA_API_KEY needed for local mode.
 * For true Chroma local server: `chroma run --path ./chroma_db` (or docker) then re-run.
 */

import * as dotenv from "dotenv";
import * as path from "path";
import * as fs from "fs";
import { createHash } from "crypto";

dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });
dotenv.config({ path: path.resolve(process.cwd(), ".env") });

const EMBEDDING_MODEL = "text-embedding-3-small" as const;
const CHUNK_SIZE = 700;
const CHUNK_OVERLAP = 120;
const EMBED_BATCH_SIZE = 100;
const LOCAL_DIR = path.resolve(process.cwd(), "chroma_db");
const LOCAL_JSON = path.join(LOCAL_DIR, "local_store.json");
const TEST_QUERY = "What does Nishant Sir say about Weber's bureaucracy?";
const DEFAULT_COLLECTION = "sociology";
const DEFAULT_PDF_REL = path.join("data", "Sociology.pdf");
const FALLBACK_PDF_WIN = `C:\\Users\\aarad\\Downloads\\_Handouts_Sociology2024byNishantSir_LevelupIAS_KING_R_QUEEN_P.PDF`;

const KNOWN_HEADINGS = [
  "Weber", "Marx", "Durkheim", "Comte", "Spencer", "Parsons", "Merton", "Mead", "Goffman", "Bourdieu",
  "Foucault", "Functionalism", "Conflict Theory", "Symbolic Interactionism", "Structural Functionalism",
  "Social Stratification", "Bureaucracy", "Religion", "Education", "Family", "Kinship", "Social Change",
  "Auguste Comte", "Karl Marx", "Max Weber", "Emile Durkheim", "Talcott Parsons", "Robert Merton",
];

function printLocalWarnings(): void {
  console.warn("\n" + "=".repeat(80));
  console.warn("⚠️  ADR-2 WARNING: You must re-embed ENTIRE document if you change embedding model — never mix models!");
  console.warn(`   Local store embedding model: ${EMBEDDING_MODEL} (1536 dims, cosine)`);
  console.warn("   Local ./chroma_db is NOT compatible with Chroma Cloud vectors if models differ.");
  console.warn("=".repeat(80));
  console.warn("📁 Local mode: stores at ./chroma_db (gitignored). No Chroma Cloud keys needed.");
  console.warn("   - If Chroma server running at http://localhost:8000, will upsert there (persisted at ./chroma_db if server started with --path)");
  console.warn("   - Otherwise falls back to JSON file ./chroma_db/local_store.json (fully offline, no server required)");
  console.warn("=".repeat(80) + "\n");
}

interface CliArgs {
  dryRun: boolean;
  help: boolean;
  pdfPath: string | null;
  collection: string | null;
  batchSize: number;
  skipVerify: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const a: CliArgs = { dryRun: false, help: false, pdfPath: null, collection: null, batchSize: EMBED_BATCH_SIZE, skipVerify: false };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--dry-run" || v === "-d") a.dryRun = true;
    else if (v === "--help" || v === "-h") a.help = true;
    else if (v === "--pdf" && argv[i + 1]) a.pdfPath = argv[++i];
    else if (v.startsWith("--pdf=")) a.pdfPath = v.split("=")[1];
    else if (v === "--collection" && argv[i + 1]) a.collection = argv[++i];
    else if (v.startsWith("--collection=")) a.collection = v.split("=")[1];
    else if (v === "--batch-size" && argv[i + 1]) a.batchSize = parseInt(argv[++i], 10);
    else if (v === "--skip-verify") a.skipVerify = true;
  }
  if (process.argv.includes("--dry-run")) a.dryRun = true;
  return a;
}

function printHelp(): void {
  console.log(`
Sociology RAG — Local Ingestion Pipeline (offline, no Chroma Cloud)
=====================================================================
Architecture: PDF → RecursiveCharacterTextSplitter (700/120) → OpenAI ${EMBEDDING_MODEL} → ./chroma_db (local)

Usage:
  npx tsx scripts/ingest-local.ts [options]
  npm run ingest:local
  npx tsx scripts/ingest-local.ts --dry-run

Options:
  --pdf <path>          PDF path (default: ./data/Sociology.pdf)
  --collection <name>   Collection name (default: sociology, stored in local_store.json)
  --dry-run             Parse + chunk only, no embeddings
  --batch-size <n>      Embedding batch size (default: 100)
  --skip-verify         Skip post-ingest verification
  --help                Show this help

Env (.env.local or .env):
  OPENAI_API_KEY        Required unless --dry-run (same model as Cloud: ${EMBEDDING_MODEL})

Storage:
  ./chroma_db/local_store.json   — JSON fallback (always written, no server needed)
  Chroma server (optional): if http://localhost:8000 reachable, also upserts to local Chroma collection

Verification:
  After ingest, runs cosine similarity search locally for: "${TEST_QUERY}"
`);
}

function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] ${msg}`);
}
function getEnv(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim().length > 0 ? v.trim() : undefined;
}
function resolvePdfPath(cliPdf: string | null): string {
  if (cliPdf) {
    const r = path.resolve(cliPdf);
    if (fs.existsSync(r)) return r;
    throw new Error(`PDF not found at CLI path: ${r}`);
  }
  const primary = path.resolve(process.cwd(), DEFAULT_PDF_REL);
  if (fs.existsSync(primary)) return primary;
  if (fs.existsSync(FALLBACK_PDF_WIN)) {
    log(`Primary PDF not found at ${primary}, falling back to Downloads original`);
    return FALLBACK_PDF_WIN;
  }
  throw new Error(`PDF not found. Tried:\n  1) ${primary}\n  2) ${FALLBACK_PDF_WIN}\nPlace PDF at ./data/Sociology.pdf or pass --pdf <path>`);
}
function hashId(text: string, page: number, chunkIndex: number, source: string): string {
  const h = createHash("sha256");
  h.update(`${source}::${page}::${chunkIndex}::${text.slice(0, 200)}::${text.length}`);
  return h.digest("hex").slice(0, 32);
}
function detectSection(text: string): string {
  const lower = text.toLowerCase();
  for (const h of KNOWN_HEADINGS) if (lower.includes(h.toLowerCase())) return h;
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  for (const line of lines.slice(0, 3)) {
    if (line.length >= 5 && line.length <= 80 && /^[A-Z0-9 \(\)\-\/&.,:]+$/.test(line) && /[A-Z]/.test(line)) {
      if (!/^\d+[\.\)]/.test(line)) return line.slice(0, 60);
    }
  }
  return "General";
}
function sleep(ms: number): Promise<void> { return new Promise((res) => setTimeout(res, ms)); }
function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

interface PageText { page: number; text: string; }
async function extractPages(pdfPath: string): Promise<PageText[]> {
  log(`Parsing PDF: ${pdfPath} (${(fs.statSync(pdfPath).size / 1024 / 1024).toFixed(2)} MB)`);
  const buffer = fs.readFileSync(pdfPath);
  log(`  Read ${buffer.length} bytes, extracting per-page text...`);
  try {
    const pdfParseModule: unknown = await import("pdf-parse");
    const mod = pdfParseModule as Record<string, unknown>;
    const PDFParseClass = (mod.PDFParse ?? mod.default) as unknown as new (opts: unknown) => {
      getText: () => Promise<{ text: string; pages: Array<{ num: number; text: string }> }>;
      destroy: () => Promise<void>;
    };
    if (typeof PDFParseClass === "function" && PDFParseClass.name === "PDFParse") {
      log(`  Using pdf-parse v2 (PDFParse)`);
      const parser = new (PDFParseClass as new (opts: { data: Uint8Array }) => { getText: () => Promise<{ text: string; pages: Array<{ text: string; num: number }> }>; destroy: () => Promise<void> })({ data: new Uint8Array(buffer) });
      const instance = parser as unknown as { getText: () => Promise<{ text: string; pages: Array<{ text: string; num: number }> }>; destroy: () => Promise<void> };
      const result = await instance.getText();
      await instance.destroy();
      const pages: PageText[] = result.pages.map((p) => ({ page: p.num, text: p.text ?? "" })).filter((p) => p.text.trim().length > 0);
      log(`  Extracted ${pages.length} pages via pdf-parse v2, total chars: ${result.text.length}`);
      if (pages.length === 0) throw new Error("No pages extracted");
      return pages;
    }
    const pdfFunc = (mod.default ?? mod) as (buf: Buffer, opts?: unknown) => Promise<{ text: string; numpages: number }>;
    if (typeof pdfFunc === "function") {
      log(`  Using pdf-parse v1 function API`);
      const pages: PageText[] = [];
      const data = await pdfFunc(buffer, {
        pagerender: async (pageData: { getTextContent: (opts?: unknown) => Promise<{ items: Array<{ str: string }> }> }) => {
          const c = await pageData.getTextContent({ normalizeWhitespace: true } as unknown);
          let t = "";
          for (const it of c.items as Array<{ str?: string }>) if (it.str) t += it.str + " ";
          pages.push({ page: pages.length + 1, text: t });
          return t;
        },
      } as unknown);
      if (pages.length > 0) {
        log(`  Extracted ${pages.length} pages via pagerender, total chars: ${data.text.length}`);
        return pages.filter((p) => p.text.trim().length > 0);
      }
      const combined: string = data.text ?? "";
      const numpages: number = (data as unknown as { numpages?: number }).numpages ?? Math.ceil(combined.length / 3000);
      const approx = Math.ceil(combined.length / numpages);
      const fallback: PageText[] = [];
      for (let i = 0; i < numpages; i++) {
        const s = combined.slice(i * approx, (i + 1) * approx);
        if (s.trim()) fallback.push({ page: i + 1, text: s });
      }
      return fallback;
    }
    throw new Error("Unrecognized pdf-parse module");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`  pdf-parse failed: ${msg} — trying unpdf fallback...`);
    try {
      const unpdfMod = await import("unpdf") as unknown as Record<string, unknown>;
      const fn = (unpdfMod.extractText ?? (unpdfMod.default as Record<string, unknown>)?.extractText) as ((buf: Uint8Array, opts?: unknown) => Promise<{ text: string[] }>) | undefined;
      if (fn) {
        const r = await fn(new Uint8Array(buffer), { mergePages: false } as unknown);
        const texts: string[] = (r.text as unknown as string[]) ?? [];
        const pages: PageText[] = texts.map((t, idx) => ({ page: idx + 1, text: t })).filter((p) => p.text.trim().length > 0);
        log(`  unpdf extracted ${pages.length} pages`);
        if (pages.length > 0) return pages;
      }
    } catch (e2) { log(`  unpdf also failed: ${e2 instanceof Error ? e2.message : String(e2)}`); }
    throw new Error(`PDF extraction failed: ${msg}`);
  }
}

interface Chunk {
  text: string;
  metadata: { page: number; section: string; chunkIndex: number; source: string; };
}

async function createChunks(pages: PageText[], sourceFileName: string): Promise<Chunk[]> {
  log(`Chunking ${pages.length} pages (chunkSize=${CHUNK_SIZE}, overlap=${CHUNK_OVERLAP})`);
  let RecursiveCharacterTextSplitter: new (opts: { chunkSize: number; chunkOverlap: number; separators: string[] }) => { splitText: (t: string) => Promise<string[]> };
  try {
    const mod = await import("@langchain/textsplitters");
    RecursiveCharacterTextSplitter = (mod as unknown as { RecursiveCharacterTextSplitter: typeof RecursiveCharacterTextSplitter }).RecursiveCharacterTextSplitter;
    log(`  Using @langchain/textsplitters`);
  } catch {
    log(`  @langchain/textsplitters not found, trying langchain/text_splitter`);
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore - legacy fallback path, may not have types
    const mod2 = await import("langchain/text_splitter" as string) as unknown as Record<string, unknown>;
    RecursiveCharacterTextSplitter = mod2.RecursiveCharacterTextSplitter as unknown as typeof RecursiveCharacterTextSplitter;
    if (!RecursiveCharacterTextSplitter) throw new Error("RecursiveCharacterTextSplitter not found");
    log(`  Using langchain/text_splitter`);
  }
  const splitter = new RecursiveCharacterTextSplitter({ chunkSize: CHUNK_SIZE, chunkOverlap: CHUNK_OVERLAP, separators: ["\n\n", "\n", " ", ""] });
  const all: Chunk[] = [];
  let gi = 0;
  for (const { page, text } of pages) {
    const trimmed = text.trim();
    if (!trimmed || trimmed.length < 10) continue;
    let sections: Array<{ section: string; text: string }>;
    const headerRegex = new RegExp(`\\n\\s*(?=(${KNOWN_HEADINGS.map((h) => h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b)`, "gi");
    const matches = [...trimmed.matchAll(headerRegex)];
    if (matches.length >= 1 && matches.length <= 10) {
      const idxs: number[] = matches.map((m) => m.index ?? 0);
      idxs.push(trimmed.length);
      sections = [];
      for (let i = 0; i < idxs.length - 1; i++) {
        const slice = trimmed.slice(idxs[i], idxs[i + 1]).trim();
        if (!slice) continue;
        sections.push({ section: detectSection(slice), text: slice });
      }
      if (sections.length === 0) sections = [{ section: detectSection(trimmed), text: trimmed }];
    } else {
      sections = [{ section: detectSection(trimmed), text: trimmed }];
    }
    for (const { section, text: secText } of sections) {
      const splits = await splitter.splitText(secText);
      for (const c of splits) {
        const clean = c.trim();
        if (!clean || clean.length < 20) continue;
        all.push({ text: clean, metadata: { page, section, chunkIndex: gi++, source: sourceFileName } });
      }
    }
  }
  log(`  Created ${all.length} chunks (avg ${Math.round(all.reduce((a, c) => a + c.text.length, 0) / Math.max(1, all.length))} chars/chunk)`);
  if (all[0]) log(`  Sample[0] page=${all[0].metadata.page} section="${all[0].metadata.section}" len=${all[0].text.length} preview="${all[0].text.slice(0, 160).replace(/\s+/g, " ")}..."`);
  return all;
}

async function embedChunks(chunks: Chunk[], batchSize: number, dryRun: boolean): Promise<number[][] | null> {
  if (dryRun) {
    log(`[dry-run] Skipping embeddings (${chunks.length} chunks, ${Math.ceil(chunks.length / batchSize)} batches)`);
    return null;
  }
  const apiKey = getEnv("OPENAI_API_KEY");
  if (!apiKey) throw new Error("Missing OPENAI_API_KEY (or use --dry-run)");
  const { default: OpenAI } = await import("openai");
  const client = new OpenAI({ apiKey, timeout: 60_000, maxRetries: 2 });
  log(`Embedding ${chunks.length} chunks via ${EMBEDDING_MODEL} in batches of ${batchSize}`);
  const all: number[][] = [];
  const total = Math.ceil(chunks.length / batchSize);
  const t0 = Date.now();
  for (let b = 0; b < total; b++) {
    const s = b * batchSize, e = Math.min(s + batchSize, chunks.length);
    const inputs = chunks.slice(s, e).map((c) => c.text);
    log(`  Batch ${b + 1}/${total}: ${s}–${e - 1} (${inputs.length} texts)...`);
    const bt0 = Date.now();
    try {
      const ctrl = new AbortController();
      const tid = setTimeout(() => ctrl.abort(), 120_000);
      const res = await client.embeddings.create({ model: EMBEDDING_MODEL, input: inputs }, { signal: ctrl.signal } as unknown as Record<string, unknown>);
      clearTimeout(tid);
      if (!res.data || res.data.length !== inputs.length) throw new Error(`OpenAI returned ${res.data?.length} for ${inputs.length}`);
      const sorted = [...res.data].sort((a, b) => a.index - b.index);
      for (const it of sorted) {
        if (!it.embedding?.length) throw new Error(`Empty embedding at ${it.index}`);
        all.push(it.embedding);
      }
      log(`    ✓ batch ${b + 1} in ${((Date.now() - bt0) / 1000).toFixed(1)}s tokens=${res.usage?.total_tokens ?? 0}`);
      if (b < total - 1) await sleep(250);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("abort") || msg.includes("timeout")) {
        log(`    ✗ timeout — retrying batch ${b + 1} after 2s...`);
        await sleep(2000);
        try {
          const r2 = await client.embeddings.create({ model: EMBEDDING_MODEL, input: inputs });
          for (const it of [...r2.data].sort((a, b) => a.index - b.index)) all.push(it.embedding);
          log(`    ✓ retry ok`);
          if (b < total - 1) await sleep(250);
          continue;
        } catch (e2) { throw new Error(`Batch ${b + 1} failed after retry: ${e2 instanceof Error ? e2.message : String(e2)}`); }
      }
      if (msg.includes("429") || msg.includes("rate")) { log(`    ⚠ 429 — backoff 5s`); await sleep(5000); b--; continue; }
      throw new Error(`Batch ${b + 1} failed: ${msg}`);
    }
  }
  log(`All embeddings done: ${all.length} vectors in ${((Date.now() - t0) / 1000).toFixed(1)}s dim=${all[0]?.length ?? 0}`);
  return all;
}

// ---------------------------------------------------------------------------
// Local persist — try Chroma server, always write JSON fallback
// ---------------------------------------------------------------------------
interface LocalStore {
  collection: string;
  embedding_model: string;
  created_at: string;
  count: number;
  chunks: Array<{ id: string; text: string; embedding: number[] | null; metadata: Chunk["metadata"] }>;
}

async function persistLocal(
  chunks: Chunk[],
  embeddings: number[][] | null,
  collectionName: string,
  sourceFileName: string,
  dryRun: boolean
): Promise<void> {
  if (!fs.existsSync(LOCAL_DIR)) {
    fs.mkdirSync(LOCAL_DIR, { recursive: true });
    log(`Created local dir: ${LOCAL_DIR}`);
  }

  // Always write .gitkeep if not exists (so dir is tracked but not PDFs)
  const gitkeep = path.join(LOCAL_DIR, ".gitkeep");
  if (!fs.existsSync(gitkeep)) fs.writeFileSync(gitkeep, "");

  if (dryRun || !embeddings) {
    log(`[dry-run] Would write ${chunks.length} chunks to ${LOCAL_JSON} (skipped)`);
    log(`[dry-run] Would also attempt Chroma local upsert if server at http://localhost:8000`);
    if (chunks[0]) {
      const c = chunks[0];
      const id = hashId(c.text, c.metadata.page, c.metadata.chunkIndex, sourceFileName);
      console.log(JSON.stringify({ id, metadata: c.metadata, preview: c.text.slice(0, 120) }, null, 2));
    }
    return;
  }

  // Build JSON store
  const store: LocalStore = {
    collection: collectionName,
    embedding_model: EMBEDDING_MODEL,
    created_at: new Date().toISOString(),
    count: chunks.length,
    chunks: chunks.map((c, i) => ({
      id: hashId(c.text, c.metadata.page, c.metadata.chunkIndex, sourceFileName),
      text: c.text,
      embedding: embeddings[i] ?? null,
      metadata: c.metadata,
    })),
  };

  // 1) Write JSON fallback (always) — this is the "offline dev without Chroma Cloud" artifact
  fs.writeFileSync(LOCAL_JSON, JSON.stringify(store, null, 2), "utf-8");
  log(`Wrote local JSON store: ${LOCAL_JSON} (${(fs.statSync(LOCAL_JSON).size / 1024).toFixed(1)} KB, ${store.count} chunks)`);

  // Also write a smaller manifest for quick inspection
  const manifest = path.join(LOCAL_DIR, "manifest.json");
  fs.writeFileSync(manifest, JSON.stringify({ collection: collectionName, embedding_model: EMBEDDING_MODEL, count: store.count, created_at: store.created_at, source: sourceFileName }, null, 2));
  log(`Wrote manifest: ${manifest}`);

  // 2) Try Chroma local server (http://localhost:8000) — optional, best-effort
  log(`Attempting local Chroma server upsert at http://localhost:8000 (optional) — will succeed if 'chroma run --path ./chroma_db' is running...`);
  try {
    const chromaMod = await import("chromadb");
    const { ChromaClient } = chromaMod as unknown as { ChromaClient: new (opts?: Record<string, unknown>) => { getOrCreateCollection: (o: unknown) => Promise<{ upsert: (a: unknown) => Promise<void>; count: () => Promise<number> }>; heartbeat: () => Promise<number> } };
    const client = new ChromaClient({} as Record<string, unknown>); // defaults to localhost:8000
    // Quick heartbeat to check if server is up (with timeout)
    const hbPromise = client.heartbeat();
    const timeoutPromise = new Promise<never>((_, rej) => setTimeout(() => rej(new Error("heartbeat timeout (3s) — no local Chroma server running)")), 3000));
    await Promise.race([hbPromise, timeoutPromise]);
    log(`  Chroma local server reachable ✓`);

    const collection = await (client as unknown as { getOrCreateCollection: (o: unknown) => Promise<{ upsert: (a: unknown) => Promise<void>; count: () => Promise<number> }> }).getOrCreateCollection({
      name: collectionName,
      metadata: { embedding_model: EMBEDDING_MODEL } as unknown,
    });
    log(`  Got/created local collection "${collectionName}"`);

    // Upsert in batches (local doesn't need such small batches but keep consistent)
    const batchSize = 100;
    const total = Math.ceil(chunks.length / batchSize);
    for (let b = 0; b < total; b++) {
      const s = b * batchSize, e = Math.min(s + batchSize, chunks.length);
      const batchChunks = chunks.slice(s, e);
      const batchEmbeddings = embeddings.slice(s, e);
      const ids = batchChunks.map((c) => hashId(c.text, c.metadata.page, c.metadata.chunkIndex, sourceFileName));
      const documents = batchChunks.map((c) => c.text);
      const metadatas = batchChunks.map((c) => ({ ...c.metadata } as Record<string, unknown>));
      log(`  Local Chroma upsert batch ${b + 1}/${total} (${s}–${e - 1})...`);
      await collection.upsert({ ids, documents, embeddings: batchEmbeddings, metadatas });
      log(`    ✓ batch ${b + 1} done`);
      if (b < total - 1) await sleep(100);
    }
    const count = await collection.count();
    log(`  Local Chroma collection count: ${count}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`  Local Chroma server not available or upsert failed: ${msg}`);
    log(`  → That's OK for offline dev! JSON fallback at ${LOCAL_JSON} is authoritative for local prototyping.`);
    log(`  → To use Chroma local server: pip install chromadb && chroma run --path ./chroma_db`);
    log(`     or: docker run -p 8000:8000 -v ./chroma_db:/chroma/chroma chromadb/chroma`);
  }
}

async function verifyLocal(
  chunks: Chunk[],
  embeddings: number[][] | null,
  dryRun: boolean,
  skipVerify: boolean
): Promise<void> {
  if (dryRun || skipVerify || !embeddings) { log(`Skipping local verification`); return; }
  const apiKey = getEnv("OPENAI_API_KEY");
  if (!apiKey) { log(`Skipping verification — no OPENAI_API_KEY`); return; }
  log(`\nLocal verification: cosine search for "${TEST_QUERY}" over ${chunks.length} local chunks (brute-force)...`);
  try {
    const { default: OpenAI } = await import("openai");
    const client = new OpenAI({ apiKey });
    const res = await client.embeddings.create({ model: EMBEDDING_MODEL, input: TEST_QUERY });
    const qEmb = res.data[0]?.embedding;
    if (!qEmb) throw new Error("No query embedding");

    const scored = chunks.map((c, i) => ({
      chunk: c,
      score: cosineSimilarity(qEmb, embeddings[i]),
    })).sort((a, b) => b.score - a.score).slice(0, 5);

    console.log(`\n  Top-5 local results for: "${TEST_QUERY}"`);
    console.log("  " + "-".repeat(72));
    scored.forEach((s, idx) => {
      console.log(`  #${idx + 1}  cosine=${s.score.toFixed(4)}  page=${s.chunk.metadata.page}  section="${s.chunk.metadata.section}"`);
      console.log(`      "${s.chunk.text.slice(0, 280).replace(/\s+/g, " ")}..."`);
      console.log(`      meta: ${JSON.stringify(s.chunk.metadata)}`);
      console.log("");
    });
    console.log("  " + "-".repeat(72));
    const hasWeber = scored.some((s) => /weber|bureaucracy/i.test(s.chunk.text));
    if (hasWeber) log(`  ✅ Local verification PASSED: top-k contains Weber/bureaucracy`);
    else log(`  ⚠ Local verification WARNING: top-k lacks Weber/bureaucracy — check PDF or chunking`);
  } catch (err) {
    console.warn(`  Local verification failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function main(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2));
  if (cli.help) { printHelp(); process.exit(0); }
  printLocalWarnings();

  const pdfPath = resolvePdfPath(cli.pdfPath);
  const source = path.basename(pdfPath);
  const collection = cli.collection ?? getEnv("CHROMA_COLLECTION") ?? DEFAULT_COLLECTION;
  const batchSize = cli.batchSize > 0 && cli.batchSize <= 200 ? cli.batchSize : EMBED_BATCH_SIZE;

  log(`Local ingest starting — dryRun=${cli.dryRun} pdf="${pdfPath}" collection="${collection}" batchSize=${batchSize}`);
  log(`  Node ${process.version} cwd=${process.cwd()}`);
  log(`  Local dir: ${LOCAL_DIR}`);

  if (!cli.dryRun && !getEnv("OPENAI_API_KEY")) {
    console.error(`\n✗ Missing OPENAI_API_KEY (or run with --dry-run)`);
    process.exit(1);
  }

  const t0 = Date.now();
  let pages: PageText[];
  try { pages = await extractPages(pdfPath); }
  catch (err) { console.error(`\n✗ PDF extraction failed: ${err instanceof Error ? err.message : String(err)}`); process.exit(1); }
  if (pages.length === 0) { console.error("✗ No pages extracted"); process.exit(1); }

  let chunks: Chunk[];
  try { chunks = await createChunks(pages, source); }
  catch (err) { console.error(`\n✗ Chunking failed: ${err instanceof Error ? err.message : String(err)}`); process.exit(1); }
  if (chunks.length === 0) { console.error("✗ No chunks"); process.exit(1); }

  if (cli.dryRun) {
    const totalChars = chunks.reduce((a, c) => a + c.text.length, 0);
    const estTokens = Math.ceil(totalChars / 4);
    log(`\n[dry-run] WOULD embed ${chunks.length} chunks → ${LOCAL_JSON}`);
    log(`[dry-run] Total chars=${totalChars} est tokens≈${estTokens} est cost≈$${((estTokens / 1_000_000) * 0.02).toFixed(4)}`);
    log(`[dry-run] Done — no API calls. Run without --dry-run to ingest locally.`);
    process.exit(0);
  }

  let embeddings: number[][] | null = null;
  try { embeddings = await embedChunks(chunks, batchSize, false); }
  catch (err) { console.error(`\n✗ Embedding failed: ${err instanceof Error ? err.message : String(err)}`); process.exit(1); }

  try { await persistLocal(chunks, embeddings, collection, source, false); }
  catch (err) { console.error(`\n✗ Local persist failed: ${err instanceof Error ? err.message : String(err)}`); process.exit(1); }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  log(`\n✅ Local ingest complete in ${elapsed}s — ${chunks.length} chunks → ${LOCAL_DIR} (collection "${collection}", model ${EMBEDDING_MODEL})`);
  log(`   Pages=${pages.length} Chunks=${chunks.length} AvgLen=${Math.round(chunks.reduce((a, c) => a + c.text.length, 0) / chunks.length)} chars`);

  await verifyLocal(chunks, embeddings, false, cli.skipVerify);
  log(`\nDone. Local store at ${LOCAL_JSON}`);
  log(`To query locally without Cloud, load ${LOCAL_JSON} or start chroma server: chroma run --path ./chroma_db`);
}

main().catch((err) => {
  console.error(`\n✗ Unhandled: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
});
