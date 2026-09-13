"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { URL } = require("node:url");

const db = require("./db");
const hsdb = require("./hsdb");
const condb = require("./condb");
const auth = require("./auth");
const { layout, esc, money, renderTimeline } = require("./lib/render");
const { renderLanding, simplePage } = require("./lib/landing");
const { computeRange, PRESET_LABELS } = require("./lib/dates");
const mailer = require("./lib/mailer");
const { toCsv, sendCsv } = require("./lib/csv");

// ---------- Shared message-sending (used by manual sends and Autopilot) ----------

// dbModule is either `db` (Insurance Broker) or `hsdb` (Home Service) — both
// expose the same createMessage/updateMessageStatus shape. Returns the same
// {ok, skipped, error} outcome mailer.sendEmail returns, so callers can share
// one flash-message mapping.
// Shared Autopilot status/control panel shown at the top of both
// Communication hubs — live counts and controls, not marketing copy, since
// Autopilot actually runs in this build (see runAutopilotOnce above).
function renderAutopilotPanel(enabledCount, totalCount) {
  const last = lastAutopilotRun;
  const lastLine = last
    ? `Last checked ${esc(last.at.replace("T", " ").slice(0, 19))} UTC — ${last.sent} sent${last.logged ? `, ${last.logged} drafted (no email provider connected yet)` : ""}, ${last.checked} client${last.checked === 1 ? "" : "s"} considered${last.errors && last.errors.length ? `, ${last.errors.length} error(s)` : ""}.`
    : `Hasn't run yet — first check happens shortly after the server starts, then every ${AUTOPILOT_INTERVAL_MINUTES} minute(s).`;
  return `
    <div class="card" style="margin-bottom:20px;background:var(--cream);">
      <div class="page-header" style="margin-bottom:6px;">
        <div>
          <h3 style="margin:0;">Autopilot</h3>
          <p class="subtitle" style="margin-top:4px;">${enabledCount} of ${totalCount} client${totalCount === 1 ? "" : "s"} opted in · runs automatically every ${AUTOPILOT_INTERVAL_MINUTES} min</p>
        </div>
        <form method="post" action="/autopilot/run"><button class="btn secondary" type="submit">Run Autopilot now</button></form>
      </div>
      <p style="font-size:12.5px;color:var(--muted);margin:0;">${lastLine} It only sends when a draft has a concrete trigger (a dated renewal, a job hitting a specific stage) and never repeats the same nudge twice — a generic "just checking in" message is never sent on its own. Turn it on per client from that client's page.</p>
    </div>`;
}

// A searchable client picker — replaces a plain <select>, which gets
// unwieldy fast once a business has more than a handful of clients, with a
// text input + native <datalist> autocomplete (type-to-filter, keyboard and
// mobile friendly, no extra library). Navigates to that client's messages
// with a draft ready as soon as the typed value exactly matches a client
// name — i.e. once it's picked from the dropdown or typed out in full.
function renderClientSearchPicker(clients, basePath) {
  const listId = "client-search-" + basePath.replace(/[^a-z0-9]/gi, "");
  const options = clients.map((c) => `<option value="${esc(c.name)}"></option>`).join("");
  const map = clients.map((c) => `${JSON.stringify(c.name)}:${c.id}`).join(",");
  return `
    <input list="${listId}" placeholder="Search clients by name…" autocomplete="off" style="max-width:320px;"
      oninput="var m={${map}};var id=m[this.value];if(id) location.href='${basePath}/'+id+'?draft=1#messages';" />
    <datalist id="${listId}">${options}</datalist>`;
}

async function sendAndLogMessage(dbModule, client, { channel, subject, body }) {
  const id = dbModule.createMessage({ client_id: client.id, channel, subject, body });
  let outcome;
  if (channel === "email") {
    outcome = await mailer.sendEmail({ to: client.email, subject, text: body });
  } else {
    outcome = { ok: false, skipped: true, error: "Texting isn't connected yet — add a provider like Twilio to send real texts." };
  }
  dbModule.updateMessageStatus(id, {
    status: outcome.ok ? "sent" : outcome.skipped ? "logged" : "failed",
    provider_id: outcome.id,
    error: outcome.error,
  });
  return outcome;
}

const PORT = process.env.PORT || 3000;

// ---------- tiny router ----------

const routes = [];
function route(method, pattern, handler) {
  const keys = [];
  const regexStr = pattern
    .split("/")
    .map((segment) => {
      if (segment.startsWith(":")) {
        keys.push(segment.slice(1));
        return "([^/]+)";
      }
      return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("/");
  routes.push({ method, regex: new RegExp(`^${regexStr}/?$`), keys, handler });
}

function get(pattern, handler) { route("GET", pattern, handler); }
function post(pattern, handler) { route("POST", pattern, handler); }

// ---------- helpers ----------

function sendHtml(res, status, html) {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

function redirect(res, location) {
  res.writeHead(302, { Location: location });
  res.end();
}

function notFound(res) {
  sendHtml(
    res,
    404,
    simplePage({
      title: "Not found",
      heading: "That cell doesn't exist.",
      lede: "The page you're looking for doesn't exist.",
      body: "",
    })
  );
}

function parseBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      const params = new URLSearchParams(data);
      const obj = {};
      for (const [k, v] of params) obj[k] = v;
      resolve(obj);
    });
  });
}

const MIME = {
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
};

function serveStatic(req, res, pathname) {
  const filePath = path.join(__dirname, "public", pathname);
  if (!filePath.startsWith(path.join(__dirname, "public"))) return false;
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) return false;
  const ext = path.extname(filePath);
  res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
  fs.createReadStream(filePath).pipe(res);
  return true;
}

function firstName(name) {
  return (name || "").trim().split(/\s+/)[0] || "there";
}

// Days until the next calendar anniversary of `dateStr` (month/day), regardless
// of year — used both for the AI draft heuristic and the renewals-due widget.
function nextAnniversaryDays(dateStr, today) {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;
  const anniv = new Date(today.getFullYear(), d.getMonth(), d.getDate());
  if (anniv < today) anniv.setFullYear(anniv.getFullYear() + 1);
  return Math.round((anniv - today) / 86400000);
}

// Rule-based "AI" draft: not a real language model — just a couple of
// scoped heuristics (renewal window + generic check-in) that mirror the
// behavior promised on the AI Assistant preview page.
function generateAiDraft(client, policies) {
  const fn = firstName(client.name);
  const today = new Date();
  let nearest = null;
  let nearestDays = Infinity;
  for (const p of policies) {
    if (!p.effective_date) continue;
    const days = nextAnniversaryDays(p.effective_date, today);
    if (days !== null && days < nearestDays) {
      nearestDays = days;
      nearest = p;
    }
  }
  if (nearest && nearestDays <= 45) {
    return {
      subject: `Your ${nearest.policy_type} policy renewal is coming up`,
      body: `Hi ${fn}, your ${nearest.policy_type} policy with ${nearest.carrier} is coming up for renewal soon. Want to hop on a quick call to review your coverage before it renews, or are you all set?`,
      // Autopilot dedupe key — identifies *this specific renewal window* so the
      // same nudge is never sent twice for it. null means "no dated trigger",
      // which Autopilot treats as not actionable (it won't auto-send a generic
      // check-in with nothing concrete driving it).
      key: `renewal:${nearest.id}`,
    };
  }
  return {
    subject: "Checking in",
    body: `Hi ${fn}, just checking in — anything changed on your end (new address, new dependents, big purchases) that might affect your coverage? Happy to take a look whenever's convenient.`,
    key: null,
  };
}

const STAGE_LABELS = {
  lead: "Lead",
  quoted: "Quoted",
  applied: "Applied",
  underwriting: "Underwriting",
  active: "Active client",
  lapsed: "Lapsed",
};
const STAGE_ORDER = ["lead", "quoted", "applied", "underwriting", "active", "lapsed"];
const STATUS_BADGE = { sent: "active", failed: "lapsed", logged: "pending" };
const STATUS_LABEL = { sent: "Sent", failed: "Failed", logged: "Logged only" };

const POLICY_TYPES = [
  "Term Life",
  "Whole Life",
  "Universal Life",
  "Final Expense",
  "Auto",
  "Home",
  "Renters",
  "Health",
  "Umbrella",
  "Business",
  "Other",
];

// ================= Landing & marketing pages =================

get("/", (req, res) => sendHtml(res, 200, renderLanding()));

function loginForm({ email = "", next = "" } = {}) {
  return `
    <form class="simple-form" method="post" action="/login">
      ${next ? `<input type="hidden" name="next" value="${esc(next)}" />` : ""}
      <div>
        <label for="email">Email</label>
        <input id="email" name="email" type="email" required value="${esc(email)}" placeholder="you@business.com" />
      </div>
      <div>
        <label for="password">Password</label>
        <input id="password" name="password" type="password" required placeholder="••••••••" />
      </div>
      <button class="btn primary" type="submit">Log in</button>
    </form>
    <p style="font-size:13px;color:var(--muted);margin-top:14px;">New here? <a href="/signup">Create an account</a>.</p>`;
}

get("/login", (req, res, params, query) => {
  const next = (query && query.get("next")) || "";
  sendHtml(
    res,
    200,
    simplePage({
      title: "Log in",
      eyebrow: "Welcome back",
      heading: "Log in to HIVE Hub",
      body: loginForm({ next }),
    })
  );
});

post("/login", async (req, res) => {
  const body = await parseBody(req);
  const account = auth.getAccountByEmail(body.email || "");
  const ok = account && auth.verifyPassword(body.password || "", account.password_salt, account.password_hash);
  if (!ok) {
    return sendHtml(
      res,
      200,
      simplePage({
        title: "Log in",
        eyebrow: "Welcome back",
        heading: "Log in to HIVE Hub",
        flash: "That email and password don't match an account — check them and try again.",
        body: loginForm({ email: body.email, next: body.next }),
      })
    );
  }
  const token = auth.createSession(account.id);
  res.setHeader("Set-Cookie", auth.sessionCookieHeader(token));
  const home = auth.VERTICAL_HOME[account.vertical];
  const next = body.next && body.next.startsWith(home) ? body.next : home;
  redirect(res, next);
});

post("/logout", (req, res) => {
  const cookies = auth.parseCookies(req);
  auth.deleteSession(cookies[auth.SESSION_COOKIE]);
  res.setHeader("Set-Cookie", auth.clearCookieHeader());
  redirect(res, "/");
});

function signupForm({ business_name = "", email = "", vertical = "" } = {}) {
  const options = auth.VERTICALS.map(
    (v) => `<option value="${v}" ${vertical === v ? "selected" : ""}>${esc(auth.VERTICAL_LABELS[v])}</option>`
  ).join("");
  return `
    <form class="simple-form" method="post" action="/signup">
      <div>
        <label for="business_name">Business name</label>
        <input id="business_name" name="business_name" required value="${esc(business_name)}" placeholder="Acme Roofing" />
      </div>
      <div>
        <label for="vertical">Workspace</label>
        <select id="vertical" name="vertical" required>
          <option value="">Choose one...</option>
          ${options}
        </select>
      </div>
      <div>
        <label for="email">Email</label>
        <input id="email" name="email" type="email" required value="${esc(email)}" placeholder="you@business.com" />
      </div>
      <div>
        <label for="password">Password</label>
        <input id="password" name="password" type="password" required minlength="8" placeholder="At least 8 characters" />
      </div>
      <button class="btn primary" type="submit">Create account</button>
    </form>
    <p style="font-size:13px;color:var(--muted);margin-top:14px;">Already have an account? <a href="/login">Log in</a>.</p>`;
}

get("/signup", (req, res, params, query) => {
  const vertical = (query && query.get("vertical")) || "";
  sendHtml(
    res,
    200,
    simplePage({
      title: "Sign up",
      eyebrow: "Create your account",
      heading: "Start your free HIVE Hub account",
      lede: "Pick the workspace that matches your business — clients, jobs, and everything else are kept separate per account, so nobody else ever sees your data.",
      body: signupForm({ vertical }),
    })
  );
});

post("/signup", async (req, res) => {
  const body = await parseBody(req);
  let accountId;
  try {
    accountId = auth.createAccount({
      business_name: body.business_name,
      email: body.email,
      password: body.password,
      vertical: body.vertical,
    });
  } catch (e) {
    return sendHtml(
      res,
      200,
      simplePage({
        title: "Sign up",
        eyebrow: "Create your account",
        heading: "Start your free HIVE Hub account",
        flash: esc(e.message),
        body: signupForm({ business_name: body.business_name, email: body.email, vertical: body.vertical }),
      })
    );
  }
  if (body.vertical === "homeservice") hsdb.seedPriceBookFor(accountId);
  const token = auth.createSession(accountId);
  res.setHeader("Set-Cookie", auth.sessionCookieHeader(token));
  redirect(res, auth.VERTICAL_HOME[body.vertical]);
});

get("/pricing", (req, res) => {
  function planSection(label, sub, plans) {
    return `
      <div style="margin-bottom:34px;">
        <h2 style="font-family:'Fraunces',serif;font-size:20px;font-weight:600;margin:0 0 2px;">${label}</h2>
        <p style="font-size:13px;color:var(--muted);margin:0 0 14px;">${sub}</p>
        <div class="plan-grid">
          ${plans
            .map(
              (p) => `
            <div class="plan-card${p.featured ? " featured" : ""}">
              <div class="plan-name">${esc(p.name)}</div>
              <div class="plan-price">${esc(p.price)}<span>${esc(p.per)}</span></div>
              <ul class="plan-list">${p.features.map((f) => `<li>${f}</li>`).join("")}</ul>
            </div>`
            )
            .join("")}
        </div>
      </div>`;
  }

  const body = `
    <p style="font-size:13.5px;color:var(--ink-soft);line-height:1.6;margin-bottom:26px;padding:14px 16px;background:var(--honey-pale);border-radius:12px;">
      <strong>How we priced this:</strong> we benchmarked against the tools people actually switch from — Jobber and Housecall Pro
      for Home Service, AgencyBloc for Insurance Broker, and CoConstruct/Buildertrend for Construction — then priced HIVE Hub 25–40% under
      the comparable tier. Two differences we kept on purpose: pricing is <strong>flat per business, not per seat</strong> (AgencyBloc and
      JobTread charge $59&ndash;120+ per user per month, which punishes you for growing your team), and <strong>AI Autopilot ships in
      the mid tier</strong> instead of being locked behind an enterprise plan or a "request a demo" sales call.
    </p>

    ${planSection("Home Service", "Benchmarked against Jobber ($29–499/mo) and Housecall Pro ($59–329/mo).", [
      {
        name: "Solo",
        price: "$39",
        per: "/mo",
        features: [
          "1 user, unlimited clients &amp; jobs",
          "Scheduling, price book, invoicing",
          "CSV export, client activity timeline",
        ],
      },
      {
        name: "Team + AI Autopilot",
        price: "$99",
        per: "/mo",
        featured: true,
        features: [
          "Up to 6 users",
          "Everything in Solo",
          "AI Autopilot — automatic reminders, invoice nudges, review asks",
          "Pipeline kanban, technician filtering",
        ],
      },
      {
        name: "Growth",
        price: "$199",
        per: "/mo",
        features: ["Up to 15 users", "Everything in Team", "Priority support"],
      },
    ])}

    ${planSection("Insurance Broker", "Benchmarked against AgencyBloc ($59–79 per user/mo).", [
      { name: "Solo Agent", price: "$49", per: "/mo", features: ["1 user", "Unlimited clients &amp; policies", "Pipeline &amp; renewal tracking"] },
      {
        name: "Agency + AI Autopilot",
        price: "$129",
        per: "/mo",
        featured: true,
        features: [
          "Up to 6 users, flat (not per seat)",
          "AI Autopilot — automatic renewal reminders &amp; check-ins",
          "Client messaging (email + SMS)",
        ],
      },
      { name: "Agency Pro", price: "$249", per: "/mo", features: ["Up to 15 users, flat", "Everything in Agency", "Priority support"] },
    ])}

    ${planSection("Construction", "Benchmarked against CoConstruct ($339–499/mo flat) and JobTread ($120+ per user/mo).", [
      { name: "Builder Starter", price: "$89", per: "/mo", features: ["Up to 3 users", "Projects, change orders, punch lists", "CSV export"] },
      {
        name: "Builder Team + AI Autopilot",
        price: "$199",
        per: "/mo",
        featured: true,
        features: ["Up to 10 users", "AI Autopilot — wrap-up reminders, change-order nudges, review asks", "Pipeline board, activity timeline"],
      },
      { name: "Builder Pro", price: "$349", per: "/mo", features: ["Unlimited users", "Everything in Team", "Priority support"] },
    ])}

    <p style="font-size:12px;color:var(--muted);">Billing isn't connected yet — these are the real prices we're launching at, not placeholders.</p>`;

  sendHtml(
    res,
    200,
    simplePage({
      title: "Subscriptions",
      eyebrow: "Plans & billing",
      heading: "Pricing, benchmarked against what you'd switch from",
      lede: "One flat price per business — not per seat — with AI Autopilot included well before the top tier.",
      body,
    })
  );
});

get("/ai", (req, res) => {
  sendHtml(
    res,
    200,
    simplePage({
      title: "AI Assistant",
      eyebrow: "Live in all three workspaces",
      heading: "Your AI assistant",
      lede: "Scoped to do a few things really well, instead of being a vague do-everything chatbot. No outside LLM API — every draft comes from explainable, rule-based logic over your own data, so you always know exactly why it said what it said.",
      body: `
        <div class="ai-tier">
          <div class="ai-tier-label">Included — Assist</div>
          <ul class="plan-list" style="font-size:14px;gap:10px;">
            <li>Watches renewals, job stages, and change orders for concrete, dated triggers</li>
            <li>Drafts the reminder, nudge, or follow-up for you to review and send with one click</li>
            <li>Every client page shows a full activity timeline before you reach out</li>
          </ul>
        </div>
        <div class="ai-tier addon">
          <div class="ai-tier-label">Team tier and up — Autopilot</div>
          <ul class="plan-list" style="font-size:14px;gap:10px;">
            <li>Sends the same drafts for you automatically, per client, once you opt them in</li>
            <li>Only fires on a concrete trigger — a dated renewal, a job or project hitting a specific stage — never a generic "just checking in" on its own</li>
            <li>Never repeats the same nudge twice, and every send lands in that client's message log exactly like a message you sent yourself</li>
          </ul>
          <a class="btn primary" href="/pricing" style="margin-top:6px;">See pricing →</a>
        </div>`,
    })
  );
});

get("/support", (req, res, params, query) => {
  sendHtml(
    res,
    200,
    simplePage({
      title: "Contact support",
      eyebrow: "We're here",
      heading: "Contact support",
      lede: "Send a message and we'll get back to you.",
      flash: query.get("sent") ? "Thanks — your message was sent." : null,
      body: `
        <form class="simple-form" method="post" action="/support">
          <div>
            <label for="s-name">Name</label>
            <input id="s-name" name="name" required />
          </div>
          <div>
            <label for="s-email">Email</label>
            <input id="s-email" name="email" type="email" required />
          </div>
          <div>
            <label for="s-message">Message</label>
            <textarea id="s-message" name="message" required></textarea>
          </div>
          <button class="btn primary" type="submit">Send message</button>
        </form>`,
    })
  );
});

post("/support", async (req, res) => {
  const body = await parseBody(req);
  const logLine = `[${new Date().toISOString()}] ${body.name} <${body.email}>: ${body.message}\n`;
  fs.appendFileSync(path.join(__dirname, "data", "support-messages.log"), logLine);
  redirect(res, "/support?sent=1");
});

get("/soon/:vertical", (req, res, params) => {
  const names = { "home-service": "Home Service", construction: "Construction" };
  const label = names[params.vertical] || "This vertical";
  sendHtml(
    res,
    200,
    simplePage({
      title: label,
      eyebrow: "Coming soon",
      heading: `${label} is on the way`,
      lede: `Insurance Broker and Home Service are live today. ${label} shares the same underlying platform — client records, jobs, and scheduling — and is next up.`,
      body: `<a class="btn primary" href="/support">Get notified</a>`,
    })
  );
});

// ================= CRM app (Insurance Broker) =================

get("/app", (req, res, params, query) => {
  const field = query.get("field") === "submitted" ? "submitted" : "effective";
  const range = query.get("range") || "ytd";
  const rangeInfo = computeRange(range, query.get("from"), query.get("to"));

  const stats = db.dashboardStats(req.account.id, { field, start: rangeInfo.start, end: rangeInfo.end });
  const maxPremium = Math.max(1, ...stats.byType.map((t) => t.premium));

  function qs(overrides) {
    const p = new URLSearchParams({ field, range, from: query.get("from") || "", to: query.get("to") || "" });
    Object.entries(overrides).forEach(([k, v]) => p.set(k, v));
    if (!p.get("from")) p.delete("from");
    if (!p.get("to")) p.delete("to");
    return "?" + p.toString();
  }

  const fieldToggle = ["effective", "submitted"]
    .map(
      (f) =>
        `<a class="toggle-pill${field === f ? " active" : ""}" href="${qs({ field: f })}">${f === "effective" ? "Effective Date" : "Submitted Date"}</a>`
    )
    .join("");

  const rangeToggle = Object.keys(PRESET_LABELS)
    .filter((r) => r !== "custom")
    .map((r) => `<a class="toggle-pill${range === r ? " active" : ""}" href="${qs({ range: r })}">${PRESET_LABELS[r]}</a>`)
    .join("");

  const typeRows = stats.byType.length
    ? stats.byType
        .map(
          (t) => `
        <div style="margin-bottom:10px;">
          <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:4px;">
            <span><strong>${esc(t.policy_type)}</strong> <span style="color:var(--muted)">(${t.count})</span></span>
            <span>${money(t.premium)}/mo</span>
          </div>
          <div style="background:#f1e7cb;border-radius:6px;height:8px;overflow:hidden;">
            <div style="background:var(--gold);height:100%;width:${(t.premium / maxPremium) * 100}%;"></div>
          </div>
        </div>`
        )
        .join("")
    : `<p style="color:var(--muted);font-size:14px;">No policies yet — add your first client to see this fill in.</p>`;

  const recentRows = stats.recentClients.length
    ? stats.recentClients
        .map(
          (c) => `<tr onclick="location.href='/app/clients/${c.id}'"><td>${esc(c.name)}</td><td>${esc(c.email || "—")}</td><td>${esc(c.phone || "—")}</td></tr>`
        )
        .join("")
    : `<tr><td colspan="3" class="empty-state">No clients yet.</td></tr>`;

  const body = `
    <div class="page-header">
      <div>
        <h1>Dashboard</h1>
        <p class="subtitle">Your book of business at a glance</p>
      </div>
      <a class="btn" href="/app/clients/new">+ Add client</a>
    </div>

    <div class="filter-bar">
      <div class="toggle-group">${fieldToggle}</div>
      <div class="toggle-group toggle-group-scroll">${rangeToggle}</div>
      <form class="custom-range" method="get" action="/app">
        <input type="hidden" name="field" value="${field}" />
        <input type="hidden" name="range" value="custom" />
        <input type="date" name="from" value="${esc(query.get("from") || "")}" aria-label="Custom range start" />
        <span>&ndash;</span>
        <input type="date" name="to" value="${esc(query.get("to") || "")}" aria-label="Custom range end" />
        <button class="btn small secondary" type="submit">Apply</button>
      </form>
    </div>
    <p class="range-label">${rangeInfo.label}: ${rangeInfo.start} &ndash; ${rangeInfo.end}</p>

    <div class="stat-grid">
      <div class="stat-card accent">
        <div class="stat-label">Production</div>
        <div class="stat-value">${money(stats.production)}</div>
        <div class="stat-foot">${stats.productionCount} polic${stats.productionCount === 1 ? "y" : "ies"} &middot; ${field === "effective" ? "by effective date" : "by submitted date"}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Est. commission</div>
        <div class="stat-value">${money(stats.estCommission)}</div>
        <div class="stat-foot">Same date range &middot; set per policy</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Active policies</div>
        <div class="stat-value">${stats.totalPolicies}</div>
        <div class="stat-foot">In-force</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Total clients</div>
        <div class="stat-value">${stats.totalClients}</div>
        <div class="stat-foot">Unique count</div>
      </div>
    </div>

    <div class="two-col">
      <div class="card">
        <h3 style="margin-bottom:14px;">Book of business</h3>
        <div class="table-scroll">
        <table class="clickable">
          <thead><tr><th>Name</th><th>Email</th><th>Phone</th></tr></thead>
          <tbody>${recentRows}</tbody>
        </table>
        </div>
        <div style="margin-top:14px;"><a class="btn ghost ${""}" href="/app/clients" style="border:1px solid var(--line);">View book of business →</a></div>
      </div>
      <div class="card">
        <h3 style="margin-bottom:14px;">Premium by policy type</h3>
        ${typeRows}
      </div>
    </div>`;

  sendHtml(res, 200, layout({ account: req.account, title: "Dashboard", active: "dashboard", body }));
});

