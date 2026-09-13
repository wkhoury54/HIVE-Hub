// HIVE Hub — Construction vertical database layer.
// Shares the same SQLite file/connection as the other two verticals (see
// db.js) but keeps its own tables (con_*) so none of the three collide, the
// way separate customer bases would in a real multi-vertical product.
"use strict";

const { rawDb: db } = require("./db");

db.exec(`
  CREATE TABLE IF NOT EXISTS con_clients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT,
    phone TEXT,
    source TEXT,
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    autopilot_enabled INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS con_projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id INTEGER NOT NULL REFERENCES con_clients(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    address TEXT,
    project_type TEXT NOT NULL DEFAULT 'Remodel',
    budget REAL NOT NULL DEFAULT 0,
    project_manager TEXT,
    phase TEXT NOT NULL DEFAULT 'lead',
    start_date TEXT,
    target_date TEXT,
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS con_change_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES con_projects(id) ON DELETE CASCADE,
    description TEXT NOT NULL,
    amount REAL NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS con_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES con_projects(id) ON DELETE CASCADE,
    description TEXT NOT NULL,
    done INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS con_daily_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES con_projects(id) ON DELETE CASCADE,
    note TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS con_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id INTEGER NOT NULL REFERENCES con_clients(id) ON DELETE CASCADE,
    channel TEXT NOT NULL DEFAULT 'email',
    subject TEXT,
    body TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'logged',
    provider_id TEXT,
    error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Lightweight migrations for dbs created before these columns existed.
for (const stmt of [
  `ALTER TABLE con_projects ADD COLUMN lat REAL`,
  `ALTER TABLE con_projects ADD COLUMN lng REAL`,
  `ALTER TABLE con_clients ADD COLUMN account_id INTEGER`,
]) {
  try {
    db.exec(stmt);
  } catch (e) {
    // column already exists — fine
  }
}

const PROJECT_PHASES = ["lead", "estimating", "contract_signed", "permitting", "in_progress", "punch_list", "complete"];
const PROJECT_SIDE_PHASES = ["on_hold"];
const PROJECT_PHASE_LABELS = {
  lead: "Lead",
  estimating: "Estimating",
  contract_signed: "Contract signed",
  permitting: "Permitting",
  in_progress: "In progress",
  punch_list: "Punch list",
  complete: "Complete",
  on_hold: "On hold",
};
const PROJECT_TYPES = ["New build", "Remodel", "Addition", "Kitchen", "Bathroom", "Roofing", "Commercial buildout", "Other"];
const CHANGE_ORDER_STATUSES = ["pending", "approved", "rejected"];

// ---------- Clients ----------

function listClients(accountId, search) {
  if (search) {
    const like = `%${search}%`;
    return db
      .prepare(`SELECT * FROM con_clients WHERE account_id = ? AND (name LIKE ? OR email LIKE ? OR phone LIKE ?) ORDER BY name ASC`)
      .all(accountId, like, like, like);
  }
  return db.prepare(`SELECT * FROM con_clients WHERE account_id = ? ORDER BY name ASC`).all(accountId);
}

function getClient(accountId, id) {
  return db.prepare(`SELECT * FROM con_clients WHERE id = ? AND account_id = ?`).get(id, accountId);
}

function createClient({ account_id, name, email, phone, source, notes }) {
  const info = db
    .prepare(`INSERT INTO con_clients (account_id, name, email, phone, source, notes) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(account_id, name, email || null, phone || null, source || null, notes || null);
  return Number(info.lastInsertRowid);
}

function updateClient(id, { name, email, phone, source, notes }) {
  db.prepare(`UPDATE con_clients SET name = ?, email = ?, phone = ?, source = ?, notes = ? WHERE id = ?`).run(
    name,
    email || null,
    phone || null,
    source || null,
    notes || null,
    id
  );
}

