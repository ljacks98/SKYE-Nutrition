import { useEffect, useState } from "react";
import { updatePassword } from "aws-amplify/auth";
import { api } from "./api.js";
import { Form, ROLE_LABEL, when } from "./shared.jsx";

const REQUEST_OPTIONS = [
  ["care-manager", "Care manager: refer patients and track their food pickups"],
  ["food-partner", "Food partner: pack orders and confirm pickups"],
  ["patient", "Patient: see my pickups and pickup code"],
  ["admin", "Admin: approve other people's access"],
];

// Asks an admin for an account type. Used by new accounts and by people who need a different one.
export function RequestForm({ me, onSent, exclude }) {
  const options = REQUEST_OPTIONS.filter(([role]) => role !== exclude && !(role === "admin" && me.admin));
  return (
    <Form
      fields={[
        ["name", "Your name", "text"],
        ["role", "Account type you need", options.map(([, label]) => label)],
        ["organization", "Clinic, health system, or food partner", "text", { optional: true, placeholder: "Riverbend Dialysis Center" }],
        ["note", "Anything the admin should know", "textarea", { optional: true, placeholder: "My role, who referred me, etc." }],
      ]}
      submitLabel="Send request"
      onSubmit={async (values) => {
        const role = options.find(([, label]) => label === values.role)[0];
        onSent(await api("/access-requests", { ...values, role }));
      }}
    />
  );
}

function RequestStatus({ request }) {
  if (!request) return null;
  const type = ROLE_LABEL[request.role]?.toLowerCase();
  if (request.status === "pending") return <p className="notice">Your request for {type} access is waiting for an admin. Sent {when(request.createdAt)}.</p>;
  if (request.status === "denied") return <p className="notice denied">Your request for {type} access was declined{request.decisionNote ? `: ${request.decisionNote}` : "."} You can send a new request below.</p>;
  return <p className="notice">Your request for {type} access was approved.</p>;
}

// What a new account sees until an admin approves it.
export function Waiting({ me, onCheckAgain }) {
  const [request, setRequest] = useState(me.request ?? null);
  return (
    <main className="single">
      <h2>Request access</h2>
      <p className="lede">Your account is set up. To see anything in TrueMatch, an admin needs to approve the kind of account you need.</p>
      <RequestStatus request={request} />
      {request?.status !== "pending" && <RequestForm me={me} onSent={setRequest} />}
      {request?.status === "pending" && (
        <p><button className="quiet" onClick={onCheckAgain}>Check again</button> <span className="muted small">Once approved, this page opens TrueMatch for you.</span></p>
      )}
    </main>
  );
}

// Signed-in account details: change password, ask for a different kind of account.
export function Account({ me }) {
  const [request, setRequest] = useState(me.request ?? null);
  const [saved, setSaved] = useState(false);
  return (
    <main className="single">
      <h2>Your account</h2>
      <dl className="facts">
        <div><dt>Email</dt><dd>{me.email}</dd></div>
        <div><dt>Account type</dt><dd>{ROLE_LABEL[me.role] ?? "None yet"}{me.admin ? ", admin" : ""}{me.demo ? ", demo" : ""}</dd></div>
      </dl>

      <h3>Change password</h3>
      {saved && <p className="notice" role="status">Password changed. Use the new one next time you sign in.</p>}
      <Form
        fields={[
          ["oldPassword", "Current password", "password"],
          ["newPassword", "New password", "password", { placeholder: "At least 8 characters, with a number and a symbol" }],
        ]}
        submitLabel="Change password"
        onSubmit={async (values) => { setSaved(false); await updatePassword(values); setSaved(true); }}
      />
      <p className="muted small">Forgot it? Sign out and choose "Forgot your password?" to get a reset code by email.</p>

      <h3>Request a different kind of account</h3>
      <p className="muted">An admin reviews every request. Admin access lets you approve other people.</p>
      <RequestStatus request={request} />
      {request?.status !== "pending" && <RequestForm me={me} onSent={setRequest} exclude={me.role} />}
    </main>
  );
}

// Admins approve or decline access requests.
export function AdminRequests() {
  const [requests, setRequests] = useState(null);
  const [error, setError] = useState("");
  const [notes, setNotes] = useState({});
  const [messages, setMessages] = useState({});

  useEffect(() => {
    api("/access-requests").then(setRequests).catch((e) => setError(e.message));
  }, []);

  async function decide(r, decision) {
    setMessages((m) => ({ ...m, [r.id]: "" }));
    try {
      const updated = await api(`/access-requests/${r.id}/decision`, { decision, note: notes[r.id] ?? "" });
      setRequests((list) => list.map((x) => (x.id === r.id ? updated : x)));
      if (updated.warning) setMessages((m) => ({ ...m, [r.id]: updated.warning }));
    } catch (e) {
      setMessages((m) => ({ ...m, [r.id]: e.message }));
    }
  }

  const pending = (requests ?? []).filter((r) => r.status === "pending");
  const decided = (requests ?? []).filter((r) => r.status !== "pending").slice(0, 20);
  return (
    <main className="single">
      <h2>Access requests</h2>
      <p className="lede">Approving adds the person to the account type they asked for. They see it the next time they sign in.</p>
      {error && <p className="error">{error}</p>}
      {!requests && !error && <p className="muted">Loading requests…</p>}
      {requests && pending.length === 0 && <p className="muted">No requests waiting.</p>}
      <ul className="ref-list">
        {pending.map((r) => (
          <li key={r.id} className="ref-card">
            <div className="ref-head"><strong>{r.name}</strong><span className="muted">{when(r.createdAt)}</span></div>
            <p className="ref-meta">
              {r.email} wants <strong>{ROLE_LABEL[r.role]}</strong> access{r.currentRole ? ` (now ${ROLE_LABEL[r.currentRole].toLowerCase()})` : ""}
              {r.organization ? `, from ${r.organization}` : ""}.
            </p>
            {r.note && <p className="notes">{r.note}</p>}
            <label className="decision-note">
              Note to them (needed to decline)
              <input value={notes[r.id] ?? ""} onChange={(e) => setNotes((n) => ({ ...n, [r.id]: e.target.value }))} />
            </label>
            <div className="decision">
              <button onClick={() => decide(r, "approve")}>Approve</button>
              <button className="quiet" onClick={() => decide(r, "deny")}>Decline</button>
            </div>
            {messages[r.id] && <p className="error">{messages[r.id]}</p>}
          </li>
        ))}
      </ul>
      {decided.length > 0 && (
        <>
          <h3>Recently decided</h3>
          <ul className="past">
            {decided.map((r) => (
              <li key={r.id}>
                <strong>{r.name}</strong> {ROLE_LABEL[r.role]}: {r.status} by {r.decidedBy} {r.decidedAt && when(r.decidedAt)}
                {messages[r.id] && <span className="error"> {messages[r.id]}</span>}
              </li>
            ))}
          </ul>
        </>
      )}
    </main>
  );
}