get("/app/messages", (req, res) => {
  const today = new Date();
  const todayIso = today.toISOString().slice(0, 10);

  const suggestionMap = new Map();
  db.listActivePoliciesWithClients(req.account.id).forEach((p) => {
    const days = nextAnniversaryDays(p.effective_date, today);
    if (days === null || days > 30) return;
    const entry = suggestionMap.get(p.client_id) || { client_id: p.client_id, client_name: p.client_name, reasons: [], urgency: Infinity };
    entry.reasons.push(`${p.policy_type} renews ${days === 0 ? "today" : "in " + days + "d"}`);
    entry.urgency = Math.min(entry.urgency, days);
    suggestionMap.set(p.client_id, entry);
  });
  db.listFollowupsDue(req.account.id, 7).forEach((c) => {
    const overdue = c.next_followup < todayIso;
    const entry = suggestionMap.get(c.id) || { client_id: c.id, client_name: c.name, reasons: [], urgency: Infinity };
    entry.reasons.push(c.followup_note || (overdue ? "Follow-up overdue" : "Follow-up due"));
    entry.urgency = Math.min(entry.urgency, overdue ? -1 : 0);
    suggestionMap.set(c.id, entry);
  });
  const suggestions = Array.from(suggestionMap.values()).sort((a, b) => a.urgency - b.urgency).slice(0, 8);

  const suggestionRows = suggestions.length
    ? suggestions
        .map(
          (s) => `
      <div class="policy-item">
        <div>
          <div class="policy-main">${esc(s.client_name)}</div>
          <div class="policy-meta">${esc(s.reasons.join(" &middot; "))}</div>
        </div>
        <a class="btn small ai-draft" href="/app/clients/${s.client_id}?draft=1#messages">Start conversation</a>
      </div>`
        )
        .join("")
    : `<p style="color:var(--muted);font-size:13px;">No renewals or follow-ups need outreach right now.</p>`;

  const recent = db.listRecentMessages(req.account.id, 15);
  const recentRows = recent.length
    ? recent
        .map((m) => {
          const snippet = (m.body || "").length > 90 ? m.body.slice(0, 90) + "…" : m.body || "";
          return `
      <div class="policy-item" style="align-items:flex-start;">
        <div>
          <div class="policy-main">
            <a href="/app/clients/${m.client_id}#messages" style="color:inherit;">${esc(m.client_name)}</a>
            <span class="badge ${m.channel}">${m.channel === "email" ? "Email" : "Text"}</span>
            <span class="badge ${STATUS_BADGE[m.status] || "pending"}">${STATUS_LABEL[m.status] || esc(m.status)}</span>
          </div>
          <div class="policy-meta" style="max-width:460px;">${m.subject ? `${esc(m.subject)} — ` : ""}${esc(snippet)}</div>
        </div>
        <div class="policy-meta">${esc(m.created_at)}</div>
      </div>`;
        })
        .join("")
    : `<div class="empty-state">No conversations yet. Use a suggestion, or open any client to send the first message.</div>`;

  const body = `
    <div class="page-header">
      <div>
        <h1>Communication</h1>
        <p class="subtitle">AI helps you find who to talk to and drafts it — you hit send</p>
      </div>
    </div>
    ${renderAutopilotPanel(db.listAutopilotEnabledClients(req.account.id).length, db.listClients(req.account.id).length)}
    <div class="card" style="margin-bottom:20px;">
      <h3 style="margin-bottom:6px;">Start a conversation</h3>
      <p style="margin:0 0 12px;font-size:13px;color:var(--muted);">Search for a client to open their thread with an AI draft ready to go.</p>
      ${renderClientSearchPicker(db.listClients(req.account.id), "/app/clients")}
    </div>
    <div class="two-col">
      <div class="card">
        <h3 style="margin-bottom:4px;">AI suggests reaching out to</h3>
        <p style="margin:0 0 12px;font-size:12px;color:var(--muted);">Based on renewals and follow-ups due</p>
        ${suggestionRows}
      </div>
      <div class="card">
        <h3 style="margin-bottom:4px;">Recent conversations</h3>
        <p style="margin:0 0 12px;font-size:12px;color:var(--muted);">Across your whole book of business</p>
        ${recentRows}
      </div>
    </div>`;

  sendHtml(res, 200, layout({ account: req.account, title: "Communication", active: "messages", body }));
});

get("/app/clients/export.csv", (req, res) => {
  const clients = db.listClients(req.account.id, "", "");
  const csv = toCsv(clients, [
    ["Name", "name"],
    ["Email", "email"],
    ["Phone", "phone"],
    ["Address", "address"],
    ["Pipeline stage", "pipeline_stage"],
    ["Next follow-up", "next_followup"],
    ["Notes", "notes"],
  ]);
  sendCsv(res, "hivehub-insurance-clients.csv", csv);
});

get("/app/policies/export.csv", (req, res) => {
  const policies = db.listAllPoliciesWithClients(req.account.id);
  const csv = toCsv(policies, [
    ["Client", "client_name"],
    ["Client email", "client_email"],
    ["Client phone", "client_phone"],
    ["Policy type", "policy_type"],
    ["Carrier", "carrier"],
    ["Monthly premium", "monthly_premium"],
    ["Coverage", "coverage"],
    ["Policy number", "policy_number"],
    ["Effective date", "effective_date"],
    ["Beneficiary", "beneficiary"],
    ["Status", "status"],
    ["Commission rate", "commission_rate"],
  ]);
  sendCsv(res, "hivehub-insurance-policies.csv", csv);
});

get("/app/clients/pipeline", (req, res) => {
  const clients = db.listClients(req.account.id, "", "");
  const byStage = {};
  STAGE_ORDER.forEach((s) => (byStage[s] = []));
  clients.forEach((c) => {
    (byStage[c.pipeline_stage] = byStage[c.pipeline_stage] || []).push(c);
  });

  const columns = STAGE_ORDER.map((s) => {
    const stageClients = byStage[s] || [];
    const cards = stageClients.length
      ? stageClients
          .map(
            (c) => `
        <a href="/app/clients/${c.id}" class="kanban-card">
          <div class="kanban-card-name">${esc(c.name)}</div>
          <div class="kanban-card-meta">${esc(c.email || c.phone || "No contact info")}</div>
          ${c.next_followup ? `<div class="kanban-card-followup">Follow up ${esc(c.next_followup)}</div>` : ""}
        </a>`
          )
          .join("")
      : `<div class="kanban-empty">No clients</div>`;
    return `
      <div class="kanban-col">
        <div class="kanban-col-head"><span>${STAGE_LABELS[s]}</span><span class="kanban-count">${stageClients.length}</span></div>
        <div class="kanban-col-body">${cards}</div>
      </div>`;
  }).join("");

  const body = `
    <div class="page-header">
      <div>
        <h1>Pipeline</h1>
        <p class="subtitle">${clients.length} client${clients.length === 1 ? "" : "s"} across the funnel</p>
      </div>
      <a class="btn secondary" href="/app/clients">Table view</a>
    </div>
    <div class="kanban-scroll"><div class="kanban-board">${columns}</div></div>
    <p style="font-size:12px;color:var(--muted);margin-top:14px;">Change a client's stage from their edit page — this board is read-only for now (no drag-and-drop yet).</p>`;

  sendHtml(res, 200, layout({ account: req.account, title: "Pipeline", active: "clients", body }));
});

get("/app/commissions/export.csv", (req, res) => {
  const policies = db.listActivePoliciesWithClients(req.account.id);
  const csv = toCsv(policies, [
    ["Client", "client_name"],
    ["Policy type", "policy_type"],
    ["Carrier", "carrier"],
    ["Monthly premium", (p) => Number(p.monthly_premium).toFixed(2)],
    ["Annual premium", (p) => (Number(p.monthly_premium) * 12).toFixed(2)],
    ["Commission rate %", "commission_rate"],
    ["Est. annual commission", (p) => ((Number(p.monthly_premium) * 12 * Number(p.commission_rate)) / 100).toFixed(2)],
  ]);
  sendCsv(res, "hivehub-commission-report.csv", csv);
});

get("/app/commissions", (req, res) => {
  const policies = db.listActivePoliciesWithClients(req.account.id).map((p) => ({
    ...p,
    annualPremium: Number(p.monthly_premium) * 12,
    annualCommission: (Number(p.monthly_premium) * 12 * Number(p.commission_rate)) / 100,
  }));

  const totalAnnualPremium = policies.reduce((sum, p) => sum + p.annualPremium, 0);
  const totalAnnualCommission = policies.reduce((sum, p) => sum + p.annualCommission, 0);

  function groupBy(key) {
    const map = new Map();
    policies.forEach((p) => {
      const k = p[key] || "Unspecified";
      const g = map.get(k) || { key: k, count: 0, premium: 0, commission: 0 };
      g.count++;
      g.premium += p.annualPremium;
      g.commission += p.annualCommission;
      map.set(k, g);
    });
    return Array.from(map.values()).sort((a, b) => b.commission - a.commission);
  }

  function groupRows(groups) {
    return groups.length
      ? groups
          .map(
            (g) => `<tr>
          <td>${esc(g.key)}</td>
          <td>${g.count}</td>
          <td>${money(g.premium)}</td>
          <td>${money(g.commission)}</td>
        </tr>`
          )
          .join("")
      : `<tr><td colspan="4" class="empty-state">No active policies yet.</td></tr>`;
  }

  const byCarrier = groupBy("carrier");
  const byType = groupBy("policy_type");

  const policyRows = policies.length
    ? policies
        .slice()
        .sort((a, b) => b.annualCommission - a.annualCommission)
        .map(
          (p) => `<tr onclick="location.href='/app/clients/${p.client_id}'">
        <td>${esc(p.client_name)}</td>
        <td>${esc(p.policy_type)}</td>
        <td>${esc(p.carrier)}</td>
        <td>${money(p.monthly_premium)}</td>
        <td>${p.commission_rate}%</td>
        <td>${money(p.annualCommission)}</td>
      </tr>`
        )
        .join("")
    : `<tr><td colspan="6"><div class="empty-state">No active policies yet.</div></td></tr>`;

  const body = `
    <div class="page-header">
      <div>
        <h1>Commissions</h1>
        <p class="subtitle">Estimated annual commission across every active policy</p>
      </div>
      <a class="btn secondary" href="/app/commissions/export.csv">Export CSV</a>
    </div>

    <div class="stat-grid">
      <div class="stat-card accent">
        <div class="stat-label">Est. annual commission</div>
        <div class="stat-value">${money(totalAnnualCommission)}</div>
        <div class="stat-foot">Across ${policies.length} active polic${policies.length === 1 ? "y" : "ies"}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Total annual premium</div>
        <div class="stat-value">${money(totalAnnualPremium)}</div>
        <div class="stat-foot">Book of business in force</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Blended commission rate</div>
        <div class="stat-value">${totalAnnualPremium ? ((totalAnnualCommission / totalAnnualPremium) * 100).toFixed(1) : "0.0"}%</div>
        <div class="stat-foot">Weighted by premium</div>
      </div>
    </div>

    <div class="two-col" style="margin-top:16px;">
      <div class="card">
        <h3 style="margin-bottom:10px;">By carrier</h3>
        <div class="table-scroll">
        <table>
          <thead><tr><th>Carrier</th><th>Policies</th><th>Annual premium</th><th>Est. commission</th></tr></thead>
          <tbody>${groupRows(byCarrier)}</tbody>
        </table>
        </div>
      </div>
      <div class="card">
        <h3 style="margin-bottom:10px;">By policy type</h3>
        <div class="table-scroll">
        <table>
          <thead><tr><th>Type</th><th>Policies</th><th>Annual premium</th><th>Est. commission</th></tr></thead>
          <tbody>${groupRows(byType)}</tbody>
        </table>
        </div>
      </div>
    </div>

    <div class="card" style="margin-top:16px;">
      <h3 style="margin-bottom:10px;">Every active policy</h3>
      <div class="table-scroll">
      <table class="clickable">
        <thead><tr><th>Client</th><th>Type</th><th>Carrier</th><th>Monthly premium</th><th>Rate</th><th>Est. annual commission</th></tr></thead>
        <tbody>${policyRows}</tbody>
      </table>
      </div>
    </div>
    <p style="font-size:12px;color:var(--muted);margin-top:12px;">"Est." because this is commission_rate × annual premium — your actual carrier statements are the source of truth; this is a planning estimate, not a reconciliation.</p>`;

  sendHtml(res, 200, layout({ account: req.account, title: "Commissions", active: "commissions", body }));
});

get("/app/clients", (req, res, params, query) => {
  const q = query.get("q") || "";
  const stage = query.get("stage") || "";
  const clients = db.listClients(req.account.id, q, stage);
  const rows = clients.length
    ? clients
        .map(
          (c) => `<tr onclick="location.href='/app/clients/${c.id}'">
            <td>${esc(c.name)}</td>
            <td><span class="badge ${c.pipeline_stage}">${esc(STAGE_LABELS[c.pipeline_stage] || c.pipeline_stage)}</span></td>
            <td>${esc(c.email || "—")}</td>
            <td>${esc(c.phone || "—")}</td>
          </tr>`
        )
        .join("")
    : `<tr><td colspan="4"><div class="empty-state">No clients found. <a href="/app/clients/new">Add your first client</a>.</div></td></tr>`;

  const stagePills = ["", ...STAGE_ORDER]
    .map((s) => {
      const p = new URLSearchParams({ q });
      if (s) p.set("stage", s);
      return `<a class="toggle-pill${stage === s ? " active" : ""}" href="?${p.toString()}">${s ? STAGE_LABELS[s] : "All"}</a>`;
    })
    .join("");

  const body = `
    <div class="page-header">
      <div>
        <h1>Book of Business</h1>
        <p class="subtitle">${clients.length} client${clients.length === 1 ? "" : "s"}</p>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <a class="btn secondary" href="/app/clients/pipeline">Pipeline view</a>
        <a class="btn secondary" href="/app/clients/export.csv">Export CSV</a>
        <a class="btn secondary" href="/app/policies/export.csv">Export policies CSV</a>
        <a class="btn" href="/app/clients/new">+ Add client</a>
      </div>
    </div>
    <form class="search-bar" method="get" action="/app/clients">
      <input type="hidden" name="stage" value="${esc(stage)}" />
      <input type="text" name="q" value="${esc(q)}" placeholder="Search by name, email, or phone..." />
      <button class="btn secondary" type="submit">Search</button>
    </form>
    <div class="toggle-group toggle-group-scroll" style="margin-bottom:14px;">${stagePills}</div>
    <div class="card">
      <div class="table-scroll">
      <table class="clickable">
        <thead><tr><th>Name</th><th>Stage</th><th>Email</th><th>Phone</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      </div>
    </div>`;

  sendHtml(res, 200, layout({ account: req.account, title: "Book of Business", active: "clients", body }));
});

function clientForm({ client = {}, action, title }) {
  return `
    <div class="page-header"><h1>${title}</h1></div>
    <form class="card" method="post" action="${action}">
      <div class="form-grid">
        <div class="form-field">
          <label for="name">Full name *</label>
          <input id="name" name="name" required value="${esc(client.name)}" />
        </div>
        <div class="form-field">
          <label for="email">Email</label>
          <input id="email" name="email" type="email" value="${esc(client.email)}" />
        </div>
        <div class="form-field">
          <label for="phone">Phone</label>
          <input id="phone" name="phone" value="${esc(client.phone)}" />
        </div>
        <div class="form-field">
          <label for="address">Address</label>
          <input id="address" name="address" value="${esc(client.address)}" />
        </div>
        <div class="form-field">
          <label for="date_of_birth">Date of birth</label>
          <input id="date_of_birth" name="date_of_birth" type="date" value="${esc(client.date_of_birth)}" />
        </div>
        <div class="form-field">
          <label for="pipeline_stage">Pipeline stage</label>
          <select id="pipeline_stage" name="pipeline_stage">
            ${STAGE_ORDER.map((s) => `<option value="${s}" ${client.pipeline_stage === s ? "selected" : ""}>${STAGE_LABELS[s]}</option>`).join("")}
          </select>
        </div>
        <div class="form-field">
          <label for="next_followup">Next follow-up</label>
          <input id="next_followup" name="next_followup" type="date" value="${esc(client.next_followup)}" />
        </div>
        <div class="form-field full">
          <label for="followup_note">Follow-up note</label>
          <input id="followup_note" name="followup_note" value="${esc(client.followup_note)}" placeholder="e.g. Call back with an umbrella quote" />
        </div>
        <div class="form-field full">
          <label for="notes">Notes</label>
          <textarea id="notes" name="notes">${esc(client.notes)}</textarea>
        </div>
      </div>
      <div class="list-actions">
        <button class="btn" type="submit">Save client</button>
        <a class="btn secondary" href="/app/clients">Cancel</a>
      </div>
    </form>`;
}

get("/app/clients/new", (req, res) => {
  sendHtml(
    res,
    200,
    layout({ account: req.account, title: "Add client", active: "clients", body: clientForm({ action: "/app/clients", title: "Add client" }) })
  );
});

post("/app/clients", async (req, res) => {
  const body = await parseBody(req);
  if (!body.name || !body.name.trim()) return redirect(res, "/app/clients/new");
  const id = db.createClient({ ...body, account_id: req.account.id });
  redirect(res, `/app/clients/${id}`);
});