function deleteClient(accountId, id) {
  db.prepare(`DELETE FROM con_clients WHERE id = ? AND account_id = ?`).run(id, accountId);
}

// ---------- Autopilot ----------
// The dedupe log itself (autopilot_log) lives in db.js since it's shared
// across all three verticals over the same underlying connection.

function setAutopilotEnabled(clientId, enabled) {
  db.prepare(`UPDATE con_clients SET autopilot_enabled = ? WHERE id = ?`).run(enabled ? 1 : 0, clientId);
}

// accountId omitted (as the background Autopilot sweep does) means "every
// account" — everywhere else, callers pass it to scope the count/list to
// their own business.
function listAutopilotEnabledClients(accountId) {
  if (accountId) return db.prepare(`SELECT * FROM con_clients WHERE autopilot_enabled = 1 AND account_id = ?`).all(accountId);
  return db.prepare(`SELECT * FROM con_clients WHERE autopilot_enabled = 1`).all();
}

// ---------- Projects ----------

function listProjectsForClient(clientId) {
  return db.prepare(`SELECT * FROM con_projects WHERE client_id = ? ORDER BY created_at DESC`).all(clientId);
}

function listAssignedPMs(accountId) {
  return db
    .prepare(
      `SELECT DISTINCT p.project_manager FROM con_projects p JOIN con_clients c ON c.id = p.client_id
       WHERE c.account_id = ? AND p.project_manager IS NOT NULL AND p.project_manager != '' ORDER BY p.project_manager ASC`
    )
    .all(accountId)
    .map((r) => r.project_manager);
}

function listAllProjects(accountId, { phase, pm, search } = {}) {
  const clauses = [`c.account_id = ?`];
  const args = [accountId];
  if (phase) {
    clauses.push(`p.phase = ?`);
    args.push(phase);
  }
  if (pm) {
    clauses.push(`p.project_manager = ?`);
    args.push(pm);
  }
  if (search) {
    clauses.push(`(p.title LIKE ? OR c.name LIKE ? OR p.address LIKE ?)`);
    const like = `%${search}%`;
    args.push(like, like, like);
  }
  const where = `WHERE ${clauses.join(" AND ")}`;
  return db
    .prepare(
      `SELECT p.*, c.name AS client_name FROM con_projects p
       JOIN con_clients c ON c.id = p.client_id
       ${where}
       ORDER BY
         CASE WHEN p.target_date IS NULL THEN 1 ELSE 0 END,
         p.target_date ASC,
         p.created_at DESC`
    )
    .all(...args);
}

function listOpenProjectsWithClients(accountId) {
  return db
    .prepare(
      `SELECT p.*, c.name AS client_name, c.email AS client_email
       FROM con_projects p
       JOIN con_clients c ON c.id = p.client_id
       WHERE c.account_id = ? AND p.phase NOT IN ('complete')
       ORDER BY p.updated_at DESC`
    )
    .all(accountId);
}

// Scoped through the owning client — a project has no account_id of its own.
function getProject(accountId, id) {
  return db
    .prepare(
      `SELECT p.*, c.name AS client_name, c.email AS client_email, c.phone AS client_phone
       FROM con_projects p
       JOIN con_clients c ON c.id = p.client_id
       WHERE p.id = ? AND c.account_id = ?`
    )
    .get(id, accountId);
}

// lat/lng are optional — set by hand on the project form, or dropped in
// automatically when a client is added by clicking a spot on the /co/map
// page. A blank/undefined value is stored as NULL, not 0, so "no location
// set yet" and "0,0" (off the coast of Africa) are never confused.
function toCoord(v) {
  return v === undefined || v === null || v === "" ? null : Number(v);
}

