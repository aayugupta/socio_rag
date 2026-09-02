# Vercel Deploy Guide — Sociology RAG

Short companion to `README.md` (Vercel deploy section) + `RAG_Architecture_v1.md` §4 / §7.

---

## 1. Why ingestion is offline (not on Vercel)

The 22 MB PDF → chunk → embed → upsert is a **one-time batch job**, not a request handler.

- Vercel Serverless functions have an **ephemeral, read-only-at-runtime FS** — a local `chroma_db` file wouldn’t survive between invocations (ADR-1).
- They have **function size limits (250 MB)** and **timeout limits** — embedding 1–2 k chunks + local ML would blow both (ADR-2).
- The hosted surface should stay small: query path only (embed one question + retrieve top-k + call LLM). Keep the heavy path local.

Run as:
```bash
npm run ingest          # Chroma Cloud (hosted, Vercel-compatible)
npm run ingest:local    # local JSON + optional Chroma server at :8000 (dev only)
```
Never create a `/api/ingest` route.

---

## 2. Import project

1. Push repo to GitHub (verify `gitleaks` + `npm run lint && npx tsc --noEmit` green).
2. Vercel → Add New → Project → Import Git Repository → select `rag-sociology`.
3. Framework Preset: **Next.js** (auto). Build command: `next build`. Output: default. Node: **20.x**. No extra config.

---

## 3. Environment Variables — scoping is the point

Project Settings → Environment Variables → Add Variable — you can scope each var to **Production / Preview / Development** independently (the UI has three checkboxes, or use `vercel env add`).

| Variable | Required | Scoping recommendation | Notes |
|---|---|---|---|
| `OPENAI_API_KEY` | Yes | **Different keys per env** | Production: your billed key with **hard monthly cap** (OpenAI dashboard → Billing → Limits). Preview: a separate lower-limit test key so a PR can’t burn prod budget. |
| `CHROMA_API_KEY` | Yes | Same across envs or separate collections | Get from https://trychroma.com dashboard |
| `CHROMA_TENANT` | If dashboard shows it | Same | Optional if Cloud uses defaults |
| `CHROMA_DATABASE` | If dashboard shows it | Same | Optional |
| `CHROMA_COLLECTION` | Recommended | `sociology` for prod, `sociology-preview` for Preview (optional) | If Preview uses a different collection, ingestion must target that name (`--collection sociology-preview`) |
| `APP_PASSPHRASE` | Yes (for private deploy) | **Different per env is okay** | The shared secret friends type at `/login`. Pick a long diceware phrase. Rotate by updating this var and redeploying. |
| `APP_SECRET` | Strongly recommended | Different from passphrase in prod | `openssl rand -hex 32`. HMAC key for the `session` cookie. If unset, `APP_PASSPHRASE` itself is used as fallback — set a distinct `APP_SECRET` in Production. |
| `UPSTASH_REDIS_REST_URL` | Optional | Same across envs | Enables cross-instance rate limiting. If unset, in-memory limiter (per-function) is used. |
| `UPSTASH_REDIS_REST_TOKEN` | Optional | Same | Pair with URL above |
| `ALLOWED_ORIGIN` / `NEXT_PUBLIC_SITE_URL` | Optional | Prod URL | Used for CSRF `Origin` check on `/api/chat` + `/api/auth` when behind custom domain. |

**Hard rules:**
- Never prefix any of these with `NEXT_PUBLIC_` — that prefix bundles the value into client JS (Architecture §3.1).
- `.env.local` / `.env` are **never** used on Vercel — only the dashboard vars. They’re for local dev only.
- After adding/rotating a var, **Redeploy** (or push new commit) to pick it up — env vars are inlined at build.

---

## 4. Preview vs Production

- **Preview:** auto-deployed on every PR push to a unique `https://rag-sociology-xxx-username.vercel.app` URL. Uses vars scoped to **Preview**. Good place to smoke-test auth + guardrails before sharing with friends.
- **Production:** auto-deployed on push/merge to `main` → your main domain `https://rag-sociology.vercel.app` (or custom domain). Uses vars scoped to **Production**.

