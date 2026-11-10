import { useEffect, useState } from "react";
import { api } from "./api.js";
import { STEPS, STATUS_LABEL, when } from "./shared.jsx";

const pct = (part, whole) => (whole ? `${Math.round((part / whole) * 100)}%` : "—");
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// De-identified results a care manager can print, save as PDF, or download to send to health plans.
export default function Results() {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api("/results").then(setData).catch((e) => setError(e.message));
  }, []);

  if (error) return <main className="single report"><p className="error">{error}</p></main>;
  if (!data) return <main className="single report"><p className="muted">Loading results…</p></main>;

  function downloadCsv() {
    const rows = [
      ["TrueMatch food referral results", `Generated ${when(data.generatedAt)}`],
      [],
      ["Referrals", data.referrals],
      ["Ended in a pickup", data.pickedUp],
      ["Pickup rate", pct(data.pickedUp, data.referrals)],
      ["Confirmed by the patient", data.confirmed],
      ["Median days from referral to pickup", data.medianDaysToPickup ?? ""],
      ["Households that received food", data.households],
      ["People in those households", data.people],
      ["Problems reported", data.issues],
      ["Cancelled (not counted above)", data.cancelled],
      [],
      ["Referral", "Referred on", "Household size", "Food partner", "Status", "Days to pickup"],
      ...data.rows.map((r) => [r.ref, r.referredOn, r.householdSize, r.partner, STATUS_LABEL[r.status], r.daysToPickup ?? ""]),
    ];
    const csv = rows.map((row) => row.map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    link.download = `truematch-results-${data.generatedAt.slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  }

  const top = data.funnel[0]?.count || 1;
  return (
    <main className="single report">
      <div className="report-head">
        <div>
          <h2>Results for health plans</h2>
          <p className="lede">Counts and timing only. No names, contact details, or medical information, so it's ready to share with a health plan.</p>
          <p className="muted print-only">TrueMatch food referral results, generated {when(data.generatedAt)}</p>
        </div>
        <div className="report-actions">
          <button onClick={() => window.print()}>Print or save as PDF</button>
          <button className="quiet" onClick={downloadCsv}>Download spreadsheet</button>
        </div>
      </div>

      {data.referrals === 0 ? (
        <p className="muted">No referrals yet. Results appear here once care managers start sending referrals.</p>
      ) : (
        <>
          <h3>Where referrals ended up</h3>
          <ol className="funnel">
            {data.funnel.map(({ step, count }) => (
              <li key={step}>
                <span className="funnel-count">{count}</span>
                <span className="funnel-label">{STEPS.find(([k]) => k === step)[1]}</span>
                <span className="funnel-bar"><span style={{ width: `${(count / top) * 100}%` }} /></span>
              </li>
            ))}
          </ol>

          <h3>What happened</h3>
          <ul className="findings">
            <li><strong>{pct(data.pickedUp, data.referrals)}</strong> of referrals ended with the household picking up food ({data.pickedUp} of {data.referrals}).</li>
            <li><strong>{data.medianDaysToPickup ?? "—"} days</strong> was the median time from referral to pickup.</li>
            <li><strong>{plural(data.people, "person", "people")}</strong> in {plural(data.households, "household", "households")} received food.</li>
            <li><strong>{data.confirmed}</strong> pickups were confirmed by the patient themselves.</li>
            <li><strong>{plural(data.issues, "problem", "problems")}</strong> reported by patients{data.cancelled ? `, and ${plural(data.cancelled, "referral", "referrals")} cancelled (left out of the counts above)` : ""}.</li>
          </ul>

          <h3>By week</h3>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Week of</th><th>Referrals sent</th><th>Pickups</th></tr></thead>
              <tbody>
                {data.weeks.map((w) => (
                  <tr key={w.week}><td>{new Date(w.week + "T12:00:00Z").toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" })}</td><td>{w.referred}</td><td>{w.pickedUp}</td></tr>
                ))}
              </tbody>
            </table>
          </div>

          <h3>Every referral</h3>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Referral</th><th>Referred on</th><th>Household</th><th>Food partner</th><th>Status</th><th>Days to pickup</th></tr></thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.ref + r.referredOn}>
                    <td>{r.ref}</td><td>{r.referredOn}</td><td>{r.householdSize}</td><td>{r.partner}</td>
                    <td>{STATUS_LABEL[r.status]}</td><td>{r.daysToPickup ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </main>
  );
}