function createProject({ client_id, title, address, project_type, budget, project_manager, phase, start_date, target_date, notes, lat, lng }) {
  const info = db
    .prepare(
      `INSERT INTO con_projects (client_id, title, address, project_type, budget, project_manager, phase, start_date, target_date, notes, lat, lng)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      client_id,
      title,
      address || null,
      PROJECT_TYPES.includes(project_type) ? project_type : "Remodel",
      Number(budget) || 0,
      project_manager || null,
      [...PROJECT_PHASES, ...PROJECT_SIDE_PHASES].includes(phase) ? phase : "lead",
      start_date || null,
      target_date || null,
      notes || null,
      toCoord(lat),
      toCoord(lng)
    );
  return Number(info.lastInsertRowid);
}

function updateProject(id, { title, address, project_type, budget, project_manager, phase, start_date, target_date, notes, lat, lng }) {
  db.prepare(
    `UPDATE con_projects SET title = ?, address = ?, project_type = ?, budget = ?, project_manager = ?, phase = ?, start_date = ?, target_date = ?, notes = ?, lat = ?, lng = ?, updated_at = datetime('now')
     WHERE id = ?`
  ).run(
    title,
    address || null,
    PROJECT_TYPES.includes(project_type) ? project_type : "Remodel",
    Number(budget) || 0,
    project_manager || null,
    [...PROJECT_PHASES, ...PROJECT_SIDE_PHASES].includes(phase) ? phase : "lead",
    start_date || null,
    target_date || null,
    notes || null,
    toCoord(lat),
    toCoord(lng),
    id
  );
}

// Every project that has a pinned location — feeds the /co/map page.
function listProjectsWithCoords(accountId) {
  return db
    .prepare(
      `SELECT p.*, c.name AS client_name FROM con_projects p
       JOIN con_clients c ON c.id = p.client_id
       WHERE c.account_id = ? AND p.lat IS NOT NULL AND p.lng IS NOT NULL
       ORDER BY p.created_at DESC`
    )
    .all(accountId);
}

function updateProjectPhase(id, phase) {
  if (![...PROJECT_PHASES, ...PROJECT_SIDE_PHASES].includes(phase)) return;
  db.prepare(`UPDATE con_projects SET phase = ?, updated_at = datetime('now') WHERE id = ?`).run(phase, id);
}

function deleteProject(id) {
  db.prepare(`DELETE FROM con_projects WHERE id = ?`).run(id);
}

// ---------- Change orders ----------
// Change orders, tasks, and daily logs all key off project_id with no
// account_id of their own — every entry point below is reached only after
// the caller in server.js has already resolved the parent project with
// getProject(accountId, id), which is what actually enforces the tenant
// boundary for these child records.

function listChangeOrdersForProject(projectId) {
  return db.prepare(`SELECT * FROM con_change_orders WHERE project_id = ? ORDER BY created_at DESC`).all(projectId);
}

function createChangeOrder({ project_id, description, amount, status }) {
  const info = db
    .prepare(`INSERT INTO con_change_orders (project_id, description, amount, status) VALUES (?, ?, ?, ?)`)
    .run(project_id, description, Number(amount) || 0, CHANGE_ORDER_STATUSES.includes(status) ? status : "pending");
  db.prepare(`UPDATE con_projects SET updated_at = datetime('now') WHERE id = ?`).run(project_id);
  return Number(info.lastInsertRowid);
}

// Scoped through the owning project/client so posting to /co/change-orders/:id
// can't touch another business's change order by guessing an id.
function updateChangeOrderStatus(accountId, id, status) {
  if (!CHANGE_ORDER_STATUSES.includes(status)) return;
  const co = db
    .prepare(
      `SELECT co.project_id FROM con_change_orders co
       JOIN con_projects p ON p.id = co.project_id
       JOIN con_clients c ON c.id = p.client_id
       WHERE co.id = ? AND c.account_id = ?`
    )
    .get(id, accountId);
  if (!co) return;
  db.prepare(`UPDATE con_change_orders SET status = ? WHERE id = ?`).run(status, id);
  db.prepare(`UPDATE con_projects SET updated_at = datetime('now') WHERE id = ?`).run(co.project_id);
}

function approvedChangeOrderTotal(projectId) {
  const row = db
    .prepare(`SELECT COALESCE(SUM(amount), 0) AS total FROM con_change_orders WHERE project_id = ? AND status = 'approved'`)
    .get(projectId);
  return row.total;
}

// ---------- Daily logs ----------
// A lightweight progress log per project — the same idea as Buildertrend/
// CoConstruct's daily logs, kept simple: a timestamped note, nothing fancier
// (no photo attachments or weather auto-fill in this build).

function listDailyLogsForProject(projectId) {
  return db.prepare(`SELECT * FROM con_daily_logs WHERE project_id = ? ORDER BY created_at DESC`).all(projectId);
}

function createDailyLog({ project_id, note }) {
  const info = db.prepare(`INSERT INTO con_daily_logs (project_id, note) VALUES (?, ?)`).run(project_id, note);
  db.prepare(`UPDATE con_projects SET updated_at = datetime('now') WHERE id = ?`).run(project_id);
  return Number(info.lastInsertRowid);
}

// Scoped through the owning project/client — see the note above
// listChangeOrdersForProject.
function deleteDailyLog(accountId, id) {
  db.prepare(
    `DELETE FROM con_daily_logs WHERE id = ? AND project_id IN (
       SELECT p.id FROM con_projects p JOIN con_clients c ON c.id = p.client_id WHERE c.account_id = ?
     )`
  ).run(id, accountId);
}

// ---------- Punch list / tasks ----------

function listTasksForProject(projectId) {
  return db.prepare(`SELECT * FROM con_tasks WHERE project_id = ? ORDER BY done ASC, created_at ASC`).all(projectId);
}

function createTask({ project_id, description }) {
  const info = db.prepare(`INSERT INTO con_tasks (project_id, description) VALUES (?, ?)`).run(project_id, description);
  return Number(info.lastInsertRowid);
}

function toggleTask(accountId, id) {
  const task = db
    .prepare(
      `SELECT t.* FROM con_tasks t
       JOIN con_projects p ON p.id = t.project_id
       JOIN con_clients c ON c.id = p.client_id
       WHERE t.id = ? AND c.account_id = ?`
    )
    .get(id, accountId);
  if (!task) return;
  db.prepare(`UPDATE con_tasks SET done = ? WHERE id = ?`).run(task.done ? 0 : 1, id);
}

function deleteTask(accountId, id) {
  db.prepare(
    `DELETE FROM con_tasks WHERE id = ? AND project_id IN (
       SELECT p.id FROM con_projects p JOIN con_clients c ON c.id = p.client_id WHERE c.account_id = ?
     )`
  ).run(id, accountId);
}

// ---------- Messages ----------

function listMessagesForClient(clientId) {
  return db.prepare(`SELECT * FROM con_messages WHERE client_id = ? ORDER BY created_at DESC`).all(clientId);
}

function createMessage({ client_id, channel, subject, body }) {
  const info = db
    .prepare(`INSERT INTO con_messages (client_id, channel, subject, body) VALUES (?, ?, ?, ?)`)
    .run(client_id, channel === "sms" ? "sms" : "email", subject || null, body);
  return Number(info.lastInsertRowid);
}

function updateMessageStatus(id, { status, provider_id, error }) {
  db.prepare(`UPDATE con_messages SET status = ?, provider_id = ?, error = ? WHERE id = ?`).run(
    status,
    provider_id || null,
    error || null,
    id
  );
}

function listRecentMessages(accountId, limit = 15) {
  return db
    .prepare(
      `SELECT m.*, c.name AS client_name FROM con_messages m
       JOIN con_clients c ON c.id = m.client_id
       WHERE c.account_id = ?
       ORDER BY m.created_at DESC LIMIT ?`
    )
    .all(accountId, limit);
}

// ---------- Client lifetime value ----------

function clientStats(clientId) {
  const projects = db.prepare(`SELECT id, phase, budget FROM con_projects WHERE client_id = ?`).all(clientId);
  const completeProjects = projects.filter((p) => p.phase === "complete");
  const lifetimeValue = completeProjects.reduce((sum, p) => sum + p.budget + approvedChangeOrderTotal(p.id), 0);
  return {
    projectCount: projects.length,
    completeProjectCount: completeProjects.length,
    lifetimeValue,
  };
}

// ---------- Dashboard aggregates ----------

function dashboardStats(accountId) {
  const totalClients = db.prepare(`SELECT COUNT(*) AS c FROM con_clients WHERE account_id = ?`).get(accountId).c;
  const totalProjects = db
    .prepare(`SELECT COUNT(*) AS c FROM con_projects p JOIN con_clients c ON c.id = p.client_id WHERE c.account_id = ?`)
    .get(accountId).c;

  const phaseCounts = {};
  db.prepare(`SELECT p.phase, COUNT(*) AS c FROM con_projects p JOIN con_clients c ON c.id = p.client_id WHERE c.account_id = ? GROUP BY p.phase`)
    .all(accountId)
    .forEach((r) => (phaseCounts[r.phase] = r.c));

  const activeProjects = PROJECT_PHASES.filter((p) => p !== "complete").reduce((sum, p) => sum + (phaseCounts[p] || 0), 0);

  const pipelineValue = db
    .prepare(
      `SELECT COALESCE(SUM(p.budget), 0) AS total FROM con_projects p JOIN con_clients c ON c.id = p.client_id
       WHERE c.account_id = ? AND p.phase NOT IN ('complete')`
    )
    .get(accountId).total;

  const pendingChangeOrders = db
    .prepare(
      `SELECT COUNT(*) AS c FROM con_change_orders co
       JOIN con_projects p ON p.id = co.project_id
       JOIN con_clients c ON c.id = p.client_id
       WHERE c.account_id = ? AND co.status = 'pending'`
    )
    .get(accountId).c;

  const recentClients = db.prepare(`SELECT * FROM con_clients WHERE account_id = ? ORDER BY created_at DESC LIMIT 5`).all(accountId);

  const targetSoon = db
    .prepare(
      `SELECT p.*, c.name AS client_name FROM con_projects p
       JOIN con_clients c ON c.id = p.client_id
       WHERE c.account_id = ? AND p.target_date IS NOT NULL AND date(p.target_date) BETWEEN date('now') AND date('now', '+14 days') AND p.phase NOT IN ('complete')
       ORDER BY p.target_date ASC`
    )
    .all(accountId);

  return { totalClients, totalProjects, phaseCounts, activeProjects, pipelineValue, pendingChangeOrders, recentClients, targetSoon };
}

module.exports = {
  PROJECT_PHASES,
  PROJECT_SIDE_PHASES,
  PROJECT_PHASE_LABELS,
  PROJECT_TYPES,
  CHANGE_ORDER_STATUSES,
  listClients,
  getClient,
  createClient,
  updateClient,
  deleteClient,
  setAutopilotEnabled,
  listAutopilotEnabledClients,
  listProjectsForClient,
  listAssignedPMs,
  listAllProjects,
  listOpenProjectsWithClients,
  getProject,
  createProject,
  updateProject,
  updateProjectPhase,
  deleteProject,
  listProjectsWithCoords,
  listChangeOrdersForProject,
  createChangeOrder,
  updateChangeOrderStatus,
  approvedChangeOrderTotal,
  listDailyLogsForProject,
  createDailyLog,
  deleteDailyLog,
  listTasksForProject,
  createTask,
  toggleTask,
  deleteTask,
  listMessagesForClient,
  createMessage,
  updateMessageStatus,
  listRecentMessages,
  clientStats,
  dashboardStats,
};
