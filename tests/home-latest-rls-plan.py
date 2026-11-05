#!/usr/bin/env python3
"""Compatibility entry point; use the registered PG17 gate."""
import pathlib, subprocess
raise SystemExit(subprocess.call(['bash', str(pathlib.Path(__file__).resolve().parents[1] / 'scripts/qa/home-latest-rls-plan-pg17.sh')]))
