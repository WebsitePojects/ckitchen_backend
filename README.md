# ckitchen_backend

Backend API for **CloudKitchen ONE** — centralized multi-brand cloud-kitchen management.

- **Stack:** Node.js + TypeScript (Express/NestJS), REST + realtime, Prisma/Supabase client.
- **Data/Auth/Realtime:** Supabase Cloud (PostgreSQL). **Host:** Hostinger VPS (Nginx + PM2).
- **Print Agent:** separate Windows .NET tray app under [`agent/`](agent/) — raw ESC/POS, no browser.
- **Frontend repo:** `WebsitePojects/ckitchen_frontend`.

## Source of truth
Architecture, business rules, data model, and decisions live in the umbrella workspace
`.claude/` folder + `Documents/CK1-*` specs. Read those before changing behavior.
Cardinal rules: deduct stock at PREPARING · shared-ingredient per-recipe portions · atomic ITO ·
idempotent ingestion on `(aggregator, external_ref)` · cloud decides WHAT/WHERE to print, agent
decides HOW · no KOT silently lost.

## Status
Pre-build. Scaffolding happens in Phase 0 (see `.claude/context/roadmap.md`).

> IMPORTANT: never commit secrets. Supabase keys, JWT secret, Print-Agent token, middleware
> credentials → `.env` (gitignored).