get("/app/clients/:id", (req, res, params, query) => {
  const client = db.getClient(req.account.id, params.id);
  if (!client) return notFound(res);
  const policies = db.listPoliciesForClient(params.id);
  const messages = db.listMessagesForClient(params.id);

  const policyItems = policies.length
    ? policies
        .map(
          (p) => `
      <div class="policy-item">
        <div>
          <div class="policy-main">${esc(p.policy_type)} &middot; ${esc(p.carrier)} <span class="badge ${p.status}">${esc(p.status)}</span></div>
          <div class="policy-meta">${p.policy_number ? `Policy #${esc(p.policy_number)} &middot; ` : ""}${p.coverage ? `Coverage: ${esc(p.coverage)} &middot; ` : ""}${p.effective_date ? `Effective ${esc(p.effective_date)}` : ""}${p.beneficiary ? ` &middot; Beneficiary: ${esc(p.beneficiary)}` : ""}</div>
        </div>
        <div style="display:flex;align-items:center;gap:14px;">
          <div class="policy-premium">${money(p.monthly_premium)}/mo</div>
          <a class="btn small secondary" href="/app/policies/${p.id}/edit">Edit</a>
          <form method="post" action="/app/policies/${p.id}/delete" onsubmit="return confirm('Delete this policy?');">
            <button class="btn small danger" type="submit">Delete</button>
          </form>
        </div>
      </div>`
        )
        .join("")
    : `<div class="empty-state">No policies yet for ${esc(client.name)}.</div>`;

  const aiDraft = generateAiDraft(client, policies);
  const templates = [
    {
      label: "Renewal reminder",
      subject: "Your policy renewal is coming up",
      body: `Hi ${firstName(client.name)}, just a heads up that your policy is coming up for renewal soon. Let me know if you'd like to review your coverage before it renews.`,
    },
    {
      label: "Birthday",
      subject: "Happy birthday!",
      body: `Happy birthday, ${firstName(client.name)}! Hope you have a great one!`,
    },
    {
      label: "Check-in",
      subject: "Checking in",
      body: `Hi ${firstName(client.name)}, just checking in to see how everything's going and if there's anything I can help with on your coverage.`,
    },
  ];
  function fillBtn(label, subject, msgBody, extraClass) {
    return `<button type="button" class="btn small ${extraClass || "secondary"}" onclick="document.getElementById('msg-subject').value=${esc(
      JSON.stringify(subject)
    )};document.getElementById('msg-body').value=${esc(JSON.stringify(msgBody))};">${esc(label)}</button>`;
  }
  const templateButtons =
    templates.map((t) => fillBtn(t.label, t.subject, t.body)).join("") +
    fillBtn("AI Draft", aiDraft.subject, aiDraft.body, "ai-draft");

  const messageItems = messages.length
    ? messages
        .map(
          (m) => `
      <div class="policy-item" style="align-items:flex-start;">
        <div>
          <div class="policy-main"><span class="badge ${m.channel}">${m.channel === "email" ? "Email" : "Text"}</span>${m.subject ? ` &middot; ${esc(m.subject)}` : ""}
            <span class="badge ${STATUS_BADGE[m.status] || "pending"}">${STATUS_LABEL[m.status] || esc(m.status)}</span>
          </div>
          <div class="policy-meta" style="white-space:pre-wrap;max-width:460px;">${esc(m.body)}</div>
          ${m.error ? `<div class="policy-meta" style="color:var(--danger);">${esc(m.error)}</div>` : ""}
        </div>
        <div class="policy-meta">${esc(m.created_at)}</div>
      </div>`
        )
        .join("")
    : `<div class="empty-state">No messages yet. Send the first one to ${esc(client.name)} above.</div>`;

  const draftPrefill = query && query.get("draft") === "1";
  const messagesCard = `
    <div class="card" style="margin-top:20px;" id="messages">
      <div class="page-header" style="margin-bottom:6px;">
        <h3 style="margin:0;">Messages</h3>
        <span style="font-size:12px;color:var(--muted);">Email sends for real once you connect a provider (see README) — texting isn't connected yet</span>
      </div>
      <form method="post" action="/app/clients/${client.id}/messages">
        <div class="form-grid">
          <div class="form-field">
            <label for="channel">Channel</label>
            <select id="channel" name="channel">
              <option value="email">Email</option>
              <option value="sms">Text (SMS)</option>
            </select>
          </div>
          <div class="form-field">
            <label for="msg-subject">Subject <span style="font-weight:400;color:var(--muted);">(email only)</span></label>
            <input id="msg-subject" name="subject" placeholder="e.g. Your policy renewal is coming up" value="${draftPrefill ? esc(aiDraft.subject) : ""}" />
          </div>
          <div class="form-field full">
            <label for="msg-body">Message *</label>
            <textarea id="msg-body" name="body" required placeholder="Write a message to ${esc(client.name)}...">${draftPrefill ? esc(aiDraft.body) : ""}</textarea>
          </div>
        </div>
        <div class="list-actions" style="flex-wrap:wrap;margin-bottom:12px;">${templateButtons}</div>
        <div class="list-actions">
          <button class="btn" type="submit">Send message</button>
        </div>
      </form>
      <form method="post" action="/app/clients/${client.id}/autopilot">
        <input type="hidden" name="enabled" value="${client.autopilot_enabled ? "1" : "0"}" />
        <label class="autopilot-row">
          <input type="checkbox" ${client.autopilot_enabled ? "checked" : ""} onclick="this.form.enabled.value=this.checked?'1':'0';this.form.submit();" />
          <span><strong>Autopilot</strong> — ${client.autopilot_enabled ? "on: " : ""}let AI send renewal reminders and check-ins like these automatically, once there's a concrete trigger (never a generic check-in on its own). ${client.email ? "" : '<span style="color:var(--danger);">Add an email address to this client to enable.</span>'}</span>
        </label>
      </form>
      <h4 style="margin:18px 0 10px;font-size:12px;text-transform:uppercase;letter-spacing:0.05em;color:var(--muted);">History</h4>
      ${messageItems}
    </div>`;

  const activityEvents = [
    { ts: client.created_at, title: "Client added", meta: `Pipeline stage: ${STAGE_LABELS[client.pipeline_stage] || client.pipeline_stage}`, color: "var(--muted)" },
  ];
  policies.forEach((p) => {
    activityEvents.push({ ts: p.created_at, title: `Policy added: ${p.policy_type} · ${p.carrier}`, meta: `${money(p.monthly_premium)}/mo · ${p.status}`, color: "var(--gold)" });
  });
  messages.forEach((m) => {
    activityEvents.push({ ts: m.created_at, title: `${m.channel === "email" ? "Email" : "Text"} ${m.status === "sent" ? "sent" : m.status === "failed" ? "failed" : "logged"}${m.subject ? ": " + m.subject : ""}`, meta: (m.body || "").slice(0, 90), color: "var(--charcoal)" });
  });
  const activityCard = `
    <div class="card" style="margin-top:20px;">
      <h3 style="margin-bottom:10px;">Activity</h3>
      ${renderTimeline(activityEvents)}
    </div>`;

  const body = `
    <div class="breadcrumb"><a href="/app/clients">Book of Business</a> / ${esc(client.name)}</div>
    <div class="page-header">
      <div>
        <h1>${esc(client.name)} <span class="badge ${client.pipeline_stage}" style="vertical-align:middle;font-size:11px;">${esc(STAGE_LABELS[client.pipeline_stage] || client.pipeline_stage)}</span></h1>
        <p class="subtitle">${esc(client.email || "")}${client.email && client.phone ? " · " : ""}${esc(client.phone || "")}</p>
      </div>
      <div class="list-actions">
        <a class="btn secondary" href="/app/clients/${client.id}/edit">Edit client</a>
        <form method="post" action="/app/clients/${client.id}/delete" onsubmit="return confirm('Delete ${esc(client.name)} and all their policies?');">
          <button class="btn danger" type="submit">Delete</button>
        </form>
      </div>
    </div>

    <div class="two-col">
      <div>
        <div class="page-header" style="margin-bottom:12px;">
          <h3 style="margin:0;">Policies</h3>
          <a class="btn small" href="/app/clients/${client.id}/policies/new">+ Add policy</a>
        </div>
        ${policyItems}
      </div>
      <div class="card">
        <h3 style="margin-bottom:10px;">Client details</h3>
        ${
          client.next_followup
            ? `<div class="policy-item" style="margin-bottom:12px;padding:10px 12px;"><div><div class="policy-main" style="font-size:13px;">Next follow-up</div><div class="policy-meta">${esc(client.followup_note || "")}</div></div><span class="badge ${client.next_followup < new Date().toISOString().slice(0, 10) ? "lapsed" : "pending"}">${esc(client.next_followup)}</span></div>`
            : ""
        }
        <p style="font-size:14px;color:var(--ink-soft);white-space:pre-wrap;">${esc(client.address ? `Address: ${client.address}\n` : "")}${esc(client.date_of_birth ? `Date of birth: ${client.date_of_birth}\n` : "")}${client.address || client.date_of_birth ? "\n" : ""}${esc(client.notes || "No notes yet.")}</p>
      </div>
    </div>
    ${activityCard}
    ${messagesCard}`;

  const msgFlag = query && query.get("msg");
  const flash =
    msgFlag === "sent"
      ? "Email sent."
      : msgFlag === "failed"
      ? "Couldn't send that email — see the error under the message below."
      : msgFlag === "logged"
      ? "Message logged (not delivered — connect an email provider to send for real; see README)."
      : null;
  sendHtml(res, 200, layout({ account: req.account, title: client.name, active: "clients", flash, body }));
});

get("/app/clients/:id/edit", (req, res, params) => {
  const client = db.getClient(req.account.id, params.id);
  if (!client) return notFound(res);
  const body = clientForm({ client, action: `/app/clients/${client.id}`, title: `Edit ${client.name}` });
  sendHtml(res, 200, layout({ account: req.account, title: "Edit client", active: "clients", body }));
});

post("/app/clients/:id", async (req, res, params) => {
  const client = db.getClient(req.account.id, params.id);
  if (!client) return notFound(res);
  const body = await parseBody(req);
  db.updateClient(params.id, body);
  redirect(res, `/app/clients/${params.id}`);
});

post("/app/clients/:id/delete", (req, res, params) => {
  db.deleteClient(req.account.id, params.id);
  redirect(res, "/app/clients");
});

post("/app/clients/:id/messages", async (req, res, params) => {
  const client = db.getClient(req.account.id, params.id);
  if (!client) return notFound(res);
  const body = await parseBody(req);
  if (!body.body || !body.body.trim()) return redirect(res, `/app/clients/${params.id}`);
  const channel = body.channel === "sms" ? "sms" : "email";
  const outcome = await sendAndLogMessage(db, client, { channel, subject: body.subject, body: body.body });
  const flag = outcome.ok ? "sent" : outcome.skipped ? "logged" : "failed";
  redirect(res, `/app/clients/${params.id}?msg=${flag}`);
});

post("/app/clients/:id/autopilot", async (req, res, params) => {
  const client = db.getClient(req.account.id, params.id);
  if (!client) return notFound(res);
  const body = await parseBody(req);
  db.setAutopilotEnabled(client.id, body.enabled === "1");
  redirect(res, `/app/clients/${params.id}#messages`);
});

function policyForm({ policy = {}, client, action, title }) {
  const typeOptions = POLICY_TYPES.map(
    (t) => `<option value="${t}" ${policy.policy_type === t ? "selected" : ""}>${t}</option>`
  ).join("");
  const statusOptions = ["active", "pending", "lapsed"]
    .map((s) => `<option value="${s}" ${policy.status === s ? "selected" : ""}>${s}</option>`)
    .join("");

  return `
    <div class="breadcrumb"><a href="/app/clients">Book of Business</a> / <a href="/app/clients/${client.id}">${esc(client.name)}</a> / ${title}</div>
    <div class="page-header"><h1>${title}</h1></div>
    <form class="card" method="post" action="${action}">
      <div class="form-grid">
        <div class="form-field">
          <label for="policy_type">Policy type *</label>
          <select id="policy_type" name="policy_type" required>${typeOptions}</select>
        </div>
        <div class="form-field">
          <label for="carrier">Carrier *</label>
          <input id="carrier" name="carrier" required value="${esc(policy.carrier)}" placeholder="e.g. Progressive" />
        </div>
        <div class="form-field">
          <label for="monthly_premium">Monthly premium ($) *</label>
          <input id="monthly_premium" name="monthly_premium" type="number" step="0.01" min="0" required value="${policy.monthly_premium ?? ""}" />
        </div>
        <div class="form-field">
          <label for="coverage">Coverage</label>
          <input id="coverage" name="coverage" value="${esc(policy.coverage)}" placeholder="e.g. $300k liability" />
        </div>
        <div class="form-field">
          <label for="policy_number">Policy number</label>
          <input id="policy_number" name="policy_number" value="${esc(policy.policy_number)}" />
        </div>
        <div class="form-field">
          <label for="effective_date">Effective date</label>
          <input id="effective_date" name="effective_date" type="date" value="${esc(policy.effective_date)}" />
        </div>
        <div class="form-field">
          <label for="beneficiary">Beneficiary</label>
          <input id="beneficiary" name="beneficiary" value="${esc(policy.beneficiary)}" placeholder="e.g. Spouse — Maria Ellis" />
        </div>
        <div class="form-field">
          <label for="status">Status</label>
          <select id="status" name="status">${statusOptions}</select>
        </div>
        <div class="form-field">
          <label for="commission_rate">Commission rate (%)</label>
          <input id="commission_rate" name="commission_rate" type="number" step="0.1" min="0" max="100" value="${policy.commission_rate ?? ""}" placeholder="e.g. 70" />
        </div>
      </div>
      <div class="list-actions">
        <button class="btn" type="submit">Save policy</button>
        <a class="btn secondary" href="/app/clients/${client.id}">Cancel</a>
      </div>
    </form>`;
}

get("/app/clients/:id/policies/new", (req, res, params) => {
  const client = db.getClient(req.account.id, params.id);
  if (!client) return notFound(res);
  const body = policyForm({ client, action: `/app/clients/${client.id}/policies`, title: "Add policy" });
  sendHtml(res, 200, layout({ account: req.account, title: "Add policy", active: "clients", body }));
});

post("/app/clients/:id/policies", async (req, res, params) => {
  const client = db.getClient(req.account.id, params.id);
  if (!client) return notFound(res);
  const body = await parseBody(req);
  db.createPolicy({ ...body, client_id: client.id });
  redirect(res, `/app/clients/${client.id}`);
});

get("/app/policies/:id/edit", (req, res, params) => {
  const policy = db.getPolicy(req.account.id, params.id);
  if (!policy) return notFound(res);
  const client = db.getClient(req.account.id, policy.client_id);
  const body = policyForm({ policy, client, action: `/app/policies/${policy.id}`, title: "Edit policy" });
  sendHtml(res, 200, layout({ account: req.account, title: "Edit policy", active: "clients", body }));
});

post("/app/policies/:id", async (req, res, params) => {
  const policy = db.getPolicy(req.account.id, params.id);
  if (!policy) return notFound(res);
  const body = await parseBody(req);
  db.updatePolicy(params.id, body);
  redirect(res, `/app/clients/${policy.client_id}`);
});

post("/app/policies/:id/delete", (req, res, params) => {
  const policy = db.getPolicy(req.account.id, params.id);
  if (!policy) return notFound(res);
  db.deletePolicy(params.id);
  redirect(res, `/app/clients/${policy.client_id}`);
});

// ================= Home Service CRM =================

const HS_NAV = [
  { href: "/hs", label: "Dashboard", key: "dashboard" },
  { href: "/hs/schedule", label: "Schedule", key: "schedule" },
  { href: "/hs/jobs", label: "Jobs", key: "jobs" },
  { href: "/hs/clients", label: "Clients", key: "clients" },
  { href: "/hs/price-book", label: "Price Book", key: "price-book" },
  { href: "/hs/messages", label: "Communication", key: "messages" },
];
const HS_TAGLINE = "Client, property, and job management for home service teams.";

function hsLayout(opts) {
  return layout({ ...opts, nav: HS_NAV, tagline: HS_TAGLINE });
}

// Signed day difference between today and a YYYY-MM-DD date string
// (positive = future, negative = past) — used by the job-outreach heuristics.
function daysFromToday(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr + "T00:00:00");
  if (isNaN(d.getTime())) return null;
  const today = new Date();
  const todayMid = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.round((d - todayMid) / 86400000);
}

const LINE_ITEM_ROWS = 4;

function lineItemsFromBody(body) {
  const items = [];
  for (let i = 1; i <= LINE_ITEM_ROWS; i++) {
    const desc = (body[`item${i}_desc`] || "").trim();
    if (!desc) continue;
    const qty = parseFloat(body[`item${i}_qty`]) || 1;
    const price = parseFloat(body[`item${i}_price`]) || 0;
    items.push({ desc, qty, price });
  }
  return JSON.stringify(items);
}

function lineItemFormRows(items, priceBook) {
  const priceBookOptions = (priceBook || [])
    .map((p, idx) => `<option value="${idx}">${esc(p.name)} — ${money(p.default_price)}${p.unit === "hour" ? "/hr" : ""}</option>`)
    .join("");
  const rows = [];
  for (let i = 0; i < LINE_ITEM_ROWS; i++) {
    const it = items[i] || {};
    const pickerCell = priceBook && priceBook.length
      ? `<select onchange="fillPriceBookRow(${i + 1}, this)" style="font-size:11.5px;">
           <option value="">From price book…</option>
           ${priceBookOptions}
         </select>`
      : "";
    rows.push(`
      <div class="form-grid" style="grid-template-columns:${priceBook && priceBook.length ? "1fr " : ""}2fr 0.6fr 0.8fr;gap:8px;margin-bottom:8px;">
        ${pickerCell}
        <input name="item${i + 1}_desc" placeholder="Description" value="${esc(it.desc || "")}" oninput="updateJobTotal()" />
        <input name="item${i + 1}_qty" type="number" step="0.01" min="0" placeholder="Qty" value="${it.qty ?? ""}" oninput="updateJobTotal()" />
        <input name="item${i + 1}_price" type="number" step="0.01" min="0" placeholder="Price" value="${it.price ?? ""}" oninput="updateJobTotal()" />
      </div>`);
  }
  return rows.join("");
}

function jobTotalScript(priceBook) {
  const priceBookJson = JSON.stringify((priceBook || []).map((p) => ({ name: p.name, price: p.default_price })));
  return `
<script>
var HS_PRICE_BOOK = ${priceBookJson};
function updateJobTotal(){
  var total = 0;
  for (var i = 1; i <= ${LINE_ITEM_ROWS}; i++) {
    var qtyEl = document.querySelector('[name="item'+i+'_qty"]');
    var priceEl = document.querySelector('[name="item'+i+'_price"]');
    var qty = qtyEl ? parseFloat(qtyEl.value) || 0 : 0;
    var price = priceEl ? parseFloat(priceEl.value) || 0 : 0;
    total += qty * price;
  }
  var el = document.getElementById('job-total-preview');
  if (el) el.textContent = '$' + total.toFixed(2);
}
function fillPriceBookRow(row, sel) {
  var idx = sel.value;
  if (idx === "") return;
  var item = HS_PRICE_BOOK[idx];
  if (!item) return;
  var descEl = document.querySelector('[name="item'+row+'_desc"]');
  var qtyEl = document.querySelector('[name="item'+row+'_qty"]');
  var priceEl = document.querySelector('[name="item'+row+'_price"]');
  if (descEl) descEl.value = item.name;
  if (qtyEl && !qtyEl.value) qtyEl.value = 1;
  if (priceEl) priceEl.value = item.price;
  updateJobTotal();
  sel.value = "";
}
</script>`;
}

function renderLineItemsTable(items) {
  if (!items.length) return `<p style="color:var(--muted);font-size:13px;">No line items yet.</p>`;
  const rows = items
    .map(
      (it) =>
        `<tr><td>${esc(it.desc)}</td><td>${esc(it.qty)}</td><td>${money(it.price)}</td><td>${money((Number(it.qty) || 0) * (Number(it.price) || 0))}</td></tr>`
    )
    .join("");
  const total = items.reduce((s, it) => s + (Number(it.qty) || 0) * (Number(it.price) || 0), 0);
  return `<div class="table-scroll"><table><thead><tr><th>Description</th><th>Qty</th><th>Price</th><th>Total</th></tr></thead><tbody>${rows}</tbody></table></div>
  <p style="text-align:right;font-weight:800;margin-top:8px;">Total: ${money(total)}</p>`;
}

// Rule-based "AI" draft for Home Service — same honesty as generateAiDraft
// above: a couple of scoped heuristics keyed on job stage/timing, not a real
// language model. Picks the single most urgent thing to say to this client.
function generateHsAiDraft(client, jobs) {
  const fn = firstName(client.name);
  const openJobs = jobs.filter((j) => j.stage !== "cancelled");

  const scheduledSoon = openJobs
    .filter((j) => j.stage === "scheduled" && j.scheduled_date)
    .map((j) => ({ job: j, days: daysFromToday(j.scheduled_date) }))
    .filter((x) => x.days !== null && x.days >= 0 && x.days <= 2)
    .sort((a, b) => a.days - b.days)[0];
  if (scheduledSoon) {
    const j = scheduledSoon.job;
    return {
      subject: `Reminder: ${j.title} is coming up`,
      body: `Hi ${fn}, just confirming we've got you on the schedule for "${j.title}"${j.scheduled_window ? ` (${j.scheduled_window})` : ""} on ${j.scheduled_date}. Let me know if anything's changed on your end!`,
      key: `job:${j.id}:reminder`,
    };
  }

  const completed = openJobs.find((j) => j.stage === "completed");
  if (completed) {
    return {
      subject: `${completed.title} is complete`,
      body: `Hi ${fn}, just wrapped up "${completed.title}" — thanks for having us out! Your invoice is on its way shortly. Let me know if you have any questions in the meantime.`,
      key: `job:${completed.id}:completed_nudge`,
    };
  }

  const invoiced = openJobs.find((j) => j.stage === "invoiced");
  if (invoiced) {
    return {
      subject: `Invoice for ${invoiced.title}`,
      body: `Hi ${fn}, just a friendly nudge that the invoice for "${invoiced.title}" is still open. Let me know if you have any questions or if you'd like it resent.`,
      key: `job:${invoiced.id}:invoice_nudge`,
    };
  }

  const paid = openJobs.find((j) => j.stage === "paid");
  if (paid) {
    return {
      subject: `How did we do?`,
      body: `Hi ${fn}, thanks again for choosing us for "${paid.title}"! If you have a minute, a quick review would mean a lot to our small business — and let us know if anything comes up down the road.`,
      key: `job:${paid.id}:review_ask`,
    };
  }

  return {
    subject: "Checking in",
    body: `Hi ${fn}, just checking in — anything around the property we can help with these days? Happy to get you scheduled whenever's convenient.`,
    key: null,
  };
}

get("/hs", (req, res) => {
  const stats = hsdb.dashboardStats(req.account.id);
  const maxStage = Math.max(1, ...hsdb.JOB_STAGES.map((s) => stats.stageCounts[s] || 0));
  const stageRows = hsdb.JOB_STAGES.map((s) => {
    const count = stats.stageCounts[s] || 0;
    return `
      <div style="margin-bottom:10px;">
        <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:4px;">
          <span><strong>${hsdb.JOB_STAGE_LABELS[s]}</strong></span>
          <span>${count}</span>
        </div>
        <div style="background:#f1e7cb;border-radius:6px;height:8px;overflow:hidden;">
          <div style="background:var(--gold);height:100%;width:${(count / maxStage) * 100}%;"></div>
        </div>
      </div>`;
  }).join("");

  const recentRows = stats.recentClients.length
    ? stats.recentClients
        .map(
          (c) =>
            `<tr onclick="location.href='/hs/clients/${c.id}'"><td>${esc(c.name)}</td><td><span class="badge">${esc(c.client_type)}</span></td><td>${esc(c.email || "—")}</td><td>${esc(c.phone || "—")}</td></tr>`
        )
        .join("")
    : `<tr><td colspan="4" class="empty-state">No clients yet.</td></tr>`;

  const overdueInvoices = hsdb.listOverdueInvoices(req.account.id);
  const overdueRows = overdueInvoices.length
    ? overdueInvoices
        .slice(0, 5)
        .map(
          (j) =>
            `<tr onclick="location.href='/hs/jobs/${j.id}'"><td>${esc(j.client_name)}</td><td>${esc(j.title)}</td><td>${money(j.amount)}</td><td>${j.daysOverdue}d</td></tr>`
        )
        .join("")
    : "";

  const body = `
    <div class="page-header">
      <div>
        <h1>Dashboard</h1>
        <p class="subtitle">Your Home Service business at a glance</p>
      </div>
      <a class="btn" href="/hs/clients/new">+ Add client</a>
    </div>

    <div class="stat-grid">
      <div class="stat-card accent">
        <div class="stat-label">Open jobs</div>
        <div class="stat-value">${stats.openJobs}</div>
        <div class="stat-foot">Not yet paid or cancelled</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Scheduled this week</div>
        <div class="stat-value">${stats.jobsThisWeek}</div>
        <div class="stat-foot">Next 7 days</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Revenue this month</div>
        <div class="stat-value">${money(stats.revenueThisMonth)}</div>
        <div class="stat-foot">Jobs marked Paid</div>
      </div>
      <div class="stat-card${stats.overdueCount ? " accent" : ""}">
        <div class="stat-label">Overdue invoices</div>
        <div class="stat-value">${stats.overdueCount}</div>
        <div class="stat-foot">Invoiced ${hsdb.OVERDUE_INVOICE_DAYS}+ days, unpaid</div>
      </div>
    </div>

    <div class="two-col">
      <div class="card">
        <h3 style="margin-bottom:14px;">Clients</h3>
        <div class="table-scroll">
        <table class="clickable">
          <thead><tr><th>Name</th><th>Type</th><th>Email</th><th>Phone</th></tr></thead>
          <tbody>${recentRows}</tbody>
        </table>
        </div>
        <div style="margin-top:14px;"><a class="btn ghost" href="/hs/clients" style="border:1px solid var(--line);">View all clients →</a></div>
      </div>
      <div class="card">
        <h3 style="margin-bottom:14px;">Jobs by stage</h3>
        ${stageRows}
        <div style="margin-top:10px;"><a class="btn ghost" href="/hs/jobs" style="border:1px solid var(--line);">View all jobs →</a></div>
      </div>
    </div>

    ${
      overdueInvoices.length
        ? `<div class="card" style="margin-top:16px;">
        <h3 style="margin-bottom:14px;">Needs collecting</h3>
        <div class="table-scroll">
        <table class="clickable">
          <thead><tr><th>Client</th><th>Job</th><th>Amount</th><th>Overdue</th></tr></thead>
          <tbody>${overdueRows}</tbody>
        </table>
        </div>
      </div>`
        : ""
    }`;

  sendHtml(res, 200, hsLayout({ account: req.account, title: "Home Service Dashboard", active: "dashboard", body }));
});

