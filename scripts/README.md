# Ingestion Pipelines — Sociology RAG

Offline ingestion is **deliberately kept off Vercel** (Architecture §2 diagram, PRD A.1). Run locally or via a manually-triggered GitHub Action. Vercel functions have ephemeral FS + timeout limits — a 22 MB PDF will not survive there.

---

## 1. Place the PDF

```bash
# Required location for default scripts (gitignored — never commit the PDF)
mkdir -p data
cp "/path/to/_Handouts_Sociology2024byNishantSir_LevelupIAS_KING_R_QUEEN_P.PDF" data/Sociology.pdf

# Alternative: keep it in Downloads and pass --pdf explicitly
# The scripts auto-fallback to C:\Users\aarad\Downloads\_Handouts_Sociology2024byNishantSir_LevelupIAS_KING_R_QUEEN_P.PDF if ./data/Sociology.pdf missing
```

`data/*.pdf` is gitignored (copyrighted coaching material + `chroma_db` also ignored). Only `data/.gitkeep` is committed.

---

## 2. Env vars

Create `.env.local` (gitignored) at project root — **never commit real keys**. Use `.env.example` as template.

### For Chroma Cloud ingest (hosted, Vercel-compatible) — `scripts/ingest.ts`

```ini
OPENAI_API_KEY=sk-...
CHROMA_API_KEY=...
CHROMA_TENANT=...      # optional — Chroma Cloud tenant (from dashboard)
CHROMA_DATABASE=...    # optional — Chroma Cloud database
CHROMA_COLLECTION=sociology  # optional, default: sociology
```

Get Chroma Cloud values from https://trychroma.com dashboard. `CHROMA_TENANT` / `CHROMA_DATABASE` are optional if your Cloud setup uses defaults.

### For local offline dev — `scripts/ingest-local.ts`

```ini
OPENAI_API_KEY=sk-...   # still needs OpenAI for embeddings (same model as Cloud)
# No CHROMA_API_KEY needed — stores at ./chroma_db
```

Both scripts load env via `dotenv` from `.env.local` then `.env` (in that order).

---

## 3. Install deps

Deps are already in `package.json` (`openai`, `chromadb`, `langchain`, `@langchain/textsplitters`, `pdf-parse`, `dotenv`, `tsx`, `unpdf`).

```bash
npm install
# If you hit script permission errors on Windows:
# powershell -ExecutionPolicy Bypass -Command "npm install"
```

---

## 4. Run

### Dry-run first (free, no API calls) — **recommended before real ingest**

```bash
npm run ingest:dry-run
# or explicitly:
npx tsx scripts/ingest.ts --dry-run
npx tsx scripts/ingest.ts --dry-run --pdf ./data/Sociology.pdf --verbose
```

Dry-run does: PDF parse → per-page text → structure-aware header detection (Weber/Marx/Functionalism) → `RecursiveCharacterTextSplitter` (700/120) → logs chunk count, avg length, sample chunks, estimated embedding cost. No OpenAI/Chroma calls.

### Full ingest to Chroma Cloud (hosted)

```bash
npm run ingest
# explicit:
npx tsx scripts/ingest.ts --pdf ./data/Sociology.pdf --collection sociology
npx tsx scripts/ingest.ts --batch-size 100 --verbose
npx tsx scripts/ingest.ts --skip-verify   # skip post-ingest test query
```

Steps executed:
1. **Parse PDF** with `pdf-parse` v2 (`PDFParse`) — per page, preserves `page` as metadata; falls back to `unpdf` if needed. Handles 22 MB large PDF with timeout guard.
2. **Structure-aware split**: first detects headers (Weber, Marx, Functionalism, Durkheim, Parsons, …) to avoid chunks straddling topics, then `RecursiveCharacterTextSplitter` with `chunkSize=700`, `chunkOverlap=120` (~17%, PRD A.1: 500-800 / 15-20%).
3. **Metadata** per chunk: `{ page, section, chunkIndex, source }`
4. **Embed** batches of 100 via OpenAI `text-embedding-3-small` (rate-limited, retry on 429/timeout, AbortController 120 s per batch).
5. **Upsert** to Chroma Cloud (`CloudClient`, `getOrCreateCollection` → `upsert` with `id=sha256`, `document`, `embedding`, `metadata`).
6. **Verification**: embeds `What does Nishant Sir say about Weber's bureaucracy?` and logs top-5 retrieval with distances/similarities/metadata.

`--help` shows all options:
```bash
npx tsx scripts/ingest.ts --help
```

### Local alternative (no Chroma Cloud) — offline dev

```bash
npm run ingest:local
npx tsx scripts/ingest-local.ts --dry-run
npx tsx scripts/ingest-local.ts --pdf ./data/Sociology.pdf --collection sociology
```

- Same splitting/embedding logic.
- Stores at `./chroma_db/local_store.json` + `manifest.json` (always written, no server needed — fully offline).
- Optionally also upserts to a local Chroma server if reachable at `http://localhost:8000` (start with `chroma run --path ./chroma_db` or Docker). If no server, JSON fallback is authoritative and ingestion still succeeds.
- Verification runs brute-force cosine similarity locally (no Chroma query needed) for the same test query.

