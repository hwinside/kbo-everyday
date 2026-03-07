// 프리셋 아바타 정의
export interface PresetAvatar {
  key: string;
  label: string;
  path: string;
}

export const PRESET_AVATARS: PresetAvatar[] = [
  { key: "baseball", label: "야구공", path: "/avatars/baseball.png" },
  { key: "bat", label: "배트", path: "/avatars/bat.png" },
  { key: "glove", label: "글러브", path: "/avatars/glove.png" },
  { key: "cap", label: "모자", path: "/avatars/cap.png" },
  { key: "helmet", label: "헬멧", path: "/avatars/helmet.png" },
  { key: "homeplate", label: "홈플레이트", path: "/avatars/homeplate.png" },
  { key: "cheerstick", label: "응원막대", path: "/avatars/cheerstick.png" },
  { key: "beer", label: "맥주", path: "/avatars/beer.png" },
  { key: "hotdog", label: "핫도그", path: "/avatars/hotdog.png" },
  { key: "foam_finger", label: "폼핑거", path: "/avatars/foam_finger.png" },
  { key: "megaphone", label: "메가폰", path: "/avatars/megaphone.png" },
  { key: "trophy", label: "트로피", path: "/avatars/trophy.png" },
];

/**
 * avatar_url 값에서 프리셋 아바타 경로를 반환.
 * "preset:baseball" → "/avatars/baseball.png"
 * 일반 URL이면 null 반환 (이니셜 폴백 사용).
 * 외부 URL은 프라이버시 정책상 사용하지 않음.
 */
export function getAvatarPath(avatarUrl: string | null): string | null {
  if (!avatarUrl) return null;
  if (avatarUrl.startsWith("preset:")) {
    const key = avatarUrl.replace("preset:", "");
    const preset = PRESET_AVATARS.find((a) => a.key === key);
    return preset?.path ?? null;
  }
  // 외부 URL은 사용하지 않음 (프라이버시 정책)
  return null;
}

export function getPresetKey(avatarUrl: string | null): string | null {
  if (!avatarUrl?.startsWith("preset:")) return null;
  return avatarUrl.replace("preset:", "");
}