function pad2(n) {
  return String(n).padStart(2, "0");
}
function isoLocal(d) {
  return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
}
const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

get("/hs/schedule", (req, res, params, query) => {
  const monthParam = query.get("month");
  const tech = query.get("tech") || "";
  const today = new Date();
  let year = today.getFullYear();
  let month = today.getMonth();
  if (monthParam && /^\d{4}-\d{2}$/.test(monthParam)) {
    const [y, m] = monthParam.split("-").map(Number);
    year = y;
    month = m - 1;
  }

  const firstOfMonth = new Date(year, month, 1);
  const lastOfMonth = new Date(year, month + 1, 0);
  const gridStart = new Date(firstOfMonth);
  gridStart.setDate(gridStart.getDate() - gridStart.getDay());
  const gridEnd = new Date(lastOfMonth);
  gridEnd.setDate(gridEnd.getDate() + (6 - gridEnd.getDay()));

  const jobs = hsdb.listJobsInRange(req.account.id, isoLocal(gridStart), isoLocal(gridEnd), { tech });
  const techs = hsdb.listAssignedTechs(req.account.id);
  const byDay = {};
  jobs.forEach((j) => {
    const key = String(j.scheduled_date).slice(0, 10);
    (byDay[key] = byDay[key] || []).push(j);
  });

  const todayStr = isoLocal(today);
  const monthLabel = firstOfMonth.toLocaleDateString("en-US", { month: "long", year: "numeric" });

  const prevMonth = new Date(year, month - 1, 1);
  const nextMonth = new Date(year, month + 1, 1);
  const prevMonthParam = prevMonth.getFullYear() + "-" + pad2(prevMonth.getMonth() + 1);
  const nextMonthParam = nextMonth.getFullYear() + "-" + pad2(nextMonth.getMonth() + 1);
  const thisMonthParam = today.getFullYear() + "-" + pad2(today.getMonth() + 1);
  const techQS = tech ? `&tech=${encodeURIComponent(tech)}` : "";

  const totalDays = Math.round((gridEnd - gridStart) / 86400000) + 1;
  const cells = [];
  for (let i = 0; i < totalDays; i++) {
    const d = new Date(gridStart);
    d.setDate(d.getDate() + i);
    const key = isoLocal(d);
    const dayJobs = (byDay[key] || []).slice().sort((a, b) => (a.scheduled_window || "").localeCompare(b.scheduled_window || ""));
    const inMonth = d.getMonth() === month;
    const isToday = key === todayStr;
    const shown = dayJobs.slice(0, 3);
    const more = dayJobs.length - shown.length;
    const chips = shown
      .map(
        (j) =>
          `<div style="font-size:10.5px;padding:2px 5px;border-radius:5px;background:var(--panel);border:1px solid var(--line);margin-bottom:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${esc(j.title)} — ${esc(j.client_name)}">${esc(j.title)}</div>`
      )
      .join("");
    cells.push(`
      <a href="/hs/schedule/day/${key}" style="display:flex;flex-direction:column;min-width:0;min-height:104px;padding:6px 7px;border:1px solid var(--line);text-decoration:none;color:inherit;overflow:hidden;background:${inMonth ? "var(--panel)" : "var(--cream)"};${isToday ? "box-shadow:inset 0 0 0 2px var(--gold);" : ""}">
        <div style="font-size:11.5px;font-weight:${isToday ? "800" : "600"};color:${inMonth ? (isToday ? "var(--gold-dark)" : "var(--ink)") : "var(--muted)"};margin-bottom:4px;">${d.getDate()}${isToday ? " · Today" : ""}</div>
        ${chips}
        ${more > 0 ? `<div style="font-size:10px;color:var(--muted);margin-top:2px;">+${more} more</div>` : ""}
      </a>`);
  }

  const weekdayHeader = WEEKDAY_LABELS.map((w) => `<div style="font-size:10.5px;font-weight:800;text-transform:uppercase;letter-spacing:0.04em;color:var(--muted);text-align:center;padding:4px 0;">${w}</div>`).join("");

  const body = `
    <div class="page-header">
      <div>
        <h1>Schedule</h1>
        <p class="subtitle">Dispatch view — ${monthLabel}</p>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <a class="btn secondary" href="/hs/schedule?month=${prevMonthParam}${techQS}">← Prev month</a>
        <a class="btn secondary" href="/hs/schedule?month=${thisMonthParam}${techQS}">Today</a>
        <a class="btn secondary" href="/hs/schedule?month=${nextMonthParam}${techQS}">Next month →</a>
      </div>
    </div>
    <form method="get" style="display:flex;gap:10px;margin-bottom:14px;align-items:center;">
      <input type="hidden" name="month" value="${year}-${pad2(month + 1)}" />
      <label style="font-size:13px;font-weight:600;color:var(--muted);">Technician:</label>
      <select name="tech" onchange="this.form.submit()" style="min-width:150px;">
        <option value="">All technicians</option>
        ${techs.map((t) => `<option value="${esc(t)}" ${tech === t ? "selected" : ""}>${esc(t)}</option>`).join("")}
      </select>
    </form>
    <div class="cal-grid" style="display:grid;grid-template-columns:repeat(7,1fr);border:1px solid var(--line);border-bottom:none;background:var(--cream);">${weekdayHeader}</div>
    <div class="cal-grid" style="display:grid;grid-template-columns:repeat(7,1fr);gap:1px;background:var(--line);border:1px solid var(--line);border-top:none;">${cells.join("")}</div>
    <p style="font-size:12px;color:var(--muted);margin-top:14px;">Jobs without a scheduled date won't appear here — set one from the job's edit page. Click any day to see the full list of jobs for that day.</p>`;

  sendHtml(res, 200, hsLayout({ account: req.account, title: "Schedule", active: "schedule", body }));
});

get("/hs/schedule/day/:date", (req, res, params) => {
  const date = params.date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return notFound(res);
  const jobs = hsdb.listJobsForDay(req.account.id, date).sort((a, b) => (a.scheduled_window || "").localeCompare(b.scheduled_window || ""));
  const dateObj = new Date(date + "T00:00:00");
  const label = dateObj.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  const monthParam = date.slice(0, 7);

  const prevDateObj = new Date(dateObj);
  prevDateObj.setDate(prevDateObj.getDate() - 1);
  const nextDateObj = new Date(dateObj);
  nextDateObj.setDate(nextDateObj.getDate() + 1);
  const prevDate = isoLocal(prevDateObj);
  const nextDate = isoLocal(nextDateObj);

  const rows = jobs.length
    ? jobs
        .map(
          (j) => `
      <div class="policy-item" onclick="location.href='/hs/jobs/${j.id}'" style="cursor:pointer;">
        <div>
          <div class="policy-main">${esc(j.title)} <span class="badge ${esc(j.stage)}">${esc(hsdb.JOB_STAGE_LABELS[j.stage] || j.stage)}</span></div>
          <div class="policy-meta">${esc(j.client_name)}${j.property_label ? " · " + esc(j.property_label) : ""}${j.property_address ? " — " + esc(j.property_address) : ""}</div>
          <div class="policy-meta">${esc(j.scheduled_window || "No arrival window set")}${j.assigned_tech ? " · " + esc(j.assigned_tech) : " · Unassigned"}${j.client_phone ? " · " + esc(j.client_phone) : ""}</div>
        </div>
        <div class="policy-premium">${money(hsdb.lineItemsTotal(j.line_items))}</div>
      </div>`
        )
        .join("")
    : `<div class="empty-state">No jobs scheduled for this day.</div>`;

  const body = `
    <div class="breadcrumb"><a href="/hs/schedule?month=${monthParam}">Schedule</a> / ${esc(label)}</div>
    <div class="page-header">
      <div>
        <h1>${esc(label)}</h1>
        <p class="subtitle">${jobs.length} job${jobs.length === 1 ? "" : "s"} scheduled</p>
      </div>
      <a class="btn secondary" href="/hs/schedule?month=${monthParam}">← Back to calendar</a>
    </div>
    <div style="display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap;">
      <a class="btn secondary" href="/hs/schedule/day/${prevDate}">← Prev day</a>
      <a class="btn secondary" href="/hs/schedule/day/${nextDate}">Next day →</a>
    </div>
    <div class="card">${rows}</div>`;

  sendHtml(res, 200, hsLayout({ account: req.account, title: label, active: "schedule", body }));
});

get("/hs/jobs/export.csv", (req, res) => {
  const jobs = hsdb.listAllJobs(req.account.id, {});
  const csv = toCsv(jobs, [
    ["Job", "title"],
    ["Client", "client_name"],
    ["Property", "property_label"],
    ["Job type", "job_type"],
    ["Stage", (j) => hsdb.JOB_STAGE_LABELS[j.stage] || j.stage],
    ["Scheduled date", "scheduled_date"],
    ["Arrival window", "scheduled_window"],
    ["Assigned tech", "assigned_tech"],
    ["Total", (j) => hsdb.lineItemsTotal(j.line_items).toFixed(2)],
  ]);
  sendCsv(res, "hivehub-home-service-jobs.csv", csv);
});

get("/hs/jobs", (req, res, params, query) => {
  const stage = query.get("stage") || "";
  const tech = query.get("tech") || "";
  const q = (query.get("q") || "").trim();
  const jobs = hsdb.listAllJobs(req.account.id, { stage, tech, search: q });
  const techs = hsdb.listAssignedTechs(req.account.id);

  const rows = jobs.length
    ? jobs
        .map((j) => {
          const total = hsdb.lineItemsTotal(j.line_items);
          return `<tr onclick="location.href='/hs/jobs/${j.id}'">
          <td>${esc(j.title)}</td>
          <td>${esc(j.client_name)}</td>
          <td><span class="badge ${j.stage}">${hsdb.JOB_STAGE_LABELS[j.stage]}</span></td>
          <td>${j.scheduled_date ? esc(j.scheduled_date) + (j.scheduled_window ? ` (${esc(j.scheduled_window)})` : "") : "—"}</td>
          <td>${esc(j.assigned_tech || "—")}</td>
          <td>${money(total)}</td>
        </tr>`;
        })
        .join("")
    : `<tr><td colspan="6"><div class="empty-state">No jobs found.</div></td></tr>`;

  const stagePills = ["", ...hsdb.JOB_STAGES, ...hsdb.JOB_SIDE_STAGES]
    .map((s) => {
      const params2 = new URLSearchParams();
      if (s) params2.set("stage", s);
      if (tech) params2.set("tech", tech);
      if (q) params2.set("q", q);
      const qs = params2.toString();
      return `<a class="toggle-pill${stage === s ? " active" : ""}" href="${qs ? "?" + qs : "?"}">${s ? hsdb.JOB_STAGE_LABELS[s] : "All"}</a>`;
    })
    .join("");

  const techOptions = techs
    .map((t) => `<option value="${esc(t)}" ${tech === t ? "selected" : ""}>${esc(t)}</option>`)
    .join("");

  const body = `
    <div class="page-header">
      <div>
        <h1>Jobs</h1>
        <p class="subtitle">${jobs.length} job${jobs.length === 1 ? "" : "s"}${stage ? " · " + hsdb.JOB_STAGE_LABELS[stage] : ""}${tech ? " · " + esc(tech) : ""}</p>
      </div>
      <a class="btn secondary" href="/hs/jobs/export.csv">Export CSV</a>
    </div>
    <form method="get" style="display:flex;gap:10px;margin-bottom:14px;flex-wrap:wrap;align-items:center;">
      ${stage ? `<input type="hidden" name="stage" value="${esc(stage)}" />` : ""}
      <input type="text" name="q" value="${esc(q)}" placeholder="Search by job title or client..." style="flex:1;min-width:180px;" />
      <select name="tech" onchange="this.form.submit()" style="min-width:150px;">
        <option value="">All technicians</option>
        ${techOptions}
      </select>
      <button class="btn secondary" type="submit">Search</button>
    </form>
    <div class="toggle-group toggle-group-scroll" style="margin-bottom:14px;">${stagePills}</div>
    <div class="card">
      <div class="table-scroll">
      <table class="clickable">
        <thead><tr><th>Job</th><th>Client</th><th>Stage</th><th>Scheduled</th><th>Tech</th><th>Total</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      </div>
    </div>
    <p style="font-size:12.5px;color:var(--muted);margin-top:12px;">New jobs are created from a client's page, alongside their properties and history — open a client and use "+ Add job."</p>`;

  sendHtml(res, 200, hsLayout({ account: req.account, title: "Jobs", active: "jobs", body }));
});

get("/hs/jobs/:id", (req, res, params) => {
  const job = hsdb.getJob(req.account.id, params.id);
  if (!job) return notFound(res);
  const items = hsdb.parseLineItems(job.line_items);

  const stageOptions = [...hsdb.JOB_STAGES, ...hsdb.JOB_SIDE_STAGES]
    .map((s) => `<option value="${s}" ${job.stage === s ? "selected" : ""}>${hsdb.JOB_STAGE_LABELS[s]}</option>`)
    .join("");

  const body = `
    <div class="breadcrumb"><a href="/hs/clients">Clients</a> / <a href="/hs/clients/${job.client_id}">${esc(job.client_name)}</a> / ${esc(job.title)}</div>
    <div class="page-header">
      <div>
        <h1>${esc(job.title)} <span class="badge ${job.stage}" style="vertical-align:middle;font-size:11px;">${hsdb.JOB_STAGE_LABELS[job.stage]}</span></h1>
        <p class="subtitle">${esc(job.job_type)}${job.property_label ? " · " + esc(job.property_label) : ""}${job.property_address ? " — " + esc(job.property_address) : ""}</p>
      </div>
      <div class="list-actions">
        <a class="btn secondary" href="/hs/jobs/${job.id}/edit">Edit job</a>
        <form method="post" action="/hs/jobs/${job.id}/delete" onsubmit="return confirm('Delete this job?');">
          <button class="btn danger" type="submit">Delete</button>
        </form>
      </div>
    </div>

    <div class="two-col">
      <div class="card">
        <h3 style="margin-bottom:10px;">Line items</h3>
        ${renderLineItemsTable(items)}
        ${job.customer_notes ? `<h4 style="margin:16px 0 6px;font-size:12px;text-transform:uppercase;letter-spacing:0.05em;color:var(--muted);">Customer-visible notes</h4><p style="font-size:14px;white-space:pre-wrap;">${esc(job.customer_notes)}</p>` : ""}
        ${job.internal_notes ? `<h4 style="margin:16px 0 6px;font-size:12px;text-transform:uppercase;letter-spacing:0.05em;color:var(--muted);">Internal notes</h4><p style="font-size:14px;white-space:pre-wrap;">${esc(job.internal_notes)}</p>` : ""}
      </div>
      <div class="card">
        <h3 style="margin-bottom:10px;">Details</h3>
        <p style="font-size:14px;color:var(--ink-soft);line-height:1.8;">
          Scheduled: ${job.scheduled_date ? esc(job.scheduled_date) + (job.scheduled_window ? ` (${esc(job.scheduled_window)})` : "") : "Not scheduled"}<br/>
          Assigned to: ${esc(job.assigned_tech || "Unassigned")}<br/>
          Recurrence: ${esc(hsdb.RECURRENCE_LABELS[job.recurrence] || job.recurrence)}<br/>
          Created: ${esc(job.created_at)}<br/>
          Updated: ${esc(job.updated_at)}
        </p>
        <form method="post" action="/hs/jobs/${job.id}/stage" style="margin-top:14px;">
          <div class="form-field">
            <label for="stage">Move to stage</label>
            <select id="stage" name="stage">${stageOptions}</select>
          </div>
          <button class="btn small" type="submit">Update stage</button>
        </form>
      </div>
    </div>
    <div class="list-actions" style="margin-top:16px;">
      <a class="btn small secondary" href="/hs/clients/${job.client_id}#messages">Message ${esc(job.client_name)} →</a>
    </div>`;

  sendHtml(res, 200, hsLayout({ account: req.account, title: job.title, active: "jobs", body }));
});

function jobForm({ job = {}, client, properties, action, title }) {
  const items = hsdb.parseLineItems(job.line_items || "[]");
  const priceBook = hsdb.listPriceBook(req.account.id);
  const propertyOptions = properties
    .map((p) => `<option value="${p.id}" ${String(job.property_id) === String(p.id) ? "selected" : ""}>${esc(p.label)}</option>`)
    .join("");
  const typeOptions = hsdb.JOB_TYPES.map((t) => `<option value="${t}" ${job.job_type === t ? "selected" : ""}>${t}</option>`).join("");
  const recurrenceOptions = hsdb.RECURRENCE_OPTIONS
    .map((r) => `<option value="${r}" ${job.recurrence === r ? "selected" : ""}>${hsdb.RECURRENCE_LABELS[r]}</option>`)
    .join("");
  const stageOptions = [...hsdb.JOB_STAGES, ...hsdb.JOB_SIDE_STAGES]
    .map((s) => `<option value="${s}" ${job.stage === s ? "selected" : ""}>${hsdb.JOB_STAGE_LABELS[s]}</option>`)
    .join("");
  const total = items.reduce((s, it) => s + (Number(it.qty) || 0) * (Number(it.price) || 0), 0);

  return `
    <div class="breadcrumb"><a href="/hs/clients">Clients</a> / <a href="/hs/clients/${client.id}">${esc(client.name)}</a> / ${title}</div>
    <div class="page-header"><h1>${title}</h1></div>
    <form class="card" method="post" action="${action}">
      <div class="form-grid">
        <div class="form-field full">
          <label for="title">Job title *</label>
          <input id="title" name="title" required value="${esc(job.title)}" placeholder="e.g. Water heater replacement" />
        </div>
        <div class="form-field">
          <label for="job_type">Job type</label>
          <select id="job_type" name="job_type">${typeOptions}</select>
        </div>
        <div class="form-field">
          <label for="property_id">Property</label>
          <select id="property_id" name="property_id">
            <option value="">— No property on file —</option>
            ${propertyOptions}
          </select>
        </div>
        <div class="form-field">
          <label for="scheduled_date">Scheduled date</label>
          <input id="scheduled_date" name="scheduled_date" type="date" value="${esc(job.scheduled_date)}" />
        </div>
        <div class="form-field">
          <label for="scheduled_window">Arrival window</label>
          <input id="scheduled_window" name="scheduled_window" value="${esc(job.scheduled_window)}" placeholder="e.g. 9am–11am" />
        </div>
        <div class="form-field">
          <label for="assigned_tech">Assigned to</label>
          <input id="assigned_tech" name="assigned_tech" value="${esc(job.assigned_tech)}" placeholder="e.g. Marcus" />
        </div>
        <div class="form-field">
          <label for="recurrence">Recurrence</label>
          <select id="recurrence" name="recurrence">${recurrenceOptions}</select>
        </div>
        <div class="form-field full">
          <label for="stage">Stage</label>
          <select id="stage" name="stage">${stageOptions}</select>
        </div>
        <div class="form-field full">
          <label>Line items</label>
          ${lineItemFormRows(items, priceBook)}
          <p style="text-align:right;font-size:13px;color:var(--muted);margin:2px 0 0;">Estimated total: <strong id="job-total-preview">${money(total)}</strong></p>
          ${priceBook.length ? `<p style="font-size:11.5px;color:var(--muted);margin:4px 0 0;">Pick a line from your <a href="/hs/price-book">price book</a> to fill it in automatically.</p>` : ""}
        </div>
        <div class="form-field full">
          <label for="customer_notes">Customer-visible notes</label>
          <textarea id="customer_notes" name="customer_notes" placeholder="Shown to the client if you share job details">${esc(job.customer_notes)}</textarea>
        </div>
        <div class="form-field full">
          <label for="internal_notes">Internal notes</label>
          <textarea id="internal_notes" name="internal_notes" placeholder="Just for your team">${esc(job.internal_notes)}</textarea>
        </div>
      </div>
      <div class="list-actions">
        <button class="btn" type="submit">Save job</button>
        <a class="btn secondary" href="/hs/clients/${client.id}">Cancel</a>
      </div>
    </form>
    ${jobTotalScript(priceBook)}`;
}

get("/hs/clients/:id/jobs/new", (req, res, params) => {
  const client = hsdb.getClient(req.account.id, params.id);
  if (!client) return notFound(res);
  const properties = hsdb.listPropertiesForClient(client.id);
  const body = jobForm({ client, properties, action: `/hs/clients/${client.id}/jobs`, title: "Add job" });
  sendHtml(res, 200, hsLayout({ account: req.account, title: "Add job", active: "clients", body }));
});

post("/hs/clients/:id/jobs", async (req, res, params) => {
  const client = hsdb.getClient(req.account.id, params.id);
  if (!client) return notFound(res);
  const body = await parseBody(req);
  if (!body.title || !body.title.trim()) return redirect(res, `/hs/clients/${client.id}/jobs/new`);
  const id = hsdb.createJob({ ...body, client_id: client.id, property_id: body.property_id || null, line_items: lineItemsFromBody(body) });
  redirect(res, `/hs/jobs/${id}`);
});

get("/hs/jobs/:id/edit", (req, res, params) => {
  const job = hsdb.getJob(req.account.id, params.id);
  if (!job) return notFound(res);
  const client = hsdb.getClient(req.account.id, job.client_id);
  const properties = hsdb.listPropertiesForClient(client.id);
  const body = jobForm({ job, client, properties, action: `/hs/jobs/${job.id}`, title: "Edit job" });
  sendHtml(res, 200, hsLayout({ account: req.account, title: "Edit job", active: "jobs", body }));
});

post("/hs/jobs/:id", async (req, res, params) => {
  const job = hsdb.getJob(req.account.id, params.id);
  if (!job) return notFound(res);
  const body = await parseBody(req);
  hsdb.updateJob(params.id, { ...body, property_id: body.property_id || null, line_items: lineItemsFromBody(body) });
  redirect(res, `/hs/jobs/${params.id}`);
});

