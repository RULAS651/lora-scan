import type { Metadata } from "next";
import "./globals.css";
import { AuthProvider } from "@/lib/auth";
import Link from "next/link";
import { Suspense } from "react";
import NavBar from "@/components/NavBar";

export const metadata: Metadata = {
  title: "LoRA Scan — Privacy-First Face → LoRA Studio",
  description: "Upload multi-angle face scans. Train personal LoRAs. AES-256 encrypted. You own your data.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">
        <AuthProvider>
          <div className="min-h-screen flex flex-col">
            <Suspense fallback={null}>
              <NavBar />
            </Suspense>
            <main className="flex-1 max-w-7xl mx-auto w-full px-4 sm:px-6 lg:px-8 py-6">
              {children}
            </main>
            <footer className="border-t border-white/10 py-6 text-xs text-white/40 text-center">
              <p>All face data AES-256-GCM encrypted per member. Raw scans auto-delete after training.</p>
            </footer>
          </div>
        </AuthProvider>
      </body>
    </html>
  );
}
