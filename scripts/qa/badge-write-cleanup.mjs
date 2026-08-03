import assert from "node:assert/strict";

const ATTEMPTS = 2;

function detail(result) {
  if (!result) return "no response";
  return `${result.status}: ${result.text || "empty response"}`;
}

async function runStep({ label, operation, valid, describe = detail, failures }) {
  let result = null;

  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    try {
      result = await operation();
    } catch (error) {
      failures.push(`${label} attempt ${attempt} threw: ${error instanceof Error ? error.message : error}`);
      continue;
    }

    if (valid(result)) return result;
    failures.push(`${label} attempt ${attempt}: ${describe(result)}`);
  }

  return result;
}

export function cleanupStageForRequest(kind, path, method = kind === "auth" ? "POST" : "GET") {
  if (kind === "rest" && path.startsWith("user_badges?") && method === "DELETE") return "badge-delete";
  if (kind === "rest" && path.startsWith("profiles?") && method === "DELETE") return "profile-delete";
  if (kind === "rest" && path.startsWith("user_badges?") && method === "GET") return "badge-postcondition";
  if (kind === "rest" && path.startsWith("profiles?") && method === "GET") return "profile-postcondition";
  if (kind === "auth" && path.startsWith("admin/users/") && method === "DELETE") return "auth-delete";
  if (kind === "auth" && path.startsWith("admin/users/") && method === "GET") return "auth-postcondition";
  return null;
}

export async function cleanupDisposableBadgeUser({ userId, key, rest, auth }) {
  assert.ok(userId, "cleanup userId required");
  const failures = [];

  await runStep({
    label: "badge DELETE",
    operation: () => rest(`user_badges?user_id=eq.${userId}`, { method: "DELETE", key }),
    valid: result => result?.ok === true,
    failures,
  });

  await runStep({
    label: "profile DELETE",
    operation: () => rest(`profiles?id=eq.${userId}`, { method: "DELETE", key }),
    valid: result => result?.ok === true,
    failures,
  });

  const left = await runStep({
    label: "badge postcondition",
    operation: () => rest(`user_badges?user_id=eq.${userId}&select=badge_id`, { key }),
    valid: result => result?.ok === true && Array.isArray(result.json) && result.json.length === 0,
    describe: result => {
      if (!result?.ok) return detail(result);
      if (!Array.isArray(result.json)) return "response is not a JSON array";
      return `badge row ${result.json.length}개 잔존`;
    },
    failures,
  });

  const leftProfile = await runStep({
    label: "profile postcondition",
    operation: () => rest(`profiles?id=eq.${userId}&select=id`, { key }),
    valid: result => result?.ok === true && Array.isArray(result.json) && result.json.length === 0,
    describe: result => {
      if (!result?.ok) return detail(result);
      if (!Array.isArray(result.json)) return "response is not a JSON array";
      return `profile row ${result.json.length}개 잔존`;
    },
    failures,
  });

  await runStep({
    label: "auth user DELETE",
    operation: () => auth(`admin/users/${userId}`, { method: "DELETE", key }),
    valid: result => result?.ok === true,
    failures,
  });

  const leftAuthUser = await runStep({
    label: "auth user postcondition",
    operation: () => auth(`admin/users/${userId}`, { method: "GET", key }),
    valid: result => result?.status === 404,
    describe: result => `expected 404, got ${detail(result)}`,
    failures,
  });

  return {
    failures,
    badgeCount: Array.isArray(left?.json) ? left.json.length : "invalid",
    profileCount: Array.isArray(leftProfile?.json) ? leftProfile.json.length : "invalid",
    authCount: leftAuthUser?.status === 404 ? 0 : "present",
  };
}
