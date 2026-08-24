export const AUTH_ERROR_EVENT = "keubo:auth-error";
export const AUTH_ERROR_STORAGE_KEY = "kbo-auth-error";
export const KAKAO_EMAIL_UNVERIFIED_CODE = "kakao_email_unverified";
export const KAKAO_EMAIL_UNVERIFIED_MARKER = "KAKAO_EMAIL_UNVERIFIED";

/**
 * 네이버 수동 OAuth callback(/api/auth/naver/callback)이 실패 시 붙이는 파라미터.
 * 값은 서버가 정의한 폐쇄집합(NAVER_LOGIN_ERROR_CODES) 또는 네이버 provider가 넘긴 raw error.
 * raw 값은 유저에게 노출하지 않고 naver_unexpected로 접는다(삼순 계약 — raw 오류 비노출).
 */
export const NAVER_LOGIN_ERROR_PARAM = "login_error";

/** 서버 callback이 발급하는 네이버 로그인 오류 코드 폐쇄집합 — callback route와 동기 유지. */
export const NAVER_LOGIN_ERROR_CODES = [
  "state_mismatch",
  "no_code",
  "token_error",
  "profile_error",
  "no_email",
  "create_user_error",
  "session_error",
  "verify_error",
  "unexpected",
] as const;

type KnownNaverLoginErrorCode = (typeof NAVER_LOGIN_ERROR_CODES)[number];
/** 알 수 없는 login_error 값(네이버 provider raw error 등)을 접는 버킷. */
export const NAVER_UNKNOWN_LOGIN_ERROR_CODE = "naver_unexpected";
/** 유저가 동의 화면에서 스스로 취소한 경우 — 오류 안내를 띄우지 않는다. */
const NAVER_USER_CANCELLED = "access_denied";

export type NaverLoginErrorCode =
  | KnownNaverLoginErrorCode
  | typeof NAVER_UNKNOWN_LOGIN_ERROR_CODE;

export type UserFacingAuthErrorCode =
  | typeof KAKAO_EMAIL_UNVERIFIED_CODE
  | NaverLoginErrorCode;

/**
 * OAuth callback 오류 표식 파라미터 — 서버 오류 callback(`/?auth_error=…`)과 provider 오류가 쓰는 키 전체.
 * appUrlOpen 분류(app-url-open.ts classifyAppUrlOpen)와 이 파일의 판정이 **같은 집합**을 봐야 한다.
 * 새 키를 읽게 되면 여기 먼저 추가할 것(분류가 못 보는 키는 네이티브에서 오류 안내가 사라진다).
 */
export const AUTH_ERROR_PARAM_KEYS = [
  "auth_error",
  "login_error",
  "error",
  "error_code",
  "error_description",
] as const;

const NAVER_LOGIN_GENERIC_MESSAGE =
  "네이버 로그인을 완료하지 못했어요. 잠시 후 다시 시도해 주세요. 계속 반복되면 아래 진단코드와 함께 문의해 주세요.";

export const AUTH_ERROR_MESSAGES: Record<UserFacingAuthErrorCode, string> = {
  [KAKAO_EMAIL_UNVERIFIED_CODE]:
    "카카오 계정의 이메일 인증이 확인되지 않아 가입을 진행하지 않았어요. 카카오 계정에서 이메일을 인증한 뒤 다시 시도해 주세요.",
  state_mismatch:
    "로그인 확인 정보가 기기에 유지되지 않아 완료하지 못했어요. 다시 시도해도 반복되면 아래 진단코드와 함께 문의해 주세요.",
  no_code: NAVER_LOGIN_GENERIC_MESSAGE,
  token_error: NAVER_LOGIN_GENERIC_MESSAGE,
  profile_error: NAVER_LOGIN_GENERIC_MESSAGE,
  no_email:
    "네이버 계정에서 이메일 정보를 받지 못해 가입을 진행하지 못했어요. 네이버 내정보에서 이메일 제공 동의 후 다시 시도해 주세요.",
  create_user_error: NAVER_LOGIN_GENERIC_MESSAGE,
  session_error: NAVER_LOGIN_GENERIC_MESSAGE,
  verify_error: NAVER_LOGIN_GENERIC_MESSAGE,
  unexpected: NAVER_LOGIN_GENERIC_MESSAGE,
  [NAVER_UNKNOWN_LOGIN_ERROR_CODE]: NAVER_LOGIN_GENERIC_MESSAGE,
};

/**
 * 유저가 문의 시 복사해 보낼 진단코드 — raw 오류 대신 폐쇄집합 코드만 노출.
 * 카카오 축은 메시지 자체가 자가해결 안내라 진단코드를 붙이지 않는다.
 */
export const AUTH_ERROR_DIAG_CODES: Partial<Record<UserFacingAuthErrorCode, string>> = {
  state_mismatch: "NV-STATE",
  no_code: "NV-NOCODE",
  token_error: "NV-TOKEN",
  profile_error: "NV-PROFILE",
  no_email: "NV-NOEMAIL",
  create_user_error: "NV-CREATE",
  session_error: "NV-SESSION",
  verify_error: "NV-VERIFY",
  unexpected: "NV-UNEXPECTED",
  [NAVER_UNKNOWN_LOGIN_ERROR_CODE]: "NV-PROVIDER",
};

function isKnownNaverLoginErrorCode(value: string): value is KnownNaverLoginErrorCode {
  return (NAVER_LOGIN_ERROR_CODES as readonly string[]).includes(value);
}

export function getUserFacingAuthError(
  params: Pick<URLSearchParams, "get">,
): UserFacingAuthErrorCode | null {
  if (params.get("auth_error") === KAKAO_EMAIL_UNVERIFIED_CODE) {
    return KAKAO_EMAIL_UNVERIFIED_CODE;
  }

  const loginError = params.get(NAVER_LOGIN_ERROR_PARAM);
  if (loginError) {
    if (loginError === NAVER_USER_CANCELLED) return null; // 유저 자진 취소 — 오류 아님
    return isKnownNaverLoginErrorCode(loginError)
      ? loginError
      : NAVER_UNKNOWN_LOGIN_ERROR_CODE;
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
