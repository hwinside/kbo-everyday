"use client";

import { Geolocation } from "@capacitor/geolocation";

export interface Position {
  lat: number;
  lng: number;
}
export interface GeoError {
  error: string;
}

/**
 * 현재 위치를 얻는다. @capacitor/geolocation 은 네이티브(iOS/Android)에선 시스템 GPS,
 * 웹에선 navigator.geolocation 을 사용한다(플러그인 web 구현).
 * ⚠️ 네이티브 인앱 동작은 위치 권한(Info.plist / AndroidManifest) + 플러그인이 들어간
 *    빌드가 스토어에 배포된 뒤부터. 그 전(구버전 앱)엔 권한 거부/미구현으로 error 반환.
 */
export async function getVenuePosition(): Promise<Position | GeoError> {
  try {
    // 네이티브에선 권한 프롬프트 유도(웹은 미구현일 수 있어 무시)
    try {
      const perm = await Geolocation.checkPermissions();
      if (perm.location !== "granted" && perm.coarseLocation !== "granted") {
        const req = await Geolocation.requestPermissions();
        if (req.location !== "granted" && req.coarseLocation !== "granted") {
          return { error: "위치 권한을 허용해야 직관 인증이 가능해요" };
        }
      }
    } catch {
      // checkPermissions/requestPermissions 미구현(웹) — getCurrentPosition 에서 처리
    }

    const pos = await Geolocation.getCurrentPosition({
      enableHighAccuracy: false,
      timeout: 12000,
      maximumAge: 30000,
    });
    return { lat: pos.coords.latitude, lng: pos.coords.longitude };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "";
    if (/denied|permission/i.test(msg)) {
      return { error: "위치 권한을 허용해야 직관 인증이 가능해요" };
    }
    return { error: "위치를 확인할 수 없어요. 잠시 후 다시 시도해주세요" };
  }
}
