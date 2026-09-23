"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useAuth } from "@/lib/auth";
import { REQUIRED_ANGLES } from "@/lib/hooks/useScanSession";

export default function ScanIntro() {
  const { me, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!loading && me) router.push(`/scan/new`);
  }, [me, loading, router]);

  if (loading || !me) {
    return (
      <div className="max-w-3xl mx-auto mt-8">
        <div className="card">
          <div className="animate-pulse h-5 w-1/3 bg-white/10 rounded mb-4" />
          <div className="animate-pulse h-3 w-2/3 bg-white/5 rounded mb-2" />
          <div className="animate-pulse h-3 w-1/2 bg-white/5 rounded" />
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto mt-8">
      <div className="card">
        <h1 className="text-2xl font-semibold">Getting ready…</h1>
        <p className="text-white/70 mt-2">
          You need {REQUIRED_ANGLES.length} angles: {REQUIRED_ANGLES.join(", ")}.
        </p>
        <div className="mt-6">
          <Link href="/scan/new" className="btn-primary">Start scan wizard →</Link>
        </div>
      </div>
    </div>
  );
}
