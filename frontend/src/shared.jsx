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
