"use strict";
// Real email sending via the Resend REST API — no SDK, no dependency, just
// Node's built-in https module, so this still runs with zero npm packages.
//
// Setup:
//   1. Sign up at https://resend.com and grab an API key (starts with "re_").
//   2. For real client emails, add + verify your own sending domain in the
//      Resend dashboard, then set RESEND_FROM to an address on that domain
//      (e.g. "Jordan Ellis <jordan@youragency.com>").
//   3. Until you verify a domain, Resend's shared onboarding@resend.dev
//      address only delivers to the email you signed up to Resend with —
//      fine for testing, not for real clients.
//   4. Set the environment variable(s) before starting the server, e.g.:
//        RESEND_API_KEY=re_xxx RESEND_FROM="HIVE Hub <you@youragency.com>" node server.js
//
// With no RESEND_API_KEY set, sendEmail() resolves immediately as "skipped"
// so the app keeps working (messages are just logged, not delivered).

const https = require("node:https");

const RESEND_TIMEOUT_MS = 10000;

function sendEmail({ to, subject, text }) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM || "HIVE Hub <onboarding@resend.dev>";

  if (!apiKey) {
    return Promise.resolve({
      ok: false,
      skipped: true,
      error: "No RESEND_API_KEY configured — message logged only, not delivered.",
    });
  }
  if (!to) {
    return Promise.resolve({ ok: false, error: "This client has no email address on file." });
  }

  const payload = JSON.stringify({
    from,
    to: [to],
    subject: subject || "Message from your broker",
    text: text || "",
  });

  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: "api.resend.com",
        path: "/emails",
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
        timeout: RESEND_TIMEOUT_MS,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          let parsed = null;
          try {
            parsed = JSON.parse(data);
          } catch (e) {
            // non-JSON response — fall through with raw text below
          }
          if (res.statusCode >= 200 && res.statusCode < 300 && parsed && parsed.id) {
            resolve({ ok: true, id: parsed.id });
          } else {
            const message = (parsed && (parsed.message || parsed.error)) || data || `HTTP ${res.statusCode}`;
            resolve({ ok: false, error: typeof message === "string" ? message : JSON.stringify(message) });
          }
        });
      }
    );
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, error: "Timed out reaching the email provider." });
    });
    req.on("error", (err) => {
      resolve({ ok: false, error: err.message || "Could not reach the email provider." });
    });
    req.write(payload);
    req.end();
  });
}

module.exports = { sendEmail };
