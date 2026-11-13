import { useEffect, useState } from "react";
import { api } from "./api.js";
import { Form, Steps, ConfirmButton, SurveySummary, STATUS_LABEL, when, shortDate } from "./shared.jsx";
import Results from "./Results.jsx";

const CLINICS = ["Riverbend Dialysis Center", "Eastgate Kidney Care"];
const PARTNERS = ["Riverside Community Pantry", "Eastside Food Collective"];
const NEEDS = ["Renal-friendly food box", "Groceries for the household", "Fresh produce bag"];

const PATIENT_FIELDS = [
  ["name", "Full name", "text"],
  ["dob", "Date of birth", "date"],
  ["dryWeightKg", "Dry weight (kg)", "number"],
  ["householdSize", "People in household", "number", { defaultValue: 1 }],
  ["schedule", "Schedule", ["Mon/Wed/Fri", "Tue/Thu/Sat"]],
  ["access", "Access", ["Fistula", "Graft", "Catheter"]],
  ["clinic", "Clinic (pickup location)", CLINICS],
  ["optedIn", "Opted in to food referrals", ["Yes", "No"]],
  ["patientEmail", "Patient's email for their own login", "email", { optional: true, placeholder: "Optional" }],
];

const SESSION_FIELDS = [
  ["preWeightKg", "Weight before (kg)", "number"],
  ["postWeightKg", "Weight after (kg)", "number"],
  ["preSystolic", "Systolic BP before", "number"],
  ["postSystolic", "Systolic BP after", "number"],
  ["minutes", "Treatment time (min)", "number"],
  ["notes", "Notes", "textarea", { optional: true }],
];

export default function CareManager() {
  const [tab, setTab] = useState("patients");
  return (
    <>
      <nav className="tabs" aria-label="Care manager pages">
        <button aria-pressed={tab === "patients"} onClick={() => setTab("patients")}>Patients and referrals</button>
        <button aria-pressed={tab === "results"} onClick={() => setTab("results")}>Results for partners</button>
      </nav>
      {tab === "patients" ? <Patients /> : <Results />}
    </>
  );
}

