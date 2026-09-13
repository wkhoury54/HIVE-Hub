// HIVE Hub — database layer
// Uses Node's built-in `node:sqlite` (no external dependencies required).
"use strict";

const { DatabaseSync } = require("node:sqlite");
const path = require("node:path");

const DB_PATH = path.join(__dirname, "data", "hivehub.db");
require("node:fs").mkdirSync(path.join(__dirname, "data"), { recursive: true });

const db = new DatabaseSync(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS clients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT,
    phone TEXT,
    address TEXT,
    date_of_birth TEXT,
    notes TEXT,
    pipeline_stage TEXT NOT NULL DEFAULT 'active',
    next_followup TEXT,
    followup_note TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS policies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    policy_type TEXT NOT NULL,
    carrier TEXT NOT NULL,
    monthly_premium REAL NOT NULL DEFAULT 0,
    coverage TEXT,
    policy_number TEXT,
    effective_date TEXT,
    beneficiary TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    commission_rate REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    channel TEXT NOT NULL DEFAULT 'email',
    subject TEXT,
    body TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'logged',
    provider_id TEXT,
    error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Shared across both verticals (Insurance Broker + Home Service) so one
  -- dedupe table covers the whole app. Records that a given AI-drafted nudge
  -- (identified by its stable trigger key, e.g. "job:12:reminder") has
  -- already been auto-sent for a client, so Autopilot never sends the same
  -- nudge twice even though it re-scans on every tick.
  CREATE TABLE IF NOT EXISTS autopilot_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    vertical TEXT NOT NULL,
    client_id INTEGER NOT NULL,
    trigger_key TEXT NOT NULL,
    sent_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(vertical, client_id, trigger_key)
  );
`);

// Lightweight migrations for dbs created before these columns existed.
for (const stmt of [
  `ALTER TABLE clients ADD COLUMN date_of_birth TEXT`,
  `ALTER TABLE policies ADD COLUMN beneficiary TEXT`,
  `ALTER TABLE clients ADD COLUMN pipeline_stage TEXT NOT NULL DEFAULT 'active'`,
  `ALTER TABLE clients ADD COLUMN next_followup TEXT`,
  `ALTER TABLE clients ADD COLUMN followup_note TEXT`,
  `ALTER TABLE policies ADD COLUMN commission_rate REAL NOT NULL DEFAULT 0`,
  `ALTER TABLE messages ADD COLUMN status TEXT NOT NULL DEFAULT 'logged'`,
  `ALTER TABLE messages ADD COLUMN provider_id TEXT`,
  `ALTER TABLE messages ADD COLUMN error TEXT`,
  `ALTER TABLE clients ADD COLUMN autopilot_enabled INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE clients ADD COLUMN account_id INTEGER`,
]) {
  try {
    db.exec(stmt);
  } catch (e) {
    // column already exists — fine
  }
}

// ---------- Clients ----------

const PIPELINE_STAGES = ["lead", "quoted", "applied", "underwriting", "active", "lapsed"];

function listClients(accountId, search, stage) {
  const clauses = [`account_id = ?`];
  const args = [accountId];
  if (search) {
    clauses.push(`(name LIKE ? OR email LIKE ? OR phone LIKE ?)`);
    const like = `%${search}%`;
    args.push(like, like, like);
  }
  if (stage) {
    clauses.push(`pipeline_stage = ?`);
    args.push(stage);
  }
  const where = `WHERE ${clauses.join(" AND ")}`;
  return db.prepare(`SELECT * FROM clients ${where} ORDER BY name ASC`).all(...args);
}

function getClient(accountId, id) {
  return db.prepare(`SELECT * FROM clients WHERE id = ? AND account_id = ?`).get(id, accountId);
}

function createClient({ account_id, name, email, phone, address, date_of_birth, notes, pipeline_stage, next_followup, followup_note }) {
  const stmt = db.prepare(
    `INSERT INTO clients (account_id, name, email, phone, address, date_of_birth, notes, pipeline_stage, next_followup, followup_note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const info = stmt.run(
    account_id,
    name,
    email || null,
    phone || null,
    address || null,
    date_of_birth || null,
    notes || null,
    PIPELINE_STAGES.includes(pipeline_stage) ? pipeline_stage : "active",
    next_followup || null,
    followup_note || null
  );
  return Number(info.lastInsertRowid);
}