post("/hs/jobs/:id/stage", async (req, res, params) => {
  const job = hsdb.getJob(req.account.id, params.id);
  if (!job) return notFound(res);
  const body = await parseBody(req);
  hsdb.updateJobStage(params.id, body.stage);
  redirect(res, `/hs/jobs/${params.id}`);
});

post("/hs/jobs/:id/delete", (req, res, params) => {
  const job = hsdb.getJob(req.account.id, params.id);
  if (!job) return notFound(res);
  hsdb.deleteJob(params.id);
  redirect(res, `/hs/clients/${job.client_id}`);
});

get("/hs/clients/export.csv", (req, res) => {
  const clients = hsdb.listClients(req.account.id, "").map((c) => ({ ...c, stats: hsdb.clientStats(c.id) }));
  const csv = toCsv(clients, [
    ["Name", "name"],
    ["Type", "client_type"],
    ["Email", "email"],
    ["Phone", "phone"],
    ["Source", "source"],
    ["Lifetime value", (c) => c.stats.lifetimeValue.toFixed(2)],
    ["Job count", (c) => c.stats.jobCount],
    ["Overdue invoices", (c) => c.stats.overdueInvoices],
    ["Notes", "notes"],
  ]);
  sendCsv(res, "hivehub-home-service-clients.csv", csv);
});

get("/hs/clients", (req, res, params, query) => {
  const q = query.get("q") || "";
  const clients = hsdb.listClients(req.account.id, q);
  const rows = clients.length
    ? clients
        .map(
          (c) => `<tr onclick="location.href='/hs/clients/${c.id}'">
        <td>${esc(c.name)}</td>
        <td><span class="badge">${esc(c.client_type)}</span></td>
        <td>${esc(c.email || "—")}</td>
        <td>${esc(c.phone || "—")}</td>
      </tr>`
        )
        .join("")
    : `<tr><td colspan="4"><div class="empty-state">No clients found. <a href="/hs/clients/new">Add your first client</a>.</div></td></tr>`;

  const body = `
    <div class="page-header">
      <div>
        <h1>Clients</h1>
        <p class="subtitle">${clients.length} client${clients.length === 1 ? "" : "s"}</p>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <a class="btn secondary" href="/hs/clients/export.csv">Export CSV</a>
        <a class="btn" href="/hs/clients/new">+ Add client</a>
      </div>
    </div>
    <form class="search-bar" method="get" action="/hs/clients">
      <input type="text" name="q" value="${esc(q)}" placeholder="Search by name, email, or phone..." />
      <button class="btn secondary" type="submit">Search</button>
    </form>
    <div class="card">
      <div class="table-scroll">
      <table class="clickable">
        <thead><tr><th>Name</th><th>Type</th><th>Email</th><th>Phone</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      </div>
    </div>`;

  sendHtml(res, 200, hsLayout({ account: req.account, title: "Clients", active: "clients", body }));
});

function hsClientForm({ client = {}, action, title }) {
  const typeOptions = hsdb.CLIENT_TYPES.map(
    (t) => `<option value="${t}" ${client.client_type === t ? "selected" : ""}>${t[0].toUpperCase() + t.slice(1)}</option>`
  ).join("");
  return `
    <div class="page-header"><h1>${title}</h1></div>
    <form class="card" method="post" action="${action}">
      <div class="form-grid">
        <div class="form-field">
          <label for="name">Full name / business name *</label>
          <input id="name" name="name" required value="${esc(client.name)}" />
        </div>
        <div class="form-field">
          <label for="email">Email</label>
          <input id="email" name="email" type="email" value="${esc(client.email)}" />
        </div>
        <div class="form-field">
          <label for="phone">Phone</label>
          <input id="phone" name="phone" value="${esc(client.phone)}" />
        </div>
        <div class="form-field">
          <label for="client_type">Client type</label>
          <select id="client_type" name="client_type">${typeOptions}</select>
        </div>
        <div class="form-field full">
          <label for="source">How they found you</label>
          <input id="source" name="source" value="${esc(client.source)}" placeholder="e.g. Google, referral, repeat customer" />
        </div>
        <div class="form-field full">
          <label for="notes">Notes</label>
          <textarea id="notes" name="notes">${esc(client.notes)}</textarea>
        </div>
      </div>
      <div class="list-actions">
        <button class="btn" type="submit">Save client</button>
        <a class="btn secondary" href="/hs/clients">Cancel</a>
      </div>
    </form>`;
}

get("/hs/clients/new", (req, res) => {
  sendHtml(res, 200, hsLayout({ account: req.account, title: "Add client", active: "clients", body: hsClientForm({ action: "/hs/clients", title: "Add client" }) }));
});

post("/hs/clients", async (req, res) => {
  const body = await parseBody(req);
  if (!body.name || !body.name.trim()) return redirect(res, "/hs/clients/new");
  const id = hsdb.createClient({ ...body, account_id: req.account.id });
  redirect(res, `/hs/clients/${id}`);
});

get("/hs/clients/:id", (req, res, params, query) => {
  const client = hsdb.getClient(req.account.id, params.id);
  if (!client) return notFound(res);
  const properties = hsdb.listPropertiesForClient(params.id);
  const jobs = hsdb.listJobsForClient(params.id);
  const messages = hsdb.listMessagesForClient(params.id);

  const propertyItems = properties.length
    ? properties
        .map(
          (p) => `
      <div class="policy-item">
        <div>
          <div class="policy-main">${esc(p.label)}</div>
          <div class="policy-meta">${esc(p.address || "No address on file")}${p.access_notes ? ` &middot; ${esc(p.access_notes)}` : ""}</div>
        </div>
        <div style="display:flex;align-items:center;gap:10px;">
          <a class="btn small secondary" href="/hs/properties/${p.id}/edit">Edit</a>
          <form method="post" action="/hs/properties/${p.id}/delete" onsubmit="return confirm('Delete this property?');">
            <button class="btn small danger" type="submit">Delete</button>
          </form>
        </div>
      </div>`
        )
        .join("")
    : `<div class="empty-state">No properties yet for ${esc(client.name)}.</div>`;

  const jobItems = jobs.length
    ? jobs
        .map((j) => {
          const total = hsdb.lineItemsTotal(j.line_items);
          return `
      <div class="policy-item" onclick="location.href='/hs/jobs/${j.id}'" style="cursor:pointer;">
        <div>
          <div class="policy-main">${esc(j.title)} <span class="badge ${j.stage}">${hsdb.JOB_STAGE_LABELS[j.stage]}</span></div>
          <div class="policy-meta">${esc(j.job_type)}${j.property_label ? " · " + esc(j.property_label) : ""}${j.scheduled_date ? " · " + esc(j.scheduled_date) : ""}</div>
        </div>
        <div class="policy-premium">${money(total)}</div>
      </div>`;
        })
        .join("")
    : `<div class="empty-state">No jobs yet for ${esc(client.name)}.</div>`;

  const aiDraft = generateHsAiDraft(client, jobs);
  const templates = [
    { label: "Appointment reminder", subject: "See you soon", body: `Hi ${firstName(client.name)}, just confirming your upcoming appointment with us. Let us know if anything's changed!` },
    { label: "Invoice nudge", subject: "Your invoice", body: `Hi ${firstName(client.name)}, following up on your open invoice — let me know if you have any questions.` },
    { label: "Review ask", subject: "How did we do?", body: `Hi ${firstName(client.name)}, thanks again for choosing us! A quick review would really help our small business.` },
  ];
  function fillBtn(label, subject, msgBody, extraClass) {
    return `<button type="button" class="btn small ${extraClass || "secondary"}" onclick="document.getElementById('msg-subject').value=${esc(
      JSON.stringify(subject)
    )};document.getElementById('msg-body').value=${esc(JSON.stringify(msgBody))};">${esc(label)}</button>`;
  }
  const templateButtons =
    templates.map((t) => fillBtn(t.label, t.subject, t.body)).join("") + fillBtn("AI Draft", aiDraft.subject, aiDraft.body, "ai-draft");

  const messageItems = messages.length
    ? messages
        .map(
          (m) => `
      <div class="policy-item" style="align-items:flex-start;">
        <div>
          <div class="policy-main"><span class="badge ${m.channel}">${m.channel === "email" ? "Email" : "Text"}</span>${m.subject ? ` &middot; ${esc(m.subject)}` : ""}
            <span class="badge ${STATUS_BADGE[m.status] || "pending"}">${STATUS_LABEL[m.status] || esc(m.status)}</span>
          </div>
          <div class="policy-meta" style="white-space:pre-wrap;max-width:460px;">${esc(m.body)}</div>
          ${m.error ? `<div class="policy-meta" style="color:var(--danger);">${esc(m.error)}</div>` : ""}
        </div>
        <div class="policy-meta">${esc(m.created_at)}</div>
      </div>`
        )
        .join("")
    : `<div class="empty-state">No messages yet. Send the first one to ${esc(client.name)} above.</div>`;

  const draftPrefill = query && query.get("draft") === "1";
  const messagesCard = `
    <div class="card" style="margin-top:20px;" id="messages">
      <div class="page-header" style="margin-bottom:6px;">
        <h3 style="margin:0;">Messages</h3>
        <span style="font-size:12px;color:var(--muted);">Email sends for real once you connect a provider (see README) — texting isn't connected yet</span>
      </div>
      <form method="post" action="/hs/clients/${client.id}/messages">
        <div class="form-grid">
          <div class="form-field">
            <label for="channel">Channel</label>
            <select id="channel" name="channel">
              <option value="email">Email</option>
              <option value="sms">Text (SMS)</option>
            </select>
          </div>
          <div class="form-field">
            <label for="msg-subject">Subject <span style="font-weight:400;color:var(--muted);">(email only)</span></label>
            <input id="msg-subject" name="subject" value="${draftPrefill ? esc(aiDraft.subject) : ""}" />
          </div>
          <div class="form-field full">
            <label for="msg-body">Message *</label>
            <textarea id="msg-body" name="body" required placeholder="Write a message to ${esc(client.name)}...">${draftPrefill ? esc(aiDraft.body) : ""}</textarea>
          </div>
        </div>
        <div class="list-actions" style="flex-wrap:wrap;margin-bottom:12px;">${templateButtons}</div>
        <div class="list-actions">
          <button class="btn" type="submit">Send message</button>
        </div>
      </form>
      <form method="post" action="/hs/clients/${client.id}/autopilot">
        <input type="hidden" name="enabled" value="${client.autopilot_enabled ? "1" : "0"}" />
        <label class="autopilot-row">
          <input type="checkbox" ${client.autopilot_enabled ? "checked" : ""} onclick="this.form.enabled.value=this.checked?'1':'0';this.form.submit();" />
          <span><strong>Autopilot</strong> — ${client.autopilot_enabled ? "on: " : ""}let AI send appointment reminders and review asks like these automatically, once there's a concrete trigger (never a generic check-in on its own). ${client.email ? "" : '<span style="color:var(--danger);">Add an email address to this client to enable.</span>'}</span>
        </label>
      </form>
      <h4 style="margin:18px 0 10px;font-size:12px;text-transform:uppercase;letter-spacing:0.05em;color:var(--muted);">History</h4>
      ${messageItems}
    </div>`;

  const addPropertyForm = `
    <form method="post" action="/hs/clients/${client.id}/properties" style="margin-top:12px;padding-top:12px;border-top:1px solid var(--line);">
      <div class="form-grid">
        <div class="form-field">
          <label for="p-label">Property label *</label>
          <input id="p-label" name="label" required placeholder="e.g. Main house, Oak St rental" />
        </div>
        <div class="form-field">
          <label for="p-address">Address</label>
          <input id="p-address" name="address" placeholder="123 Oak St, Springfield" />
        </div>
        <div class="form-field full">
          <label for="p-access">Access notes</label>
          <input id="p-access" name="access_notes" placeholder="e.g. gate code 1234, dog in backyard" />
        </div>
      </div>
      <button class="btn small" type="submit">+ Add property</button>
    </form>`;

  const activityEvents = [
    { ts: client.created_at, title: "Client added", meta: `${client.client_type} · via ${client.source || "unspecified source"}`, color: "var(--muted)" },
  ];
  jobs.forEach((j) => {
    activityEvents.push({ ts: j.created_at, title: `Job created: ${j.title}`, meta: `${j.job_type} · started as ${hsdb.JOB_STAGE_LABELS[j.stage] || j.stage}`, color: "var(--gold)" });
    if (j.updated_at && j.updated_at !== j.created_at) {
      activityEvents.push({ ts: j.updated_at, title: `${j.title} → ${hsdb.JOB_STAGE_LABELS[j.stage] || j.stage}`, meta: "Job updated", color: "var(--gold-dark)" });
    }
  });
  messages.forEach((m) => {
    activityEvents.push({ ts: m.created_at, title: `${m.channel === "email" ? "Email" : "Text"} ${m.status === "sent" ? "sent" : m.status === "failed" ? "failed" : "logged"}${m.subject ? ": " + m.subject : ""}`, meta: (m.body || "").slice(0, 90), color: "var(--charcoal)" });
  });
  const activityCard = `
    <div class="card" style="margin-top:20px;">
      <h3 style="margin-bottom:10px;">Activity</h3>
      ${renderTimeline(activityEvents)}
    </div>`;

  const cstats = hsdb.clientStats(client.id);
  const clientStatGrid = `
    <div class="stat-grid" style="margin-bottom:16px;">
      <div class="stat-card accent">
        <div class="stat-label">Lifetime value</div>
        <div class="stat-value">${money(cstats.lifetimeValue)}</div>
        <div class="stat-foot">Total from paid jobs</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Jobs on file</div>
        <div class="stat-value">${cstats.jobCount}</div>
        <div class="stat-foot">${cstats.completedJobCount} completed or later</div>
      </div>
      <div class="stat-card${cstats.overdueInvoices ? " accent" : ""}">
        <div class="stat-label">Overdue invoices</div>
        <div class="stat-value">${cstats.overdueInvoices}</div>
        <div class="stat-foot">Unpaid ${hsdb.OVERDUE_INVOICE_DAYS}+ days</div>
      </div>
    </div>`;

  const body = `
    <div class="breadcrumb"><a href="/hs/clients">Clients</a> / ${esc(client.name)}</div>
    <div class="page-header">
      <div>
        <h1>${esc(client.name)} <span class="badge" style="vertical-align:middle;font-size:11px;">${esc(client.client_type)}</span></h1>
        <p class="subtitle">${esc(client.email || "")}${client.email && client.phone ? " · " : ""}${esc(client.phone || "")}</p>
      </div>
      <div class="list-actions">
        <a class="btn secondary" href="/hs/clients/${client.id}/edit">Edit client</a>
        <form method="post" action="/hs/clients/${client.id}/delete" onsubmit="return confirm('Delete ${esc(client.name)} and all their properties and jobs?');">
          <button class="btn danger" type="submit">Delete</button>
        </form>
      </div>
    </div>

    ${clientStatGrid}

    <div class="two-col">
      <div>
        <div class="page-header" style="margin-bottom:12px;">
          <h3 style="margin:0;">Jobs</h3>
          <a class="btn small" href="/hs/clients/${client.id}/jobs/new">+ Add job</a>
        </div>
        ${jobItems}
      </div>
      <div class="card">
        <h3 style="margin-bottom:10px;">Properties</h3>
        ${propertyItems}
        ${addPropertyForm}
      </div>
    </div>
    ${
      client.source || client.notes
        ? `<div class="card" style="margin-top:20px;"><h3 style="margin-bottom:10px;">Notes</h3><p style="font-size:14px;color:var(--ink-soft);white-space:pre-wrap;">${esc(
            client.source ? `Source: ${client.source}\n\n` : ""
          )}${esc(client.notes || "")}</p></div>`
        : ""
    }
    ${activityCard}
    ${messagesCard}`;

  const msgFlag = query && query.get("msg");
  const flash =
    msgFlag === "sent"
      ? "Email sent."
      : msgFlag === "failed"
      ? "Couldn't send that email — see the error under the message below."
      : msgFlag === "logged"
      ? "Message logged (not delivered — connect an email provider to send for real; see README)."
      : null;

  sendHtml(res, 200, hsLayout({ account: req.account, title: client.name, active: "clients", flash, body }));
});

get("/hs/clients/:id/edit", (req, res, params) => {
  const client = hsdb.getClient(req.account.id, params.id);
  if (!client) return notFound(res);
  const body = hsClientForm({ client, action: `/hs/clients/${client.id}`, title: `Edit ${client.name}` });
  sendHtml(res, 200, hsLayout({ account: req.account, title: "Edit client", active: "clients", body }));
});

post("/hs/clients/:id", async (req, res, params) => {
  const client = hsdb.getClient(req.account.id, params.id);
  if (!client) return notFound(res);
  const body = await parseBody(req);
  hsdb.updateClient(params.id, body);
  redirect(res, `/hs/clients/${params.id}`);
});

post("/hs/clients/:id/delete", (req, res, params) => {
  hsdb.deleteClient(req.account.id, params.id);
  redirect(res, "/hs/clients");
});

post("/hs/clients/:id/messages", async (req, res, params) => {
  const client = hsdb.getClient(req.account.id, params.id);
  if (!client) return notFound(res);
  const body = await parseBody(req);
  if (!body.body || !body.body.trim()) return redirect(res, `/hs/clients/${params.id}`);
  const channel = body.channel === "sms" ? "sms" : "email";
  const outcome = await sendAndLogMessage(hsdb, client, { channel, subject: body.subject, body: body.body });
  const flag = outcome.ok ? "sent" : outcome.skipped ? "logged" : "failed";
  redirect(res, `/hs/clients/${params.id}?msg=${flag}`);
});

post("/hs/clients/:id/autopilot", async (req, res, params) => {
  const client = hsdb.getClient(req.account.id, params.id);
  if (!client) return notFound(res);
  const body = await parseBody(req);
  hsdb.setAutopilotEnabled(client.id, body.enabled === "1");
  redirect(res, `/hs/clients/${params.id}#messages`);
});

post("/hs/clients/:id/properties", async (req, res, params) => {
  const client = hsdb.getClient(req.account.id, params.id);
  if (!client) return notFound(res);
  const body = await parseBody(req);
  if (!body.label || !body.label.trim()) return redirect(res, `/hs/clients/${params.id}`);
  hsdb.createProperty({ ...body, client_id: client.id });
  redirect(res, `/hs/clients/${params.id}`);
});

function propertyForm({ property = {}, client, action, title }) {
  return `
    <div class="breadcrumb"><a href="/hs/clients">Clients</a> / <a href="/hs/clients/${client.id}">${esc(client.name)}</a> / ${title}</div>
    <div class="page-header"><h1>${title}</h1></div>
    <form class="card" method="post" action="${action}">
      <div class="form-grid">
        <div class="form-field">
          <label for="label">Property label *</label>
          <input id="label" name="label" required value="${esc(property.label)}" />
        </div>
        <div class="form-field">
          <label for="address">Address</label>
          <input id="address" name="address" value="${esc(property.address)}" />
        </div>
        <div class="form-field full">
          <label for="access_notes">Access notes</label>
          <input id="access_notes" name="access_notes" value="${esc(property.access_notes)}" />
        </div>
      </div>
      <div class="list-actions">
        <button class="btn" type="submit">Save property</button>
        <a class="btn secondary" href="/hs/clients/${client.id}">Cancel</a>
      </div>
    </form>`;
}

get("/hs/properties/:id/edit", (req, res, params) => {
  const property = hsdb.getProperty(req.account.id, params.id);
  if (!property) return notFound(res);
  const client = hsdb.getClient(req.account.id, property.client_id);
  const body = propertyForm({ property, client, action: `/hs/properties/${property.id}`, title: "Edit property" });
  sendHtml(res, 200, hsLayout({ account: req.account, title: "Edit property", active: "clients", body }));
});

post("/hs/properties/:id", async (req, res, params) => {
  const property = hsdb.getProperty(req.account.id, params.id);
  if (!property) return notFound(res);
  const body = await parseBody(req);
  hsdb.updateProperty(params.id, body);
  redirect(res, `/hs/clients/${property.client_id}`);
});

post("/hs/properties/:id/delete", (req, res, params) => {
  const property = hsdb.getProperty(req.account.id, params.id);
  if (!property) return notFound(res);
  hsdb.deleteProperty(params.id);
  redirect(res, `/hs/clients/${property.client_id}`);
});

function priceBookForm({ item = {}, action, title }) {
  const unitOptions = hsdb.PRICE_BOOK_UNITS
    .map((u) => `<option value="${u}" ${item.unit === u ? "selected" : ""}>${hsdb.PRICE_BOOK_UNIT_LABELS[u]}</option>`)
    .join("");
  return `
    <div class="breadcrumb"><a href="/hs/price-book">Price Book</a> / ${title}</div>
    <div class="page-header"><h1>${title}</h1></div>
    <form class="card" method="post" action="${action}">
      <div class="form-grid">
        <div class="form-field full">
          <label for="name">Service name *</label>
          <input id="name" name="name" required value="${esc(item.name)}" placeholder="e.g. Drain cleaning" />
        </div>
        <div class="form-field">
          <label for="default_price">Default price *</label>
          <input id="default_price" name="default_price" type="number" step="0.01" min="0" required value="${item.default_price ?? ""}" />
        </div>
        <div class="form-field">
          <label for="unit">Billed</label>
          <select id="unit" name="unit">${unitOptions}</select>
        </div>
        <div class="form-field full">
          <label for="description">Description</label>
          <textarea id="description" name="description" placeholder="What's included, for your own reference">${esc(item.description)}</textarea>
        </div>
      </div>
      <div class="list-actions">
        <button class="btn" type="submit">Save</button>
        <a class="btn secondary" href="/hs/price-book">Cancel</a>
      </div>
    </form>`;
}

get("/hs/price-book", (req, res) => {
  const items = hsdb.listPriceBook(req.account.id);
  const rows = items.length
    ? items
        .map(
          (p) => `
      <div class="policy-item">
        <div>
          <div class="policy-main">${esc(p.name)}</div>
          <div class="policy-meta">${esc(p.description || "No description")}</div>
        </div>
        <div style="display:flex;align-items:center;gap:10px;">
          <div class="policy-premium">${money(p.default_price)}${p.unit === "hour" ? "/hr" : ""}</div>
          <a class="btn small secondary" href="/hs/price-book/${p.id}/edit">Edit</a>
          <form method="post" action="/hs/price-book/${p.id}/delete" onsubmit="return confirm('Delete this service from your price book?');">
            <button class="btn small danger" type="submit">Delete</button>
          </form>
        </div>
      </div>`
        )
        .join("")
    : `<div class="empty-state">No services yet. Add your standard rates below so job estimates fill in automatically.</div>`;

  const body = `
    <div class="page-header">
      <div>
        <h1>Price Book</h1>
        <p class="subtitle">Your standard services and rates — pick from these when you build out a job's line items</p>
      </div>
      <a class="btn" href="/hs/price-book/new">+ Add service</a>
    </div>
    <div class="card">${rows}</div>`;

  sendHtml(res, 200, hsLayout({ account: req.account, title: "Price Book", active: "price-book", body }));
});

