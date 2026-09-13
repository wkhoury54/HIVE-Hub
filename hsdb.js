// HIVE Hub — Home Service vertical database layer.
// Shares the same SQLite file/connection as the Insurance Broker vertical
// (see db.js) but keeps its own tables (hs_*) so the two verticals never
// collide, the way separate customer bases would in a real multi-vertical
// product.
"use strict";

const { rawDb: db } = require("./db");

db.exec(`
  CREATE TABLE IF NOT EXISTS hs_clients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT,
    phone TEXT,
    client_type TEXT NOT NULL DEFAULT 'residential',
    source TEXT,
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS hs_properties (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id INTEGER NOT NULL REFERENCES hs_clients(id) ON DELETE CASCADE,
    label TEXT NOT NULL,
    address TEXT,
    access_notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS hs_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id INTEGER NOT NULL REFERENCES hs_clients(id) ON DELETE CASCADE,
    property_id INTEGER REFERENCES hs_properties(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    job_type TEXT NOT NULL DEFAULT 'Repair',
    line_items TEXT NOT NULL DEFAULT '[]',
    scheduled_date TEXT,
    scheduled_window TEXT,
    assigned_tech TEXT,
    recurrence TEXT NOT NULL DEFAULT 'none',
    stage TEXT NOT NULL DEFAULT 'new_request',
    internal_notes TEXT,
    customer_notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS hs_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id INTEGER NOT NULL REFERENCES hs_clients(id) ON DELETE CASCADE,
    channel TEXT NOT NULL DEFAULT 'email',
    subject TEXT,
    body TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'logged',
    provider_id TEXT,
    error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS hs_price_book (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    default_price REAL NOT NULL DEFAULT 0,
    unit TEXT NOT NULL DEFAULT 'flat',
    description TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Lightweight migrations for dbs created before these columns existed.
for (const stmt of [
  `ALTER TABLE hs_clients ADD COLUMN autopilot_enabled INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE hs_clients ADD COLUMN account_id INTEGER`,
  `ALTER TABLE hs_price_book ADD COLUMN account_id INTEGER`,
]) {
  try {
    db.exec(stmt);
  } catch (e) {
    // column already exists — fine
  }
}

// Seeds a starter price book for one account, so the feature isn't an empty
// shell on first login. Called once per new Home Service account (see
// seedPriceBookFor below) rather than unconditionally, now that price books
// are per-account.
function seedPriceBookFor(accountId) {
  const seedInsert = db.prepare(
    `INSERT INTO hs_price_book (account_id, name, default_price, unit, description) VALUES (?, ?, ?, ?, ?)`
  );
  [
    ["Service call / diagnostic", 89, "flat", "Standard trip charge, includes first 30 minutes on site"],
    ["Standard labor hour", 125, "hour", "Base labor rate for repairs and installs"],
    ["Emergency / after-hours labor hour", 195, "hour", "Nights, weekends, and same-day emergency calls"],
    ["Drain/line cleaning", 175, "flat", "Standard clog clearing, single line"],
    ["Water heater install (standard)", 1450, "flat", "Tank swap, standard venting, up to 50 gal"],
    ["HVAC seasonal tune-up", 149, "flat", "Filter, coils, refrigerant check, safety inspection"],
    ["Recurring maintenance visit", 99, "flat", "Standard recurring plan visit"],
  ].forEach((row) => seedInsert.run(accountId, ...row));
}

const JOB_STAGES = ["new_request", "quoted", "scheduled", "in_progress", "completed", "invoiced", "paid"];
const JOB_SIDE_STAGES = ["on_hold", "cancelled"];
const JOB_STAGE_LABELS = {
  new_request: "New request",
  quoted: "Quoted",
  scheduled: "Scheduled",
  in_progress: "In progress",
  completed: "Completed",
  invoiced: "Invoiced",
  paid: "Paid",
  on_hold: "On hold",
  cancelled: "Cancelled",
};
const JOB_TYPES = ["Repair", "Installation", "Maintenance", "Inspection", "Cleaning", "Other"];
const RECURRENCE_OPTIONS = ["none", "weekly", "biweekly", "monthly", "quarterly", "annual"];
const RECURRENCE_LABELS = {
  none: "One-time",
  weekly: "Weekly",
  biweekly: "Every 2 weeks",
  monthly: "Monthly",
  quarterly: "Quarterly",
  annual: "Annual",
};
const CLIENT_TYPES = ["residential", "commercial"];

// ---------- Line items ----------

function parseLineItems(json) {
  try {
    const items = JSON.parse(json || "[]");
    return Array.isArray(items) ? items : [];
  } catch (e) {
    return [];
  }
}

function lineItemsTotal(json) {
  return parseLineItems(json).reduce((sum, it) => sum + (Number(it.qty) || 0) * (Number(it.price) || 0), 0);
}

// ---------- Clients ----------

function listClients(accountId, search) {
  if (search) {
    const like = `%${search}%`;
    return db
      .prepare(`SELECT * FROM hs_clients WHERE account_id = ? AND (name LIKE ? OR email LIKE ? OR phone LIKE ?) ORDER BY name ASC`)
      .all(accountId, like, like, like);
  }
  return db.prepare(`SELECT * FROM hs_clients WHERE account_id = ? ORDER BY name ASC`).all(accountId);
}

function getClient(accountId, id) {
  return db.prepare(`SELECT * FROM hs_clients WHERE id = ? AND account_id = ?`).get(id, accountId);
}

function createClient({ account_id, name, email, phone, client_type, source, notes }) {
  const info = db
    .prepare(`INSERT INTO hs_clients (account_id, name, email, phone, client_type, source, notes) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(account_id, name, email || null, phone || null, CLIENT_TYPES.includes(client_type) ? client_type : "residential", source || null, notes || null);
  return Number(info.lastInsertRowid);
}

