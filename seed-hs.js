"use strict";
// Seeds the Home Service vertical with realistic sample data for local preview/demo.
const hsdb = require("./hsdb");
const auth = require("./auth");

const DEMO_EMAIL = "demo@homeservice.hivehub.dev";
const DEMO_PASSWORD = "demo1234";
let demoAccount = auth.getAccountByEmail(DEMO_EMAIL);
if (!demoAccount) {
  const id = auth.createAccount({
    business_name: "Marco & Dana Home Services",
    email: DEMO_EMAIL,
    password: DEMO_PASSWORD,
    vertical: "homeservice",
  });
  hsdb.seedPriceBookFor(id);
  demoAccount = auth.getAccountById(id);
  console.log(`Created demo Home Service account — log in with ${DEMO_EMAIL} / ${DEMO_PASSWORD}`);
}
const accountId = demoAccount.id;

function isoOffset(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function li(description, qty, price) {
  return { description, qty, price };
}

const clients = [
  {
    client: { name: "Priya's Bakery", email: "priya@priyasbakery.com", phone: "(636) 555-0298", client_type: "commercial", source: "Referral", notes: "Commercial kitchen — needs after-hours scheduling when possible." },
    properties: [{ label: "Main kitchen", address: "1180 Baker St, St. Charles, MO" }],
    jobs: [
      { title: "Walk-in cooler repair", job_type: "Repair", stage: "paid", propertyIdx: 0, scheduledOffset: -20, window: "8am-10am", tech: "Marco", items: [li("Diagnostic", 1, 89), li("Compressor part + labor", 1, 410)] },
      { title: "Quarterly HVAC tune-up", job_type: "Maintenance", stage: "scheduled", propertyIdx: 0, scheduledOffset: 3, window: "7am-9am", tech: "Marco", items: [li("Recurring maintenance", 1, 99)] },
    ],
  },
  {
    client: { name: "Bishop Family", email: "kbishop@icloud.com", phone: "(314) 555-0233", client_type: "residential", source: "Google", notes: "Prefers text over email." },
    properties: [{ label: "Home — Rockwood Ave", address: "902 Rockwood Ave, Webster Groves, MO" }],
    jobs: [
      { title: "Gutter cleaning", job_type: "Maintenance", stage: "paid", propertyIdx: 0, scheduledOffset: -10, window: "1pm-3pm", tech: "Dana", items: [li("Gutter/line cleaning", 1, 175)] },
      { title: "Water heater install", job_type: "Installation", stage: "invoiced", propertyIdx: 0, scheduledOffset: -18, window: "9am-1pm", tech: "Dana", items: [li("Water heater install", 1, 1450)] },
    ],
  },
  {
    client: { name: "Terry Nguyen", email: "terry.nguyen@yahoo.com", phone: "(314) 555-0187", client_type: "residential", source: "Referral", notes: "" },
    properties: [{ label: "Home", address: "44 Elm Ct, Kirkwood, MO" }],
    jobs: [
      { title: "AC tune-up", job_type: "Maintenance", stage: "scheduled", propertyIdx: 0, scheduledOffset: 1, window: "10am-12pm", tech: "Marco", items: [li("HVAC tune-up", 1, 149)] },
      { title: "New request: leaking faucet", job_type: "Repair", stage: "new_request", propertyIdx: 0, scheduledOffset: null, window: "", tech: "", items: [] },
    ],
  },
  {
    client: { name: "Oak Grove HOA", email: "manager@oakgrovehoa.com", phone: "(636) 555-0144", client_type: "commercial", source: "Website", notes: "Manages 40 units — billing contact is the property manager, not individual owners." },
    properties: [
      { label: "Clubhouse", address: "1 Oak Grove Dr, Chesterfield, MO" },
      { label: "Pool house", address: "3 Oak Grove Dr, Chesterfield, MO" },
    ],
    jobs: [
      { title: "Pool pump repair", job_type: "Repair", stage: "completed", propertyIdx: 1, scheduledOffset: -2, window: "8am-10am", tech: "Dana", items: [li("Service call/diagnostic", 1, 89), li("Standard labor hour", 2, 125)] },
      { title: "Clubhouse HVAC quote", job_type: "Installation", stage: "quoted", propertyIdx: 0, scheduledOffset: null, window: "", tech: "", items: [li("HVAC tune-up", 1, 149)] },
    ],
  },
  {
    client: { name: "Meredith Cole", email: "meredith.cole@gmail.com", phone: "(314) 555-0210", client_type: "residential", source: "Referral", notes: "New homeowner — first-time service call." },
    properties: [{ label: "Home", address: "77 Sunset Ln, Ballwin, MO" }],
    jobs: [
      { title: "Drain cleaning", job_type: "Repair", stage: "in_progress", propertyIdx: 0, scheduledOffset: 0, window: "2pm-4pm", tech: "Dana", items: [li("Drain/line cleaning", 1, 175)] },
    ],
  },
  {
    client: { name: "Marlow & Sons Roofing Sub", email: "ops@marlowsons.com", phone: "(314) 555-0299", client_type: "commercial", source: "Referral", notes: "Subcontracts overflow plumbing work to us." },
    properties: [{ label: "Job site — Forsyth", address: "212 Forsyth Blvd, Clayton, MO" }],
    jobs: [
      { title: "Rough-in plumbing", job_type: "Installation", stage: "invoiced", propertyIdx: 0, scheduledOffset: -30, window: "", tech: "Marco", items: [li("Standard labor hour", 8, 125)] },
    ],
  },
  {
    client: { name: "Dana Ferris", email: "dana.ferris@outlook.com", phone: "(636) 555-0271", client_type: "residential", source: "Google", notes: "" },
    properties: [{ label: "Home", address: "9 Birchwood Dr, O'Fallon, MO" }],
    jobs: [
      { title: "Emergency pipe burst", job_type: "Repair", stage: "on_hold", propertyIdx: 0, scheduledOffset: null, window: "", tech: "", items: [li("Emergency labor hour", 1, 195)], internal_notes: "Waiting on insurance adjuster before proceeding." },
    ],
  },
];

let clientCount = 0;
let jobCount = 0;

clients.forEach((c) => {
  const clientId = hsdb.createClient({ ...c.client, account_id: accountId });
  clientCount++;
  const propertyIds = c.properties.map((p) => hsdb.createProperty({ client_id: clientId, ...p }));
  c.jobs.forEach((j) => {
    const propertyId = j.propertyIdx != null ? propertyIds[j.propertyIdx] : null;
    hsdb.createJob({
      client_id: clientId,
      property_id: propertyId,
      title: j.title,
      job_type: j.job_type,
      line_items: JSON.stringify(j.items || []),
      scheduled_date: j.scheduledOffset != null ? isoOffset(j.scheduledOffset) : null,
      scheduled_window: j.window || null,
      assigned_tech: j.tech || null,
      stage: j.stage,
      internal_notes: j.internal_notes || null,
    });
    jobCount++;
  });
});

console.log(`Home Service seed complete — ${clientCount} client(s), ${jobCount} job(s) added.`);