---

## 5. Architecture warnings (ADR-1 / ADR-2) — READ THIS

### ADR-2: Embedding model consistency

> **⚠️ You must re-embed the ENTIRE document if you change the embedding model — never mix models between ingestion and query time. Vectors from different models are not comparable (silent retrieval failure).**

- Ingestion uses `text-embedding-3-small` (1536 dims, cosine). Query-time (`src/lib/openai.ts:32` `EMBEDDING_MODEL`) must match exactly.
- If you switch models (e.g., back to `all-MiniLM-L6-v2` or `bge-small`), **delete the Chroma collection** and re-run ingestion from scratch. Do not mix.
- Both ingest scripts warn loudly at startup and tag `embedding_model` in Chroma metadata for traceability.

### ADR-1: Vector DB choice

- **Vercel (hosted)**: use **Chroma Cloud** (`scripts/ingest.ts`). Local file-based `ChromaDB` cannot persist on Vercel's ephemeral, read-only FS.
- **Local dev / friend prototyping**: use `scripts/ingest-local.ts` → `./chroma_db` (original PRD local Chroma, free, no Cloud account needed). `chroma_db/` and `data/*.pdf` are gitignored.

---

## 6. Large PDF timeout & batching

- `scripts/ingest.ts` handles the 22 MB PDF gracefully: per-batch `AbortController` 120 s timeout, 429 backoff (5 s), 250 ms pause between batches, `NODE_OPTIONS=--max-old-space-size=4096` hint if OOM.
- Default `EMBED_BATCH_SIZE=100` — lower via `--batch-size 50` if you hit rate limits on a low-tier OpenAI key.
- Upsert is also batched (100) to stay under Chroma Cloud payload limits.

---

## 7. Data directory

```
rag-sociology/
  data/
    .gitkeep              # committed — keeps dir in git
    Sociology.pdf         # YOU provide — gitignored, 22 MB source
  chroma_db/              # generated — gitignored (local persist or JSON fallback)
    .gitkeep
    local_store.json      # written by ingest-local.ts (chunks + embeddings + metadata)
    manifest.json
    sqlite / chroma files # if you run `chroma run --path ./chroma_db`
  scripts/
    ingest.ts             # Cloud ingest (this doc)
    ingest-local.ts       # Local ingest
    README.md             # you are here
```

`.gitignore` already ignores `.env*`, `chroma_db/`, `data/*.pdf` — verify before first push with `gitleaks` or `git status --ignored`.

---

## 8. Troubleshooting

| Symptom | Fix |
|---|---|
| `PDF not found` | Place at `./data/Sociology.pdf` or pass `--pdf <path>`; check Windows path quoting (spaces in `open code folder` require quotes) |
| `Missing OPENAI_API_KEY` / `CHROMA_API_KEY` | Set in `.env.local` (not `.env.example`); `dotenv` loads `.env.local` then `.env` |
| `No pages extracted — scanned/image-only` | PDF is image scans — `pdf-parse` can't OCR; need OCR pre-pass (e.g., `ocrmypdf`) — verify text extraction quality (PRD §1.9) |
| `rate limited (429)` | Lower `--batch-size 50` or wait; scripts auto-retry with 5 s backoff |
| `timeout after 120s` | Transient — scripts retry once; increase Node memory `NODE_OPTIONS=--max-old-space-size=4096 npx tsx ...` |
| `Chroma collection not accessible` | Check `CHROMA_TENANT`/`CHROMA_DATABASE` from Cloud dashboard; verify `CHROMA_API_KEY` has write access |
| `Local Chroma server not available` (ingest-local) | Expected if no server running — JSON fallback still succeeds; to use server: `pip install chromadb && chroma run --path ./chroma_db` |
| Fragmented chunks mid-sentence | Tune `CHUNK_SIZE`/`CHUNK_OVERLAP` in script header (PRD A.1: inspect 10-15 chunks) |

---

## 9. Verification & eval

- Both scripts auto-verify with `TEST_QUERY = "What does Nishant Sir say about Weber's bureaucracy?"` and log top-k (similarity, page, section). Manual check: does top-k actually contain Weber/bureaucracy?
- For full PRD A.5 eval (25-30 Q&A, faithfulness 95%, refusal precision 90%), build `eval/eval_set.json` and run after any pipeline change.

---

## 10. npm scripts (package.json)

```json
"scripts": {
  "ingest": "tsx scripts/ingest.ts",
  "ingest:local": "tsx scripts/ingest-local.ts",
  "ingest:dry-run": "tsx scripts/ingest.ts --dry-run"
}
```

Run with `npm run <script> -- --help` to pass args through (`--` required for npm).

---

*Delivers Architecture diagram offline pipeline + PRD A.1 chunking + ADR-1/ADR-2 warnings. Other agents own frontend/API — do not modify `src/` here.*
