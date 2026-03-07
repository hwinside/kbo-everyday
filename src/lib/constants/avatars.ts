// 프리셋 아바타 정의 (Twemoji, CC-BY 4.0)
export interface PresetAvatar {
  key: string;
  label: string;
  path: string;
}

export const PRESET_AVATARS: PresetAvatar[] = [
  { key: "baseball", label: "야구공", path: "/avatars/baseball.svg" },
  { key: "glove", label: "글러브", path: "/avatars/glove.svg" },
  { key: "cap", label: "모자", path: "/avatars/cap.svg" },
  { key: "trophy", label: "트로피", path: "/avatars/trophy.svg" },
  { key: "stadium", label: "구장", path: "/avatars/stadium.svg" },
  { key: "megaphone", label: "메가폰", path: "/avatars/megaphone.svg" },
  { key: "beer", label: "맥주", path: "/avatars/beer.svg" },
  { key: "hotdog", label: "핫도그", path: "/avatars/hotdog.svg" },
  { key: "fire", label: "불꽃", path: "/avatars/fire.svg" },
  { key: "star", label: "스타", path: "/avatars/star.svg" },
  { key: "muscle", label: "근육", path: "/avatars/muscle.svg" },
  { key: "fist", label: "화이팅", path: "/avatars/fist.svg" },
];

/**
 * avatar_url 값에서 프리셋 아바타 경로를 반환.
 * "preset:baseball" → "/avatars/baseball.svg"
 * 외부 URL은 프라이버시 정책상 사용하지 않음.
 */
export function getAvatarPath(avatarUrl: string | null): string | null {
  if (!avatarUrl) return null;
  if (avatarUrl.startsWith("preset:")) {
    const key = avatarUrl.replace("preset:", "");
    const preset = PRESET_AVATARS.find((a) => a.key === key);
    return preset?.path ?? null;
  }
  return null;
}

export function getPresetKey(avatarUrl: string | null): string | null {
  if (!avatarUrl?.startsWith("preset:")) return null;
  return avatarUrl.replace("preset:", "");
}
