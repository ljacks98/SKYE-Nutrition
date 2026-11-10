import { useEffect, useRef, useState } from "react";
import { api } from "./api.js";
import { Steps, STATUS_LABEL, shortDate } from "./shared.jsx";

// The food partner's day: confirm pickups by scanning the patient's code, and work the queue.
export default function FoodPartner() {
  const [referrals, setReferrals] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api("/referrals").then(setReferrals).catch((e) => setError(e.message));
  }, []);

  const replace = (updated) => setReferrals((list) => list.map((r) => (r.id === updated.id ? updated : r)));
  const move = async (r, status) => replace(await api(`/referrals/${r.id}/status`, { status }));

  const lanes = [
    ["referred", "New referrals", "Accept", "accepted"],
    ["accepted", "To pack", "Mark packed", "packed"],
    ["packed", "Ready for pickup", null, null],
  ];
  const done = (referrals ?? []).filter((r) => ["picked_up", "confirmed", "issue"].includes(r.status)).slice(0, 8);

  return (
    <main className="single">
      <PickupCheckIn onPickedUp={replace} />
      {error && <p className="error">{error}</p>}
      {!referrals && !error && <p className="muted">Loading referrals…</p>}
      {referrals && lanes.map(([status, title, action, next]) => {
        const list = referrals.filter((r) => r.status === status);
        return (
          <div key={status} className="lane">
            <h3>{title} <span className="count">{list.length}</span></h3>
            {list.length === 0 && <p className="muted">Nothing here right now.</p>}
            <ul className="ref-list">
              {list.map((r) => (
                <li key={r.id} className="ref-card">
                  <div className="ref-head">
                    <strong>{r.patientName}</strong>
                    <span className="muted">{r.ref}</span>
                  </div>
                  <p className="ref-meta">
                    {r.need} for a household of {r.householdSize}. Pickup at {r.pickupLocation}, {r.pickupWindow}.
                  </p>
                  {r.notes && <p className="notes">{r.notes}</p>}
                  {action ? (
                    <button onClick={() => move(r, next).catch((e) => setError(e.message))}>{action}</button>
                  ) : (
                    <p className="muted">Scan the code on {r.patientName.split(" ")[0]}'s patient card at handoff.</p>
                  )}
                </li>
              ))}
            </ul>
          </div>
        );
      })}
      {done.length > 0 && (
        <div className="lane">
          <h3>Recently handed over</h3>
          <ul className="ref-list">
            {done.map((r) => (
              <li key={r.id} className="ref-card">
                <div className="ref-head"><strong>{r.patientName}</strong><span className="muted">{STATUS_LABEL[r.status]} {shortDate(r.history.at(-1).at)}</span></div>
                <Steps referral={r} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </main>
  );
}

// Confirms a pickup: scan the QR code on the patient's card, or type the 6-character code under it.
function PickupCheckIn({ onPickedUp }) {
  const [code, setCode] = useState("");
  const [result, setResult] = useState(null); // { ok, text }
  const [busy, setBusy] = useState(false);

  async function confirm(raw) {
    setBusy(true);
    setResult(null);
    try {
      const r = await api("/pickup", { code: raw });
      onPickedUp(r);
      setResult({ ok: true, text: `Picked up: ${r.patientName}, ${r.need.toLowerCase()} for a household of ${r.householdSize}.` });
      setCode("");
    } catch (e) {
      setResult({ ok: false, text: e.message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="checkin">
      <h2>Pickup check-in</h2>
      <p>Scan the QR code on the patient's card, or type the code printed under it.</p>
      <Scanner onCode={confirm} />
      <form className="code-form" onSubmit={(e) => { e.preventDefault(); confirm(code); }}>
        <label>
          Pickup code
          <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} maxLength={7} autoComplete="off" placeholder="Q7KM4T" required />
        </label>
        <button disabled={busy}>{busy ? "Checking…" : "Confirm pickup"}</button>
      </form>
      {result && <p className={result.ok ? "checkin-ok" : "checkin-error"} role="status">{result.text}</p>}
    </div>
  );
}

// Uses the browser's built-in QR reader where it exists (Chrome on Android and Mac). Elsewhere, people type the code.
function Scanner({ onCode }) {
  const video = useRef(null);
  const latestOnCode = useRef(onCode);
  latestOnCode.current = onCode; // always call the newest handler without restarting the camera
  const [on, setOn] = useState(false);
  const [error, setError] = useState("");
  const supported = typeof window !== "undefined" && "BarcodeDetector" in window && navigator.mediaDevices?.getUserMedia;

  useEffect(() => {
    if (!on) return;
    let stream;
    let timer;
    let stopped = false;
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
        video.current.srcObject = stream;
        await video.current.play();
        const detector = new window.BarcodeDetector({ formats: ["qr_code"] });
        const look = async () => {
          if (stopped) return;
          const found = await detector.detect(video.current).catch(() => []);
          if (found[0]?.rawValue) {
            setOn(false);
            latestOnCode.current(found[0].rawValue);
            return;
          }
          timer = setTimeout(look, 250);
        };
        look();
      } catch {
        setError("The camera didn't open. Allow camera access, or type the code instead.");
        setOn(false);
      }
    })();
    return () => {
      stopped = true;
      clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [on]);

  if (!supported) return <p className="muted small">This browser can't scan QR codes. Type the code below instead.</p>;
  return (
    <div className="scanner">
      {on ? (
        <>
          <video ref={video} muted playsInline aria-label="Camera view for scanning the pickup code" />
          <button type="button" className="quiet on-dark" onClick={() => setOn(false)}>Stop camera</button>
        </>
      ) : (
        <button type="button" onClick={() => { setError(""); setOn(true); }}>Scan with camera</button>
      )}
      {error && <p className="checkin-error">{error}</p>}
    </div>
  );
}
