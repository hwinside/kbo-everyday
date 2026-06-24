import { isAndroidWeb } from "@/lib/capacitor/platform";

export type AnnouncementTarget = "all" | "android_web";

/**
 * 클라이언트 플랫폼 기준 새소식 노출 여부.
 * target_platform === 'android_web'  → 안드로이드 모바일웹에만 노출(설치 앱/iOS 제외).
 * 그 외('all' 또는 미지정)            → 전체 노출.
 */
export function isAnnouncementVisible(
  target: AnnouncementTarget | string | null | undefined,
): boolean {
  if (target === "android_web") return isAndroidWeb();
  return true;
}
