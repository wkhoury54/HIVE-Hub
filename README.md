# HIVE Hub

A CRM with three live verticals — Insurance Broker, Home Service, and Construction — sharing one platform, one AI layer, and one pricing model. Built as a zero-dependency Node.js app (no `npm install` required) so it runs anywhere Node runs.

## Running it locally

Requires **Node.js 22.5 or newer** (for the built-in `node:sqlite` module).

```
node seed.js                # optional: demo Insurance Broker account + sample clients/policies
node seed-hs.js              # optional: demo Home Service account + sample clients/jobs
node seed-construction.js    # optional: demo Construction account + sample clients/projects
node server.js
```

Then open http://localhost:3000 and either sign up for a new account or log in with one of the seed scripts' demo accounts:

| Vertical | Email | Password |
|---|---|---|
| Insurance Broker | `demo@insurance.hivehub.dev` | `demo1234` |
| Home Service | `demo@homeservice.hivehub.dev` | `demo1234` |
| Construction | `demo@construction.hivehub.dev` | `demo1234` |

## Accounts & multi-tenancy

HIVE Hub is real multi-tenant software now, not a single-business demo: `/signup` creates a business account (business name, email, password, and one of the three verticals), and everything that account creates — clients, policies, jobs, projects, messages, the price book — is scoped to that account alone. Log in at `/login`; a session is an httpOnly cookie backed by a `sessions` table, and passwords are hashed with Node's built-in `crypto.scryptSync` (salted, timing-safe compare) — no external auth library. `/app`, `/hs`, and `/co` all require a logged-in account whose own vertical matches the section, so an Insurance Broker account is bounced back to `/app` if it wanders toward `/co`, and a signed-out visitor is sent to `/login` with a `next` redirect back to where they were headed. Every list, dashboard, and lookup-by-id query is filtered by `account_id` (enforced in `db.js`/`hsdb.js`/`condb.js`, not just hidden in the UI), so one business can never see or edit another's data — including by guessing a URL like `/app/clients/1`. The `auth.js` module holds all of this: accounts, sessions, password hashing, and cookie helpers, sharing the same SQLite connection as the three vertical databases. See `accounts.plan` / `accounts.subscription_status` below for how this is meant to plug into real billing next.

## What's here

- `/` — marketing landing page with a hexagon "pie-wheel" selector for workspaces (Insurance Broker, Home Service, and Construction are all live; AI Assistant, Subscriptions, and Support are informational pages)
- `/signup` and `/login` — real account creation and sign-in (see "Accounts & multi-tenancy" above); `/app`, `/hs`, and `/co` all require one
- `/pricing` — real, benchmarked subscription tiers for all three verticals (see "Pricing" below) — not placeholders
- `/ai` — what the AI layer actually does today (Assist, on every tier) versus what Autopilot adds (Team tier and up)
- `/app` — the Insurance Broker CRM: dashboard, book of business (table + `/app/clients/pipeline` kanban view by pipeline stage), policies, a `/app/commissions` report (estimated annual commission by carrier and by policy type, plus CSV export), and the Communication hub
- `/hs` — the Home Service CRM: dashboard, clients (properties, lifetime value, overdue-invoice flags, per-client activity timeline), jobs (real stage lifecycle, line-item estimates, technician + text search filters, CSV export), a full month-calendar dispatch schedule (filterable by technician), a reusable Price Book, and its own Communication hub
- `/co` — the Construction CRM: dashboard, clients (per-client activity timeline), projects (phase lifecycle from Lead through Complete, budget + approved change-order total, `/co/projects/pipeline` kanban view, PM + text search filters, CSV export), change orders (pending/approved/rejected, with one-click approve/reject), a punch list per project, a Buildertrend/CoConstruct-style daily log per project, a real `/co/map` (see "The site map" below), and its own Communication hub
- Every vertical's Communication hub now has a live **AI Autopilot** panel (see below) instead of a disabled placeholder — real counts, a manual "Run Autopilot now" button, and an honest log of what it last did
- `db.js` / `hsdb.js` / `condb.js` — one data-access module per vertical, all sharing the same underlying SQLite connection (`node:sqlite`) and file at `data/hivehub.db`, each with its own table prefix (none, `hs_`, `con_`) so the three never collide; every function that reads or writes a client (and anything scoped to one) takes the calling account's id
- `auth.js` — accounts, sessions, password hashing (`crypto.scryptSync`), and cookie parsing — shared across all three verticals over the same SQLite connection
- `server.js` — routing and page handlers for all three verticals (plain `http`, no framework)
- `lib/render.js` — shared HTML templating, including `renderTimeline()` for the activity-timeline UI used on every client detail page
- `lib/landing.js` — the marketing shell + hex-wheel homepage
- `lib/mailer.js` — real email sending via the Resend API (see "Sending real email" below), used by all three verticals
- `lib/csv.js` — a small hand-rolled CSV writer (proper quote-escaping, `Content-Disposition: attachment`) used by every `/export.csv` route — no external CSV dependency
- `public/style.css` / `public/landing.css` — styling (app shell vs. marketing pages), responsive down to ~400px wide (mobile sidebar collapses to a horizontal scroll bar, tables scroll horizontally in their own container instead of overflowing the page)

