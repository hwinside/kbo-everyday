"use client";

import { useEffect, useRef } from "react";
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
 * API 경로: `setOverlaysWebView({ overlay: true })`는 API 레벨과 무관하게 edge-to-edge를
 * 켠다.
 *  - API ≥35(Android 15+): 이미 edge-to-edge가 강제라 statusBarColor는 무시되고, 오버레이가
 *    상태바 뒤 콘텐츠를 노출시킨다(제보 케이스). styles.xml의 투명 statusBarColor는 무해.
 *  - API ≤34(Android 14-): edge-to-edge가 기본이 아니므로 오버레이가 이를 명시적으로 켜고,
 *    투명 statusBarColor가 존중되어 동일하게 콘텐츠가 상태바 영역을 칠한다.
 * 즉 두 경로 모두 동일 코드로 수렴한다(분기 불필요). 아이콘 명암은 setStyle로 통일.
 *
 * 경합/stale 방어: ThemeProvider 초기 `resolvedTheme`는 dark로 시작해 마운트 직후 실제값
 * (예: light)으로 갱신되고, 인앱 토글로도 빠르게 바뀔 수 있다. 비동기 effect가 여러 개
 * 겹치면 늦게 시작한 게 먼저 끝나 stale 스타일이 후승할 수 있으므로, 세대(generation)
 * 펜스로 "가장 최근 실행만 적용"을 보장한다. 각 await 뒤 stale이면 즉시 중단한다.
 *
 * 안드로이드 전용 — iOS(black-translucent 메타)·웹 브라우저는 건드리지 않는다(회귀 방지).
 * 플러그인이 없는 구버전 APK / 웹에서는 호출이 no-op 되거나 실패해도 조용히 무시한다.
 */
export default function StatusBarThemeSync() {
  const { resolvedTheme } = useTheme();
  // 세대 카운터: 각 effect 실행마다 증가. 더 늦게 시작한 실행이 항상 이긴다.
  const genRef = useRef(0);

  useEffect(() => {
    const myGen = ++genRef.current;
    // 재실행 시엔 다음 실행이 genRef를 올려 이 실행이 stale이 되고, 언마운트 시엔
    // cancelled가 막는다(genRef는 cleanup에서 건드리지 않는다).
    let cancelled = false;
    const isStale = () => cancelled || myGen !== genRef.current;

    (async () => {
      try {
        const { Capacitor } = await import("@capacitor/core");
        // 네이티브 안드로이드에서만 동작. 웹/iOS는 조기 반환.
        if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== "android") return;
        if (isStale()) return;

        const { StatusBar, Style } = await import("@capacitor/status-bar");
        if (isStale()) return;

        // 웹뷰가 상태바 뒤까지 그리도록 오버레이(edge-to-edge). 콘텐츠의 safe-area
        // 패딩이 상태바 영역을 테마색으로 채운다.
        await StatusBar.setOverlaysWebView({ overlay: true });
        if (isStale()) return;
        // 배경 투명 — 오버레이라 실제로는 웹 콘텐츠가 비친다.
        await StatusBar.setBackgroundColor({ color: "#00000000" });
        if (isStale()) return;
        // 아이콘 명암: 다크 배경 → 밝은 아이콘(Style.Dark), 라이트 배경 → 어두운 아이콘(Style.Light).
        // 최종 적용 직전 stale 체크로 콜드스타트(dark→light)·빠른 토글의 후승을 막는다.
        await StatusBar.setStyle({
          style: resolvedTheme === "dark" ? Style.Dark : Style.Light,
        });
      } catch {
        // 네이티브 아님 / 플러그인 미설치(구버전 APK) — 무시.
      }
    })();

    return () => {
      // 진행 중인 비동기 적용을 무효화. 재실행은 genRef 세대 펜스로, 언마운트는
      // 이 플래그로 막는다.
      cancelled = true;
    };
  }, [resolvedTheme]);

  return null;
}
