export const AUTH_ERROR_EVENT = "keubo:auth-error";
export const AUTH_ERROR_STORAGE_KEY = "kbo-auth-error";
export const KAKAO_EMAIL_UNVERIFIED_CODE = "kakao_email_unverified";
export const KAKAO_EMAIL_UNVERIFIED_MARKER = "KAKAO_EMAIL_UNVERIFIED";

export type UserFacingAuthErrorCode = typeof KAKAO_EMAIL_UNVERIFIED_CODE;

/**
 * OAuth callback 오류 표식 파라미터 — 서버 오류 callback(`/?auth_error=…`)과 provider 오류가 쓰는 키 전체.
 * appUrlOpen 분류(app-url-open.ts classifyAppUrlOpen)와 이 파일의 판정이 **같은 집합**을 봐야 한다.
 * 새 키를 읽게 되면 여기 먼저 추가할 것(분류가 못 보는 키는 네이티브에서 오류 안내가 사라진다).
 */
export const AUTH_ERROR_PARAM_KEYS = [
  "auth_error",
  "error",
  "error_code",
  "error_description",
] as const;

export const AUTH_ERROR_MESSAGES: Record<UserFacingAuthErrorCode, string> = {
  [KAKAO_EMAIL_UNVERIFIED_CODE]:
    "카카오 계정의 이메일 인증이 확인되지 않아 가입을 진행하지 않았어요. 카카오 계정에서 이메일을 인증한 뒤 다시 시도해 주세요.",
};

export function getUserFacingAuthError(
  params: Pick<URLSearchParams, "get">,
): UserFacingAuthErrorCode | null {
  if (params.get("auth_error") === KAKAO_EMAIL_UNVERIFIED_CODE) {
    return KAKAO_EMAIL_UNVERIFIED_CODE;
  }

  const providerError = [
    params.get("error"),
    params.get("error_code"),
    params.get("error_description"),
  ]
    .filter(Boolean)
    .join(" ");

  return providerError.includes(KAKAO_EMAIL_UNVERIFIED_MARKER)
    ? KAKAO_EMAIL_UNVERIFIED_CODE
    : null;
}

export function getUserFacingAuthErrorFromUrl(
  url: Pick<URL, "hash" | "searchParams">,
): UserFacingAuthErrorCode | null {
  return (
    getUserFacingAuthError(url.searchParams) ??
    getUserFacingAuthError(
      new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : url.hash),
    )
  );
}