function updateClient(id, { name, email, phone, client_type, source, notes }) {
  db.prepare(`UPDATE hs_clients SET name = ?, email = ?, phone = ?, client_type = ?, source = ?, notes = ? WHERE id = ?`).run(
    name,
    email || null,
    phone || null,
    CLIENT_TYPES.includes(client_type) ? client_type : "residential",
    source || null,
    notes || null,
    id
  );
}

function deleteClient(accountId, id) {
  db.prepare(`DELETE FROM hs_clients WHERE id = ? AND account_id = ?`).run(id, accountId);
}

// ---------- Properties ----------

function listPropertiesForClient(clientId) {
  return db.prepare(`SELECT * FROM hs_properties WHERE client_id = ? ORDER BY created_at ASC`).all(clientId);
}

// Scoped through the owning client — a property has no account_id of its own.
function getProperty(accountId, id) {
  return db
    .prepare(
      `SELECT p.* FROM hs_properties p JOIN hs_clients c ON c.id = p.client_id
       WHERE p.id = ? AND c.account_id = ?`
    )
    .get(id, accountId);
}

function createProperty({ client_id, label, address, access_notes }) {
  const info = db
    .prepare(`INSERT INTO hs_properties (client_id, label, address, access_notes) VALUES (?, ?, ?, ?)`)
    .run(client_id, label, address || null, access_notes || null);
  return Number(info.lastInsertRowid);
}

function updateProperty(id, { label, address, access_notes }) {
  db.prepare(`UPDATE hs_properties SET label = ?, address = ?, access_notes = ? WHERE id = ?`).run(
    label,
    address || null,
    access_notes || null,
    id
  );
}

function deleteProperty(id) {
  db.prepare(`DELETE FROM hs_properties WHERE id = ?`).run(id);
}

// ---------- Jobs ----------

