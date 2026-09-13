"use strict";
// Seeds the Construction vertical with realistic sample data for local preview/demo.
const condb = require("./condb");
const auth = require("./auth");

const DEMO_EMAIL = "demo@construction.hivehub.dev";
const DEMO_PASSWORD = "demo1234";
let demoAccount = auth.getAccountByEmail(DEMO_EMAIL);
if (!demoAccount) {
  const id = auth.createAccount({
    business_name: "Ferreira Build Co.",
    email: DEMO_EMAIL,
    password: DEMO_PASSWORD,
    vertical: "construction",
  });
  demoAccount = auth.getAccountById(id);
  console.log(`Created demo Construction account — log in with ${DEMO_EMAIL} / ${DEMO_PASSWORD}`);
}
const accountId = demoAccount.id;

function isoOffset(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

const entries = [
  {
    client: { name: "Rosalind Ferreira", email: "rosalind.ferreira@gmail.com", phone: "(636) 555-0311", source: "Referral", notes: "Second project with us — did a bathroom remodel in 2024." },
    projects: [
      {
        title: "Kitchen remodel — Ferreira",
        address: "18 Larkspur Ct, Wildwood, MO",
        lat: 38.588,
        lng: -90.658,
        project_type: "Kitchen",
        budget: 68000,
        project_manager: "Marco",
        phase: "in_progress",
        startOffset: -30,
        targetOffset: 4,
        notes: "Quartz counters, custom cabinetry, moving the island 2ft.",
        changeOrders: [{ description: "Upgrade to quartz countertops", amount: 3200, status: "pending" }],
        tasks: [
          { description: "Final electrical inspection", done: false },
          { description: "Install cabinet hardware", done: true },
        ],
      },
    ],
  },
  {
    client: { name: "Devon Marsh", email: "devon.marsh@outlook.com", phone: "(314) 555-0177", source: "Google", notes: "" },
    projects: [
      {
        title: "Primary bath addition — Marsh",
        address: "552 Twin Oaks Dr, Kirkwood, MO",
        lat: 38.589,
        lng: -90.412,
        project_type: "Bathroom",
        budget: 41500,
        project_manager: "Dana",
        phase: "permitting",
        startOffset: -10,
        targetOffset: 60,
        notes: "Waiting on county permit before framing can start.",
        changeOrders: [],
        tasks: [{ description: "Submit revised plans to county", done: true }],
      },
    ],
  },
  {
    client: { name: "Whitmore Retail Group", email: "facilities@whitmoreretail.com", phone: "(314) 555-0402", source: "Website", notes: "Manages 3 strip-mall locations — this is their second buildout with us." },
    projects: [
      {
        title: "Storefront buildout — Manchester Rd",
        address: "9400 Manchester Rd, Rock Hill, MO",
        lat: 38.612,
        lng: -90.368,
        project_type: "Commercial buildout",
        budget: 155000,
        project_manager: "Marco",
        phase: "contract_signed",
        startOffset: 7,
        targetOffset: 120,
        notes: "Tenant improvement for a new tenant — landlord-funded allowance covers half the budget.",
        changeOrders: [],
        tasks: [],
      },
    ],
  },
  {
    client: { name: "Ilsa Novak", email: "ilsa.novak@yahoo.com", phone: "(636) 555-0288", source: "Referral", notes: "Wants to break ground in spring." },
    projects: [
      {
        title: "New build — Novak residence",
        address: "TBD — Wildhorse Creek Rd parcel, Chesterfield, MO",
        lat: 38.661,
        lng: -90.581,
        project_type: "New build",
        budget: 620000,
        project_manager: "",
        phase: "estimating",
        startOffset: null,
        targetOffset: null,
        notes: "Still finalizing the floor plan with the architect before we can lock the estimate.",
        changeOrders: [],
        tasks: [],
      },
    ],
  },
  {
    client: { name: "Tobias Renner", email: "tobias.renner@gmail.com", phone: "(314) 555-0356", source: "Repeat client", notes: "Has used us for 3 projects now." },
    projects: [
      {
        title: "Deck + pergola — Renner",
        address: "27 Persimmon Way, Ballwin, MO",
        lat: 38.598,
        lng: -90.542,
        project_type: "Addition",
        budget: 22800,
        project_manager: "Dana",
        phase: "punch_list",
        startOffset: -45,
        targetOffset: 2,
        notes: "Just finishing stain and final hardware.",
        changeOrders: [{ description: "Add built-in bench seating", amount: 1800, status: "approved" }],
        tasks: [
          { description: "Touch up stain on north rail", done: false },
          { description: "Install post cap lights", done: false },
        ],
      },
    ],
  },
  {
    client: { name: "Priya Chandrasekar", email: "priya.chandra@icloud.com", phone: "(636) 555-0299", source: "Referral", notes: "" },
    projects: [
      {
        title: "Roof replacement — Chandrasekar",
        address: "1140 Meadowbrook Ln, Ellisville, MO",
        lat: 38.59,
        lng: -90.591,
        project_type: "Roofing",
        budget: 18400,
        project_manager: "Marco",
        phase: "complete",
        startOffset: -60,
        targetOffset: -50,
        notes: "Full tear-off, architectural shingles, 2 skylights replaced.",
        changeOrders: [{ description: "Replace 2 skylights found damaged mid-tear-off", amount: 950, status: "approved" }],
        tasks: [{ description: "Final walkthrough with homeowner", done: true }],
      },
    ],
  },
  {
    client: { name: "Bartlett & Cole Property Mgmt", email: "projects@bartlettcole.com", phone: "(314) 555-0470", source: "Referral", notes: "Manages several rental properties — this is an on-hold job pending owner budget approval." },
    projects: [
      {
        title: "Multi-unit exterior repaint",
        address: "6200-6220 Waterman Blvd, St. Louis, MO",
        lat: 38.653,
        lng: -90.271,
        project_type: "Other",
        budget: 34000,
        project_manager: "",
        phase: "on_hold",
        startOffset: null,
        targetOffset: null,
        notes: "Owner paused the project pending Q4 budget review.",
        changeOrders: [],
        tasks: [],
      },
    ],
  },
];

let clientCount = 0;
let projectCount = 0;

entries.forEach((entry) => {
  const clientId = condb.createClient({ ...entry.client, account_id: accountId });
  clientCount++;
  entry.projects.forEach((p) => {
    const projectId = condb.createProject({
      client_id: clientId,
      title: p.title,
      address: p.address,
      project_type: p.project_type,
      budget: p.budget,
      project_manager: p.project_manager,
      phase: p.phase,
      start_date: p.startOffset === null ? null : isoOffset(p.startOffset),
      target_date: p.targetOffset === null ? null : isoOffset(p.targetOffset),
      notes: p.notes,
      lat: p.lat,
      lng: p.lng,
    });
    projectCount++;
    (p.changeOrders || []).forEach((co) => condb.createChangeOrder({ project_id: projectId, ...co }));
    (p.tasks || []).forEach((t) => {
      const taskId = condb.createTask({ project_id: projectId, description: t.description });
      if (t.done) condb.toggleTask(accountId, taskId);
    });
  });
});

console.log(`Construction seed complete — ${clientCount} client(s), ${projectCount} project(s) added.`);
