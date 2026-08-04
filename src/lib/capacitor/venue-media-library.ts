"use client";

import { registerPlugin } from "@capacitor/core";
import { isNativeRuntime } from "@/lib/capacitor/platform";

export type VenueMediaPermission = "prompt" | "authorized" | "limited" | "denied";
export type VenueMediaKind = "image" | "video";

export interface VenueMediaAsset {
  id: string;
  kind: VenueMediaKind;
  /** 네이티브가 내려준 소형 썸네일 data URL(원격 WebView 는 _capacitor_file_ 을 못 읽는다) */
  thumbnailUrl: string;
  durationMs: number | null;
  createdAt: number;
}

interface VenueMediaPage {
  assets: VenueMediaAsset[];
  nextCursor: string | null;
  permission: VenueMediaPermission;
}

/** exportMedia 가 cache 에 써 둔 원본 파일 핸들 — readExport 청크로 읽고 releaseExport 로 정리 */
interface VenueMediaExportHandle {
  token: string;
  fileName: string;
  mimeType: string;
  size: number;
  lastModified: number;
}

interface VenueMediaLibraryPlugin {
  getPermission(): Promise<{ permission: VenueMediaPermission }>;
  requestPermission(): Promise<{ permission: VenueMediaPermission }>;
  listMedia(options: {
    cursor?: string;
    limit: number;
    /**
     * 열거할 미디어 타입. 생략/빈 배열이면 사진+영상 전체(기존 계약).
     * 구설치본 네이티브는 이 파라미터를 무시하고 혼합 목록을 내려준다 — 호출부가
     * 화면단 필터를 fail-safe 로 유지해야 하는 이유(원격 WebView 라 웹만 먼저 배포됨).
     */
    mediaTypes?: VenueMediaKind[];
  }): Promise<VenueMediaPage>;
  exportMedia(options: { id: string }): Promise<VenueMediaExportHandle>;
  readExport(options: { token: string; offset: number; length: number }): Promise<{ data: string }>;
  releaseExport(options: { token: string }): Promise<void>;
  presentLimitedPicker(): Promise<void>;
  openSettings(): Promise<void>;
  selectionChanged(): Promise<void>;
}

const VenueMediaLibrary = registerPlugin<VenueMediaLibraryPlugin>("VenueMediaLibrary");

// 주입된 네이티브 브릿지(window.Capacitor) — 원격 로드(server.url=keubo.fan) 앱은 npm
// @capacitor/core 가 'web' false-negative 될 수 있어(native-app-review.ts 와 동일 패턴)
// npm 프록시 실패 시 주입 브릿지의 Plugins 레지스트리를 직접 호출한다.
interface InjectedCapacitor {
  Plugins?: Record<string, Record<string, (options?: unknown) => Promise<unknown>> | undefined>;
  isPluginAvailable?: (name: string) => boolean;
}

function getInjectedPlugin():
  | Record<string, (options?: unknown) => Promise<unknown>>
  | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const injected = (window as unknown as { Capacitor?: InjectedCapacitor }).Capacitor;
    return injected?.Plugins?.VenueMediaLibrary;
  } catch {
    return undefined;
  }
}

/** npm 프록시 → 주입 브릿지 순으로 호출. 양쪽 다 실패하면 마지막 에러를 던진다. */
async function callPlugin<T>(
  method: keyof VenueMediaLibraryPlugin,
  options?: unknown,
): Promise<T> {
  try {
    return await (
      VenueMediaLibrary[method] as unknown as (o?: unknown) => Promise<T>
    )(options);
  } catch (coreErr) {
    const injected = getInjectedPlugin();
    const fn = injected?.[method as string];
    if (fn) return (await fn(options)) as T;
    throw coreErr;
  }
}

/**
 * 커스텀 그리드 진입 자격 — 설치 앱 runtime 판정.
 * `Capacitor.isNativePlatform()` 단독 판정 금지: 원격 로드(server.url) 설치 앱은 npm core 가
 * 'web' false-negative(PR #484 운영 사고) → 공용 `isNativeRuntime()`(npm core OR 주입 브릿지) 사용.
 */
export function canUseVenueMediaLibrary(): boolean {
  return isNativeRuntime();
}

/**
 * 네이티브 `VenueMediaLibrary` 브릿지 가용성 런타임 감지 — version gate.
 * 플러그인 없는 구설치본(원격 WebView 만 최신)은 false → 호출부가 기존 file input 픽커로 폴백해
 * 업로드 동선이 끊기지 않게 한다. 판정: 실제 getPermission 호출이 성공하는지 probe
 * (UNIMPLEMENTED/미등록이면 reject → false). 결과는 세션 캐시.
 */
