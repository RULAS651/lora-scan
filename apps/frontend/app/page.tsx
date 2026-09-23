import Link from "next/link";

export default function HomePage() {
  return (
    <div className="py-14 sm:py-24">
      <section className="max-w-4xl">
        <h1 className="text-4xl sm:text-6xl font-bold tracking-tight leading-tight">
          Train personal <span className="bg-gradient-to-r from-brand-400 to-fuchsia-400 bg-clip-text text-transparent">LoRAs</span> from
          face scans.  <span className="text-white/60">Keep every pixel private.</span>
        </h1>
        <p className="mt-6 text-lg text-white/70 max-w-2xl">
          Capture your face from 5 angles in our on-device guided wizard.  Your photos are
          AES-256-GCM encrypted before storage, auto-deleted after training, and never
          shared with other members.
        </p>
        <div className="mt-10 flex flex-wrap items-center gap-3">
          <Link href="/register" className="btn-primary">Start scanning</Link>
          <Link href="/login" className="btn-ghost">Sign in</Link>
        </div>
      </section>

      <section className="mt-24 grid md:grid-cols-3 gap-4">
        {[
          { t: "Multi-angle guided capture",
            d: "Step-by-step webcam wizard with real-time pose validation — 5 mandatory angles for LoRA quality." },
          { t: "On-device quality checks",
            d: "MediaPipe face detection runs client-side before upload: single face, eyes open, good lighting." },
          { t: "Encrypted at rest + TTL purge",
            d: "AES-256-GCM with HKDF per-member keys.  Raw scans auto-delete 24h after successful training." },
          { t: "You hold the delete button",
            d: "One-click 'Wipe Account' + LoRA revocation cascade.  Full audit log of every access." },
          { t: "ComfyUI + RunPod ready",
            d: "Plugs into your existing ComfyUI workflow and RunPod serverless GPU endpoint." },
          { t: "Admin audit & force-delete",
            d: "Append-only audit log.  Admins can force-delete any member's data with a recorded reason." },
        ].map((c) => (
          <div key={c.t} className="card">
            <h3 className="font-semibold">{c.t}</h3>
            <p className="mt-2 text-sm text-white/70">{c.d}</p>
          </div>
        ))}
      </section>
    </div>
  );
}
