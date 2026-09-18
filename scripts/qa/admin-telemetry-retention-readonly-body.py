"""Emit full preview-body-equivalent SQL; does not connect to or mutate a DB.
Run from the repository root and submit output with read_only=true.
Repeat the request three times under the unchanged 8-second DB limit.
The deployed function is NOT replaced; independent DB gates call the actual RPC.
"""
from pathlib import Path

migration = Path("supabase/migrations/20260918_telemetry_retention_preview_scan.sql")
source = migration.read_text()
body = source.split("AS $$", 1)[1].split("$$;", 1)[0]
assert body.count("RETURN jsonb_build_object(") == 1
# Match the RPC's default p_now, search_path, declarations, complete CTE,
# all four expired-rollup counts and final JSON construction. Only RETURN is
# adapted to a transaction-local result because READ ONLY cannot install DDL.
body = body.replace("DECLARE\n", "DECLARE\n  p_now timestamptz := now();\n  measured_start timestamptz := clock_timestamp();\n", 1)
body = body.replace("RETURN jsonb_build_object(",
                    "PERFORM set_config('telemetry.preview_result', (jsonb_build_object(")
body = body.replace("\n  );\nEND;", "\n  ))::text, true);\nEND;")
body = body.replace("\nEND;", "\n  PERFORM set_config('telemetry.preview_ms', (1000 * extract(epoch FROM clock_timestamp() - measured_start))::text, true);\nEND;")
print("BEGIN READ ONLY;")
print("SET LOCAL statement_timeout = '8s';")
print("SET LOCAL search_path = public;")
print("DO $$" + body + "$$;")
print("SELECT current_setting('telemetry.preview_result')::jsonb AS result, current_setting('telemetry.preview_ms')::numeric AS body_ms;")
print("ROLLBACK;")