get("/hs/price-book/new", (req, res) => {
  sendHtml(res, 200, hsLayout({ account: req.account, title: "Add service", active: "price-book", body: priceBookForm({ action: "/hs/price-book", title: "Add service" }) }));
});

post("/hs/price-book", async (req, res) => {
  const body = await parseBody(req);
  if (!body.name || !body.name.trim()) return redirect(res, "/hs/price-book/new");
  hsdb.createPriceBookItem({ ...body, account_id: req.account.id });
  redirect(res, "/hs/price-book");
});

get("/hs/price-book/:id/edit", (req, res, params) => {
  const item = hsdb.getPriceBookItem(req.account.id, params.id);
  if (!item) return notFound(res);
  const body = priceBookForm({ item, action: `/hs/price-book/${item.id}`, title: "Edit service" });
  sendHtml(res, 200, hsLayout({ account: req.account, title: "Edit service", active: "price-book", body }));
});

post("/hs/price-book/:id", async (req, res, params) => {
  const item = hsdb.getPriceBookItem(req.account.id, params.id);
  if (!item) return notFound(res);
  const body = await parseBody(req);
  hsdb.updatePriceBookItem(req.account.id, params.id, body);
  redirect(res, "/hs/price-book");
});

post("/hs/price-book/:id/delete", (req, res, params) => {
  hsdb.deletePriceBookItem(req.account.id, params.id);
  redirect(res, "/hs/price-book");
});

get("/hs/messages", (req, res) => {
  const jobs = hsdb.listOpenJobsWithClients(req.account.id);
  const suggestionMap = new Map();
  jobs.forEach((j) => {
    const days = daysFromToday(j.scheduled_date);
    let urgency = null;
    let reason = "";
    if (j.stage === "scheduled" && days !== null && days >= 0 && days <= 2) {
      urgency = 0;
      reason = `"${j.title}" scheduled ${days === 0 ? "today" : "in " + days + "d"}`;
    } else if (j.stage === "completed") {
      urgency = 1;
      reason = `"${j.title}" completed — not yet invoiced`;
    } else if (j.stage === "invoiced") {
      const updated = new Date(String(j.updated_at).replace(" ", "T") + "Z").getTime();
      const daysSinceInvoiced = Number.isNaN(updated) ? 0 : Math.floor((Date.now() - updated) / 86400000);
      if (daysSinceInvoiced >= hsdb.OVERDUE_INVOICE_DAYS) {
        urgency = -1;
        reason = `"${j.title}" invoiced ${daysSinceInvoiced}d ago — payment overdue`;
      } else {
        urgency = 2;
        reason = `"${j.title}" invoiced — payment pending`;
      }
    } else if (j.stage === "paid") {
      urgency = 3;
      reason = `"${j.title}" paid — good time to ask for a review`;
    } else {
      return;
    }
    const existing = suggestionMap.get(j.client_id);
    if (!existing || urgency < existing.urgency) {
      suggestionMap.set(j.client_id, { client_id: j.client_id, client_name: j.client_name, reason, urgency });
    }
  });
  const suggestions = Array.from(suggestionMap.values()).sort((a, b) => a.urgency - b.urgency).slice(0, 8);

  const suggestionRows = suggestions.length
    ? suggestions
        .map(
          (s) => `
      <div class="policy-item">
        <div>
          <div class="policy-main">${esc(s.client_name)}</div>
          <div class="policy-meta">${esc(s.reason)}</div>
        </div>
        <a class="btn small ai-draft" href="/hs/clients/${s.client_id}?draft=1#messages">Start conversation</a>
      </div>`
        )
        .join("")
    : `<p style="color:var(--muted);font-size:13px;">No jobs need outreach right now.</p>`;

  const recent = hsdb.listRecentMessages(req.account.id, 15);
  const recentRows = recent.length
    ? recent
        .map((m) => {
          const snippet = (m.body || "").length > 90 ? m.body.slice(0, 90) + "…" : m.body || "";
          return `
      <div class="policy-item" style="align-items:flex-start;">
        <div>
          <div class="policy-main">
            <a href="/hs/clients/${m.client_id}#messages" style="color:inherit;">${esc(m.client_name)}</a>
            <span class="badge ${m.channel}">${m.channel === "email" ? "Email" : "Text"}</span>
            <span class="badge ${STATUS_BADGE[m.status] || "pending"}">${STATUS_LABEL[m.status] || esc(m.status)}</span>
          </div>
          <div class="policy-meta" style="max-width:460px;">${m.subject ? `${esc(m.subject)} — ` : ""}${esc(snippet)}</div>
        </div>
        <div class="policy-meta">${esc(m.created_at)}</div>
      </div>`;
        })
        .join("")
    : `<div class="empty-state">No conversations yet. Use a suggestion, or open any client to send the first message.</div>`;

  const body = `
    <div class="page-header">
      <div>
        <h1>Communication</h1>
        <p class="subtitle">AI helps you find who to talk to and drafts it — you hit send</p>
      </div>
    </div>
    ${renderAutopilotPanel(hsdb.listAutopilotEnabledClients(req.account.id).length, hsdb.listClients(req.account.id).length)}
    <div class="card" style="margin-bottom:20px;">
      <h3 style="margin-bottom:6px;">Start a conversation</h3>
      <p style="margin:0 0 12px;font-size:13px;color:var(--muted);">Search for a client to open their thread with an AI draft ready to go.</p>
      ${renderClientSearchPicker(hsdb.listClients(req.account.id), "/hs/clients")}
    </div>
    <div class="two-col">
      <div class="card">
        <h3 style="margin-bottom:4px;">AI suggests reaching out to</h3>
        <p style="margin:0 0 12px;font-size:12px;color:var(--muted);">Based on jobs that are scheduled soon, completed, invoiced, or just paid</p>
        ${suggestionRows}
      </div>
      <div class="card">
        <h3 style="margin-bottom:4px;">Recent conversations</h3>
        <p style="margin:0 0 12px;font-size:12px;color:var(--muted);">Across all your clients</p>
        ${recentRows}
      </div>
    </div>`;

  sendHtml(res, 200, hsLayout({ account: req.account, title: "Communication", active: "messages", body }));
});

// ================= Construction CRM =================

const CON_NAV = [
  { href: "/co", label: "Dashboard", key: "dashboard" },
  { href: "/co/projects", label: "Projects", key: "projects" },
  { href: "/co/projects/pipeline", label: "Pipeline", key: "pipeline" },
  { href: "/co/map", label: "Map", key: "map" },
  { href: "/co/clients", label: "Clients", key: "clients" },
  { href: "/co/messages", label: "Communication", key: "messages" },
];
const CON_TAGLINE = "Client, project, and change-order management for builders and contractors.";

// Marker colors for the /co/map page — mirrors the .badge.<phase> palette
// used everywhere else, just as hex since these get embedded into a
// Leaflet circleMarker's fillColor rather than a CSS class.
const CON_MAP_PHASE_COLORS = {
  lead: "#b39257",
  estimating: "#2757b0",
  contract_signed: "#6a3ec7",
  permitting: "#9c7a44",
  in_progress: "#6a3ec7",
  punch_list: "#1f6d6d",
  complete: "#2f7a34",
  on_hold: "#6b6255",
};

function conLayout(opts) {
  return layout({ ...opts, nav: CON_NAV, tagline: CON_TAGLINE, brandHref: "/co" });
}

// Signed day difference between today and a YYYY-MM-DD date string.
function conDaysFromToday(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr + "T00:00:00");
  if (isNaN(d.getTime())) return null;
  const today = new Date();
  const todayMid = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.round((d - todayMid) / 86400000);
}

// Rule-based AI draft for the Construction vertical — same honest pattern as
// the other two verticals: a handful of concrete, explainable triggers, never
// a real LLM call. Each branch carries a dedupe `key` for Autopilot; the
// generic fallback has `key: null` so Autopilot never auto-sends it.
function generateConAiDraft(client, projects) {
  const fn = firstName(client.name);
  const openProjects = projects.filter((p) => p.phase !== "on_hold");

  const wrappingSoon = openProjects
    .filter((p) => ["in_progress", "punch_list"].includes(p.phase) && p.target_date)
    .map((p) => ({ project: p, days: conDaysFromToday(p.target_date) }))
    .filter((x) => x.days !== null && x.days >= 0 && x.days <= 7)
    .sort((a, b) => a.days - b.days)[0];
  if (wrappingSoon) {
    const p = wrappingSoon.project;
    return {
      subject: `${p.title} — wrapping up soon`,
      body: `Hi ${fn}, just a heads up that we're targeting ${p.target_date} to wrap up "${p.title}". Let me know if you'd like to walk the site before then, or if anything's come up on your end.`,
      key: `project:${p.id}:wrap_reminder`,
    };
  }

  for (const p of openProjects) {
    const pendingCOs = condb.listChangeOrdersForProject(p.id).filter((co) => co.status === "pending");
    if (pendingCOs.length) {
      const co = pendingCOs[0];
      return {
        subject: `Change order awaiting your approval — ${p.title}`,
        body: `Hi ${fn}, there's a change order on "${p.title}" waiting on your approval: "${co.description}" (${money(co.amount)}). Let me know if you'd like to discuss it or if you're good to approve.`,
        key: `project:${p.id}:co:${co.id}:pending`,
      };
    }
  }

  const justCompleted = projects.find((p) => p.phase === "complete");
  if (justCompleted) {
    return {
      subject: `${justCompleted.title} is complete!`,
      body: `Hi ${fn}, we've wrapped "${justCompleted.title}" — it was a pleasure working on it with you. If you have a minute, a quick review would mean a lot to us, and let us know if any punch-list items need a second look.`,
      key: `project:${justCompleted.id}:review_ask`,
    };
  }

  return {
    subject: "Checking in",
    body: `Hi ${fn}, just checking in — anything coming up on your property we could help plan for? Happy to talk through it whenever's convenient.`,
    key: null,
  };
}

get("/co", (req, res) => {
  const stats = condb.dashboardStats(req.account.id);
  const maxPhase = Math.max(1, ...condb.PROJECT_PHASES.map((p) => stats.phaseCounts[p] || 0));
  const phaseRows = condb.PROJECT_PHASES.map((p) => {
    const count = stats.phaseCounts[p] || 0;
    return `
      <div style="margin-bottom:10px;">
        <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:4px;">
          <span><strong>${condb.PROJECT_PHASE_LABELS[p]}</strong></span>
          <span>${count}</span>
        </div>
        <div style="background:#f1e7cb;border-radius:6px;height:8px;overflow:hidden;">
          <div style="background:var(--gold);height:100%;width:${(count / maxPhase) * 100}%;"></div>
        </div>
      </div>`;
  }).join("");

  const recentRows = stats.recentClients.length
    ? stats.recentClients
        .map((c) => `<tr onclick="location.href='/co/clients/${c.id}'"><td>${esc(c.name)}</td><td>${esc(c.email || "—")}</td><td>${esc(c.phone || "—")}</td></tr>`)
        .join("")
    : `<tr><td colspan="3" class="empty-state">No clients yet.</td></tr>`;

  const targetSoonRows = stats.targetSoon.length
    ? stats.targetSoon
        .map((p) => `<tr onclick="location.href='/co/projects/${p.id}'"><td>${esc(p.client_name)}</td><td>${esc(p.title)}</td><td>${esc(p.target_date)}</td></tr>`)
        .join("")
    : "";

  const body = `
    <div class="page-header">
      <div>
        <h1>Dashboard</h1>
        <p class="subtitle">Your construction business at a glance</p>
      </div>
      <a class="btn" href="/co/clients/new">+ Add client</a>
    </div>

    <div class="stat-grid">
      <div class="stat-card accent">
        <div class="stat-label">Active projects</div>
        <div class="stat-value">${stats.activeProjects}</div>
        <div class="stat-foot">Not yet complete</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Pipeline value</div>
        <div class="stat-value">${money(stats.pipelineValue)}</div>
        <div class="stat-foot">Budgets of open projects</div>
      </div>
      <div class="stat-card${stats.pendingChangeOrders ? " accent" : ""}">
        <div class="stat-label">Pending change orders</div>
        <div class="stat-value">${stats.pendingChangeOrders}</div>
        <div class="stat-foot">Awaiting client approval</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Total clients</div>
        <div class="stat-value">${stats.totalClients}</div>
        <div class="stat-foot">${stats.totalProjects} project${stats.totalProjects === 1 ? "" : "s"} total</div>
      </div>
    </div>

    <div class="two-col">
      <div class="card">
        <h3 style="margin-bottom:14px;">Clients</h3>
        <div class="table-scroll">
        <table class="clickable">
          <thead><tr><th>Name</th><th>Email</th><th>Phone</th></tr></thead>
          <tbody>${recentRows}</tbody>
        </table>
        </div>
        <div style="margin-top:14px;"><a class="btn ghost" href="/co/clients" style="border:1px solid var(--line);">View all clients →</a></div>
      </div>
      <div class="card">
        <h3 style="margin-bottom:14px;">Projects by phase</h3>
        ${phaseRows}
        <div style="margin-top:10px;"><a class="btn ghost" href="/co/projects" style="border:1px solid var(--line);">View all projects →</a></div>
      </div>
    </div>

    ${
      stats.targetSoon.length
        ? `<div class="card" style="margin-top:16px;">
        <h3 style="margin-bottom:14px;">Wrapping up in the next 2 weeks</h3>
        <div class="table-scroll">
        <table class="clickable">
          <thead><tr><th>Client</th><th>Project</th><th>Target date</th></tr></thead>
          <tbody>${targetSoonRows}</tbody>
        </table>
        </div>
      </div>`
        : ""
    }`;

  sendHtml(res, 200, conLayout({ account: req.account, title: "Construction Dashboard", active: "dashboard", body }));
});

get("/co/projects/export.csv", (req, res) => {
  const projects = condb.listAllProjects(req.account.id, {});
  const csv = toCsv(projects, [
    ["Title", "title"],
    ["Client", "client_name"],
    ["Type", "project_type"],
    ["Phase", (p) => condb.PROJECT_PHASE_LABELS[p.phase] || p.phase],
    ["Budget", (p) => p.budget.toFixed(2)],
    ["Project manager", "project_manager"],
    ["Address", "address"],
    ["Start date", "start_date"],
    ["Target date", "target_date"],
  ]);
  sendCsv(res, "hivehub-construction-projects.csv", csv);
});

get("/co/projects/pipeline", (req, res) => {
  const projects = condb.listAllProjects(req.account.id, {});
  const byPhase = {};
  condb.PROJECT_PHASES.forEach((p) => (byPhase[p] = []));
  projects.forEach((p) => {
    (byPhase[p.phase] = byPhase[p.phase] || []).push(p);
  });

  const columns = condb.PROJECT_PHASES.map((ph) => {
    const phaseProjects = byPhase[ph] || [];
    const cards = phaseProjects.length
      ? phaseProjects
          .map(
            (p) => `
        <a href="/co/projects/${p.id}" class="kanban-card">
          <div class="kanban-card-name">${esc(p.title)}</div>
          <div class="kanban-card-meta">${esc(p.client_name)} · ${money(p.budget)}</div>
          ${p.target_date ? `<div class="kanban-card-followup">Target ${esc(p.target_date)}</div>` : ""}
        </a>`
          )
          .join("")
      : `<div class="kanban-empty">No projects</div>`;
    return `
      <div class="kanban-col">
        <div class="kanban-col-head"><span>${condb.PROJECT_PHASE_LABELS[ph]}</span><span class="kanban-count">${phaseProjects.length}</span></div>
        <div class="kanban-col-body">${cards}</div>
      </div>`;
  }).join("");

  const body = `
    <div class="page-header">
      <div>
        <h1>Pipeline</h1>
        <p class="subtitle">${projects.length} project${projects.length === 1 ? "" : "s"} across every phase</p>
      </div>
      <a class="btn secondary" href="/co/projects">Table view</a>
    </div>
    <div class="kanban-scroll"><div class="kanban-board">${columns}</div></div>
    <p style="font-size:12px;color:var(--muted);margin-top:14px;">Change a project's phase from its own page — this board is read-only for now (no drag-and-drop yet).</p>`;

  sendHtml(res, 200, conLayout({ account: req.account, title: "Pipeline", active: "pipeline", body }));
});

// A real, literal map — OpenStreetMap tiles via Leaflet (both loaded from
// cdnjs), not the illustrative site-plan sketch used in the earlier demo
// artifact. This is a genuine web page served by this Node app and opened in
// the user's own browser, so it isn't subject to that artifact preview's CSP
// sandbox — it just needs the user's browser to have normal internet access,
// same as any map on any website. No API key needed: OpenStreetMap's tiles
// are free to use. Markers use circleMarker (color = phase) instead of the
// default Leaflet pin icon so there's no marker-icon.png path to worry about.
get("/co/map", (req, res) => {
  const projects = condb.listProjectsWithCoords(req.account.id);
  const totalProjects = condb.listAllProjects(req.account.id, {}).length;
  const mapData = projects.map((p) => ({ id: p.id, lat: p.lat, lng: p.lng, phase: p.phase, title: p.title, client_name: p.client_name }));

  const legendItems =
    condb.PROJECT_PHASES.concat(condb.PROJECT_SIDE_PHASES)
      .map(
        (p) => `
      <span style="display:inline-flex;align-items:center;margin:0 14px 6px 0;font-size:11.5px;color:var(--ink-soft);">
        <span style="width:11px;height:11px;border-radius:50%;display:inline-block;margin-right:6px;background:${CON_MAP_PHASE_COLORS[p] || "#9c7a44"};"></span>${condb.PROJECT_PHASE_LABELS[p]}
      </span>`
      )
      .join("") +
    `<span style="display:inline-flex;align-items:center;margin:0 14px 6px 0;font-size:11.5px;color:var(--muted);">Click anywhere on the map to add a client there</span>`;

  const body = `
    <div class="page-header">
      <div>
        <h1>Map</h1>
        <p class="subtitle">Every project with a pinned location — click anywhere to drop a new client and project there</p>
      </div>
      <a class="btn secondary" href="/co/projects">Table view</a>
    </div>
    ${
      projects.length < totalProjects
        ? `<p style="font-size:12px;color:var(--muted);margin:-8px 0 14px;">${totalProjects - projects.length} project(s) don't have a location set yet — add one from the project's edit page, or from here.</p>`
        : ""
    }
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css" />
    <div class="card" style="padding:0;overflow:hidden;">
      <div style="padding:14px 17px 0;">${legendItems}</div>
      <div id="con-map" style="height:560px;"></div>
    </div>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js"></script>
    <script>
      (function () {
        var mapEl = document.getElementById("con-map");
        if (typeof L === "undefined") {
          mapEl.innerHTML = '<div class="empty-state" style="padding:40px 20px;">The map tiles couldn\\'t load — this page needs internet access to reach OpenStreetMap and cdnjs.cloudflare.com. Everything else in the app works offline.</div>';
          return;
        }
        var projects = ${JSON.stringify(mapData)};
        var colors = ${JSON.stringify(CON_MAP_PHASE_COLORS)};
        function esc(s) { return String(s == null ? "" : s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }

        var center = projects.length ? [projects[0].lat, projects[0].lng] : [38.63, -90.45];
        var map = L.map("con-map").setView(center, projects.length ? 10 : 9);

        L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
          maxZoom: 19,
          attribution: "&copy; <a href=\\"https://www.openstreetmap.org/copyright\\">OpenStreetMap</a> contributors"
        }).addTo(map);

        var bounds = [];
        projects.forEach(function (p) {
          bounds.push([p.lat, p.lng]);
          var marker = L.circleMarker([p.lat, p.lng], {
            radius: 9, color: "#fff", weight: 2, fillColor: colors[p.phase] || "#9c7a44", fillOpacity: 0.95
          }).addTo(map);
          marker.bindPopup(
            "<strong>" + esc(p.title) + "</strong><br>" + esc(p.client_name) +
            "<br><a href=\\"/co/projects/" + p.id + "\\">Open project &rarr;</a>"
          );
        });
        if (bounds.length > 1) map.fitBounds(bounds, { padding: [40, 40] });

        map.on("click", function (e) {
          var lat = e.latlng.lat.toFixed(6), lng = e.latlng.lng.toFixed(6);
          var html =
            '<form method="post" action="/co/map/add" style="min-width:210px;font-family:inherit;">' +
              '<input type="hidden" name="lat" value="' + lat + '" />' +
              '<input type="hidden" name="lng" value="' + lng + '" />' +
              '<div style="margin-bottom:6px;"><label style="font-size:11px;font-weight:700;display:block;margin-bottom:2px;">Client name</label>' +
                '<input name="name" required style="width:100%;box-sizing:border-box;padding:6px 8px;border:1px solid #ccc;border-radius:6px;font-size:13px;" /></div>' +
              '<div style="margin-bottom:8px;"><label style="font-size:11px;font-weight:700;display:block;margin-bottom:2px;">Project title</label>' +
                '<input name="title" required style="width:100%;box-sizing:border-box;padding:6px 8px;border:1px solid #ccc;border-radius:6px;font-size:13px;" /></div>' +
              '<button type="submit" style="width:100%;padding:7px;border-radius:6px;border:none;background:#9c7a44;color:#fff;font-weight:700;cursor:pointer;font-size:13px;">+ Add client here</button>' +
            '</form>';
          L.popup({ maxWidth: 260 }).setLatLng(e.latlng).setContent(html).openOn(map);
        });
      })();
    </script>`;

  sendHtml(res, 200, conLayout({ account: req.account, title: "Map", active: "map", body }));
});

post("/co/map/add", async (req, res) => {
  const body = await parseBody(req);
  const name = (body.name || "").trim();
  const title = (body.title || "").trim();
  const lat = Number(body.lat);
  const lng = Number(body.lng);
  if (!name || !title || !Number.isFinite(lat) || !Number.isFinite(lng)) return redirect(res, "/co/map");
  const clientId = condb.createClient({ account_id: req.account.id, name, email: "", phone: "", source: "Map", notes: "" });
  const projectId = condb.createProject({
    client_id: clientId,
    title,
    address: "",
    project_type: "Other",
    budget: 0,
    project_manager: "",
    phase: "lead",
    start_date: null,
    target_date: null,
    notes: "",
    lat,
    lng,
  });
  redirect(res, `/co/projects/${projectId}`);
});

