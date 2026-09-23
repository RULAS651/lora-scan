"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAuth } from "@/lib/auth";

export default function NavBar() {
  const { me, loading, logout } = useAuth();
  const p = usePathname();

  const item = (href: string, label: string) => (
    <Link
      href={href}
      className={`text-sm px-3 py-1.5 rounded-md transition ${
        p === href ? "bg-white/10 text-white" : "text-white/70 hover:text-white hover:bg-white/5"
      }`}
    >{label}</Link>
  );

  return (
    <header className="border-b border-white/10 sticky top-0 z-40 backdrop-blur bg-[#0b0b14]/80">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-14 flex items-center justify-between">
        <Link href="/" className="flex items-center gap-2 font-bold tracking-tight">
          <span className="inline-block w-7 h-7 rounded-md bg-gradient-to-br from-brand-500 to-brand-700 shadow-inner" />
          <span>LoRA Scan</span>
          <span className="badge badge-info ml-2">Privacy First</span>
        </Link>
        <nav className="flex items-center gap-1">
          {!loading && me ? (
            <>
              {item("/dashboard", "Dashboard")}
              {item("/scan", "Face Scan")}
              {me.role === "ADMIN" && item("/admin", "Admin")}
              <div className="w-px h-5 bg-white/10 mx-2" />
              <span className="text-xs text-white/50 mr-2">{me.email}</span>
              <button className="btn-ghost text-xs" onClick={logout}>Sign out</button>
            </>
          ) : (
            <>
              {item("/login", "Sign in")}
              {item("/register", "Create account")}
            </>
          )}
        </nav>
      </div>
    </header>
  );
}
