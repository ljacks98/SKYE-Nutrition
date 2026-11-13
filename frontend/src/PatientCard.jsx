import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { api } from "./api.js";
import { Steps, STATUS_LABEL, RATING_LABEL, RIDE_LABEL, RIDE_NEXT_LABEL, firstName, shortDate } from "./shared.jsx";

// One survey question as large tap-friendly choices.
function Choices({ legend, name, options, answers, setAnswers }) {
  return (
    <fieldset className="choices">
      <legend>{legend}</legend>
      {options.map(([value, label]) => (
        <label key={value} className={String(answers[name]) === String(value) ? "picked" : ""}>
          <input type="radio" name={name} value={value} checked={String(answers[name]) === String(value)} onChange={() => setAnswers((a) => ({ ...a, [name]: value }))} />
          {label}
        </label>
      ))}
    </fieldset>
  );
}

// What a patient sees: their next pickup with the code to show at handoff, and a way to say how it went.
export default function PatientCard() {
  const [me, setMe] = useState(null);
  const [referrals, setReferrals] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api("/me").then(setMe).catch((e) => setError(e.message));
    api("/referrals").then(setReferrals).catch((e) => setError(e.message));
  }, []);

  const replace = (updated) => setReferrals((list) => list.map((r) => (r.id === updated.id ? updated : r)));

  if (error) return <main className="single"><p className="error">{error}</p></main>;
  if (!me || !referrals) return <main className="single"><p className="muted">Loading your card…</p></main>;
  if (!me.patient) {
    return (
      <main className="single">
        <h2>Your patient card</h2>
        <p className="lede">We couldn't find your patient record yet. Ask your care manager to add {me.email} to your record, then sign in again.</p>
      </main>
    );
  }

  const live = referrals.filter((r) => r.status !== "cancelled");
  const current = live.find((r) => r.status !== "confirmed") ?? null;
  const past = live.filter((r) => r !== current);

  return (
    <main className="single patient">
      <h2>{firstName(me.patient.name)}'s food pickups</h2>
      <p className="lede">From your care team at {me.patient.clinic}.</p>
      {current ? <CurrentPickup referral={current} onChange={replace} /> : <p className="muted">No pickups scheduled right now. Your care manager will set one up with you.</p>}
      {past.length > 0 && (
        <>
          <h3>Past pickups</h3>
          <ul className="past">
            {past.map((r) => (
              <li key={r.id}>
                <strong>{shortDate(r.createdAt)}</strong> {r.need} from {r.partner}
                <span className="muted"> {STATUS_LABEL[r.status]}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </main>
  );
}

function CurrentPickup({ referral: r, onChange }) {
  const [qr, setQr] = useState("");
  const [problem, setProblem] = useState(false);
  const [surveyOpen, setSurveyOpen] = useState(false);
  const [answers, setAnswers] = useState({});
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    QRCode.toDataURL(`truematch:${r.pickupCode}`, { margin: 1, width: 240, color: { dark: "#13294b", light: "#ffffff" } }).then(setQr);
  }, [r.pickupCode]);

  async function send(status, survey) {
    setBusy(true);
    setError("");
    try {
      onChange(await api(`/referrals/${r.id}/status`, { status, note, survey }));
      setProblem(false);
      setNote("");
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  const waiting = ["referred", "accepted", "packed"].includes(r.status);
  return (
    <div className="pickup-card">
      <div className="pickup-code">
        {qr && <img src={qr} alt={`QR code for pickup code ${r.pickupCode}`} width="240" height="240" />}
        <p className="code-text" aria-label={`Pickup code ${r.pickupCode.split("").join(" ")}`}>{r.pickupCode.slice(0, 3)} {r.pickupCode.slice(3)}</p>
        <p className="small">Show this at pickup. The food partner scans it to confirm you got your food.</p>
      </div>
      <div className="pickup-details">
        <dl className="facts stacked">
          <div><dt>What</dt><dd>{r.need} ({r.householdSize === 1 ? "1 person" : `${r.householdSize} people`})</dd></div>
          <div><dt>Where</dt><dd>{r.pickupLocation}</dd></div>
          <div><dt>When</dt><dd>{r.pickupWindow}</dd></div>
          <div><dt>From</dt><dd>{r.partner}</dd></div>
        </dl>
        <Steps referral={r} />

        {r.status === "picked_up" && !problem && !surveyOpen && (
          <div className="patient-actions">
            <p>Did you get everything?</p>
            <button onClick={() => setSurveyOpen(true)}>Yes, I got my food</button>
            <button className="quiet" onClick={() => setProblem(true)}>Something was wrong</button>
          </div>
        )}
        {r.status === "picked_up" && surveyOpen && (
          <form className="survey" onSubmit={(e) => { e.preventDefault(); send("confirmed", answers); }}>
            <p className="survey-intro">Glad you got it. Three quick questions help your care team plan your next pickup.</p>
            <Choices legend="How was this pickup?" name="rating" options={[4, 3, 2, 1].map((n) => [n, RATING_LABEL[n]])} answers={answers} setAnswers={setAnswers} />
            <Choices legend="How did you get to the pickup?" name="ride" options={Object.entries(RIDE_LABEL)} answers={answers} setAnswers={setAnswers} />
            <Choices legend="Will you need a ride next time?" name="needsRideNext" options={Object.entries(RIDE_NEXT_LABEL)} answers={answers} setAnswers={setAnswers} />
            <label className="survey-comment">
              Anything else your care team should know? (optional)
              <textarea rows={2} value={answers.comment ?? ""} onChange={(e) => setAnswers((a) => ({ ...a, comment: e.target.value }))} />
            </label>
            <div className="patient-actions">
              <button disabled={busy}>{busy ? "Sending…" : "Send and confirm pickup"}</button>
              <button type="button" className="quiet" disabled={busy} onClick={() => send("confirmed")}>Skip the questions</button>
            </div>
          </form>
        )}
        {r.status === "confirmed" && <p className="exit-note">Thank you. Your care team has your answers.</p>}
        {waiting && !problem && (
          <div className="patient-actions">
            <button className="quiet" onClick={() => setProblem(true)}>I can't make this pickup</button>
          </div>
        )}
        {problem && (
          <form className="form problem" onSubmit={(e) => { e.preventDefault(); send("issue"); }}>
            <label className="full">
              What happened?
              <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} required placeholder="For example: the box was missing items, or I can't come Wednesday." />
            </label>
            <button disabled={busy}>Tell my care manager</button>
            <button type="button" className="quiet" onClick={() => setProblem(false)}>Never mind</button>
          </form>
        )}
        {r.status === "issue" && <p className="exit-note">Your care manager has your message and will follow up with you.</p>}
        {error && <p className="error">{error}</p>}
      </div>
    </div>
  );
}
