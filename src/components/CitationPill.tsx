"use client";

import { useState, useRef, useEffect } from "react";

export interface CitationPillProps {
  page: string | number | null;
  textPreview: string;
  chunkId?: string;
}

export default function CitationPill({ page, textPreview }: CitationPillProps) {
  const [open, setOpen] = useState(false);
  const [tooltipPos, setTooltipPos] = useState<"top" | "bottom">("top");
  const pillRef = useRef<HTMLButtonElement>(null);
  const timeoutRef = useRef<number | null>(null);

  const label = page !== null && page !== undefined && String(page).trim() !== "" ? `Page ${String(page).replace(/^Page\s*/i, "")}` : "Source";

  const handleEnter = () => {
    if (timeoutRef.current) window.clearTimeout(timeoutRef.current);
    // Decide position based on viewport space
    if (pillRef.current) {
      const rect = pillRef.current.getBoundingClientRect();
      // if close to top, show below
      if (rect.top < 180) setTooltipPos("bottom");
      else setTooltipPos("top");
    }
    setOpen(true);
  };

  const handleLeave = () => {
    if (timeoutRef.current) window.clearTimeout(timeoutRef.current);
    // small delay to allow moving to tooltip
    timeoutRef.current = window.setTimeout(() => setOpen(false), 120);
  };

  const handleClick = () => {
    setOpen((v) => !v);
    if (pillRef.current) {
      const rect = pillRef.current.getBoundingClientRect();
      if (rect.top < 180) setTooltipPos("bottom");
      else setTooltipPos("top");
    }
  };

  useEffect(() => {
    return () => {
      if (timeoutRef.current) window.clearTimeout(timeoutRef.current);
    };
  }, []);

  // Close on outside click / escape when open via click on mobile
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onClickOutside = (e: MouseEvent) => {
      if (pillRef.current && !pillRef.current.contains(e.target as Node)) {
        // also check tooltip itself
        const tooltipEl = document.getElementById(`tooltip-${label}-${textPreview.slice(0, 20)}`);
        if (tooltipEl && tooltipEl.contains(e.target as Node)) return;
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onClickOutside);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onClickOutside);
    };
  }, [open, label, textPreview]);

  return (
    <div className="relative inline-flex">
      <button
        ref={pillRef}
        type="button"
        onMouseEnter={handleEnter}
        onMouseLeave={handleLeave}
        onFocus={handleEnter}
        onBlur={handleLeave}
        onClick={handleClick}
        aria-describedby={open ? `tooltip-${label}` : undefined}
        aria-expanded={open}
        className="group inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-medium text-slate-700 shadow-sm transition-all hover:border-blue-200 hover:bg-blue-50 hover:text-blue-700 hover:shadow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1 active:scale-[0.97]"
      >
        {/* Book icon */}
        <svg
          aria-hidden="true"
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="shrink-0 opacity-70 group-hover:opacity-100"
        >
          <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
          <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
        </svg>
        <span>{label}</span>
        <span
          aria-hidden="true"
          className="ml-0.5 inline-flex h-3.5 w-3.5 items-center justify-center rounded-full bg-slate-100 text-[10px] leading-none text-slate-500 group-hover:bg-blue-100 group-hover:text-blue-600"
        >
          i
        </span>
      </button>

      {/* Tooltip */}
      <div
        id={`tooltip-${label}`}
        role="tooltip"
        className={`absolute left-1/2 z-20 w-72 -translate-x-1/2 transition-all duration-150 ${
          tooltipPos === "top" ? "bottom-full mb-2" : "top-full mt-2"
        } ${open ? "pointer-events-auto opacity-100 translate-y-0" : "pointer-events-none opacity-0 translate-y-1"}`}
        onMouseEnter={handleEnter}
        onMouseLeave={handleLeave}
      >
        <div
          className={`relative rounded-xl border border-slate-200 bg-slate-900 px-3.5 py-3 text-xs leading-relaxed text-slate-100 shadow-xl ${
            open ? "animate-slideIn" : ""
          }`}
        >
          {/* Arrow */}
          <div
            className={`absolute left-1/2 h-2 w-2 -translate-x-1/2 rotate-45 bg-slate-900 border-slate-200 ${
              tooltipPos === "top"
                ? "-bottom-1 border-b border-r"
                : "-top-1 border-l border-t"
            }`}
          />
          <div className="mb-1.5 flex items-center gap-2">
            <span className="inline-flex items-center gap-1 rounded-full bg-white/10 px-2 py-0.5 text-[11px] font-semibold tracking-wide text-blue-200">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="opacity-80">
                <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
                <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
              </svg>
              {label}
            </span>
            <span className="text-[11px] text-slate-400">Preview</span>
          </div>
          <p className="line-clamp-6 whitespace-pre-wrap break-words font-normal text-slate-200">
            {textPreview?.trim() ? textPreview.trim() : "No preview available for this source."}
          </p>
          <p className="mt-2 text-[11px] text-slate-400">Grounded excerpt from the 2024 handouts</p>
        </div>
      </div>
    </div>
  );
}
