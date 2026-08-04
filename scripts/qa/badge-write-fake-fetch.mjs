const USER_ID = "00000000-0000-4000-8000-000000000108";
const SERVICE_KEY = "offline-service-key";
const ANON_KEY = "offline-anon-key";

let authUserExists = true;
let profileExists = false;
const badges = new Set();

function response(status, body = null) {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function unexpected(url, method) {
  return response(500, { error: `unexpected fake-fetch request: ${method} ${url.pathname}${url.search}` });
}

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(input);
  const method = init.method || "GET";
  const apikey = new Headers(init.headers).get("apikey");
  const body = init.body ? JSON.parse(init.body) : null;

  if (url.pathname === "/auth/v1/admin/users" && method === "POST") {
    authUserExists = true;
    return response(200, { id: USER_ID });
  }
  if (url.pathname === "/auth/v1/token" && method === "POST") {
    return response(200, { access_token: "offline-user-jwt" });
  }
  if (url.pathname === `/auth/v1/admin/users/${USER_ID}` && method === "DELETE") {
    authUserExists = false;
    return response(204);
  }
  if (url.pathname === `/auth/v1/admin/users/${USER_ID}` && method === "GET") {
    return authUserExists ? response(200, { id: USER_ID }) : response(404, { error: "not found" });
  }

  if (url.pathname === "/rest/v1/profiles" && method === "POST" && apikey === SERVICE_KEY) {
    profileExists = true;
    return response(201, [body]);
  }
  if (url.pathname === "/rest/v1/profiles" && method === "DELETE" && apikey === SERVICE_KEY) {
    profileExists = false;
    return response(204);
  }
  if (url.pathname === "/rest/v1/profiles" && method === "GET" && apikey === SERVICE_KEY) {
    return response(200, profileExists ? [{ id: USER_ID }] : []);
  }

  if (url.pathname === "/rest/v1/user_badges" && method === "POST") {
    if (apikey === ANON_KEY) return response(403, { error: "badge writes require service role" });
    if (apikey !== SERVICE_KEY) return unexpected(url, method);
    const rows = Array.isArray(body) ? body : [body];
    for (const row of rows) badges.add(row.badge_id);
    return response(201, rows);
  }
  if (url.pathname === "/rest/v1/user_badges" && method === "DELETE") {
    if (apikey === SERVICE_KEY) badges.clear();
    return response(204);
  }
  if (url.pathname === "/rest/v1/user_badges" && method === "GET") {
    let rows = [...badges].map(badge_id => ({ badge_id, earned_at: "2026-08-03T00:00:00Z" }));
    const badgeFilter = url.searchParams.get("badge_id");
    if (badgeFilter?.startsWith("eq.")) rows = rows.filter(row => row.badge_id === badgeFilter.slice(3));
    return response(200, rows);
  }

  return unexpected(url, method);
};
