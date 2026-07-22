"use client";

import { Geolocation } from "@capacitor/geolocation";
import { Capacitor } from "@capacitor/core";

export interface Position {
  lat: number;
  lng: number;
  accuracy: number | null;
}
export interface GeoError {
  error: string;
  needsUpdate?: boolean;
}

/**
 * 현재 위치를 얻는다. @capacitor/geolocation 은 네이티브 GPS(iOS/Android) / 웹 navigator.geolocation.
 * ⚠️ 네이티브 인앱 GPS는 위치권한+플러그인이 들어간 빌드 배포 후부터. 구버전 앱은
 *    Capacitor.isPluginAvailable 로 감지해 "앱 업데이트 필요"로 명시 안내한다.
 */
export async function getVenuePosition(): Promise<Position | GeoError> {
  if (Capacitor.isNativePlatform() && !Capacitor.isPluginAvailable("Geolocation")) {
    return {
      error: "앱을 최신 버전으로 업데이트하면 직관 인증을 쓸 수 있어요",
      needsUpdate: true,
    };
  }

  try {
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
      enableHighAccuracy: true,
      timeout: 15000,
      maximumAge: 10000,
    });
    return {
      lat: pos.coords.latitude,
      lng: pos.coords.longitude,
      accuracy: typeof pos.coords.accuracy === "number" ? pos.coords.accuracy : null,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "";
    if (/denied|permission/i.test(msg)) {
      return { error: "위치 권한을 허용해야 직관 인증이 가능해요" };
    }
    return { error: "위치를 확인할 수 없어요. 야외에서 다시 시도해주세요" };
  }
}
