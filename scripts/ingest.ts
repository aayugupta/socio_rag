#!/usr/bin/env tsx
/**
 * Offline ingestion pipeline — scripts/ingest.ts:1
 * Implements Architecture Diagram: [PDF] → [LangChain RecursiveCharacterTextSplitter] → [OpenAI Embeddings] → [Chroma Cloud ingest]
 * Deliberately run OFFLINE / locally — never on Vercel (see Architecture §2, PRD A.1).
 *
 * Usage:
 *   npm run ingest              # full ingest to Chroma Cloud
 *   npm run ingest:dry-run      # parse + split only, no embedding/upsert
 *   npx tsx scripts/ingest.ts --help
 *   npx tsx scripts/ingest.ts --dry-run --pdf ./data/Sociology.pdf
 *
 * Env (via .env.local or .env):
 *   OPENAI_API_KEY=sk-...
 *   CHROMA_API_KEY=...
 *   CHROMA_TENANT=...
 *   CHROMA_DATABASE=...
 *   CHROMA_COLLECTION=sociology   # default if unset
 */

// ---------------------------------------------------------------------------
// Env loading (must be first)
// ---------------------------------------------------------------------------
import * as dotenv from "dotenv";
import * as path from "path";
import * as fs from "fs";
import { createHash } from "crypto";

// Load .env.local first (preferred) then .env fallback — dotenv does not override existing vars by default
dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });
dotenv.config({ path: path.resolve(process.cwd(), ".env") });

// ---------------------------------------------------------------------------
// Constants — PRD A.1: 500-800 chars, 15-20% overlap. Architecture ADR-2 model.
// ---------------------------------------------------------------------------
const EMBEDDING_MODEL = "text-embedding-3-small" as const;
const CHUNK_SIZE = 700;
const CHUNK_OVERLAP = 120; // ~17%
const EMBED_BATCH_SIZE = 100;
const UPSERT_BATCH_SIZE = 100;
const TEST_QUERY = "What does Nishant Sir say about Weber's bureaucracy?";
const DEFAULT_COLLECTION = "sociology";
const DEFAULT_PDF_REL = path.join("data", "Sociology.pdf");
const FALLBACK_PDF_WIN = `C:\\Users\\aarad\\Downloads\\_Handouts_Sociology2024byNishantSir_LevelupIAS_KING_R_QUEEN_P.PDF`;

// Known sociology headers for structure-aware splitting (PRD A.1)
const KNOWN_HEADINGS = [
  "Weber",
  "Marx",
  "Durkheim",
  "Comte",
  "Spencer",
  "Parsons",
  "Merton",
  "Mead",
  "Goffman",
  "Bourdieu",
  "Foucault",
  "Functionalism",
  "Conflict Theory",
  "Symbolic Interactionism",
  "Structural Functionalism",
  "Social Stratification",
  "Bureaucracy",
  "Religion",
  "Education",
  "Family",
  "Kinship",
  "Social Change",
  "Auguste Comte",
  "Karl Marx",
  "Max Weber",
  "Emile Durkheim",
  "Talcott Parsons",
  "Robert Merton",
];

// ---------------------------------------------------------------------------
// ADR warnings — must be loud (Architecture ADR-2)
// ---------------------------------------------------------------------------
function printAdrWarnings(): void {
  console.warn("\n" + "=".repeat(80));
  console.warn("⚠️  ADR-2 WARNING: You must re-embed ENTIRE document if you change embedding model — never mix models!");
  console.warn(`   Current embedding model: ${EMBEDDING_MODEL} (OpenAI, 1536 dims, cosine)`);
  console.warn("   Query-time embeddings MUST use the same model. Vectors from different models are NOT comparable — silent retrieval failure.");
  console.warn("   If you switch models, delete the Chroma collection and re-ingest from scratch.");
  console.warn("=".repeat(80) + "\n");

  console.warn("⚠️  ADR-1 NOTE: Chroma Cloud is the hosted vector DB for Vercel. Do NOT commit ./chroma_db or local persist files.");
  console.warn("   Ingestion is OFFLINE only — never run on Vercel (timeout + ephemeral FS). Run locally or via manual GitHub Action.");
  console.warn("=".repeat(80) + "\n");
}

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------
interface CliArgs {
  dryRun: boolean;
  help: boolean;
  pdfPath: string | null;
  collection: string | null;
  batchSize: number;
  skipVerify: boolean;
  verbose: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    dryRun: false,
    help: false,
    pdfPath: null,
    collection: null,
    batchSize: EMBED_BATCH_SIZE,
    skipVerify: false,
    verbose: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run" || a === "-d") args.dryRun = true;
    else if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--pdf" && argv[i + 1]) { args.pdfPath = argv[++i]; }
    else if (a.startsWith("--pdf=")) args.pdfPath = a.split("=")[1];
    else if (a === "--collection" && argv[i + 1]) { args.collection = argv[++i]; }
    else if (a.startsWith("--collection=")) args.collection = a.split("=")[1];
    else if (a === "--batch-size" && argv[i + 1]) args.batchSize = parseInt(argv[++i], 10);
    else if (a === "--skip-verify") args.skipVerify = true;
    else if (a === "--verbose" || a === "-v") args.verbose = true;
  }
  // Also check env-style dry-run via npm script
  if (process.argv.includes("--dry-run")) args.dryRun = true;
  return args;
}