function listJobsForClient(clientId) {
  return db
    .prepare(
      `SELECT j.*, p.label AS property_label FROM hs_jobs j
       LEFT JOIN hs_properties p ON p.id = j.property_id
       WHERE j.client_id = ? ORDER BY j.created_at DESC`
    )
    .all(clientId);
}

// ---------- Autopilot ----------
// The dedupe log itself (autopilot_log) lives in db.js since it's shared
// across both verticals over the same underlying connection.

function setAutopilotEnabled(clientId, enabled) {
  db.prepare(`UPDATE hs_clients SET autopilot_enabled = ? WHERE id = ?`).run(enabled ? 1 : 0, clientId);
}

// accountId omitted (as the background Autopilot sweep does) means "every
// account" — everywhere else, callers pass it to scope the count/list to
// their own business.
function listAutopilotEnabledClients(accountId) {
  if (accountId) return db.prepare(`SELECT * FROM hs_clients WHERE autopilot_enabled = 1 AND account_id = ?`).all(accountId);
  return db.prepare(`SELECT * FROM hs_clients WHERE autopilot_enabled = 1`).all();
}

// Distinct list of technician names that have ever been assigned to a job —
// used to populate the "Filter by technician" dropdown without hardcoding names.
function listAssignedTechs(accountId) {
  return db
    .prepare(
      `SELECT DISTINCT j.assigned_tech FROM hs_jobs j JOIN hs_clients c ON c.id = j.client_id
       WHERE c.account_id = ? AND j.assigned_tech IS NOT NULL AND j.assigned_tech != '' ORDER BY j.assigned_tech ASC`
    )
    .all(accountId)
    .map((r) => r.assigned_tech);
}

