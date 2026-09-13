"use strict";

function esc(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function money(n) {
  const num = Number(n || 0);
  return num.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

const DEFAULT_NAV = [
  { href: "/app", label: "Dashboard", key: "dashboard" },
  { href: "/app/clients", label: "Book of Business", key: "clients" },
  { href: "/app/commissions", label: "Commissions", key: "commissions" },
  { href: "/app/messages", label: "Communication", key: "messages" },
];

function layout({ title, active, flash, body, nav, tagline, brandHref, account }) {
  const navItems = nav || DEFAULT_NAV;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${esc(title)} · HIVE Hub</title>
  <link rel="stylesheet" href="/style.css" />
  <link rel="icon" href="data:image/svg+xml,${encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><polygon points="50,3 93,25 93,75 50,97 7,75 7,25" fill="%239c7a44"/></svg>'
  )}" />
</head>
<body>
  <div class="app-shell">
    <aside class="sidebar">
      <a href="${brandHref || "/"}" class="brand" style="cursor:pointer">
        <span class="brand-hex" aria-hidden="true"></span>
        <span class="brand-name">HIVE<span class="brand-accent">Hub</span></span>
      </a>
      <nav class="nav">
        ${navItems
          .map(
            (item) =>
              `<a href="${item.href}" class="nav-link${item.key === active ? " active" : ""}">${item.label}</a>`
          )
          .join("\n")}
      </nav>
      ${
        account
          ? `<div class="account-chip">
               <div class="account-chip-name">${esc(account.business_name)}</div>
               <form method="post" action="/logout">
                 <button type="submit" class="account-chip-logout">Log out</button>
               </form>
             </div>`
          : ""
      }
      <div class="sidebar-footer">
        <div class="hex-pattern" aria-hidden="true"></div>
        <p class="tagline">${tagline || "Client and policy management for life insurance brokers."}</p>
      </div>
    </aside>
    <main class="main">
      ${flash ? `<div class="flash">${esc(flash)}</div>` : ""}
      ${body}
    </main>
  </div>
</body>
</html>`;
}

// A unified, chronological activity feed for a client detail page — merges
// jobs/policies, messages, and record creation into one timeline. This is
// built from each record's own created_at/updated_at timestamps rather than
// a dedicated audit-log table, so it shows *what changed last*, not a full
// history of every intermediate stage a record passed through.
function renderTimeline(events) {
  if (!events.length) return `<div class="empty-state">No activity yet.</div>`;
  const sorted = events.slice().sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
  return `<div class="timeline">${sorted
    .map(
      (e) => `
    <div class="timeline-item">
      <div class="timeline-dot" style="background:${e.color || "var(--gold)"};"></div>
      <div class="timeline-body">
        <div class="timeline-title">${esc(e.title)}</div>
        ${e.meta ? `<div class="timeline-meta">${esc(e.meta)}</div>` : ""}
        <div class="timeline-ts">${esc(e.ts)}</div>
      </div>
    </div>`
    )
    .join("")}</div>`;
}

module.exports = { layout, esc, money, renderTimeline };
