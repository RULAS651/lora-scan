# Face Scan + Privacy-Protected LoRA Training System Implementation Plan

## Repository Research

**Current State:**
- Empty project directory — greenfield implementation
- User already operates a media content creation platform with **ComfyUI + RunPod**
- LoRA training is an existing workflow on the platform
- Need to add a **new member-facing feature**: multi-angle face scanning → personal LoRA generation
- **Critical requirement**: member privacy — raw facial data must never be exposed to other users or accessible by unauthorized parties

**Target Architecture:**
- **Frontend**: Next.js (React) — face scan wizard UI, member dashboard, auth pages
- **Backend**: Node.js + Express — REST API, auth, privacy engine, ComfyUI/RunPod orchestration
- **Database**: SQLite (via Prisma) — members, sessions, scan jobs, LoRA metadata
- **Privacy Layer**: AES-256 at-rest encryption, auto-deletion TTLs, role-based access control (RBAC), face de-identification option
- **Compute Integration**: RunPod serverless endpoints + ComfyUI workflows for LoRA training

---

## Files and Modules

### Root Configuration
- `package.json` — Monorepo root with workspaces (frontend + backend)
- `docker-compose.yml` — Local dev (Postgres/SQLite, Redis for job queue)
- `.env.example` — Environment template (keys, RunPod creds, ComfyUI endpoint)

### Backend (`/apps/backend`)
- `apps/backend/src/server.ts` — Express server entry
- `apps/backend/src/routes/auth.ts` — Register / login / refresh JWT
- `apps/backend/src/routes/members.ts` — Profile, LoRA library, access controls
- `apps/backend/src/routes/scan.ts` — Start scan session, upload image slices, finalize & submit training job
- `apps/backend/src/routes/lora.ts` — List member's LoRAs, download, revoke/delete
- `apps/backend/src/routes/admin.ts` — Admin only: audit, force-delete, view job statuses
- `apps/backend/src/services/auth.service.ts` — JWT signing, password hashing (bcrypt), session revocation
- `apps/backend/src/services/privacy.service.ts` — AES-GCM encrypt/decrypt, TTL auto-delete scheduler, access-guard middleware, face-blur pipeline (MediaPipe + Sharp)
- `apps/backend/src/services/comfy.service.ts` — ComfyUI workflow serialization, image upload, prompt injection
- `apps/backend/src/services/runpod.service.ts` — RunPod serverless job dispatch, webhook handling, status polling
- `apps/backend/src/services/lora.service.ts` — LoRA training job orchestration (scan → privacy filter → RunPod → store artifact metadata)
- `apps/backend/src/prisma/schema.prisma` — Member, ScanSession, ScanImage, LoRA, AuditLog models
- `apps/backend/src/middleware/authGuard.ts` — JWT verification + RBAC (member / admin roles)
- `apps/backend/src/middleware/auditLog.ts` — Access logging for every face/LoRA operation

### Frontend (`/apps/frontend`)
- `apps/frontend/app/layout.tsx` — Root layout, auth context provider
- `apps/frontend/app/login/page.tsx` — Login form
- `apps/frontend/app/register/page.tsx` — Registration form with privacy agreement checkbox
- `apps/frontend/app/dashboard/page.tsx` — Member dashboard: LoRA library, start new scan
- `apps/frontend/app/scan/page.tsx` — Face scan wizard: step-by-step multi-angle camera capture (or file upload)
- `apps/frontend/app/scan/[sessionId]/page.tsx` — Live scan session with angle guides (front, 45°L, 45°R, profile-L, profile-R, top, bottom optional)
- `apps/frontend/app/lora/[loraId]/page.tsx` — LoRA detail, test generation preview, revoke/delete
- `apps/frontend/app/admin/page.tsx` — Admin: member audit, job monitor, force-delete tooling
- `apps/frontend/components/FaceScanner.tsx` — Webcam capture component with MediaPipe face detection for quality checks (eyes open, lighting, angle match)
- `apps/frontend/components/AngleGuide.tsx` — SVG overlay showing target pose for each scan angle
- `apps/frontend/components/PrivacyNotice.tsx` — GDPR/CCPA-style consent banner with retention policy summary
- `apps/frontend/lib/api.ts` — Axios instance with JWT auto-refresh
- `apps/frontend/lib/auth.ts` — Client-side auth store (localStorage token, session state)
- `apps/frontend/lib/hooks/useScanSession.ts` — Scan session state machine

---

## Implementation Steps

### Step 1 — Project Scaffold & Dev Environment
1. Initialize monorepo with npm workspaces: `apps/frontend` + `apps/backend`
2. Create `package.json` workspaces config, install base deps (Express, Next.js, Prisma, zod)
3. Initialize Prisma + SQLite schema with Member, ScanSession, ScanImage, LoRA, AuditLog, Job models
4. Add `.env.example` with: DATABASE_URL, JWT_SECRET, ENCRYPTION_KEY (32-byte), RUNPOD_API_KEY, RUNPOD_ENDPOINT_ID, COMFYUI_URL, ADMIN_EMAILS
5. `docker-compose.yml` for local redis (job queue) — optional initially, Node Agenda as fallback

