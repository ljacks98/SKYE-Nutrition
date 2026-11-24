// TrueMatch API: one Lambda function serves every route.
// API Gateway has already checked the user's sign-in token before this code runs.
// This file decides what each kind of account may see and do:
//   care-manager  - patients, treatment sessions, food referrals, and de-identified results to share with health plans
//   food-partner  - referrals sent to food partners: accept, pack, and confirm pickup by scanning the patient's code
//   patient       - their own patient card: pickup details, pickup code, confirm they got their food or report a problem
//   demo          - a presenting account that can view the app as any of the three (sent in the X-View-As header)
//   admin         - approves or denies access requests (works alongside any of the above)
// Anyone can create an account, but a new account sees nothing until an admin approves its access request.
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { CognitoIdentityProviderClient, AdminAddUserToGroupCommand, AdminRemoveUserFromGroupCommand } from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { randomUUID, randomInt } from "node:crypto";

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
const cognito = new CognitoIdentityProviderClient({});
const { PATIENTS_TABLE, SESSIONS_TABLE, REFERRALS_TABLE, REQUESTS_TABLE, USER_POOL_ID } = process.env;

// Example alert limits. Have your clinical team set the real values.
const LIMITS = { highSystolic: 180, lowSystolic: 90, kgAboveDryWeight: 1 };

const ROLES = ["care-manager", "food-partner", "patient", "transport-partner"];
const REQUESTABLE = [...ROLES, "demo", "admin"]; // what a person can ask an admin for; demo = see every view, for teammates and reviewers
// Routes anyone signed in may use, even before an admin approves them.
const OPEN_ROUTES = ["GET /me", "POST /access-requests"];
const ADMIN_ROUTES = ["GET /access-requests", "POST /access-requests/{id}/decision"];
// A referral moves along these stops. "issue" and "cancelled" are side exits.
const STEPS = ["referred", "accepted", "packed", "picked_up", "confirmed"];
const DEFAULT_PARTNER = "Riverside Community Pantry";

// The short survey a patient answers when they confirm pickup. Keys are stored; the screens show the wording.
const SURVEY = {
  rating: [1, 2, 3, 4], // 4 = great, 3 = good, 2 = okay, 1 = not good
  ride: ["own", "someone", "program", "none"], // how they got to the pickup
  needsRideNext: ["yes", "no", "unsure"],
};
function cleanSurvey(input) {
  if (!input || typeof input !== "object") return undefined;
  const survey = {
    rating: SURVEY.rating.includes(Number(input.rating)) ? Number(input.rating) : undefined,
    ride: SURVEY.ride.includes(input.ride) ? input.ride : undefined,
    needsRideNext: SURVEY.needsRideNext.includes(input.needsRideNext) ? input.needsRideNext : undefined,
    comment: text(input.comment, 500) || undefined,
  };
  if (!survey.rating && !survey.ride && !survey.needsRideNext && !survey.comment) return undefined;
  return { ...survey, at: new Date().toISOString() };
}

// ---- Small helpers ----
const reply = (statusCode, data) => ({
  statusCode,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(data),
});
const forbidden = () => reply(403, { error: "Your account can't do that." });

// Trims text and caps its length.
const text = (value, max = 100) => String(value ?? "").trim().slice(0, max);

// Reads the given fields as numbers. Returns null unless every one is a number above 0.
const positiveNumbers = (input, fields) => {
  const nums = Object.fromEntries(fields.map((f) => [f, Number.parseFloat(input[f])]));
  return Object.values(nums).every((n) => Number.isFinite(n) && n > 0) ? nums : null;
};

// Readings for staff to double-check. These are prompts, not a diagnosis.
const alertsFor = (session, patient) =>
  [
    session.preSystolic >= LIMITS.highSystolic && "High BP before",
    session.postSystolic < LIMITS.lowSystolic && "Low BP after",
    session.postWeightKg - patient.dryWeightKg > LIMITS.kgAboveDryWeight && "Above dry weight",
  ].filter(Boolean);

// Pickup codes skip look-alike characters (0/O, 1/I/L, 2/Z, 5/S, 8/B) so they're easy to read aloud or type.
const CODE_CHARS = "ACDEFGHJKMNPQRTUVWXY3479";
const newPickupCode = () => Array.from({ length: 6 }, () => CODE_CHARS[randomInt(CODE_CHARS.length)]).join("");
const newRef = () => `TM-${randomInt(1000, 10000)}`;

// Cognito puts group names in the token; API Gateway passes them as "[a b]" or a list.
function groupsOf(claims) {
  const raw = claims["cognito:groups"];
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  return String(raw).replace(/^\[|\]$/g, "").split(/[\s,]+/).filter(Boolean);
}

