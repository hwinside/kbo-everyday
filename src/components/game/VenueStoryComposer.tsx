"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import {
  X,
  Loader2,
  Video as VideoIcon,
  MapPin,
  Play,
  Settings,
  Trash2,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
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
  resolveVenuePickerMode,
  toggleAssetSelection,
  previewMediaMode,
  shouldRefreshLibraryOnResume,
  VENUE_LIBRARY_FIRST_PAGE_SIZE,
  VENUE_LIBRARY_PAGE_SIZE,
  VENUE_LIBRARY_FILTERS,
  filterLibraryAssets,
  libraryEmptyMessage,
  shouldAutoLoadMoreForFilter,
  type VenueLibraryFilter,
} from "@/lib/venue-stories/multi-pick";
import {
  runVenueUploadQueue,
  type VenueUploadTarget,
} from "@/lib/venue-stories/venue-upload-queue";
import { VenueLibraryGrid } from "@/components/game/VenueLibraryGrid";
import { readFileAsDataURL } from "@/lib/venue-stories/read-file";
import { getMyTeamId } from "@/lib/store/myteam";
import { teamPalette } from "@/design-v2/team-palette";
import { TEAMS } from "@/design-v2/TEAMS";
import { useIsAdmin } from "@/hooks/useIsAdmin";
import {
  canUseVenueMediaLibrary,
  exportVenueMediaFile,
  getVenueMediaPermission,
  isVenueMediaLibraryAvailable,
  listVenueMedia,
  openVenueMediaSettings,
  presentLimitedVenueMediaPicker,
  requestVenueMediaPermission,
  venueMediaSelectionHaptic,
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

/** 멀티픽 항목 — 원본 File + 프리뷰/진행/결과. key 는 pickIdentity(파일 픽) 또는 asset:{id}(그리드 픽). */
interface ComposerItem {
  key: string;
  /** 원본 파일 — 그리드 픽은 백그라운드 export 완료 전까지 null(썸네일 프리뷰로 먼저 열고 업로드가 await). */
  file: File | null;
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

/** 그리드 픽 항목 key — 원본 File 도착 전에도 안정적이도록 asset id 기반. */
const assetItemKey = (assetId: string) => `asset:${assetId}`;


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
  // 미디어 타입 토글 — 네이티브 열거는 사진+영상을 섞어 내려주므로 화면단에서 걸러 보여준다.
  const [libraryFilter, setLibraryFilter] = useState<VenueLibraryFilter>("all");
  // 비동기 열거 응답이 도착했을 때 '지금 어느 탭인가'를 읽기 위한 동기 미러 — setState 반영
  // 전 구간에 탭이 바뀜을 때 stale 페이지가 다른 탭 목록을 오염시키는 걸 막는다.
  const libraryFilterRef = useRef<VenueLibraryFilter>("all");
  // React state 반영 전에도 중복 네이티브 열거를 막는 동기 guard. 로딩 중 새 필터 요청은
  // 버리지 않고 pendingReload 로 합쳐 현재 요청이 끝나는 즉시 **최신 필터**를 다시 읽는다.
  const libraryLoadingRef = useRef(false);
  const libraryPendingReloadRef = useRef(false);
  // 필터 A→B→A처럼 최종 필터 문자열이 다시 같아져도 첫 A의 늦은 응답을 받지 않도록
  // 모든 조회 의도에 generation을 부여한다(필터 ref 동일성만으로는 막을 수 없는 ABA race).
  const libraryRequestGenerationRef = useRef(0);
  // reset→재오픈 뒤 이전 요청의 늦은 finally가 새 요청 loading/pending을 풀지 못하게
  // 실제 실행 중인 request generation도 별도로 보관한다.
  const libraryActiveRequestRef = useRef(0);
  // 필터 탭 자동 추가 로드 횟수(bounded) — 탭 전환/재조회 시 초기화.
  const libraryAutoPagesRef = useRef(0);
  // 그리드 한 화면 멀티셀렉트 — 탭 토글로 순서 유지, 하단 '선택 완료'는 즉시 닫힌다(삼순 라운드2 #2).
  const [librarySelection, setLibrarySelection] = useState<VenueMediaAsset[]>([]);
  // version gate — 네이티브 브릿지 가용이면 grid, 아니면 기존 file input 폴백(구설치본/웹).
  const [pickerMode, setPickerMode] = useState<"grid" | "fileInput" | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
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
  // onAccent 공용 helper(paletteForTeamId/onAccentColor) 신설은 별도 PR 분리 합의 —
  // 여기선 기존 teamPalette + TEAMS 로만 조회한다(삼순 NO-GO 라운드1 #5).
  const palette = useMemo(() => {
    const teamId = getMyTeamId();
    const team =
      teamId != null ? Object.values(TEAMS).find((t) => t.id === teamId) : undefined;
    return teamPalette(team ?? TEAMS.neutral);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- isOpen 마다 마이팀 재조회(설정 변경 반영)
  }, [isOpen]);

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
    libraryPendingReloadRef.current = false;
    libraryRequestGenerationRef.current++;
    libraryActiveRequestRef.current = 0;
    libraryLoadingRef.current = false;
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
    setLibrarySelection([]);
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

  // version gate — 열릴 때마다 네이티브 브릿지 가용성을 런타임 감지해 픽커 모드를 확정한다.
  // 플러그인 없는 구설치본(원격 WebView 만 최신)·웹은 기존 file input 동선 그대로 유지.
  useEffect(() => {
    if (!isOpen) {
      setPickerMode(null);
      return;
    }
    let alive = true;
    (async () => {
      const nativeRuntime = canUseVenueMediaLibrary();
      const pluginAvailable = nativeRuntime && (await isVenueMediaLibraryAvailable());
      if (alive) setPickerMode(resolveVenuePickerMode({ nativeRuntime, pluginAvailable }));
    })();
    return () => {
      alive = false;
    };
  }, [isOpen]);

  const loadLibrary = async (append = false) => {
    if (libraryLoadingRef.current) {
      if (!append) {
        // 로딩 중 필터/권한 재조회는 마지막 요청 하나로 합친다. generation을 즉시 올려
        // 현재 응답을 무효화하고, finally에서 최신 libraryFilterRef로 재조회한다.
        libraryPendingReloadRef.current = true;
        libraryRequestGenerationRef.current++;
      }
      return;
    }
    libraryLoadingRef.current = true;
    const requestGeneration = ++libraryRequestGenerationRef.current;
    libraryActiveRequestRef.current = requestGeneration;
    const seq = pickSeqRef.current;
    setLibraryLoading(true);
    setError(null);
    try {
      let permission = await getVenueMediaPermission();
      if (seq !== pickSeqRef.current) return;
      if (permission === "prompt") {
        permission = await requestVenueMediaPermission();
      }
      if (seq !== pickSeqRef.current) return;
      setLibraryPermission(permission);
      if (!append && !libraryOpen) {
        // 그리드 첫 진입 시만 이미 담긴 항목을 선택 상태로 복원 — 이미 열려 있는 상태의
        // 재조회(앱 복귀/Limited 변경)는 진행 중이던 선택을 보존한다(삼순 라운드2 #1).
        setLibrarySelection(
          items
            .filter((it) => it.assetId != null)
            .map((it) => ({
              id: it.assetId as string,
              kind: it.kind,
              thumbnailUrl: "",
              durationMs: it.durationMs,
              createdAt: 0,
            })),
        );
      }
      setLibraryOpen(true);
      if (permission === "denied") return;
      // 첫 페이지는 소량(24)만 읽어 그리드를 빨리 연다 — 네이티브가 썸네일을 직렬 생성하므로
      // 한 번에 60개를 기다리면 웜 진입 P95 0.5초와 충돌한다(삼순 라운드2 #3).
      // 미디어 타입은 **네이티브 쿼리 단계에서** 걸러다달라고 전달한다 — cursor 도 같은
      // 타입 안에서만 진행하므로 '영상만' 탭에서 첫 페이지부터 영상으로 채워진다.
      // 구설치본은 이 인자를 무시하고 혼합 목록을 내려주므로(원격 WebView 라 웹만 먼저
      // 배포될 수 있다) 화면단 filterLibraryAssets 를 fail-safe 로 그대로 유지한다.
      const requestedTypes = libraryFilterRef.current;
      const page = await listVenueMedia(
        append ? libraryCursor ?? undefined : undefined,
        append ? VENUE_LIBRARY_PAGE_SIZE : VENUE_LIBRARY_FIRST_PAGE_SIZE,
        requestedTypes === "all" ? undefined : [requestedTypes],
      );
      if (seq !== pickSeqRef.current) return;
      if (requestGeneration !== libraryRequestGenerationRef.current) return;
      // 응답 대기 중 탭이 바뀌었으면 이 페이지는 다른 타입의 결과다 — 버린다(탭 간 오염 방지).
      if (libraryFilterRef.current !== requestedTypes) return;
      setLibraryPermission(page.permission);
      setLibraryCursor(page.nextCursor);
      setLibraryAssets((prev) => (append ? [...prev, ...page.assets] : page.assets));
      // 필터 탭 자동 추가 로드 횟수 — append 만 증가, 새 조회는 리셋(bounded 재시작).
      libraryAutoPagesRef.current = append ? libraryAutoPagesRef.current + 1 : 0;
    } catch {
      // 필터 전환/reset으로 이미 무효화된 과거 요청의 실패가 최신 그리드를 file input으로
      // 강등시키지 않게 한다. 현재 generation을 소유한 실제 브릿지 실패만 폴백한다.
      if (
        seq !== pickSeqRef.current ||
        requestGeneration !== libraryRequestGenerationRef.current
      ) {
        return;
      }
      // 브릿지 호출 자체가 실패(구설치본 등) — 기존 file input 동선으로 폴백해 업로드가 끊기지 않게.
      setLibraryOpen(false);
      setPickerMode("fileInput");
    } finally {
      // reset 또는 새 요청이 이 요청을 대체했으면 최신 loading/pending 상태를 건드리지 않는다.
      if (libraryActiveRequestRef.current !== requestGeneration) return;
      libraryActiveRequestRef.current = 0;
      libraryLoadingRef.current = false;
      setLibraryLoading(false);
      if (libraryPendingReloadRef.current) {
        libraryPendingReloadRef.current = false;
        void loadLibrary(false);
      }
    }
  };

  const openPicker = () => {
    if (submitting || phase === "done" || processingPickRef.current) return;
    if (items.length >= VENUE_STORY_MAX_ITEMS) return;
    if (!precheckGateReady({ isAdmin, status: precheck.status })) return;
    if (pickerMode === "grid") {
      void loadLibrary(false);
    } else {
      // 폴백: 기존(현행) OS 파일 선택 동선 — 구설치본/웹도 업로드 가능(version gate).
      fileInputRef.current?.click();
    }
  };

  const patchItem = (key: string, patch: Partial<ComposerItem>) => {
    setItems((prev) => prev.map((it) => (it.key === key ? { ...it, ...patch } : it)));
  };

  const removeItem = (key: string) => {
    setItems((prev) => {
      const removedIndex = prev.findIndex((item) => item.key === key);
      if (removedIndex < 0) return prev;
      const removed = prev[removedIndex];
      if (removed.previewUrl?.startsWith("blob:")) URL.revokeObjectURL(removed.previewUrl);
      const next = prev.filter((item) => item.key !== key);
      setActiveKey((current) =>
        current === key
          ? (next[Math.min(removedIndex, Math.max(0, next.length - 1))]?.key ?? null)
          : current,
      );
      return next;
    });
    void venueMediaSelectionHaptic();
  };

  const moveItem = (key: string, delta: -1 | 1) => {
    setItems((prev) => {
      const from = prev.findIndex((item) => item.key === key);
      const to = from + delta;
      if (from < 0 || to < 0 || to >= prev.length) return prev;
      const next = [...prev];
      [next[from], next[to]] = [next[to], next[from]];
      return next;
    });
    void venueMediaSelectionHaptic();
  };

  /** 기존 file input 폴백 경로 — 그리드 픽은 confirmLibrarySelection 이 담당(원본은 업로드 차례에 lazy export). */
  const handlePickedFiles = async (files: File[] | null) => {
    if (!files || files.length === 0 || submitting) return;
    processingPickRef.current = true;
    setError(null);
    const seq = pickSeqRef.current;
    try {
      const accepted: ComposerItem[] = [];
      let rejectReason: string | null = null;
      for (const f of files) {
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
          assetId: null,
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
      for (const it of accepted) {
        if (it.kind !== "image" || it.file == null) continue;
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

  /** 그리드 타일 탭 — 즉시 선택/해제 토글만(export 없음). 선택 순서 1→2→3 보존. */
  const toggleLibraryAsset = (asset: VenueMediaAsset) => {
    setLibrarySelection((prev) => {
      const { next, overMax } = toggleAssetSelection(
        prev.map((a) => a.id),
        asset.id,
      );
      if (overMax) {
        setError(VENUE_STORY_OVER_MAX_MSG);
        return prev;
      }
      setError(null);
      return next.length < prev.length
        ? prev.filter((a) => a.id !== asset.id)
        : [...prev, asset];
    });
    void venueMediaSelectionHaptic();
  };

  /**
   * 그리드 하단 '선택 완료' — 즉시(동기) 그리드를 닫고 네이티브 썸네일(소형)로 프리뷰를 연다.
   * 원본은 저장하지 않고(File 도, full-res data URL 도 생성 X) assetId 만 보관 —
   * export 는 **업로드 차례**에 runVenueUploadQueue 가 lazy 로 수행하고 즉시 해제한다
   * (bounded memory — 3×원본 동시 상주 제거, 삼순 라운드3 #3). 재시도는 assetId 로 재-export(#2).
   */
  const confirmLibrarySelection = () => {
    const selectedIds = new Set(librarySelection.map((a) => a.id));
    for (const it of items) {
      if (it.assetId != null && !selectedIds.has(it.assetId)) removeItem(it.key);
    }
    const existingAssetIds = new Set(
      items.filter((it) => it.assetId != null).map((it) => it.assetId as string),
    );
    const additions = librarySelection.filter((a) => !existingAssetIds.has(a.id));
    const provisional: ComposerItem[] = additions.map((asset) => ({
      key: assetItemKey(asset.id),
      file: null,
      kind: asset.kind,
      // 즉시 프리뷰: 네이티브 소형 썸네일(data URL)만 보관 — 고해상 원본은 저장하지 않는다
      // (bounded memory, 삼순 라운드3 #3). 원본은 업로드 차례에 assetId 로 export 된다.
      previewUrl: asset.thumbnailUrl || null,
      durationMs: asset.durationMs,
      status: "ready",
      progress: 0,
      stage: "upload",
      failReason: null,
      assetId: asset.id,
    }));
    setError(null);
    setItems((prev) => {
      const { merged, droppedOverMax } = mergePickedItems(prev, provisional, (it) => it.key);
      if (droppedOverMax > 0) setError(VENUE_STORY_OVER_MAX_MSG);
      setActiveKey((cur) => cur ?? merged[0]?.key ?? null);
      return merged;
    });
    setLibraryOpen(false);
    // 원본 pre-export 없음 — assetId 만 provisional 항목에 남고, export 는 업로드 차례에 lazy 수행.
    void venueMediaSelectionHaptic();
  };

  /**
   * 화면에 실제 그려지는 asset — 상단 타입 토글 적용분(**fail-safe**).
   *
   * 1차 방어는 네이티브 쿼리 필터다(iOS PHFetch predicate / Android MediaStore selection) —
   * 그래서 cursor 도 같은 타입 안에서만 페이징한다. 다만 원격 로드(server.url) 앱은 웹이
   * 먼저 배포될 수 있고, 그 구설치본 브릿지는 `mediaTypes` 를 무시한 혼합 목록을 내려준다.
   * 그 구간에서도 '영상만' 탭에 사진이 섞이지 않도록 화면단 거르기를 유지한다.
   */
  const visibleLibraryAssets = useMemo(
    () => filterLibraryAssets(libraryAssets, libraryFilter),
    [libraryAssets, libraryFilter],
  );

  /**
   * 타입 토글 선택 — 네이티브를 그 타입으로 **재열거**한다(cursor 리셋).
   * 혼합 목록을 받아 화면에서 걸러내면 첫 페이지(24)에 영상이 1~2개뿐일 때 빈 화면처럼 보인다.
   * 선택(순서) 상태는 탭을 넘나들어도 그대로 보존된다.
   */
  const selectLibraryFilter = (next: VenueLibraryFilter) => {
    // state 반영 전 연속 탭(A→B→A)도 받아야 하므로 렌더 시점 state가 아닌 최신 ref로 비교한다.
    if (next === libraryFilterRef.current) return;
    libraryAutoPagesRef.current = 0;
    libraryFilterRef.current = next;
    setLibraryFilter(next);
    setLibraryAssets([]);
    setLibraryCursor(null);
    void loadLibrary(false);
  };

  // 구설치본 fail-safe — 네이티브가 `mediaTypes` 를 무시해 혼합 목록을 내려주면 '영상만' 탭의
  // 첫 페이지(24)에 영상이 1~2개뿐일 수 있다. 한 화면 분량(12)을 채울 때까지 다음 페이지를
  // 자동으로 이어 받는다(최대 6페이지 bounded). 신버전 네이티브에선 첫 페이지가 이미 해당
  // 타입으로 차서 보통 1회도 도지 않는다.
  useEffect(() => {
    if (!libraryOpen || libraryPermission === "denied") return;
    if (
      !shouldAutoLoadMoreForFilter({
        filter: libraryFilter,
        visibleCount: visibleLibraryAssets.length,
        hasCursor: libraryCursor != null,
        loading: libraryLoading,
        autoPages: libraryAutoPagesRef.current,
      })
    ) {
      return;
    }
    void loadLibrary(true);
    // loadLibrary 는 최신 state 를 읽는 action — 재생성 된다고 다시 돌 필요 없다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    libraryOpen,
    libraryPermission,
    libraryFilter,
    visibleLibraryAssets.length,
    libraryCursor,
    libraryLoading,
  ]);

  /** 그리드만 닫기(선택 변경 파기) — 기존 프리뷰/선택 화면으로 복귀. */
  const closeLibrary = () => {
    setLibraryOpen(false);
    setError(null);
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

  // 앱 복귀(기기 설정/Limited 시트 → 돌아옴) 시 사진첩 권한·목록 재조회 — 설정에서 허용해도
  // denied/stale 화면이 남는 회귀 방지(삼순 라운드2 #1). 그리드가 열려 있을 때만.
  useEffect(() => {
    if (!isOpen) return;
    const onVisibilityChange = () => {
      if (
        shouldRefreshLibraryOnResume({
          libraryOpen,
          documentVisible: document.visibilityState === "visible",
        })
      ) {
        void loadLibrary(false);
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
    // loadLibrary 는 최신 state 를 읽는 UI action — 리스너는 open 상태 변화에만 재등록한다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, libraryOpen]);

  // 트레이 '올리기' 진입 → 위치 선체크 통과 즉시 앱 내 커스텀 사진첩 그리드.
  // fileInput 폴백 모드는 자동 열기 없음 — OS 픽커 프로그래밍 클릭은 제스처 밖이면 차단된다.
  useEffect(() => {
    if (
      !isOpen ||
      pickerMode !== "grid" ||
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
  }, [isOpen, isAdmin, precheck.status, items.length, pickerMode]);

  /**
   * 항목 순차 업로드 — 기존 단건 파이프라인(prepareVenueStoryMedia → POST /api/venue-stories)을
   * 항목별로 그대로 재사용한다(서버 계약 변경 0). 성공 즉시 onUploaded 로 트레이 낙관 반영,
   * 실패는 사유 1줄을 항목에 기록(완료 요약에서 실패건만 개별 재시도).
   */
  const runUpload = async (targets: ReadonlyArray<VenueUploadTarget>) => {
    const pos = submitPosRef.current;
    // 순차 러너 — 원본은 각 항목 차례에만 export 되고, 그 항목 업로드가 끝나면 즉시 해제된다
    // (bounded memory — 3×원본 동시 상주 없음, #3). export 실패는 assetId 보존 → 재시도가 다시 export(#2).
    await runVenueUploadQueue(targets, {
      exportOriginal: (assetId) => exportVenueMediaFile(assetId),
      onStart: (target) =>
        patchItem(target.key, { status: "uploading", progress: 0, stage: "upload", failReason: null }),
      onResolveFail: (target) =>
        patchItem(target.key, {
          status: "failed",
          failReason: uploadFailureReason({ kind: "prepare", message: "원본을 준비하지 못했어요" }),
        }),
      uploadOne: async (target, file) => {
        // 그리드 픽은 pick 시점 제한 검사가 없었으므로(lazy export) 여기서 원본 제한을 검증한다.
        if (target.assetId != null) {
          const limitError = checkVenueMediaLimits({
            kind: target.kind,
            sizeBytes: file.size,
            durationMs: target.durationMs,
            videoAutoCompressAvailable: target.kind === "video" && isVideoCompressSupported(),
          });
          if (limitError) {
            patchItem(target.key, {
              status: "failed",
              failReason: uploadFailureReason({ kind: "prepare", message: limitError }),
            });
            return;
          }
        }
        let prepared;
        try {
          prepared = await prepareVenueStoryMedia(file, gameId, (r, stage) => {
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
          return;
        }
        const session = await getSafeSession();
        const token = session?.access_token;
        if (!token) {
          patchItem(target.key, {
            status: "failed",
            failReason: uploadFailureReason({ kind: "server", message: "로그인이 필요해요" }),
          });
          return;
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
            return;
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
      },
    });
  };

  /** 항목 → 업로드 타겟(key/file/assetId/kind/durationMs) — 그리드 픽은 file=null·assetId 보존. */
  const toUploadTarget = (
    it: Pick<ComposerItem, "key" | "file" | "assetId" | "kind" | "durationMs">,
  ): VenueUploadTarget => ({
    key: it.key,
    file: it.file,
    assetId: it.assetId,
    kind: it.kind,
    durationMs: it.durationMs,
  });

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
      await runUpload(items.map((it) => toUploadTarget(it)));
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
    void venueMediaSelectionHaptic();
    try {
      await runUpload([toUploadTarget(target)]);
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
  const activeIndex = activeItem ? items.findIndex((item) => item.key === activeItem.key) : -1;
  const activeBadge = activeItem
    ? mediaDurationBadge(activeItem.kind, activeItem.durationMs)
    : null;
  // 선택 직후엔 네이티브 썸네일(img)로 즉시 프리뷰, 영상 <video>는 원본 blob 준비 후에만.
  const activePreviewMode = activeItem
    ? previewMediaMode({
        kind: activeItem.kind,
        previewUrl: activeItem.previewUrl,
        originalReady: activeItem.file != null,
      })
    : "placeholder";
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
              onClick={libraryOpen && phase !== "done" ? closeLibrary : close}
              disabled={submitting}
              aria-label={libraryOpen && phase !== "done" ? "사진첩 닫기" : "닫기"}
              className="w-11 h-11 -mr-2 flex items-center justify-center text-text-tertiary disabled:opacity-40"
            >
              <X size={22} />
            </button>
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain p-4 flex flex-col gap-3">
            {phase === "done" ? (
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.22, ease: "easeOut" }}
                className="flex flex-col gap-3"
              >
                {/* 완료 요약 — 항목별 원본 썸네일 매칭 성공/실패 + 실패 사유 1줄 + 실패건만 개별 재시도 */}
                <div className="text-lg font-bold text-text-primary">
                  <span className="text-green-400">성공 {outcome.success}</span>
                  <span className="text-text-tertiary"> · </span>
                  <span className="text-red-400">실패 {outcome.failed}</span>
                </div>
                <div className="flex flex-col gap-2">
                  {items.map((it) => {
                    const badge = mediaDurationBadge(it.kind, it.durationMs);
                    const rowMode = previewMediaMode({
                      kind: it.kind,
                      previewUrl: it.previewUrl,
                      originalReady: it.file != null,
                    });
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
                            {rowMode === "video" ? (
                              <video
                                src={it.previewUrl ?? undefined}
                                className="w-full h-full object-cover"
                                muted
                                playsInline
                                preload="metadata"
                              />
                            ) : rowMode === "image" && it.previewUrl ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img src={it.previewUrl} alt="" className="w-full h-full object-cover" />
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
                            className="ml-auto shrink-0 min-h-11 px-3.5 rounded-xl text-xs font-semibold disabled:opacity-40"
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
              </motion.div>
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
                      className="shrink-0 min-h-11 rounded-xl px-3 text-xs font-semibold disabled:opacity-40"
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
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => void openVenueMediaSettings()}
                        className="min-h-11 rounded-xl px-4 text-sm font-semibold"
                        style={{ background: palette.accent, color: palette.onAccent }}
                      >
                        설정 열기
                      </button>
                      {/* 설정 복귀 후 stale 방지 — 앱 복귀 자동 재조회(visibilitychange)의 수동 보완 동선. */}
                      <button
                        onClick={() => void loadLibrary(false)}
                        disabled={libraryLoading}
                        className="min-h-11 rounded-xl border border-border px-4 text-sm font-semibold text-text-secondary disabled:opacity-40"
                      >
                        다시 확인
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    {/* 미디어 타입 토글 — 네이티브 열거가 사진+영상을 섞어 주므로 화면단에서 걸러 보여준다. */}
                    <div
                      role="tablist"
                      aria-label="미디어 종류"
                      data-testid="library-filter-tabs"
                      className="flex items-center gap-1 rounded-xl bg-bg-tertiary/60 p-1"
                    >
                      {VENUE_LIBRARY_FILTERS.map((tab) => {
                        const selected = libraryFilter === tab.value;
                        return (
                          <button
                            key={tab.value}
                            role="tab"
                            aria-selected={selected}
                            data-library-filter={tab.value}
                            onClick={() => selectLibraryFilter(tab.value)}
                            className={`flex-1 min-h-11 rounded-lg text-sm font-semibold transition-colors ${
                              selected ? "" : "text-text-secondary"
                            }`}
                            style={
                              selected
                                ? { background: palette.accent, color: palette.onAccent }
                                : undefined
                            }
                          >
                            {tab.label}
                          </button>
                        );
                      })}
                    </div>

                    {visibleLibraryAssets.length > 0 ? (
                      <>
                        {/* 타일 탭 → 같은 화면 큰 네이티브 썸네일 프리뷰 즉시 갱신 + 선택/해제 토글(삼순 라운드3 #1). */}
                        <VenueLibraryGrid
                          key={libraryFilter}
                          assets={visibleLibraryAssets}
                          selection={librarySelection.map((a) => a.id)}
                          onToggle={toggleLibraryAsset}
                          accent={palette.accent}
                          onAccent={palette.onAccent}
                        />
                        {libraryCursor && (
                          <button
                            onClick={() => void loadLibrary(true)}
                            disabled={libraryLoading}
                            className="w-full min-h-11 rounded-xl border border-border px-3 text-sm text-text-secondary disabled:opacity-40"
                          >
                            더 불러오기
                          </button>
                        )}
                      </>
                    ) : libraryLoading ? (
                      <div className="grid grid-cols-3 gap-0.5" aria-label="사진첩 불러오는 중">
                        {Array.from({ length: 12 }, (_, index) => (
                          <div
                            key={index}
                            className="aspect-square animate-pulse bg-gradient-to-br from-bg-tertiary via-bg-secondary to-bg-tertiary"
                          />
                        ))}
                      </div>
                    ) : (
                      <div
                        data-testid="library-empty"
                        className="flex min-h-64 flex-col items-center justify-center gap-2 rounded-2xl border border-border bg-bg-tertiary/30 px-6 text-center"
                      >
                        <VideoIcon size={28} className="text-text-tertiary" />
                        <span className="text-sm font-semibold text-text-secondary">
                          {libraryEmptyMessage({
                            filter: libraryFilter,
                            totalLoaded: libraryAssets.length,
                          })}
                        </span>
                        <span className="text-sm text-text-tertiary">
                          {libraryFilter === "all" || libraryAssets.length === 0
                            ? "사진 접근 범위를 확인하거나 새로 촬영한 뒤 다시 열어주세요"
                            : "위 탭을 '전체'로 바꾸면 모두 볼 수 있어요"}
                        </span>
                      </div>
                    )}
                  </>
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
                          className="mt-1 min-h-11 text-xs bg-bg-secondary border border-border text-text-secondary px-4 rounded-full active:bg-bg-tertiary"
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
                    {pickerMode === "grid" && (
                      <span className="text-[11px] text-text-tertiary/60">
                        앱 안에서 최근 사진첩을 열어요
                      </span>
                    )}
                  </button>
                ) : (
                  <>
                    {/* 선택 → 즉시 프리뷰: 첫 항목(또는 탭한 항목) 큰 프리뷰 */}
                    <div className="relative rounded-2xl overflow-hidden bg-black aspect-[9/16] max-h-[42dvh] flex items-center justify-center">
                      <AnimatePresence mode="wait" initial={false}>
                        <motion.div
                          key={activeItem?.key ?? "loading"}
                          initial={{ opacity: 0, scale: 1.015 }}
                          animate={{ opacity: 1, scale: 1 }}
                          exit={{ opacity: 0, scale: 0.99 }}
                          transition={{ duration: 0.16, ease: "easeOut" }}
                          className="absolute inset-0 flex items-center justify-center"
                        >
                          {activePreviewMode === "video" && activeItem ? (
                            <video
                              src={activeItem.previewUrl ?? undefined}
                              className="w-full h-full object-contain"
                              controls
                              playsInline
                              muted
                            />
                          ) : activePreviewMode === "image" && activeItem?.previewUrl ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={activeItem.previewUrl}
                              alt=""
                              decoding="async"
                              className="w-full h-full object-contain"
                            />
                          ) : (
                            <div className="flex flex-col items-center gap-2 text-text-tertiary">
                              <Loader2 size={22} className="animate-spin" />
                              <span className="text-xs">프리뷰 준비 중</span>
                            </div>
                          )}
                        </motion.div>
                      </AnimatePresence>
                      {/* 미디어 타입 정합: 길이 배지는 영상에만(0:12), 사진엔 금지 */}
                      {activeBadge && (
                        <span className="absolute bottom-2 right-2 px-2 py-0.5 rounded-lg bg-black/60 text-white text-[11px] font-semibold">
                          {activeBadge}
                        </span>
                      )}
                    </div>
                    {/* 선택 스트립 — 선택 순서 1→2→3 배지 + 영상 재생 아이콘/길이 배지 */}
                    <div className="flex items-center gap-2">
                      <AnimatePresence initial={false}>
                      {items.map((it, idx) => {
                        const badge = mediaDurationBadge(it.kind, it.durationMs);
                        const isActive = activeItem?.key === it.key;
                        const tileMode = previewMediaMode({
                          kind: it.kind,
                          previewUrl: it.previewUrl,
                          originalReady: it.file != null,
                        });
                        return (
                          <motion.button
                            key={it.key}
                            layout
                            initial={{ opacity: 0, scale: 0.82 }}
                            animate={{ opacity: 1, scale: 1 }}
                            exit={{ opacity: 0, scale: 0.82 }}
                            transition={{ type: "spring", stiffness: 430, damping: 32 }}
                            onClick={() => setActiveKey(it.key)}
                            disabled={submitting}
                            className="relative w-14 h-14 min-w-11 min-h-11 rounded-lg overflow-hidden bg-bg-tertiary shrink-0 disabled:opacity-40"
                            style={
                              isActive
                                ? { boxShadow: `inset 0 0 0 2px ${palette.accent}` }
                                : undefined
                            }
                          >
                            {tileMode === "video" ? (
                              <video
                                src={it.previewUrl ?? undefined}
                                className="w-full h-full object-cover"
                                muted
                                playsInline
                                preload="metadata"
                              />
                            ) : tileMode === "image" && it.previewUrl ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img src={it.previewUrl} alt="" className="w-full h-full object-cover" />
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
                          </motion.button>
                        );
                      })}
                      </AnimatePresence>
                      {items.length < VENUE_STORY_MAX_ITEMS && (
                        <button
                          onClick={openPicker}
                          disabled={submitting || !precheckGateReady({ isAdmin, status: precheck.status })}
                          aria-label="더 추가"
                          className="w-14 h-14 min-w-11 min-h-11 rounded-lg bg-bg-tertiary text-text-tertiary text-xl font-light flex items-center justify-center active:bg-bg-primary disabled:opacity-40 shrink-0"
                        >
                          +
                        </button>
                      )}
                    </div>
                    {activeItem && (
                      <div className="flex items-center justify-end gap-1">
                        <button
                          type="button"
                          onClick={() => moveItem(activeItem.key, -1)}
                          disabled={submitting || activeIndex <= 0}
                          aria-label="선택 항목 앞으로 이동"
                          className="w-11 h-11 rounded-xl flex items-center justify-center text-text-secondary active:bg-bg-tertiary disabled:opacity-25"
                        >
                          <ChevronLeft size={19} />
                        </button>
                        <button
                          type="button"
                          onClick={() => moveItem(activeItem.key, 1)}
                          disabled={submitting || activeIndex >= items.length - 1}
                          aria-label="선택 항목 뒤로 이동"
                          className="w-11 h-11 rounded-xl flex items-center justify-center text-text-secondary active:bg-bg-tertiary disabled:opacity-25"
                        >
                          <ChevronRight size={19} />
                        </button>
                        <button
                          type="button"
                          onClick={() => removeItem(activeItem.key)}
                          disabled={submitting}
                          aria-label="선택 항목 삭제"
                          className="w-11 h-11 rounded-xl flex items-center justify-center text-red-400 active:bg-red-500/10 disabled:opacity-40"
                        >
                          <Trash2 size={18} />
                        </button>
                      </div>
                    )}
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
                  className="h-full rounded-full transition-[width] duration-300 ease-out"
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

          {/* 그리드 sticky 확정 바 — 한 화면에서 1→2→3 선택/해제 끝내고 일괄 확정(삼순 #4). */}
          {libraryOpen && phase !== "done" && (
            <div
              className="shrink-0 border-t border-border p-4"
              style={{ paddingBottom: "max(env(safe-area-inset-bottom), 12px)" }}
            >
              <button
                onClick={confirmLibrarySelection}
                disabled={
                  libraryLoading ||
                  libraryPermission === "denied" ||
                  (librarySelection.length === 0 && !items.some((it) => it.assetId != null))
                }
                className="w-full py-3.5 rounded-xl font-semibold flex items-center justify-center gap-2 disabled:opacity-40"
                style={{ background: palette.accent, color: palette.onAccent }}
              >
                {librarySelection.length > 0
                  ? `${librarySelection.length}개 선택 완료`
                  : "선택 완료"}
              </button>
            </div>
          )}

          {/* version gate 폴백 — 네이티브 브릿지 없는 구설치본/웹은 기존 OS 파일 선택 동선 그대로. */}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*,video/*"
            multiple
            className="hidden"
            onChange={(e) => {
              const files = e.target.files ? Array.from(e.target.files) : null;
              e.target.value = "";
              void handlePickedFiles(files);
            }}
          />
        </motion.div>
      </motion.div>
    </AnimatePresence>,
    document.body,
  );
}
