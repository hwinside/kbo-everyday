// 직관 스토리 업로드 큐 — 원본을 **업로드 차례에만** export 하고, 그 항목 업로드가 끝나면
// 즉시 참조를 놓아 다음 항목 export 전에 GC 가능하게 하는 bounded-memory 순차 러너.
// (삼순 라운드3 #2·#3: 원본 File/full-res data URL 을 3개 동시 상주시키지 않고,
//  export 실패건은 assetId 를 보존해 재시도 시 exportVenueMediaFile 을 재실행한다.)
//
// 컴포넌트(runUpload)는 이 러너에 UI 콜백만 주입한다 — 순차/해제/재export 계약은 여기서
// 단일 소스로 고정하고, 실제 상태 회귀(export 재시도·resident peak=1)로 검증한다.

/** 원본을 만들 수단(File 도, native asset id 도) 자체가 없어 재시도가 무의미한 경우. */
export class VenueOriginalUnavailableError extends Error {}

export interface VenueUploadTarget {
  key: string;
  /** 파일 픽(폴백 경로)은 이미 File 보유 — 그리드 픽은 null 이고 assetId 로 lazy export. */
  file: File | null;
  /** 그리드 픽 원본 핸들 — export 실패해도 보존돼 재시도가 다시 export 하게 한다(#2). */
  assetId: string | null;
  kind: "image" | "video";
  durationMs: number | null;
}

export interface VenueUploadHandlers {
  /** assetId → 원본 File. 큐는 항목 차례에만 1회 호출하고, 실패 시 그대로 전파한다. */
  exportOriginal: (assetId: string) => Promise<File>;
  /** 원본 준비 완료 후 실제 업로드. 자체적으로 성공/실패 상태를 기록한다(예외 없이 소진). */
  uploadOne: (target: VenueUploadTarget, file: File) => Promise<void>;
  /** 각 항목 처리 시작(원본 export 전) — "올리는 중" 상태 노출용. */
  onStart?: (target: VenueUploadTarget) => void;
  /** 원본 준비 실패 — 항목은 실패로 남기되 제거하지 않는다(assetId 보존 → 재시도 재export). */
  onResolveFail: (target: VenueUploadTarget, error: unknown) => void;
  /** 현재 메모리에 상주 중인 원본 File 개수 변화 통지(bounded-memory 회귀 관찰용). */
  onResidentChange?: (residentCount: number) => void;
}

/**
 * 항목 원본 확보 — File 이 이미 있으면 그대로, 없으면 assetId 로 export.
 * export 실패는 그대로 throw(assetId 는 target 에 남아 재시도가 다시 이 경로로 export 한다).
 * File·assetId 둘 다 없으면 재시도 불가 — VenueOriginalUnavailableError.
 */
export async function resolveVenueOriginal(
  target: Pick<VenueUploadTarget, "file" | "assetId">,
  exportOriginal: (assetId: string) => Promise<File>,
): Promise<File> {
  if (target.file) return target.file;
  if (target.assetId == null) {
    throw new VenueOriginalUnavailableError("원본을 준비하지 못했어요");
  }
  return exportOriginal(target.assetId);
}

/**
 * 순차 업로드 러너 — 항목을 순서대로 처리하되 **한 번에 원본 File 1개만** 메모리에 상주시킨다.
 *  1) onStart → 2) resolveVenueOriginal(차례에만 export) → 3) uploadOne await
 *  → 4) finally 로 참조 해제(resident-1) 후 다음 항목. 앞 항목 File 을 붙들지 않아 3×원본 동시 상주 없음(#3).
 * export 실패는 onResolveFail 로 넘기고 다음 항목으로 진행(#2: 항목/assetId 유지 → 재시도 가능).
 */
export async function runVenueUploadQueue(
  targets: readonly VenueUploadTarget[],
  handlers: VenueUploadHandlers,
): Promise<void> {
  let resident = 0;
  for (const target of targets) {
    handlers.onStart?.(target);
    let file: File;
    try {
      file = await resolveVenueOriginal(target, handlers.exportOriginal);
    } catch (error) {
      handlers.onResolveFail(target, error);
      continue;
    }
    resident += 1;
    handlers.onResidentChange?.(resident);
    try {
      await handlers.uploadOne(target, file);
    } finally {
      // 이 항목 업로드가 끝나면 원본 참조를 즉시 놓는다 — 다음 항목 export 전 GC 가능(bounded memory).
      file = null as unknown as File;
      resident -= 1;
      handlers.onResidentChange?.(resident);
    }
  }
}
