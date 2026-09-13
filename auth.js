// HIVE Hub — accounts & sessions (multi-tenant auth).
// Zero-dependency: password hashing uses Node's built-in crypto.scryptSync,
// sessions are opaque random tokens in a DB table + an httpOnly cookie.
// Shares the same SQLite connection as the vertical DB modules.
"use strict";

const crypto = require("node:crypto");
const { rawDb: db } = require("./db");

db.exec(`
  CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    business_name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    vertical TEXT NOT NULL,
    plan TEXT NOT NULL DEFAULT 'starter',
    subscription_status TEXT NOT NULL DEFAULT 'trialing',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
  );
`);

const VERTICALS = ["insurance", "homeservice", "construction"];
const VERTICAL_LABELS = { insurance: "Insurance Broker", homeservice: "Home Service", construction: "Construction" };
const VERTICAL_HOME = { insurance: "/app", homeservice: "/hs", construction: "/co" };

const SESSION_COOKIE = "hh_session";
const SESSION_DAYS = 30;

// ---------- Passwords ----------

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return { salt, hash };
}

function verifyPassword(password, salt, hash) {
  const candidate = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, "hex");
  if (candidate.length !== expected.length) return false;
  return crypto.timingSafeEqual(candidate, expected);
}

// ---------- Accounts ----------

function getAccountByEmail(email) {
  return db.prepare(`SELECT * FROM accounts WHERE email = ?`).get((email || "").trim().toLowerCase());
}

function getAccountById(id) {
  return db.prepare(`SELECT * FROM accounts WHERE id = ?`).get(id);
}

// Throws a plain Error with a user-facing message on bad input — callers
// should catch and show err.message rather than a generic 500.
function createAccount({ business_name, email, password, vertical }) {
  const cleanEmail = (email || "").trim().toLowerCase();
  const cleanName = (business_name || "").trim();
  if (!cleanName) throw new Error("Business name is required.");
  if (!cleanEmail || !cleanEmail.includes("@")) throw new Error("A valid email is required.");
  if (!password || password.length < 8) throw new Error("Password must be at least 8 characters.");
  if (!VERTICALS.includes(vertical)) throw new Error("Pick which workspace you're signing up for.");
  if (getAccountByEmail(cleanEmail)) throw new Error("An account with that email already exists — try logging in instead.");

  const { salt, hash } = hashPassword(password);
  const info = db
    .prepare(
      `INSERT INTO accounts (business_name, email, password_hash, password_salt, vertical) VALUES (?, ?, ?, ?, ?)`
    )
    .run(cleanName, cleanEmail, hash, salt, vertical);
  return Number(info.lastInsertRowid);
}

// ---------- Sessions ----------

function createSession(accountId) {
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  db.prepare(`INSERT INTO sessions (token, account_id, expires_at) VALUES (?, ?, ?)`).run(token, accountId, expiresAt);
  return token;
}

function getSessionAccount(token) {
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT a.* FROM sessions s JOIN accounts a ON a.id = s.account_id
       WHERE s.token = ? AND s.expires_at > datetime('now')`
    )
    .get(token);
  return row || null;
}

function deleteSession(token) {
  if (!token) return;
  db.prepare(`DELETE FROM sessions WHERE token = ?`).run(token);
}

// ---------- Cookies ----------

function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  header.split(";").forEach((pair) => {
    const idx = pair.indexOf("=");
    if (idx === -1) return;
    const key = pair.slice(0, idx).trim();
    const val = pair.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(val);
  });
  return out;
}

function sessionCookieHeader(token) {
  const maxAge = SESSION_DAYS * 24 * 60 * 60;
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; Path=/; Max-Age=${maxAge}; SameSite=Lax`;
}

function clearCookieHeader() {
  return `${SESSION_COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`;
}

module.exports = {
  VERTICALS,
  VERTICAL_LABELS,
  VERTICAL_HOME,
  SESSION_COOKIE,
  hashPassword,
  verifyPassword,
  getAccountByEmail,
  getAccountById,
  createAccount,
  createSession,
  getSessionAccount,
  deleteSession,
  parseCookies,
  sessionCookieHeader,
  clearCookieHeader,
};
