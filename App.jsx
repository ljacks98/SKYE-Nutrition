import { useEffect, useState } from "react";
import { api } from "./api.js";

// Form fields as [name, label, type]. A list instead of a type makes a dropdown.
const PATIENT_FIELDS = [
  ["name", "Full name", "text"],
  ["dob", "Date of birth", "date"],
  ["dryWeightKg", "Dry weight (kg)", "number"],
  ["schedule", "Schedule", ["Mon/Wed/Fri", "Tue/Thu/Sat"]],
  ["access", "Access", ["Fistula", "Graft", "Catheter"]],
];

const SESSION_FIELDS = [
  ["preWeightKg", "Weight before (kg)", "number"],
  ["postWeightKg", "Weight after (kg)", "number"],
  ["preSystolic", "Systolic BP before", "number"],
  ["postSystolic", "Systolic BP after", "number"],
  ["minutes", "Treatment time (min)", "number"],
  ["notes", "Notes", "textarea"],
];

export default function App({ user, signOut }) {
  const [patients, setPatients] = useState(null); // null until loaded
  const [selected, setSelected] = useState(null);
  const [sessions, setSessions] = useState({}); // { patientId: [newest session, ...] }
  const [error, setError] = useState("");

  // Load the patient list once, after sign-in.
  useEffect(() => {
    api("/patients").then(setPatients).catch((e) => setError(e.message));
  }, []);

  // Load a patient's history when they're chosen. Results are filed by patient ID,
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

  async function addSession(values) {
    const session = await api(`/patients/${selected.id}/sessions`, values);
    setSessions((all) => ({ ...all, [session.patientId]: [session, ...(all[session.patientId] ?? [])] }));
  }

  const sortedPatients = [...(patients ?? [])].sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div className="app">
      <header>
        <h1>Dialysis Care</h1>
        <span>{user?.signInDetails?.loginId}</span>
        <button onClick={signOut}>Sign out</button>
      </header>

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
              <h2>{selected.name}</h2>
              <dl className="facts">
                <div><dt>Dry weight</dt><dd>{selected.dryWeightKg} kg</dd></div>
                <div><dt>Schedule</dt><dd>{selected.schedule}</dd></div>
                <div><dt>Access</dt><dd>{selected.access}</dd></div>
                <div><dt>Born</dt><dd>{selected.dob}</dd></div>
              </dl>

              <h3>Log a session</h3>
              {/* key gives each patient a fresh, empty form, so numbers never carry over to the wrong person */}
              <Form key={selected.id} fields={SESSION_FIELDS} submitLabel="Save session" onSubmit={addSession} />

              <h3>Treatment history</h3>
              <History sessions={sessions[selected.id]} />
            </>
          ) : (
            <p className="muted">Choose a patient on the left, or add one.</p>
          )}
        </section>
      </main>
    </div>
  );
}

// Builds a form from a field list and passes the entered values to onSubmit.
function Form({ fields, submitLabel, onSubmit }) {
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
    <form className="form" onSubmit={handleSubmit}>
      {fields.map(([name, label, type]) => (
        <label key={name}>
          {label}
          {Array.isArray(type) ? (
            <select name={name}>{type.map((option) => <option key={option}>{option}</option>)}</select>
          ) : type === "textarea" ? (
            <textarea name={name} rows={2} />
          ) : (
            <input name={name} type={type} step={type === "number" ? "any" : undefined} required />
          )}
        </label>
      ))}
      {error && <p className="error">{error}</p>}
      <button disabled={saving}>{saving ? "Saving…" : submitLabel}</button>
    </form>
  );
}

// Width of the fluid-removed bar: 5 kg or more fills it.
const barWidth = (kg) => `${Math.min(Math.max(kg, 0) / 5, 1) * 100}%`;

function History({ sessions }) {
  if (!sessions) return <p className="muted">Loading treatment history…</p>;
  if (sessions.length === 0) return <p className="muted">No sessions yet. Log the first one above.</p>;

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Date</th>
            <th>Weight (kg)</th>
            <th>Fluid removed</th>
            <th>Systolic BP</th>
            <th>Time</th>
            <th>Alerts</th>
            <th>Notes</th>
          </tr>
        </thead>
        <tbody>
          {sessions.map((s) => (
            <tr key={s.recordedAt}>
              <td>{new Date(s.recordedAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</td>
              <td>{s.preWeightKg} → {s.postWeightKg}</td>
              <td>
                {s.fluidRemovedKg} kg
                <span className="track"><span className="bar" style={{ width: barWidth(s.fluidRemovedKg) }} /></span>
              </td>
              <td>{s.preSystolic} → {s.postSystolic}</td>
              <td>{s.minutes} min</td>
              <td className="wrap">{s.alerts.map((a) => <span key={a} className="alert">{a}</span>)}</td>
              <td className="wrap">{s.notes}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
