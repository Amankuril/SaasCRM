# Zeta Connect

Multi-tenant WhatsApp automation SaaS (MERN monorepo): businesses get private workspaces to run a shared inbox, contacts/CRM, broadcasts, flow automations and an AI agent on their own WhatsApp Business number.

```
backend/    Express 5 + Mongoose 8 + TypeScript API
frontend/   React 19 + Vite + Tailwind 4 dashboard
```

## Status

**Phase 1: Foundation** (done)

- Email/password auth: short-lived JWT access token (in memory) + httpOnly refresh cookie, rotated on every refresh, with stolen-token reuse detection
- Workspaces (tenants) with onboarding, settings and a workspace switcher
- Roles: owner, admin, manager, agent, analyst, enforced on the server (`backend/src/modules/roles.ts`)
- Team invitations by link, role changes, remove/leave, last-owner protection; audit log
- Super Admin panel: all tenants, stats, suspend/reactivate (suspended workspaces become read-only)
- **Tenant isolation guard**: a Mongoose plugin makes any query on tenant-owned data throw unless it filters by `workspaceId` (`backend/src/db/tenantPlugin.ts`)

**Phase 2: WhatsApp core** (done)

- Provider-independent `WhatsAppProvider` interface with a Meta Cloud API implementation and a **sandbox** provider for local development
- Connect a number (WABA ID + phone number ID + token, validated with Meta; token AES-256-GCM encrypted); health refresh; auto-pause on rejected tokens
- Webhook receiver: verify handshake, `X-Hub-Signature-256` check on the raw body, store-then-ack, async processing via BullMQ, replay-safe
- Message lifecycle `queued → submitted → sent → delivered → read | failed`, out-of-order receipts reconciled, idempotency keys, retry with backoff for transient/rate-limit errors
- 24-hour customer service window enforced for free-form text; templates allowed any time
- Templates: sync from WhatsApp, create with validation + live preview, review status via webhook

**Phase 3: CRM + Team Inbox** (done)

- Contacts: search, tag/stage filters, lifecycle pipeline, owner, consent (opted-out contacts can't be messaged), custom fields
- Tags (case-insensitive, coloured); CSV import with column mapping, skip / fill-empty / overwrite duplicate strategies and a per-row error report; CSV export (admins, audited, formula-injection safe)
- Team inbox: one thread per contact, open / pending / resolved (customer replies reopen), unread counts, priority, assignment (managers assign anyone; agents claim/release and auto-take a thread when they reply), internal notes, template replies when the 24h window is closed
- Visibility: owners/admins/managers see everything, analysts read-only, agents see unassigned + their own
- Realtime: Socket.io + Redis pub/sub change signals (ids only; clients refetch through the permission-checked API)

**Phase 4: Broadcast campaigns** (done)

- Saved segments (tags any/exclude, lifecycle stages, opt-in only) with live reachable counts
- Campaign editor: audience, approved template, per-variable mapping (contact field / custom field / static text, with fallback), send rate, quiet hours, send now or schedule in the workspace timezone
- Preview shows exactly who gets it and why others are skipped (opted out, no opt-in, missing variable), with rendered sample messages
- Launch snapshots recipients; a BullMQ dispatcher sends rate-limited batches with atomic claims + idempotency keys (re-runs never duplicate), pauses itself if the connection breaks or the template stops being approved
- Pause / resume / cancel; recipient-level report (sent, delivered, read, replied, failed, skipped) that always reconciles
- Customers can text STOP / START to opt out or back in

**Phase 5: Flow builder + automation engine** (done)

- Visual builder (React Flow): drag/click steps, connect labelled outputs, settings panel per step, live "contacts are here" markers, runs tab with step-by-step logs, test runs
- Triggers: keyword (exact/contains), any message (fallback), new contact, tag added
- Steps: send text, template (variable mapping), reply buttons (branch per button + no-reply timeout), CTA URL button, question (validated, saved to contact/custom field/flow variable), condition, wait/delay, update contact (tags, stage, fields), human handoff (pauses the bot until resolved), end/goal
- Draft vs immutable published versions; runs stay on the version they started with
- Publish validation: required config, reachability, one connection per output, loops without a wait, template/tag/assignee references, keyword conflicts between live flows
- Engine: persisted executions, BullMQ wake-ups with stale-token guard (delays survive restarts), per-execution locking, loop guards, exit on reply, deactivate ends runs, STOP never triggers flows

Not yet: Meta Embedded Signup (needs Tech Provider approval), email verification, password reset, a real email provider, media messages, routing rules/SLA metrics, plan quotas on sends, HTTP/API step in flows, and later phases (AI agent, forms, integrations, billing).

## Getting started

Requirements: Node 20+, MongoDB (Atlas free tier, a local install, or `docker compose up -d`) and Redis (for BullMQ).

```bash
npm install
cp backend/.env.example backend/.env   # set MONGODB_URI, JWT_ACCESS_SECRET, ENCRYPTION_KEY
npm run dev                            # API on :4000 (with queue workers), web app on http://localhost:5173
```

Set `WHATSAPP_PROVIDER=sandbox` to try everything without a Meta account (fake numbers, simulated receipts and template approval). With `meta`, configure the webhook in your Meta app using `PUBLIC_API_URL/api/webhooks/whatsapp`, `META_WEBHOOK_VERIFY_TOKEN` and `META_APP_SECRET` (use an ngrok/cloudflared tunnel locally).

In production run the worker separately: `RUN_WORKERS=false` on the API and `npm run start:worker -w backend`.

Make yourself Super Admin (sign up first):

```bash
npm run make-admin -w backend -- you@example.com
```

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | API (tsx watch) + web app (Vite) together |
| `npm test` | Backend tests (Vitest + Supertest + in-memory MongoDB) |
| `npm run typecheck` | TypeScript checks for both packages |
| `npm run build` | Production builds (`backend/dist`, `frontend/dist`) |

## Multi-tenancy rules

- Every tenant-owned schema declares `workspaceId: workspaceIdField` and uses `schema.plugin(tenantScoped)`.
- Workspace routes live under `/api/workspaces/:workspaceId/...`. `loadWorkspace` resolves the workspace **through the user's membership** (non-members get 404), and `requirePermission(...)` checks the role.
- Deliberate cross-tenant reads must opt out explicitly with `.setOptions({ skipTenantScope: true })`.
- API errors always look like `{ "error": { "code", "message", "details?", "request_id" } }`.