function updateClient(id, { name, email, phone, address, date_of_birth, notes, pipeline_stage, next_followup, followup_note }) {
  db.prepare(
    `UPDATE clients SET name = ?, email = ?, phone = ?, address = ?, date_of_birth = ?, notes = ?, pipeline_stage = ?, next_followup = ?, followup_note = ? WHERE id = ?`
  ).run(
    name,
    email || null,
    phone || null,
    address || null,
    date_of_birth || null,
    notes || null,
    PIPELINE_STAGES.includes(pipeline_stage) ? pipeline_stage : "active",
    next_followup || null,
    followup_note || null,
    id
  );
}

function listFollowupsDue(accountId, withinDays = 7) {
  return db
    .prepare(
      `SELECT * FROM clients
       WHERE account_id = ? AND next_followup IS NOT NULL AND date(next_followup) <= date('now', '+' || ? || ' days')
       ORDER BY date(next_followup) ASC`
    )
    .all(accountId, withinDays);
}

function deleteClient(accountId, id) {
  db.prepare(`DELETE FROM clients WHERE id = ? AND account_id = ?`).run(id, accountId);
}

// ---------- Policies ----------

function listPoliciesForClient(clientId) {
  return db
    .prepare(`SELECT * FROM policies WHERE client_id = ? ORDER BY created_at DESC`)
    .all(clientId);
}

// Scoped through the owning client, since a policy has no account_id of its
// own — this is what keeps /app/policies/:id/* from leaking another
// business's policy by guessing an id.
function getPolicy(accountId, id) {
  return db
    .prepare(
      `SELECT p.* FROM policies p JOIN clients c ON c.id = p.client_id
       WHERE p.id = ? AND c.account_id = ?`
    )
    .get(id, accountId);
}

