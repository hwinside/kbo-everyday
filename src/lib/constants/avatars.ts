// 프리셋 아바타 정의 (Twemoji, CC-BY 4.0)
export interface PresetAvatar {
  key: string;
  label: string;
  path: string;
}

export const PRESET_AVATARS: PresetAvatar[] = [
  { key: "baseball", label: "야구공", path: "/avatars/baseball.png" },
  { key: "glove", label: "글러브", path: "/avatars/glove.png" },
  { key: "cap", label: "모자", path: "/avatars/cap.png" },
  { key: "trophy", label: "트로피", path: "/avatars/trophy.png" },
  { key: "stadium", label: "구장", path: "/avatars/stadium.png" },
  { key: "megaphone", label: "메가폰", path: "/avatars/megaphone.png" },
  { key: "beer", label: "맥주", path: "/avatars/beer.png" },
  { key: "hotdog", label: "핫도그", path: "/avatars/hotdog.png" },
  { key: "fire", label: "불꽃", path: "/avatars/fire.png" },
  { key: "star", label: "스타", path: "/avatars/star.png" },
  { key: "muscle", label: "근육", path: "/avatars/muscle.png" },
  { key: "fist", label: "화이팅", path: "/avatars/fist.png" },
];

/**
 * avatar_url 값에서 프리셋 아바타 경로를 반환.
 * "preset:baseball" → "/avatars/baseball.png"
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
