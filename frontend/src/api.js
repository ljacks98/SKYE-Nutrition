import { fetchAuthSession } from "aws-amplify/auth";

// For demo accounts only: which view to show. The server ignores these for everyone else.
export const demoView = { role: "", patientId: "" };

// Calls the backend: POST when you pass a body, GET otherwise.
// The signed-in user's token goes in the Authorization header; without it, API Gateway refuses the request.
export async function api(path, body) {
  const { tokens } = await fetchAuthSession(); // refreshes the token automatically when it expires
  const headers = { Authorization: `Bearer ${tokens.idToken}`, "Content-Type": "application/json" };
  if (demoView.role) headers["X-View-As"] = demoView.role;
  if (demoView.patientId) headers["X-Patient-Id"] = demoView.patientId;
  const res = await fetch(import.meta.env.VITE_API_URL + path, {
    method: body ? "POST" : "GET",
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? data.message ?? "Request failed.");
  return data;
}

// Gets a fresh sign-in token, e.g. right after an admin approves new access, so the new account type takes effect.
export const refreshSignIn = () => fetchAuthSession({ forceRefresh: true });
