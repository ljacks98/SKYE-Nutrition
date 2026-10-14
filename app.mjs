// Dialysis Care API: one Lambda function serves all four routes.
// API Gateway has already checked the user's sign-in token before this code runs.
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const { PATIENTS_TABLE, SESSIONS_TABLE } = process.env;

// Example alert limits. Have your clinical team set the real values.
const LIMITS = { highSystolic: 180, lowSystolic: 90, kgAboveDryWeight: 1 };

// ---- Small helpers ----
const reply = (statusCode, data) => ({
  statusCode,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(data),
});

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

// ---- Routes ----
export const handler = async (event) => {
  const user = event.requestContext.authorizer.jwt.claims.email;
  const patientId = event.pathParameters?.id;
  const body = JSON.parse(event.body || "{}");

  // Audit trail in CloudWatch Logs: who did what, to which record. No medical details.
  console.log(JSON.stringify({ audit: event.routeKey, user, patientId }));

  switch (event.routeKey) {
    case "GET /patients": {
      const { Items } = await db.send(new ScanCommand({ TableName: PATIENTS_TABLE }));
      return reply(200, Items);
    }

    case "POST /patients": {
      const nums = positiveNumbers(body, ["dryWeightKg"]);
      if (!text(body.name) || !nums) return reply(400, { error: "Enter a name and a dry weight above 0." });
      const patient = {
        id: randomUUID(),
        name: text(body.name),
        dob: text(body.dob, 10),
        schedule: text(body.schedule),
        access: text(body.access),
        ...nums,
        createdBy: user,
      };
      await db.send(new PutCommand({ TableName: PATIENTS_TABLE, Item: patient }));
      return reply(201, patient);
    }

    case "GET /patients/{id}/sessions": {
      const { Items } = await db.send(new QueryCommand({
        TableName: SESSIONS_TABLE,
        KeyConditionExpression: "patientId = :id",
        ExpressionAttributeValues: { ":id": patientId },
        ScanIndexForward: false, // newest first
      }));
      return reply(200, Items);
    }

    case "POST /patients/{id}/sessions": {
      const { Item: patient } = await db.send(new GetCommand({ TableName: PATIENTS_TABLE, Key: { id: patientId } }));
      if (!patient) return reply(404, { error: "This patient doesn't exist. Refresh the patient list." });
      const nums = positiveNumbers(body, ["preWeightKg", "postWeightKg", "preSystolic", "postSystolic", "minutes"]);
      if (!nums) return reply(400, { error: "Fill in every number with a value above 0." });
      const session = {
        patientId,
        recordedAt: new Date().toISOString(),
        ...nums,
        fluidRemovedKg: Number((nums.preWeightKg - nums.postWeightKg).toFixed(1)),
        notes: text(body.notes, 1000),
        recordedBy: user,
      };
      session.alerts = alertsFor(session, patient);
      await db.send(new PutCommand({ TableName: SESSIONS_TABLE, Item: session }));
      return reply(201, session);
    }

    default:
      return reply(404, { error: "Unknown route." });
  }
};
