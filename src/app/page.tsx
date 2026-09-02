"use client";

/* eslint-disable react-hooks/purity -- id generation with Date.now inside event handlers is safe; rule is over-eager for handlers */
import { useState, useRef, useEffect, useCallback } from "react";
import ChatMessage from "@/components/ChatMessage";

type Citation = { page: string | number | null; textPreview: string; chunkId?: string };
type Msg = {
  id: string;
  role: "user" | "assistant";
  content: string;
  citations?: Citation[];
  isScopeRefusal?: boolean;
};

const EXAMPLE_PROMPTS = [
  "What does Nishant Sir say about Weber's bureaucracy?",
  "Explain functionalist perspective on social equilibrium as per the document",
  "Compare Marx and Weber on stratification",
] as const;

const OUT_OF_SCOPE_TEXT = "This is out of my scope.";

export default function Home() {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [showToast, setShowToast] = useState(false);

  const listRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const endRef = useRef<HTMLDivElement>(null);

  const MAX = 2000;
  const remaining = MAX - input.length;
  const isOver = input.length > MAX;
  const canSend = input.trim().length > 0 && !isOver && !loading;

  const showErrorToast = useCallback((msg: string) => {
    setToast(msg);
    setShowToast(true);
    window.setTimeout(() => setShowToast(false), 4000);
    window.setTimeout(() => setToast(null), 4500);
  }, []);

  const scrollToBottom = useCallback((smooth = true) => {
    endRef.current?.scrollIntoView({ behavior: smooth ? "smooth" : "instant", block: "end" });
  }, []);

  useEffect(() => {
    scrollToBottom(messages.length <= 2);
  }, [messages, loading, scrollToBottom]);

  useEffect(() => {
    // autofocus textarea on mount (desktop)
    if (textareaRef.current && window.innerWidth >= 640) textareaRef.current.focus();
  }, []);

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const newH = Math.min(el.scrollHeight, 160);
    el.style.height = `${newH}px`;
  }, [input]);

  async function sendMessage(textOverride?: string) {
    const raw = (textOverride ?? input).trim();
    if (!raw || loading) return;
    if (raw.length > MAX) {
      showErrorToast(`Message too long — please keep it under ${MAX} characters.`);
      return;
    }

    const userMsg: Msg = { id: `u-${Date.now()}`, role: "user", content: raw.slice(0, MAX) };
    setMessages((m) => [...m, userMsg]);
    setInput("");
    setLoading(true);

    // Re-focus textarea after send for quick follow-ups (unless mobile)
    requestAnimationFrame(() => textareaRef.current?.focus());

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: raw }),
      });

      if (res.status === 401) {
        showErrorToast("Session expired — redirecting to login…");
        window.setTimeout(() => {
          // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- intentional hard navigation to ensure middleware sees cookie
          window.location.href = "/login";
        }, 900);
        // Remove optimistic user message? Keep it, but add system note
        setMessages((m) => [
          ...m,
          {
            id: `a-${Date.now()}-401`,
            role: "assistant",
            content: OUT_OF_SCOPE_TEXT,
            isScopeRefusal: true,
          },
        ]);
        return;
      }

      if (res.status === 429) {
        let retryMsg = "Too many requests. Please slow down and try again in a moment.";
        try {
          const j = await res.json();
          if (j?.error) retryMsg = j.error;
        } catch {}
        showErrorToast(retryMsg);
        setMessages((m) => [
          ...m,
          {
            id: `a-${Date.now()}-429`,
            role: "assistant",
            content: retryMsg,
            isScopeRefusal: false,
          },
        ]);
        return;
      }

      if (!res.ok) {
        let errText = "Something went wrong. Please try again.";
        try {
          const j = await res.json();
          if (j?.error && typeof j.error === "string") errText = j.error;
          // sanitize generic
          if (res.status >= 500) errText = "Something went wrong on our side. Please try again in a moment.";
        } catch {}
        showErrorToast(errText);
        // Also add assistant bubble with friendly fallback so conversation isn't blank
        setMessages((m) => [
          ...m,
          {
            id: `a-${Date.now()}-err`,
            role: "assistant",
            content: errText.includes("Something went wrong") ? errText : `Something went wrong. Please try again.`,
          },
        ]);
        return;
      }

      const data: { answer: string; citations?: Citation[]; gated?: boolean } = await res.json();
      const answer = typeof data.answer === "string" ? data.answer : "";
      const citations: Citation[] = Array.isArray(data.citations) ? data.citations : [];
      const isRefusal = data.gated === true || answer.trim() === OUT_OF_SCOPE_TEXT;

      setMessages((m) => [
        ...m,
        {
          id: `a-${Date.now()}`,
          role: "assistant",
          content: answer || "I couldn't generate an answer. Please try again.",
          citations: isRefusal ? [] : citations,
          isScopeRefusal: isRefusal,
        },
      ]);
    } catch (err) {
      console.error(err);
      showErrorToast("Network error. Please check your connection and try again.");
      setMessages((m) => [
        ...m,
        {
          id: `a-${Date.now()}-net`,
          role: "assistant",
          content: "Network error. Please check your connection and try again.",
        },
      ]);
    } finally {
      setLoading(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (canSend) sendMessage();
    }
  }

  const counterColor =
    remaining < 0
      ? "text-red-600"
      : remaining < 100
        ? "text-amber-600"
        : remaining < 300
          ? "text-slate-500"
          : "text-slate-400";

  return (
    <div className="flex min-h-screen flex-col bg-[#f8fafc]">
      {/* Background decoration */}
      <div className="pointer-events-none fixed inset-0 -z-10">
        <div className="absolute inset-0 bg-gradient-to-b from-white via-[#f8fafc] to-[#f1f5f9]" />
        <div className="absolute left-1/2 top-0 h-[480px] w-[1000px] -translate-x-1/2 rounded-full bg-gradient-to-r from-blue-50 via-indigo-50 to-violet-50 opacity-70 blur-3xl" />
      </div>

      {/* Header */}
      <header className="sticky top-0 z-30 border-b border-slate-200/70 bg-white/80 backdrop-blur-xl supports-[backdrop-filter]:bg-white/70">
        <div className="mx-auto flex w-full max-w-5xl items-center justify-between gap-4 px-4 py-3.5 sm:px-6 sm:py-4">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-slate-900 text-white shadow-md shadow-slate-900/10">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
                <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
              </svg>
            </div>
            <div className="min-w-0">
              <h1 className="truncate text-[15px] font-semibold tracking-tight text-slate-900 sm:text-[16px]">
                Sociology RAG — Nishant Sir (LevelUp IAS) 2024
              </h1>
              <p className="hidden truncate text-xs leading-none text-slate-500 sm:block">
                Ask anything from the 40 handouts — grounded, cited answers
              </p>
              <p className="truncate text-[11px] leading-none text-slate-500 sm:hidden">
                40 handouts • grounded, cited
              </p>
            </div>
          </div>

          <div className="hidden shrink-0 items-center gap-2 sm:flex">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />
              Grounded only
            </span>
            <span className="hidden items-center gap-1.5 rounded-full bg-slate-900 px-2.5 py-1 text-xs font-medium text-white lg:inline-flex">
              40 handouts • 2024
            </span>
          </div>

          {/* Mobile badge */}
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-slate-900 px-2.5 py-1 text-[11px] font-medium text-white sm:hidden">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
            Live
          </span>
        </div>
      </header>

      {/* Main */}
      <main className="flex flex-1 flex-col">
        {/* Message list */}
        <div
          ref={listRef}
          className="custom-scrollbar flex-1 overflow-y-auto"
          aria-live="polite"
          aria-relevant="additions"
        >
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6 sm:px-6 sm:py-8">
            {messages.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-8 sm:py-12">
                {/* Empty state card */}
                <div className="w-full max-w-2xl rounded-[20px] border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
                  <div className="flex flex-col items-center text-center">
                    <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-blue-600 text-white shadow-lg shadow-blue-600/20">
                      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
                        <path d="M21 11.5a8.5 8.5 0 0 1-12.5 7.5L3 21l2-5.5A8.5 8.5 0 0 1 21 11.5z" />
                        <path d="M8 12h8" />
                        <path d="M8 8h8" />
                      </svg>
                    </div>
                    <h2 className="mt-4 text-xl font-semibold tracking-tight text-slate-900">Start a conversation</h2>
                    <p className="mt-2 max-w-md text-sm leading-relaxed text-slate-500">
                      Ask anything from Nishant Sir&apos;s 40 handouts. Every answer is grounded in the document with page citations — and I&apos;ll say{" "}
                      <span className="font-medium text-amber-700">&ldquo;This is out of my scope.&rdquo;</span> if it&apos;s not in the notes.
                    </p>

                    <div className="mt-6 grid w-full gap-2.5 sm:grid-cols-1">
                      {EXAMPLE_PROMPTS.map((prompt) => (
                        <button
                          key={prompt}
                          type="button"
                          onClick={() => sendMessage(prompt)}
                          disabled={loading}
                          className="group flex w-full items-center gap-3 rounded-2xl border border-slate-200 bg-slate-50/70 px-4 py-3.5 text-left transition hover:border-blue-200 hover:bg-blue-50/70 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white text-slate-500 shadow-sm ring-1 ring-slate-200 group-hover:bg-blue-600 group-hover:text-white group-hover:ring-blue-600">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" aria-hidden="true">
                              <path d="M5 12h14" />
                              <path d="m12 5 7 7-7 7" />
                            </svg>
                          </span>
                          <span className="text-sm leading-snug text-slate-700 group-hover:text-slate-900">{prompt}</span>
                        </button>
                      ))}
                    </div>

                    <div className="mt-6 flex flex-wrap items-center justify-center gap-2 text-xs text-slate-400">
                      <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-2.5 py-1">
                        <span className="h-1.5 w-1.5 rounded-full bg-blue-500" />
                        Faithful to handouts
                      </span>
                      <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-2.5 py-1 text-amber-700 ring-1 ring-amber-200">
                        Refuses out-of-scope
                      </span>
                      <span className="inline-flex items-center gap-1.5 rounded-full bg-white px-2.5 py-1 ring-1 ring-slate-200">
                        Page citations
                      </span>
                    </div>
                  </div>
                </div>

                {/* Tips */}
                <div className="mt-6 hidden w-full max-w-2xl items-center justify-center gap-4 text-xs text-slate-400 sm:flex">
                  <span className="flex items-center gap-1.5">
                    <kbd className="rounded border border-slate-200 bg-white px-1.5 py-0.5 font-mono text-[11px] shadow-sm">Enter</kbd>
                    to send
                  </span>
                  <span className="h-3 w-px bg-slate-200" />
                  <span className="flex items-center gap-1.5">
                    <kbd className="rounded border border-slate-200 bg-white px-1.5 py-0.5 font-mono text-[11px] shadow-sm">Shift</kbd>
                    <span>+</span>
                    <kbd className="rounded border border-slate-200 bg-white px-1.5 py-0.5 font-mono text-[11px] shadow-sm">Enter</kbd>
                    new line
                  </span>
                  <span className="h-3 w-px bg-slate-200" />
                  <span>Max {MAX} chars</span>
                </div>
              </div>
            ) : (
              <>
                {messages.map((m) => (
                  <ChatMessage
                    key={m.id}
                    role={m.role}
                    content={m.content}
                    citations={m.citations}
                    isScopeRefusal={m.isScopeRefusal}
                  />
                ))}

                {loading && (
                  <div className="flex w-full justify-start animate-fadeIn">
                    <div className="mr-2 hidden h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-900 text-white sm:inline-flex">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                        <path d="M12 6a4 4 0 0 1 4 4 4 4 0 0 1-4 4 4 4 0 0 1-4-4 4 4 0 0 1 4-4z" />
                        <path d="M12 14a7 7 0 0 0-7 7h14a7 7 0 0 0-7-7z" />
                      </svg>
                    </div>
                    <div className="mr-2 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-slate-900 text-white sm:hidden">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                        <path d="M12 6a4 4 0 0 1 4 4 4 4 0 0 1-4 4 4 4 0 0 1-4-4 4 4 0 0 1 4-4z" />
                        <path d="M12 14a7 7 0 0 0-7 7h14a7 7 0 0 0-7-7z" />
                      </svg>
                    </div>
                    <div className="max-w-[85%] rounded-2xl rounded-bl-md border border-slate-200 bg-white px-4 py-3.5 shadow-sm">
                      <div className="flex items-center gap-3">
                        <span className="flex items-center gap-1" aria-hidden="true">
                          <span className="h-2 w-2 rounded-full bg-slate-300" style={{ animation: "typingPulse 1.2s infinite 0s" }} />
                          <span className="h-2 w-2 rounded-full bg-slate-300" style={{ animation: "typingPulse 1.2s infinite 0.2s" }} />
                          <span className="h-2 w-2 rounded-full bg-slate-300" style={{ animation: "typingPulse 1.2s infinite 0.4s" }} />
                        </span>
                        <span className="text-sm text-slate-500">Consulting Nishant Sir&apos;s notes…</span>
                      </div>
                    </div>
                  </div>
                )}
              </>
            )}
            <div ref={endRef} className="h-1 shrink-0" aria-hidden="true" />
          </div>
        </div>

        {/* Composer */}
        <div className="sticky bottom-0 z-20 border-t border-slate-200 bg-white/95 backdrop-blur-xl supports-[backdrop-filter]:bg-white/80">
          <div className="mx-auto w-full max-w-3xl px-4 py-3 sm:px-6 sm:py-4">
            <div className="relative flex flex-col gap-2">
              {/* Input card */}
              <div className="relative flex items-end gap-2 rounded-[20px] border border-slate-200 bg-white p-2 shadow-sm ring-0 transition focus-within:border-blue-300 focus-within:ring-4 focus-within:ring-blue-500/10 sm:p-2.5">
                <textarea
                  ref={textareaRef}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Ask about Weber, Durkheim, Marx, functionalism…"
                  rows={1}
                  maxLength={MAX + 100}
                  disabled={loading}
                  aria-label="Ask a question about the handouts"
                  className="max-h-40 min-h-[44px] flex-1 resize-none bg-transparent px-3 py-2.5 text-[15px] leading-relaxed text-slate-900 placeholder:text-slate-400 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
                />
                <button
                  type="button"
                  onClick={() => sendMessage()}
                  disabled={!canSend}
                  aria-label="Send message"
                  className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-blue-600 text-white shadow-md shadow-blue-600/20 transition hover:bg-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400 disabled:shadow-none active:scale-95 sm:h-11 sm:w-11"
                >
                  {loading ? (
                    <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" aria-hidden="true" />
                  ) : (
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="m22 2-7 20-4-9-9-4Z" />
                      <path d="M22 2 11 13" />
                    </svg>
                  )}
                </button>
              </div>

              {/* Meta bar */}
              <div className="flex items-center justify-between gap-3 px-1">
                <div className="flex items-center gap-2 text-xs">
                  <span className={`font-mono tabular-nums ${counterColor}`}>
                    {input.length}/{MAX}
                  </span>
                  <span className="hidden text-slate-300 sm:inline">•</span>
                  <span className="hidden text-slate-400 sm:inline">
                    <kbd className="rounded border border-slate-200 bg-slate-50 px-1 py-0.5 font-mono text-[10px]">Enter</kbd>
                    <span className="mx-1">to send,</span>
                    <kbd className="rounded border border-slate-200 bg-slate-50 px-1 py-0.5 font-mono text-[10px]">Shift</kbd>
                    <span className="mx-1">+</span>
                    <kbd className="rounded border border-slate-200 bg-slate-50 px-1 py-0.5 font-mono text-[10px]">Enter</kbd>
                    <span className="ml-1">new line</span>
                  </span>
                  <span className="text-slate-400 sm:hidden">Shift+Enter newline</span>
                </div>

                <div className="flex items-center gap-2">
                  {isOver && <span className="text-xs font-medium text-red-600">Too long</span>}
                  {!isOver && input.trim().length > 0 && <span className="hidden text-xs text-slate-400 sm:inline">{input.trim().split(/\s+/).length} words</span>}
                </div>
              </div>
            </div>

            {/* Footer disclaimer */}
            <p className="mt-3 text-center text-xs leading-relaxed text-slate-500">
              Answers are grounded in the 2024 handouts only — not general knowledge
            </p>
          </div>
        </div>
      </main>

      {/* Toast */}
      <div
        aria-live="polite"
        aria-atomic="true"
        className="pointer-events-none fixed inset-x-0 top-4 z-50 flex justify-center px-4"
      >
        <div
          role="status"
          className={`pointer-events-auto max-w-md rounded-xl border bg-slate-900 px-4 py-3 text-sm font-medium text-white shadow-xl transition-all duration-300 ${
            showToast && toast ? "translate-y-0 opacity-100" : "-translate-y-4 opacity-0 pointer-events-none"
          } border-slate-800`}
        >
          <div className="flex items-start gap-2.5">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="mt-0.5 shrink-0 text-red-300" aria-hidden="true">
              <circle cx="12" cy="12" r="10" />
              <path d="M12 8v4" />
              <path d="M12 16h.01" />
            </svg>
            <span className="leading-relaxed">{toast}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
