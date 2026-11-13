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

const ROLES = ["care-manager", "food-partner", "patient"];
const REQUESTABLE = [...ROLES, "admin"]; // account types a person can ask an admin for
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
  const demo = groups.includes("demo");
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
const forPartner = ({ pickupCode, patientId, createdBy, survey, ...rest }) => rest;
// What a patient sees about their own referral (they need their own pickup code).
const forPatient = ({ createdBy, ...rest }) => rest;

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

  return {
    generatedAt: new Date().toISOString(),
    organization: organizationFrom(patients, referrals),
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
        me.patient = p ? { id: p.id, name: p.name, clinic: p.clinic, householdSize: p.householdSize } : null;
      }
      return reply(200, me);
    }

    // -- Patients and treatment sessions: care managers only --
    case "GET /patients": {
      if (!is("care-manager")) return forbidden();
      return reply(200, await scanAll(PATIENTS_TABLE));
    }

    case "POST /patients": {
      if (!is("care-manager")) return forbidden();
      const nums = positiveNumbers(body, ["dryWeightKg", "householdSize"]);
      if (!text(body.name) || !nums) return reply(400, { error: "Enter a name, a dry weight above 0, and a household size of at least 1." });
      const patient = {
        id: randomUUID(),
        name: text(body.name),
        dob: text(body.dob, 10),
        schedule: text(body.schedule),
        access: text(body.access),
        clinic: text(body.clinic),
        optedIn: body.optedIn === "Yes" ? "Yes" : "No",
        patientEmail: text(body.patientEmail, 200).toLowerCase() || undefined,
        dryWeightKg: nums.dryWeightKg,
        householdSize: Math.round(nums.householdSize),
        createdBy: who.email,
      };
      await db.send(new PutCommand({ TableName: PATIENTS_TABLE, Item: patient }));
      return reply(201, patient);
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
      return reply(200, patient);
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
        pickupCode: newPickupCode(),
        createdAt: new Date().toISOString(),
        createdBy: who.email,
      }, "referred", who.email);
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
      await saveReferral(advance(referral, to, who.email, text(body.note, 500)));
      return reply(200, is("food-partner") ? forPartner(referral) : is("patient") ? forPatient(referral) : referral);
    }

    // The food partner scans or types the code on the patient's card at handoff.
    case "POST /pickup": {
      if (!is("food-partner")) return forbidden();
      const code = text(body.code, 64).toUpperCase().replace(/^TRUEMATCH:/, "").replace(/[^A-Z0-9]/g, "");
      if (code.length !== 6) return reply(400, { error: "Pickup codes are 6 letters and numbers. Check the code on the patient's card." });
      const match = (await scanAll(REFERRALS_TABLE)).find((r) => r.pickupCode === code);
      if (!match) return reply(404, { error: `No referral has the code ${code}. Check the code on the patient's card.` });
      if (["picked_up", "confirmed"].includes(match.status)) return reply(409, { error: `${match.patientName}'s order was already picked up.` });
      if (!["accepted", "packed"].includes(match.status)) return reply(400, { error: `${match.patientName}'s order isn't ready for pickup yet.` });
      await saveReferral(advance(match, "picked_up", who.email));
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
        // One main account type at a time: moving to a new one removes the old one. Admin is added on top.
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
  const patients = people.map(([name, dob, dryWeightKg, schedule, access, householdSize, clinic, optedIn], i) => {
    const o = demoOutcomes[i];
    return {
      id: `demo-pt-${i + 1}`, name, dob, dryWeightKg, schedule, access, householdSize, clinic: clinics[clinic], optedIn, createdBy: by,
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
      need: needs[n % needs.length], pickupLocation: p.clinic, pickupWindow: n % 2 ? "Thursday 10 AM - 2 PM" : "Wednesday after treatment",
      partner: p.clinic === clinics[0] ? "Riverside Community Pantry" : "Eastside Food Collective", notes: "",
      pickupCode: code, createdAt: at(daysAgo), createdBy: by, history: [],
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
  return { patients, sessions, referrals };
}
