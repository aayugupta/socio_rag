import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Sociology RAG — Nishant Sir (LevelUp IAS) 2024",
  description:
    "Ask anything from the 40 handouts — grounded, cited answers. UPSC Sociology RAG chatbot grounded strictly in Nishant Sir's 2024 LevelUp IAS material.",
  keywords: [
    "Sociology",
    "UPSC",
    "RAG",
    "Nishant Sir",
    "LevelUp IAS",
    "Chatbot",
    "Handouts",
  ],
  authors: [{ name: "LevelUp IAS" }],
  openGraph: {
    title: "Sociology RAG — Nishant Sir (LevelUp IAS) 2024",
    description:
      "Ask anything from the 40 handouts — grounded, cited answers.",
    type: "website",
  },
  robots: {
    index: false,
    follow: false,
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-[#f8fafc] text-slate-900 selection:bg-blue-100">
        {children}
        <div id="toast-root" aria-live="polite" aria-atomic="true" />
      </body>
    </html>
  );
}
