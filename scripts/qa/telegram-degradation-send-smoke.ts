/**
 * 텔레그램 열화 경보 실발송 smoke (삼순 2차 NO-GO blocker 1: 비시크릿 실발송 검증).
 * 실제 sendDegradationTelegramAlert() 를 호출해 Telegram 2xx(ACK) 를 받는지 검증한다.
 * 시크릿(토큰)은 코드/로그에 남기지 않고 환경변수(.env.local 또는 배포 env)에서만 읽는다.
 * 토큰이 없으면 SKIP(exit 0) — 자격 없는 CI 는 non-blocking, 토큰 있는 merge gate 에선 실발송 검증.
 * 실행: npm run qa:telegram-degradation-send
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// 배포 env 가 없을 때 로컬 .env.local 에서 필요한 값만 주입(시크릿은 출력하지 않음).
function loadDotEnv(file: string) {
  if (!existsSync(file)) return;
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

async function main() {
  loadDotEnv(resolve(".env.local"));

  if (!process.env.TELEGRAM_BOT_TOKEN) {
    console.log("SKIP: TELEGRAM_BOT_TOKEN 미설정 — 실발송 검증 건너뜀(자격 없는 환경). 배포 env 배선 후 재실행.");
    process.exit(0);
  }
  // supabaseAdmin import 부작용 방지용 최소 env 보정(실제 DB 호출은 이 smoke 에서 하지 않음).
  process.env.NEXT_PUBLIC_SUPABASE_URL ??= "http://localhost:54321";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "anon-placeholder";

  const { sendDegradationTelegramAlert } = await import("../../src/lib/monitoring/api-fallback-tracker");

  const delivered = await sendDegradationTelegramAlert(
    "kbo-scoreboard-linescore-selftest",
    "schema-error",
    { errorMessage: "🔧 배포 검증: KBO 열화 경보 파이프라인 실발송 테스트(무시하셔도 됩니다)" },
    { windowMinutes: 5, threshold: 3, cooldownMinutes: 30, leaseSeconds: 120 },
  );

  if (delivered === true) {
    console.log("✅ 실발송 성공(Telegram 2xx ACK) — 경보 파이프라인 end-to-end 확인");
    process.exit(0);
  }
  console.error("❌ 실발송 실패(2xx 아님) — 토큰/네트워크/chat_id 확인 필요");
  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
