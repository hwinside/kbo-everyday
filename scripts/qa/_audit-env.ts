// 전건 감사 전용 env 선주입.
//
// ⚠️ **반드시 다른 import 보다 먼저** import 될 것. `server.ts` 는 트랜지티브로
//   `supabase/admin` 싱글톤을 로드하고, 그 싱글톤이 **모듈 로드 시점에** SUPABASE env 를
//   요구한다. ESM 은 import 를 본문보다 먼저 평가하므로, 같은 파일 안에서 env 를 읽어도
//   이미 늦다(실측: `supabaseUrl is required`).
//
// 여기서는 더미가 아니라 **실제 `.env.local` 값**을 넣는다 — 감사가 운영 사전·로그·기록을
// 실제로 읽어야 하기 때문이다.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const envPath = resolve(__dirname, "../../.env.local");
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (!m) continue;
  let value = m[2].trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  if (!process.env[m[1]]) process.env[m[1]] = value;
}