### Step 2 — Member Authentication & RBAC (Backend)
1. `auth.service.ts`: bcrypt password hashing, JWT access (15min) + refresh (7d) tokens, token revocation list
2. `authGuard.ts` middleware: verify JWT, attach `req.user` with { id, role }
3. `auditLog.ts` middleware: log every request touching face/LoRA data (user_id, action, ip, timestamp)
4. `routes/auth.ts`: POST /register (email+password+consent), POST /login, POST /refresh, POST /logout
5. Seed an admin user from `ADMIN_EMAILS` env on first boot
6. Unit tests: register → login → access protected route → revoked token rejected

### Step 3 — Privacy Engine (Backend)
1. `privacy.service.ts`:
   - `encryptBuffer(buf, memberId)` → AES-256-GCM encrypted blob + auth tag + IV, stored alongside member-specific key derivation
   - `decryptBlob(blobId, memberId)` — throws unless caller === member OR caller === admin
   - `scheduleDeletion(scanSessionId, ttlHours)` — auto-delete raw scan images after LoRA training succeeds (default TTL: 24h) or when member revokes
   - `deIdentifyFace(buffer)` — optional pipeline: MediaPipe face-landmarks → Sharp pixelate/blur face region BEFORE any encryption (stores only de-identified copy if member opts in)
2. Access-guard: every `/scan/*` and `/lora/*` route checks `req.user.id === resource.memberId` OR `role === 'admin'`
3. Background job (Agenda/cron): hourly sweep to purge expired ScanImages + write deletion confirm to AuditLog

### Step 4 — Face Scan Frontend UX
1. `FaceScanner.tsx`: `navigator.mediaDevices.getUserMedia` → canvas snap → MediaPipe `face-detection` client-side to validate:
   - Single face present
   - Eyes open
   - Lighting threshold (canvas histogram check)
   - Rough pose angle (yaw/pitch from landmarks)
2. `AngleGuide.tsx`: SVG overlays showing target silhouette for each step (Front → 45°L → 45°R → ProfileL → ProfileR, 5 mandatory angles + 2 optional)
3. Scan wizard state machine: each validated snap → upload slice to backend via `POST /scan/:sessionId/image` with `angle: 'front'|'45L'|...`
4. Uploads are streamed into `privacy.encryptBuffer()` — decrypted copy is never written to plaintext disk; temp buffer only for face-deIdentify step
5. Finalize button → `POST /scan/:sessionId/finalize` triggers LoRA training pipeline

### Step 5 — LoRA Training Pipeline (ComfyUI + RunPod Orchestration)
1. `comfy.service.ts`: Build ComfyUI LoRA-training workflow JSON (or call existing platform workflow) — inject:
   - Decrypted (still in-memory buffer) scan images as inputs
   - Member ID as trigger word / instance prompt
   - Training parameters (steps, rank, LR) — defaults + advanced tab for admins
2. `runpod.service.ts`:
   - `submitTrainingJob(workflow, memberId)` — POST to RunPod serverless endpoint
   - Webhook handler `POST /webhooks/runpod/job-complete` — on success: pull LoRA `.safetensors` artifact, encrypt it per member, store metadata in LoRA table (size, trigger word, trainingSteps, sha256)
   - Status polling fallback if webhooks flaky
3. `lora.service.ts`: Transactional orchestrator: FinalizeScan → validate all 5 angles present → schedule raw-image TTL deletion → submit RunPod job → on webhook → store artifact → send email (optional)
4. On failure: keep scan images 72h for retry, then auto-purge

### Step 6 — Member Dashboard & LoRA Library
1. Dashboard: list member's LoRAs (status: training / ready / failed), "Start New Scan" CTA, storage used, data retention summary
2. LoRA detail page:
   - Download `.safetensors` (streamed from `privacy.decryptBlob()` → response)
   - Quick test prompt widget → calls existing ComfyUI generate endpoint with LoRA lora-weights inject
   - **Revoke Access / Delete Forever** button → hard-deletes LoRA blob + all associated scan images + writes AuditLog "member self-deleted"
3. Privacy settings page: toggle "Always de-identify before storage", adjust TTL, download all my data (GDPR portability), wipe account

### Step 7 — Admin Panel & Audit
1. Admin dashboard routes (RBAC `role === 'admin'` only)
2. Member list → view member's scan/LoRA count, last activity, jump to audit trail
3. Audit log viewer: filter by member, action type (upload, train, download, delete), date range — export CSV
4. Force-delete tool: admin can delete a member's scan/LoRA data (with reason field) — same pipeline as self-delete, reason logged
5. Job monitor: in-flight RunPod jobs, retry failed training, cancel stuck jobs