get("/co/projects", (req, res, params, query) => {
  const phase = query.get("phase") || "";
  const pm = query.get("pm") || "";
  const q = query.get("q") || "";
  const projects = condb.listAllProjects(req.account.id, { phase, pm, search: q });
  const pms = condb.listAssignedPMs(req.account.id);

  const qs = (overrides) => {
    const p = new URLSearchParams({ phase, pm, q });
    Object.entries(overrides).forEach(([k, v]) => (v ? p.set(k, v) : p.delete(k)));
    const s = p.toString();
    return s ? `?${s}` : "";
  };

  const phasePills = [`<a class="toggle-pill${phase === "" ? " active" : ""}" href="/co/projects${qs({ phase: "" })}">All</a>`]
    .concat(
      condb.PROJECT_PHASES.concat(condb.PROJECT_SIDE_PHASES).map(
        (p) => `<a class="toggle-pill${phase === p ? " active" : ""}" href="/co/projects${qs({ phase: p })}">${condb.PROJECT_PHASE_LABELS[p]}</a>`
      )
    )
    .join("");

  const pmOptions = [`<option value="">All PMs</option>`]
    .concat(pms.map((t) => `<option value="${esc(t)}" ${pm === t ? "selected" : ""}>${esc(t)}</option>`))
    .join("");

  const rows = projects.length
    ? projects
        .map(
          (p) => `<tr onclick="location.href='/co/projects/${p.id}'">
        <td>${esc(p.title)}</td>
        <td>${esc(p.client_name)}</td>
        <td><span class="badge ${p.phase}">${condb.PROJECT_PHASE_LABELS[p.phase] || p.phase}</span></td>
        <td>${money(p.budget)}</td>
        <td>${esc(p.project_manager || "—")}</td>
        <td>${esc(p.target_date || "—")}</td>
      </tr>`
        )
        .join("")
    : `<tr><td colspan="6"><div class="empty-state">No projects found. <a href="/co/projects/new">Add one</a>.</div></td></tr>`;

  const body = `
    <div class="page-header">
      <div>
        <h1>Projects</h1>
        <p class="subtitle">${projects.length} project${projects.length === 1 ? "" : "s"}</p>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <a class="btn secondary" href="/co/map">Map view</a>
        <a class="btn secondary" href="/co/projects/export.csv">Export CSV</a>
        <a class="btn" href="/co/projects/new">+ Add project</a>
      </div>
    </div>
    <form method="get" action="/co/projects" style="display:flex;gap:10px;margin-bottom:14px;flex-wrap:wrap;align-items:center;">
      <input type="hidden" name="phase" value="${esc(phase)}" />
      <input type="text" name="q" value="${esc(q)}" placeholder="Search by project, client, or address..." style="flex:1;min-width:180px;" />
      <select name="pm" onchange="this.form.submit()" style="min-width:150px;">${pmOptions}</select>
      <button class="btn secondary" type="submit">Search</button>
    </form>
    <div class="toggle-group toggle-group-scroll" style="margin-bottom:14px;">${phasePills}</div>
    <div class="card">
      <div class="table-scroll">
      <table class="clickable">
        <thead><tr><th>Project</th><th>Client</th><th>Phase</th><th>Budget</th><th>PM</th><th>Target date</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      </div>
    </div>`;

  sendHtml(res, 200, conLayout({ account: req.account, title: "Projects", active: "projects", body }));
});

function conProjectForm({ project = {}, clients, action, title }) {
  const clientOptions = clients
    .map((c) => `<option value="${c.id}" ${String(project.client_id) === String(c.id) ? "selected" : ""}>${esc(c.name)}</option>`)
    .join("");
  const typeOptions = condb.PROJECT_TYPES.map((t) => `<option value="${t}" ${project.project_type === t ? "selected" : ""}>${t}</option>`).join("");
  const phaseOptions = condb.PROJECT_PHASES.concat(condb.PROJECT_SIDE_PHASES)
    .map((p) => `<option value="${p}" ${project.phase === p ? "selected" : ""}>${condb.PROJECT_PHASE_LABELS[p]}</option>`)
    .join("");
  return `
    <div class="page-header"><h1>${title}</h1></div>
    <form class="card" method="post" action="${action}">
      <div class="form-grid">
        <div class="form-field">
          <label for="client_id">Client *</label>
          <select id="client_id" name="client_id" required>${clientOptions}</select>
        </div>
        <div class="form-field">
          <label for="title">Project title *</label>
          <input id="title" name="title" required value="${esc(project.title)}" placeholder="e.g. Kitchen remodel" />
        </div>
        <div class="form-field">
          <label for="project_type">Project type</label>
          <select id="project_type" name="project_type">${typeOptions}</select>
        </div>
        <div class="form-field">
          <label for="phase">Phase</label>
          <select id="phase" name="phase">${phaseOptions}</select>
        </div>
        <div class="form-field">
          <label for="budget">Budget</label>
          <input id="budget" name="budget" type="number" step="0.01" min="0" value="${project.budget ?? ""}" />
        </div>
        <div class="form-field">
          <label for="project_manager">Project manager</label>
          <input id="project_manager" name="project_manager" value="${esc(project.project_manager)}" placeholder="e.g. Marco" />
        </div>
        <div class="form-field">
          <label for="start_date">Start date</label>
          <input id="start_date" name="start_date" type="date" value="${esc(project.start_date)}" />
        </div>
        <div class="form-field">
          <label for="target_date">Target completion date</label>
          <input id="target_date" name="target_date" type="date" value="${esc(project.target_date)}" />
        </div>
        <div class="form-field full">
          <label for="address">Job site address</label>
          <input id="address" name="address" value="${esc(project.address)}" />
        </div>
        <div class="form-field">
          <label for="lat">Latitude <span style="font-weight:400;color:var(--muted);">(optional)</span></label>
          <input id="lat" name="lat" type="number" step="0.000001" min="-90" max="90" value="${project.lat ?? ""}" placeholder="e.g. 38.589" />
        </div>
        <div class="form-field">
          <label for="lng">Longitude <span style="font-weight:400;color:var(--muted);">(optional)</span></label>
          <input id="lng" name="lng" type="number" step="0.000001" min="-180" max="180" value="${project.lng ?? ""}" placeholder="e.g. -90.412" />
        </div>
        <div class="form-field full" style="margin-top:-6px;">
          <p style="font-size:11.5px;color:var(--muted);margin:0;">Set these by hand, or leave blank and drop a pin instead from the <a href="/co/map" style="color:var(--honey-deep);font-weight:600;">Map</a> page.</p>
        </div>
        <div class="form-field full">
          <label for="notes">Notes</label>
          <textarea id="notes" name="notes">${esc(project.notes)}</textarea>
        </div>
      </div>
      <div class="list-actions">
        <button class="btn" type="submit">Save project</button>
        <a class="btn secondary" href="/co/projects">Cancel</a>
      </div>
    </form>`;
}

get("/co/projects/new", (req, res, params, query) => {
  const clients = condb.listClients(req.account.id);
  const body = conProjectForm({
    project: { client_id: query.get("client_id") || "" },
    clients,
    action: "/co/projects",
    title: "Add project",
  });
  sendHtml(res, 200, conLayout({ account: req.account, title: "Add project", active: "projects", body }));
});

post("/co/projects", async (req, res) => {
  const body = await parseBody(req);
  if (!body.title || !body.title.trim() || !body.client_id) return redirect(res, "/co/projects/new");
  const client = condb.getClient(req.account.id, body.client_id);
  if (!client) return redirect(res, "/co/projects/new");
  const id = condb.createProject(body);
  redirect(res, `/co/projects/${id}`);
});

get("/co/projects/:id", (req, res, params, query) => {
  const project = condb.getProject(req.account.id, params.id);
  if (!project) return notFound(res);
  const changeOrders = condb.listChangeOrdersForProject(project.id);
  const tasks = condb.listTasksForProject(project.id);
  const dailyLogs = condb.listDailyLogsForProject(project.id);

  const coItems = changeOrders.length
    ? changeOrders
        .map(
          (co) => `
      <div class="policy-item">
        <div>
          <div class="policy-main">${esc(co.description)} <span class="badge ${co.status}">${co.status[0].toUpperCase() + co.status.slice(1)}</span></div>
          <div class="policy-meta">${esc(co.created_at)}</div>
        </div>
        <div style="display:flex;align-items:center;gap:10px;">
          <div class="policy-premium">${money(co.amount)}</div>
          ${
            co.status === "pending"
              ? `<form method="post" action="/co/change-orders/${co.id}/status" style="display:flex;gap:6px;">
                   <button class="btn small" type="submit" name="status" value="approved">Approve</button>
                   <button class="btn small danger" type="submit" name="status" value="rejected">Reject</button>
                 </form>`
              : ""
          }
        </div>
      </div>`
        )
        .join("")
    : `<div class="empty-state">No change orders yet.</div>`;

  const approvedTotal = condb.approvedChangeOrderTotal(project.id);

  const addCoForm = `
    <form method="post" action="/co/projects/${project.id}/change-orders" style="margin-top:12px;padding-top:12px;border-top:1px solid var(--line);">
      <div class="form-grid">
        <div class="form-field">
          <label for="co-desc">Description *</label>
          <input id="co-desc" name="description" required placeholder="e.g. Upgrade to quartz countertops" />
        </div>
        <div class="form-field">
          <label for="co-amount">Amount *</label>
          <input id="co-amount" name="amount" type="number" step="0.01" required />
        </div>
      </div>
      <button class="btn small" type="submit">+ Add change order</button>
    </form>`;

  const taskItems = tasks.length
    ? tasks
        .map(
          (t) => `
      <div class="policy-item">
        <label style="display:flex;align-items:center;gap:10px;cursor:pointer;flex:1;">
          <form method="post" action="/co/tasks/${t.id}/toggle" style="display:inline;">
            <input type="checkbox" ${t.done ? "checked" : ""} onchange="this.form.submit()" />
          </form>
          <span style="${t.done ? "text-decoration:line-through;color:var(--muted);" : ""}">${esc(t.description)}</span>
        </label>
        <form method="post" action="/co/tasks/${t.id}/delete" onsubmit="return confirm('Delete this item?');">
          <button class="btn small danger" type="submit">Delete</button>
        </form>
      </div>`
        )
        .join("")
    : `<div class="empty-state">No punch-list items yet.</div>`;

  const addTaskForm = `
    <form method="post" action="/co/projects/${project.id}/tasks" style="margin-top:12px;padding-top:12px;border-top:1px solid var(--line);display:flex;gap:8px;">
      <input name="description" required placeholder="e.g. Touch up hallway paint" style="flex:1;" />
      <button class="btn small" type="submit">+ Add</button>
    </form>`;

  const phaseOptions = condb.PROJECT_PHASES.concat(condb.PROJECT_SIDE_PHASES)
    .map((p) => `<option value="${p}" ${project.phase === p ? "selected" : ""}>${condb.PROJECT_PHASE_LABELS[p]}</option>`)
    .join("");

  const dailyLogItems = dailyLogs.length
    ? dailyLogs
        .map(
          (l) => `
      <div class="policy-item" style="align-items:flex-start;">
        <div>
          <div class="policy-meta" style="white-space:pre-wrap;max-width:460px;color:var(--ink-soft);">${esc(l.note)}</div>
          <div class="policy-meta">${esc(l.created_at)}</div>
        </div>
        <form method="post" action="/co/daily-logs/${l.id}/delete" onsubmit="return confirm('Delete this log entry?');">
          <button class="btn small danger" type="submit">Delete</button>
        </form>
      </div>`
        )
        .join("")
    : `<div class="empty-state">No daily log entries yet — post a quick update after each site visit so the client (and your future self) can see progress at a glance.</div>`;

  const addDailyLogForm = `
    <form method="post" action="/co/projects/${project.id}/daily-logs" style="margin-top:12px;padding-top:12px;border-top:1px solid var(--line);display:flex;gap:8px;">
      <input name="note" required placeholder="e.g. Framing inspection passed, drywall starts Monday" style="flex:1;" />
      <button class="btn small" type="submit">+ Post update</button>
    </form>`;

  const dailyLogCard = `
    <div class="card" style="margin-top:20px;">
      <h3 style="margin-bottom:4px;">Daily log</h3>
      <p style="margin:0 0 10px;font-size:12px;color:var(--muted);">A running, timestamped progress log for this project — the same idea as Buildertrend/CoConstruct's daily logs.</p>
      ${dailyLogItems}
      ${addDailyLogForm}
    </div>`;

  const activityEvents = [
    { ts: project.created_at, title: "Project created", meta: `${project.project_type} · started as ${condb.PROJECT_PHASE_LABELS[project.phase] || project.phase}`, color: "var(--muted)" },
  ];
  changeOrders.forEach((co) => {
    activityEvents.push({ ts: co.created_at, title: `Change order: ${co.description}`, meta: `${money(co.amount)} · ${co.status}`, color: "var(--gold)" });
  });
  dailyLogs.forEach((l) => {
    activityEvents.push({ ts: l.created_at, title: "Daily log update", meta: (l.note || "").slice(0, 90), color: "var(--charcoal)" });
  });
  if (project.updated_at && project.updated_at !== project.created_at) {
    activityEvents.push({ ts: project.updated_at, title: `${project.title} → ${condb.PROJECT_PHASE_LABELS[project.phase] || project.phase}`, meta: "Project updated", color: "var(--gold-dark)" });
  }
  const activityCard = `
    <div class="card" style="margin-top:20px;">
      <h3 style="margin-bottom:10px;">Activity</h3>
      ${renderTimeline(activityEvents)}
    </div>`;

  const body = `
    <div class="breadcrumb"><a href="/co/projects">Projects</a> / ${esc(project.title)}</div>
    <div class="page-header">
      <div>
        <h1>${esc(project.title)} <span class="badge ${project.phase}" style="vertical-align:middle;">${condb.PROJECT_PHASE_LABELS[project.phase]}</span></h1>
        <p class="subtitle"><a href="/co/clients/${project.client_id}" style="color:inherit;">${esc(project.client_name)}</a>${project.address ? " · " + esc(project.address) : ""}</p>
      </div>
      <div class="list-actions">
        <a class="btn secondary" href="/co/projects/${project.id}/edit">Edit project</a>
        <form method="post" action="/co/projects/${project.id}/delete" onsubmit="return confirm('Delete ${esc(project.title)} and its change orders/tasks?');">
          <button class="btn danger" type="submit">Delete</button>
        </form>
      </div>
    </div>

    <div class="stat-grid" style="margin-bottom:16px;">
      <div class="stat-card accent">
        <div class="stat-label">Budget</div>
        <div class="stat-value">${money(project.budget)}</div>
        <div class="stat-foot">${money(approvedTotal)} approved change orders</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Contract total</div>
        <div class="stat-value">${money(project.budget + approvedTotal)}</div>
        <div class="stat-foot">Budget + approved changes</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Target date</div>
        <div class="stat-value" style="font-size:20px;">${esc(project.target_date || "—")}</div>
        <div class="stat-foot">${project.project_manager ? "PM: " + esc(project.project_manager) : "No PM assigned"}</div>
      </div>
    </div>

    <form method="post" action="/co/projects/${project.id}/phase" class="card" style="margin-bottom:16px;display:flex;align-items:center;gap:12px;flex-wrap:wrap;">
      <label for="phase-select" style="font-weight:700;font-size:13px;">Phase:</label>
      <select id="phase-select" name="phase" onchange="this.form.submit()">${phaseOptions}</select>
      <span style="font-size:12px;color:var(--muted);">Changing this updates the pipeline board immediately.</span>
    </form>

    <div class="two-col">
      <div class="card">
        <h3 style="margin-bottom:10px;">Change orders</h3>
        ${coItems}
        ${addCoForm}
      </div>
      <div class="card">
        <h3 style="margin-bottom:10px;">Punch list</h3>
        ${taskItems}
        ${addTaskForm}
      </div>
    </div>
    ${project.notes ? `<div class="card" style="margin-top:20px;"><h3 style="margin-bottom:10px;">Notes</h3><p style="font-size:14px;color:var(--ink-soft);white-space:pre-wrap;">${esc(project.notes)}</p></div>` : ""}
    ${dailyLogCard}
    ${activityCard}`;

  sendHtml(res, 200, conLayout({ account: req.account, title: project.title, active: "projects", body }));
});

get("/co/projects/:id/edit", (req, res, params) => {
  const project = condb.getProject(req.account.id, params.id);
  if (!project) return notFound(res);
  const clients = condb.listClients(req.account.id);
  const body = conProjectForm({ project, clients, action: `/co/projects/${project.id}`, title: `Edit ${project.title}` });
  sendHtml(res, 200, conLayout({ account: req.account, title: "Edit project", active: "projects", body }));
});

post("/co/projects/:id", async (req, res, params) => {
  const project = condb.getProject(req.account.id, params.id);
  if (!project) return notFound(res);
  const body = await parseBody(req);
  condb.updateProject(params.id, body);
  redirect(res, `/co/projects/${params.id}`);
});

post("/co/projects/:id/phase", async (req, res, params) => {
  const project = condb.getProject(req.account.id, params.id);
  if (!project) return notFound(res);
  const body = await parseBody(req);
  condb.updateProjectPhase(params.id, body.phase);
  redirect(res, `/co/projects/${params.id}`);
});

post("/co/projects/:id/delete", (req, res, params) => {
  const project = condb.getProject(req.account.id, params.id);
  if (!project) return notFound(res);
  condb.deleteProject(params.id);
  redirect(res, "/co/projects");
});

post("/co/projects/:id/change-orders", async (req, res, params) => {
  const project = condb.getProject(req.account.id, params.id);
  if (!project) return notFound(res);
  const body = await parseBody(req);
  if (!body.description || !body.description.trim()) return redirect(res, `/co/projects/${params.id}`);
  condb.createChangeOrder({ ...body, project_id: project.id });
  redirect(res, `/co/projects/${params.id}`);
});

post("/co/change-orders/:id/status", async (req, res, params) => {
  const body = await parseBody(req);
  const co = db.rawDb
    .prepare(
      `SELECT co.* FROM con_change_orders co
       JOIN con_projects p ON p.id = co.project_id
       JOIN con_clients c ON c.id = p.client_id
       WHERE co.id = ? AND c.account_id = ?`
    )
    .get(params.id, req.account.id);
  if (!co) return notFound(res);
  condb.updateChangeOrderStatus(req.account.id, params.id, body.status);
  redirect(res, `/co/projects/${co.project_id}`);
});

post("/co/projects/:id/tasks", async (req, res, params) => {
  const project = condb.getProject(req.account.id, params.id);
  if (!project) return notFound(res);
  const body = await parseBody(req);
  if (!body.description || !body.description.trim()) return redirect(res, `/co/projects/${params.id}`);
  condb.createTask({ project_id: project.id, description: body.description });
  redirect(res, `/co/projects/${params.id}`);
});

post("/co/tasks/:id/toggle", (req, res, params) => {
  const task = db.rawDb
    .prepare(
      `SELECT t.* FROM con_tasks t JOIN con_projects p ON p.id = t.project_id JOIN con_clients c ON c.id = p.client_id
       WHERE t.id = ? AND c.account_id = ?`
    )
    .get(params.id, req.account.id);
  if (!task) return notFound(res);
  condb.toggleTask(req.account.id, params.id);
  redirect(res, `/co/projects/${task.project_id}`);
});

post("/co/tasks/:id/delete", (req, res, params) => {
  const task = db.rawDb
    .prepare(
      `SELECT t.* FROM con_tasks t JOIN con_projects p ON p.id = t.project_id JOIN con_clients c ON c.id = p.client_id
       WHERE t.id = ? AND c.account_id = ?`
    )
    .get(params.id, req.account.id);
  if (!task) return notFound(res);
  condb.deleteTask(req.account.id, params.id);
  redirect(res, `/co/projects/${task.project_id}`);
});

post("/co/projects/:id/daily-logs", async (req, res, params) => {
  const project = condb.getProject(req.account.id, params.id);
  if (!project) return notFound(res);
  const body = await parseBody(req);
  if (!body.note || !body.note.trim()) return redirect(res, `/co/projects/${params.id}`);
  condb.createDailyLog({ project_id: project.id, note: body.note });
  redirect(res, `/co/projects/${params.id}`);
});

post("/co/daily-logs/:id/delete", (req, res, params) => {
  const log = db.rawDb
    .prepare(
      `SELECT dl.* FROM con_daily_logs dl JOIN con_projects p ON p.id = dl.project_id JOIN con_clients c ON c.id = p.client_id
       WHERE dl.id = ? AND c.account_id = ?`
    )
    .get(params.id, req.account.id);
  if (!log) return notFound(res);
  condb.deleteDailyLog(req.account.id, params.id);
  redirect(res, `/co/projects/${log.project_id}`);
});

get("/co/clients/export.csv", (req, res) => {
  const clients = condb.listClients(req.account.id, "").map((c) => ({ ...c, stats: condb.clientStats(c.id) }));
  const csv = toCsv(clients, [
    ["Name", "name"],
    ["Email", "email"],
    ["Phone", "phone"],
    ["Source", "source"],
    ["Lifetime value", (c) => c.stats.lifetimeValue.toFixed(2)],
    ["Project count", (c) => c.stats.projectCount],
    ["Notes", "notes"],
  ]);
  sendCsv(res, "hivehub-construction-clients.csv", csv);
});

get("/co/clients", (req, res, params, query) => {
  const q = query.get("q") || "";
  const clients = condb.listClients(req.account.id, q);
  const rows = clients.length
    ? clients
        .map(
          (c) => `<tr onclick="location.href='/co/clients/${c.id}'">
        <td>${esc(c.name)}</td>
        <td>${esc(c.email || "—")}</td>
        <td>${esc(c.phone || "—")}</td>
        <td>${esc(c.source || "—")}</td>
      </tr>`
        )
        .join("")
    : `<tr><td colspan="4"><div class="empty-state">No clients found. <a href="/co/clients/new">Add your first client</a>.</div></td></tr>`;

  const body = `
    <div class="page-header">
      <div>
        <h1>Clients</h1>
        <p class="subtitle">${clients.length} client${clients.length === 1 ? "" : "s"}</p>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <a class="btn secondary" href="/co/clients/export.csv">Export CSV</a>
        <a class="btn" href="/co/clients/new">+ Add client</a>
      </div>
    </div>
    <form class="search-bar" method="get" action="/co/clients">
      <input type="text" name="q" value="${esc(q)}" placeholder="Search by name, email, or phone..." />
      <button class="btn secondary" type="submit">Search</button>
    </form>
    <div class="card">
      <div class="table-scroll">
      <table class="clickable">
        <thead><tr><th>Name</th><th>Email</th><th>Phone</th><th>Source</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      </div>
    </div>`;

  sendHtml(res, 200, conLayout({ account: req.account, title: "Clients", active: "clients", body }));
});