let availabilityCache: boolean | null = null;
export async function isVenueMediaLibraryAvailable(): Promise<boolean> {
  if (!isNativeRuntime()) return false;
  if (availabilityCache != null) return availabilityCache;
  try {
    await callPlugin<{ permission: VenueMediaPermission }>("getPermission");
    availabilityCache = true;
  } catch {
    availabilityCache = false;
  }
  return availabilityCache;
}

export async function getVenueMediaPermission(): Promise<VenueMediaPermission> {
  return (await callPlugin<{ permission: VenueMediaPermission }>("getPermission")).permission;
}

export async function requestVenueMediaPermission(): Promise<VenueMediaPermission> {
  return (await callPlugin<{ permission: VenueMediaPermission }>("requestPermission")).permission;
}

/**
 * 사진첩 페이지 열거.
 * @param mediaTypes 열거할 타입(생략 = 사진+영상). 네이티브가 **쿼리 단계에서** 걸러주므로
 *   nextCursor 도 같은 타입 안에서만 진행한다(혼합 목록을 받아 화면에서 걸러내는 방식과 다름).
 *   구설치본은 이 인자를 무시하므로 호출부가 화면단 필터를 함께 유지해야 한다.
 */
export async function listVenueMedia(
  cursor?: string,
  limit: number = 60,
  mediaTypes?: VenueMediaKind[],
): Promise<VenueMediaPage> {
  return callPlugin<VenueMediaPage>("listMedia", {
    ...(cursor ? { cursor } : {}),
    limit,
    ...(mediaTypes && mediaTypes.length > 0 ? { mediaTypes } : {}),
  });
}

/** readExport 청크 크기 — 브릿지 메시지당 base64 부담과 왕복 횟수의 절충(4MB). */
const EXPORT_CHUNK_BYTES = 4 * 1024 * 1024;

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/**
 * 네이티브가 사진첩 asset 원본을 앱 cache 로 export한 뒤, base64 청크(readExport)로 읽어
 * 기존 upload.ts 가 받는 File 로 조립한다. 원격 WebView(server.url)는 file:// 도
 * _capacitor_file_ 경로도 읽지 못하므로 반드시 이 base64 청크 경로를 쓴다.
 * 성공/실패와 무관하게 releaseExport 로 cache 파일을 정리한다.
 */
export async function exportVenueMediaFile(id: string): Promise<File> {
  const handle = await callPlugin<VenueMediaExportHandle>("exportMedia", { id });
  try {
    const parts: BlobPart[] = [];
    let offset = 0;
    while (offset < handle.size) {
      const { data } = await callPlugin<{ data: string }>("readExport", {
        token: handle.token,
        offset,
        length: Math.min(EXPORT_CHUNK_BYTES, handle.size - offset),
      });
      const bytes = base64ToBytes(data);
      if (bytes.length === 0) throw new Error("empty chunk");
      parts.push(bytes.buffer as ArrayBuffer);
      offset += bytes.length;
    }
    return new File(parts, handle.fileName, {
      type: handle.mimeType,
      lastModified: handle.lastModified,
    });
  } finally {
    try {
      await callPlugin<void>("releaseExport", { token: handle.token });
    } catch {
      /* cache cleanup best-effort — 네이티브도 세션 종료 시 자체 정리 */
    }
  }
}

/**
 * Limited '더 보기' 재선택 시트. **사용자가 선택을 마친 뒤** resolve 된다
 * (iOS 15+ completionHandler / Android permissionCallback) — 호출부는 resolve 후
 * 목록을 재조회해야 stale 이 안 남는다(삼순 라운드2 #1).
 */
export async function presentLimitedVenueMediaPicker(): Promise<void> {
  await callPlugin<void>("presentLimitedPicker");
}

export async function openVenueMediaSettings(): Promise<void> {
  await callPlugin<void>("openSettings");
}

/** 선택/해제 즉시 가벼운 촉각 피드백. 구 브릿지에서는 조용히 no-op. */
export async function venueMediaSelectionHaptic(): Promise<void> {
  try {
    await callPlugin<void>("selectionChanged");
  } catch {
    navigator.vibrate?.(8);
  }
}

/** 테스트 전용 — availability probe 세션 캐시 초기화 */
export function __resetVenueMediaLibraryAvailabilityCache(): void {
  availabilityCache = null;
}
