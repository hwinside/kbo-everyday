#!/usr/bin/env python3
"""Exact-allowlist, read-only Supabase peak measurement harness.

No mutation code is imported. SQL execution accepts exactly two constants below.
Use --selftest to prove mutation-shaped SQL is rejected before any network call.
"""
import argparse
import base64
import collections
import json
import re
import statistics
import time
import urllib.request
from pathlib import Path

PROJECT_REF = "lbmbdjgsnenqjwjotoei"
SQL_PG_STATS = (
    "SELECT coalesce(sum(total_exec_time),0) AS exec_ms, "
    "coalesce(sum(calls),0) AS calls FROM pg_stat_statements"
)
SQL_PUBLICATION = (
    "SELECT schemaname||'.'||tablename AS table_name "
    "FROM pg_publication_tables WHERE pubname='supabase_realtime' ORDER BY 1"
)
ALLOWED_SQL = frozenset({SQL_PG_STATS, SQL_PUBLICATION})


class UnsafeQuery(RuntimeError):
    pass


def load_env(path):
    out = {}
    for raw in Path(path).read_text().splitlines():
        raw = raw.strip()
        if not raw or raw.startswith("#") or "=" not in raw:
            continue
        k, v = raw.split("=", 1)
        out[k.strip()] = v.strip().strip('"').strip("'")
    return out


def labels(line):
    m = re.search(r"\{(.*)\}", line)
    return dict(re.findall(r'(\w+)="([^"]*)"', m.group(1))) if m else {}


def metric_value(line):
    return float(line.rsplit(" ", 1)[1])


def metric_lines(text, name):
    return [line for line in text.splitlines() if line.startswith(name + "{") or line.startswith(name + " ")]


def cpu(text):
    modes = collections.Counter()
    for line in metric_lines(text, "node_cpu_seconds_total"):
        modes[labels(line).get("mode", "unknown")] += metric_value(line)
    return modes


def gauge(text, name):
    rows = metric_lines(text, name)
    return metric_value(rows[0]) if rows else None


def gotrue_routes(text):
    routes = collections.Counter()
    for line in metric_lines(text, "http_status_codes_total"):
        lab = labels(line)
        if lab.get("service_type") == "gotrue":
            routes[lab.get("http_route", "unknown")] += metric_value(line)
    return routes


def query(env, sql):
    if sql not in ALLOWED_SQL:
        raise UnsafeQuery(f"SQL is not in exact read-only allowlist: {sql[:100]}")
    req = urllib.request.Request(
        f"https://api.supabase.com/v1/projects/{PROJECT_REF}/database/query",
        data=json.dumps({"query": sql}).encode(),
        headers={
            "Authorization": f"Bearer {env['SUPABASE_MANAGEMENT_TOKEN']}",
            "Content-Type": "application/json",
            "User-Agent": "keubo-peak-readonly/2",
        },
        method="POST",
    )
    return json.load(urllib.request.urlopen(req, timeout=120))


def metrics(env):
    auth = base64.b64encode(f"service_role:{env['SUPABASE_SERVICE_ROLE_KEY']}".encode()).decode()
    req = urllib.request.Request(
        f"https://{PROJECT_REF}.supabase.co/customer/v1/privileged/metrics",
        headers={"Authorization": f"Basic {auth}", "User-Agent": "keubo-peak-readonly/2"},
    )
    return urllib.request.urlopen(req, timeout=60).read().decode()


def rest_probe(env):
    req = urllib.request.Request(
        env["NEXT_PUBLIC_SUPABASE_URL"] + "/rest/v1/chat_messages?select=id&limit=1",
        headers={
            "apikey": env["NEXT_PUBLIC_SUPABASE_ANON_KEY"],
            "Authorization": f"Bearer {env['NEXT_PUBLIC_SUPABASE_ANON_KEY']}",
            "User-Agent": "keubo-peak-readonly/2",
        },
    )
    started = time.monotonic()
    try:
        urllib.request.urlopen(req, timeout=40).read()
        return round((time.monotonic() - started) * 1000, 1)
    except Exception:
        return None


