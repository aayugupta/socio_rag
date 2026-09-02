/**
 * OpenAI client singleton — src/lib/openai.ts:1
 * Server-only. Never prefix key with NEXT_PUBLIC_ (arch §3.1).
 */

import OpenAI from "openai";

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let openaiClient: OpenAI | null = null;

function getOpenAIClient(): OpenAI {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || apiKey.trim().length === 0) {
    throw new Error(
      "OpenAI not configured: missing OPENAI_API_KEY env var (server-only, never use NEXT_PUBLIC_ prefix)"
    );
  }
  if (!openaiClient) {
    openaiClient = new OpenAI({ apiKey: apiKey.trim() });
  }
  return openaiClient;
}

// ---------------------------------------------------------------------------
// Embeddings — text-embedding-3-small (ADR-2). NEVER mix embedding models.
// ---------------------------------------------------------------------------

/** Embedding model must be consistent between ingestion and query time (arch ADR-2). */
export const EMBEDDING_MODEL = "text-embedding-3-small" as const;
/** Chat model for grounded generation (per rag.ts orchestrator). */
export const CHAT_MODEL = "gpt-4o-mini" as const;

export async function embedText(text: string): Promise<number[]> {
  if (typeof text !== "string" || text.trim().length === 0) {
    throw new Error("embedText: input must be a non-empty string");
  }
  // Guard large inputs — embeddings API limit ~8191 tokens; ~33000 chars rough upper bound. 2000 char cap from validateInput keeps us safe.
  const trimmed = text.trim().slice(0, 8000);

  const client = getOpenAIClient();
  try {
    const res = await client.embeddings.create({
      model: EMBEDDING_MODEL,
      input: trimmed,
    });
    const embedding = res.data[0]?.embedding;
    if (!embedding || embedding.length === 0) {
      throw new Error("OpenAI embeddings returned empty vector");
    }
    return embedding;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Do not leak API key — rethrow sanitized
    throw new Error(`Embedding failed: ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// Chat generation
// ---------------------------------------------------------------------------

export interface GenerateAnswerOptions {
  temperature?: number;
  maxTokens?: number;
  systemPrompt?: string;
}

export interface GenerateAnswerResult {
  answer: string;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
}

/**
 * Generate answer via Chat Completions — with Groq free-tier fallback.
 * If OpenAI fails with insufficient_quota / 429, tries GROQ_API_KEY (llama-3.1-8b-instant).
 * Groq is OpenAI-compatible; we reuse same prompt format.
 */
export async function generateAnswer(
  prompt: string,
  options: GenerateAnswerOptions = {}
): Promise<GenerateAnswerResult> {
  if (typeof prompt !== "string" || prompt.trim().length === 0) {
    throw new Error("generateAnswer: prompt must be a non-empty string");
  }

  const { temperature = 0, maxTokens = 700, systemPrompt } = options;
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
  if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
  messages.push({ role: "user", content: prompt });

  // Helper to detect quota/rate errors
  const isQuotaErr = (msg: string) => /insufficient_quota|credit_balance_exhausted|429|quota|billing/i.test(msg);

  const groqKey = process.env.GROQ_API_KEY?.trim();
  const groqModel = process.env.GROQ_MODEL?.trim() || "allam-2-7b";
  const useGroqPrimary = !!groqKey && groqKey.length >= 10 && groqKey.startsWith("gsk_");

  // If Groq is configured (user wants Groq as primary), try Groq FIRST — no OpenAI attempt
  if (useGroqPrimary) {
    const tryModels = [groqModel, "allam-2-7b", "qwen/qwen3-32b", "groq/compound-mini"].filter((v,i,a)=>a.indexOf(v)===i);
    let lastErr: string | null = null;
    for (const mdl of tryModels) {
      try {
        let Groq: any;
        try { Groq = (await import("groq-sdk")).default; } catch { throw new Error("groq-sdk not installed (npm install groq-sdk)"); }
        const groq = new Groq({ apiKey: groqKey });
        const res = await groq.chat.completions.create({
          model: mdl,
          messages: messages as any,
          temperature,
          max_tokens: maxTokens,
        });
        const answer = (res.choices[0] as any)?.message?.content?.trim() ?? "";
        if (!answer) throw new Error("Groq returned empty content");
        if (mdl !== groqModel) console.warn(`[groq] fallback model ${mdl} succeeded (primary ${groqModel} failed)`);
        return {
          answer,
          usage: (res as any).usage ? { promptTokens: (res as any).usage?.prompt_tokens, completionTokens: (res as any).usage?.completion_tokens, totalTokens: (res as any).usage?.total_tokens } : undefined,
        };
      } catch (gErr) {
        const gMsg = gErr instanceof Error ? gErr.message : String(gErr);
        lastErr = gMsg;
        if (/429|rate/i.test(gMsg)) {
          console.warn(`[groq] ${mdl} 429 rate-limit, trying next model...`);
          await new Promise(r => setTimeout(r, 800));
          continue;
        }
        // For non-429 errors, also try next model
        console.warn(`[groq] ${mdl} failed: ${gMsg.slice(0,120)}, trying next...`);
        continue;
      }
    }
    throw new Error(`Groq chat failed (all models ${tryModels.join(",")}): ${lastErr}`);
  }

  // Fallback: try OpenAI (only if Groq not configured or Groq failed)
  try {
    const client = getOpenAIClient();
    const res = await client.chat.completions.create({
      model: CHAT_MODEL,
      messages,
      temperature,
      max_tokens: maxTokens,
    });
    const answer = res.choices[0]?.message?.content?.trim() ?? "";
    if (!answer) throw new Error("OpenAI chat returned empty content");
    return {
      answer,
      usage: res.usage ? { promptTokens: res.usage.prompt_tokens, completionTokens: res.usage.completion_tokens, totalTokens: res.usage.total_tokens } : undefined,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // If OpenAI quota and Groq exists as secondary, try Groq (should have been primary already, but keep for safety)
    if (isQuotaErr(msg) && groqKey && groqKey.length >= 10) {
      console.warn(`[openai] OpenAI quota exhausted, falling back to Groq ${groqModel}`);
      let Groq: any;
      Groq = (await import("groq-sdk")).default;
      const groq = new Groq({ apiKey: groqKey });
      const res = await groq.chat.completions.create({ model: groqModel, messages: messages as any, temperature, max_tokens: maxTokens });
      const answer = (res.choices[0] as any)?.message?.content?.trim() ?? "";
      if (!answer) throw new Error("Groq returned empty content");
      return { answer, usage: (res as any).usage ? { promptTokens: (res as any).usage?.prompt_tokens, completionTokens: (res as any).usage?.completion_tokens, totalTokens: (res as any).usage?.total_tokens } : undefined };
    }
    throw new Error(`Chat generation failed: ${msg}`);
  }
}

/**
 * Lower-level helper if caller already has message array.
 */
export async function generateChat(
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
  opts: Omit<GenerateAnswerOptions, "systemPrompt"> = {}
): Promise<GenerateAnswerResult> {
  if (!messages || messages.length === 0) throw new Error("generateChat: messages must be non-empty");
  const client = getOpenAIClient();
  const { temperature = 0, maxTokens = 700 } = opts;
  const res = await client.chat.completions.create({
    model: CHAT_MODEL,
    messages,
    temperature,
    max_tokens: maxTokens,
  });
  const answer = res.choices[0]?.message?.content?.trim() ?? "";
  return {
    answer,
    usage: res.usage
      ? {
          promptTokens: res.usage.prompt_tokens,
          completionTokens: res.usage.completion_tokens,
          totalTokens: res.usage.total_tokens,
        }
      : undefined,
  };
}

/**
 * Test helper to reset singleton.
 */
export function _resetOpenAIForTests(): void {
  openaiClient = null;
}
