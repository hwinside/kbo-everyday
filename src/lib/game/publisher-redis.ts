type Config = { url: string; token: string } | null;
type Result = { ok: true; value: unknown } | { ok: false };

/** Never log provider bodies, command arguments, URLs, tokens or exception text. */
export async function publisherRedisCommand(
  args: Array<string | number>, cfg: Config,
): Promise<Result> {
  const operation = ["SET", "GET", "EVAL", "INCR", "SETEX"].includes(String(args[0]))
    ? String(args[0]) : "other";
  const failed = (kind: string, status?: number): Result => {
    console.warn("[relay-publisher] redis-error", { operation, kind, ...(status === undefined ? {} : { status }) });
    return { ok: false };
  };
  if (!cfg) return failed("unconfigured");
  try {
    const response = await fetch(cfg.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(args), cache: "no-store", signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) return failed("http", response.status);
    let payload: unknown;
    try { payload = await response.json(); } catch { return failed("invalid-json"); }
    if (typeof payload !== "object" || payload === null) return failed("invalid-response");
    if ("error" in payload) return failed("command");
    if (!("result" in payload)) return failed("invalid-response");
    return { ok: true, value: payload.result };
  } catch {
    return failed("transport-or-timeout");
  }
}

/** Only a successful Redis null result means NX contention. All errors fail closed. */
export async function acquirePublisherLock(token: string, key: string, ttl: number, cfg: Config) {
  const result = await publisherRedisCommand(["SET", key, token, "NX", "PX", ttl], cfg);
  if (!result.ok) return "unavailable";
  if (result.value === "OK") return "acquired";
  if (result.value === null) return "held";
  console.warn("[relay-publisher] redis-error", { operation: "SET", kind: "invalid-lock-result" });
  return "unavailable";
}
