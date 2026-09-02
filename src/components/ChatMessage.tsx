"use client";

import CitationPill from "./CitationPill";

export interface ChatMessageProps {
  role: "user" | "assistant";
  content: string;
  citations?: Array<{ page: string | number | null; textPreview: string; chunkId?: string }>;
  isScopeRefusal?: boolean;
}

// Lightweight markdown-ish bold renderer: **bold** -> <strong>
function renderInlineMarkdown(text: string) {
  // Escape html first
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  // Bold: **text** or __text__
  const withBold = escaped
    .replace(/\*\*(.+?)\*\*/g, '<strong class="font-semibold text-slate-900">$1</strong>')
    .replace(/__(.+?)__/g, '<strong class="font-semibold text-slate-900">$1</strong>');

  // Inline citations like [Source: Page 42] -> styled span (non-interactive, just visual)
  const withCitations = withBold.replace(
    /\[Source:\s*Page\s*([^\]]+)\]/gi,
    '<span class="inline-flex items-center rounded-full bg-blue-50 px-1.5 py-0.5 text-xs font-medium text-blue-700 border border-blue-100 align-middle">[Page $1]</span>'
  );

  // Preserve line breaks
  const withBreaks = withCitations.replace(/\n/g, "<br />");

  return withBreaks;
}

export default function ChatMessage({ role, content, citations, isScopeRefusal }: ChatMessageProps) {
  const isUser = role === "user";
  const isRefusal = isScopeRefusal || content.trim() === "This is out of my scope.";

  if (isUser) {
    return (
      <div className="flex w-full justify-end animate-fadeIn">
        <div className="flex max-w-[85%] sm:max-w-[78%] flex-col items-end gap-1.5">
          <div className="rounded-2xl rounded-br-md bg-blue-600 px-4 py-3 text-[15px] leading-relaxed text-white shadow-md shadow-blue-600/20">
            <p className="whitespace-pre-wrap break-words">{content}</p>
          </div>
          <span className="pr-1 text-[11px] font-medium tracking-wide text-slate-400">You</span>
        </div>
        <div className="ml-2 hidden h-8 w-8 shrink-0 items-center justify-center rounded-full bg-blue-600 text-xs font-semibold text-white shadow sm:inline-flex">
          Y
        </div>
        <div className="ml-2 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-blue-600 text-[11px] font-semibold text-white shadow sm:hidden">
          Y
        </div>
      </div>
    );
  }

  // Assistant
  if (isRefusal) {
    return (
      <div className="flex w-full justify-start animate-fadeIn">
        <div className="mr-2 hidden h-8 w-8 shrink-0 items-center justify-center rounded-full bg-amber-100 text-amber-700 ring-1 ring-amber-200 sm:inline-flex">
          {/* Warning icon */}
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 9v4" />
            <path d="M12 17h.01" />
            <path d="M10.3 3.3 2 18a2 2 0 0 0 1.7 3h16.6a2 2 0 0 0 1.7-3L13.7 3.3a2 2 0 0 0-3.4 0z" />
          </svg>
        </div>
        <div className="mr-2 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-amber-100 text-amber-700 ring-1 ring-amber-200 sm:hidden">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="M12 9v4" />
            <path d="M12 17h.01" />
            <path d="M10.3 3.3 2 18a2 2 0 0 0 1.7 3h16.6a2 2 0 0 0 1.7-3L13.7 3.3a2 2 0 0 0-3.4 0z" />
          </svg>
        </div>
        <div className="max-w-[92%] sm:max-w-[85%]">
          <div className="rounded-2xl rounded-bl-md border border-amber-200 bg-amber-50 px-4 py-3.5 shadow-sm">
            <div className="mb-1 flex items-center gap-2">
              <span className="inline-flex items-center rounded-full bg-amber-200/70 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider text-amber-800">
                Out of scope
              </span>
              <span className="text-xs text-amber-700/70">Grounded guardrail</span>
            </div>
            <p className="text-[15px] font-medium leading-relaxed text-amber-900">
              This is out of my scope.
            </p>
            <p className="mt-1.5 text-xs leading-relaxed text-amber-800/80">
              I can only answer from the 40 handouts (Nishant Sir / LevelUp IAS 2024). Try rephrasing — if the idea is covered in the notes, I&apos;ll cite the page.
            </p>
          </div>
          <span className="ml-1 mt-1.5 inline-block text-[11px] font-medium tracking-wide text-slate-400">
            Sociology RAG • LevelUp IAS
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex w-full justify-start animate-fadeIn">
      <div className="mr-2 hidden h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-900 text-white shadow sm:inline-flex">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 6a4 4 0 0 1 4 4 4 4 0 0 1-4 4 4 4 0 0 1-4-4 4 4 0 0 1 4-4z" />
          <path d="M12 14a7 7 0 0 0-7 7h14a7 7 0 0 0-7-7z" />
        </svg>
      </div>
      <div className="mr-2 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-slate-900 text-white shadow sm:hidden">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
          <path d="M12 6a4 4 0 0 1 4 4 4 4 0 0 1-4 4 4 4 0 0 1-4-4 4 4 0 0 1 4-4z" />
          <path d="M12 14a7 7 0 0 0-7 7h14a7 7 0 0 0-7-7z" />
        </svg>
      </div>
      <div className="flex max-w-[92%] flex-col gap-2 sm:max-w-[85%]">
        <div className="rounded-2xl rounded-bl-md border border-slate-200 bg-white px-4 py-3.5 shadow-sm shadow-slate-200/50">
          <div
            className="prose max-w-none text-[15px] leading-relaxed text-slate-800"
            // biome-ignore lint/security/noDangerouslySetInnerHtml: controlled markdown-ish rendering
            dangerouslySetInnerHTML={{ __html: renderInlineMarkdown(content) }}
          />
          {citations && citations.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1.5 border-t border-slate-100 pt-3">
              {citations.map((c, i) => (
                <CitationPill key={`${c.page}-${i}-${c.chunkId ?? ""}`} page={c.page} textPreview={c.textPreview} chunkId={c.chunkId} />
              ))}
            </div>
          )}
        </div>
        <div className="ml-1 flex items-center gap-2">
          <span className="text-[11px] font-medium tracking-wide text-slate-400">Sociology RAG • LevelUp IAS</span>
          {citations && citations.length > 0 && (
            <span className="hidden items-center gap-1 text-[11px] text-slate-400 sm:inline-flex">
              <span className="h-1 w-1 rounded-full bg-slate-300" />
              {citations.length} source{citations.length !== 1 ? "s" : ""}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
