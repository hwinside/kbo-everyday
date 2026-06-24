// 테스터 신청 → 하린아빠 Slack DM 실시간 알림 (roster-gap 패턴 동일, 비차단).
// 웹훅 URL은 코드 비노출 — Vercel env `TESTER_SIGNUP_SLACK_WEBHOOK`(본인 DM 대상)으로만 관리.

const WEBHOOK_URL = process.env.TESTER_SIGNUP_SLACK_WEBHOOK || "";

/** Android UA에서 기기모델 추출 (예: "...; SM-S921N Build/...") */
function deviceModel(ua: string | null | undefined): string {
  if (!ua) return "-";
  const m = ua.match(/Android[^;]*;\s*([^;)]+?)\s*(?:Build\/|\))/);
  if (m?.[1]) return m[1].trim();
  if (/iPhone|iPad/i.test(ua)) return "iOS";
  if (/Android/i.test(ua)) return "Android";
  return "기타";
}

export interface TesterSignupNotice {
  playStoreEmail: string;
  accountEmail: string | null;
  nickname: string | null;
  deviceInfo: string | null;
  isUpdate: boolean;
}

/** 신청/이메일변경 시 Slack 웹훅으로 알림. 실패해도 throw 안 함(신청 흐름 비차단). */
export async function notifyTesterSignup(input: TesterSignupNotice): Promise<void> {
  if (!WEBHOOK_URL) return;
  const head = input.isUpdate ? "✏️ 테스터 신청 이메일 변경" : "🆕 새 테스터 신청";
  const text =
    `📨 *${head}*\n` +
    `• 플레이스토어 이메일: \`${input.playStoreEmail}\`\n` +
    `• 닉네임: ${input.nickname ?? "-"}\n` +
    `• 가입 계정: ${input.accountEmail ?? "-"}\n` +
    `• 기기: ${deviceModel(input.deviceInfo)}`;
  try {
    await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
  } catch {
    /* 비차단 */
  }
}