def snapshot(env):
    metrics_started = time.monotonic()
    text = metrics(env)
    metrics_finished = time.monotonic()
    pg = query(env, SQL_PG_STATS)[0]
    publication = query(env, SQL_PUBLICATION)
    return {
        # Counter deltas must be normalized by the actual interval between metric snapshots,
        # not by the requested wall-clock window.
        "metrics_sample_monotonic": (metrics_started + metrics_finished) / 2,
        "cpu": cpu(text),
        "routes": gotrue_routes(text),
        "pg_exec_ms": float(pg["exec_ms"]),
        "pg_calls": int(pg["calls"]),
        "jwt_cache": gauge(text, "pgrst_jwt_cache_requests_total") or 0,
        "realtime_client_subscriptions": gauge(text, "realtime_postgres_changes_client_subscriptions"),
        "realtime_lag_bytes": gauge(text, "replication_realtime_lag_bytes"),
        "load1": gauge(text, "node_load1"),
        "publication": [row["table_name"] for row in publication],
    }


def require_nonnegative(label, value):
    if value < 0:
        raise RuntimeError(f"counter reset/rollback detected: {label} delta={value}")
    return value


def successful(values):
    return [v for v in values if v is not None]


def median_or_none(values):
    ok = successful(values)
    return round(statistics.median(ok), 1) if ok else None


def validate_probe_config(window, burst_probes, distributed_probes, min_success, max_counter_overrun):
    if not 60 <= window <= 600:
        raise ValueError("--window must be 60..600 seconds (metrics scrape resolution)")
    if min_success < 1:
        raise ValueError("--min-success must be >= 1")
    if burst_probes < 1 or distributed_probes < 1:
        raise ValueError("probe counts must be positive")
    if burst_probes < min_success or distributed_probes < min_success:
        raise ValueError("probe counts must be >= --min-success")
    if max_counter_overrun < 0:
        raise ValueError("--max-counter-overrun must be >= 0")


