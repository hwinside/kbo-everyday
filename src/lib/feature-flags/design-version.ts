/**
 * Design Version Feature Flag (T1.3.3)
 *
 * Spec: specs/design-v2-migration.md (v0.5) §3
 * Lockdown: Design Freeze Gate 통과 전까지 middleware 가 'v2' 를 'v1' 로 강제 fallback (T1.3.5)
 *
 * 진입 순서:
 *   1. URL `?v2=1` → 쿠키 set, `?v2=0` → 쿠키 delete (middleware 처리)
 *   2. DB `profiles.design_version` ('v1' | 'v2')
 *   3. Cookie `kbo-design` ('v2')
 *   4. 기본: 'v1'
 */

export type DesignVersion = "v1" | "v2";

export const DESIGN_VERSION_COOKIE = "kbo-design";
export const DESIGN_VERSION_COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30일

/**
 * Lockdown 플래그 — Design Freeze Gate 통과 전까지 true.
 * Phase 4 종료 + 하린아빠 명시 승인 후 false 로 전환.
 *
 * true 일 때 동작:
 *   - DB `profiles.design_version = 'v2'` 여도 middleware 가 V1 페이지로 렌더
 *   - 내부자 수동 테스트만 `?v2=1` 쿠키로 가능 (middleware 에서 예외 허용)
 *   - Admin cohort UI 비활성화
 *
 * ⚠️ false 로 바꾸는 커밋은 push 승인 필수.
 */
export const USER_EXPOSURE_LOCKDOWN = true;

/**
 * 문자열이 유효한 DesignVersion 인지.
 * 알 수 없는 값은 'v1' 로 해석해야 안전.
 */
export function parseDesignVersion(input: string | undefined | null): DesignVersion {
  return input === "v2" ? "v2" : "v1";
}

/**
 * 서버/클라이언트 공용: cookie 값 + DB 값 + lockdown 플래그를 조합해 최종 버전 결정.
 *
 * @param dbVersion - AuthContext 가 Supabase profiles 에서 읽은 값 (nullable)
 * @param cookieVersion - document.cookie 또는 middleware 에서 읽은 값
 * @param lockdownBypass - 내부자 `?v2=1` 직접 세팅 (lockdown 예외 허용)
 */
export function resolveDesignVersion(
  dbVersion?: string | null,
  cookieVersion?: string | null,
  lockdownBypass: boolean = false,
): DesignVersion {
  const db = parseDesignVersion(dbVersion);
  const cookie = parseDesignVersion(cookieVersion);

  // 쿠키가 명시적으로 v2 면 우선 (세션 레벨 override)
  const raw: DesignVersion = cookie === "v2" ? "v2" : db;

  // Lockdown 가드
  if (USER_EXPOSURE_LOCKDOWN && !lockdownBypass && raw === "v2") {
    return "v1";
  }

  return raw;
}
