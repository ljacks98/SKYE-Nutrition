import { useEffect, useState } from "react";
import { api, demoView, refreshSignIn } from "./api.js";
import { ROLE_LABEL } from "./shared.jsx";
import CareManager from "./CareManager.jsx";
import FoodPartner from "./FoodPartner.jsx";
import PatientCard from "./PatientCard.jsx";
import { Waiting, Account, AdminRequests } from "./Access.jsx";

const VIEWS = ["care-manager", "food-partner", "patient"];

// Decides what the signed-in person sees. The server enforces the same rules,
// so this only chooses screens; it isn't what keeps data private.
export default function App({ user, signOut }) {
  const [me, setMe] = useState(null);
  const [error, setError] = useState("");
  const [page, setPage] = useState("home"); // home | account | requests
  const [view, setView] = useState("care-manager"); // demo accounts only
  const [patientId, setPatientId] = useState(""); // demo accounts only, for the patient view
  const [reloads, setReloads] = useState(0);
  const [seeding, setSeeding] = useState(false);

  async function loadMe(fresh = false) {
    setError("");
    try {
      if (fresh) await refreshSignIn();
      demoView.role = "";
      demoView.patientId = "";
      const m = await api("/me");
      setMe(m);
      setPatientId((id) => id || m.demoPatients?.find((p) => p.id === "demo-pt-1")?.id || m.demoPatients?.[0]?.id || "");
    } catch (e) {
      setError(e.message);
    }
  }
  useEffect(() => { loadMe(); }, []);

  async function loadDemoData() {
    setSeeding(true);
    try {
      await api("/demo/seed", {});
      await loadMe();
      setReloads((n) => n + 1);
    } catch (e) {
      setError(e.message);
    } finally {
      setSeeding(false);
    }
  }

  const role = me?.demo ? view : me?.role;
  // Demo accounts tell the server which view to show; set before the views below make their requests.
  demoView.role = me?.demo && page === "home" ? view : "";
  demoView.patientId = me?.demo && page === "home" && view === "patient" ? patientId : "";

  let body;
  if (error && !me) body = <main className="single"><p className="error">{error}</p></main>;
  else if (!me) body = <main className="single"><p className="muted">Loading…</p></main>;
  else if (page === "account") body = <Account me={me} />;
  else if (page === "requests" && me.admin) body = <AdminRequests />;
  else if (!role) body = me.admin ? <AdminRequests /> : <Waiting me={me} onCheckAgain={() => loadMe(true)} />;
  else {
    const key = `${role}-${patientId}-${reloads}`; // a fresh screen whenever the view changes
    body = role === "care-manager" ? <CareManager key={key} /> : role === "food-partner" ? <FoodPartner key={key} /> : <PatientCard key={key} />;
  }

  return (
    <div className="app">
      <header>
        <h1><button className="home-link" onClick={() => setPage("home")}>TrueMatch</button></h1>
        {me && (
          <nav className="account-nav" aria-label="Account">
            {me.admin && <button aria-pressed={page === "requests"} onClick={() => setPage("requests")}>Access requests</button>}
            <button aria-pressed={page === "account"} onClick={() => setPage("account")}>Account</button>
          </nav>
        )}
        <span className="who">{user?.signInDetails?.loginId}{me?.role && !me.demo ? `, ${ROLE_LABEL[me.role].toLowerCase()}` : ""}</span>
        <button className="signout" onClick={signOut}>Sign out</button>
      </header>

      {me?.demo && page === "home" && (
        <div className="demobar">
          <span className="demobar-label">Demo account. Showing the</span>
          <div className="segmented" role="group" aria-label="Show TrueMatch as">
            {VIEWS.map((v) => (
              <button key={v} aria-pressed={view === v} onClick={() => setView(v)}>{ROLE_LABEL[v]}</button>
            ))}
          </div>
          <span className="demobar-label">view</span>
          {view === "patient" && me.demoPatients?.length > 0 && (
            <label className="demobar-patient">
              as
              <select value={patientId} onChange={(e) => setPatientId(e.target.value)}>
                {me.demoPatients.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </label>
          )}
          <button className="quiet demobar-seed" disabled={seeding} onClick={loadDemoData}>
            {seeding ? "Loading…" : me.demoPatients?.length ? "Reset demo data" : "Load demo data"}
          </button>
        </div>
      )}

      {error && me && <p className="error banner">{error}</p>}
      {body}
    </div>
  );
}
