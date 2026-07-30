"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import { X, Loader2, Video as VideoIcon, MapPin, Play, Settings } from "lucide-react";
import { getSafeSession } from "@/lib/supabase/client";
import {
  prepareVenueStoryMedia,
  probeVideoDurationMs,
  type UploadStage,
} from "@/lib/venue-stories/upload";
import { checkVenueMediaLimits } from "@/lib/venue-stories/media-limits";
import { isVideoCompressSupported } from "@/lib/venue-stories/video-compress";
import { getVenuePosition, type Position } from "@/lib/venue-stories/geo";
import { evaluateGeofence, isVenueUploadBlocked } from "@/lib/venue-stories/geofence";
import {
  classifyPrecheck,
  isPrecheckReusable,
  precheckGateReady,
  VENUE_PRECHECK_REUSE_TTL_MS,
  type PrecheckState,
} from "@/lib/venue-stories/precheck";
import {
  VENUE_GEOFENCE_MAX_ACCURACY_M,
  VENUE_STORY_CONSENT_VERSION,
  type VenueInfo,
} from "@/lib/venue-stories/types";
import { consentStorageKey } from "@/lib/venue-stories/auth-consent";
import { venueStorySubmitReady } from "@/lib/venue-stories/composer-helpers";
import {
  VENUE_STORY_MAX_ITEMS,
  VENUE_STORY_OVER_MAX_MSG,
  VENUE_STORY_CTA_LABEL,
  type MultiItemStatus,
  pickIdentity,
  mergePickedItems,
  mediaDurationBadge,
  overallUploadProgress,
  summarizeUploadOutcome,
  uploadFailureReason,
  isRetryableItem,
} from "@/lib/venue-stories/multi-pick";
import { readFileAsDataURL } from "@/lib/venue-stories/read-file";
import { getMyTeamId } from "@/lib/store/myteam";
import { paletteForTeamId } from "@/design-v2/team-palette";
import { useIsAdmin } from "@/hooks/useIsAdmin";
import {
  canUseVenueMediaLibrary,
  exportVenueMediaFile,
  getVenueMediaPermission,
  listVenueMedia,
  openVenueMediaSettings,
  presentLimitedVenueMediaPicker,
  requestVenueMediaPermission,
  type VenueMediaAsset,
  type VenueMediaPermission,
} from "@/lib/capacitor/venue-media-library";

interface Props {
  gameId: string;
  isOpen: boolean;
  onClose: () => void;
  onUploaded: (result: {
    id: number | null;
    mediaType: "video" | "image";
    status: string | null;
    thumbUrl: string | null;
  }) => void;
}

type Phase = "idle" | "geo" | "upload" | "done";

/** 멀티픽 항목 — 원본 File + 프리뷰/진행/결과. key 는 pickIdentity(중복 픽 방지와 동일 축). */
interface ComposerItem {
  key: string;
  file: File;
  kind: "image" | "video";
  /** image: data URL(안드 WebView blob 미렌더 회피, 삼순 #839 유지) · video: blob URL */
  previewUrl: string | null;
  durationMs: number | null;
  status: MultiItemStatus;
  /** 0~1 — status==="uploading" 일 때만 유효 */
  progress: number;
  stage: UploadStage;
  failReason: string | null;
  /** 커스텀 사진첩 그리드에서 선택한 원본 asset id — 재진입 시 선택 순서 번호 표시용. */
  assetId: string | null;
}