function whoIs(event) {
  const claims = event.requestContext.authorizer.jwt.claims;
  const groups = groupsOf(claims);
  const headers = Object.fromEntries(Object.entries(event.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  // Admins can open every view (care manager, food partner, patient) with the same switcher demo accounts use,
  // so the person approving access can see what each account type sees. Before real patient data,
  // narrow this so admins only manage access (least privilege).
  const demo = groups.includes("demo") || groups.includes("admin");
  const role = demo
    ? (ROLES.includes(headers["x-view-as"]) ? headers["x-view-as"] : "care-manager")
    : ROLES.find((r) => groups.includes(r)) ?? null;
  return {
    email: claims.email,
    sub: claims.sub,
    username: claims["cognito:username"],
    demo,
    admin: groups.includes("admin"),
    role,
    demoPatientId: demo ? text(headers["x-patient-id"], 60) : "",
  };
}

const scanAll = async (TableName) => {
  const items = [];
  let ExclusiveStartKey;
  do {
    const page = await db.send(new ScanCommand({ TableName, ExclusiveStartKey }));
    items.push(...page.Items);
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
};
const getPatient = async (id) => (await db.send(new GetCommand({ TableName: PATIENTS_TABLE, Key: { id } }))).Item;
const getReferral = async (id) => (await db.send(new GetCommand({ TableName: REFERRALS_TABLE, Key: { id } }))).Item;
const saveReferral = (referral) => db.send(new PutCommand({ TableName: REFERRALS_TABLE, Item: referral }));
const getRequest = async (id) => (await db.send(new GetCommand({ TableName: REQUESTS_TABLE, Key: { id } }))).Item;
const saveRequest = (request) => db.send(new PutCommand({ TableName: REQUESTS_TABLE, Item: request }));

// The patient record behind a patient login: matched by email, or chosen in the demo switcher.
async function patientFor(who) {
  if (who.demo) return who.demoPatientId ? getPatient(who.demoPatientId) : undefined;
  const all = await scanAll(PATIENTS_TABLE);
  return all.find((p) => p.patientEmail && p.patientEmail.toLowerCase() === String(who.email).toLowerCase());
}

// What a food partner may see: enough to pack and hand over food, and nothing clinical.
const forPartner = ({ pickupCode, patientId, createdBy, survey, messages, needsReply, lastReminderAt, ride, ...rest }) => ({
  ...rest,
  ride: ride && { kind: ride.kind, status: ride.status, when: ride.when, partner: ride.partner }, // so they know a driver is coming, nothing more
});
// What a patient sees about their own referral (they need their own pickup code).
const forPatient = ({ createdBy, ride, ...rest }) => ({ ...rest, ride: ride && { kind: ride.kind, status: ride.status, when: ride.when, partner: ride.partner, coverage: ride.coverage } });

function advance(referral, status, by, note) {
  referral.status = status;
  referral.history = [...(referral.history ?? []), { status, at: new Date().toISOString(), by, note: note || undefined }];
  return referral;
}

// Which status changes each kind of account may make.
const MOVES = {
  "food-partner": { referred: ["accepted"], accepted: ["packed"] },
  patient: { referred: ["issue"], accepted: ["issue"], packed: ["issue"], picked_up: ["confirmed", "issue"] },
  "care-manager": { referred: ["cancelled"], accepted: ["cancelled"], packed: ["cancelled"], issue: ["cancelled"] },
};

// ---- Getting the food home: during the dialysis visit, a ride to the pickup, or home delivery ----
// Transportation partners (volunteer drivers, ride services, delivery programs) see only what they need to do the trip:
// first name, address, phone, place and time. Never diagnoses, diet, health plan, messages, or the pickup code.
const DELIVERY = ["dialysis-visit", "ride", "home-delivery"];
const TRANSPORT_PARTNERS = ["Demo Volunteer Drivers", "Demo Ride Service"];
const COVERAGE = ["Health plan benefit", "Program or grant", "Volunteer, no cost"];

// Sets how a referral's food gets home. Returns an error message, or null when it worked.
function setTransport(referral, patient, body, by) {
  const delivery = DELIVERY.includes(body.delivery) ? body.delivery : "dialysis-visit";
  const active = referral.ride && ["requested", "scheduled"].includes(referral.ride.status);
  if (delivery === "dialysis-visit") {
    referral.delivery = delivery;
    if (active) rideStep(referral.ride, "cancelled", by, "Care manager switched to pickup during the dialysis visit.");
    return null;
  }
  if (!patient.address) return `Add ${patient.name.split(" ")[0]}'s home address first, under Contact and texts.`;
  if (!TRANSPORT_PARTNERS.includes(body.transportPartner)) return "Choose a transportation partner.";
  if (!COVERAGE.includes(body.coverage)) return "Choose who pays for the trip.";
  if (active) rideStep(referral.ride, "cancelled", by, "Replaced by a new request.");
  referral.delivery = delivery;
  referral.ride = {
    kind: delivery === "ride" ? "ride" : "delivery",
    status: "requested",
    partner: body.transportPartner,
    coverage: body.coverage,
    address: patient.address,
    phone: patient.phone,
    history: [{ status: "requested", at: new Date().toISOString(), by }],
  };
  return null;
}

function rideStep(ride, status, by, note, at = new Date().toISOString()) {
  ride.status = status;
  ride.history = [...(ride.history ?? []), { status, at, by, note: note || undefined }];
  return ride;
}

// What a transportation partner sees about a trip.
const forTransport = (r) => ({
  id: r.id,
  ref: r.ref,
  firstName: r.patientName.split(" ")[0],
  householdSize: r.householdSize,
  pickupLocation: r.pickupLocation,
  pickupWindow: r.pickupWindow,
  foodPartner: r.partner,
  foodReady: r.status === "packed", // a delivery can only be confirmed once the box is packed
  referralStatus: r.status,
  ride: r.ride,
});

const cleanCost = (value) => {
  if (value === undefined || value === null || value === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= 1000 ? Math.round(n * 100) / 100 : null; // null = invalid
};

// ---- Text messages and notes on each pickup ----
// In the demo, texts are recorded on the referral and shown on the patient's card instead of going to a real phone.
// To send real texts, register a number in AWS End User Messaging SMS and send from sendText below.
// Texts never include diagnoses or diet details, since anyone holding the phone can read them.
const SAFETY_LINE = "For medical questions, call your clinic. In an emergency, call 911.";
const textsOk = (patient) => patient?.textsOk === "Yes" && Boolean(patient.phone);

function cleanPhone(value) {
  const digits = String(value ?? "").replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
  if (!digits) return "";
  return digits.length === 10 ? `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}` : null; // null = not a valid US number
}

function addMessage(referral, from, via, body, extra = {}, at = new Date().toISOString()) {
  referral.messages = [...(referral.messages ?? []), { id: randomUUID(), at, from, via, body, ...extra }];
  if (from === "patient") referral.needsReply = true; // shows on the care manager's board until handled
  if (from === "care-manager") referral.needsReply = false;
  return referral;
}

const TEXTS = {
  referred: (r) => `TrueMatch: Your care team set up a food pickup for you from ${r.partner}. We'll text you when it's ready. Reply STOP to stop texts.`,
  packed: (r, place) => `TrueMatch: Your food is ready. Pick it up ${r.pickupWindow} at ${place}. Your code is ${r.pickupCode}. Reply 1 if you'll be there or 2 if you can't make it.`,
  reminder: (r, place) => `TrueMatch reminder: Your food pickup is ${r.pickupWindow} at ${place}. Your code is ${r.pickupCode}. Reply 1 if you'll be there or 2 if you can't make it.`,
  picked_up: () => "TrueMatch: Thanks for picking up your food. Reply 1 if you got everything or 2 if something was wrong.",
  rideScheduled: (r) => `TrueMatch: Your ride to pick up your food is set for ${r.ride.when}. ${r.ride.partner} will call you before they arrive.`,
  deliveryScheduled: (r) => `TrueMatch: Your food will be delivered ${r.ride.when} by ${r.ride.partner}. Have your pickup code ready to show the driver.`,
};

// Sends a text from TrueMatch if the patient agreed to texts. Returns true when one went out.
function sendText(patient, referral, kind, at) {
  if (!textsOk(patient)) return false;
  // "Your clinic" instead of the clinic's name, which could reveal the patient's condition to anyone who sees the phone.
  const place = referral.pickupLocation === patient.clinic ? "your clinic" : referral.pickupLocation;
  addMessage(referral, "truematch", "text", TEXTS[kind](referral, place), { kind }, at);
  return true;
}

// A patient's text reply. 1 and 2 mean different things before and after pickup; anything else goes to the care manager.
function handleTextReply(referral, body, by) {
  const answer = body.trim().toUpperCase();
  addMessage(referral, "patient", "text", body.trim());
  const beforePickup = ["referred", "accepted", "packed"].includes(referral.status);
  const afterPickup = referral.status === "picked_up";
  const handled = (reply) => { referral.needsReply = false; return { reply }; };
  if (answer === "STOP") return { stop: true, ...handled("TrueMatch: You won't get any more texts. Your care manager can turn them back on.") };
  if (answer === "1" && beforePickup) {
    referral.comingConfirmed = new Date().toISOString();
    return handled("TrueMatch: Great, see you then.");
  }
  if (answer === "2" && beforePickup) {
    advance(referral, "issue", by, "Replied by text: can't make this pickup.");
    return handled("TrueMatch: Thanks for letting us know. Your care manager will reach out to set up a new time.");
  }
  if (answer === "1" && afterPickup) {
    advance(referral, "confirmed", by, "Confirmed by text.");
    return handled("TrueMatch: Thank you! We're glad you got your food.");
  }
  if (answer === "2" && afterPickup) {
    advance(referral, "issue", by, "Replied by text: something was wrong with the order.");
    return handled("TrueMatch: Sorry about that. Your care manager will follow up.");
  }
  return { reply: `TrueMatch: Thanks, we passed your message to your care manager. ${SAFETY_LINE}` };
}

// ---- Outcomes a care manager records per patient: the 12 weeks before TrueMatch vs the latest 12 weeks ----
const OUTCOME_COUNTS = ["hospitalBefore", "hospitalAfter", "erBefore", "erAfter", "missedBefore", "missedAfter"];
const LAB_STATES = ["in", "out"]; // all key labs in range, or not
function cleanOutcomes(input) {
  const out = {};
  for (const field of OUTCOME_COUNTS) {
    if (input[field] === undefined || input[field] === "") continue;
    const n = Number(input[field]);
    if (!Number.isInteger(n) || n < 0 || n > 365) return null;
    out[field] = n;
  }
  for (const field of ["labsBefore", "labsNow"]) if (LAB_STATES.includes(input[field])) out[field] = input[field];
  return out;
}

// ---- Medically tailored food: diagnoses and health plan -> what to choose, what to limit, what the plan may cover ----
// General guidance for a demo, not a meal plan. The care team and a registered dietitian set each patient's real limits.
const FOODS = {
  leanProtein: "Fresh chicken, turkey, fish, and eggs",
  lowKFruit: "Apples, berries, grapes, and pineapple",
  lowKVeg: "Cabbage, cauliflower, green beans, peppers, and onions",
  refinedGrains: "White rice, white bread, pasta, and unsalted crackers",
  greens: "Spinach and other cooked greens",
  highKFruit: "Bananas, oranges, melons, and dried fruit",
  potatoes: "Potatoes and sweet potatoes",
  tomatoes: "Tomatoes and avocado",
  wholeGrains: "Oats, brown rice, and other whole grains",
  beans: "Beans, lentils, and nuts",
  lowFatDairy: "Low fat milk and yogurt",
  healthyOil: "Olive or canola oil in place of butter",
  cheese: "Cheese, especially processed cheese",
  processedMeat: "Deli meat, hot dogs, bacon, and sausage",
  cannedMeals: "Canned soup, frozen dinners, and instant noodles",
  saltySnacks: "Chips, pickles, and other salty snacks",
  darkCola: "Dark colas and drinks with added phosphate",
  sweets: "Sweets, sugary drinks, and juice",
  bigStarch: "Large portions of rice, bread, and pasta",
  friedFat: "Fried foods, butter, and fatty red meat",
};
const CONDITIONS = {
  dialysis: {
    label: "Kidney failure on dialysis",
    tags: ["Low potassium", "Low phosphorus", "Low sodium", "High protein"],
    choose: ["leanProtein", "lowKFruit", "lowKVeg", "refinedGrains"],
    limit: ["highKFruit", "potatoes", "tomatoes", "greens", "beans", "wholeGrains", "lowFatDairy", "cheese", "processedMeat", "cannedMeals", "saltySnacks", "darkCola"],
    note: "Keep fluids within the limit the care team sets, counting soup, ice, and gelatin.",
  },
  diabetes: {
    label: "Diabetes",
    tags: ["Low added sugar", "Carb controlled"],
    choose: ["lowKVeg", "greens", "leanProtein", "wholeGrains", "beans", "lowKFruit"],
    limit: ["sweets", "bigStarch"],
  },
  hypertension: {
    label: "High blood pressure",
    tags: ["Low sodium"],
    choose: ["lowKVeg", "greens", "highKFruit", "tomatoes", "wholeGrains", "beans", "lowFatDairy", "leanProtein"],
    limit: ["cannedMeals", "processedMeat", "saltySnacks"],
  },
  cholesterol: {
    label: "High cholesterol",
    tags: ["Heart healthy"],
    choose: ["wholeGrains", "beans", "leanProtein", "healthyOil", "lowKFruit", "lowKVeg"],
    limit: ["friedFat", "processedMeat", "cheese"],
  },
};
const PLAN_TYPES = ["Medicare Advantage", "Medicaid", "Medicare", "Commercial", "None or unknown"];
const PLAN_BENEFITS = ["meals", "box", "card"]; // medically tailored meals, healthy food box, grocery allowance card

function cleanHealth(input) {
  const list = (value) => (Array.isArray(value) ? value : value ? [value] : []).map(String);
  return {
    conditions: [...new Set(list(input.conditions))].filter((c) => c in CONDITIONS),
    tailorFood: input.tailorFood === "Yes" ? "Yes" : "No",
    plan: {
      name: text(input.planName, 80) || undefined,
      type: PLAN_TYPES.includes(input.planType) ? input.planType : undefined,
      benefits: [...new Set(list(input.benefits))].filter((b) => PLAN_BENEFITS.includes(b)),
    },
  };
}

// Food help the patient's plan may pay for, then the pantry box TrueMatch can always send.
// `detail` is written for the care team, `forPatient` for the patient's own card.
function foodOptionsFor(plan = {}) {
  const name = plan.name || "The health plan";
  const theirs = plan.name || "Your health plan";
  const has = (b) => plan.benefits?.includes(b);
  const options = [];
  if (has("meals")) options.push({
    title: "Medically tailored meals",
    detail: `${name} lists this benefit. Meals are made for the diet and arrive ready to eat, which helps patients who don't cook.`,
    forPatient: `${theirs} lists this benefit. Meals made for your diet arrive ready to eat. Ask your care manager to set it up.`,
  });
  if (has("card")) options.push({
    title: "Grocery allowance card",
    detail: `${name} lists this benefit. Spend it on the foods in the choose more list.`,
    forPatient: `${theirs} lists this benefit. Use it for the foods on your choose more often list.`,
  });
  if (has("box")) options.push({
    title: "Healthy food box",
    detail: `${name} lists this benefit. Ask for a box that follows the diet needs below.`,
    forPatient: `${theirs} lists this benefit. Ask your care manager to request a box that fits your diet.`,
  });
  options.push({
    title: "Tailored pantry box",
    detail: "Send a TrueMatch referral. The food partner packs to the diet needs, and never sees the diagnoses.",
    forPatient: "Your care manager can send a referral, and the food partner packs to your diet needs. They never see your diagnoses.",
  });
  return options;
}

// The patient's food plan, or null when they haven't asked for tailored food or have no diagnoses recorded.
// Where conditions disagree (beans help blood pressure but are limited on dialysis), the stricter advice wins.
function foodPlanFor(patient) {
  const h = patient?.health;
  if (!h || h.tailorFood !== "Yes" || !h.conditions?.length) return null;
  const conditions = h.conditions.map((c) => CONDITIONS[c]).filter(Boolean);
  const limitIds = [...new Set(conditions.flatMap((c) => c.limit))];
  const wanted = [...new Set(conditions.flatMap((c) => c.choose))];
  const chooseIds = wanted.filter((id) => !limitIds.includes(id));
  const notes = conditions.map((c) => c.note).filter(Boolean);
  if (chooseIds.length < wanted.length) notes.push("Some foods that help one condition are limited for another, so the stricter advice is shown. Check with the dietitian.");
  return {
    tags: [...new Set(conditions.flatMap((c) => c.tags))],
    choose: chooseIds.map((id) => FOODS[id]),
    limit: limitIds.map((id) => FOODS[id]),
    notes,
    options: foodOptionsFor(h.plan),
  };
}

// What travels with a referral to the food partner: diet needs only, no diagnoses and no plan details.
const dietFor = (patient) => {
  const plan = foodPlanFor(patient);
  return plan ? { tags: plan.tags, choose: plan.choose, limit: plan.limit, notes: plan.notes } : undefined;
};

// Care managers see the computed food plan beside the record they entered.
const withFood = (patient) => ({ ...patient, food: foodPlanFor(patient) });

// Organization results: totals across enrolled patients, never names.
function organizationFrom(patients, referrals) {
  const enrolledIds = new Set(referrals.filter((r) => r.status !== "cancelled").map((r) => r.patientId));
  const tracked = patients.filter((p) => enrolledIds.has(p.id) && p.outcomes && OUTCOME_COUNTS.some((f) => f in p.outcomes));
  const sum = (field) => tracked.reduce((total, p) => total + (p.outcomes[field] ?? 0), 0);
  const withLabs = patients.filter((p) => enrolledIds.has(p.id) && p.outcomes?.labsNow);
  return {
    enrolled: enrolledIds.size,
    tracked: tracked.length,
    hospital: { before: sum("hospitalBefore"), after: sum("hospitalAfter") },
    er: { before: sum("erBefore"), after: sum("erAfter") },
    missed: { before: sum("missedBefore"), after: sum("missedAfter") },
    labs: {
      withLabs: withLabs.length,
      inRangeNow: withLabs.filter((p) => p.outcomes.labsNow === "in").length,
      inRangeBefore: withLabs.filter((p) => p.outcomes.labsBefore === "in").length,
    },
  };
}

// ---- Results to share with health plans: counts and timing only, no names or medical details ----
function resultsFrom(referrals, patients = []) {
  const reached = (r, step) => (r.history ?? []).some((h) => h.status === step);
  const live = referrals.filter((r) => r.status !== "cancelled");
  const pickedUp = live.filter((r) => reached(r, "picked_up"));
  const daysToPickup = pickedUp
    .map((r) => (Date.parse(r.history.find((h) => h.status === "picked_up").at) - Date.parse(r.createdAt)) / 86400000)
    .sort((a, b) => a - b);
  const median = daysToPickup.length
    ? (daysToPickup[Math.floor((daysToPickup.length - 1) / 2)] + daysToPickup[Math.ceil((daysToPickup.length - 1) / 2)]) / 2
    : null;

  const weekOf = (iso) => {
    const d = new Date(iso);
    d.setUTCHours(0, 0, 0, 0);
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); // Monday
    return d.toISOString().slice(0, 10);
  };
  const weeks = {};
  for (const r of live) {
    (weeks[weekOf(r.createdAt)] ??= { referred: 0, pickedUp: 0 }).referred += 1;
    const pick = (r.history ?? []).find((h) => h.status === "picked_up");
    if (pick) (weeks[weekOf(pick.at)] ??= { referred: 0, pickedUp: 0 }).pickedUp += 1;
  }

  // Survey answers as counts only. Comments stay out of results because they can name people.
  const surveys = live.map((r) => r.survey).filter(Boolean);
  const tally = (field, keys) => keys.map((key) => ({ key, count: surveys.filter((s) => s[field] === key).length }));

  // Trips arranged through TrueMatch: counts and cost only, never addresses or names.
  const trips = live.filter((r) => r.ride && r.ride.status !== "cancelled");
  const done = trips.filter((r) => r.ride.status === "completed");
  const costed = done.filter((r) => typeof r.ride.cost === "number");
  const transport = {
    requested: trips.length,
    completed: done.length,
    declined: trips.filter((r) => r.ride.status === "declined").length,
    rides: trips.filter((r) => r.ride.kind === "ride").length,
    deliveries: trips.filter((r) => r.ride.kind === "delivery").length,
    pickedUpWithHelp: done.filter((r) => reached(r, "picked_up")).length,
    averageCost: costed.length ? Math.round((costed.reduce((sum, r) => sum + r.ride.cost, 0) / costed.length) * 100) / 100 : null,
    totalCost: Math.round(costed.reduce((sum, r) => sum + r.ride.cost, 0) * 100) / 100,
  };

  return {
    generatedAt: new Date().toISOString(),
    organization: organizationFrom(patients, referrals),
    transport,
    feedback: {
      responses: surveys.length,
      rating: tally("rating", [4, 3, 2, 1]),
      ride: tally("ride", SURVEY.ride),
      needsRideNext: tally("needsRideNext", SURVEY.needsRideNext),
    },
    funnel: STEPS.map((step) => ({ step, count: live.filter((r) => reached(r, step)).length })),
    referrals: live.length,
    pickedUp: pickedUp.length,
    confirmed: live.filter((r) => reached(r, "confirmed")).length,
    issues: live.filter((r) => reached(r, "issue")).length,
    tailored: live.filter((r) => r.diet).length, // referrals packed to a medical diet
    cancelled: referrals.length - live.length,
    households: pickedUp.length,
    people: pickedUp.reduce((sum, r) => sum + (Number(r.householdSize) || 0), 0),
    medianDaysToPickup: median === null ? null : Math.round(median * 10) / 10,
    weeks: Object.entries(weeks).sort(([a], [b]) => a.localeCompare(b)).map(([week, v]) => ({ week, ...v })),
    rows: live
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((r) => {
        const pick = (r.history ?? []).find((h) => h.status === "picked_up");
        return {
          ref: r.ref,
          referredOn: r.createdAt.slice(0, 10),
          status: r.status,
          householdSize: r.householdSize,
          partner: r.partner,
          daysToPickup: pick ? Math.round(((Date.parse(pick.at) - Date.parse(r.createdAt)) / 86400000) * 10) / 10 : null,
          rating: r.survey?.rating ?? null,
          needsRideNext: r.survey?.needsRideNext ?? null,
          tailored: Boolean(r.diet),
          gettingHome: r.ride && r.ride.status !== "cancelled" ? `${r.ride.kind === "ride" ? "Ride" : "Home delivery"}, ${r.ride.status}` : "Dialysis visit",
        };
      }),
  };
}

// ---- Routes ----
export const handler = async (event) => {
  const who = whoIs(event);
  const patientId = event.pathParameters?.id;
  const body = JSON.parse(event.body || "{}");

  // Audit trail in CloudWatch Logs: who did what, as which role, to which record. No medical details.
  console.log(JSON.stringify({ audit: event.routeKey, user: who.email, role: who.role, demo: who.demo, id: patientId }));

  if (ADMIN_ROUTES.includes(event.routeKey) && !who.admin) return forbidden();
  if (!who.role && !OPEN_ROUTES.includes(event.routeKey) && !ADMIN_ROUTES.includes(event.routeKey)) {
    return reply(403, { error: "Your account is waiting for an admin to approve it. Request access from the TrueMatch home page." });
  }
  const is = (...roles) => roles.includes(who.role);

  switch (event.routeKey) {
    case "GET /me": {
      const me = { email: who.email, role: who.role, demo: who.demo, admin: who.admin };
      const request = await getRequest(who.sub);
      if (request) me.request = { role: request.role, status: request.status, createdAt: request.createdAt, decisionNote: request.decisionNote };
      if (who.demo) me.demoPatients = (await scanAll(PATIENTS_TABLE)).map((p) => ({ id: p.id, name: p.name })).sort((a, b) => a.name.localeCompare(b.name));
      if (is("patient")) {
        const p = await patientFor(who);
        me.patient = p ? { id: p.id, name: p.name, clinic: p.clinic, householdSize: p.householdSize, food: foodPlanFor(p), textsTo: textsOk(p) ? p.phone.slice(-4) : null } : null;
      }
      return reply(200, me);
    }

    // -- Patients and treatment sessions: care managers only --
    case "GET /patients": {
      if (!is("care-manager")) return forbidden();
      return reply(200, (await scanAll(PATIENTS_TABLE)).map(withFood));
    }

    case "POST /patients": {
      if (!is("care-manager")) return forbidden();
      const nums = positiveNumbers(body, ["dryWeightKg", "householdSize"]);
      if (!text(body.name) || !nums) return reply(400, { error: "Enter a name, a dry weight above 0, and a household size of at least 1." });
      if (cleanPhone(body.phone) === null) return reply(400, { error: "Enter a 10-digit mobile number, or leave it blank." });
      const patient = {
        id: randomUUID(),
        name: text(body.name),
        dob: text(body.dob, 10),
        schedule: text(body.schedule),
        access: text(body.access),
        clinic: text(body.clinic),
        optedIn: body.optedIn === "Yes" ? "Yes" : "No",
        patientEmail: text(body.patientEmail, 200).toLowerCase() || undefined,
        phone: cleanPhone(body.phone) || undefined,
        address: text(body.address, 160) || undefined,
        textsOk: body.textsOk === "Yes" && cleanPhone(body.phone) ? "Yes" : "No",
        dryWeightKg: nums.dryWeightKg,
        householdSize: Math.round(nums.householdSize),
        createdBy: who.email,
      };
      await db.send(new PutCommand({ TableName: PATIENTS_TABLE, Item: patient }));
      return reply(201, withFood(patient));
    }

    case "GET /patients/{id}/sessions": {
      if (!is("care-manager")) return forbidden();
      const { Items } = await db.send(new QueryCommand({
        TableName: SESSIONS_TABLE,
        KeyConditionExpression: "patientId = :id",
        ExpressionAttributeValues: { ":id": patientId },
        ScanIndexForward: false, // newest first
      }));
      return reply(200, Items);
    }

    case "POST /patients/{id}/outcomes": {
      if (!is("care-manager")) return forbidden();
      const patient = await getPatient(patientId);
      if (!patient) return reply(404, { error: "This patient doesn't exist. Refresh the patient list." });
      const outcomes = cleanOutcomes(body);
      if (!outcomes) return reply(400, { error: "Use whole numbers from 0 to 365 for visits and missed treatments." });
      patient.outcomes = { ...outcomes, updatedAt: new Date().toISOString(), updatedBy: who.email };
      await db.send(new PutCommand({ TableName: PATIENTS_TABLE, Item: patient }));
      return reply(200, withFood(patient));
    }

    // Mobile number and whether the patient agreed to get pickup texts.
    case "POST /patients/{id}/contact": {
      if (!is("care-manager")) return forbidden();
      const patient = await getPatient(patientId);
      if (!patient) return reply(404, { error: "This patient doesn't exist. Refresh the patient list." });
      const phone = cleanPhone(body.phone);
      if (phone === null) return reply(400, { error: "Enter a 10-digit mobile number, or leave it blank." });
      if (body.textsOk === "Yes" && !phone) return reply(400, { error: "Add a mobile number so TrueMatch knows where to send texts." });
      patient.phone = phone || undefined;
      patient.textsOk = body.textsOk === "Yes" ? "Yes" : "No";
      if (body.address !== undefined) patient.address = text(body.address, 160) || undefined;
      await db.send(new PutCommand({ TableName: PATIENTS_TABLE, Item: patient }));
      return reply(200, withFood(patient));
    }

    // Diagnoses, health plan, and whether the patient wants food tailored to their health.
    case "POST /patients/{id}/health": {
      if (!is("care-manager")) return forbidden();
      const patient = await getPatient(patientId);
      if (!patient) return reply(404, { error: "This patient doesn't exist. Refresh the patient list." });
      const health = cleanHealth(body);
      if (health.tailorFood === "Yes" && health.conditions.length === 0) {
        return reply(400, { error: "Check at least one diagnosis so TrueMatch knows how to tailor the food." });
      }
      patient.health = { ...health, updatedAt: new Date().toISOString(), updatedBy: who.email };
      await db.send(new PutCommand({ TableName: PATIENTS_TABLE, Item: patient }));
      return reply(200, withFood(patient));
    }

    case "POST /patients/{id}/sessions": {
      if (!is("care-manager")) return forbidden();
      const patient = await getPatient(patientId);
      if (!patient) return reply(404, { error: "This patient doesn't exist. Refresh the patient list." });
      const nums = positiveNumbers(body, ["preWeightKg", "postWeightKg", "preSystolic", "postSystolic", "minutes"]);
      if (!nums) return reply(400, { error: "Fill in every number with a value above 0." });
      const session = {
        patientId,
        recordedAt: new Date().toISOString(),
        ...nums,
        fluidRemovedKg: Number((nums.preWeightKg - nums.postWeightKg).toFixed(1)),
        notes: text(body.notes, 1000),
        recordedBy: who.email,
      };
      session.alerts = alertsFor(session, patient);
      await db.send(new PutCommand({ TableName: SESSIONS_TABLE, Item: session }));
      return reply(201, session);
    }

    // -- Food referrals --
    case "GET /referrals": {
      const all = (await scanAll(REFERRALS_TABLE)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      if (is("care-manager")) return reply(200, all);
      if (is("food-partner")) return reply(200, all.filter((r) => r.status !== "cancelled").map(forPartner));
      const me = await patientFor(who);
      return reply(200, me ? all.filter((r) => r.patientId === me.id).map(forPatient) : []);
    }

    case "POST /referrals": {
      if (!is("care-manager")) return forbidden();
      const patient = await getPatient(text(body.patientId, 60));
      if (!patient) return reply(404, { error: "This patient doesn't exist. Refresh the patient list." });
      if (patient.optedIn !== "Yes") return reply(400, { error: `${patient.name} hasn't opted in to food referrals. Record their opt-in first.` });
      if (!text(body.need) || !text(body.pickupWindow)) return reply(400, { error: "Choose what the household needs and when they'll pick it up." });
      const referral = advance({
        id: randomUUID(),
        ref: newRef(),
        patientId: patient.id,
        patientName: patient.name,
        householdSize: patient.householdSize,
        need: text(body.need),
        pickupLocation: text(body.pickupLocation) || patient.clinic,
        pickupWindow: text(body.pickupWindow),
        partner: text(body.partner) || DEFAULT_PARTNER,
        notes: text(body.notes, 500),
        diet: dietFor(patient),
        pickupCode: newPickupCode(),
        createdAt: new Date().toISOString(),
        createdBy: who.email,
      }, "referred", who.email);
      const transportError = setTransport(referral, patient, body, who.email);
      if (transportError) return reply(400, { error: transportError });
      sendText(patient, referral, "referred");
      await saveReferral(referral);
      return reply(201, referral);
    }

    case "POST /referrals/{id}/status": {
      const referral = await getReferral(patientId);
      if (!referral) return reply(404, { error: "This referral doesn't exist. Refresh the page." });
      if (is("patient")) {
        const me = await patientFor(who);
        if (!me || me.id !== referral.patientId) return reply(404, { error: "This referral doesn't exist. Refresh the page." });
      }
      const to = text(body.status, 20);
      if (!(MOVES[who.role]?.[referral.status] ?? []).includes(to)) {
        return reply(400, { error: `This referral is ${referral.status.replace("_", " ")}, so it can't be marked ${to.replace("_", " ")}.` });
      }
      if (to === "issue" && !text(body.note)) return reply(400, { error: "Say what went wrong so the care manager can follow up." });
      if (to === "confirmed" && is("patient")) referral.survey = cleanSurvey(body.survey);
      advance(referral, to, who.email, text(body.note, 500));
      if (to === "cancelled" && referral.ride && ["requested", "scheduled"].includes(referral.ride.status)) {
        rideStep(referral.ride, "cancelled", who.email, "Referral cancelled.");
      }
      if (to === "packed") sendText(await getPatient(referral.patientId), referral, "packed");
      await saveReferral(referral);
      return reply(200, is("food-partner") ? forPartner(referral) : is("patient") ? forPatient(referral) : referral);
    }

    // The food partner scans or types the code on the patient's card at handoff.
    // A care manager changes how the food gets home, before pickup.
    case "POST /referrals/{id}/transport": {
      if (!is("care-manager")) return forbidden();
      const referral = await getReferral(patientId);
      if (!referral) return reply(404, { error: "This referral doesn't exist. Refresh the page." });
      if (!["referred", "accepted", "packed"].includes(referral.status)) return reply(400, { error: "Transportation can only be changed before pickup." });
      const transportError = setTransport(referral, await getPatient(referral.patientId), body, who.email);
      if (transportError) return reply(400, { error: transportError });
      await saveReferral(referral);
      return reply(200, referral);
    }

    // Transportation partners: their trips, newest first. Cancelled trips drop off.
    case "GET /rides": {
      if (!is("transport-partner")) return forbidden();
      const all = await scanAll(REFERRALS_TABLE);
      return reply(200, all.filter((r) => r.ride && r.ride.status !== "cancelled" && r.status !== "cancelled").map(forTransport));
    }

    // Transportation partners schedule, decline, finish a ride, or confirm a home delivery with the patient's code.
    case "POST /rides/{id}": {
      if (!is("transport-partner")) return forbidden();
      const referral = await getReferral(patientId);
      if (!referral?.ride || referral.ride.status === "cancelled") return reply(404, { error: "This trip doesn't exist or was cancelled. Refresh the page." });
      const ride = referral.ride;
      const action = text(body.action, 20);
      const cost = cleanCost(body.cost);
      if (cost === null) return reply(400, { error: "Enter the trip cost as a dollar amount, or leave it blank." });
      if (action === "schedule") {
        if (!["requested", "scheduled"].includes(ride.status)) return reply(400, { error: `This trip is already ${ride.status}.` });
        const when = text(body.when, 80);
        if (!when) return reply(400, { error: "Enter the day and time, for example Thursday 11 AM." });
        ride.when = when;
        rideStep(ride, "scheduled", who.email);
        sendText(await getPatient(referral.patientId), referral, ride.kind === "ride" ? "rideScheduled" : "deliveryScheduled");
      } else if (action === "decline") {
        if (!["requested", "scheduled"].includes(ride.status)) return reply(400, { error: `This trip is already ${ride.status}.` });
        if (!text(body.note)) return reply(400, { error: "Say why, so the care manager can find another option." });
        rideStep(ride, "declined", who.email, text(body.note, 300));
      } else if (action === "complete") {
        if (ride.kind !== "ride" || ride.status !== "scheduled") return reply(400, { error: "Only a scheduled ride can be marked done." });
        ride.cost = cost;
        rideStep(ride, "completed", who.email);
      } else if (action === "deliver") {
        if (ride.kind !== "delivery" || ride.status !== "scheduled") return reply(400, { error: "Schedule the delivery first." });
        const code = text(body.code, 64).toUpperCase().replace(/^TRUEMATCH:/, "").replace(/[^A-Z0-9]/g, "");
        if (code !== referral.pickupCode) return reply(400, { error: "That code doesn't match. Ask the patient for the code on their TrueMatch card." });
        if (referral.status !== "packed") return reply(400, { error: "The food partner hasn't packed this order yet. Confirm the delivery once it's packed." });
        ride.cost = cost;
        rideStep(ride, "completed", who.email);
        advance(referral, "picked_up", who.email, `Delivered home by ${ride.partner}.`);
        sendText(await getPatient(referral.patientId), referral, "picked_up");
      } else {
        return reply(400, { error: "Choose schedule, decline, complete, or deliver." });
      }
      await saveReferral(referral);
      return reply(200, forTransport(referral));
    }

    // Messages about one pickup. Patients send a note, or in the demo reply to a text; care managers reply.
    case "POST /referrals/{id}/messages": {
      const referral = await getReferral(patientId);
      if (!referral) return reply(404, { error: "This referral doesn't exist. Refresh the page." });
      const message = text(body.body, 500);
      if (!message) return reply(400, { error: "Write a message first." });
      if (is("care-manager")) {
        addMessage(referral, "care-manager", "app", message, { by: who.email });
        await saveReferral(referral);
        return reply(200, referral);
      }
      if (!is("patient")) return forbidden();
      const me = await patientFor(who);
      if (!me || me.id !== referral.patientId) return reply(404, { error: "This referral doesn't exist. Refresh the page." });
      if (body.via === "text") {
        if (!textsOk(me)) return reply(400, { error: "Texts are turned off for this patient." });
        const result = handleTextReply(referral, message, who.email);
        addMessage(referral, "truematch", "text", result.reply, { kind: "auto" });
        if (result.stop) {
          me.textsOk = "No";
          await db.send(new PutCommand({ TableName: PATIENTS_TABLE, Item: me }));
        }
      } else {
        addMessage(referral, "patient", "app", message);
      }
      await saveReferral(referral);
      return reply(200, forPatient(referral));
    }

    // A care manager sends a pickup reminder by text.
    case "POST /referrals/{id}/remind": {
      if (!is("care-manager")) return forbidden();
      const referral = await getReferral(patientId);
      if (!referral) return reply(404, { error: "This referral doesn't exist. Refresh the page." });
      if (!["referred", "accepted", "packed"].includes(referral.status)) return reply(400, { error: "Reminders are for pickups that haven't happened yet." });
      const patient = await getPatient(referral.patientId);
      if (!sendText(patient, referral, "reminder")) return reply(400, { error: `${referral.patientName} hasn't agreed to texts, or has no mobile number on file.` });
      referral.lastReminderAt = new Date().toISOString();
      await saveReferral(referral);
      return reply(200, referral);
    }

    // A care manager marks a patient's message as handled, without replying in TrueMatch (for example after a phone call).
    case "POST /referrals/{id}/handled": {
      if (!is("care-manager")) return forbidden();
      const referral = await getReferral(patientId);
      if (!referral) return reply(404, { error: "This referral doesn't exist. Refresh the page." });
      referral.needsReply = false;
      await saveReferral(referral);
      return reply(200, referral);
    }

    case "POST /pickup": {
      if (!is("food-partner")) return forbidden();
      const code = text(body.code, 64).toUpperCase().replace(/^TRUEMATCH:/, "").replace(/[^A-Z0-9]/g, "");
      if (code.length !== 6) return reply(400, { error: "Pickup codes are 6 letters and numbers. Check the code on the patient's card." });
      const match = (await scanAll(REFERRALS_TABLE)).find((r) => r.pickupCode === code);
      if (!match) return reply(404, { error: `No referral has the code ${code}. Check the code on the patient's card.` });
      if (["picked_up", "confirmed"].includes(match.status)) return reply(409, { error: `${match.patientName}'s order was already picked up.` });
      if (!["accepted", "packed"].includes(match.status)) return reply(400, { error: `${match.patientName}'s order isn't ready for pickup yet.` });
      advance(match, "picked_up", who.email);
      sendText(await getPatient(match.patientId), match, "picked_up");
      await saveReferral(match);
      return reply(200, forPartner(match));
    }

    case "GET /results": {
      if (!is("care-manager")) return forbidden();
      const [referrals, patients] = await Promise.all([scanAll(REFERRALS_TABLE), scanAll(PATIENTS_TABLE)]);
      return reply(200, resultsFrom(referrals, patients));
    }

    // -- Access requests: anyone signed in can ask; admins decide --
    case "POST /access-requests": {
      const role = text(body.role, 20);
      if (!REQUESTABLE.includes(role)) return reply(400, { error: "Choose the kind of account you need." });
      if (!text(body.name)) return reply(400, { error: "Enter your name so the admin knows who's asking." });
      if (role === who.role) return reply(400, { error: "You already have that kind of account." });
      if (role === "demo" && who.demo) return reply(400, { error: "You can already see the full demo." });
      const existing = await getRequest(who.sub);
      const request = {
        id: who.sub,
        username: who.username,
        email: who.email,
        name: text(body.name),
        role,
        organization: text(body.organization, 120),
        note: text(body.note, 500),
        currentRole: who.role || undefined,
        status: "pending",
        createdAt: existing?.status === "pending" ? existing.createdAt : new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await saveRequest(request);
      return reply(201, { role: request.role, status: request.status, createdAt: request.createdAt });
    }

    case "GET /access-requests": {
      const all = await scanAll(REQUESTS_TABLE);
      const rank = (r) => (r.status === "pending" ? 0 : 1);
      return reply(200, all.sort((a, b) => rank(a) - rank(b) || (b.updatedAt ?? b.createdAt).localeCompare(a.updatedAt ?? a.createdAt)));
    }

    case "POST /access-requests/{id}/decision": {
      const request = await getRequest(patientId);
      if (!request) return reply(404, { error: "This request doesn't exist. Refresh the page." });
      if (request.status !== "pending") return reply(409, { error: `This request was already ${request.status}.` });
      const decision = text(body.decision, 10);
      if (!["approve", "deny"].includes(decision)) return reply(400, { error: "Choose approve or deny." });
      if (decision === "deny" && !text(body.note)) return reply(400, { error: "Say why, so the person knows what to do next." });
      let warning;
      if (decision === "approve") {
        const Username = request.username || request.email;
        await cognito.send(new AdminAddUserToGroupCommand({ UserPoolId: USER_POOL_ID, Username, GroupName: request.role }));
        // One main account type at a time: moving to a new one removes the old one. Admin and demo are added on top.
        if (ROLES.includes(request.role)) {
          for (const GroupName of ROLES.filter((r) => r !== request.role)) {
            await cognito.send(new AdminRemoveUserFromGroupCommand({ UserPoolId: USER_POOL_ID, Username, GroupName })).catch(() => {});
          }
        }
        if (request.role === "patient") {
          const match = (await scanAll(PATIENTS_TABLE)).find((p) => p.patientEmail === String(request.email).toLowerCase());
          if (!match) warning = `No patient record has ${request.email} yet. A care manager needs to add that email to the patient's record before their card appears.`;
        }
      }
      request.status = decision === "approve" ? "approved" : "denied";
      request.decidedBy = who.email;
      request.decidedAt = new Date().toISOString();
      request.updatedAt = request.decidedAt;
      request.decisionNote = text(body.note, 500) || undefined;
      await saveRequest(request);
      return reply(200, { ...request, warning });
    }

    // Loads made-up demo records. Fixed IDs, so running it again resets them. Demo accounts only.
    case "POST /demo/seed": {
      if (!who.demo) return forbidden();
      const { patients, sessions, referrals } = demoData(who.email);
      await Promise.all([
        ...patients.map((Item) => db.send(new PutCommand({ TableName: PATIENTS_TABLE, Item }))),
        ...sessions.map((Item) => db.send(new PutCommand({ TableName: SESSIONS_TABLE, Item }))),
        ...referrals.map((Item) => saveReferral(Item)),
      ]);
      return reply(200, { patients: patients.length, sessions: sessions.length, referrals: referrals.length });
    }

    default:
      return reply(404, { error: "Unknown route." });
  }
};

// ---- Made-up demo records (no real people) ----
function demoData(by) {
  const now = Date.now();
  const day = 86400000;
  const at = (daysAgo, hour = 10) => {
    const d = new Date(now - daysAgo * day);
    d.setUTCHours(hour + 4, 0, 0, 0);
    return new Date(Math.min(d.getTime(), now - 60000)).toISOString(); // never in the future
  };
  const clinics = ["Riverbend Dialysis Center", "Eastgate Kidney Care"];
  const people = [
    ["Maya Thompson", "1962-03-14", 71.5, "Mon/Wed/Fri", "Fistula", 4, 0, "Yes"],
    ["James Carter", "1955-11-02", 84.0, "Tue/Thu/Sat", "Graft", 2, 0, "Yes"],
    ["Rosa Delgado", "1970-07-21", 66.2, "Mon/Wed/Fri", "Fistula", 5, 1, "Yes"],
    ["Henry Walker", "1949-01-30", 79.8, "Tue/Thu/Sat", "Catheter", 1, 0, "Yes"],
    ["Aisha Bello", "1968-09-09", 62.4, "Mon/Wed/Fri", "Graft", 3, 1, "Yes"],
    ["Tom Nguyen", "1959-05-17", 88.1, "Tue/Thu/Sat", "Fistula", 2, 1, "No"],
  ];
  // Made-up 12-week numbers: [hospital stays, ER visits, missed treatments] before -> after, and labs in range before -> now
  const demoOutcomes = [
    [2, 1, 3, 1, 4, 1, "out", "in"], [1, 1, 2, 2, 3, 2, "out", "out"], [1, 0, 2, 1, 2, 0, "out", "in"],
    [2, 1, 1, 1, 5, 2, "in", "in"], [1, 0, 2, 1, 1, 1, "out", "in"], null,
  ];
  // Made-up diagnoses and plans: [conditions, wants tailored food, plan name, plan type, plan food benefits]
  const demoHealth = [
    [["dialysis", "diabetes"], "Yes", "Demo Advantage Plan", "Medicare Advantage", ["meals", "card"]],
    [["dialysis", "hypertension"], "Yes", "Demo Medicaid Plan", "Medicaid", ["box"]],
    [["dialysis", "diabetes", "hypertension"], "Yes", "Demo Advantage Plan", "Medicare Advantage", ["card"]],
    [["dialysis", "cholesterol"], "Yes", undefined, "Medicare", []],
    [["dialysis"], "No", "Demo Medicaid Plan", "Medicaid", ["box"]],
    [["dialysis", "hypertension"], "Yes", undefined, "Commercial", []],
  ];
  const patients = people.map(([name, dob, dryWeightKg, schedule, access, householdSize, clinic, optedIn], i) => {
    const o = demoOutcomes[i];
    const [conditions, tailorFood, planName, planType, benefits] = demoHealth[i];
    return {
      id: `demo-pt-${i + 1}`, name, dob, dryWeightKg, schedule, access, householdSize, clinic: clinics[clinic], optedIn, createdBy: by,
      phone: `(919) 555-01${String(i + 1).padStart(2, "0")}`, textsOk: i === 3 ? "No" : "Yes", // made-up 555 numbers; Henry prefers calls
      address: `${100 + i * 12} Demo Street, Durham, NC`, // made-up
      health: { conditions, tailorFood, plan: { name: planName, type: planType, benefits }, updatedAt: new Date(now).toISOString(), updatedBy: by },
      outcomes: o ? {
        hospitalBefore: o[0], hospitalAfter: o[1], erBefore: o[2], erAfter: o[3], missedBefore: o[4], missedAfter: o[5],
        labsBefore: o[6], labsNow: o[7], updatedAt: new Date(now).toISOString(), updatedBy: by,
      } : undefined,
    };
  });

  const sessions = [];
  const addSessions = (p, rows) => rows.forEach(([daysAgo, pre, post, preSys, postSys, minutes, notes]) => {
    const s = { patientId: p.id, recordedAt: at(daysAgo, 9), preWeightKg: pre, postWeightKg: post, preSystolic: preSys, postSystolic: postSys, minutes, fluidRemovedKg: Number((pre - post).toFixed(1)), notes, recordedBy: by };
    s.alerts = alertsFor(s, p);
    sessions.push(s);
  });
  addSessions(patients[0], [[1, 74.6, 72.1, 184, 128, 240, "Reports skipping meals near the end of the month."], [3, 73.9, 71.7, 162, 124, 240, ""], [5, 74.2, 71.9, 158, 120, 225, ""]]);
  addSessions(patients[1], [[2, 86.3, 84.4, 150, 118, 240, ""], [4, 86.9, 84.6, 148, 86, 240, "Lightheaded after treatment."]]);
  addSessions(patients[3], [[2, 82.4, 81.2, 170, 122, 210, ""]]);

  const steps = { referred: 0, accepted: 1, packed: 2, picked_up: 3, confirmed: 4 };
  const order = ["referred", "accepted", "packed", "picked_up", "confirmed"];
  const needs = ["Renal-friendly food box", "Groceries for the household", "Renal-friendly food box", "Fresh produce bag"];
  const referrals = [];
  let confirmedCount = 0;
  // [patient index, days ago referred, furthest step, days per step, code, extra]
  const plan = [
    [0, 33, "confirmed", 2, "MAY3CA"], [1, 31, "confirmed", 3, "JAM4CD"], [2, 29, "confirmed", 2, "RQD7EF"],
    [3, 26, "confirmed", 4, "HNK9FG"], [4, 24, "picked_up", 3, "AYK3GH"], [0, 19, "confirmed", 2, "MAY4HJ"],
    [2, 17, "confirmed", 1, "RQD9JK"], [1, 15, "issue", 2, "JAM7KM", "Box was missing the low-potassium items."],
    [3, 12, "confirmed", 3, "HNK3MN"], [4, 10, "cancelled", 1, "AYK4NP", "Patient moved to a different clinic schedule."],
    [2, 8, "picked_up", 2, "RQD3PQ"], [3, 5, "accepted", 1, "HNK7QR"], [1, 3, "referred", 0, "JAM9RT"],
    [0, 2, "packed", 1, "Q7KM4T"],
  ];
  plan.forEach(([pi, daysAgo, furthest, perStep, code, extra], n) => {
    const p = patients[pi];
    const r = {
      id: `demo-ref-${n + 1}`, ref: `TM-${1040 + n}`, patientId: p.id, patientName: p.name, householdSize: p.householdSize,
      // Pickups happen after treatment on one of the patient's own dialysis days.
      need: needs[n % needs.length], pickupLocation: p.clinic, pickupWindow: `${p.schedule.startsWith("Mon") ? "Wednesday" : "Thursday"} after treatment`,
      partner: p.clinic === clinics[0] ? "Riverside Community Pantry" : "Eastside Food Collective", notes: "",
      diet: dietFor(p), pickupCode: code, createdAt: at(daysAgo), createdBy: by, history: [],
    };
    const last = furthest === "issue" ? steps.picked_up : furthest === "cancelled" ? steps.accepted : steps[furthest];
    for (let s = 0; s <= last; s++) r.history.push({ status: order[s], at: at(Math.max(daysAgo - s * perStep, 0), 10 + s), by: s === 0 ? by : s <= 3 ? "partner@demo" : "patient@demo" });
    if (furthest === "issue") r.history.push({ status: "issue", at: at(Math.max(daysAgo - 3 * perStep, 0), 17), by: "patient@demo", note: extra });
    if (furthest === "cancelled") r.history.push({ status: "cancelled", at: at(daysAgo - 2, 15), by, note: extra });
    r.status = r.history[r.history.length - 1].status;
    if (r.status === "confirmed") {
      // Made-up survey answers so the results page has something to show.
      const answers = [[4, "own", "no"], [3, "someone", "yes"], [4, "program", "no"], [2, "none", "yes", "Hard to get a ride after treatment."], [4, "someone", "unsure"], [3, "own", "no"], [4, "program", "yes"]];
      const [rating, ride, needsRideNext, comment] = answers[confirmedCount++ % answers.length];
      r.survey = { rating, ride, needsRideNext, comment, at: r.history[r.history.length - 1].at };
    }
    referrals.push(r);
  });

  // Made-up trips: [pickup code, ride or delivery, partner, who pays, status, when, cost].
  // Rides and deliveries fall on a day off from dialysis (patients are already at the clinic on treatment days),
  // so their pickup window moves to that day and each trip time sits inside it.
  const trips = [
    ["RQD7EF", "ride", "Demo Ride Service", "Health plan benefit", "completed", "Tuesday 11 AM", 22],
    ["HNK9FG", "delivery", "Demo Volunteer Drivers", "Volunteer, no cost", "completed", "Friday 1 PM", 0],
    ["HNK3MN", "delivery", "Demo Volunteer Drivers", "Volunteer, no cost", "completed", "Friday 12:30 PM", 0],
    ["RQD3PQ", "ride", "Demo Ride Service", "Health plan benefit", "completed", "Tuesday 10:30 AM", 18],
    ["HNK7QR", "delivery", "Demo Volunteer Drivers", "Volunteer, no cost", "scheduled", "Friday 1 PM"],
    ["JAM9RT", "ride", "Demo Ride Service", "Program or grant", "requested"],
  ];
  for (const [code, kind, partner, coverage, status, when, cost] of trips) {
    const r = referrals.find((x) => x.pickupCode === code);
    const p = patients.find((x) => x.id === r.patientId);
    r.pickupWindow = `${p.schedule.startsWith("Mon") ? "Tuesday" : "Friday"} 10 AM - 2 PM`;
    r.delivery = kind === "ride" ? "ride" : "home-delivery";
    r.ride = { kind, status: "requested", partner, coverage, address: p.address, phone: p.phone, history: [{ status: "requested", at: r.createdAt, by }] };
    if (status !== "requested") { r.ride.when = when; rideStep(r.ride, "scheduled", "driver@demo", undefined, r.history[1]?.at ?? r.createdAt); }
    if (status === "completed") { r.ride.cost = cost; rideStep(r.ride, "completed", "driver@demo", undefined, r.history.find((h) => h.status === "picked_up").at); }
    if (kind === "delivery" && status === "completed") r.history.find((h) => h.status === "picked_up").note = `Delivered home by ${partner}.`;
  }

  // Made-up texts and notes, so the message threads have something to show.
  const historyAt = (r, status) => r.history.find((h) => h.status === status)?.at;
  for (const r of referrals) {
    const p = patients.find((x) => x.id === r.patientId);
    if (!textsOk(p)) continue;
    sendText(p, r, "referred", r.createdAt);
    if (historyAt(r, "packed")) sendText(p, r, "packed", historyAt(r, "packed"));
    if (historyAt(r, "picked_up")) sendText(p, r, "picked_up", historyAt(r, "picked_up"));
  }
  const maya = referrals.find((r) => r.pickupCode === "Q7KM4T");
  addMessage(maya, "patient", "app", "Can my daughter pick it up for me if I'm running late from treatment?", {}, new Date(now).toISOString()); // newest message
  return { patients, sessions, referrals };
}
