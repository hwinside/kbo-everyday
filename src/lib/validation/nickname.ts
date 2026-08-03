export const NICKNAME_MIN_LENGTH = 2;
export const NICKNAME_MAX_LENGTH = 8;
export const NICKNAME_LENGTH_MESSAGE = `닉네임은 ${NICKNAME_MIN_LENGTH}~${NICKNAME_MAX_LENGTH}자로 입력해주세요`;
export const NICKNAME_INPUT_PLACEHOLDER = `닉네임 (${NICKNAME_MIN_LENGTH}~${NICKNAME_MAX_LENGTH}자)`;

export function normalizeNickname(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

export function validateNickname(nickname: string): string | null {
  if (nickname.length < NICKNAME_MIN_LENGTH || nickname.length > NICKNAME_MAX_LENGTH) {
    return NICKNAME_LENGTH_MESSAGE;
  }
  if (!/^[가-힣a-zA-Z0-9]+$/.test(nickname)) {
    return "한글, 영문, 숫자만 사용 가능합니다";
  }
  return null;
}