## Why no framework

This was built in an environment where the npm registry was blocked by network policy, so Next.js/Tailwind/Prisma weren't available to install. Everything here uses only what ships with Node itself. It's a real, working app — once you're developing somewhere with normal npm access, this is straightforward to port into Next.js (the route handlers and SQL queries translate directly) or to swap `node:sqlite` for Postgres for production/multi-user use.

## Data model

### Accounts (shared across all three verticals)

**Accounts** (`auth.js`): business name, email (unique), hashed password + salt, `vertical` (which of the three CRMs this account is), `plan` (defaults to `starter` — not yet tied to real pricing tiers), `subscription_status` (defaults to `trialing`). Those last two fields exist so real Stripe billing can be wired in later without another schema change: a webhook handler will eventually update `plan`/`subscription_status` on the account instead of the app needing to ask Stripe on every request.
**Sessions**: an opaque token, the account it belongs to, and an expiry — this is what the `hh_session` cookie holds.

### Insurance Broker

**Clients**: name, email, phone, address, date of birth, notes, pipeline stage (lead/quoted/applied/underwriting/active/lapsed), next follow-up date + note, `autopilot_enabled`.
**Policies** (belong to a client): policy type, carrier, monthly premium, coverage, policy number, effective date, beneficiary, status (active/pending/lapsed), commission rate.
**Messages** (belong to a client): channel (email/sms), subject, body, delivery status (sent/failed/logged), provider id, error.

### Home Service

**Clients**: name, email, phone, client type (residential/commercial), source, notes, `autopilot_enabled`.
**Properties** (belong to a client, one client can have several): label, address, access notes.
**Jobs** (belong to a client, optionally tied to one property): title, job type, line items (description/qty/price, optionally filled from the Price Book), scheduled date + arrival window, assigned tech, recurrence, customer-visible notes, internal notes, and a stage: `New request → Quoted → Scheduled → In progress → Completed → Invoiced → Paid`, with `On hold` and `Cancelled` as exits.
**Price Book**: name, default price, unit (flat or per hour), description.
**Messages**: same shape as Insurance Broker's, scoped to Home Service clients.

An invoiced job that's gone `OVERDUE_INVOICE_DAYS` (14) days without moving to Paid is flagged automatically — on the dashboard, on the client's profile, and bumped to the top of the Communication hub's outreach suggestions.

### Construction

**Clients**: name, email, phone, source, notes, `autopilot_enabled`.
**Projects** (belong to a client): title, job-site address, project type (New build/Remodel/Addition/Kitchen/Bathroom/Roofing/Commercial buildout/Other), budget, project manager, start date, target completion date, notes, and a phase: `Lead → Estimating → Contract signed → Permitting → In progress → Punch list → Complete`, with `On hold` as an exit.
**Change orders** (belong to a project): description, amount, status (pending/approved/rejected) — approved change orders add to the project's contract total shown on its page.
**Punch list / tasks** (belong to a project): a simple description + done checkbox list.
**Messages**: same shape as the other two verticals, scoped to Construction clients.

## AI Autopilot — how it actually works

All three verticals ship the same kind of "AI": a handful of scoped, rule-based heuristics that read your own data and draft a message — never a call to an outside LLM. This is intentional: every draft is explainable, and nothing here can hallucinate a fact about a client.

- **Insurance Broker**: watches each policy's effective-date anniversary; within 45 days, drafts a renewal reminder.
- **Home Service**: checks, in priority order, a job scheduled in the next 2 days (appointment reminder), a job just completed but not yet invoiced, a job invoiced but unpaid (payment nudge), and a job just paid (review ask).
- **Construction**: checks, in priority order, a project targeted to wrap within 7 days, a pending change order awaiting approval, and a project that just moved to Complete (review ask).

Every heuristic also returns a **dedupe key** identifying the specific trigger (e.g. `renewal:42`, `job:9:invoice_nudge`, `project:3:co:7:pending`). That key is what makes Autopilot safe to run unattended:

