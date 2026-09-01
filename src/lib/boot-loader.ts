// PR④ 부트 번들 로더 — AuthContext 1차 프로필 로드의 순수 로직 분리.
//
// 왜 별도 모듈인가: AuthContext 는 React Provider(.tsx)라 node 게이트가 원리적으로
// 구동할 수 없다. 순수 판정/IO 로직을 .ts 로 분리해 qa:user-boot-bundle 이
// "actual boot endpoint 1콜 → settle → 소비자 소비" 종단을 실제 이 함수로 태운다
// (검증 가능성은 코드 배치의 함수다 — lessons 2026-08-22).
//
// 계약 (AuthContext loadProfileNow 1차 경로와 동일 의미):
// - begin 토큰 발급 → /api/me/boot fetch (네이티브 런타임만 include=prefs)
// - 성공+profile: isCurrent 확인 후 settle(prefs) → { ok, profile }
// - isCurrent 탈락: settle(null) → { stale } (호출자는 옛 응답 폐기)
// - non-ok/no-profile/네트워크 실패: 반드시 settle(null) → { miss }
//   (대기 중 소비자를 settle 타임아웃까지 묶어두지 않는다)
import { beginBootLoad, settleBootLoad } from "@/lib/boot-cache";
import { isNativeRuntime } from "@/lib/capacitor/platform";
import type { NotificationPrefs } from "@/lib/notifications/prefs";

export type BootLoadOutcome =
  | { status: "ok"; profile: Record<string, unknown> }
  | { status: "stale" }
  | { status: "miss" };

export async function performBootLoad(
  accessToken: string,
  userId: string,
  isCurrent: () => boolean,
  wantPrefs: boolean = isNativeRuntime(),
): Promise<BootLoadOutcome> {
  const bootToken = beginBootLoad(userId);
  let bootSettled = false;
  try {
    const res = await fetch(wantPrefs ? "/api/me/boot?include=prefs" : "/api/me/boot", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (res.ok) {
      const json = await res.json() as { profile?: Record<string, unknown> | null; prefs?: NotificationPrefs | null };
      if (json.profile) {
        if (!isCurrent()) {
          settleBootLoad(bootToken, null);
          return { status: "stale" };
        }
        settleBootLoad(bootToken, json.prefs ?? null);
        bootSettled = true;
        return { status: "ok", profile: json.profile };
      }
    }
  } catch { /* miss → 호출자 fallback 체인 계속 */ }
  if (!bootSettled) settleBootLoad(bootToken, null); // 실패 fail-open — 대기 소비자 즉시 해제
  return { status: "miss" };
}
