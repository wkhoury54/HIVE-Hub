"use strict";

function shellHead(title) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title} · HIVE Hub</title>
  <link rel="stylesheet" href="/landing.css" />
  <link rel="icon" href="data:image/svg+xml,${encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><polygon points="50,3 93,25 93,75 50,97 7,75 7,25" fill="%239c7a44"/></svg>'
  )}" />
</head>
<body>`;
}

const header = `
<a class="skip-link" href="#main">Skip to content</a>
<header class="site">
  <a class="logo" href="/">
    <span class="logo-mark" aria-hidden="true"></span>
    HIVE<span class="accent">Hub</span>
  </a>
  <nav class="site-nav" aria-label="Account">
    <a class="btn ghost" href="/login">Log in</a>
    <a class="btn primary" href="/signup">Start free</a>
  </nav>
</header>`;

const footer = `
<footer class="site-footer">
  <span>&copy; 2026 HIVE Hub</span>
  <nav class="footer-links" aria-label="Legal">
    <a href="/pricing">Pricing</a>
    <a href="/support">Contact</a>
  </nav>
</footer>`;

function renderLanding() {
  return `${shellHead("HIVE Hub")}
${header}
<main id="main">
  <section class="hero">
    <p class="eyebrow">CRM for service businesses</p>
    <h1>Run every side of your business from <em>one system</em>.</h1>
    <p>HIVE Hub keeps clients, jobs, projects, policies, and conversations organized in one place. Choose the workspace that matches your business below.</p>
  </section>

  <section class="hex-section" id="hex" aria-label="Choose your workspace">
    <div class="hex-wrap">
      <svg class="hex-outline" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        <polygon points="50,4 89.8,27 89.8,73 50,96 10.2,73 10.2,27" fill="none" stroke="var(--bg)" stroke-width="0.6" />
        <line x1="50" y1="4" x2="50" y2="50" stroke="var(--bg)" stroke-width="0.55" />
        <line x1="89.8" y1="27" x2="50" y2="50" stroke="var(--bg)" stroke-width="0.55" />
        <line x1="89.8" y1="73" x2="50" y2="50" stroke="var(--bg)" stroke-width="0.55" />
        <line x1="50" y1="96" x2="50" y2="50" stroke="var(--bg)" stroke-width="0.55" />
        <line x1="10.2" y1="73" x2="50" y2="50" stroke="var(--bg)" stroke-width="0.55" />
        <line x1="10.2" y1="27" x2="50" y2="50" stroke="var(--bg)" stroke-width="0.55" />
      </svg>

      <a class="wedge w6" href="/signup?vertical=insurance" aria-label="Insurance Broker — live, create your account">
        <span class="wedge-content">
          <svg class="wedge-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 3l7 3v5c0 4.6-3 7.7-7 10-4-2.3-7-5.4-7-10V6l7-3z"/><path d="M9 12l2 2 4-4"/></svg>
          <span class="wedge-label">Insurance Broker</span>
          <span class="wedge-sub">Life policies, beneficiaries, renewals</span>
          <span class="wedge-status status-live">Live</span>
        </span>
      </a>

      <a class="wedge w1" href="/signup?vertical=homeservice" aria-label="Home Service — live, create your account">
        <span class="wedge-content">
          <svg class="wedge-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3 11l9-7 9 7"/><path d="M5 10v9h14v-9"/><path d="M14 19v-5h-4v5"/></svg>
          <span class="wedge-label">Home Service</span>
          <span class="wedge-sub">Jobs, properties, invoices</span>
          <span class="wedge-status status-live">Live</span>
        </span>
      </a>

      <a class="wedge w5" href="/signup?vertical=construction" aria-label="Construction — live, create your account">
        <span class="wedge-content">
          <svg class="wedge-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 20l6.5-13L14 14"/><path d="M9 13h7l3 7"/><circle cx="17" cy="5" r="2"/></svg>
          <span class="wedge-label">Construction</span>
          <span class="wedge-sub">Projects, change orders, punch lists</span>
          <span class="wedge-status status-live">Live</span>
        </span>
      </a>

      <a class="wedge w2" href="/ai" aria-label="AI Assistant — preview">
        <span class="wedge-content">
          <svg class="wedge-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 3v3M12 18v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M3 12h3M18 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/><circle cx="12" cy="12" r="4"/></svg>
          <span class="wedge-label">AI Assistant</span>
          <span class="wedge-sub">Flags renewals, drafts messages</span>
          <span class="wedge-status status-preview">Preview</span>
        </span>
      </a>

      <a class="wedge w4" href="/pricing" aria-label="Subscriptions — manage your plan and billing">
        <span class="wedge-content">
          <svg class="wedge-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18"/><path d="M7 15h4"/></svg>
          <span class="wedge-label">Subscriptions</span>
          <span class="wedge-sub">Plans &amp; billing, upgrade anytime</span>
          <span class="wedge-status status-manage">Manage</span>
        </span>
      </a>

      <a class="wedge w3" href="/support" aria-label="Contact Support">
        <span class="wedge-content">
          <svg class="wedge-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 13a8 8 0 0116 0"/><rect x="2" y="13" width="5" height="6" rx="1.5"/><rect x="17" y="13" width="5" height="6" rx="1.5"/><path d="M20 19a4 4 0 01-4 3h-2"/></svg>
          <span class="wedge-label">Contact Support</span>
          <span class="wedge-sub">Talk to a real person</span>
        </span>
      </a>
    </div>

    <p class="hex-caption">Insurance Broker, Home Service, and Construction are all live — open any of them to work in it for real. The rest are previews of what's coming next.</p>

    <ul class="legend">
      <li class="legend-item"><span class="dot" aria-hidden="true"></span><strong>Insurance&nbsp;Broker</strong>&nbsp;— live now</li>
      <li class="legend-item"><span class="dot" aria-hidden="true"></span><strong>Home&nbsp;Service</strong>&nbsp;— live now</li>
      <li class="legend-item"><span class="dot" aria-hidden="true"></span><strong>Construction</strong>&nbsp;— live now</li>
      <li class="legend-item"><span class="dot" aria-hidden="true"></span><strong>Subscriptions</strong>&nbsp;— plans &amp; billing</li>
      <li class="legend-item"><span class="dot" aria-hidden="true"></span><strong>AI&nbsp;Assistant</strong>&nbsp;— early preview</li>
      <li class="legend-item"><span class="dot" aria-hidden="true"></span><strong>Support</strong>&nbsp;— always on</li>
    </ul>
  </section>
</main>
${footer}
</body>
</html>`;
}

function simplePage({ title, eyebrow, heading, lede, body, flash }) {
  return `${shellHead(title)}
${header}
<main id="main">
  <div class="simple-page">
    ${flash ? `<div class="flash-note">${flash}</div>` : ""}
    ${eyebrow ? `<p class="eyebrow">${eyebrow}</p>` : ""}
    <h1>${heading}</h1>
    ${lede ? `<p class="lede">${lede}</p>` : ""}
    ${body}
    <a class="back-link" href="/">&larr; Back to HIVE Hub</a>
  </div>
</main>
${footer}
</body>
</html>`;
}

module.exports = { renderLanding, simplePage };
