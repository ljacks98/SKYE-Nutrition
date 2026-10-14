import { fetchAuthSession } from "aws-amplify/auth";

// Calls the backend: POST when you pass a body, GET otherwise.
// The signed-in user's token goes in the Authorization header; without it, API Gateway refuses the request.
export async function api(path, body) {
  const { tokens } = await fetchAuthSession(); // refreshes the token automatically when it expires
  const res = await fetch(import.meta.env.VITE_API_URL + path, {
    method: body ? "POST" : "GET",
    headers: { Authorization: `Bearer ${tokens.idToken}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? data.message ?? "Request failed.");
  return data;
}
