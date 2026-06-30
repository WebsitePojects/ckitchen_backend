# ckitchen_backend

Backend API for **CloudKitchen ONE** — a centralized multi-brand cloud-kitchen + ERP/EMS
platform. One physical outlet hosts many brands and aggregator listings, with a unified live
order feed, two-tier inventory, a universal stock ledger, employee management + photo
attendance, and silent kitchen printing via a separate Print Agent.

- **Stack:** Node.js + TypeScript, Express 5, Drizzle ORM, Socket.IO, JWT, Zod.
- **Database:** PostgreSQL (Supabase Cloud in prod). Tests run on embedded **PGlite** — no DB needed.
- **Frontend:** [`ckitchen_frontend`](../ckitchen_frontend) (React + Vite).
- **Print Agent:** separate Windows .NET tray app — raw ESC/POS, the web app never prints directly.

---

## Prerequisites

| Tool | Version | Notes |
|---|---|---|
| **Node.js** | **≥ 20.12** (20 LTS or 22 LTS recommended) | needs `process.loadEnvFile`; 24.x also works |
| **npm** | ≥ 10 | ships with Node |
| **PostgreSQL** | any (Supabase pooled URL) | **only for running the server** — tests use PGlite |
| Cloudinary account | — | only for the attendance photo feature (`/ems/attendance`) |

Check yours: `node -v && npm -v`.

---

## Quick start (local)

```bash
# 1. install
npm install

# 2. configure environment
cp .env.example .env
#    then edit .env — set JWT_SECRET, AGENT_TOKEN, DATABASE_URL (a Postgres/Supabase URL),
#    and the CLOUDINARY_* keys if you want attendance photo upload.

# 3. initialize the database (creates tables, then loads pilot demo data)
npm run migrate
npm run seed:pilot

# 4. run the API (hot reload)
npm run dev
#    → http://localhost:5003  (health: GET /api/v1/health)
```

Default seed login (from `seed:pilot`): `admin@cloudkitchen.local` / `admin123` (SUPER_ADMIN).

---

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Run the API with hot reload (`tsx watch src/server.ts`). |
| `npm start` | Run the API once (used by the deploy host). |
| `npm run build` | Type-check + compile to `dist/` (`tsc`). |
| `npm test` | Full Vitest suite (PGlite, no external DB). **Use `npm test -- --maxWorkers=1`** — parallel workers can flake/OOM on the in-memory migrations. |
| `npm run migrate` | Apply Drizzle migrations in `drizzle/` to `DATABASE_URL`. |
| `npm run seed` | Minimal seed (admin + base records). |
| `npm run seed:pilot` | Full pilot demo data (brands, menu, inventory, sample employees). |
| `npm run db:generate` | Generate a new migration from `src/db/schema.ts` after a schema change. |
| `npm run agent:mock` | Run a mock Print Agent that pulls + ACKs print jobs. |

---

## Project layout

```
src/
  server.ts            # HTTP + Socket.IO bootstrap
  app.ts               # Express app factory (all routers mounted at /api/v1)
  db/
    schema.ts          # Drizzle schema — single source of truth for tables
    client.ts          # DB client (Postgres in prod, PGlite in tests)
    migrate.ts         # migration runner
    seed*.ts           # seed scripts
  modules/
    auth/              # login, JWT, requireAuth / requireRole (RBAC)
    outlets/           # physical outlets + their MAIN/KITCHEN warehouses
    brands/ menu/ stations/
    inventory/         # two-tier stock, ITO transfers, ledger.ts (postLedger)
    orders/            # ingestion, NEW→PREPARING deduction, lifecycle
    printing/          # print job queue + Print Agent endpoints
    ems/               # employees, sessions, audit log, attendance/DTR, cloudinary
    master/            # suppliers, customers, department access (ERP R2)
    analytics/
drizzle/               # generated SQL migrations (0000…)
test/                  # Vitest suites
```

API base path: **`/api/v1`**. Auth: `Authorization: Bearer <token>`; Print Agent uses `X-Agent-Token`.

---

## Testing

```bash
npm test -- --maxWorkers=1     # full suite, serialized (recommended)
npx tsc --noEmit               # type-check only
```

Tests are isolated per file on in-memory PGlite — they never touch your real database.

---

## Deployment

- **Backend** runs on a Node host (currently **Render**; Hostinger VPS is the locked target —
  see the umbrella workspace `Desktop/VPS/CloudKitchen-ONE/CK1VPS.md`).
- Set the same env vars as `.env` in the host's dashboard (**including `CLOUDINARY_*`** or the
  attendance endpoint returns 502).
- Migrations are **not** auto-run on deploy — run `npm run migrate` against the prod
  `DATABASE_URL` when new migrations land.
- The host runs `npm start`. Build first (`npm run build`) if you run the compiled `dist/`.

---

## Security (must-read)

- **Never commit secrets.** `JWT_SECRET`, `AGENT_TOKEN`, `DATABASE_URL` password, Cloudinary
  keys → `.env` only (gitignored). `.env.example` holds placeholders only.
- RBAC is enforced **server-side** on every endpoint; never trust the client.
- Audit log records every state-changing action; actor + session come from the verified token
  (anti-spoof), never from the request body.
- Aggregator credentials are referenced by id and never returned in API responses.

---

## Source of truth

Architecture, business rules, data model, and decision log live in the **umbrella workspace**
`.claude/` folder + `Documents/CK1-*` specs. Read those before changing domain behavior.
Cardinal rules: deduct stock at **PREPARING** · shared-ingredient per-recipe portions · atomic
ITO · idempotent ingestion on `(aggregator, external_ref)` · cloud decides **what/where** to
print, agent decides **how** · no KOT silently lost · outlet-aware RBAC.
