// Load .env.local for QA scripts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, "../../.env.local");

try {
  const raw = readFileSync(envPath, "utf8");
  for (const line of raw.split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (!m) continue;
    let v = m[2];
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    if (!process.env[m[1]]) process.env[m[1]] = v;
  }
} catch (e) {
  const alreadyInjected =
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY &&
    process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!alreadyInjected) {
    console.error("[qa] failed to load .env.local:", e.message);
    process.exit(1);
  }
}

export const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
export const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
export const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
export const REF = SUPABASE_URL?.match(/https:\/\/([a-z0-9]+)/)?.[1];
export const BASE = process.env.QA_BASE_URL || "https://keubo.fan";

if (!SUPABASE_URL || !ANON || !SERVICE_ROLE || !REF) {
  console.error("[qa] missing env (SUPABASE_URL / ANON / SERVICE_ROLE)");
  process.exit(1);
}
