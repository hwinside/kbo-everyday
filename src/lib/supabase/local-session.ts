"use client";

/**
 * 세션 쿠키를 **동기적으로** 읽어 현재 로그인 사용자 id를 알아낸다.
 *
 * 용도(2026-08-11 #infra 서비스 속도 트랙): 홈의 "로컬 마이팀 즉시 렌더"는
 * 인증 확인(비동기)을 기다리지 않는 것이 목적인데, 계정 전환 직후에는 localStorage
 * 마이팀이 이전 계정 것일 수 있다(삼순 리뷰 #1154 NO-GO ①). 그래서 즉시 렌더 전에
 * "로컬 데이터의 주인(kbo-auth-uid)과 현재 세션 쿠키의 user id가 일치하는가"를
 * 네트워크·supabase 락 없이 판정한다.
 *
 * @supabase/ssr createBrowserClient 는 세션을 `sb-<ref>-auth-token` 쿠키에 저장한다.
 * 값이 크면 `.0`, `.1` … 청크로 쪼개지고, `base64-` 접두 인코딩일 수 있다 — 둘 다 처리.
 *
 * 반환 계약:
 * - null       = 세션 쿠키 없음(비로그인)
 * - string(id) = 세션 쿠키의 user id
 * - "unknown"  = 세션 쿠키는 있는데 파싱 실패 → 호출부는 fail-close(즉시 렌더 포기)
 */
export function readSessionCookieUserId(): string | null | "unknown" {
  if (typeof document === "undefined") return null;
  try {
    const chunks: Record<string, { idx: number; value: string }[]> = {};
    let found = false;
    for (const part of document.cookie.split(";")) {
      const eq = part.indexOf("=");
      if (eq < 0) continue;
      const name = part.slice(0, eq).trim();
      const m = name.match(/^(sb-.+-auth-token)(?:\.(\d+))?$/);
      if (!m) continue;
      found = true;
      const base = m[1];
      (chunks[base] ??= []).push({ idx: m[2] ? Number(m[2]) : 0, value: part.slice(eq + 1).trim() });
    }
    if (!found) return null;
    for (const base of Object.keys(chunks)) {
      const joined = chunks[base]
        .sort((a, b) => a.idx - b.idx)
        .map((c) => c.value)
        .join("");
      const decoded = decodeURIComponent(joined);
      // @supabase/ssr 는 `base64-` + **base64url**(-·_ 사용, 패딩 없음) 인코딩이다
      // (node_modules/@supabase/ssr cookies.js BASE64_PREFIX + stringToBase64URL 실측).
      // 순수 atob 는 base64url 문자에서 던지므로 변환 후 디코딩한다.
      const raw = decoded.startsWith("base64-")
        ? atob(decoded.slice(7).replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil((decoded.length - 7) / 4) * 4, "="))
        : decoded;
      const parsed = JSON.parse(raw) as { user?: { id?: string } };
      if (parsed?.user?.id) return parsed.user.id;
    }
    return "unknown";
  } catch {
    return "unknown";
  }
}