function Patients() {
  const [patients, setPatients] = useState(null); // null until loaded
  const [referrals, setReferrals] = useState(null);
  const [selected, setSelected] = useState(null);
  const [sessions, setSessions] = useState({}); // { patientId: [newest session, ...] }
  const [error, setError] = useState("");

  useEffect(() => {
    api("/patients").then(setPatients).catch((e) => setError(e.message));
    api("/referrals").then(setReferrals).catch((e) => setError(e.message));
  }, []);

  // Load a patient's treatment history when they're chosen. Results are filed by patient ID,
  // so a slow reply can never show up under the wrong patient.
  useEffect(() => {
    if (!selected) return;
    api(`/patients/${selected.id}/sessions`)
      .then((list) => setSessions((all) => ({ ...all, [selected.id]: list })))
      .catch((e) => setError(e.message));
  }, [selected]);

  async function addPatient(values) {
    const patient = await api("/patients", values);
    setPatients((list) => [...(list ?? []), patient]);
    setSelected(patient);
  }

  async function saveOutcomes(values) {
    const updated = await api(`/patients/${selected.id}/outcomes`, values);
    setPatients((list) => list.map((p) => (p.id === updated.id ? updated : p)));
    setSelected(updated);
  }

  async function addSession(values) {
    const session = await api(`/patients/${selected.id}/sessions`, values);
    setSessions((all) => ({ ...all, [session.patientId]: [session, ...(all[session.patientId] ?? [])] }));
  }

  async function addReferral(values) {
    const referral = await api("/referrals", { ...values, patientId: selected.id });
    setReferrals((list) => [referral, ...(list ?? [])]);
  }

  async function cancelReferral(referral) {
    const updated = await api(`/referrals/${referral.id}/status`, { status: "cancelled", note: "Cancelled by care manager" });
    setReferrals((list) => list.map((r) => (r.id === updated.id ? updated : r)));
  }

  const sortedPatients = [...(patients ?? [])].sort((a, b) => a.name.localeCompare(b.name));
  const theirReferrals = (referrals ?? []).filter((r) => r.patientId === selected?.id);

  return (
    <main className="layout">
      <aside>
        <h2>Patients</h2>
        {!patients && !error && <p className="muted">Loading patients…</p>}
        {patients?.length === 0 && <p className="muted">No patients yet. Add the first one below.</p>}
        <ul className="patients">
          {sortedPatients.map((p) => (
            <li key={p.id}>
              <button className={p.id === selected?.id ? "active" : ""} onClick={() => setSelected(p)}>
                {p.name}
              </button>
            </li>
          ))}
        </ul>
        <h3>Add a patient</h3>
        <Form fields={PATIENT_FIELDS} submitLabel="Add patient" onSubmit={addPatient} />
      </aside>

      <section>
        {error && <p className="error">{error}</p>}
        {selected ? (
          <>
            <button className="back quiet" onClick={() => setSelected(null)}>All referrals</button>
            <h2>{selected.name}</h2>
            <dl className="facts">
              <div><dt>Household</dt><dd>{selected.householdSize ?? "Not recorded"}{selected.householdSize ? (selected.householdSize === 1 ? " person" : " people") : ""}</dd></div>
              <div><dt>Clinic</dt><dd>{selected.clinic || "Not recorded"}</dd></div>
              <div><dt>Food referrals</dt><dd>{selected.optedIn === "Yes" ? "Opted in" : "Not opted in"}</dd></div>
              <div><dt>Patient login</dt><dd>{selected.patientEmail || "None"}</dd></div>
              <div><dt>Schedule</dt><dd>{selected.schedule}</dd></div>
              <div><dt>Access</dt><dd>{selected.access}</dd></div>
              <div><dt>Dry weight</dt><dd>{selected.dryWeightKg} kg</dd></div>
              <div><dt>Born</dt><dd>{selected.dob || "Not recorded"}</dd></div>
            </dl>

            <h3>Food referrals</h3>
            {theirReferrals.length === 0 && <p className="muted">No food referrals yet.</p>}
            <ul className="ref-list">
              {theirReferrals.map((r) => (
                <li key={r.id} className="ref-card">
                  <div className="ref-head">
                    <strong>{r.need}</strong>
                    <span className="muted">{r.ref}</span>
                  </div>
                  <p className="ref-meta">{r.partner}. Pickup at {r.pickupLocation}, {r.pickupWindow}. Pickup code <code>{r.pickupCode}</code></p>
                  <Steps referral={r} />
                  <SurveySummary survey={r.survey} />
                  {["referred", "accepted", "packed", "issue"].includes(r.status) && (
                    <ConfirmButton label="Cancel referral" confirmLabel="Yes, cancel it" onConfirm={() => cancelReferral(r)} />
                  )}
                </li>
              ))}
            </ul>
            {selected.optedIn === "Yes" ? (
              <>
                <h4>Send a new referral</h4>
                {/* key gives each patient a fresh form, so details never carry over to the wrong person */}
                <Form
                  key={`ref-${selected.id}`}
                  fields={[
                    ["need", "What the household needs", NEEDS],
                    ["partner", "Food partner", PARTNERS, { defaultValue: selected.clinic === CLINICS[1] ? PARTNERS[1] : PARTNERS[0] }],
                    ["pickupWindow", "Pickup day and time", "text", { placeholder: "Wednesday after treatment" }],
                    ["pickupLocation", "Pickup location", "text", { defaultValue: selected.clinic }],
                    ["notes", "Notes for the food partner", "textarea", { optional: true, placeholder: "Low-potassium items, no stairs, etc." }],
                  ]}
                  submitLabel="Send referral"
                  onSubmit={addReferral}
                />
              </>
            ) : (
              <p className="muted">{selected.name} hasn't opted in to food referrals, so referrals can't be sent yet.</p>
            )}

            <h3>Outcomes for organization results</h3>
            <p className="muted small">Counts for the 12 weeks before TrueMatch and the latest 12 weeks. They feed the organization results that partners see, as totals only.</p>
            <Outcomes key={`out-${selected.id}-${selected.outcomes?.updatedAt ?? ""}`} outcomes={selected.outcomes} onSave={saveOutcomes} />

            <h3>Log a treatment session</h3>
            <Form key={selected.id} fields={SESSION_FIELDS} submitLabel="Save session" onSubmit={addSession} />

            <h3>Treatment history</h3>
            <History sessions={sessions[selected.id]} />
          </>
        ) : (
          <Board referrals={referrals} patients={patients} onOpen={(id) => setSelected(patients.find((p) => p.id === id))} />
        )}
      </section>
    </main>
  );
}

const LAB_CHOICES = [["", "Not recorded"], ["in", "All in range"], ["out", "Not all in range"]];