def run_selftest():
    attempts = [
        "ALTER PUBLICATION supabase_realtime DROP TABLE posts",
        "WITH removed AS (DELETE FROM posts RETURNING *) SELECT * FROM removed",
        "CALL dangerous_procedure()",
        "DO $$ BEGIN PERFORM 1; END $$",
        "SELECT pg_terminate_backend(123)",
    ]
    network_calls = 0
    original = urllib.request.urlopen

    def forbidden_network(*_args, **_kwargs):
        nonlocal network_calls
        network_calls += 1
        raise AssertionError("network must not be reached by rejection selftest")

    urllib.request.urlopen = forbidden_network
    try:
        rejected = 0
        for sql in attempts:
            try:
                query({}, sql)
            except UnsafeQuery:
                rejected += 1
            else:
                raise AssertionError(f"mutation query unexpectedly allowed: {sql}")
        if rejected != len(attempts) or network_calls != 0:
            raise AssertionError(f"rejected={rejected}/{len(attempts)} network_calls={network_calls}")
    finally:
        urllib.request.urlopen = original
    invalid_probe_configs = [
        (70, 5, 6, 0, 15),
        (70, 0, 6, 1, 15),
        (70, 5, 0, 1, 15),
        (70, 1, 1, 2, 15),
        (70, 5, 6, 1, -1),
    ]
    for config in invalid_probe_configs:
        try:
            validate_probe_config(*config)
        except ValueError:
            pass
        else:
            raise AssertionError(f"invalid probe config unexpectedly allowed: {config}")
    validate_probe_config(70, 5, 6, 1, 15)
    print(f"PASS exact-SQL rejection selftest: {rejected}/{len(attempts)} RED, network_calls=0")
    print(f"PASS probe config selftest: {len(invalid_probe_configs)}/{len(invalid_probe_configs)} RED")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--env", default=".env.local")
    ap.add_argument("--window", type=int, default=70)
    ap.add_argument("--burst-probes", type=int, default=5)
    ap.add_argument("--distributed-probes", type=int, default=6)
    ap.add_argument("--min-success", type=int, default=3)
    ap.add_argument("--baseline-non-user-per-min", type=float)
    ap.add_argument("--max-counter-overrun", type=float, default=15.0)
    ap.add_argument("--label", default="PEAK")
    ap.add_argument("--output")
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args()
    if args.selftest:
        run_selftest()
        return
    try:
        validate_probe_config(
            args.window,
            args.burst_probes,
            args.distributed_probes,
            args.min_success,
            args.max_counter_overrun,
        )
    except ValueError as error:
        raise SystemExit(str(error)) from error

    env = load_env(args.env)
    before = snapshot(env)
    started = time.monotonic()

    # Preserve the historical short burst for comparison.
    burst = []
    for _ in range(args.burst_probes):
        burst.append(rest_probe(env))
        time.sleep(0.4)

    # Also sample across the full CPU/auth window, not only its first ~2 seconds.
    distributed = []
    for i in range(args.distributed_probes):
        target = started + ((i + 1) * args.window / (args.distributed_probes + 1))
        remaining = target - time.monotonic()
        if remaining > 0:
            time.sleep(remaining)
        distributed.append(rest_probe(env))
    remaining = started + args.window - time.monotonic()
    if remaining > 0:
        time.sleep(remaining)
    after = snapshot(env)

    if len(successful(burst)) < args.min_success:
        raise RuntimeError(f"burst probe success below minimum: {len(successful(burst))}/{args.burst_probes}")
    if len(successful(distributed)) < args.min_success:
        raise RuntimeError(f"distributed probe success below minimum: {len(successful(distributed))}/{args.distributed_probes}")

    cpu_deltas = {mode: after["cpu"].get(mode, 0) - before["cpu"].get(mode, 0) for mode in set(before["cpu"]) | set(after["cpu"])}
    for mode, delta in cpu_deltas.items():
        require_nonnegative(f"cpu.{mode}", delta)
    total = sum(cpu_deltas.values())
    if total <= 0:
        raise RuntimeError("CPU counters did not advance")
    idle = cpu_deltas.get("idle", 0)
    busy_seconds = total - idle

    pg_exec_seconds = require_nonnegative("pg_exec_ms", after["pg_exec_ms"] - before["pg_exec_ms"]) / 1000
    pg_calls = require_nonnegative("pg_calls", after["pg_calls"] - before["pg_calls"])
    jwt_cache = require_nonnegative("jwt_cache", after["jwt_cache"] - before["jwt_cache"])
    route_keys = set(before["routes"]) | set(after["routes"])
    route_deltas = {route: after["routes"].get(route, 0) - before["routes"].get(route, 0) for route in route_keys}
    for route, delta in route_deltas.items():
        require_nonnegative(f"gotrue.{route}", delta)
    user_requests = route_deltas.get("/user", 0)
    all_gotrue = sum(route_deltas.values())
    non_user_requests = all_gotrue - user_requests
    counter_interval = after["metrics_sample_monotonic"] - before["metrics_sample_monotonic"]
    if counter_interval <= 0:
        raise RuntimeError(f"invalid metrics counter interval: {counter_interval}")
    if counter_interval > args.window + args.max_counter_overrun:
        raise RuntimeError(
            f"metrics counter interval exceeded window: actual={counter_interval:.2f}s "
            f"requested={args.window}s max_overrun={args.max_counter_overrun}s"
        )
    non_user_per_min = non_user_requests * 60 / counter_interval

    baseline = args.baseline_non_user_per_min
    if baseline is None:
        normalization = "HOLD_NO_BASELINE_NON_USER"
    elif baseline <= 0:
        raise RuntimeError("baseline non-/user must be > 0")
    else:
        ratio = non_user_per_min / baseline
        normalization = "ELIGIBLE" if 0.8 <= ratio <= 1.25 else f"HOLD_TRAFFIC_RATIO_{ratio:.2f}"

    result = {
        "label": args.label,
        "window_seconds": args.window,
        "metrics_counter_interval_seconds": round(counter_interval, 2),
        "max_counter_overrun_seconds": args.max_counter_overrun,
        "captured_at_epoch": int(time.time()),
        "cpu_busy_pct": round(100 * busy_seconds / total, 2),
        "cpu_busy_seconds": round(busy_seconds, 2),
        "load1": after["load1"],
        "pg_exec_seconds": round(pg_exec_seconds, 2),
        "pg_calls": pg_calls,
        "rest_burst_ms": burst,
        "rest_burst_median_ms": median_or_none(burst),
        "rest_distributed_ms": distributed,
        "rest_distributed_median_ms": median_or_none(distributed),
        "gotrue_user_requests": user_requests,
        "gotrue_non_user_requests": non_user_requests,
        "gotrue_all_requests": all_gotrue,
        "normalization_non_user_per_min": round(non_user_per_min, 2),
        "baseline_non_user_per_min": baseline,
        "effect_eligibility": normalization,
        "jwt_cache_requests": jwt_cache,
        "realtime_client_subscriptions_before": before["realtime_client_subscriptions"],
        "realtime_client_subscriptions_after": after["realtime_client_subscriptions"],
        "realtime_lag_bytes_before": before["realtime_lag_bytes"],
        "realtime_lag_bytes_after": after["realtime_lag_bytes"],
        "publication_before": before["publication"],
        "publication_after": after["publication"],
        "publication_unchanged": before["publication"] == after["publication"],
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))
    if args.output:
        Path(args.output).write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    if not result["publication_unchanged"]:
        raise RuntimeError("publication changed during read-only measurement")


if __name__ == "__main__":
    main()