export default function VenueStoryComposer({ gameId, isOpen, onClose, onUploaded }: Props) {
  const isAdmin = useIsAdmin();
  const [items, setItems] = useState<ComposerItem[]>([]);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [caption, setCaption] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [libraryAssets, setLibraryAssets] = useState<VenueMediaAsset[]>([]);
  const [libraryCursor, setLibraryCursor] = useState<string | null>(null);
  const [libraryPermission, setLibraryPermission] =
    useState<VenueMediaPermission>("prompt");
  const [libraryLoading, setLibraryLoading] = useState(false);
  const libraryAutoOpenRef = useRef(false);
  // phase state 반영 전의 짧은 구간까지 닫기/중복 제출을 막는 동기 guard.
  const uploadInFlightRef = useRef(false);
  // 네이티브 asset export 뒤 duration probe/data URL 준비가 끝날 때까지 재선택을 막는다.
  const processingPickRef = useRef(false);
  // 영상 duration probe·이미지 read가 async — reset 이후 도착하는 late 결과는 무시한다
  const pickSeqRef = useRef(0);
  const [error, setError] = useState<string | null>(null);
  const [venue, setVenue] = useState<VenueInfo | null>(null);
  const [venueLoading, setVenueLoading] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [sessionUserId, setSessionUserId] = useState<string | null>(null);

  // GPS 선체크 — 모달 열릴 때 위치를 미리 측정해 경기장 밖이면 파일 선택 전에 안내한다
  // (하린아빠: 못 올리는 위치 유저가 촬영·선택·동의까지 다 밟고 마지막에 거절되는 UX 방지).
  // 관리자 QA 계정은 선체크도 생략(구장 밖 테스트 허용). ok 일 때 측정값을 짧은 TTL 안에서만 재사용해
  // 중복 GPS 팝업을 피하되, 만료 시 submit 에서 현재 위치를 재측정한다(삼순 NO-GO #3: stale 재사용 방지).
  const [precheck, setPrecheck] = useState<PrecheckState>({ status: "idle" });
  const [precheckNonce, setPrecheckNonce] = useState(0);
  const precheckPosRef = useRef<{ pos: Position; at: number } | null>(null);
  // submit 시 확정한 위치 — 실패건 개별 재시도에서 재사용(서버가 최종 권위 재검증).
  const submitPosRef = useRef<{ lat: number | null; lng: number | null; accuracy: number | null }>(
    { lat: null, lng: null, accuracy: null },
  );

  // CTA 팀색 — 팀 CSS 변수 직접 사용 없이 공용 teamPalette.accent/onAccent(10팀 WCAG AA).
  // eslint-disable-next-line react-hooks/exhaustive-deps -- isOpen 마다 마이팀 재조회(설정 변경 반영)
  const palette = useMemo(() => paletteForTeamId(getMyTeamId()), [isOpen]);

  // UGC 가이드라인 동의 — 버전별 + **user-scoped** 기억(삼순 09:44 #3: 계정 전환 시 타 계정
  // 동의 상속 금지). userId 미상이면 기억하지 않는다. 서버가 최종 검증하므로 이건 UX 편의용.
  const consentKey = consentStorageKey(VENUE_STORY_CONSENT_VERSION, sessionUserId);
  useEffect(() => {
    if (!isOpen) return;
    let alive = true;
    (async () => {
      const session = await getSafeSession();
      const uid = session?.user?.id ?? null;
      if (!alive) return;
      setSessionUserId(uid);
      const key = consentStorageKey(VENUE_STORY_CONSENT_VERSION, uid);
      try {
        setAgreed(key != null && localStorage.getItem(key) === "1");
      } catch {
        setAgreed(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [isOpen]);

  const toggleAgree = () => {
    setAgreed((prev) => {
      const next = !prev;
      try {
        if (consentKey != null) {
          if (next) localStorage.setItem(consentKey, "1");
          else localStorage.removeItem(consentKey);
        }
      } catch {
        /* noop */
      }
      return next;
    });
  };

  // done(완료 요약)은 닫기 허용 — 진행 중(geo/upload)만 잠근다(orphan 업로드 방지, 삼순 #795).
  const submitting = phase === "geo" || phase === "upload";
  const radiusKm = venue ? Math.round((venue.radiusM / 1000) * 10) / 10 : null;

  // 열릴 때 서버에서 구장/업로드 가능 시간대를 받아온다(서버가 최종 권위, 여기선 UX 게이트용).
  // precheckNonce 도 dep — 구장 정보 확인 실패(venue=null) 시 "다시 확인"이 venue 를 재페치하게(삼순 NO-GO #2).
  useEffect(() => {
    if (!isOpen) return;
    let alive = true;
    setVenueLoading(true);
    setVenue(null);
    (async () => {
      try {
        const res = await fetch(
          `/api/venue-stories/venue?gameId=${encodeURIComponent(gameId)}`,
        );
        const data = (await res.json()) as VenueInfo;
        if (alive) setVenue(data);
      } catch {
        // 무시 — venue=null 유지 → 선체크가 fail-closed(failed)로 닫아 서버 403 전 차단
      } finally {
        if (alive) setVenueLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [isOpen, gameId, precheckNonce]);

  // GPS 선체크: 모달 열림 + 비관리자 + 시간대 정상일 때 위치를 미리 측정한다.
  // 밖이면 파일 선택 UI 대신 안내 카드를 띄우고 제출을 막는다(제출 시 재측정 생략은 ok 값 재사용).
  useEffect(() => {
    if (!isOpen || isAdmin) return;
    // venue 로딩 중엔 "확인 중" 유지
    if (venueLoading) {
      setPrecheck({ status: "measuring" });
      return;
    }
    // 시간대 차단(경기 전/후·취소·미지원 구장)은 그 사유로 막히므로 선체크 불필요(기존 gateReason 노출).
    const blocked =
      !!venue &&
      isVenueUploadBlocked({
        uploadOpen: venue.uploadOpen,
        gateKind: venue.gateKind,
        privileged: isAdmin,
      });
    if (blocked) {
      setPrecheck({ status: "idle" });
      return;
    }
    // 구장 정보 미확보(venue=null / 좌표 null)는 fail-closed — 파일 선택 열지 않고 "다시 시도" 안내(삼순 NO-GO #2).
    if (!venue || venue.lat == null || venue.lng == null) {
      precheckPosRef.current = null;
      setPrecheck({ status: "failed", error: "구장 정보를 확인하지 못했어요. 다시 시도해주세요" });
      return;
    }
    const pv = {
      lat: venue.lat,
      lng: venue.lng,
      radiusM: venue.radiusM,
      stadiumName: venue.stadiumName,
    };
    let alive = true;
    precheckPosRef.current = null;
    setPrecheck({ status: "measuring" });
    (async () => {
      const m = await getVenuePosition();
      if (!alive) return;
      // 서버와 동일 축(evaluateGeofence + VENUE_GEOFENCE_MAX_ACCURACY_M)으로 판정 — 구장 안이지만
      // 저정확도인 측정값을 파일 선택 전 failed 로 보낸다(삼순 NO-GO #1: accuracy 무시 방지).
      const next = classifyPrecheck({
        venue: pv,
        measurement:
          "error" in m ? { error: m.error } : { lat: m.lat, lng: m.lng, accuracy: m.accuracy },
        maxAccuracy: VENUE_GEOFENCE_MAX_ACCURACY_M,
      });
      // ok 일 때만 측정값+시각을 저장 — submit 은 TTL 안에서만 재사용(삼순 NO-GO #3).
      if (next.status === "ok" && !("error" in m)) {
        precheckPosRef.current = { pos: m, at: Date.now() };
      } else {
        precheckPosRef.current = null;
      }
      setPrecheck(next);
    })();
    return () => {
      alive = false;
    };
  }, [isOpen, isAdmin, venue, venueLoading, precheckNonce]);

  const reset = () => {
    processingPickRef.current = false;
    uploadInFlightRef.current = false;
    libraryAutoOpenRef.current = false;
    pickSeqRef.current++;
    // data URL(이미지 프리뷰)은 revoke 불필 — blob(비디오)만 해제
    for (const it of items) {
      if (it.previewUrl?.startsWith("blob:")) URL.revokeObjectURL(it.previewUrl);
    }
    setItems([]);
    setActiveKey(null);
    setCaption("");
    setError(null);
    setPhase("idle");
    setLibraryOpen(false);
    setLibraryAssets([]);
    setLibraryCursor(null);
    setLibraryPermission("prompt");
    setLibraryLoading(false);
    precheckPosRef.current = null;
    submitPosRef.current = { lat: null, lng: null, accuracy: null };
    setPrecheck({ status: "idle" });
  };

  const close = () => {
    // 업로드 진행 중 닫기 금지 — XHR은 계속돼서 orphan 업로드가 남는다(삼순 #795 blocker)
    if (submitting || uploadInFlightRef.current || processingPickRef.current) return;
    reset();
    onClose();
  };

  const loadLibrary = async (append = false) => {
    if (libraryLoading) return;
    const seq = pickSeqRef.current;
    setLibraryLoading(true);
    setError(null);
    try {
      if (!canUseVenueMediaLibrary()) {
        setError("커스텀 사진첩은 최신 설치 앱에서만 사용할 수 있어요");
        return;
      }
      let permission = await getVenueMediaPermission();
      if (seq !== pickSeqRef.current) return;
      if (permission === "prompt") {
        permission = await requestVenueMediaPermission();
      }
      if (seq !== pickSeqRef.current) return;
      setLibraryPermission(permission);
      setLibraryOpen(true);
      if (permission === "denied") return;
      const page = await listVenueMedia(append ? libraryCursor ?? undefined : undefined);
      if (seq !== pickSeqRef.current) return;
      setLibraryPermission(page.permission);
      setLibraryCursor(page.nextCursor);
      setLibraryAssets((prev) => (append ? [...prev, ...page.assets] : page.assets));
    } catch {
      // 브릿지가 아직 없는 구 TestFlight 빌드도 OS 시스템 픽커로 폴백하지 않는다(B안 계약).
      setLibraryOpen(true);
      setError("이 기능을 사용하려면 최신 앱 업데이트가 필요해요");
    } finally {
      setLibraryLoading(false);
    }
  };

  const openPicker = () => {
    if (submitting || phase === "done" || processingPickRef.current) return;
    if (items.length >= VENUE_STORY_MAX_ITEMS) return;
    if (!precheckGateReady({ isAdmin, status: precheck.status })) return;
    void loadLibrary(false);
  };

  const patchItem = (key: string, patch: Partial<ComposerItem>) => {
    setItems((prev) => prev.map((it) => (it.key === key ? { ...it, ...patch } : it)));
  };

  const handlePickedFiles = async (
    files: File[] | null,
    assetIds: ReadonlyArray<string | null> = [],
  ) => {
    if (!files || files.length === 0 || submitting) return;
    processingPickRef.current = true;
    setError(null);
    const seq = pickSeqRef.current;
    try {
      const accepted: ComposerItem[] = [];
      let rejectReason: string | null = null;
      for (const [fileIndex, f] of files.entries()) {
        const isVideo = f.type.startsWith("video/");
        const isImage = f.type.startsWith("image/");
        if (!isVideo && !isImage) {
          rejectReason ??= "이미지 또는 영상만 올릴 수 있어요";
          continue;
        }
        // 제한 초과는 픽 시점에 즉시 차단 — '올리기'까지 가지 않게 (upload.ts 검사는 최종 안전망).
        // 영상은 duration(15초)이 1차 기준 — 유저는 방금 찍은 영상이 몇 MB인지 모른다(하린아빠 7/24).
        // probe 실패(null)는 여기서 차단하지 않고 업로드 단계 검증으로 fail-close(이중 차단 방지).
        const durationMs = isVideo ? await probeVideoDurationMs(f) : null;
        if (seq !== pickSeqRef.current) return; // reset 이 끼어든 late probe — 배치 전체 버림
        const limitError = checkVenueMediaLimits({
          kind: isVideo ? "video" : "image",
          sizeBytes: f.size,
          durationMs,
          // WebCodecs 지원 환경이면 cap 초과 영상을 차단 대신 업로드 단계 압축에 맡긴다
          videoAutoCompressAvailable: isVideo && isVideoCompressSupported(),
        });
        if (limitError) {
          rejectReason ??= limitError;
          continue;
        }
        accepted.push({
          key: pickIdentity(f),
          file: f,
          kind: isVideo ? "video" : "image",
          // 영상: blob 프리뷰. 이미지: 안드 WebView blob 미렌더 회피 → data URL 비동기 채움(#839).
          previewUrl: isVideo ? URL.createObjectURL(f) : null,
          durationMs,
          status: "ready",
          progress: 0,
          stage: "upload",
          failReason: null,
          assetId: assetIds[fileIndex] ?? null,
        });
      }
      if (seq !== pickSeqRef.current) {
        for (const it of accepted) {
          if (it.previewUrl?.startsWith("blob:")) URL.revokeObjectURL(it.previewUrl);
        }
        return;
      }
      // 순서 보존 병합(기존 → 새 항목 append) + 중복/상한 drop — 스트립 순서 1→2→3 계약
      setItems((prev) => {
        const { merged, droppedOverMax } = mergePickedItems(
          prev,
          accepted,
          (it) => it.key,
        );
        // 병합에서 탈락한 새 항목의 blob 은 즉시 회수
        const kept = new Set(merged.map((it) => it.key));
        for (const it of accepted) {
          if (!kept.has(it.key) && it.previewUrl?.startsWith("blob:")) {
            URL.revokeObjectURL(it.previewUrl);
          }
        }
        if (droppedOverMax > 0) setError(VENUE_STORY_OVER_MAX_MSG);
        setActiveKey((cur) => cur ?? merged[0]?.key ?? null);
        return merged;
      });
      if (rejectReason) setError(rejectReason);
      // 이미지 프리뷰(data URL) 비동기 읽기 — 실패한 항목은 제거해 "원본 썸네일 매칭" 계약을 지킨다.
      for (const it of accepted.filter((a) => a.kind === "image")) {
        let dataUrl: string | null = null;
        try {
          dataUrl = await readFileAsDataURL(it.file);
        } catch {
          dataUrl = null;
        }
        if (seq !== pickSeqRef.current) return; // reset 이후 late read — 버림
        if (dataUrl != null) {
          patchItem(it.key, { previewUrl: dataUrl });
        } else {
          setItems((prev) => prev.filter((x) => x.key !== it.key));
          setActiveKey((cur) => (cur === it.key ? null : cur));
          setError("사진을 불러오지 못했어요. 다시 선택해주세요");
        }
      }
    } finally {
      processingPickRef.current = false;
    }
  };

  const selectLibraryAsset = async (asset: VenueMediaAsset) => {
    if (processingPickRef.current || items.length >= VENUE_STORY_MAX_ITEMS) return;
    const selected = items.find((item) => item.assetId === asset.id);
    if (selected) {
      setActiveKey(selected.key);
      setLibraryOpen(false);
      return;
    }
    processingPickRef.current = true;
    const seq = pickSeqRef.current;
    setLibraryLoading(true);
    setError(null);
    try {
      const file = await exportVenueMediaFile(asset.id);
      if (seq !== pickSeqRef.current) return;
      // 그리드 탭 → export 완료 즉시 프리뷰로 전환. 추가 선택은 프리뷰 스트립의 +로 재진입.
      await handlePickedFiles([file], [asset.id]);
      setLibraryOpen(false);
    } catch {
      setError("선택한 사진·영상을 불러오지 못했어요");
    } finally {
      processingPickRef.current = false;
      setLibraryLoading(false);
    }
  };

  const extendLimitedAccess = async () => {
    setLibraryLoading(true);
    setError(null);
    try {
      await presentLimitedVenueMediaPicker();
      await loadLibrary(false);
    } catch {
      setError("사진 접근 범위를 변경하지 못했어요. 기기 설정에서 허용해주세요");
    } finally {
      setLibraryLoading(false);
    }
  };

  // 모달이 열린 동안 body 스크롤 잠금 — 안드로이드에서 모달 안 터치가 배경(body)으로
  // 체이닝돼 배경만 스크롤되고 하단 CTA 버튼에 도달 못하던 문제 방지(하린아빠 A17 리포트).
  useEffect(() => {
    if (!isOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [isOpen]);

  // 트레이 '올리기' 진입 → 위치 선체크 통과 즉시 앱 내 커스텀 사진첩 그리드.
  useEffect(() => {
    if (
      !isOpen ||
      libraryAutoOpenRef.current ||
      items.length > 0 ||
      !precheckGateReady({ isAdmin, status: precheck.status })
    ) {
      return;
    }
    libraryAutoOpenRef.current = true;
    void loadLibrary(false);
    // loadLibrary는 현재 permission/cursor를 읽는 UI action. 자동 진입은 세션당 1회만 필요.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, isAdmin, precheck.status, items.length]);

  /**
   * 항목 순차 업로드 — 기존 단건 파이프라인(prepareVenueStoryMedia → POST /api/venue-stories)을
   * 항목별로 그대로 재사용한다(서버 계약 변경 0). 성공 즉시 onUploaded 로 트레이 낙관 반영,
   * 실패는 사유 1줄을 항목에 기록(완료 요약에서 실패건만 개별 재시도).
   */
  const runUpload = async (
    targets: ReadonlyArray<Pick<ComposerItem, "key" | "file">>,
  ) => {
    const pos = submitPosRef.current;
    for (const target of targets) {
      patchItem(target.key, { status: "uploading", progress: 0, stage: "upload", failReason: null });
      let prepared;
      try {
        prepared = await prepareVenueStoryMedia(target.file, gameId, (r, stage) => {
          patchItem(target.key, { progress: Math.min(0.99, r), ...(stage ? { stage } : {}) });
        });
      } catch {
        prepared = { error: "업로드에 실패했어요" };
      }
      if ("error" in prepared) {
        patchItem(target.key, {
          status: "failed",
          failReason: uploadFailureReason({ kind: "prepare", message: prepared.error }),
        });
        continue;
      }
      const session = await getSafeSession();
      const token = session?.access_token;
      if (!token) {
        patchItem(target.key, {
          status: "failed",
          failReason: uploadFailureReason({ kind: "server", message: "로그인이 필요해요" }),
        });
        continue;
      }
      try {
        const res = await fetch("/api/venue-stories", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            gameId,
            mediaType: prepared.mediaType,
            mediaUrl: prepared.mediaUrl,
            mediaPath: prepared.mediaPath, // 영상: private staging 경로(서버 즉시 검증 후 공개 승격)
            thumbUrl: prepared.thumbUrl,
            durationMs: prepared.durationMs,
            width: prepared.width,
            height: prepared.height,
            caption: caption.trim() || null,
            lat: pos.lat,
            lng: pos.lng,
            accuracy: pos.accuracy,
            consentVersion: VENUE_STORY_CONSENT_VERSION,
          }),
        });
        const data = await res.json();
        if (data.error) {
          patchItem(target.key, {
            status: "failed",
            failReason: uploadFailureReason({ kind: "server", message: data.error }),
          });
          continue;
        }
        patchItem(target.key, { status: "done", progress: 1 });
        // 항목 성공 즉시 트레이 낙관 반영(영상 pending 처리중 카드 포함 — 기존 단건 계약 유지)
        onUploaded({
          id: typeof data.id === "number" ? data.id : null,
          mediaType: prepared.mediaType,
          status: data.status ?? null,
          thumbUrl: prepared.thumbUrl,
        });
      } catch {
        patchItem(target.key, {
          status: "failed",
          failReason: uploadFailureReason({ kind: "network" }),
        });
      }
    }
  };

  const submit = async () => {
    if (items.length === 0 || submitting || uploadInFlightRef.current || phase === "done") return;
    setError(null);

    // UGC 가이드라인 동의 필수(업로드 시점 게이트)
    if (!agreed) {
      setError("업로드 가이드라인에 동의해주세요");
      return;
    }

    // 업로드 가능 시간대 아님(경기 전/후, 취소, 미지원 구장) — 서버 사유 그대로 노출.
    // 관리자 QA는 시간창 마감(종료/시작전)만 우회 — 렌더 gateReason과 동일 조건(uploadBlocked).
    // **취소 경기는 관리자도 여기서 차단** → media prepare 전에 막아 고아 객체 생성 방지(삼순 #832 왕복2).
    if (uploadBlocked) {
      setError(venue?.reason ?? "지금은 올릴 수 없어요");
      return;
    }

    // 일반 유저는 위치 필수. 관리자 WIP QA 계정은 구장 밖 테스트를 위해 GPS 수집부터 생략.
    let pos: { lat: number | null; lng: number | null; accuracy: number | null } = {
      lat: null,
      lng: null,
      accuracy: null,
    };
    if (!isAdmin) {
      // 선체크 ok 측정값은 짧은 TTL 안에서만 재사용(중복 GPS 팝업 회피). 모달을 열고 이동해
      // 측정값이 만료됐거나 없으면 현재 위치를 재측정한다(삼순 NO-GO #3: stale 재사용 방지).
      const cached = precheckPosRef.current;
      let measured: Position | null =
        cached && isPrecheckReusable(cached.at, Date.now(), VENUE_PRECHECK_REUSE_TTL_MS)
          ? cached.pos
          : null;
      if (!measured) {
        setPhase("geo");
        const m = await getVenuePosition();
        if ("error" in m) {
          setError(m.error);
          setPhase("idle");
          return;
        }
        measured = m;
      }
      pos = measured;
      // 최종 재검증 — 서버와 동일 축(evaluateGeofence: accuracy + 반경). 구장 정보/좌표 없으면
      // coord=null 로 fail-closed(삼순 NO-GO #1·#2 일관). fresh·stale 모두 이 게이트를 통과해야 업로드.
      const geo = evaluateGeofence({
        lat: measured.lat,
        lng: measured.lng,
        accuracy: measured.accuracy,
        coord:
          venue && venue.lat != null && venue.lng != null
            ? { lat: venue.lat, lng: venue.lng, radiusM: venue.radiusM, name: venue.stadiumName ?? "경기장" }
            : null,
        maxAccuracy: VENUE_GEOFENCE_MAX_ACCURACY_M,
      });
      if (!geo.ok) {
        setError(geo.reason ?? "직관 인증에 실패했어요. 야외에서 다시 시도해주세요");
        setPhase("idle");
        return;
      }
    }
    // 실패건 개별 재시도가 같은 인증 위치를 재사용(서버가 최종 권위 재검증)
    submitPosRef.current = pos;

    uploadInFlightRef.current = true;
    setPhase("upload");
    try {
      await runUpload(items.map((it) => ({ key: it.key, file: it.file })));
      // 성공/실패와 무관하게 완료 요약으로 전환 — 항목별 결과·실패 사유·개별 재시도 제공(스펙 5)
      setPhase("done");
    } finally {
      uploadInFlightRef.current = false;
    }
  };

  /** 완료 요약에서 실패건 1건 재시도 — 성공/진행 중 항목은 재전송하지 않는다. */
  const retryItem = async (key: string) => {
    const target = items.find((it) => it.key === key);
    if (!target || uploadInFlightRef.current || !isRetryableItem(target.status)) return;
    uploadInFlightRef.current = true;
    try {
      await runUpload([{ key: target.key, file: target.file }]);
    } finally {
      uploadInFlightRef.current = false;
    }
  };

  if (!isOpen || typeof document === "undefined") return null;

  // 관리자 QA 모드는 시간창(시작 전·종료 후)만 우회한다. **취소 경기는 관리자도 차단**
  // (삼순 #832 왕복2: 클라도 media prepare 전 차단해 고아 객체/불필요 전송 방지, 서버 403과 E2E 정합).
  // 일반 유저는 그대로 마감 사유로 버튼 비활성. 서버도 동일 축(qaWindowBypass = qaBypass && !cancelled).
  const uploadBlocked =
    !!venue &&
    isVenueUploadBlocked({
      uploadOpen: venue.uploadOpen,
      gateKind: venue.gateKind,
      privileged: isAdmin,
    });
  const gateReason = uploadBlocked ? venue?.reason ?? null : null;

  // GPS 선체크(관리자 제외) 결과로 파일 선택 UI 대체/제출 게이트. 시간대 차단(gateReason) 시엔
  // 선체크 자체가 안 돌아 idle 이므로 그 사유만 노출(기존 동작 유지).
  const showPrecheckCard =
    phase === "idle" &&
    !isAdmin &&
    !gateReason &&
    !precheckGateReady({ isAdmin, status: precheck.status });
  const precheckDistKm =
    precheck.distanceM != null ? Math.max(0.1, Math.round(precheck.distanceM / 100) / 10) : null;

  const activeItem = items.find((it) => it.key === activeKey) ?? items[0] ?? null;
  const activeBadge = activeItem
    ? mediaDurationBadge(activeItem.kind, activeItem.durationMs)
    : null;
  const statuses = items.map((it) => it.status);
  const uploadingItem = items.find((it) => it.status === "uploading") ?? null;
  const overallProgress = overallUploadProgress(statuses, uploadingItem?.progress ?? 0);
  const settledCount = statuses.filter((s) => s === "done" || s === "failed").length;
  const outcome = summarizeUploadOutcome(statuses);
  const retryInFlight = phase === "done" && uploadingItem != null;

  const ctaLabel =
    phase === "geo"
      ? "직관 인증 중…"
      : phase === "upload"
        ? uploadingItem?.stage === "compress"
          ? `영상 최적화 중… ${overallProgress}%`
          : `올리는 중… ${Math.min(settledCount + 1, items.length)}/${items.length} · ${overallProgress}%`
        : phase === "done"
          ? "닫기"
          : VENUE_STORY_CTA_LABEL;
  const ctaDisabled =
    phase === "done"
      ? retryInFlight
      : !venueStorySubmitReady({
          hasFile: items.length > 0,
          submitting,
          gateBlocked: !!gateReason,
          agreed,
          precheckReady: precheckGateReady({ isAdmin, status: precheck.status }),
        });

  return createPortal(
    <AnimatePresence>
      <motion.div
        className="fixed inset-0 z-[55] flex items-end"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
      >
        <div className="absolute inset-0 bg-black/60" onClick={close} />
        <motion.div
          className="relative w-full max-w-lg mx-auto bg-bg-secondary rounded-t-3xl max-h-[90dvh] overflow-hidden flex flex-col"
          initial={{ y: "100%" }}
          animate={{ y: 0 }}
          exit={{ y: "100%" }}
          transition={{ type: "spring", damping: 26 }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* 헤더 — 닫기만. 상단 공유 버튼 없음(하단 sticky CTA 1개 계약) */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-border">
            <span className="text-base font-semibold text-text-primary">
              {phase === "done" ? "업로드 완료" : libraryOpen ? "최근 항목" : "직관 라이브 올리기"}
            </span>
            <button
              onClick={close}
              disabled={submitting}
              aria-label="닫기"
              className="text-text-tertiary disabled:opacity-40"
            >
              <X size={22} />
            </button>
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain p-4 flex flex-col gap-3">
            {phase === "done" ? (
              <>
                {/* 완료 요약 — 항목별 원본 썸네일 매칭 성공/실패 + 실패 사유 1줄 + 실패건만 개별 재시도 */}
                <div className="text-lg font-bold text-text-primary">
                  <span className="text-green-400">성공 {outcome.success}</span>
                  <span className="text-text-tertiary"> · </span>
                  <span className="text-red-400">실패 {outcome.failed}</span>
                </div>
                <div className="flex flex-col gap-2">
                  {items.map((it) => {
                    const badge = mediaDurationBadge(it.kind, it.durationMs);
                    return (
                      <div
                        key={it.key}
                        className="flex items-center gap-3 rounded-xl border border-border bg-bg-tertiary/40 p-2.5"
                      >
                        <div className="relative w-[42px] h-[42px] shrink-0">
                          <div
                            className={`w-full h-full rounded-lg overflow-hidden bg-black ${
                              it.status === "failed" ? "opacity-50 grayscale" : ""
                            }`}
                          >
                            {it.previewUrl ? (
                              it.kind === "video" ? (
                                <video
                                  src={it.previewUrl}
                                  className="w-full h-full object-cover"
                                  muted
                                  playsInline
                                  preload="metadata"
                                />
                              ) : (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img src={it.previewUrl} alt="" className="w-full h-full object-cover" />
                              )
                            ) : (
                              <div className="w-full h-full flex items-center justify-center text-text-tertiary">
                                <VideoIcon size={16} />
                              </div>
                            )}
                          </div>
                          {it.kind === "video" && (
                            <Play
                              size={11}
                              className="absolute bottom-1 left-1 text-white fill-white drop-shadow"
                            />
                          )}
                          {badge && (
                            <span className="absolute top-0.5 right-0.5 px-1 rounded bg-black/60 text-white text-[8px] font-semibold leading-[13px]">
                              {badge}
                            </span>
                          )}
                          <span
                            className={`absolute -bottom-1 -right-1 w-[18px] h-[18px] rounded-full border-2 border-bg-secondary flex items-center justify-center text-[10px] font-bold ${
                              it.status === "done"
                                ? "bg-green-500 text-black"
                                : it.status === "failed"
                                  ? "bg-red-500 text-white"
                                  : "bg-bg-tertiary text-text-secondary"
                            }`}
                          >
                            {it.status === "done" ? "✓" : it.status === "failed" ? "!" : "…"}
                          </span>
                        </div>
                        <div className="flex flex-col gap-0.5 min-w-0">
                          <span className="text-sm font-semibold text-text-primary">
                            {it.status === "uploading"
                              ? `올리는 중… ${Math.round(it.progress * 100)}%`
                              : it.status === "done"
                                ? `완료${it.kind === "video" ? " · 영상" : ""}`
                                : `실패${it.kind === "video" ? " · 영상" : ""}`}
                          </span>
                          {it.status === "failed" && it.failReason && (
                            <span className="text-[11px] text-text-tertiary truncate">{it.failReason}</span>
                          )}
                        </div>
                        {it.status === "failed" && (
                          <button
                            onClick={() => retryItem(it.key)}
                            disabled={retryInFlight}
                            className="ml-auto shrink-0 h-8 px-3.5 rounded-lg text-xs font-semibold disabled:opacity-40"
                            style={{ background: palette.accent, color: palette.onAccent }}
                          >
                            다시 시도
                          </button>
                        )}
                        {it.status === "uploading" && (
                          <Loader2 size={16} className="ml-auto shrink-0 animate-spin text-text-tertiary" />
                        )}
                      </div>
                    );
                  })}
                </div>
              </>
            ) : libraryOpen ? (
              <>
                {libraryPermission === "limited" && (
                  <div className="flex items-center justify-between gap-3 rounded-xl bg-bg-tertiary/60 px-3 py-2.5">
                    <span className="text-xs text-text-secondary">
                      선택한 사진만 보여요
                    </span>
                    <button
                      onClick={extendLimitedAccess}
                      disabled={libraryLoading}
                      className="shrink-0 rounded-lg px-3 py-1.5 text-xs font-semibold disabled:opacity-40"
                      style={{ background: palette.accent, color: palette.onAccent }}
                    >
                      더 보기
                    </button>
                  </div>
                )}

                {libraryPermission === "denied" ? (
                  <div className="flex flex-col items-center justify-center gap-3 min-h-64 rounded-2xl border border-border bg-bg-tertiary/40 px-6 text-center">
                    <Settings size={28} className="text-text-tertiary" />
                    <div className="flex flex-col gap-1">
                      <span className="text-sm font-semibold text-text-primary">
                        사진 접근이 꺼져 있어요
                      </span>
                      <span className="text-xs text-text-tertiary">
                        기기 설정에서 사진·영상 접근을 허용해주세요
                      </span>
                    </div>
                    <button
                      onClick={() => void openVenueMediaSettings()}
                      className="rounded-xl px-4 py-2 text-sm font-semibold"
                      style={{ background: palette.accent, color: palette.onAccent }}
                    >
                      설정 열기
                    </button>
                  </div>
                ) : libraryAssets.length > 0 ? (
                  <>
                    {/* 앱 내 커스텀 그리드 — 최근순 사진+영상. 탭 즉시 export 후 프리뷰 전환. */}
                    <div className="grid grid-cols-3 gap-0.5">
                      {libraryAssets.map((asset) => {
                        const selectedIndex = items.findIndex((item) => item.assetId === asset.id);
                        const badge = mediaDurationBadge(asset.kind, asset.durationMs);
                        return (
                          <button
                            key={asset.id}
                            onClick={() => void selectLibraryAsset(asset)}
                            disabled={
                              libraryLoading ||
                              (selectedIndex < 0 && items.length >= VENUE_STORY_MAX_ITEMS)
                            }
                            className="relative aspect-square overflow-hidden bg-bg-tertiary disabled:opacity-40"
                          >
                            {/* 네이티브가 내려준 작은 썸네일만 그리드에 사용(원본 export는 탭 후). */}
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                              src={asset.thumbnailUrl}
                              alt=""
                              className="w-full h-full object-cover"
                            />
                            {selectedIndex >= 0 ? (
                              <span
                                className="absolute top-1.5 right-1.5 w-5 h-5 rounded-full border border-white flex items-center justify-center text-[11px] font-bold"
                                style={{ background: palette.accent, color: palette.onAccent }}
                              >
                                {selectedIndex + 1}
                              </span>
                            ) : (
                              <span className="absolute top-1.5 right-1.5 w-5 h-5 rounded-full border border-white/90 bg-black/20" />
                            )}
                            {asset.kind === "video" && (
                              <Play
                                size={13}
                                className="absolute bottom-1.5 left-1.5 text-white fill-white drop-shadow"
                              />
                            )}
                            {badge && (
                              <span className="absolute bottom-1.5 right-1.5 px-1.5 rounded-md bg-black/60 text-white text-[9px] font-semibold leading-4">
                                {badge}
                              </span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                    {libraryCursor && (
                      <button
                        onClick={() => void loadLibrary(true)}
                        disabled={libraryLoading}
                        className="w-full rounded-xl border border-border py-2.5 text-sm text-text-secondary disabled:opacity-40"
                      >
                        더 불러오기
                      </button>
                    )}
                  </>
                ) : (
                  <div className="flex min-h-64 items-center justify-center rounded-2xl bg-bg-tertiary/30">
                    {libraryLoading ? (
                      <Loader2 size={24} className="animate-spin text-text-tertiary" />
                    ) : (
                      <span className="text-sm text-text-tertiary">
                        표시할 사진·영상이 없어요
                      </span>
                    )}
                  </div>
                )}

                {error && <p className="text-sm text-red-400">{error}</p>}
              </>
            ) : (
              <>
                <div className="flex items-center gap-1.5 text-[12px] text-text-tertiary bg-bg-tertiary/50 rounded-lg px-3 py-2">
                  <MapPin size={13} className="text-red-400 shrink-0" />
                  <span>
                    {isAdmin
                      ? "관리자 QA 모드 · 위치 인증 없이 업로드할 수 있어요"
                      : venueLoading
                      ? "구장 정보 확인 중…"
                      : gateReason
                        ? gateReason
                        : `${venue?.stadiumName ?? "경기장"}${radiusKm ? ` 반경 ${radiusKm}km` : ""} 안(직관 중)에서만 올릴 수 있어요`}
                  </span>
                </div>

                {showPrecheckCard ? (
                  <div className="flex flex-col items-center justify-center gap-3 h-48 rounded-2xl border border-border bg-bg-tertiary/40 px-5 text-center">
                    {precheck.status === "idle" || precheck.status === "measuring" ? (
                      <>
                        <Loader2 size={26} className="animate-spin text-text-tertiary" />
                        <span className="text-sm text-text-secondary">위치 확인 중… 잠시만요</span>
                      </>
                    ) : (
                      <>
                        <MapPin size={26} className="text-red-400" />
                        {precheck.status === "out" ? (
                          <div className="flex flex-col gap-1">
                            <span className="text-sm font-medium text-text-primary">
                              {venue?.stadiumName ?? "경기장"}{radiusKm ? ` 반경 ${radiusKm}km` : ""} 밖이에요
                            </span>
                            <span className="text-[12px] text-text-tertiary">
                              {precheckDistKm != null ? `지금은 약 ${precheckDistKm}km 떨어져 있어요. ` : ""}직관 중에 경기장 안에서 올릴 수 있어요
                            </span>
                          </div>
                        ) : (
                          <div className="flex flex-col gap-1">
                            <span className="text-sm font-medium text-text-primary">위치를 확인할 수 없어요</span>
                            <span className="text-[12px] text-text-tertiary">
                              {precheck.error ?? "위치 권한을 허용하고 다시 시도해주세요"}
                            </span>
                          </div>
                        )}
                        <button
                          onClick={() => setPrecheckNonce((n) => n + 1)}
                          className="mt-1 text-xs bg-bg-secondary border border-border text-text-secondary px-4 py-1.5 rounded-full active:bg-bg-tertiary"
                        >
                          다시 확인
                        </button>
                      </>
                    )}
                  </div>
                ) : items.length === 0 ? (
                  <button
                    onClick={openPicker}
                    disabled={submitting || !precheckGateReady({ isAdmin, status: precheck.status })}
                    className="flex flex-col items-center justify-center gap-2 h-48 rounded-2xl border-2 border-dashed border-border text-text-tertiary active:bg-bg-tertiary disabled:opacity-40"
                  >
                    <VideoIcon size={28} />
                    <span className="text-sm">현장 사진·영상 선택 (최대 {VENUE_STORY_MAX_ITEMS}개)</span>
                    <span className="text-[11px] text-text-tertiary/70">영상은 15초 이하 · 세로 추천</span>
                    <span className="text-[11px] text-text-tertiary/60">
                      앱 안에서 최근 사진첩을 열어요
                    </span>
                  </button>
                ) : (
                  <>
                    {/* 선택 → 즉시 프리뷰: 첫 항목(또는 탭한 항목) 큰 프리뷰 */}
                    <div className="relative rounded-2xl overflow-hidden bg-black aspect-[9/16] max-h-[42dvh] flex items-center justify-center">
                      {activeItem?.kind === "video" ? (
                        <video
                          key={activeItem.key}
                          src={activeItem.previewUrl ?? undefined}
                          className="w-full h-full object-contain"
                          controls
                          playsInline
                          muted
                        />
                      ) : activeItem?.previewUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={activeItem.previewUrl} alt="" className="w-full h-full object-contain" />
                      ) : (
                        <Loader2 size={22} className="animate-spin text-text-tertiary" />
                      )}
                      {/* 미디어 타입 정합: 길이 배지는 영상에만(0:12), 사진엔 금지 */}
                      {activeBadge && (
                        <span className="absolute bottom-2 right-2 px-2 py-0.5 rounded-lg bg-black/60 text-white text-[11px] font-semibold">
                          {activeBadge}
                        </span>
                      )}
                    </div>
                    {/* 선택 스트립 — 선택 순서 1→2→3 배지 + 영상 재생 아이콘/길이 배지 */}
                    <div className="flex gap-2">
                      {items.map((it, idx) => {
                        const badge = mediaDurationBadge(it.kind, it.durationMs);
                        const isActive = activeItem?.key === it.key;
                        return (
                          <button
                            key={it.key}
                            onClick={() => setActiveKey(it.key)}
                            disabled={submitting}
                            className="relative w-14 h-14 rounded-lg overflow-hidden bg-bg-tertiary shrink-0 disabled:opacity-40"
                            style={
                              isActive
                                ? { boxShadow: `inset 0 0 0 2px ${palette.accent}` }
                                : undefined
                            }
                          >
                            {it.previewUrl ? (
                              it.kind === "video" ? (
                                <video
                                  src={it.previewUrl}
                                  className="w-full h-full object-cover"
                                  muted
                                  playsInline
                                  preload="metadata"
                                />
                              ) : (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img src={it.previewUrl} alt="" className="w-full h-full object-cover" />
                              )
                            ) : (
                              <div className="w-full h-full flex items-center justify-center">
                                <Loader2 size={14} className="animate-spin text-text-tertiary" />
                              </div>
                            )}
                            <span
                              className="absolute top-1 right-1 w-[18px] h-[18px] rounded-full border border-white/90 flex items-center justify-center text-[10px] font-bold"
                              style={{ background: palette.accent, color: palette.onAccent }}
                            >
                              {idx + 1}
                            </span>
                            {it.kind === "video" && (
                              <Play
                                size={11}
                                className="absolute bottom-1 left-1 text-white fill-white drop-shadow"
                              />
                            )}
                            {badge && (
                              <span className="absolute bottom-1 right-1 px-1 rounded bg-black/60 text-white text-[8px] font-semibold leading-[13px]">
                                {badge}
                              </span>
                            )}
                          </button>
                        );
                      })}
                      {items.length < VENUE_STORY_MAX_ITEMS && (
                        <button
                          onClick={openPicker}
                          disabled={submitting || !precheckGateReady({ isAdmin, status: precheck.status })}
                          aria-label="더 추가"
                          className="w-14 h-14 rounded-lg bg-bg-tertiary text-text-tertiary text-xl font-light flex items-center justify-center active:bg-bg-primary disabled:opacity-40 shrink-0"
                        >
                          +
                        </button>
                      )}
                    </div>
                  </>
                )}

                <input
                  type="text"
                  value={caption}
                  onChange={(e) => setCaption(e.target.value)}
                  maxLength={200}
                  disabled={submitting}
                  placeholder="한 줄 코멘트 (선택)"
                  className="w-full px-3 py-2.5 rounded-xl bg-bg-tertiary text-sm text-text-primary placeholder:text-text-tertiary outline-none disabled:opacity-40"
                />
              </>
            )}
          </div>

          {!libraryOpen && (
            <div
              className="shrink-0 border-t border-border p-4 flex flex-col gap-3"
              style={{ paddingBottom: "max(env(safe-area-inset-bottom), 12px)" }}
            >
            {phase !== "done" && (
              <label className="flex items-start gap-2 text-[11px] text-text-tertiary leading-relaxed cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={agreed}
                  onChange={toggleAgree}
                  disabled={submitting}
                  className="mt-0.5 accent-brand-primary shrink-0 disabled:opacity-40"
                />
                <span>
                  중계화면 무단 재촬영·타인 얼굴/초상권 침해·욕설/폭력·불법 촬영물을 올리지 않겠습니다.
                  위반 콘텐츠는 신고·삭제될 수 있어요. <b className="text-text-secondary">가이드라인에 동의합니다.</b>
                </span>
              </label>
            )}

            {error && phase !== "done" && <p className="text-sm text-red-400">{error}</p>}

            {phase === "upload" && (
              <div className="w-full h-1.5 rounded-full bg-bg-tertiary overflow-hidden">
                <div
                  className="h-full rounded-full transition-[width] duration-200 ease-out"
                  style={{ width: `${overallProgress}%`, background: palette.accent }}
                />
              </div>
            )}

            {/* 하단 sticky CTA 1개 — rounded-xl · py-3.5 · safe-area(bottom).
                팀색은 공용 teamPalette.accent/onAccent(10팀 WCAG AA)만 사용 */}
            <button
              onClick={phase === "done" ? close : submit}
              disabled={ctaDisabled}
              className="w-full py-3.5 rounded-xl font-semibold flex items-center justify-center gap-2 disabled:opacity-40"
              style={{ background: palette.accent, color: palette.onAccent }}
            >
              {submitting ? <Loader2 size={18} className="animate-spin" /> : null}
              {ctaLabel}
            </button>
            </div>
          )}
        </motion.div>
      </motion.div>
    </AnimatePresence>,
    document.body,
  );
}
