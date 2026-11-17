import { useEffect, useState } from "react";
import { api } from "./api.js";
import { STATUS_LABEL, shortDate } from "./shared.jsx";

// Transportation partners: volunteer drivers, ride services, delivery programs.
// They see first name, address, phone, place and time for each trip, and nothing about the patient's health.
export default function TransportPartner() {
  const [trips, setTrips] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    api("/rides").then(setTrips).catch((e) => setError(e.message));
  }, []);
  const replace = (updated) => setTrips((list) => list.map((t) => (t.id === updated.id ? updated : t)));
  const lanes = [
    ["requested", "New requests"],
    ["scheduled", "Scheduled"],
    ["completed", "Done"],
    ["declined", "Declined"],
  ];
  return (
    <main className="single transport">
      <h2>Rides and deliveries</h2>
      <p className="lede">Trips TrueMatch care managers asked you to do. You'll see where and when to go, and how to reach the patient. Health details stay with their care team.</p>
      {error && <p className="error">{error}</p>}
      {!trips && !error && <p className="muted">Loading trips…</p>}
      {trips?.length === 0 && <p className="muted">No trips yet.</p>}
      {trips && lanes.map(([status, title]) => {
        const list = trips.filter((t) => t.ride.status === status).sort((a, b) => b.ride.history.at(-1).at.localeCompare(a.ride.history.at(-1).at));
        if (list.length === 0) return null;
        return (
          <div key={status} className="lane">
            <h3>{title} <span className="count">{list.length}</span></h3>
            <ul className="trip-list">
              {list.map((t) => <Trip key={t.id} trip={t} onChange={replace} />)}
            </ul>
          </div>
        );
      })}
    </main>
  );
}

function Trip({ trip: t, onChange }) {
  const [mode, setMode] = useState(""); // "", schedule, decline, complete, deliver
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const delivery = t.ride.kind === "delivery";

  async function submit(event) {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    setBusy(true); setError("");
    try {
      onChange(await api(`/rides/${t.id}`, { ...values, action: mode }));
      setMode("");
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className={`ref-card trip ${t.ride.status}`}>
      <div className="ref-head">
        <strong>{delivery ? "Home delivery" : "Ride to the pickup"} for {t.firstName}</strong>
        <span className="muted">{t.ref}</span>
      </div>
      <dl className="facts">
        {delivery ? (
          <>
            <div><dt>Pick up the food at</dt><dd>{t.pickupLocation}, from {t.foodPartner}</dd></div>
            <div><dt>Deliver to</dt><dd>{t.ride.address}</dd></div>
          </>
        ) : (
          <>
            <div><dt>Pick up {t.firstName} at</dt><dd>{t.ride.address}</dd></div>
            <div><dt>Take them to</dt><dd>{t.pickupLocation}, and home after</dd></div>
          </>
        )}
        <div><dt>Phone</dt><dd>{t.ride.phone || "Not on file. Ask the care manager."}</dd></div>
        <div><dt>Their pickup window</dt><dd>{t.pickupWindow}</dd></div>
        <div><dt>Scheduled for</dt><dd>{t.ride.when || "Not scheduled yet"}</dd></div>
        <div><dt>Household</dt><dd>{t.householdSize === 1 ? "1 person" : `${t.householdSize} people`}{delivery ? " (box size)" : ""}</dd></div>
        <div><dt>Who pays</dt><dd>{t.ride.coverage}{typeof t.ride.cost === "number" ? `, $${t.ride.cost.toFixed(2)}` : ""}</dd></div>
        <div><dt>Food</dt><dd>{t.foodReady ? "Packed and ready" : STATUS_LABEL[t.referralStatus]}</dd></div>
      </dl>
      {t.ride.status === "declined" && <p className="notes">Declined: {t.ride.history.at(-1).note}</p>}
      {t.ride.status === "completed" && <p className="muted small">Done {shortDate(t.ride.history.at(-1).at)}.</p>}

      {!mode && ["requested", "scheduled"].includes(t.ride.status) && (
        <div className="msg-actions">
          <button onClick={() => setMode("schedule")}>{t.ride.status === "requested" ? "Schedule" : "Reschedule"}</button>
          {t.ride.status === "scheduled" && !delivery && <button onClick={() => setMode("complete")}>Mark ride done</button>}
          {t.ride.status === "scheduled" && delivery && <button onClick={() => setMode("deliver")}>Confirm delivery</button>}
          <button className="quiet" onClick={() => setMode("decline")}>Can't do this trip</button>
        </div>
      )}

      {mode && (
        <form className="form trip-form" onSubmit={submit}>
          {mode === "schedule" && (
            <label className="full">Day and time<input name="when" required defaultValue={t.ride.when ?? ""} placeholder="Thursday 11 AM" /></label>
          )}
          {mode === "decline" && (
            <label className="full">Why can't you do it?<textarea name="note" rows={2} required placeholder="No drivers that day" /></label>
          )}
          {mode === "deliver" && (
            <label className="full">
              The patient's pickup code
              <input name="code" required autoComplete="off" placeholder="6 letters and numbers" />
              <span className="muted small">Ask {t.firstName} to show the code on their TrueMatch card. It confirms they got the food.</span>
            </label>
          )}
          {(mode === "complete" || mode === "deliver") && (
            <label>Trip cost in dollars (optional)<input name="cost" type="number" min="0" step="0.01" placeholder="0" /></label>
          )}
          {error && <p className="error">{error}</p>}
          <div className="msg-actions">
            <button disabled={busy}>{busy ? "Saving…" : { schedule: "Save time", decline: "Send to care manager", complete: "Mark done", deliver: "Confirm delivery" }[mode]}</button>
            <button type="button" className="quiet" onClick={() => { setMode(""); setError(""); }}>Back</button>
          </div>
        </form>
      )}
    </li>
  );
}