function printHelp(): void {
  console.log(`
Sociology RAG — Offline Ingestion Pipeline (Chroma Cloud)
==========================================================
Architecture: PDF → RecursiveCharacterTextSplitter (700/120) → OpenAI ${EMBEDDING_MODEL} → Chroma Cloud

Usage:
  npx tsx scripts/ingest.ts [options]
  npm run ingest              # full ingest
  npm run ingest:dry-run      # parse + split, no API calls
  npm run ingest -- --pdf ./data/Sociology.pdf

Options:
  --pdf <path>          PDF path (default: ./data/Sociology.pdf, fallback: Downloads original)
  --collection <name>   Chroma collection name (default: env CHROMA_COLLECTION or "sociology")
  --dry-run             Parse + chunk only — skip embeddings + upsert + verification (free, no API keys needed)
  --batch-size <n>      Embedding batch size (default: 100)
  --skip-verify         Skip post-ingest test query
  --verbose             Extra logging
  --help                Show this help

Env (.env.local or .env):
  OPENAI_API_KEY        Required (unless --dry-run)
  CHROMA_API_KEY        Required (unless --dry-run)
  CHROMA_TENANT         Optional (Chroma Cloud tenant)
  CHROMA_DATABASE       Optional (Chroma Cloud database)
  CHROMA_COLLECTION     Optional (default: sociology)

Steps:
  1. Parse PDF per page (pdf-parse, preserve page numbers)
  2. Structure-aware detect headers (Weber/Marx/Functionalism) + RecursiveCharacterTextSplitter 700/120
  3. Embed batches of 100 via OpenAI ${EMBEDDING_MODEL}
  4. Upsert to Chroma Cloud (id=sha256 hash, document, embedding, metadata {page, section, chunkIndex, source})
  5. Verify: test query "${TEST_QUERY}" top-5

Warnings (ADR-1/ADR-2):
  - Never mix embedding models — re-embed entire doc if you change model.
  - Never run this on Vercel — offline only (large PDF timeout).

Examples:
  npx tsx scripts/ingest.ts --dry-run
  npx tsx scripts/ingest.ts --pdf ./data/Sociology.pdf --collection sociology
`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
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
    const resolved = path.resolve(cliPdf);
    if (fs.existsSync(resolved)) return resolved;
    throw new Error(`PDF not found at CLI path: ${resolved}`);
  }
  const primary = path.resolve(process.cwd(), DEFAULT_PDF_REL);
  if (fs.existsSync(primary)) return primary;
  if (fs.existsSync(FALLBACK_PDF_WIN)) {
    log(`Primary PDF not found at ${primary}, falling back to Downloads original (22MB)`);
    return FALLBACK_PDF_WIN;
  }
  throw new Error(
    `PDF not found. Looked at:\n  1) ${primary} (place your PDF here as ./data/Sociology.pdf)\n  2) ${FALLBACK_PDF_WIN}\n` +
    `Fix: copy the PDF to ./data/Sociology.pdf or pass --pdf <path>`
  );
}

function hashId(text: string, page: number, chunkIndex: number, source: string): string {
  // Deterministic hash: text + page + index + source — truncated sha256
  const h = createHash("sha256");
  h.update(`${source}::${page}::${chunkIndex}::${text.slice(0, 200)}::${text.length}`);
  return h.digest("hex").slice(0, 32);
}

function detectSection(text: string): string {
  const lower = text.toLowerCase();
  for (const heading of KNOWN_HEADINGS) {
    if (lower.includes(heading.toLowerCase())) {
      return heading;
    }
  }
  // Fallback: detect ALL CAPS header-like line (>=5 chars, mostly uppercase)
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  for (const line of lines.slice(0, 3)) {
    if (line.length >= 5 && line.length <= 80 && /^[A-Z0-9 \(\)\-\/&.,:]+$/.test(line) && /[A-Z]/.test(line)) {
      // Avoid false positives like numbered lists
      if (!/^\d+[\.\)]/.test(line)) return line.slice(0, 60);
    }
  }
  return "General";
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

// ---------------------------------------------------------------------------
// PDF parsing — pdf-parse v2 (PDFParse class) with fallback
// ---------------------------------------------------------------------------
interface PageText {
  page: number;
  text: string;
}

