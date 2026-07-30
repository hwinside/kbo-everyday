"use client";

import { Capacitor, registerPlugin } from "@capacitor/core";

export type VenueMediaPermission = "prompt" | "authorized" | "limited" | "denied";
export type VenueMediaKind = "image" | "video";

export interface VenueMediaAsset {
  id: string;
  kind: VenueMediaKind;
  thumbnailUrl: string;
  durationMs: number | null;
  createdAt: number;
}

interface VenueMediaPage {
  assets: VenueMediaAsset[];
  nextCursor: string | null;
  permission: VenueMediaPermission;
}

interface ExportedVenueMedia {
  webPath: string;
  fileName: string;
  mimeType: string;
  size: number;
  lastModified: number;
}

interface VenueMediaLibraryPlugin {
  getPermission(): Promise<{ permission: VenueMediaPermission }>;
  requestPermission(): Promise<{ permission: VenueMediaPermission }>;
  listMedia(options: { cursor?: string; limit: number }): Promise<VenueMediaPage>;
  exportMedia(options: { id: string }): Promise<ExportedVenueMedia>;
  presentLimitedPicker(): Promise<void>;
  openSettings(): Promise<void>;
}

const VenueMediaLibrary = registerPlugin<VenueMediaLibraryPlugin>("VenueMediaLibrary");

/** 커스텀 그리드는 네이티브 사진첩 열거 브릿지가 있는 설치 앱에서만 동작한다. */
export function canUseVenueMediaLibrary(): boolean {
  return Capacitor.isNativePlatform();
}

export async function getVenueMediaPermission(): Promise<VenueMediaPermission> {
  return (await VenueMediaLibrary.getPermission()).permission;
}

export async function requestVenueMediaPermission(): Promise<VenueMediaPermission> {
  return (await VenueMediaLibrary.requestPermission()).permission;
}

export async function listVenueMedia(
  cursor?: string,
  limit: number = 60,
): Promise<VenueMediaPage> {
  return VenueMediaLibrary.listMedia({ ...(cursor ? { cursor } : {}), limit });
}

/**
 * 네이티브가 사진첩 asset을 앱 cache로 export한 뒤 반환한 경로를 기존 upload.ts가 받는 File로 변환.
 * 원격 웹뷰는 file://을 직접 읽지 못하므로 convertFileSrc를 반드시 거친다.
 */
export async function exportVenueMediaFile(id: string): Promise<File> {
  const exported = await VenueMediaLibrary.exportMedia({ id });
  const response = await fetch(Capacitor.convertFileSrc(exported.webPath));
  if (!response.ok) throw new Error("선택한 미디어를 불러오지 못했어요");
  const blob = await response.blob();
  return new File([blob], exported.fileName, {
    type: exported.mimeType || blob.type,
    lastModified: exported.lastModified,
  });
}

export async function presentLimitedVenueMediaPicker(): Promise<void> {
  await VenueMediaLibrary.presentLimitedPicker();
}

export async function openVenueMediaSettings(): Promise<void> {
  await VenueMediaLibrary.openSettings();
}
