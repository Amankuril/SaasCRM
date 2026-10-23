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

Not yet: Meta Embedded Signup (needs Tech Provider approval), email verification, password reset, a real email provider, media sending, and later phases (inbox, CRM, campaigns, flows, AI, billing).

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
