"use client";

import { useState, FormEvent } from "react";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const router = useRouter();
  const [passphrase, setPassphrase] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = passphrase.trim();
    if (!trimmed) {
      setError("Please enter the passphrase.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ passphrase: trimmed }),
      });

      if (res.ok) {
        // Success — session cookie is set httpOnly by server.
        // Use hard navigation so middleware sees cookie on next request.
        // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- intentional hard navigation for cookie
        window.location.href = "/";
        // Fallback for router:
        setTimeout(() => router.push("/"), 200);
        return;
      }

      // Try to parse error message
      let msg = "Wrong passphrase. Try again.";
      try {
        const data = await res.json();
        if (data?.error && typeof data.error === "string") {
          // sanitize common cases
          if (res.status === 401) msg = "Wrong passphrase. Please check and try again.";
          else msg = data.error;
        }
      } catch {
        if (res.status === 429) msg = "Too many attempts. Please wait and try again.";
        else if (res.status === 401) msg = "Wrong passphrase. Please check and try again.";
        else if (!res.ok) msg = `Login failed (${res.status}). Please try again.`;
      }
      setError(msg);
    } catch {
      setError("Network error. Please check your connection and try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen flex-col bg-[#f8fafc]">
      {/* subtle background pattern */}
      <div className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-b from-blue-50/70 via-[#f8fafc] to-[#f8fafc]" />
        <div className="absolute left-1/2 top-[-10%] h-[600px] w-[900px] -translate-x-1/2 rounded-full bg-gradient-to-r from-blue-100/40 via-indigo-100/40 to-violet-100/40 blur-3xl" />
        <div className="absolute right-[-10%] top-[30%] h-[400px] w-[400px] rounded-full bg-blue-100/30 blur-3xl" />
      </div>

      {/* Top brand */}
      <header className="w-full px-6 py-6">
        <div className="mx-auto flex max-w-5xl items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-slate-900 text-white shadow">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
              <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
              <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
            </svg>
          </div>
          <span className="text-sm font-semibold tracking-tight text-slate-900">Sociology RAG</span>
          <span className="hidden text-sm text-slate-400 sm:inline">— Nishant Sir • LevelUp IAS 2024</span>
        </div>
      </header>

      <main className="flex flex-1 items-center justify-center px-4 py-10">
        <div className="w-full max-w-[420px]">
          {/* Card */}
          <div className="overflow-hidden rounded-[20px] border border-slate-200 bg-white shadow-xl shadow-slate-200/60">
            {/* Accent top */}
            <div className="h-1 w-full bg-gradient-to-r from-blue-600 via-indigo-600 to-violet-600" />
            <div className="px-7 pb-7 pt-7 sm:px-8 sm:pb-8">
              {/* Lock icon */}
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-blue-600 text-white shadow-lg shadow-blue-600/20">
                <svg
                  width="22"
                  height="22"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.9"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                  <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                  <circle cx="12" cy="16" r="1.2" fill="currentColor" stroke="none" />
                </svg>
              </div>

              <h1 className="mt-4 text-center text-[22px] font-semibold tracking-tight text-slate-900">
                Enter passphrase
              </h1>
              <p className="mt-1.5 text-center text-sm leading-relaxed text-slate-500">
                This is a study-group only tool. Enter the shared passphrase to continue.
              </p>

              <form onSubmit={handleSubmit} className="mt-6 space-y-4" noValidate>
                <div className="space-y-2">
                  <label htmlFor="passphrase" className="block text-sm font-medium text-slate-700">
                    Passphrase
                  </label>
                  <div className="relative">
                    <input
                      id="passphrase"
                      type="password"
                      autoComplete="current-password"
                      autoFocus
                      value={passphrase}
                      onChange={(e) => {
                        setPassphrase(e.target.value);
                        if (error) setError(null);
                      }}
                      placeholder="••••••••"
                      disabled={loading}
                      className="w-full rounded-xl border border-slate-200 bg-white px-3.5 py-3 pr-10 text-[15px] text-slate-900 placeholder:text-slate-400 shadow-sm outline-none transition focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10 disabled:cursor-not-allowed disabled:bg-slate-50"
                      aria-invalid={error ? "true" : "false"}
                      aria-describedby={error ? "login-error" : undefined}
                    />
                    <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-slate-400">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
                        <rect x="3" y="11" width="18" height="11" rx="2" />
                        <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                      </svg>
                    </span>
                  </div>
                </div>

                {error && (
                  <div
                    id="login-error"
                    role="alert"
                    className="flex gap-2.5 rounded-xl border border-red-200 bg-red-50 px-3.5 py-3 text-sm leading-relaxed text-red-800 animate-fadeIn"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="mt-0.5 shrink-0" aria-hidden="true">
                      <circle cx="12" cy="12" r="10" />
                      <path d="M12 8v4" />
                      <path d="M12 16h.01" />
                    </svg>
                    <span>{error}</span>
                  </div>
                )}

                <button
                  type="submit"
                  disabled={loading || passphrase.trim().length === 0}
                  className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-slate-900 px-4 py-3 text-sm font-semibold text-white shadow-lg shadow-slate-900/10 transition hover:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60 active:scale-[0.99]"
                >
                  {loading ? (
                    <>
                      <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" aria-hidden="true" />
                      Checking…
                    </>
                  ) : (
                    <>
                      Unlock
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                        <path d="M5 12h14" />
                        <path d="m12 5 7 7-7 7" />
                      </svg>
                    </>
                  )}
                </button>

                <p className="text-center text-xs leading-relaxed text-slate-500">
                  Contact admin for access — this is a study-group only tool
                </p>
              </form>
            </div>

            {/* Footer meta */}
            <div className="border-t border-slate-100 bg-slate-50/70 px-7 py-3.5 sm:px-8">
              <p className="text-center text-xs text-slate-500">
                Protected by shared-passphrase gate • <span className="font-medium text-slate-600">LevelUp IAS 2024 handouts</span>
              </p>
            </div>
          </div>

          {/* Under-card help */}
          <p className="mt-6 text-center text-xs text-slate-400">
            Trouble logging in? Check with your group admin or try refreshing.
          </p>
        </div>
      </main>

      <footer className="px-6 py-6 text-center text-xs text-slate-400">Answers are grounded in the 2024 handouts only — not general knowledge</footer>
    </div>
  );
}
