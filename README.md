# Zeta Connect

Multi-tenant WhatsApp automation SaaS (MERN monorepo): businesses get private workspaces to run a shared inbox, contacts/CRM, broadcasts, flow automations and an AI agent on their own WhatsApp Business number.

```
backend/    Express 5 + Mongoose 8 + TypeScript API
frontend/   React 19 + Vite + Tailwind 4 dashboard
```

## Status: Phase 1 (Foundation)

Done:

- Email/password auth: short-lived JWT access token (in memory) + httpOnly refresh cookie, rotated on every refresh, with stolen-token reuse detection
- Workspaces (tenants) with onboarding, settings and a workspace switcher
- Roles: owner, admin, manager, agent, analyst, enforced on the server (`backend/src/modules/roles.ts`)
- Team invitations by link (7-day expiry, one-time use, revocable), role changes, remove/leave, last-owner protection
- Audit log for privileged changes
- Super Admin panel: all tenants, stats, suspend/reactivate (suspended workspaces become read-only)
- **Tenant isolation guard**: a Mongoose plugin makes any query on tenant-owned data throw unless it filters by `workspaceId` (`backend/src/db/tenantPlugin.ts`)

Not yet: email verification, password reset, a real email provider (invite emails print to the API log), WhatsApp connection, and all later-phase modules (inbox, contacts, campaigns, flows, AI, billing).

## Getting started

Requirements: Node 20+ and MongoDB (MongoDB Atlas free tier, a local install, or `docker compose up -d`).

```bash
npm install
cp backend/.env.example backend/.env   # then set MONGODB_URI and a random JWT_ACCESS_SECRET
npm run dev                            # API on :4000, web app on http://localhost:5173
```

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