- **Assist** (every tier, always on): the draft appears as an "AI Draft" button on the client's Messages panel — a human reviews and clicks Send.
- **Autopilot** (Team tier and up, opt-in per client from that client's page): the same draft is sent automatically on a timer (every `AUTOPILOT_INTERVAL_MINUTES`, default 60, plus once ~15s after the server starts) — but **only** when the draft has a real dedupe key. The generic "just checking in" fallback always returns `key: null`, and Autopilot deliberately refuses to auto-send it — so it can never spam a client with a contentless nudge. Every key is logged to a shared `autopilot_log` table (`vertical`, `client_id`, `trigger_key`) so the same trigger is never re-sent, even across server restarts. Every autopilot send also lands in that client's normal message history and activity timeline, exactly like a message a human sent — there is no separate, hidden autopilot outbox.

Each Communication hub's Autopilot panel shows live counts (how many clients are opted in, when it last ran, how many it sent vs. drafted-but-logged vs. errored) and a "Run Autopilot now" button that fires a check immediately instead of waiting for the timer.

## Pricing

`/pricing` reflects real research into what people currently pay for comparable tools (Jobber, Housecall Pro, AgencyBloc, CoConstruct, JobTread, current as of the tool's own pricing pages), priced 25–40% under the comparable tier, with two deliberate differences: pricing is **flat per business, not per seat** (several competitors charge $59–120+ per user/month, which punishes a growing team), and **AI Autopilot ships in the mid tier** instead of being locked behind an enterprise plan.

## Sending real email

Client messages sent from the "Email" channel go out for real through [Resend](https://resend.com)'s API, using only Node's built-in `https` module (no SDK).

1. Create a free Resend account and grab an API key (starts with `re_`).
2. Set it before starting the server:
   ```
   RESEND_API_KEY=re_your_key_here node server.js
   ```
3. By default, mail sends from `HIVE Hub <onboarding@resend.dev>` — Resend's shared test domain, which only delivers to **the email address on your own Resend account** until you verify a custom sending domain:
   ```
   RESEND_API_KEY=re_your_key_here RESEND_FROM="HIVE Hub <you@yourdomain.com>" node server.js
   ```

If `RESEND_API_KEY` isn't set, or the send fails, the message is still saved to the client's history with a "Logged only" or "Failed" badge and the error is shown — this applies to manual sends and to Autopilot alike, in all three verticals. Nothing here fails silently or pretends to have sent.

**Texting (SMS)** isn't wired to a real provider yet. The compose form supports an "SMS" channel for planning outreach; sending it is marked "not connected yet" rather than faked.

## The site map (`/co/map`)

A real, literal map — [OpenStreetMap](https://www.openstreetmap.org) tiles rendered with [Leaflet](https://leafletjs.com), both loaded from cdnjs in the browser. No API key needed (OpenStreetMap's tiles are free to use), and no Google Maps billing account required. It's a genuine web page your browser renders like any other site, so it needs normal internet access to load the tiles — if it can't reach them, the page shows a plain "couldn't load" message instead of a blank crash.

Every project with a `lat`/`lng` set shows up as a colored pin (color = phase, same palette as the badges everywhere else) — click one to open its project. Click anywhere else on the map and a small popup form drops in; fill in a client name and project title and submitting it creates that client, creates a project for them pinned exactly there, and takes you to the new project's page. Coordinates can also be set or edited by hand from a project's edit page.

The 7 seeded projects have real, approximate coordinates for their listed addresses (accurate to the neighborhood, not the rooftop — there's no live geocoding API wired in, so these were placed by hand rather than looked up).

## Not built yet

- Real Stripe billing — accounts have real signup/login and a `plan`/`subscription_status` field ready for it (see "Accounts" above), but nothing charges a card yet; the `/pricing` page shows real prices with no checkout wired to them
- Real SMS sending (see "Sending real email" above)
- Password reset / "forgot password" — there's no email-a-reset-link flow yet, so a forgotten password currently means a new account
- Multiple logins per business (each account is a single email/password — no inviting teammates with their own logins yet), and no way to switch an account's vertical after signup
- Drag-and-drop on either kanban pipeline board (`/app/clients/pipeline`, `/co/projects/pipeline`) — phase/stage changes happen from the record's own page
- Separate Estimate/Invoice objects for Home Service — line items and stage live on the Job itself for now
- Technician/crew and project-manager accounts — these are free-text fields, not real users with logins
- A daily send cap or per-message-type opt-out for Autopilot — today it's a single per-client on/off switch, and the background Autopilot sweep itself still runs as one global loop across every account rather than being partitioned per business
- Real address geocoding on `/co/map` — coordinates come from the project's `lat`/`lng` fields (set by hand, or by clicking the map), not a live lookup of the typed address

## Deploying

Any host that runs a recent Node.js process works (Render, Railway, Fly.io, a VPS, etc.). Set the `PORT` environment variable if your host requires it. Because the SQLite database is a local file, use a host with persistent disk, or swap in a hosted Postgres database before you have real paying users depending on the data.
