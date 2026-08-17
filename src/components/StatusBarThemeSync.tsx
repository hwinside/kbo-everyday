"use client";

import { useEffect } from "react";
import { useTheme } from "@/components/ThemeProvider";

/**
 * 안드로이드 네이티브 상태바를 앱의 현재 테마에 동기화한다.
 *
 * 배경: targetSdk 36(Android 15+)은 edge-to-edge를 강제해 `android:statusBarColor`가
 * 무시된다. 그 결과 상태바 뒤로 창 배경이 비쳐 라이트 화면에서도 상단이 검게 보였다
 * (유저 제보: "위에 검정 줄", 앱=검정 / 브라우저=하양). 웹은 라이트/다크(+ 인앱 토글)를
 * 따라가는데 네이티브 상태바만 고정 다크였던 색 불일치가 원인.
 *
 * 해결: 상태바를 오버레이(투명)로 두어 웹 콘텐츠(safe-area 패딩 `pt-safe`)가 상태바 영역
 * 배경을 직접 칠하게 하고(=iOS black-translucent와 동일 방식), 아이콘 명암만 실제 렌더
 * 테마(resolvedTheme)에 맞춘다. 시스템 테마가 아니라 인앱 토글까지 정확히 반영된다.
 *
 * 안드로이드 전용 — iOS(black-translucent 메타)·웹 브라우저는 건드리지 않는다(회귀 방지).
 * 플러그인이 없는 구버전 APK / 웹에서는 호출이 no-op 되거나 실패해도 조용히 무시한다.
 */
export default function StatusBarThemeSync() {
  const { resolvedTheme } = useTheme();

  useEffect(() => {
    (async () => {
      try {
        const { Capacitor } = await import("@capacitor/core");
        // 네이티브 안드로이드에서만 동작. 웹/iOS는 조기 반환.
        if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== "android") return;

        const { StatusBar, Style } = await import("@capacitor/status-bar");

        // 웹뷰가 상태바 뒤까지 그리도록 오버레이(edge-to-edge). 콘텐츠의 safe-area
        // 패딩이 상태바 영역을 테마색으로 채운다.
        await StatusBar.setOverlaysWebView({ overlay: true });
        // 배경 투명 — 오버레이라 실제로는 웹 콘텐츠가 비친다.
        await StatusBar.setBackgroundColor({ color: "#00000000" });
        // 아이콘 명암: 다크 배경 → 밝은 아이콘(Style.Dark), 라이트 배경 → 어두운 아이콘(Style.Light).
        await StatusBar.setStyle({
          style: resolvedTheme === "dark" ? Style.Dark : Style.Light,
        });
      } catch {
        // 네이티브 아님 / 플러그인 미설치(구버전 APK) — 무시.
      }
    })();
  }, [resolvedTheme]);

  return null;
}
