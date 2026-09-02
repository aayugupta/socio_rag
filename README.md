pass-key -   pHltKTo0e6j1-UQc
# Sociology RAG Chatbot — Nishant Sir / Level Up IAS (2024)

[![CI](https://github.com/USERNAME/rag-sociology/actions/workflows/ci.yml/badge.svg)](https://github.com/USERNAME/rag-sociology/actions/workflows/ci.yml) [![typecheck](https://github.com/USERNAME/rag-sociology/actions/workflows/ci.yml/badge.svg?label=typecheck)](https://github.com/USERNAME/rag-sociology/actions/workflows/ci.yml) [![secret-scan](https://github.com/USERNAME/rag-sociology/actions/workflows/ci.yml/badge.svg?label=secret%20scan)](https://github.com/USERNAME/rag-sociology/actions/workflows/ci.yml)

> Replace `USERNAME` in badge URLs after pushing to GitHub. Badges reflect the CI pipeline in `.github/workflows/ci.yml` (lint + typecheck + gitleaks).

Accuracy-first Retrieval-Augmented Generation chatbot scoped to **one PDF** — *Sociology 2024, Nishant Sir / Level Up IAS* — for UPSC Sociology aspirants. Answers are grounded, cited by page, and explicitly refuse when the question is outside the document (refusal is a feature, not a limitation — PRD G1/G2).

Built on **Next.js + Vercel serverless**, **Chroma Cloud** (hosted vector DB), **OpenAI `text-embedding-3-small` + `gpt-4o-mini`**, shared-passphrase auth, and server-side-only secrets.

---

## Table of Contents

- [Architecture](#architecture)
- [Features](#features)
- [Security model](#security-model)
- [Quick start (local)](#quick-start-local)
- [Ingestion — place the PDF and embed](#ingestion--place-the-pdf-and-embed)
- [Vercel deploy](#vercel-deploy)
- [Evaluation (PRD A.5 / §1.5)](#evaluation-prd-a5--15)
- [Cost notes](#cost-notes)
- [Troubleshooting](#troubleshooting)
- [Repo structure](#repo-structure)
- [Open questions](#open-questions)
- [Scripts](#scripts)
- [License / usage](#license--usage)

---

## Architecture

Adapted from **RAG_Architecture_v1.md §2 — “Honest First Call-Out”**: local Chroma + local MiniLM don’t survive Vercel’s ephemeral filesystem / 250 MB function limit, so v1 moves to **hosted** equivalents.

```
                                   ┌──────────────────────────┐
                                   │        Browser            │
                                   │  (Next.js frontend page)  │
                                   └────────────┬──────────────┘
                                                │ HTTPS only
                                                ▼
                         ┌──────────────────────────────────────────┐
                         │           Vercel Edge Middleware           │
                         │  - checks session cookie (ADR-4)          │
                         │  - security headers (CSP, HSTS, etc.)     │
                         │  - basic rate limiting (per IP)           │
                         └───────────────────┬────────────────────────┘
                                              │ (only if authenticated + within rate limit)
                                              ▼
                    ┌─────────────────────────────────────────────────────┐
                    │        Vercel Serverless Function: /api/chat         │
                    │  1. Validate & sanitize input                       │
                    │  2. Rate-limit check (Upstash Redis)                │
                    │  3. Embed question → OpenAI Embeddings API (ADR-2)  │
                    │  4. Retrieve top-k → Chroma Cloud (ADR-1)           │
                    │  5. Confidence gate: low similarity → refuse        │
                    │  6. Build grounded prompt                           │
                    │  7. Call OpenAI Chat Completions (server-side key)  │
                    │  8. Log query + retrieved chunk IDs (not to client) │
                    │  9. Return answer + citations                      │
                    └───────────┬───────────────────────┬─────────────────┘
                                │                       │
                                ▼                       ▼
                   ┌────────────────────┐   ┌───────────────────────┐
                   │   Chroma Cloud      │   │    OpenAI API          │
                   │ (vector store,      │   │ (embeddings + chat)    │
                   │  hosted)            │   │                        │
                   └────────────────────┘   └───────────────────────┘

  Separate, one-time / offline process (NOT on Vercel — run locally or via a GitHub Action):
  [PDF] → [LangChain RecursiveCharacterTextSplitter] → [OpenAI Embeddings] → [Chroma Cloud ingest]
```

Ingestion is **deliberately off Vercel** — it’s a one-time batch job over a 22 MB PDF, would hit serverless timeout + ephemeral FS. Run locally (`npm run ingest`) or via a manually-triggered GitHub Action.

**ADRs (Architecture §1):**
| Decision | Choice | Why |
|---|---|---|
| Vector DB | **Chroma Cloud** | Same `chromadb` client API as your local prototype, zero migration cost. Free tier fits one-doc scale. Fast-follow: Supabase `pgvector` if you outgrow free tier. |
| Embeddings | **OpenAI `text-embedding-3-small`** | One provider, one key, no 500 MB PyTorch weight, cheap ($0.02/1M). Must re-embed entire doc if you ever switch models — vectors from different models are **not** comparable (silent failure). |
| Runtime | **Next.js Route Handlers (Node runtime) on Vercel** | Single repo, single push-to-deploy. Node (not Edge) for full OpenAI/Chroma SDK. |
| Auth | **Shared-passphrase + HMAC-signed httpOnly cookie** | Proportionate for “few friends.” Upgrade to NextAuth allowlist later if needed. |
| Always-alive | **Standard Vercel serverless is enough** | Endpoint always reachable; cold-start sub-second without heavy local ML. Optional cron to `/api/health` if you ever want warm instances. |

---

## Features

- **Single-PDF grounding:** every answer cites `[Source: Page X]`; otherwise replies exactly `This is out of my scope.` Two-layer guard: retrieval confidence gate *before* LLM + strict system prompt *inside* LLM.
- **Structured chunking (PRD A.1):** LangChain `RecursiveCharacterTextSplitter` `chunkSize=700` / `overlap=120` (~17%, tuned for dense coaching notes) plus header-aware pre-split on theorist/topic headers (Weber, Marx, Durkheim, Parsons, …) so chunks don’t straddle arguments.
- **Page-tagged citations:** each chunk carries `{page, section, chunkIndex, source}` at ingest; returned as `citations[]` to UI.
- **Passphrase gate (ADR-4):** middleware checks `session` cookie (HMAC-SHA256, 7-day expiry, `httpOnly` + `SameSite=Strict` + `Secure` in prod) on **all** routes including `/api/chat` — not just the UI. Login at `/login`.
- **Rate limiting:** Upstash Redis (serverless-friendly) when configured, in-memory fallback per instance; 10 req/60 s on `/api/chat`, 30/60 s middleware-wide, 10/60 s on `/api/auth` (brute-force), before expensive OpenAI/Chroma calls.
- **Security headers:** CSP (script/style/img/font/connect locked), HSTS, `nosniff`, `DENY` framing, `Permissions-Policy`, etc. — in middleware (Edge) + `next.config.ts` fallback, per Architecture §3.6.
- **Sanitized errors:** client never sees stack traces or key material — server logs full error, client gets “Something went wrong.”
- **Health probe:** `GET /api/health` is public (no auth) for UptimeRobot / cron warm-ping. Excluded from middleware matcher.
- **Evaluation harness:** `eval/eval_set.json` (30 Q&A) + `eval/run_eval.ts` measuring faithfulness / refusal precision / retrieval hit rate / cost per query per PRD §1.5 / A.5.

---

## Security model

See **Architecture §3** (threat → mitigation). Summary:

| Asset | Threat | Mitigation |
|---|---|---|
| **Secrets** (OpenAI, Chroma Cloud) | Committed to git | `.env.local` gitignored; real values only in **Vercel Environment Variables** per env (Production/Preview/Development). `.env.example` has placeholders only. |
|  | Exposed to browser | Keys only read inside serverless functions; never prefix with `NEXT_PUBLIC_`. Browser only ever calls your `/api/chat`, never OpenAI/Chroma directly. |
|  | Verbose error leak | API routes catch and return generic message; full stack only in server logs. |
|  | Leaked despite `.gitignore` | GitHub Push Protection (native) + `gitleaks` in CI as second layer; **rotate immediately** if leaked — removing in later commit doesn’t purge history. |
| **Frontend↔Backend** | Direct SDK call bypassing guardrails | Architectural: browser never ships OpenAI/Chroma SDKs/keys. |
|  | CSRF on cookie-auth | `SameSite=Strict` cookie + `Origin`/`Referer` check on `/api/chat` + `/api/auth`. |
|  | CORS abuse | No permissive `Access-Control-Allow-Origin` on `/api/chat` (same-origin only). |
|  | Prompt injection (`ignore previous instructions`) | (1) `validateInput` regex blocklist (`src/lib/rag.ts:INJECTION_PATTERNS`) → 400; (2) system prompt never contains key; (3) delimited `<INSTRUCTIONS>/<CONTEXT>/<QUESTION>` template strips fake tags. |
| **Access control** | Public URL guessed, strangers rack up bill | Shared-passphrase middleware on **all** routes + `/api/chat` double-check; passphrase is a Vercel env var, rotatable. |
| **Abuse / cost** | Cost bomb (retry loop / shared link) | Server-side rate limiting before embedding/chat; hard monthly cap in OpenAI dashboard; per-request token logging. |
|  | Large payload | `MAX_INPUT_LENGTH=2000` enforced server-side (truncate + injection scan) before embedding. |
| **Transport** | Mixed content / clickjacking | HTTPS enforced by Vercel, HSTS, `X-Frame-Options: DENY` + `frame-ancestors 'none'` CSP. |

Dependency hygiene: enable **Dependabot** (GitHub → Insights → Dependency graph → Dependabot alerts), pin security-sensitive pkgs, review PRs before merging.

---

## Quick start (local)

Prereqs: Node.js 20+, npm. Optional: Chroma Cloud account, OpenAI API key.

```bash
git clone https://github.com/YOURUSERNAME/rag-sociology.git
cd rag-sociology
npm install

# 1. Env vars — copy template, never commit the real file
cp .env.example .env.local
# Now edit .env.local and fill real values:
#   OPENAI_API_KEY=sk-...
#   CHROMA_API_KEY=...        # from https://trychroma.com dashboard
#   CHROMA_TENANT=...         # optional
#   CHROMA_DATABASE=...       # optional
#   CHROMA_COLLECTION=sociology  # optional, default sociology
#   APP_PASSPHRASE=your-shared-passphrase  # friends enter at /login
#   APP_SECRET=openssl-rand-hex-32         # optional, falls back to passphrase
#   UPSTASH_REDIS_REST_URL=...              # optional, enables Redis rate limiting
#   UPSTASH_REDIS_REST_TOKEN=...
# See .env.example header for scope (all server-only, never NEXT_PUBLIC_)

# 2. Place the source PDF (gitignored — copyrighted coaching material)
mkdir -p data
cp "/path/to/_Handouts_Sociology2024byNishantSir_LevelupIAS_KING_R_QUEEN_P.PDF" data/Sociology.pdf
# Alternative: keep elsewhere and pass --pdf to ingest

# 3. Verify env + PDF without spending API credits
npm run ingest:dry-run
# or: npx tsx scripts/ingest.ts --dry-run --verbose

# 4. Real ingest (offline) to Chroma Cloud — embeddings + upsert
npm run ingest
# Explicit: npx tsx scripts/ingest.ts --pdf ./data/Sociology.pdf --collection sociology

# 5. Local dev (no Vercel needed)
npm run dev
# → http://localhost:3000  (login with APP_PASSPHRASE if set)
```

Local-only alternative (no Chroma Cloud, fully offline except OpenAI embeddings): `npm run ingest:local` → persists to `./chroma_db/local_store.json` + optional local Chroma server at `http://localhost:8000` (`chroma run --path ./chroma_db`). See `scripts/README.md`.

---

## Ingestion — place the PDF and embed

Full docs: [`scripts/README.md`](scripts/README.md)

Flow: **PDF per page → header-aware split (Weber/Marx/Durkheim/…) → `RecursiveCharacterTextSplitter` 700/120 → OpenAI `text-embedding-3-small` (batch 100, rate-limited) → Chroma Cloud `upsert` with `id=sha256` + metadata `{page, section, chunkIndex, source}` → verification query `What does Nishant Sir say about Weber's bureaucracy?` top-5.**

```bash
npx tsx scripts/ingest.ts --help          # all flags
npx tsx scripts/ingest.ts --dry-run       # free check
npx tsx scripts/ingest.ts --batch-size 50 --verbose  # if 429 on low tier key
npx tsx scripts/ingest.ts --skip-verify   # skip post-ingest test query
```

⚠️ **ADR-2 warning:** query-time embedding model (`src/lib/openai.ts:EMBEDDING_MODEL`) **must** match ingestion model (`text-embedding-3-small`). Never mix models — vectors from different models silently return wrong retrievals. If you switch, delete the Chroma collection and re-ingest entirely.

---

## Vercel deploy

See short guide: [`VERCEL_DEPLOY.md`](VERCEL_DEPLOY.md). Full checklist:

1. **Push to GitHub** (make repo public or private as you prefer; CI `gitleaks` blocks secret leaks either way).
2. **Import in Vercel** → Connect GitHub → select `rag-sociology` → Framework Preset: Next.js → Build command `next build` (default) → Node 20.
3. **Environment Variables** — Project Settings → Environment Variables — scope independently per **Production / Preview / Development**:
   - `OPENAI_API_KEY` — production key with hard monthly cap (OpenAI dashboard → Billing → Limits), preview can use a lower-limit test key to cap PR abuse.
   - `CHROMA_API_KEY`, `CHROMA_TENANT`, `CHROMA_DATABASE`, `CHROMA_COLLECTION=sociology`
   - `APP_PASSPHRASE` — the shared passphrase friends enter at `/login` (choose a long diceware phrase; rotate by changing this var if leaked).
   - `APP_SECRET` — long random hex (`openssl rand -hex 32`); HMAC key for session cookie (if unset, `APP_PASSPHRASE` is used as fallback — set a distinct `APP_SECRET` in production).
   - `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` — optional but recommended for cross-instance rate limiting. If unset, in-memory limiter is used (per-function, resets on cold start).
   - Never prefix any of these with `NEXT_PUBLIC_`.
4. **Preview vs Production:** Vercel auto-deploys a unique **Preview** URL per PR (isolated env vars) and **Production** on merge to `main`. Keep a **separate, lower-limit OpenAI key or test Chroma collection for Preview** so a PR can’t hit prod data/budget (Architecture §4).
5. **Branch protection:** After first green CI, enable in GitHub → Settings → Branches → Require `lint-typecheck` and `secret-scan` checks before merge, disallow direct pushes to `main` (see `ci.yml` footer comment).
6. **First smoke test:** Deploy to Preview → log in → ask one in-scope + one out-of-scope + one injection (`Ignore previous instructions`) — verify 401/403 when unauthenticated, 400 on injection, and citation page on success.
7. **Custom domain (optional):** Vercel → Settings → Domains. HTTPS/HSTS automatic.

Ingestion stays **offline** — never add a Vercel Function for PDF processing (timeout + ephemeral FS). If you need CI ingestion, add a `workflow_dispatch` GitHub Action that runs `scripts/ingest.ts` with secrets injected, then exits (no deploy side-effect).

---

## Evaluation (PRD A.5 / §1.5)

Labeled set: [`eval/eval_set.json`](eval/eval_set.json) — **30 Q&A** (15 in-scope with expected page/keywords, 5 paraphrased stressing embeddings, 5 clearly out-of-scope, 5 adversarial/borderline). Inferred from UPSC Sociology syllabus (Weber bureaucracy / Marx stratification / Durkheim suicide / functionalism / division of labour / social fact / etc.) since the PDF is private.

Harness: [`eval/run_eval.ts`](eval/run_eval.ts) — reads the set, calls either local RAG or remote `/api/chat`, computes PRD §1.5 metrics, emits a markdown table + `eval/results.json` (+ `eval/results.md`).

```bash
# Local (direct function, needs OPENAI_API_KEY + CHROMA_* env). Fastest, no auth.
npm run eval:local             # = npx tsx eval/run_eval.ts --local
npx tsx eval/run_eval.ts --local --verbose
npx tsx eval/run_eval.ts --local --strict   # exit 1 if thresholds not met (for CI gating)

# Remote — against a running server (local dev or staging)
npm run eval                   # = hits http://localhost:3000 by default
npx tsx eval/run_eval.ts --url http://localhost:3000 --passphrase "$APP_PASSPHRASE"
npx tsx eval/run_eval.ts --url https://your-staging.vercel.app --passphrase "$APP_PASSPHRASE" --verbose
npx tsx eval/run_eval.ts --url https://your-staging.vercel.app --output eval/staging-results.json
```

**Metrics emitted (PRD §1.5):**
| Metric | Definition | Target |
|---|---|---|
| **Faithfulness rate** | in_scope + paraphrased answers whose `expectedContains` keywords appear (≥50% keyword hit, not refused) / total in_scope expected `answer contains` | ≥95% |
| **Refusal precision** | out_of_scope + adversarial with `expected: should refuse` that actually returned `This is out of my scope` (or gated/400) / total should-refuse | ≥90% |
| **Retrieval hit rate** | expected `expectedPage` found in returned `citations[].page` (±1 page tolerance) / total with `expectedPage` | ≥90% |
| **False-refusal rate** | in_scope `answer contains` but was incorrectly refused / total in_scope `answer contains` | ideal 0% (≤10% warning) |
| **Cost per query** | `prompt_tokens * $0.15/1M + completion_tokens * $0.60/1M (+ embedding $0.02/1M)` if `usage` present; else heuristic chars/4 + 800 context tokens | soft gate (track) |
| Avg latency | wall-clock per question, ms | — |

Artifacts: `eval/results.json` (full per-question + summary + pricing) and `eval/results.md` (same folder) are **gitignored** (they contain answer text). Uploaded as CI artifact from the optional `eval-optional` job when `EVAL_STAGING_URL` is set.

Run the set **after every pipeline change** (chunk size, embedding model, prompt guard) — it’s the only way to tell “I think it’s better” from “it’s measurably better.”

---

## Cost notes

| Component | Provider | v1 cost at “few friends” scale |
|---|---|---|
| Hosting (frontend + `/api/chat`) | Vercel Hobby | Free |
| Vector DB | Chroma Cloud | Free tier (one small collection, ~1–2 k chunks) |
| Embeddings + Chat | OpenAI | Usage-based; set a hard cap in OpenAI dashboard (Billing → Limits). Rough: ingestion ~$0.05–0.25 for 22 MB / ~1500 chunks; per query ~$0.002–0.01 depending on k + output length. See eval cost output. |
| Rate-limit store | Upstash Redis | Free tier (or in-memory fallback = free) |
| Secret scanning | GitHub + gitleaks | Free |

Tip: print per-request `usage` is already logged server-side (`rag_query`, `api_chat_success`). Lower `k` (default 5) or `max_tokens` (default 700) if costs surprise you on metered keys.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `PDF not found` | Put PDF at `data/Sociology.pdf` (`data/` is gitignored) or pass `--pdf <path>`. On Windows with spaces in `open code folder`, quote the path. |
| `Missing OPENAI_API_KEY / CHROMA_API_KEY` | Fill `.env.local` (not `.env.example`); `dotenv` loads `.env.local` first then `.env`. Check Vercel env scoping (Production vs Preview). |
| `No pages extracted` / “scanned/image-only” | PDF is image scans — `pdf-parse` can’t OCR. Pre-process with `ocrmypdf` (PRD §1.9). Verify 10–15 chunks look coherent (`npm run ingest:dry-run -- --verbose`). |
| `429 rate limited` (ingest) | Lower `--batch-size 50`, or wait; scripts auto-backoff 5 s. Upgrade OpenAI tier if recurring. |
| `Chroma collection not accessible` | Verify `CHROMA_TENANT` / `CHROMA_DATABASE` from dashboard; ensure key has write; collection name must match `CHROMA_COLLECTION`. |
| `Unauthorized` (401) from `/api/chat` or eval | Pass correct `APP_PASSPHRASE` (same as Vercel env) via `/login` or `Authorization: Bearer <passphrase>` (eval does both). In dev with no passphrase set, auth is intentionally open — not a bug. |
| `Too many requests` (429) from chat | Per-IP + per-session sliding window 10/60 s on `/api/chat`. Wait; eval throttles ~350 ms/q to avoid this. |
| `Something went wrong` (500) | Client sees generic; check Vercel logs (Dashboard → Deployments → Logs) for full error — look for `Embedding failed`, `Chroma not configured`, or missing env. |
| `Invalid input rejected` (400) on benign question | False positive in injection regex (`INJECTION_PATTERNS`). Rare; rephrase or adjust pattern in `src/lib/rag.ts`. |
| Fragments mid-sentence in chunks | Tune `CHUNK_SIZE` / `CHUNK_OVERLAP` at top of `scripts/ingest.ts` (PRD A.1: inspect 10–15 chunks). |
| CI fails on secret scan but I only put placeholders | Placeholders (`sk-your-...`, `your-chroma-api-key-here`) in `.env.example` are allowed. Real keys matching `sk-[A-Za-z0-9_-]{20,}` outside `.env.example` fail — move them to `.env.local` or Vercel. |
| `chroma_db` / `data/*.pdf` showing as untracked? | They’re gitignored intentionally (copyrighted material + vector store). Only `.gitkeep` is committed. Verify with `git status --ignored`. |

---

## Repo structure

```
rag-sociology/
  .env.example               # placeholder keys only (committed)
  .env.local                 # your real keys (gitignored, never commit)
  .gitignore                 # .env*, chroma_db, data/*.pdf, __pycache__, venv, .next
  next.config.ts             # security headers (CSP/HSTS) backup — middleware is primary
  src/
    middleware.ts            # Edge: auth gate + CSP/HSTS + per-IP rate limit (matcher excludes /api/health)
    app/
      page.tsx               # chat UI (other agent)
      login/page.tsx         # passphrase login
      api/
        chat/route.ts        # Node runtime: validate → rate limit → retrieveAndGenerate → citations
        auth/route.ts        # HMAC-signed session login (POST passphrase → set cookie)
        auth/logout/route.ts # alias logout
        health/route.ts      # public liveness probe (ADR-5)
    lib/
      rag.ts                 # validateInput, buildGroundedPrompt, confidenceGate, retrieveAndGenerate
      openai.ts              # embedText (text-embedding-3-small), generateAnswer (gpt-4o-mini)
      chroma.ts              # CloudClient, queryCollection, distance→similarity
      auth.ts                # signSession / verifySession / timingSafeCompare (Node crypto)
      rateLimit.ts           # Upstash Redis or in-memory fallback
    components/              # ChatMessage, CitationPill, etc.
  scripts/
    ingest.ts                # Chroma Cloud offline ingest (ingest) — primary for Vercel
    ingest-local.ts          # local JSON fallback (ingest:local) — no Cloud needed
    README.md                # ingestion deep dive
  eval/
    eval_set.json            # 30 Q&A labeled set (PRD A.5) — your eval gold
    run_eval.ts              # harness: faithfulness / refusal / hit rate / cost → results.json + .md
    results.json             # generated report (gitignored + CI artifact)
    results.md               # generated markdown twin
  .github/workflows/ci.yml   # lint+typecheck, gitleaks + fallback grep, optional eval-against-staging
  data/
    .gitkeep
    Sociology.pdf            # you provide, gitignored (22 MB, copyrighted)
  chroma_db/                 # gitignored (local persist: local_store.json / manifest, or Chroma server files)
```

Per PRD **B.1 / B.3**: `.env`, `chroma_db/`, `__pycache__/`, `venv/`, and the source PDF itself are never committed — the persistence directory may already contain embedded chunks of copyrighted material.

---

## Open questions

Carry-overs from **PRD Open Questions** and **Architecture Open Questions** — file an issue/discussion before finalizing:

1. **Non-technical friends:** do they create their own `.env.local` + run locally (PRD B.2: each friend uses own OpenAI key — naturally caps your cost), or do you host a private Vercel deployment with your key + `APP_PASSPHRASE`? This doc assumes the latter for “one-click” friends; on-host billing becomes your responsibility (mitigated by rate limit + OpenAI hard cap).
2. **Citation visibility:** should `[Source: Page X]` appear inline in the chat answer (recommended — makes fabrication auditable), or only server-side logged? Controlled in `rag.ts:SYSTEM_INSTRUCTION` + prompt `RULES`.
3. **Chat model choice:** “ChatGPT LLM” → `gpt-4o-mini` here (per `src/lib/openai.ts:CHAT_MODEL`). If you need higher reasoning (e.g., `gpt-4o`), bump `CHAT_MODEL` but costs 5–10×.
4. **Refusal string:** hard exact `"This is out of my scope."` (easiest to eval/test) vs natural refusal phrasing? Current is **hard string** at both gate and prompt levels; search `OUT_OF_SCOPE_MSG` to relax.
5. **ADR-2 model lock-in:** okay with `text-embedding-3-small` switch (recommended), or do you want Hugging Face Inference API path to keep original MiniLM free? Decision: current is OpenAI (one provider, no 500 MB weight). If you switch, re-embed entire doc and never mix models.
6. **Per-friend vs shared passphrase:** one shared secret (v1, ADR-4) vs lightweight per-friend codes (lets you revoke one without rotating for all). Flagged as fast-follow.
7. **Citations in UI vs log-only:** PRD notes citation as optional display — DB already tracks page/section; toggle in component.

---

## Scripts

| Script | Command | Purpose |
|---|---|---|
| `dev` | `npm run dev` | Next.js dev server (http://localhost:3000) |
| `build` | `npm run build` | Production build |
| `start` | `npm run start` | Serve production build |
| `lint` | `npm run lint` | ESLint (Next.js config) |
| `ingest` | `npm run ingest` | Offline ingest to **Chroma Cloud** (`scripts/ingest.ts`) |
| `ingest:local` | `npm run ingest:local` | Offline ingest to **local** `chroma_db/` (`scripts/ingest-local.ts`) |
| `ingest:dry-run` | `npm run ingest:dry-run` | Parse + split only, no API calls (free) |
| `eval` | `npm run eval` | Eval harness vs **remote** `http://localhost:3000` (or `EVAL_URL`) |
| `eval:local` | `npm run eval:local` | Eval harness **local** direct RAG call (no HTTP) |

Pass args through npm with `--`:

```bash
npm run ingest -- --help
npm run ingest -- --pdf ./data/Sociology.pdf --collection sociology
npm run eval -- --url https://staging.vercel.app --passphrase secret
```

---

## Before the first push — checklist (PRD B.4)

- [ ] `.env.local` never committed (`git status --ignored` shows `.env.local` ignored).
- [ ] `.env.example` has placeholders only, no real keys (`grep -n sk- .env.example` should show only `sk-your-...`).
- [ ] PDF at `data/Sociology.pdf` is ignored (`git status` doesn’t list it).
- [ ] Run `gitleaks detect --source . --no-git` or rely on CI; also try `npm run lint && npx tsc --noEmit` green locally.
- [ ] If a real key ever shipped despite `.gitignore`, **rotate it** in the vendor dashboard immediately — history survives.
- [ ] Ingestion uses `text-embedding-3-small` and query uses same (verify `src/lib/openai.ts:EMBEDDING_MODEL`).
- [ ] Preview deployments use a separate test key/collection (Vercel → Project Settings → Environment Variables → Preview scope).
- [ ] `APP_PASSPHRASE` set in Vercel (Production + Preview scopes separately); `APP_SECRET` is distinct `openssl rand -hex 32`.
- [ ] Hit `/api/health` after deploy — should return `{"status":"ok"}` without auth.
- [ ] Login with passphrase, ask one in-scope and one out-of-scope + one injection; verify citations and `This is out of my scope.`.

---

## License / usage

Course handout (`Sociology 2024, Level Up IAS`) is **copyrighted coaching material** — the PDF itself and its derived embeddings/chunks are **not** redistributed via this repo (`.gitignore` + ingest tag `source`). Share the *code*, not the *content*; each friend should obtain the PDF themselves and run their own ingestion with their own key.

---

*Companion docs: [`RAG_PRD_v1.md`](../RAG_PRD_v1.md) and [`RAG_Architecture_v1.md`](../RAG_Architecture_v1.md) (local to builder’s Downloads — not in this repo). See `VERCEL_DEPLOY.md` for the short deploy guide and `scripts/README.md` for ingestion depth.*