async function extractPages(pdfPath: string): Promise<PageText[]> {
  log(`Parsing PDF: ${pdfPath} (${(fs.statSync(pdfPath).size / 1024 / 1024).toFixed(2)} MB)`);
  const buffer = fs.readFileSync(pdfPath);
  log(`  Read ${buffer.length} bytes, extracting per-page text (may take 10-30s for 22MB PDF)...`);

  // Try pdf-parse v2 API (PDFParse class) first
  try {
    const pdfParseModule: unknown = await import("pdf-parse");
    // pdf-parse v2 exports PDFParse; v1 exports a function; handle both
    const mod = pdfParseModule as Record<string, unknown>;
    const PDFParseClass = (mod.PDFParse ?? mod.default) as unknown as new (opts: unknown) => {
      getText: (params?: unknown) => Promise<{ text: string; pages: Array<{ num: number; text: string }> }>;
      destroy: () => Promise<void>;
    };

    if (typeof PDFParseClass === "function" && PDFParseClass.name === "PDFParse") {
      log(`  Using pdf-parse v2 (PDFParse class)`);
      const parser = new (PDFParseClass as new (opts: { data: Uint8Array }) => typeof PDFParseClass extends new (opts: unknown) => infer T ? T : never)({ data: new Uint8Array(buffer) });
      // We need to construct with data
      // Type workaround: pdf-parse v2 expects { data: Uint8Array } or { url }
      const instance = parser as unknown as { getText: () => Promise<{ text: string; pages: Array<{ text: string; num: number }> }>; destroy: () => Promise<void> };
      const result = await instance.getText();
      await instance.destroy();
      const pages: PageText[] = result.pages
        .map((p) => ({ page: p.num, text: p.text ?? "" }))
        .filter((p) => p.text.trim().length > 0);
      log(`  Extracted ${pages.length} pages via pdf-parse v2, total chars: ${result.text.length}`);
      if (pages.length === 0) throw new Error("No pages extracted — PDF may be scanned/image-only (check PRD §1.9)");
      return pages;
    }

    // Fallback: pdf-parse v1 function export: pdf(buffer, options).then(data => data.text)
    // v1 style: const pdf = require('pdf-parse'); const data = await pdf(buffer, { pagerender })
    if (typeof mod.default === "function" || typeof mod === "function") {
      const pdfFunc = (mod.default ?? mod) as (buf: Buffer, opts?: unknown) => Promise<{ text: string; numpages: number }>;
      log(`  Using pdf-parse v1 function API (pagerender per page)`);
      const pages: PageText[] = [];
      const data = await pdfFunc(buffer, {
        // pagerender captures per-page text for metadata
        pagerender: async (pageData: { getTextContent: (o?: unknown) => Promise<{ items: Array<{ str: string }> }> }) => {
          const content = await pageData.getTextContent({ normalizeWhitespace: true } as unknown);
          let txt = "";
          for (const item of content.items as Array<{ str?: string }>) {
            if (item.str) txt += item.str + " ";
          }
          pages.push({ page: pages.length + 1, text: txt });
          return txt;
        },
      } as unknown);
      if (pages.length > 0) {
        log(`  Extracted ${pages.length} pages via pagerender, total chars: ${data.text.length}`);
        return pages.filter((p) => p.text.trim().length > 0);
      }
      // If pagerender didn't populate (some versions), split combined text roughly
      log(`  pagerender did not populate, falling back to combined text heuristic`);
      const combined: string = data.text ?? "";
      // Heuristic: split by form-feed or assume average chars per page
      const numpages: number = (data as unknown as { numpages?: number }).numpages ?? Math.max(1, Math.ceil(combined.length / 3000));
      const approxPerPage = Math.ceil(combined.length / numpages);
      const fallbackPages: PageText[] = [];
      for (let i = 0; i < numpages; i++) {
        const slice = combined.slice(i * approxPerPage, (i + 1) * approxPerPage);
        if (slice.trim()) fallbackPages.push({ page: i + 1, text: slice });
      }
      return fallbackPages;
    }

    throw new Error("Unrecognized pdf-parse module shape");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Try unpdf as secondary fallback if pdf-parse failed
    log(`  pdf-parse extraction failed: ${msg} — trying unpdf fallback if available...`);
    try {
      const unpdfMod = await import("unpdf") as unknown as Record<string, unknown>;
      const extractTextFn = (unpdfMod.extractText ?? (unpdfMod.default as Record<string, unknown>)?.extractText) as
        | ((buf: Uint8Array, opts?: unknown) => Promise<{ text: string[]; totalPages?: number }>)
        | undefined;
      if (extractTextFn) {
        const result = await extractTextFn(new Uint8Array(buffer), { mergePages: false } as unknown);
        const texts: string[] = (result.text as unknown as string[]) ?? [];
        const pages: PageText[] = texts
          .map((t, idx) => ({ page: idx + 1, text: t }))
          .filter((p) => p.text.trim().length > 0);
        log(`  unpdf extracted ${pages.length} pages`);
        if (pages.length > 0) return pages;
      }
    } catch (e2) {
      log(`  unpdf fallback also failed: ${e2 instanceof Error ? e2.message : String(e2)}`);
    }
    throw new Error(`PDF extraction failed (both pdf-parse and unpdf): ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// Chunking — structure-aware + RecursiveCharacterTextSplitter 700/120
// ---------------------------------------------------------------------------
interface Chunk {
  text: string;
  metadata: {
    page: number;
    section: string;
    chunkIndex: number;
    source: string;
  };
}

async function createChunks(pages: PageText[], sourceFileName: string): Promise<Chunk[]> {
  log(`Chunking ${pages.length} pages with RecursiveCharacterTextSplitter (chunkSize=${CHUNK_SIZE}, overlap=${CHUNK_OVERLAP})`);
  // Dynamic import to support both @langchain/textsplitters and legacy langchain
  let RecursiveCharacterTextSplitter: new (opts: { chunkSize: number; chunkOverlap: number; separators: string[] }) => { splitText: (t: string) => Promise<string[]> };
  try {
    const mod = await import("@langchain/textsplitters");
    RecursiveCharacterTextSplitter = (mod as unknown as { RecursiveCharacterTextSplitter: typeof RecursiveCharacterTextSplitter }).RecursiveCharacterTextSplitter;
    log(`  Using @langchain/textsplitters`);
  } catch {
    log(`  @langchain/textsplitters not found, trying langchain/text_splitter...`);
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore - legacy fallback path, may not have types
    const mod2 = await import("langchain/text_splitter" as string) as unknown as Record<string, unknown>;
    RecursiveCharacterTextSplitter = mod2.RecursiveCharacterTextSplitter as unknown as typeof RecursiveCharacterTextSplitter;
    if (!RecursiveCharacterTextSplitter) {
      throw new Error("RecursiveCharacterTextSplitter not found in either @langchain/textsplitters or langchain/text_splitter");
    }
    log(`  Using langchain/text_splitter`);
  }

  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: CHUNK_SIZE,
    chunkOverlap: CHUNK_OVERLAP,
    separators: ["\n\n", "\n", " ", ""],
  });

  const allChunks: Chunk[] = [];
  let globalIndex = 0;

  for (const { page, text } of pages) {
    const trimmed = text.trim();
    if (!trimmed) continue;
    if (trimmed.length < 10) continue; // skip near-empty pages (e.g., cover)

    // Optional structure-aware pre-split: detect if page contains a KNOWN_HEADINGS header line,
    // split on that header to avoid chunks straddling topics. We keep header with following content.
    // This is heuristic — if no headers found, we just split the whole page text.
    let sections: Array<{ section: string; text: string }>;
    const headerRegex = new RegExp(
      `\\n\\s*(?=(${KNOWN_HEADINGS.map((h) => h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b)`,
      "gi"
    );
    const headerMatches = [...trimmed.matchAll(headerRegex)];
    if (headerMatches.length >= 1 && headerMatches.length <= 10) {
      // Split by header positions, preserving header text
      const indices: number[] = headerMatches.map((m) => m.index ?? 0);
      indices.push(trimmed.length);
      sections = [];
      for (let i = 0; i < indices.length - 1; i++) {
        const start = indices[i];
        const end = indices[i + 1];
        const slice = trimmed.slice(start, end).trim();
        if (!slice) continue;
        const sec = detectSection(slice);
        sections.push({ section: sec, text: slice });
      }
      if (sections.length === 0) sections = [{ section: detectSection(trimmed), text: trimmed }];
    } else {
      sections = [{ section: detectSection(trimmed), text: trimmed }];
    }

    for (const { section, text: secText } of sections) {
      const splits = await splitter.splitText(secText);
      for (const chunkText of splits) {
        const clean = chunkText.trim();
        if (!clean || clean.length < 20) continue; // skip fragments
        allChunks.push({
          text: clean,
          metadata: {
            page,
            section,
            chunkIndex: globalIndex++,
            source: sourceFileName,
          },
        });
      }
    }
  }

  log(`  Created ${allChunks.length} chunks (avg ${(allChunks.reduce((a, c) => a + c.text.length, 0) / Math.max(1, allChunks.length)).toFixed(0)} chars/chunk)`);
  // Log sample
  if (allChunks.length > 0) {
    const sample = allChunks[0];
    log(`  Sample chunk[0] page=${sample.metadata.page} section="${sample.metadata.section}" len=${sample.text.length}`);
    log(`    preview: "${sample.text.slice(0, 180).replace(/\s+/g, " ")}..."`);
  }
  if (allChunks.length > 1) {
    const last = allChunks[allChunks.length - 1];
    log(`  Sample chunk[${allChunks.length - 1}] page=${last.metadata.page} section="${last.metadata.section}" len=${last.text.length}`);
  }
  // Suggest checking 10-15 chunks coherence (PRD A.1 action item)
  log(`  PRD A.1 check: inspect 10-15 chunks for coherence (mid-sentence fragments => adjust chunkSize/overlap)`);
  return allChunks;
}

// ---------------------------------------------------------------------------
// Embeddings — OpenAI text-embedding-3-small, batch 100, rate-limited, timeout-aware
// ---------------------------------------------------------------------------
async function embedChunks(
  chunks: Chunk[],
  batchSize: number,
  dryRun: boolean
): Promise<number[][] | null> {
  if (dryRun) {
    log(`[dry-run] Skipping embeddings (would embed ${chunks.length} chunks in ${Math.ceil(chunks.length / batchSize)} batches of ${batchSize})`);
    return null;
  }
  const apiKey = getEnv("OPENAI_API_KEY");
  if (!apiKey) throw new Error("Missing OPENAI_API_KEY (set in .env.local). Required for embeddings (skip with --dry-run)");

  const { default: OpenAI } = await import("openai");
  const client = new OpenAI({ apiKey, timeout: 60_000, maxRetries: 2 });

  log(`Embedding ${chunks.length} chunks via OpenAI ${EMBEDDING_MODEL} in batches of ${batchSize} (rate-limited, 100 at a time)`);

  const allEmbeddings: number[][] = [];
  const totalBatches = Math.ceil(chunks.length / batchSize);
  const t0 = Date.now();

  for (let b = 0; b < totalBatches; b++) {
    const start = b * batchSize;
    const end = Math.min(start + batchSize, chunks.length);
    const batch = chunks.slice(start, end);
    const inputs = batch.map((c) => c.text);

    log(`  Batch ${b + 1}/${totalBatches}: chunks ${start}–${end - 1} (${inputs.length} texts)...`);
    const batchT0 = Date.now();
    try {
      // Timeout guard per batch: 120s per 100 chunks (large PDF timeout gracefully)
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 120_000);
      const res = await client.embeddings.create(
        {
          model: EMBEDDING_MODEL,
          input: inputs,
        },
        { signal: controller.signal } as unknown as Record<string, unknown>
      );
      clearTimeout(timeoutId);

      if (!res.data || res.data.length !== inputs.length) {
        throw new Error(`OpenAI returned ${res.data?.length ?? 0} embeddings for ${inputs.length} inputs`);
      }
      // Ensure sorted by index (OpenAI returns index field)
      const sorted = [...res.data].sort((a, b) => a.index - b.index);
      for (const item of sorted) {
        if (!item.embedding || item.embedding.length === 0) throw new Error(`Empty embedding at index ${item.index}`);
        allEmbeddings.push(item.embedding);
      }
      const ms = Date.now() - batchT0;
      const tok = (res.usage?.total_tokens ?? 0);
      log(`    ✓ batch ${b + 1} done in ${(ms / 1000).toFixed(1)}s, tokens=${tok}, avg ${(tok / inputs.length).toFixed(0)} tok/chunk`);

      // Rate limiting: small pause between batches to avoid 429, especially for large PDF
      if (b < totalBatches - 1) {
        await sleep(250);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("abort") || msg.includes("timeout") || msg.includes("AbortError")) {
        log(`    ✗ batch ${b + 1} timed out after 120s — retrying once after 2s...`);
        await sleep(2000);
        try {
          const res2 = await client.embeddings.create({ model: EMBEDDING_MODEL, input: inputs });
          const sorted2 = [...res2.data].sort((a, b) => a.index - b.index);
          for (const item of sorted2) allEmbeddings.push(item.embedding);
          log(`    ✓ retry succeeded for batch ${b + 1}`);
          if (b < totalBatches - 1) await sleep(250);
          continue;
        } catch (e2) {
          throw new Error(`Batch ${b + 1} failed after retry: ${e2 instanceof Error ? e2.message : String(e2)} (original: ${msg})`);
        }
      }
      // Handle rate limit (429) with backoff
      if (msg.includes("429") || msg.includes("rate")) {
        log(`    ⚠ rate limited — backing off 5s then retrying batch ${b + 1}...`);
        await sleep(5000);
        b--; // retry same batch
        continue;
      }
      throw new Error(`Embedding batch ${b + 1}/${totalBatches} failed: ${msg}`);
    }
  }

  const totalMs = Date.now() - t0;
  log(`All embeddings complete: ${allEmbeddings.length} vectors in ${(totalMs / 1000).toFixed(1)}s (avg ${(totalMs / chunks.length).toFixed(0)} ms/chunk)`);
  if (allEmbeddings.length !== chunks.length) throw new Error(`Embedding count mismatch: ${allEmbeddings.length} vs ${chunks.length} chunks`);
  // Dimension check
  const dim = allEmbeddings[0]?.length ?? 0;
  log(`  Embedding dimension: ${dim} (${EMBEDDING_MODEL}) — if this changes, you MUST re-embed entire doc (ADR-2)`);
  return allEmbeddings;
}

// ---------------------------------------------------------------------------
// Chroma Cloud — upsert
// ---------------------------------------------------------------------------
async function getOrCreateChromaCollection(collectionName: string, dryRun: boolean): Promise<unknown> {
  if (dryRun) {
    log(`[dry-run] Skipping Chroma Cloud collection creation (would use collection="${collectionName}")`);
    return null;
  }
  const apiKey = getEnv("CHROMA_API_KEY");
  if (!apiKey) throw new Error("Missing CHROMA_API_KEY (set in .env.local for Chroma Cloud). Required unless --dry-run");
  const tenant = getEnv("CHROMA_TENANT");
  const database = getEnv("CHROMA_DATABASE");

  log(`Connecting to Chroma Cloud: collection="${collectionName}" tenant="${tenant ?? "(default)"}" database="${database ?? "(default)"}"`);
  const chromaMod = await import("chromadb");
  const { CloudClient } = chromaMod as unknown as { CloudClient: new (opts: unknown) => { getOrCreateCollection: (opts: unknown) => Promise<unknown>; getCollection: (opts: unknown) => Promise<unknown> } };
  if (!CloudClient) throw new Error("chromadb CloudClient not found — check chromadb version (expected 3.5.0)");

  const client = new CloudClient({ apiKey, tenant, database } as unknown as Record<string, unknown>);

  // Try getOrCreateCollection first (preferred for ingest), fallback to createCollection / getCollection
  try {
    const collection = await (client as unknown as { getOrCreateCollection: (o: unknown) => Promise<unknown> }).getOrCreateCollection({
      name: collectionName,
      // Do NOT pass embeddingFunction — we provide embeddings manually (precomputed OpenAI)
      // metadata embedding_model tag for ADR-2 traceability
      metadata: { embedding_model: EMBEDDING_MODEL, hnsw_space: "cosine" } as unknown,
    });
    log(`  ✓ Chroma collection ready: "${collectionName}"`);
    return collection;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`  getOrCreateCollection failed: ${msg} — trying getCollection fallback...`);
    try {
      const collection = await (client as unknown as { getCollection: (o: unknown) => Promise<unknown> }).getCollection({ name: collectionName });
      log(`  ✓ Got existing collection via fallback`);
      return collection;
    } catch (e2) {
      throw new Error(`Chroma Cloud collection "${collectionName}" not accessible: ${msg}; fallback also failed: ${e2 instanceof Error ? e2.message : String(e2)}`);
    }
  }
}

async function upsertToChroma(
  collection: unknown,
  chunks: Chunk[],
  embeddings: number[][] | null,
  sourceFileName: string,
  dryRun: boolean
): Promise<void> {
  if (dryRun || !embeddings || !collection) {
    log(`[dry-run] Skipping Chroma upsert (would upsert ${chunks.length} chunks with embeddings)`);
    log(`[dry-run] Example upsert payload (first chunk):`);
    if (chunks[0]) {
      const c = chunks[0];
      const fakeId = hashId(c.text, c.metadata.page, c.metadata.chunkIndex, sourceFileName);
      console.log(JSON.stringify({ id: fakeId, document: c.text.slice(0, 120) + "...", metadata: c.metadata }, null, 2));
    }
    return;
  }
  if (embeddings.length !== chunks.length) throw new Error(`Embeddings/chunks length mismatch at upsert`);

  const coll = collection as {
    upsert: (args: { ids: string[]; documents: string[]; embeddings: number[][]; metadatas: Record<string, unknown>[] }) => Promise<void>;
    count: () => Promise<number>;
  };

  const totalBatches = Math.ceil(chunks.length / UPSERT_BATCH_SIZE);
  log(`Upserting ${chunks.length} chunks to Chroma Cloud in ${totalBatches} batches of ${UPSERT_BATCH_SIZE}...`);

  for (let b = 0; b < totalBatches; b++) {
    const start = b * UPSERT_BATCH_SIZE;
    const end = Math.min(start + UPSERT_BATCH_SIZE, chunks.length);
    const batchChunks = chunks.slice(start, end);
    const batchEmbeddings = embeddings.slice(start, end);

    const ids = batchChunks.map((c) => hashId(c.text, c.metadata.page, c.metadata.chunkIndex, sourceFileName));
    const documents = batchChunks.map((c) => c.text);
    const metadatas = batchChunks.map((c) => ({ ...c.metadata } as Record<string, unknown>));

    log(`  Upsert batch ${b + 1}/${totalBatches}: ids ${start}–${end - 1}...`);
    try {
      await coll.upsert({ ids, documents, embeddings: batchEmbeddings, metadatas });
      log(`    ✓ batch ${b + 1} upserted`);
      if (b < totalBatches - 1) await sleep(150);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Chroma upsert batch ${b + 1} failed: ${msg}`);
    }
  }

  try {
    const count = await coll.count();
    log(`  Chroma collection count after upsert: ${count} (expected ~${chunks.length})`);
    if (count < chunks.length * 0.9) {
      console.warn(`  ⚠ count ${count} is notably less than chunks ${chunks.length} — check for id collisions or prior data`);
    }
  } catch {
    log(`  (count check skipped — collection.count() not available)`);
  }
}

// ---------------------------------------------------------------------------
// Verification — test query (PRD A.5 style)
// ---------------------------------------------------------------------------
async function verifyRetrieval(
  collectionName: string,
  dryRun: boolean,
  skipVerify: boolean
): Promise<void> {
  if (dryRun || skipVerify) {
    log(`Skipping verification (dryRun=${dryRun}, skipVerify=${skipVerify})`);
    return;
  }
  const apiKey = getEnv("OPENAI_API_KEY");
  const chromaKey = getEnv("CHROMA_API_KEY");
  if (!apiKey || !chromaKey) {
    log(`Skipping verification — missing OPENAI_API_KEY or CHROMA_API_KEY`);
    return;
  }
  log(`\nVerification: embedding test query and retrieving top-5 from Chroma Cloud...`);
  log(`  Query: "${TEST_QUERY}"`);

  try {
    const { default: OpenAI } = await import("openai");
    const openai = new OpenAI({ apiKey });
    const chromaMod = await import("chromadb");
    const { CloudClient } = chromaMod as unknown as { CloudClient: new (opts: unknown) => { getCollection: (opts: unknown) => Promise<{ query: (opts: unknown) => Promise<unknown> }> } };
    const tenant = getEnv("CHROMA_TENANT");
    const database = getEnv("CHROMA_DATABASE");
    const client = new CloudClient({ apiKey: chromaKey, tenant, database } as unknown as Record<string, unknown>);

    const embedRes = await openai.embeddings.create({ model: EMBEDDING_MODEL, input: TEST_QUERY });
    const queryEmbedding = embedRes.data[0]?.embedding;
    if (!queryEmbedding) throw new Error("No embedding for test query");

    const collection = await (client as unknown as { getCollection: (o: unknown) => Promise<{ query: (o: unknown) => Promise<{ documents: string[][]; metadatas: Record<string, unknown>[][]; distances: number[][]; ids: string[][] }> }> }).getCollection({ name: collectionName });

    // Use query with precomputed embedding
    const result = await collection.query({
      queryEmbeddings: [queryEmbedding],
      nResults: 5,
      include: ["documents", "metadatas", "distances"] as unknown as string[],
    });

    const docs: string[][] = (result as unknown as { documents: string[][] }).documents ?? [];
    const metas: Record<string, unknown>[][] = (result as unknown as { metadatas: Record<string, unknown>[][] }).metadatas ?? [];
    const dists: number[][] = (result as unknown as { distances: number[][] }).distances ?? [];
    const topDocs = docs[0] ?? [];
    const topMetas = metas[0] ?? [];
    const topDists = dists[0] ?? [];

    if (topDocs.length === 0) {
      console.warn("  ⚠ Verification: no results returned — collection may be empty or query failed");
      return;
    }

    console.log(`\n  Top-${topDocs.length} results for: "${TEST_QUERY}"`);
    console.log("  " + "-".repeat(72));
    for (let i = 0; i < topDocs.length; i++) {
      const dist = topDists[i];
      const sim = dist !== undefined && dist !== null ? (1 - Math.max(0, Math.min(2, dist))).toFixed(3) : "n/a";
      const meta = topMetas[i] ?? {};
      console.log(`  #${i + 1}  distance=${dist?.toFixed?.(4) ?? "n/a"}  similarity≈${sim}  page=${(meta as Record<string, unknown>).page ?? "?"}  section="${(meta as Record<string, unknown>).section ?? "?"}\"`);
      console.log(`      "${String(topDocs[i] ?? "").slice(0, 280).replace(/\s+/g, " ")}..."`);
      console.log(`      meta: ${JSON.stringify(meta)}`);
      console.log("");
    }
    console.log("  " + "-".repeat(72));
    const hasWeber = topDocs.some((d) => /weber|bureaucracy/i.test(d));
    if (hasWeber) log(`  ✅ Verification PASSED: top-k contains Weber/bureaucracy content`);
    else log(`  ⚠ Verification WARNING: top-k does not mention Weber/bureaucracy — check chunking or embedding model`);
  } catch (err) {
    console.warn(`  Verification failed: ${err instanceof Error ? err.message : String(err)}`);
    console.warn(`  (Ingest may still have succeeded — check Chroma Cloud dashboard)`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2));
  if (cli.help) {
    printHelp();
    process.exit(0);
  }

  printAdrWarnings();

  const pdfPath = resolvePdfPath(cli.pdfPath);
  const sourceFileName = path.basename(pdfPath);
  const collectionName = cli.collection ?? getEnv("CHROMA_COLLECTION") ?? DEFAULT_COLLECTION;
  const batchSize = cli.batchSize > 0 && cli.batchSize <= 200 ? cli.batchSize : EMBED_BATCH_SIZE;

  log(`Ingest starting — dryRun=${cli.dryRun} pdf="${pdfPath}" collection="${collectionName}" batchSize=${batchSize}`);
  log(`  Node ${process.version} cwd=${process.cwd()}`);
  log(`  CHROMA_TENANT=${getEnv("CHROMA_TENANT") ?? "(default)"} CHROMA_DATABASE=${getEnv("CHROMA_DATABASE") ?? "(default)"}`);

  if (!cli.dryRun) {
    if (!getEnv("OPENAI_API_KEY")) {
      console.error(`\n✗ Missing OPENAI_API_KEY — set in .env.local or .env (or run with --dry-run)`);
      process.exit(1);
    }
    if (!getEnv("CHROMA_API_KEY")) {
      console.error(`\n✗ Missing CHROMA_API_KEY — set in .env.local or .env (or run with --dry-run)`);
      process.exit(1);
    }
  }

  const tStart = Date.now();

  // 1. PDF → per-page text
  let pages: PageText[];
  try {
    pages = await extractPages(pdfPath);
  } catch (err) {
    console.error(`\n✗ PDF extraction failed: ${err instanceof Error ? err.message : String(err)}`);
    console.error(`  For large PDF (22MB), ensure Node has enough memory: NODE_OPTIONS=--max-old-space-size=4096`);
    process.exit(1);
  }
  if (pages.length === 0) {
    console.error("✗ No pages extracted — PDF may be scanned/image-only. Verify text extraction quality before build (PRD §1.9)");
    process.exit(1);
  }

  // 2. Pages → chunks (structure-aware + RecursiveCharacterTextSplitter)
  let chunks: Chunk[];
  try {
    chunks = await createChunks(pages, sourceFileName);
  } catch (err) {
    console.error(`\n✗ Chunking failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  if (chunks.length === 0) {
    console.error("✗ No chunks created — check splitter params or PDF text");
    process.exit(1);
  }

  // Dry-run summary and exit early before API calls
  if (cli.dryRun) {
    log(`\n[dry-run] WOULD embed ${chunks.length} chunks and upsert to Chroma collection "${collectionName}"`);
    log(`[dry-run] WOULD use model ${EMBEDDING_MODEL}, batches of ${batchSize}`);
    const totalChars = chunks.reduce((a, c) => a + c.text.length, 0);
    const estTokens = Math.ceil(totalChars / 4); // rough: ~4 chars/token
    const costPer1MTok = 0.02;
    const estCost = (estTokens / 1_000_000) * costPer1MTok;
    log(`[dry-run] Total chars=${totalChars}, est tokens≈${estTokens}, est embedding cost≈$${estCost.toFixed(4)} (at $0.02/1M tokens)`);
    log(`[dry-run] Sample IDs (sha256 slice): ${chunks.slice(0, 3).map((c) => hashId(c.text, c.metadata.page, c.metadata.chunkIndex, sourceFileName)).join(", ")}`);
    log(`[dry-run] Done — no API calls made. Run without --dry-run to ingest.`);
    process.exit(0);
  }

  // 3. Embed
  let embeddings: number[][] | null = null;
  try {
    embeddings = await embedChunks(chunks, batchSize, false);
  } catch (err) {
    console.error(`\n✗ Embedding failed: ${err instanceof Error ? err.message : String(err)}`);
    console.error(`  Handle large PDF timeout gracefully: reduce --batch-size, check OPENAI_API_KEY, retry`);
    process.exit(1);
  }

  // 4. Chroma Cloud ingest
  try {
    const collection = await getOrCreateChromaCollection(collectionName, false);
    await upsertToChroma(collection, chunks, embeddings, sourceFileName, false);
  } catch (err) {
    console.error(`\n✗ Chroma Cloud ingest failed: ${err instanceof Error ? err.message : String(err)}`);
    console.error(`  Check CHROMA_API_KEY / CHROMA_TENANT / CHROMA_DATABASE / CHROMA_COLLECTION and network`);
    process.exit(1);
  }

  const elapsed = ((Date.now() - tStart) / 1000).toFixed(1);
  log(`\n✅ Ingest complete in ${elapsed}s — ${chunks.length} chunks → Chroma Cloud collection "${collectionName}" (model: ${EMBEDDING_MODEL})`);
  log(`   Pages=${pages.length}  Chunks=${chunks.length}  AvgChunkLen=${Math.round(chunks.reduce((a, c) => a + c.text.length, 0) / chunks.length)} chars`);

  // 5. Verification query
  await verifyRetrieval(collectionName, false, cli.skipVerify);

  log(`\nDone. Next: test with "npm run dev" and query via UI, or run eval set (PRD A.5).`);
  log(`Remember ADR-2: if you change embedding model, delete collection and re-ingest entirely.`);
}

main().catch((err) => {
  console.error(`\n✗ Unhandled error: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
});
