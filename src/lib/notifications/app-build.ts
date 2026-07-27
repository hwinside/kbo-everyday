// 디바이스 app_build(=Android versionCode / iOS build) 정규화 (순수, 의존 0).
// register-device route(저장측)와 native-push.ts(클라 전송측)가 *동일* 규칙으로 정규화해
// 버전 게이트 신호가 양쪽에서 어긋나지 않게 잠근다(삼순 S2 Slice0 NO-GO #4 wiring lock).
//
// 계약(fail-closed): 유한한 양의 정수만 채택하고 나머지(null/NaN/0/음수/비수치)는 null →
// 서버가 "구버전/미상"으로 fail-safe 취급(notification 유지). 소수는 trunc.

export function normalizeAppBuild(raw: unknown): number | null {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
}
