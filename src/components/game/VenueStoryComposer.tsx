"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import { X, Loader2, Video as VideoIcon, MapPin } from "lucide-react";
import { getSafeSession } from "@/lib/supabase/client";
import { prepareVenueStoryMedia, probeVideoDurationMs } from "@/lib/venue-stories/upload";
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
import { createPickController, type PickController } from "@/lib/venue-stories/pick-controller";
import {
  ownsImagePreviewReadLock,
  resolveImagePreview,
} from "@/lib/venue-stories/composer-helpers";
import { readFileAsDataURL } from "@/lib/venue-stories/read-file";
import { useIsAdmin } from "@/hooks/useIsAdmin";

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

type Phase = "idle" | "geo" | "upload";

export default function VenueStoryComposer({ gameId, isOpen, onClose, onUploaded }: Props) {
  const isAdmin = useIsAdmin();
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewType, setPreviewType] = useState<"image" | "video" | null>(null);
  const [caption, setCaption] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState(0); // 0~100, phase==="upload" 일 때만 유효
  // cap 초과 영상 자동압축 구간(0~40%) 라벨 분기용 — upload.ts 가 stage 를 알려준다
  const [uploadStage, setUploadStage] = useState<"compress" | "upload">("upload");
  // iOS가 사진앱 영상을 export하느라 픽 후 change 이벤트까지 수 초간 무피드백 구간이 있다
  // → 픽 대기 안내 오버레이 (하린아빠 7/23 21:05 리포트). 상태 전이는 pick-session 순수 모듈이 소유:
  // 수동 취소/닫기 후 late change 무시 · 준비 중 재진입 차단 (삼순 #805 blocker)
  const [picking, setPicking] = useState(false);
  // 이미지 data URL 읽는 동안 제출 잠금 — 파일만 활성·프리뷰 없는 사이 업로드 방지(삼순 #839)
  const [readingPreview, setReadingPreview] = useState(false);
  // controller의 onFile은 생성 시 1회 결속되므로, 최신 render closure를 ref로 우회한다
  const handlePickedFileRef = useRef<(file: File | null) => void>(() => {});
  // 영상 duration probe가 async — reset/새 픽 이후 도착하는 late probe 결과는 무시한다
  const pickSeqRef = useRef(0);
  // readingPreview boolean만으로는 superseded read가 lock을 풀어야 하는지 구분할 수 없다.
  // 현재 이미지 read의 seq를 소유권으로 두고, 소유자만 lock을 해제한다.
  const previewReadSeqRef = useRef<number | null>(null);
  const pickControllerRef = useRef<PickController | null>(null);
  const pickController = () =>
    (pickControllerRef.current ??= createPickController({
      // 픽마다 **새 input 인스턴스** 생성 — 토큰이 이 인스턴스의 handler closure에 결속되어
      // 이전 픽(A)의 late change/cancel이 새 픽(B)으로 오인될 수 없다 (삼순 #805 라운드4)
      openNative: ({ onChange, onCancel }) => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = "image/*,video/*";
        // iOS WKWebView 버그: DOM에 **미부착된** file input은 영상 export가 필요한 픽에서
        // change 이벤트를 안 쏘고 멈춘다 → 픽 스피너 영구 hang (하린아빠 7/25 04:36 리포트).
        // 반드시 document에 붙여 click, 이벤트 처리 후 제거한다. (데스크톱/안드로이드는 무해)
        input.style.cssText =
          "position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;pointer-events:none;";
        document.body.appendChild(input);

        let settled = false;
        let watchdog: ReturnType<typeof setTimeout> | null = null;
        const settle = (fn: () => void) => {
          if (settled) return;
          settled = true;
          if (watchdog != null) clearTimeout(watchdog);
          watchdog = null;
          input.remove();
          fn();
        };
        input.addEventListener(
          "change",
          () => {
            const f = input.files?.[0] ?? null; // 제거 전에 파일 참조 확보
            settle(() => onChange(f));
          },
          { once: true },
        );
        input.addEventListener("cancel", () => settle(() => onCancel()), { once: true });
        // 그래도 iOS가 change/cancel을 끝내 안 쏘는 드문 케이스 방어 — 무한 스피너 대신 자동 취소
        watchdog = setTimeout(() => settle(() => onCancel()), 90_000);
        input.click();
      },
      onFile: (file) => handlePickedFileRef.current(file),
      onStateChange: setPicking,
    }));
  const cancelPick = () => {
    pickController().cancel();
  };
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

  const submitting = phase !== "idle";
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
    // in-flight 픽 invalidate — 닫기/초기화 뒤 도착하는 late change는 무시된다
    cancelPick();
    pickSeqRef.current++;
    // data URL(이미지 프리뷰)은 revoke 불필 — blob(비디오)만 해제
    if (previewUrl?.startsWith("blob:")) URL.revokeObjectURL(previewUrl);
    setFile(null);
    setPreviewUrl(null);
    setPreviewType(null);
    setCaption("");
    setError(null);
    setPhase("idle");
    setProgress(0);
    setUploadStage("upload");
    // 읽기 lock/소유권 해제 — 이미지 data URL 읽는 중 모달을 닫으면 seq 증가로 늦은 read는
    // discard된다. 여기서 둘 다 비우지 않으면 재오픈 뒤 openPicker/submit이 영구 차단된다.
    previewReadSeqRef.current = null;
    setReadingPreview(false);
    precheckPosRef.current = null;
    setPrecheck({ status: "idle" });
  };

  const close = () => {
    // 업로드 진행 중 닫기 금지 — XHR은 계속돼서 orphan 업로드가 남는다(삼순 #795 blocker)
    if (submitting) return;
    reset();
    onClose();
  };

  const openPicker = () => {
    if (submitting || readingPreview) return;
    // 재진입/late-event 방어는 controller가 소유 (픽별 새 input + 토큰 closure 결속)
    pickController().openPicker();
  };

  const handlePickedFile = async (f: File | null) => {
    if (!f || submitting) return;
    setError(null);
    const isVideo = f.type.startsWith("video/");
    const isImage = f.type.startsWith("image/");
    if (!isVideo && !isImage) {
      setError("이미지 또는 영상만 올릴 수 있어요");
      return;
    }
    // 제한 초과는 픽 시점에 즉시 차단 — '올리기'까지 가지 않게 (upload.ts 검사는 최종 안전망).
    // 영상은 duration(15초)이 1차 기준 — 유저는 방금 찍은 영상이 몇 MB인지 모른다(하린아빠 7/24).
    // probe 실패(null)는 여기서 차단하지 않고 업로드 단계 검증으로 fail-close(이중 차단 방지).
    const seq = ++pickSeqRef.current;
    const durationMs = isVideo ? await probeVideoDurationMs(f) : null;
    if (seq !== pickSeqRef.current) return; // reset/새 픽이 끼어든 late probe — 버림
    const limitError = checkVenueMediaLimits({
      kind: isVideo ? "video" : "image",
      sizeBytes: f.size,
      durationMs,
      // WebCodecs 지원 환경이면 cap 초과 영상을 차단 대신 업로드 단계 자동압축에 맡긴다
      videoAutoCompressAvailable: isVideo && isVideoCompressSupported(),
    });
    if (limitError) {
      setError(limitError);
      return;
    }
    // 영상: blob 프리뷰 — file·preview·type 원자 반영(late면 방금 만든 blob만 revoke하고 빠짐).
    if (isVideo) {
      const url = URL.createObjectURL(f);
      if (seq !== pickSeqRef.current) {
        URL.revokeObjectURL(url);
        return;
      }
      if (previewUrl?.startsWith("blob:")) URL.revokeObjectURL(previewUrl);
      setFile(f);
      setPreviewUrl(url);
      setPreviewType("video");
      return;
    }
    // 이미지: 안드로이드 WebView가 blob: 이미지를 못 렌더하는 케이스 방지 → data URL.
    // **file·preview를 읽기 완료 후에만 함께 반영** — A→B 재선택 시 파일은 B인데 프리뷰는 A인
    // 불일치 방지(삼순 #839). 읽는 동안 제출 잠금(readingPreview), 실패/늦은 결과는 순수함수로 판정.
    previewReadSeqRef.current = seq;
    setReadingPreview(true);
    let dataUrl: string | null = null;
    try {
      dataUrl = await readFileAsDataURL(f);
    } catch {
      dataUrl = null;
    }
    const outcome = resolveImagePreview({
      pickSeq: seq,
      currentSeq: pickSeqRef.current,
      read: dataUrl != null ? { ok: true, dataUrl } : { ok: false },
    });
    const releaseReadLock = () => {
      if (!ownsImagePreviewReadLock(seq, previewReadSeqRef.current)) return;
      previewReadSeqRef.current = null;
      setReadingPreview(false);
    };
    if (outcome === "discard") {
      // 새 이미지 read가 lock을 인수했다면 건드리지 않는다. 반대로 seq만 바뀐
      // 영상/취소 경로라면 이 read가 여전히 소유자이므로 반드시 해제한다.
      releaseReadLock();
      return;
    }
    if (outcome === "error") {
      releaseReadLock();
      setError("사진을 불러오지 못했어요. 다시 선택해주세요");
      return;
    }
    // apply — file·preview 원자 반영
    if (previewUrl?.startsWith("blob:")) URL.revokeObjectURL(previewUrl);
    setFile(f);
    setPreviewUrl(dataUrl!);
    setPreviewType("image");
    releaseReadLock();
  };
  // 모달이 열린 동안 body 스크롤 잠금 — 안드로이드에서 모달 안 터치가 배경(body)으로
  // 체이닝돼 뤡경만 스크롤되고 하단 '올리기' 버튼에 도달 못하던 문제 방지(하린아빠 A17 리포트).
  useEffect(() => {
    if (!isOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [isOpen]);

  useEffect(() => {
    // render마다 최신 closure로 갱신 — controller의 1회 결속 onFile이 stale state를 보지 않게
    handlePickedFileRef.current = handlePickedFile;
  });

  const submit = async () => {
    // readingPreview 중이면 file 만 활성·preview 미반영 상태일 수 있어 제출 잠금(버튼 disabled 와 이중 방어)
    if (!file || submitting || readingPreview) return;
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

    setPhase("upload");
    setProgress(0);
    setUploadStage("upload");
    try {
      const prepared = await prepareVenueStoryMedia(file, gameId, (r, stage) => {
        setProgress(Math.min(99, Math.round(r * 100)));
        if (stage) setUploadStage(stage);
      });
      if ("error" in prepared) {
        setError(prepared.error);
        setPhase("idle");
        return;
      }
      const session = await getSafeSession();
      const token = session?.access_token;
      if (!token) {
        setError("로그인이 필요해요");
        setPhase("idle");
        return;
      }
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
        setError(data.error);
        setPhase("idle");
        return;
      }
      // 업로드 성공 — mediaType과 상태(영상은 pending→검증 중일 수 있음)를 알려 성공 피드백을 보장.
      // 지금까지는 모달만 조용히 닫혀 "실패한 줄"로 오인되던 문제(하린아빠 A17 리포트).
      onUploaded({
        id: typeof data.id === "number" ? data.id : null,
        mediaType: prepared.mediaType,
        status: data.status ?? null,
        thumbUrl: prepared.thumbUrl,
      });
      close();
    } catch {
      setError("업로드에 실패했어요");
      setPhase("idle");
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
    !isAdmin &&
    !gateReason &&
    (precheck.status === "measuring" || precheck.status === "out" || precheck.status === "failed");
  const precheckDistKm =
    precheck.distanceM != null ? Math.max(0.1, Math.round(precheck.distanceM / 100) / 10) : null;

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
          className="relative w-full max-w-lg mx-auto bg-bg-secondary rounded-t-3xl max-h-[90dvh] overflow-y-auto overscroll-contain flex flex-col"
          initial={{ y: "100%" }}
          animate={{ y: 0 }}
          exit={{ y: "100%" }}
          transition={{ type: "spring", damping: 26 }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between px-4 py-3 border-b border-border">
            <span className="text-base font-semibold text-text-primary">직관 라이브 올리기</span>
            <button
              onClick={close}
              disabled={submitting}
              aria-label="닫기"
              className="text-text-tertiary disabled:opacity-40"
            >
              <X size={22} />
            </button>
          </div>

          <div className="p-4 flex flex-col gap-3">
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
                {precheck.status === "measuring" ? (
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
            ) : !previewUrl ? (
              <button
                onClick={openPicker}
                disabled={submitting}
                className="flex flex-col items-center justify-center gap-2 h-48 rounded-2xl border-2 border-dashed border-border text-text-tertiary active:bg-bg-tertiary disabled:opacity-40"
              >
                <VideoIcon size={28} />
                <span className="text-sm">현장 사진·영상 선택</span>
                <span className="text-[11px] text-text-tertiary/70">영상은 15초 이하 · 세로 추천</span>
                {/* iOS 네이티브 모달은 우리 UI 위에 뜨므로 picking 오버레이가 그 구간을 덮지 못한다.
                    피커 열기 전에 상시 안내해 "멈춘 게 아니다" 신호를 미리 준다(삼순 #832 왕복2 합의). */}
                <span className="text-[11px] text-text-tertiary/60">영상은 기기에서 준비하는 데 몇 초 걸릴 수 있어요</span>
              </button>
            ) : (
              <div className="relative rounded-2xl overflow-hidden bg-black aspect-[9/16] max-h-[50dvh] flex items-center justify-center">
                {previewType === "video" ? (
                  <video src={previewUrl} className="w-full h-full object-contain" controls playsInline muted />
                ) : (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={previewUrl} alt="" className="w-full h-full object-contain" />
                )}
                <button
                  onClick={openPicker}
                  disabled={submitting}
                  className="absolute bottom-2 right-2 text-xs bg-black/60 text-white px-3 py-1.5 rounded-full disabled:opacity-40"
                >
                  다시 선택
                </button>
              </div>
            )}

            {/* iOS 사진앱 영상 export 대기 구간 안내 — 픽커가 닫힌 뒤 change 이벤트까지 수 초간 무피드백이던 구간 (7/23 리포트) */}
            {picking && !submitting && (
              <div className="flex items-center justify-between gap-2 rounded-xl bg-bg-tertiary/60 px-3 py-2.5 text-sm text-text-secondary">
                <span className="flex items-center gap-2">
                  <Loader2 size={16} className="animate-spin shrink-0" />
                  사진·영상 불러오는 중… 영상은 몇 초 걸릴 수 있어요
                </span>
                <button onClick={cancelPick} className="text-xs text-text-tertiary shrink-0">
                  취소
                </button>
              </div>
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

            {error && <p className="text-sm text-red-400">{error}</p>}

            {phase === "upload" && (
              <div className="w-full h-1.5 rounded-full bg-bg-tertiary overflow-hidden">
                <div
                  className="h-full rounded-full bg-brand-primary transition-[width] duration-200 ease-out"
                  style={{ width: `${progress}%` }}
                />
              </div>
            )}

            <button
              onClick={submit}
              disabled={!file || submitting || readingPreview || !!gateReason || !agreed || !precheckGateReady({ isAdmin, status: precheck.status })}
              className="w-full py-3 rounded-xl bg-brand-primary text-white font-semibold flex items-center justify-center gap-2 disabled:opacity-40"
            >
              {submitting ? <Loader2 size={18} className="animate-spin" /> : null}
              {phase === "geo"
                ? "직관 인증 중…"
                : phase === "upload"
                  ? uploadStage === "compress"
                    ? `영상 최적화 중… ${progress}%`
                    : `올리는 중… ${progress}%`
                  : "올리기"}
            </button>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>,
    document.body,
  );
}