function createPolicy({ client_id, policy_type, carrier, monthly_premium, coverage, policy_number, effective_date, beneficiary, status, commission_rate }) {
  const stmt = db.prepare(
    `INSERT INTO policies (client_id, policy_type, carrier, monthly_premium, coverage, policy_number, effective_date, beneficiary, status, commission_rate)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const info = stmt.run(
    client_id,
    policy_type,
    carrier,
    monthly_premium || 0,
    coverage || null,
    policy_number || null,
    effective_date || null,
    beneficiary || null,
    status || "active",
    commission_rate || 0
  );
  return Number(info.lastInsertRowid);
}

function updatePolicy(id, { policy_type, carrier, monthly_premium, coverage, policy_number, effective_date, beneficiary, status, commission_rate }) {
  db.prepare(
    `UPDATE policies SET policy_type = ?, carrier = ?, monthly_premium = ?, coverage = ?, policy_number = ?, effective_date = ?, beneficiary = ?, status = ?, commission_rate = ? WHERE id = ?`
  ).run(
    policy_type,
    carrier,
    monthly_premium || 0,
    coverage || null,
    policy_number || null,
    effective_date || null,
    beneficiary || null,
    status || "active",
    commission_rate || 0,
    id
  );
}

function deletePolicy(id) {
  db.prepare(`DELETE FROM policies WHERE id = ?`).run(id);
}

// ---------- Messages ----------

function listMessagesForClient(clientId) {
  return db
    .prepare(`SELECT * FROM messages WHERE client_id = ? ORDER BY created_at DESC`)
    .all(clientId);
}

function createMessage({ client_id, channel, subject, body }) {
  const stmt = db.prepare(
    `INSERT INTO messages (client_id, channel, subject, body) VALUES (?, ?, ?, ?)`
  );
  const info = stmt.run(client_id, channel === "sms" ? "sms" : "email", subject || null, body);
  return Number(info.lastInsertRowid);
}

function listRecentMessages(accountId, limit = 15) {
  return db
    .prepare(
      `SELECT m.*, c.name AS client_name FROM messages m
       JOIN clients c ON c.id = m.client_id
       WHERE c.account_id = ?
       ORDER BY m.created_at DESC LIMIT ?`
    )
    .all(accountId, limit);
}

function updateMessageStatus(id, { status, provider_id, error }) {
  db.prepare(`UPDATE messages SET status = ?, provider_id = ?, error = ? WHERE id = ?`).run(
    status,
    provider_id || null,
    error || null,
    id
  );
}

// ---------- Dashboard aggregates ----------

function dashboardStats(accountId, { field = "effective", start, end } = {}) {
  const totalClients = db.prepare(`SELECT COUNT(*) AS c FROM clients WHERE account_id = ?`).get(accountId).c;
  const totalPolicies = db
    .prepare(
      `SELECT COUNT(*) AS c FROM policies p JOIN clients c ON c.id = p.client_id WHERE c.account_id = ? AND p.status = 'active'`
    )
    .get(accountId).c;

  const dateCol = field === "submitted" ? "p.created_at" : "p.effective_date";
  let production = 0;
  let productionCount = 0;
  let estCommission = 0;
  if (start && end) {
    const row = db
      .prepare(
        `SELECT COALESCE(SUM(p.monthly_premium * 12), 0) AS s, COUNT(*) AS c,
                COALESCE(SUM(p.monthly_premium * 12 * p.commission_rate / 100.0), 0) AS commission
         FROM policies p JOIN clients c ON c.id = p.client_id
         WHERE c.account_id = ? AND ${dateCol} IS NOT NULL AND date(${dateCol}) BETWEEN date(?) AND date(?)`
      )
      .get(accountId, start, end);
    production = row.s;
    productionCount = row.c;
    estCommission = row.commission;
  }

  const byType = db
    .prepare(
      `SELECT p.policy_type, COUNT(*) AS count, COALESCE(SUM(p.monthly_premium),0) AS premium
       FROM policies p JOIN clients c ON c.id = p.client_id
       WHERE c.account_id = ? AND p.status = 'active' GROUP BY p.policy_type ORDER BY premium DESC`
    )
    .all(accountId);
  const recentClients = db.prepare(`SELECT * FROM clients WHERE account_id = ? ORDER BY created_at DESC LIMIT 5`).all(accountId);
  return { totalClients, totalPolicies, production, productionCount, estCommission, byType, recentClients };
}

function listActivePoliciesWithClients(accountId) {
  return db
    .prepare(
      `SELECT p.*, c.id AS client_id, c.name AS client_name
       FROM policies p JOIN clients c ON c.id = p.client_id
       WHERE c.account_id = ? AND p.effective_date IS NOT NULL AND p.status != 'lapsed'`
    )
    .all(accountId);
}

// ---------- Autopilot ----------

function setAutopilotEnabled(clientId, enabled) {
  db.prepare(`UPDATE clients SET autopilot_enabled = ? WHERE id = ?`).run(enabled ? 1 : 0, clientId);
}

// accountId omitted (as the background Autopilot sweep does) means "every
// account" — everywhere else, callers pass it to scope the count/list to
// their own business.
function listAutopilotEnabledClients(accountId) {
  if (accountId) return db.prepare(`SELECT * FROM clients WHERE autopilot_enabled = 1 AND account_id = ?`).all(accountId);
  return db.prepare(`SELECT * FROM clients WHERE autopilot_enabled = 1`).all();
}

// Has this exact nudge already been auto-sent for this client? Checked before
// every autopilot send so the same trigger never fires twice.
function hasAutopilotSent(vertical, clientId, triggerKey) {
  return !!db
    .prepare(`SELECT 1 FROM autopilot_log WHERE vertical = ? AND client_id = ? AND trigger_key = ?`)
    .get(vertical, clientId, triggerKey);
}

function recordAutopilotSent(vertical, clientId, triggerKey) {
  db.prepare(`INSERT OR IGNORE INTO autopilot_log (vertical, client_id, trigger_key) VALUES (?, ?, ?)`).run(vertical, clientId, triggerKey);
}

function listAutopilotLog(limit = 50) {
  return db.prepare(`SELECT * FROM autopilot_log ORDER BY sent_at DESC LIMIT ?`).all(limit);
}

// Every policy regardless of status, for CSV export.
function listAllPoliciesWithClients(accountId) {
  return db
    .prepare(
      `SELECT p.*, c.name AS client_name, c.email AS client_email, c.phone AS client_phone
       FROM policies p JOIN clients c ON c.id = p.client_id
       WHERE c.account_id = ?
       ORDER BY c.name ASC, p.policy_type ASC`
    )
    .all(accountId);
}

module.exports = {
  rawDb: db,
  PIPELINE_STAGES,
  listClients,
  getClient,
  createClient,
  updateClient,
  deleteClient,
  listFollowupsDue,
  listPoliciesForClient,
  getPolicy,
  createPolicy,
  updatePolicy,
  deletePolicy,
  listActivePoliciesWithClients,
  listAllPoliciesWithClients,
  setAutopilotEnabled,
  listAutopilotEnabledClients,
  hasAutopilotSent,
  recordAutopilotSent,
  listAutopilotLog,
  listMessagesForClient,
  createMessage,
  updateMessageStatus,
  listRecentMessages,
  dashboardStats,
};
