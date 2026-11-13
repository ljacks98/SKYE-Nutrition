import { useState } from "react";

// A referral's stops, in order. "issue" and "cancelled" are side exits shown under the line.
export const STEPS = [
  ["referred", "Referred"],
  ["accepted", "Accepted"],
  ["packed", "Packed"],
  ["picked_up", "Picked up"],
  ["confirmed", "Confirmed"],
];
export const STATUS_LABEL = { ...Object.fromEntries(STEPS), confirmed: "Patient confirmed", issue: "Problem reported", cancelled: "Cancelled" };

// Patient survey wording. The server stores the keys.
export const RATING_LABEL = { 4: "Great", 3: "Good", 2: "Okay", 1: "Not good" };
export const RIDE_LABEL = {
  own: "I had my own way there",
  someone: "Family or a friend gave me a ride",
  program: "The clinic or my health plan gave me a ride",
  none: "I didn't have a ride",
};
export const RIDE_NEXT_LABEL = { yes: "Yes", no: "No", unsure: "Not sure" };

// One line a care manager can read at a glance.
export function SurveySummary({ survey }) {
  if (!survey) return null;
  const parts = [
    survey.rating && `Rated the pickup ${RATING_LABEL[survey.rating].toLowerCase()}`,
    survey.ride && RIDE_LABEL[survey.ride].replace(/^I /, "they ").replace(/\bmy\b/g, "their").replace(/\bme\b/g, "them").replace(/^./, (c) => c.toLowerCase()),
    survey.needsRideNext && (survey.needsRideNext === "yes" ? "needs a ride next time" : survey.needsRideNext === "no" ? "doesn't need a ride next time" : "not sure about a ride next time"),
  ].filter(Boolean);
  return (
    <div className={`survey-summary ${survey.needsRideNext === "yes" ? "needs-ride" : ""}`}>
      <p><strong>Patient feedback:</strong> {parts.join(", ")}.</p>
      {survey.comment && <p className="notes">"{survey.comment}"</p>}
    </div>
  );
}

export const ROLE_LABEL = {
  "care-manager": "Care manager",
  "food-partner": "Food partner",
  patient: "Patient",
  admin: "Admin",
};

export const when = (iso) => new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
export const shortDate = (iso) => new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" });
export const firstName = (name = "") => name.split(" ")[0];

// Builds a form from a field list and passes the entered values to onSubmit.
// Each field is [name, label, type, options]. A list as the type makes a dropdown.
// options: { optional, defaultValue, placeholder, full } (full = spans the whole row)
export function Form({ fields, submitLabel, onSubmit, className = "" }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(event) {
    event.preventDefault();
    const form = event.currentTarget;
    setSaving(true);
    setError("");
    try {
      await onSubmit(Object.fromEntries(new FormData(form)));
      form.reset();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className={`form ${className}`} onSubmit={handleSubmit}>
      {fields.map(([name, label, type, opts = {}]) => (
        <label key={name} className={opts.full || type === "textarea" ? "full" : ""}>
          {label}
          {Array.isArray(type) ? (
            <select name={name} defaultValue={opts.defaultValue}>
              {type.map((option) => <option key={option}>{option}</option>)}
            </select>
          ) : type === "textarea" ? (
            <textarea name={name} rows={2} placeholder={opts.placeholder} required={!opts.optional} />
          ) : (
            <input
              name={name}
              type={type}
              step={type === "number" ? "any" : undefined}
              defaultValue={opts.defaultValue}
              placeholder={opts.placeholder}
              required={!opts.optional}
            />
          )}
        </label>
      ))}
      {error && <p className="error">{error}</p>}
      <button disabled={saving}>{saving ? "Saving…" : submitLabel}</button>
    </form>
  );
}

// A referral drawn as a line with stops. Reached stops are filled; the current one is yellow.
export function Steps({ referral }) {
  const reached = {};
  for (const h of referral.history ?? []) reached[h.status] ??= h;
  const exit = ["issue", "cancelled"].includes(referral.status) ? reached[referral.status] : null;
  return (
    <div className="steps-wrap">
      <ol className="steps" aria-label={`Referral status: ${STATUS_LABEL[referral.status]}`}>
        {STEPS.map(([key, label]) => (
          <li key={key} className={[reached[key] && "done", referral.status === key && "current"].filter(Boolean).join(" ")}>
            <span className="stop-label">{label}</span>
            {reached[key] && <span className="stop-date">{shortDate(reached[key].at)}</span>}
          </li>
        ))}
      </ol>
      {exit && (
        <p className={`exit ${referral.status}`}>
          {STATUS_LABEL[referral.status]} {shortDate(exit.at)}
          {exit.note && <>: {exit.note}</>}
        </p>
      )}
    </div>
  );
}

// Two-step button for actions that are hard to undo, so a stray click doesn't fire them.
export function ConfirmButton({ label, confirmLabel, onConfirm, className = "" }) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!armed) return <button type="button" className={`quiet ${className}`} onClick={() => setArmed(true)}>{label}</button>;
  return (
    <span className="confirm-pair">
      <button type="button" className={`danger ${className}`} disabled={busy} onClick={async () => { setBusy(true); try { await onConfirm(); } finally { setBusy(false); setArmed(false); } }}>
        {busy ? "Working…" : confirmLabel}
      </button>
      <button type="button" className="quiet" onClick={() => setArmed(false)}>Keep it</button>
    </span>
  );
}

// ---- Medically tailored food. The server works out the food plan; these only show it. ----
export const CONDITION_LABEL = {
  dialysis: "Kidney failure on dialysis",
  diabetes: "Diabetes",
  hypertension: "High blood pressure",
  cholesterol: "High cholesterol",
};
export const BENEFIT_LABEL = { meals: "Medically tailored meals", box: "Healthy food box", card: "Grocery allowance card" };
export const PLAN_TYPES = ["Medicare Advantage", "Medicaid", "Medicare", "Commercial", "None or unknown"];

// Diet needs as small labels, for example "Low potassium". Never diagnoses.
export function DietTags({ diet, inline = false }) {
  if (!diet?.tags?.length) return null;
  const Wrap = inline ? "span" : "p";
  return (
    <Wrap className="diet-tags">
      {diet.tags.map((t) => <span key={t} className="diet-tag">{t}</span>)}
    </Wrap>
  );
}

// What to choose and what to limit, side by side, with any notes underneath.
export function FoodLists({ food, chooseTitle = "Choose more", limitTitle = "Limit" }) {
  return (
    <>
      <div className="food-lists">
        <div className="choose">
          <h4>{chooseTitle}</h4>
          <ul>{food.choose.map((x) => <li key={x}>{x}</li>)}</ul>
        </div>
        <div className="limit">
          <h4>{limitTitle}</h4>
          <ul>{food.limit.map((x) => <li key={x}>{x}</li>)}</ul>
        </div>
      </div>
      {food.notes?.map((n) => <p key={n} className="food-note">{n}</p>)}
    </>
  );
}
