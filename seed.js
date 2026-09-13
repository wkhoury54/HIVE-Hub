"use strict";
// Seeds HIVE Hub with realistic sample data for local preview/demo purposes.
const db = require("./db");
const auth = require("./auth");

// Every account now owns its own clients, so seeding needs an account to
// attach them to. Reuses the demo account across re-runs instead of creating
// a new one every time (createAccount throws if the email already exists).
const DEMO_EMAIL = "demo@insurance.hivehub.dev";
const DEMO_PASSWORD = "demo1234";
let demoAccount = auth.getAccountByEmail(DEMO_EMAIL);
if (!demoAccount) {
  const id = auth.createAccount({
    business_name: "Ellis & Ferreira Insurance",
    email: DEMO_EMAIL,
    password: DEMO_PASSWORD,
    vertical: "insurance",
  });
  demoAccount = auth.getAccountById(id);
  console.log(`Created demo Insurance Broker account — log in with ${DEMO_EMAIL} / ${DEMO_PASSWORD}`);
}
const accountId = demoAccount.id;

function isoOffset(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

const clients = [
  {
    name: "Jordan Ellis",
    email: "jordan.ellis@gmail.com",
    phone: "(314) 555-0148",
    address: "412 Maplewood Ave, St. Louis, MO",
    date_of_birth: "1990-06-14",
    notes: "Referred by his brother-in-law. Bundling auto + renters, asked about umbrella coverage next renewal.",
    pipeline_stage: "active",
    next_followup: isoOffset(-3),
    followup_note: "Asked about umbrella coverage — call back with a quote.",
    policies: [
      { policy_type: "Auto", carrier: "Progressive", monthly_premium: 118.4, coverage: "100/300/100", policy_number: "PA-33812", effective_date: "2026-02-01", status: "active", commission_rate: 12 },
      { policy_type: "Renters", carrier: "Progressive", monthly_premium: 14.75, coverage: "$30k personal property", policy_number: "RN-88213", effective_date: "2026-02-01", status: "active", commission_rate: 15 },
    ],
  },
  {
    name: "Priya Nair",
    email: "priya.nair@outlook.com",
    phone: "(314) 555-0192",
    address: "78 Kirkwood Rd, Kirkwood, MO",
    date_of_birth: "1985-03-22",
    notes: "Long-time client, very responsive. Life policy renews every January.",
    pipeline_stage: "active",
    policies: [
      { policy_type: "Home", carrier: "State Farm", monthly_premium: 96.2, coverage: "$410k dwelling", policy_number: "HO-10245", effective_date: "2025-11-15", status: "active", commission_rate: 12 },
      { policy_type: "Term Life", carrier: "State Farm", monthly_premium: 41.0, coverage: "$250k term (20yr)", policy_number: "LF-77291", effective_date: "2026-01-10", beneficiary: "Spouse — Arjun Nair", status: "active", commission_rate: 70 },
    ],
  },
  {
    name: "Marcus Webb",
    email: "mwebb.contracting@gmail.com",
    phone: "(636) 555-0110",
    address: "220 Industrial Pkwy, Wentzville, MO",
    date_of_birth: "1978-11-02",
    notes: "Owns a small contracting business, asked about switching to HIVE Hub's Construction vertical once it's live.",
    pipeline_stage: "active",
    policies: [
      { policy_type: "Business", carrier: "Nationwide", monthly_premium: 210.0, coverage: "$1M general liability", policy_number: "BZ-55620", effective_date: "2025-08-01", status: "active", commission_rate: 10 },
      { policy_type: "Auto", carrier: "Nationwide", monthly_premium: 145.6, coverage: "Commercial fleet, 2 vehicles", policy_number: "PA-90142", effective_date: "2025-08-01", status: "active", commission_rate: 12 },
    ],
  },
  {
    name: "Dana Whitfield",
    email: "dana.whitfield@yahoo.com",
    phone: "(314) 555-0177",
    address: "9 Forest Park Ct, Clayton, MO",
    date_of_birth: "1992-09-08",
    notes: "Premium went up at last renewal — flagged for a shopping review before next cycle.",
    pipeline_stage: "active",
    policies: [
      { policy_type: "Auto", carrier: "Allstate", monthly_premium: 162.9, coverage: "250/500/100", policy_number: "PA-44107", effective_date: "2025-10-01", status: "lapsed", commission_rate: 12 },
    ],
  },
  {
    name: "Sam Okafor",
    email: "sam.okafor@icloud.com",
    phone: "(314) 555-0163",
    address: "1500 Delmar Blvd, St. Louis, MO",
    date_of_birth: "1996-01-27",
    notes: "New homeowner, first policy with us. Very price-sensitive.",
    pipeline_stage: "underwriting",
    next_followup: isoOffset(4),
    followup_note: "Underwriter requested a home inspection report — check in on status.",
    policies: [
      { policy_type: "Home", carrier: "Liberty Mutual", monthly_premium: 88.5, coverage: "$325k dwelling", policy_number: "HO-30987", effective_date: "2026-03-01", status: "pending", commission_rate: 12 },
    ],
  },
  {
    name: "Chris Alvarez",
    email: "chris.alvarez@gmail.com",
    phone: "(314) 555-0121",
    address: "88 Manchester Rd, Brentwood, MO",
    date_of_birth: "1988-05-19",
    notes: "Inbound lead from the website contact form. Wants term life for a young family, no policies yet.",
    pipeline_stage: "lead",
    next_followup: isoOffset(1),
    followup_note: "Discovery call scheduled — send a term life quote afterward.",
    policies: [],
  },
  {
    name: "Renee Foster",
    email: "renee.foster@proton.me",
    phone: "(636) 555-0199",
    address: "31 Baxter Ln, Ballwin, MO",
    date_of_birth: "1982-12-03",
    notes: "Quoted a $500k 20-year term policy — comparing against her employer's group life before deciding.",
    pipeline_stage: "quoted",
    next_followup: isoOffset(6),
    followup_note: "Follow up on the $500k term quote sent Tuesday.",
    policies: [],
  },
];

let created = 0;
for (const c of clients) {
  const existing = db.listClients(accountId, c.name).find((row) => row.name === c.name);
  if (existing) continue;
  const id = db.createClient({ ...c, account_id: accountId });
  for (const p of c.policies) db.createPolicy({ ...p, client_id: id });
  created++;
}

console.log(`Seed complete — ${created} client(s) added.`);
console.log(db.dashboardStats(accountId));