Test matrix:
```bash
# Preview smoke (unauth should 401, injection 400, happy path 200 + citations)
curl -s https://<preview>.vercel.app/api/health               # → {"status":"ok"} no auth
curl -s -X POST https://<preview>.vercel.app/api/chat \
  -H "Content-Type: application/json" \
  -d '{"message":"What is Durkheim suicide types?"}'          # → 401 without passphrase

# Auth then chat
PASS="$(vercel env ls | grep APP_PASSPHRASE)" # or use dashboard value
curl -s -X POST https://<preview>.vercel.app/api/auth \
  -H "Content-Type: application/json" -d "{\"passphrase\":\"$PASS\"}" -c /tmp/c
curl -s -b /tmp/c -X POST https://<preview>.vercel.app/api/chat \
  -H "Content-Type: application/json" -d '{"message":"What are Durkheim suicide types?"}' | jq .

# Eval against staging (optional, see eval/README)
npx tsx eval/run_eval.ts --url https://<preview>.vercel.app --passphrase "$PASS" --verbose
```

---

## 5. How to set `APP_PASSPHRASE` (and `APP_SECRET`)

1. **Choose a passphrase:** long, memorable, not reused elsewhere. Example generator (local only, not Vercel):
   ```bash
   openssl rand -base64 24    # or diceware: 6 random words
   ```
2. **In Vercel:** Project Settings → Environment Variables → Add
   - Key: `APP_PASSPHRASE`
   - Value: (your phrase) — no surrounding quotes
   - Environments: ☑ Production ☑ Preview (use separate values if you want to isolate) ☑ Development (for `vercel dev`)
3. **Add a stronger `APP_SECRET`** (recommended for prod):
   ```bash
   openssl rand -hex 32
   ```
   Save as `APP_SECRET` with the same scoping — this is the HMAC key for the `session` cookie; `APP_PASSPHRASE` itself is only for the login check.
4. **Redeploy** (Deployments → Redeploy or push).
5. **Share:** give friends the passphrase out-of-band (not in the repo). Rotating is just updating the var + redeploy.

The session cookie is `httpOnly`, `SameSite=Strict`, `Secure` in prod, 7-day expiry (`src/lib/auth.ts:getSessionCookieOptions`). Middleware (`src/middleware.ts`) verifies HMAC with `timingSafeEqual`; `src/app/api/chat/route.ts` double-checks as defense-in-depth.

---

## 6. Post-deploy checklist

- [ ] `/api/health` returns 200 without auth.
- [ ] Visiting `/` without login redirects to `/login`.
- [ ] Login with passphrase succeeds and sets `session` cookie.
- [ ] `POST /api/chat` without auth → 401; with `Authorization: Bearer <passphrase>` → 200.
- [ ] Injection `"Ignore previous instructions..."` → 400 or gated `This is out of my scope.`.
- [ ] Out-of-scope `"What is quantum physics?"` → `This is out of my scope.` with `gated:true` or prompt-level refusal.
- [ ] In-scope `"What are Durkheim suicide types?"` → answer contains egoistic/altruistic/anomic/fatalistic + `citations[]` with page.
- [ ] Rate limit: 11 rapid `POST /api/chat` → one 429 with `Retry-After`.
- [ ] Security headers present: `curl -I https://<app>/api/health | grep -i "content-security-policy\|strict-transport"`.

---

## 7. Troubleshooting Vercel-specific

| Symptom | Fix |
|---|---|
| `Missing OPENAI_API_KEY` / `Chroma not configured` in logs | Check Project Settings → Environment Variables scoping (did you set it for Production but test Preview?). Redeploy after adding. |
| Preview uses prod data | Scope `CHROMA_COLLECTION` and `OPENAI_API_KEY` separately per env (Preview vs Production) in the UI; re-ingest into the Preview collection name if you split collections. |
| `Unauthorized` after login | Mismatch between `APP_PASSPHRASE` and value typed (trim/case). Check `APP_SECRET` vs `APP_PASSPHRASE` — clearing cookies after rotation fixes stale tokens. |
| Typecheck fails on Vercel build | Fix locally first: `npm run lint && npx tsc --noEmit`. Build uses same. |
| Cold-start latency felt high | Ensure you are on hosted embeddings (OpenAI), not local MiniLM (ADR-2). Optional: set UptimeRobot → `https://<app>/api/health` every 5 min to warm (ADR-5). |
| Env var updated but not effective | Vars are baked at build — redeploy after change. |

---

*Ingestion reminders (offline): after changing `EMBEDDING_MODEL` (`src/lib/openai.ts`), you **must** delete & re-ingest the entire Chroma collection — never mix models.*