function listAllJobs(accountId, { stage, tech, search } = {}) {
  const clauses = [`c.account_id = ?`];
  const args = [accountId];
  if (stage) {
    clauses.push(`j.stage = ?`);
    args.push(stage);
  }
  if (tech) {
    clauses.push(`j.assigned_tech = ?`);
    args.push(tech);
  }
  if (search) {
    clauses.push(`(j.title LIKE ? OR c.name LIKE ?)`);
    const like = `%${search}%`;
    args.push(like, like);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return db
    .prepare(
      `SELECT j.*, c.name AS client_name, p.label AS property_label FROM hs_jobs j
       JOIN hs_clients c ON c.id = j.client_id
       LEFT JOIN hs_properties p ON p.id = j.property_id
       ${where}
       ORDER BY
         CASE WHEN j.scheduled_date IS NULL THEN 1 ELSE 0 END,
         j.scheduled_date ASC,
         j.created_at DESC`
    )
    .all(...args);
}

// Every open (non-terminal) job across all clients — used for the dashboard
// and for the Communication hub's "who needs outreach" heuristic.
function listOpenJobsWithClients(accountId) {
  return db
    .prepare(
      `SELECT j.*, c.name AS client_name, c.email AS client_email, p.label AS property_label
       FROM hs_jobs j
       JOIN hs_clients c ON c.id = j.client_id
       LEFT JOIN hs_properties p ON p.id = j.property_id
       WHERE c.account_id = ? AND j.stage NOT IN ('cancelled')
       ORDER BY j.updated_at DESC`
    )
    .all(accountId);
}

// Scoped through the owning client — a job has no account_id of its own.
function getJob(accountId, id) {
  const job = db
    .prepare(
      `SELECT j.*, c.name AS client_name, p.label AS property_label, p.address AS property_address
       FROM hs_jobs j
       JOIN hs_clients c ON c.id = j.client_id
       LEFT JOIN hs_properties p ON p.id = j.property_id
       WHERE j.id = ? AND c.account_id = ?`
    )
    .get(id, accountId);
  return job;
}

function createJob({ client_id, property_id, title, job_type, line_items, scheduled_date, scheduled_window, assigned_tech, recurrence, stage, internal_notes, customer_notes }) {
  const info = db
    .prepare(
      `INSERT INTO hs_jobs (client_id, property_id, title, job_type, line_items, scheduled_date, scheduled_window, assigned_tech, recurrence, stage, internal_notes, customer_notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      client_id,
      property_id || null,
      title,
      JOB_TYPES.includes(job_type) ? job_type : "Repair",
      line_items || "[]",
      scheduled_date || null,
      scheduled_window || null,
      assigned_tech || null,
      RECURRENCE_OPTIONS.includes(recurrence) ? recurrence : "none",
      [...JOB_STAGES, ...JOB_SIDE_STAGES].includes(stage) ? stage : "new_request",
      internal_notes || null,
      customer_notes || null
    );
  return Number(info.lastInsertRowid);
}

function updateJob(id, { property_id, title, job_type, line_items, scheduled_date, scheduled_window, assigned_tech, recurrence, stage, internal_notes, customer_notes }) {
  db.prepare(
    `UPDATE hs_jobs SET property_id = ?, title = ?, job_type = ?, line_items = ?, scheduled_date = ?, scheduled_window = ?, assigned_tech = ?, recurrence = ?, stage = ?, internal_notes = ?, customer_notes = ?, updated_at = datetime('now')
     WHERE id = ?`
  ).run(
    property_id || null,
    title,
    JOB_TYPES.includes(job_type) ? job_type : "Repair",
    line_items || "[]",
    scheduled_date || null,
    scheduled_window || null,
    assigned_tech || null,
    RECURRENCE_OPTIONS.includes(recurrence) ? recurrence : "none",
    [...JOB_STAGES, ...JOB_SIDE_STAGES].includes(stage) ? stage : "new_request",
    internal_notes || null,
    customer_notes || null,
    id
  );
}

function updateJobStage(id, stage) {
  if (![...JOB_STAGES, ...JOB_SIDE_STAGES].includes(stage)) return;
  db.prepare(`UPDATE hs_jobs SET stage = ?, updated_at = datetime('now') WHERE id = ?`).run(stage, id);
}

function deleteJob(id) {
  db.prepare(`DELETE FROM hs_jobs WHERE id = ?`).run(id);
}

// ---------- Messages ----------

function listMessagesForClient(clientId) {
  return db.prepare(`SELECT * FROM hs_messages WHERE client_id = ? ORDER BY created_at DESC`).all(clientId);
}

function createMessage({ client_id, channel, subject, body }) {
  const info = db
    .prepare(`INSERT INTO hs_messages (client_id, channel, subject, body) VALUES (?, ?, ?, ?)`)
    .run(client_id, channel === "sms" ? "sms" : "email", subject || null, body);
  return Number(info.lastInsertRowid);
}

function updateMessageStatus(id, { status, provider_id, error }) {
  db.prepare(`UPDATE hs_messages SET status = ?, provider_id = ?, error = ? WHERE id = ?`).run(
    status,
    provider_id || null,
    error || null,
    id
  );
}

function listRecentMessages(accountId, limit = 15) {
  return db
    .prepare(
      `SELECT m.*, c.name AS client_name FROM hs_messages m
       JOIN hs_clients c ON c.id = m.client_id
       WHERE c.account_id = ?
       ORDER BY m.created_at DESC LIMIT ?`
    )
    .all(accountId, limit);
}

// ---------- Price Book ----------

const PRICE_BOOK_UNITS = ["flat", "hour"];
const PRICE_BOOK_UNIT_LABELS = { flat: "Flat rate", hour: "Per hour" };

function listPriceBook(accountId) {
  return db.prepare(`SELECT * FROM hs_price_book WHERE account_id = ? ORDER BY name ASC`).all(accountId);
}

function getPriceBookItem(accountId, id) {
  return db.prepare(`SELECT * FROM hs_price_book WHERE id = ? AND account_id = ?`).get(id, accountId);
}

function createPriceBookItem({ account_id, name, default_price, unit, description }) {
  const info = db
    .prepare(`INSERT INTO hs_price_book (account_id, name, default_price, unit, description) VALUES (?, ?, ?, ?, ?)`)
    .run(account_id, name, Number(default_price) || 0, PRICE_BOOK_UNITS.includes(unit) ? unit : "flat", description || null);
  return Number(info.lastInsertRowid);
}

function updatePriceBookItem(accountId, id, { name, default_price, unit, description }) {
  db.prepare(`UPDATE hs_price_book SET name = ?, default_price = ?, unit = ?, description = ? WHERE id = ? AND account_id = ?`).run(
    name,
    Number(default_price) || 0,
    PRICE_BOOK_UNITS.includes(unit) ? unit : "flat",
    description || null,
    id,
    accountId
  );
}

function deletePriceBookItem(accountId, id) {
  db.prepare(`DELETE FROM hs_price_book WHERE id = ? AND account_id = ?`).run(id, accountId);
}

// ---------- Client lifetime value & overdue invoices ----------

// Overdue = invoiced but not yet paid, and it's been at least this many days
// since the job last moved (i.e. since it was invoiced).
const OVERDUE_INVOICE_DAYS = 14;

function clientStats(clientId) {
  const jobs = db.prepare(`SELECT stage, line_items, updated_at FROM hs_jobs WHERE client_id = ?`).all(clientId);
  const paidJobs = jobs.filter((j) => j.stage === "paid");
  const lifetimeValue = paidJobs.reduce((sum, j) => sum + lineItemsTotal(j.line_items), 0);
  const overdueInvoices = jobs.filter(
    (j) => j.stage === "invoiced" && daysSince(j.updated_at) >= OVERDUE_INVOICE_DAYS
  ).length;
  return {
    jobCount: jobs.length,
    completedJobCount: jobs.filter((j) => ["completed", "invoiced", "paid"].includes(j.stage)).length,
    lifetimeValue,
    overdueInvoices,
  };
}

function daysSince(sqliteDatetime) {
  if (!sqliteDatetime) return 0;
  const then = new Date(sqliteDatetime.replace(" ", "T") + "Z").getTime();
  if (Number.isNaN(then)) return 0;
  return Math.floor((Date.now() - then) / (1000 * 60 * 60 * 24));
}

// All invoiced-but-unpaid jobs older than the overdue threshold, across every
// client — used to flag collections risk on the dashboard and Communication hub.
function listOverdueInvoices(accountId) {
  return db
    .prepare(
      `SELECT j.*, c.name AS client_name, c.email AS client_email
       FROM hs_jobs j
       JOIN hs_clients c ON c.id = j.client_id
       WHERE c.account_id = ? AND j.stage = 'invoiced'
       ORDER BY j.updated_at ASC`
    )
    .all(accountId)
    .map((j) => ({ ...j, amount: lineItemsTotal(j.line_items), daysOverdue: daysSince(j.updated_at) }))
    .filter((j) => j.daysOverdue >= OVERDUE_INVOICE_DAYS);
}

// ---------- Calendar schedule view ----------

// All non-cancelled jobs with a scheduled_date anywhere in [startDate, endDate]
// (inclusive, "YYYY-MM-DD"), for a month-grid or single-day view.
function listJobsInRange(accountId, startDate, endDate, { tech } = {}) {
  const clauses = [
    `c.account_id = ?`,
    `j.scheduled_date IS NOT NULL`,
    `date(j.scheduled_date) BETWEEN date(?) AND date(?)`,
    `j.stage NOT IN ('cancelled')`,
  ];
  const args = [accountId, startDate, endDate];
  if (tech) {
    clauses.push(`j.assigned_tech = ?`);
    args.push(tech);
  }
  return db
    .prepare(
      `SELECT j.*, c.name AS client_name, c.phone AS client_phone, p.label AS property_label, p.address AS property_address
       FROM hs_jobs j
       JOIN hs_clients c ON c.id = j.client_id
       LEFT JOIN hs_properties p ON p.id = j.property_id
       WHERE ${clauses.join(" AND ")}
       ORDER BY j.scheduled_date ASC, j.scheduled_window ASC`
    )
    .all(...args);
}

// All non-cancelled jobs scheduled on exactly one day — used by the schedule's
// day-detail view.
function listJobsForDay(accountId, dateStr) {
  return listJobsInRange(accountId, dateStr, dateStr);
}

// ---------- Dashboard aggregates ----------

function dashboardStats(accountId) {
  const totalClients = db.prepare(`SELECT COUNT(*) AS c FROM hs_clients WHERE account_id = ?`).get(accountId).c;
  const totalProperties = db
    .prepare(
      `SELECT COUNT(*) AS c FROM hs_properties p JOIN hs_clients c ON c.id = p.client_id WHERE c.account_id = ?`
    )
    .get(accountId).c;

  const stageCounts = {};
  db.prepare(`SELECT j.stage, COUNT(*) AS c FROM hs_jobs j JOIN hs_clients c ON c.id = j.client_id WHERE c.account_id = ? GROUP BY j.stage`)
    .all(accountId)
    .forEach((r) => (stageCounts[r.stage] = r.c));

  const openJobs = JOB_STAGES.filter((s) => s !== "paid").reduce((sum, s) => sum + (stageCounts[s] || 0), 0);

  const jobsThisWeek = db
    .prepare(
      `SELECT COUNT(*) AS c FROM hs_jobs j JOIN hs_clients c ON c.id = j.client_id
       WHERE c.account_id = ? AND j.scheduled_date IS NOT NULL AND date(j.scheduled_date) BETWEEN date('now') AND date('now', '+7 days') AND j.stage NOT IN ('cancelled')`
    )
    .get(accountId).c;

  const paidJobs = db
    .prepare(
      `SELECT j.line_items FROM hs_jobs j JOIN hs_clients c ON c.id = j.client_id
       WHERE c.account_id = ? AND j.stage = 'paid' AND date(j.updated_at) >= date('now', 'start of month')`
    )
    .all(accountId);
  const revenueThisMonth = paidJobs.reduce((sum, j) => sum + lineItemsTotal(j.line_items), 0);

  const recentClients = db.prepare(`SELECT * FROM hs_clients WHERE account_id = ? ORDER BY created_at DESC LIMIT 5`).all(accountId);
  const overdueCount = listOverdueInvoices(accountId).length;

  return { totalClients, totalProperties, stageCounts, openJobs, jobsThisWeek, revenueThisMonth, recentClients, overdueCount };
}

module.exports = {
  JOB_STAGES,
  JOB_SIDE_STAGES,
  JOB_STAGE_LABELS,
  JOB_TYPES,
  RECURRENCE_OPTIONS,
  RECURRENCE_LABELS,
  CLIENT_TYPES,
  parseLineItems,
  lineItemsTotal,
  seedPriceBookFor,
  listClients,
  getClient,
  createClient,
  updateClient,
  deleteClient,
  listPropertiesForClient,
  getProperty,
  createProperty,
  updateProperty,
  deleteProperty,
  listJobsForClient,
  listAllJobs,
  listAssignedTechs,
  setAutopilotEnabled,
  listAutopilotEnabledClients,
  listOpenJobsWithClients,
  getJob,
  createJob,
  updateJob,
  updateJobStage,
  deleteJob,
  listMessagesForClient,
  createMessage,
  updateMessageStatus,
  listRecentMessages,
  dashboardStats,
  PRICE_BOOK_UNITS,
  PRICE_BOOK_UNIT_LABELS,
  listPriceBook,
  getPriceBookItem,
  createPriceBookItem,
  updatePriceBookItem,
  deletePriceBookItem,
  OVERDUE_INVOICE_DAYS,
  clientStats,
  listOverdueInvoices,
  listJobsInRange,
  listJobsForDay,
};