function conClientForm({ client = {}, action, title }) {
  return `
    <div class="page-header"><h1>${title}</h1></div>
    <form class="card" method="post" action="${action}">
      <div class="form-grid">
        <div class="form-field">
          <label for="name">Full name / business name *</label>
          <input id="name" name="name" required value="${esc(client.name)}" />
        </div>
        <div class="form-field">
          <label for="email">Email</label>
          <input id="email" name="email" type="email" value="${esc(client.email)}" />
        </div>
        <div class="form-field">
          <label for="phone">Phone</label>
          <input id="phone" name="phone" value="${esc(client.phone)}" />
        </div>
        <div class="form-field">
          <label for="source">How they found you</label>
          <input id="source" name="source" value="${esc(client.source)}" placeholder="e.g. Referral, Google, repeat client" />
        </div>
        <div class="form-field full">
          <label for="notes">Notes</label>
          <textarea id="notes" name="notes">${esc(client.notes)}</textarea>
        </div>
      </div>
      <div class="list-actions">
        <button class="btn" type="submit">Save client</button>
        <a class="btn secondary" href="/co/clients">Cancel</a>
      </div>
    </form>`;
}

get("/co/clients/new", (req, res) => {
  sendHtml(res, 200, conLayout({ account: req.account, title: "Add client", active: "clients", body: conClientForm({ action: "/co/clients", title: "Add client" }) }));
});

post("/co/clients", async (req, res) => {
  const body = await parseBody(req);
  if (!body.name || !body.name.trim()) return redirect(res, "/co/clients/new");
  const id = condb.createClient({ ...body, account_id: req.account.id });
  redirect(res, `/co/clients/${id}`);
});

get("/co/clients/:id", (req, res, params, query) => {
  const client = condb.getClient(req.account.id, params.id);
  if (!client) return notFound(res);
  const projects = condb.listProjectsForClient(params.id);
  const messages = condb.listMessagesForClient(params.id);

  const projectItems = projects.length
    ? projects
        .map(
          (p) => `
      <div class="policy-item" onclick="location.href='/co/projects/${p.id}'" style="cursor:pointer;">
        <div>
          <div class="policy-main">${esc(p.title)} <span class="badge ${p.phase}">${condb.PROJECT_PHASE_LABELS[p.phase]}</span></div>
          <div class="policy-meta">${esc(p.project_type)}${p.target_date ? " · target " + esc(p.target_date) : ""}</div>
        </div>
        <div class="policy-premium">${money(p.budget)}</div>
      </div>`
        )
        .join("")
    : `<div class="empty-state">No projects yet for ${esc(client.name)}.</div>`;

  const aiDraft = generateConAiDraft(client, projects);
  const templates = [
    { label: "Project update", subject: "Quick update", body: `Hi ${firstName(client.name)}, quick update on your project — everything's moving along. Let me know if you have any questions!` },
    { label: "Change order nudge", subject: "Change order awaiting approval", body: `Hi ${firstName(client.name)}, just following up on the change order awaiting your approval — let me know if you'd like to discuss it.` },
    { label: "Review ask", subject: "How did we do?", body: `Hi ${firstName(client.name)}, thanks again for choosing us for your project! A quick review would mean a lot to our business.` },
  ];
  function conFillBtn(label, subject, msgBody, extraClass) {
    return `<button type="button" class="btn small ${extraClass || "secondary"}" onclick="document.getElementById('msg-subject').value=${esc(
      JSON.stringify(subject)
    )};document.getElementById('msg-body').value=${esc(JSON.stringify(msgBody))};">${esc(label)}</button>`;
  }
  const templateButtons =
    templates.map((t) => conFillBtn(t.label, t.subject, t.body)).join("") + conFillBtn("AI Draft", aiDraft.subject, aiDraft.body, "ai-draft");

  const messageItems = messages.length
    ? messages
        .map(
          (m) => `
      <div class="policy-item" style="align-items:flex-start;">
        <div>
          <div class="policy-main"><span class="badge ${m.channel}">${m.channel === "email" ? "Email" : "Text"}</span>${m.subject ? ` &middot; ${esc(m.subject)}` : ""}
            <span class="badge ${STATUS_BADGE[m.status] || "pending"}">${STATUS_LABEL[m.status] || esc(m.status)}</span>
          </div>
          <div class="policy-meta" style="white-space:pre-wrap;max-width:460px;">${esc(m.body)}</div>
          ${m.error ? `<div class="policy-meta" style="color:var(--danger);">${esc(m.error)}</div>` : ""}
        </div>
        <div class="policy-meta">${esc(m.created_at)}</div>
      </div>`
        )
        .join("")
    : `<div class="empty-state">No messages yet. Send the first one to ${esc(client.name)} above.</div>`;

  const draftPrefill = query && query.get("draft") === "1";
  const messagesCard = `
    <div class="card" style="margin-top:20px;" id="messages">
      <div class="page-header" style="margin-bottom:6px;">
        <h3 style="margin:0;">Messages</h3>
        <span style="font-size:12px;color:var(--muted);">Email sends for real once you connect a provider (see README) — texting isn't connected yet</span>
      </div>
      <form method="post" action="/co/clients/${client.id}/messages">
        <div class="form-grid">
          <div class="form-field">
            <label for="channel">Channel</label>
            <select id="channel" name="channel">
              <option value="email">Email</option>
              <option value="sms">Text (SMS)</option>
            </select>
          </div>
          <div class="form-field">
            <label for="msg-subject">Subject <span style="font-weight:400;color:var(--muted);">(email only)</span></label>
            <input id="msg-subject" name="subject" value="${draftPrefill ? esc(aiDraft.subject) : ""}" />
          </div>
          <div class="form-field full">
            <label for="msg-body">Message *</label>
            <textarea id="msg-body" name="body" required placeholder="Write a message to ${esc(client.name)}...">${draftPrefill ? esc(aiDraft.body) : ""}</textarea>
          </div>
        </div>
        <div class="list-actions" style="flex-wrap:wrap;margin-bottom:12px;">${templateButtons}</div>
        <div class="list-actions">
          <button class="btn" type="submit">Send message</button>
        </div>
      </form>
      <form method="post" action="/co/clients/${client.id}/autopilot">
        <input type="hidden" name="enabled" value="${client.autopilot_enabled ? "1" : "0"}" />
        <label class="autopilot-row">
          <input type="checkbox" ${client.autopilot_enabled ? "checked" : ""} onclick="this.form.enabled.value=this.checked?'1':'0';this.form.submit();" />
          <span><strong>Autopilot</strong> — ${client.autopilot_enabled ? "on: " : ""}let AI send project updates and review asks like these automatically, once there's a concrete trigger (never a generic check-in on its own). ${client.email ? "" : '<span style="color:var(--danger);">Add an email address to this client to enable.</span>'}</span>
        </label>
      </form>
      <h4 style="margin:18px 0 10px;font-size:12px;text-transform:uppercase;letter-spacing:0.05em;color:var(--muted);">History</h4>
      ${messageItems}
    </div>`;

  const activityEvents = [
    { ts: client.created_at, title: "Client added", meta: `via ${client.source || "unspecified source"}`, color: "var(--muted)" },
  ];
  projects.forEach((p) => {
    activityEvents.push({ ts: p.created_at, title: `Project created: ${p.title}`, meta: `${p.project_type} · started as ${condb.PROJECT_PHASE_LABELS[p.phase] || p.phase}`, color: "var(--gold)" });
    if (p.updated_at && p.updated_at !== p.created_at) {
      activityEvents.push({ ts: p.updated_at, title: `${p.title} → ${condb.PROJECT_PHASE_LABELS[p.phase] || p.phase}`, meta: "Project updated", color: "var(--gold-dark)" });
    }
  });
  messages.forEach((m) => {
    activityEvents.push({ ts: m.created_at, title: `${m.channel === "email" ? "Email" : "Text"} ${m.status === "sent" ? "sent" : m.status === "failed" ? "failed" : "logged"}${m.subject ? ": " + m.subject : ""}`, meta: (m.body || "").slice(0, 90), color: "var(--charcoal)" });
  });
  const activityCard = `
    <div class="card" style="margin-top:20px;">
      <h3 style="margin-bottom:10px;">Activity</h3>
      ${renderTimeline(activityEvents)}
    </div>`;

  const cstats = condb.clientStats(client.id);
  const clientStatGrid = `
    <div class="stat-grid" style="margin-bottom:16px;">
      <div class="stat-card accent">
        <div class="stat-label">Lifetime value</div>
        <div class="stat-value">${money(cstats.lifetimeValue)}</div>
        <div class="stat-foot">Total from completed projects</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Projects on file</div>
        <div class="stat-value">${cstats.projectCount}</div>
        <div class="stat-foot">${cstats.completeProjectCount} complete</div>
      </div>
    </div>`;

  const body = `
    <div class="breadcrumb"><a href="/co/clients">Clients</a> / ${esc(client.name)}</div>
    <div class="page-header">
      <div>
        <h1>${esc(client.name)}</h1>
        <p class="subtitle">${esc(client.email || "")}${client.email && client.phone ? " · " : ""}${esc(client.phone || "")}</p>
      </div>
      <div class="list-actions">
        <a class="btn secondary" href="/co/clients/${client.id}/edit">Edit client</a>
        <form method="post" action="/co/clients/${client.id}/delete" onsubmit="return confirm('Delete ${esc(client.name)} and all their projects?');">
          <button class="btn danger" type="submit">Delete</button>
        </form>
      </div>
    </div>

    ${clientStatGrid}

    <div class="page-header" style="margin-bottom:12px;">
      <h3 style="margin:0;">Projects</h3>
      <a class="btn small" href="/co/projects/new?client_id=${client.id}">+ Add project</a>
    </div>
    ${projectItems}
    ${
      client.source || client.notes
        ? `<div class="card" style="margin-top:20px;"><h3 style="margin-bottom:10px;">Notes</h3><p style="font-size:14px;color:var(--ink-soft);white-space:pre-wrap;">${esc(
            client.source ? `Source: ${client.source}\n\n` : ""
          )}${esc(client.notes || "")}</p></div>`
        : ""
    }
    ${activityCard}
    ${messagesCard}`;

  const msgFlag = query && query.get("msg");
  const flash =
    msgFlag === "sent"
      ? "Email sent."
      : msgFlag === "failed"
      ? "Couldn't send that email — see the error under the message below."
      : msgFlag === "logged"
      ? "Message logged (not delivered — connect an email provider to send for real; see README)."
      : null;

  sendHtml(res, 200, conLayout({ account: req.account, title: client.name, active: "clients", flash, body }));
});

get("/co/clients/:id/edit", (req, res, params) => {
  const client = condb.getClient(req.account.id, params.id);
  if (!client) return notFound(res);
  const body = conClientForm({ client, action: `/co/clients/${client.id}`, title: `Edit ${client.name}` });
  sendHtml(res, 200, conLayout({ account: req.account, title: "Edit client", active: "clients", body }));
});

post("/co/clients/:id", async (req, res, params) => {
  const client = condb.getClient(req.account.id, params.id);
  if (!client) return notFound(res);
  const body = await parseBody(req);
  condb.updateClient(params.id, body);
  redirect(res, `/co/clients/${params.id}`);
});

post("/co/clients/:id/delete", (req, res, params) => {
  condb.deleteClient(req.account.id, params.id);
  redirect(res, "/co/clients");
});

post("/co/clients/:id/messages", async (req, res, params) => {
  const client = condb.getClient(req.account.id, params.id);
  if (!client) return notFound(res);
  const body = await parseBody(req);
  if (!body.body || !body.body.trim()) return redirect(res, `/co/clients/${params.id}`);
  const channel = body.channel === "sms" ? "sms" : "email";
  const outcome = await sendAndLogMessage(condb, client, { channel, subject: body.subject, body: body.body });
  const flag = outcome.ok ? "sent" : outcome.skipped ? "logged" : "failed";
  redirect(res, `/co/clients/${params.id}?msg=${flag}`);
});

post("/co/clients/:id/autopilot", async (req, res, params) => {
  const client = condb.getClient(req.account.id, params.id);
  if (!client) return notFound(res);
  const body = await parseBody(req);
  condb.setAutopilotEnabled(client.id, body.enabled === "1");
  redirect(res, `/co/clients/${params.id}#messages`);
});

get("/co/messages", (req, res) => {
  const projects = condb.listOpenProjectsWithClients(req.account.id);
  const suggestionMap = new Map();
  projects.forEach((p) => {
    const days = conDaysFromToday(p.target_date);
    let urgency = null;
    let reason = "";
    const pendingCOs = condb.listChangeOrdersForProject(p.id).filter((co) => co.status === "pending");
    if (pendingCOs.length) {
      urgency = 0;
      reason = `Change order awaiting approval on "${p.title}"`;
    } else if (["in_progress", "punch_list"].includes(p.phase) && days !== null && days >= 0 && days <= 7) {
      urgency = 1;
      reason = `"${p.title}" targeted to wrap in ${days}d`;
    } else if (p.phase === "complete") {
      urgency = 2;
      reason = `"${p.title}" complete — good time to ask for a review`;
    } else {
      return;
    }
    const existing = suggestionMap.get(p.client_id);
    if (!existing || urgency < existing.urgency) {
      suggestionMap.set(p.client_id, { client_id: p.client_id, client_name: p.client_name, reason, urgency });
    }
  });
  const suggestions = Array.from(suggestionMap.values()).sort((a, b) => a.urgency - b.urgency).slice(0, 8);

  const suggestionRows = suggestions.length
    ? suggestions
        .map(
          (s) => `
      <div class="policy-item">
        <div>
          <div class="policy-main">${esc(s.client_name)}</div>
          <div class="policy-meta">${esc(s.reason)}</div>
        </div>
        <a class="btn small ai-draft" href="/co/clients/${s.client_id}?draft=1#messages">Start conversation</a>
      </div>`
        )
        .join("")
    : `<p style="color:var(--muted);font-size:13px;">No projects need outreach right now.</p>`;

  const recent = condb.listRecentMessages(req.account.id, 15);
  const recentRows = recent.length
    ? recent
        .map((m) => {
          const snippet = (m.body || "").length > 90 ? m.body.slice(0, 90) + "…" : m.body || "";
          return `
      <div class="policy-item" style="align-items:flex-start;">
        <div>
          <div class="policy-main">
            <a href="/co/clients/${m.client_id}#messages" style="color:inherit;">${esc(m.client_name)}</a>
            <span class="badge ${m.channel}">${m.channel === "email" ? "Email" : "Text"}</span>
            <span class="badge ${STATUS_BADGE[m.status] || "pending"}">${STATUS_LABEL[m.status] || esc(m.status)}</span>
          </div>
          <div class="policy-meta" style="max-width:460px;">${m.subject ? `${esc(m.subject)} — ` : ""}${esc(snippet)}</div>
        </div>
        <div class="policy-meta">${esc(m.created_at)}</div>
      </div>`;
        })
        .join("")
    : `<div class="empty-state">No conversations yet. Use a suggestion, or open any client to send the first message.</div>`;

  const body = `
    <div class="page-header">
      <div>
        <h1>Communication</h1>
        <p class="subtitle">AI helps you find who to talk to and drafts it — you hit send</p>
      </div>
    </div>
    ${renderAutopilotPanel(condb.listAutopilotEnabledClients(req.account.id).length, condb.listClients(req.account.id).length)}
    <div class="card" style="margin-bottom:20px;">
      <h3 style="margin-bottom:6px;">Start a conversation</h3>
      <p style="margin:0 0 12px;font-size:13px;color:var(--muted);">Search for a client to open their thread with an AI draft ready to go.</p>
      ${renderClientSearchPicker(condb.listClients(req.account.id), "/co/clients")}
    </div>
    <div class="two-col">
      <div class="card">
        <h3 style="margin-bottom:4px;">AI suggests reaching out to</h3>
        <p style="margin:0 0 12px;font-size:12px;color:var(--muted);">Based on pending change orders, projects wrapping up soon, or just completed</p>
        ${suggestionRows}
      </div>
      <div class="card">
        <h3 style="margin-bottom:4px;">Recent conversations</h3>
        <p style="margin:0 0 12px;font-size:12px;color:var(--muted);">Across all your clients</p>
        ${recentRows}
      </div>
    </div>`;

  sendHtml(res, 200, conLayout({ account: req.account, title: "Communication", active: "messages", body }));
});

// ================= server =================

// Which vertical (if any) a path belongs to — used to gate /app, /hs, and
// /co behind a logged-in account whose own vertical matches the path, so an
// Insurance Broker account can't wander into someone's Construction data (or
// vice versa) just by typing the URL.
function requiredVerticalFor(pathname) {
  if (pathname === "/app" || pathname.startsWith("/app/")) return "insurance";
  if (pathname === "/hs" || pathname.startsWith("/hs/")) return "homeservice";
  if (pathname === "/co" || pathname.startsWith("/co/")) return "construction";
  return null;
}

// Routes outside /app, /hs, /co that still need *some* logged-in account
// (but aren't tied to one particular vertical).
const ACCOUNT_REQUIRED_PATHS = new Set(["/autopilot/run"]);

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = decodeURIComponent(url.pathname);

    if (req.method === "GET" && (pathname === "/style.css" || pathname === "/landing.css")) {
      if (serveStatic(req, res, pathname)) return;
    }

    // ---- resolve the session (if any) before routing ----
    const cookies = auth.parseCookies(req);
    req.account = auth.getSessionAccount(cookies[auth.SESSION_COOKIE]);

    const gateVertical = requiredVerticalFor(pathname);
    if (gateVertical) {
      if (!req.account) {
        return redirect(res, `/login?next=${encodeURIComponent(pathname)}`);
      }
      if (req.account.vertical !== gateVertical) {
        return redirect(res, auth.VERTICAL_HOME[req.account.vertical] || "/");
      }
    } else if (ACCOUNT_REQUIRED_PATHS.has(pathname) && !req.account) {
      return redirect(res, "/login");
    }

    for (const r of routes) {
      if (r.method !== req.method) continue;
      const match = pathname.match(r.regex);
      if (!match) continue;
      const params = {};
      r.keys.forEach((key, i) => (params[key] = match[i + 1]));
      await r.handler(req, res, params, url.searchParams);
      return;
    }

    notFound(res);
  } catch (err) {
    console.error(err);
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("Something buzzed wrong on the server: " + err.message);
  }
});

// ---------- AI Autopilot ----------
// Turns the same rule-based drafts the manual "AI Draft" button uses into
// real, automatic sends — opt-in per client, and only for a trigger with a
// concrete dedupe key (a dated renewal, a specific job hitting a stage).
// The generic "just checking in" fallback (key: null) is deliberately never
// auto-sent — it's not tied to anything happening, so autopiloting it would
// just be spam on a timer. Every send is logged to autopilot_log so the same
// trigger is never re-sent, and to the normal message history so it shows up
// in the client's timeline exactly like a message a human sent.
async function runAutopilotOnce() {
  const results = { checked: 0, sent: 0, logged: 0, skipped: 0, errors: [] };

  for (const client of db.listAutopilotEnabledClients()) {
    results.checked++;
    if (!client.email) { results.skipped++; continue; }
    const policies = db.listPoliciesForClient(client.id);
    const draft = generateAiDraft(client, policies);
    if (!draft.key) { results.skipped++; continue; }
    if (db.hasAutopilotSent("insurance", client.id, draft.key)) { results.skipped++; continue; }
    try {
      const outcome = await sendAndLogMessage(db, client, { channel: "email", subject: draft.subject, body: draft.body });
      db.recordAutopilotSent("insurance", client.id, draft.key);
      if (outcome.ok) results.sent++;
      else if (outcome.skipped) results.logged++; // no email provider configured — drafted and logged, not a failure
      else results.errors.push(`${client.name}: ${outcome.error || "send failed"}`);
    } catch (e) {
      results.errors.push(`${client.name}: ${e.message}`);
    }
  }

  for (const client of hsdb.listAutopilotEnabledClients()) {
    results.checked++;
    if (!client.email) { results.skipped++; continue; }
    const jobs = hsdb.listJobsForClient(client.id);
    const draft = generateHsAiDraft(client, jobs);
    if (!draft.key) { results.skipped++; continue; }
    if (db.hasAutopilotSent("homeservice", client.id, draft.key)) { results.skipped++; continue; }
    try {
      const outcome = await sendAndLogMessage(hsdb, client, { channel: "email", subject: draft.subject, body: draft.body });
      db.recordAutopilotSent("homeservice", client.id, draft.key);
      if (outcome.ok) results.sent++;
      else if (outcome.skipped) results.logged++;
      else results.errors.push(`${client.name}: ${outcome.error || "send failed"}`);
    } catch (e) {
      results.errors.push(`${client.name}: ${e.message}`);
    }
  }

  for (const client of condb.listAutopilotEnabledClients()) {
    results.checked++;
    if (!client.email) { results.skipped++; continue; }
    const projects = condb.listProjectsForClient(client.id);
    const draft = generateConAiDraft(client, projects);
    if (!draft.key) { results.skipped++; continue; }
    if (db.hasAutopilotSent("construction", client.id, draft.key)) { results.skipped++; continue; }
    try {
      const outcome = await sendAndLogMessage(condb, client, { channel: "email", subject: draft.subject, body: draft.body });
      db.recordAutopilotSent("construction", client.id, draft.key);
      if (outcome.ok) results.sent++;
      else if (outcome.skipped) results.logged++;
      else results.errors.push(`${client.name}: ${outcome.error || "send failed"}`);
    } catch (e) {
      results.errors.push(`${client.name}: ${e.message}`);
    }
  }

  return results;
}

const AUTOPILOT_INTERVAL_MINUTES = Number(process.env.AUTOPILOT_INTERVAL_MINUTES) || 60;
let lastAutopilotRun = null;

async function autopilotTick() {
  try {
    const results = await runAutopilotOnce();
    lastAutopilotRun = { at: new Date().toISOString(), ...results };
    if (results.sent > 0 || results.logged > 0 || results.errors.length > 0) {
      console.log(`[autopilot] checked ${results.checked}, sent ${results.sent}, logged ${results.logged}, skipped ${results.skipped}${results.errors.length ? `, errors: ${results.errors.join("; ")}` : ""}`);
    }
  } catch (e) {
    console.error("[autopilot] tick failed:", e.message);
  }
}

// First run shortly after boot (so a fresh server doesn't wait a full
// interval before Autopilot does anything visible), then on a fixed
// interval. Override AUTOPILOT_INTERVAL_MINUTES for a shorter loop when
// testing locally.
setTimeout(autopilotTick, 15_000);
setInterval(autopilotTick, AUTOPILOT_INTERVAL_MINUTES * 60_000);

post("/autopilot/run", async (req, res) => {
  await autopilotTick();
  const ref = req.headers.referer || "/app/messages";
  redirect(res, ref);
});

server.listen(PORT, () => {
  console.log(`HIVE Hub running at http://localhost:${PORT}`);
});