### Step 8 — Hardening & Privacy Compliance Checks
1. Helmet.js, CORS config, rate limiting (express-rate-limit) on auth + upload routes
2. Input validation: zod on every POST/PUT body — file size caps, MIME whitelist (image/png, image/jpeg), max 15 images per scan session
3. ENCRYPTION_KEY rotation strategy: support `ENCRYPTION_KEY_PREVIOUS` env for zero-downtime rekey
4. Audit log immutability: append-only table, writes fail if UPDATE attempted on old rows (DB trigger or app-level)
5. Session isolation: scan session IDs are random UUIDv4, bound to member_id — never guessable

### Step 9 — Validation
- `npm run test` backend: auth flows, encrypt/decrypt roundtrip, access-guard rejects cross-member access, TTL job purges images, audit log writes
- `npm run build` frontend: no TS errors, pages render
- Manual E2E: register member → scan 5 angles → submit training → (mock RunPod webhook success) → LoRA appears → admin cannot see other member's raw scans (only metadata) → member deletes → audit log + DB rows purged
- `npx prisma validate` schema OK, `npx prisma migrate dev` applies cleanly

---

## Dependencies and Considerations

**Core Dependencies (must be installed):**
- `express`, `cors`, `helmet`, `express-rate-limit` — API + hardening
- `@prisma/client`, `prisma` — ORM + migrations
- `bcrypt`, `jsonwebtoken` — auth
- `zod` — input validation
- `multer` — multipart image upload streaming
- `sharp`, `@mediapipe/tasks-vision` — face de-identification + server-side image ops
- `node-cron` or `agenda` — TTL deletion jobs
- `next` 14+, `react`, `axios` — frontend
- `@mediapipe/camera_utils`, `@mediapipe/face_detection` — client-side quality check
- `uuid` — session ids

**External Services:**
- **RunPod**: serverless GPU endpoint for LoRA training — user must provide API key + existing endpoint ID
- **ComfyUI**: existing user instance — workflow ID or API URL must be provided
- **Email (optional)**: SendGrid/Resend for job completion notifications — skip initially, log only

**Compatibility Notes:**
- LoRA training workflow for ComfyUI is user-specific — the `comfy.service.ts` will accept a WORKFLOW_TEMPLATE path so user can plug in their existing workflow JSON without code changes
- All filesystem paths use forward slashes internally; Windows compatibility via `path.posix`

---

## Validation

1. **Backend unit tests (Jest)**:
   - `auth.test.ts`: register → login → JWT decode → refresh → revoke
   - `privacy.test.ts`: encrypt → decrypt matches, decrypt with wrong memberId throws, TTL job marks purgeable
   - `access-guard.test.ts`: member A GET /lora/B → 403; admin GET /lora/B → 200; audit entry created
2. **Frontend typecheck + build**: `cd apps/frontend && npm run build` — 0 errors
3. **Prisma schema sanity**: `npx prisma validate && npx prisma migrate dev --name init` — clean apply
4. **Manual E2E checklist** (mocked RunPod):
   - [ ] Member registers, sees privacy consent
   - [ ] Scan wizard validates 5 angles via webcam, invalid snaps are rejected client-side
   - [ ] Uploaded images appear encrypted in DB/S3 storage path
   - [ ] Finalize triggers training job (mocked webhook → status=ready)
   - [ ] Member can download LoRA, other members 403 on attempt
   - [ ] Self-delete removes blobs + audit rows confirm deletion
   - [ ] Admin force-delete works and logs reason

---

## Risks

| Risk | Handling |
|------|----------|
| **Encryption key loss → data unrecoverable** | Document key rotation procedure in `.env.example`; support previous-key fallback; never log key material |
| **RunPod job hangs / fails silently** | Timeout watchdog; retries (2x); member sees "failed + retry" button; admin panel manual cancel |
| **Face de-identification reduces LoRA quality** | Make it opt-in (default off); warn member at toggle time; compare LoRA quality on known test set |
| **Cross-member data leak via access bugs** | Defense-in-depth: (1) authGuard middleware (2) per-row memberId check in service layer (3) encryption keyed per member — all three must fail for leak |
| **GDPR/CCPA deletion requests missed** | Wipe-account endpoint cascades: LoRA blobs → ScanImages → ScanSession → AuditLog (retained only: action=deleted, by=whom, timestamp — no image data) |
| **Webcam access denied on iOS Safari** | Fallback file-upload path for every angle; "Browse…" button always present alongside "Use Camera" |
| **Large image uploads blow memory** | Multer `limits: { fileSize: 8MB }`; Sharp server-side resize to max 1024px before encrypt — LoRA training doesn't need higher |