// Before/after counts for one patient. Blank fields are left as they were.
function Outcomes({ outcomes = {}, onSave }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const rows = [
    ["Hospital stays", "hospitalBefore", "hospitalAfter"],
    ["Emergency visits", "erBefore", "erAfter"],
    ["Missed dialysis treatments", "missedBefore", "missedAfter"],
  ];
  async function submit(event) {
    event.preventDefault();
    setSaving(true); setError(""); setSaved(false);
    try { await onSave(Object.fromEntries(new FormData(event.currentTarget))); setSaved(true); }
    catch (e) { setError(e.message); }
    finally { setSaving(false); }
  }
  return (
    <form className="outcomes" onSubmit={submit}>
      <table>
        <thead><tr><th></th><th>12 weeks before TrueMatch</th><th>Latest 12 weeks</th></tr></thead>
        <tbody>
          {rows.map(([label, before, after]) => (
            <tr key={label}>
              <th scope="row">{label}</th>
              <td><input name={before} type="number" min="0" max="365" step="1" defaultValue={outcomes[before] ?? ""} aria-label={`${label}, 12 weeks before TrueMatch`} /></td>
              <td><input name={after} type="number" min="0" max="365" step="1" defaultValue={outcomes[after] ?? ""} aria-label={`${label}, latest 12 weeks`} /></td>
            </tr>
          ))}
          <tr>
            <th scope="row">Potassium, phosphorus and albumin</th>
            {["labsBefore", "labsNow"].map((name) => (
              <td key={name}>
                <select name={name} defaultValue={outcomes[name] ?? ""} aria-label={`Labs, ${name === "labsBefore" ? "before TrueMatch" : "latest"}`}>
                  {LAB_CHOICES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
              </td>
            ))}
          </tr>
        </tbody>
      </table>
      {error && <p className="error">{error}</p>}
      {saved && <p className="notice" role="status">Saved. Organization results now include these numbers.</p>}
      <button disabled={saving}>{saving ? "Saving…" : "Save outcomes"}</button>
      {outcomes.updatedAt && <p className="muted small">Last updated {when(outcomes.updatedAt)}.</p>}
    </form>
  );
}

// The care manager's overview: every referral that still needs something, grouped by where it is.
function Board({ referrals, patients, onOpen }) {
  if (!referrals || !patients) return <p className="muted">Loading referrals…</p>;
  const groups = [
    ["issue", "Problems to follow up"],
    ["referred", "Waiting for the food partner"],
    ["accepted", "Accepted, being packed"],
    ["packed", "Ready for pickup"],
    ["picked_up", "Picked up, waiting for the patient to confirm"],
  ];
  const closed = referrals.filter((r) => r.status === "confirmed").length;
  // Patients who said they'll need a ride, newest answer per patient, so the care team can arrange transportation.
  const rides = Object.values(
    referrals
      .filter((r) => r.survey)
      .sort((a, b) => a.survey.at.localeCompare(b.survey.at))
      .reduce((latest, r) => ({ ...latest, [r.patientId]: r }), {})
  ).filter((r) => r.survey.needsRideNext === "yes");
  return (
    <>
      <h2>Referrals</h2>
      <p className="lede">{referrals.length === 0 ? "No referrals yet. Choose a patient to send the first one." : `${closed} of ${referrals.filter((r) => r.status !== "cancelled").length} referrals are closed: the patient confirmed they got their food.`}</p>
      {groups.map(([status, label]) => {
        const list = referrals.filter((r) => r.status === status);
        if (list.length === 0) return null;
        return (
          <div key={status} className={`board-group ${status}`}>
            <h3>{label} <span className="count">{list.length}</span></h3>
            <ul className="board-list">
              {list.map((r) => (
                <li key={r.id}>
                  <button onClick={() => onOpen(r.patientId)}>
                    <strong>{r.patientName}</strong>
                    <span>{r.need}, {r.pickupWindow}</span>
                    <span className="muted">{STATUS_LABEL[r.status]} {shortDate(r.history.at(-1).at)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
      {rides.length > 0 && (
        <div className="board-group ride">
          <h3>Need a ride for their next pickup <span className="count">{rides.length}</span></h3>
          <ul className="board-list">
            {rides.map((r) => (
              <li key={r.id}>
                <button onClick={() => onOpen(r.patientId)}>
                  <strong>{r.patientName}</strong>
                  <span>{r.survey.comment || "Said they'll need a ride next time."}</span>
                  <span className="muted">Answered {shortDate(r.survey.at)}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {patients.length === 0 && <p className="muted">Add a patient on the left to get started.</p>}
    </>
  );
}

// Width of the fluid-removed bar: 5 kg or more fills it.
const barWidth = (kg) => `${Math.min(Math.max(kg, 0) / 5, 1) * 100}%`;

function History({ sessions }) {
  if (!sessions) return <p className="muted">Loading treatment history…</p>;
  if (sessions.length === 0) return <p className="muted">No sessions yet. Log the first one above.</p>;

  // Newest first. Each treatment is a stop on the patient's route; a stop with alerts turns red.
  return (
    <ol className="route">
      {sessions.map((s) => (
        <li key={s.recordedAt} className={s.alerts.length ? "stop flagged" : "stop"}>
          <time dateTime={s.recordedAt}>{when(s.recordedAt)}</time>
          <dl className="readings">
            <div><dt>Weight</dt><dd>{s.preWeightKg} → {s.postWeightKg} kg</dd></div>
            <div>
              <dt>Fluid removed</dt>
              <dd>
                {s.fluidRemovedKg} kg
                <span className="track"><span className="bar" style={{ width: barWidth(s.fluidRemovedKg) }} /></span>
              </dd>
            </div>
            <div><dt>Systolic BP</dt><dd>{s.preSystolic} → {s.postSystolic}</dd></div>
            <div><dt>Time</dt><dd>{s.minutes} min</dd></div>
          </dl>
          {s.alerts.length > 0 && (
            <p className="alerts">{s.alerts.map((a) => <span key={a} className="alert">{a}</span>)}</p>
          )}
          {s.notes && <p className="notes">{s.notes}</p>}
        </li>
      ))}
    </ol>
  );
}
