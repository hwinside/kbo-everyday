"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import { X, Loader2, Video as VideoIcon, MapPin } from "lucide-react";
import { getSafeSession } from "@/lib/supabase/client";
import { prepareVenueStoryMedia, probeVideoDurationMs } from "@/lib/venue-stories/upload";
import { checkVenueMediaLimits } from "@/lib/venue-stories/media-limits";
import { isVideoCompressSupported } from "@/lib/venue-stories/video-compress";
import { getVenuePosition } from "@/lib/venue-stories/geo";
import { haversineMeters } from "@/lib/venue-stories/stadiums";
import { VENUE_STORY_CONSENT_VERSION, type VenueInfo } from "@/lib/venue-stories/types";
import { consentStorageKey } from "@/lib/venue-stories/auth-consent";
import { createPickController, type PickController } from "@/lib/venue-stories/pick-controller";
import { useIsAdmin } from "@/hooks/useIsAdmin";

interface Props {
  gameId: string;
  isOpen: boolean;
  onClose: () => void;
  onUploaded: () => void;
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
  // controller의 onFile은 생성 시 1회 결속되므로, 최신 render closure를 ref로 우회한다
  const handlePickedFileRef = useRef<(file: File | null) => void>(() => {});
  // 영상 duration probe가 async — reset/새 픽 이후 도착하는 late probe 결과는 무시한다
  const pickSeqRef = useRef(0);
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
        // 무시 — 서버가 POST 에서 최종 판정
      } finally {
        if (alive) setVenueLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [isOpen, gameId]);

  const reset = () => {
    // in-flight 픽 invalidate — 닫기/초기화 뒤 도착하는 late change는 무시된다
    cancelPick();
    pickSeqRef.current++;
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setFile(null);
    setPreviewUrl(null);
    setPreviewType(null);
    setCaption("");
    setError(null);
    setPhase("idle");
    setProgress(0);
    setUploadStage("upload");
  };

  const close = () => {
    // 업로드 진행 중 닫기 금지 — XHR은 계속돼서 orphan 업로드가 남는다(삼순 #795 blocker)
    if (submitting) return;
    reset();
    onClose();
  };

  const openPicker = () => {
    if (submitting) return;
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
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setFile(f);
    setPreviewUrl(URL.createObjectURL(f));
    setPreviewType(isVideo ? "video" : "image");
  };
  useEffect(() => {
    // render마다 최신 closure로 갱신 — controller의 1회 결속 onFile이 stale state를 보지 않게
    handlePickedFileRef.current = handlePickedFile;
  });

  const submit = async () => {
    if (!file || submitting) return;
    setError(null);

    // UGC 가이드라인 동의 필수(업로드 시점 게이트)
    if (!agreed) {
      setError("업로드 가이드라인에 동의해주세요");
      return;
    }

    // 업로드 가능 시간대 아님(경기 전/후, 취소, 미지원 구장) — 서버 사유 그대로 노출
    if (venue && !venue.uploadOpen) {
      setError(venue.reason ?? "지금은 올릴 수 없어요");
      return;
    }

    // 일반 유저는 위치 필수. 관리자 WIP QA 계정은 구장 밖 테스트를 위해 GPS 수집부터 생략.
    let pos: { lat: number | null; lng: number | null; accuracy: number | null } = {
      lat: null,
      lng: null,
      accuracy: null,
    };
    if (!isAdmin) {
      setPhase("geo");
      const measured = await getVenuePosition();
      if ("error" in measured) {
        setError(measured.error);
        setPhase("idle");
        return;
      }
      pos = measured;
      if (venue && venue.lat != null && venue.lng != null) {
        const dist = haversineMeters(measured.lat, measured.lng, venue.lat, venue.lng);
        if (dist > venue.radiusM) {
          const where = venue.stadiumName ?? "경기장";
          setError(
            `직관 인증 실패 — ${where}${radiusKm ? ` 반경 ${radiusKm}km` : ""} 안에서만 올릴 수 있어요`,
          );
          setPhase("idle");
          return;
        }
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
      onUploaded();
      close();
    } catch {
      setError("업로드에 실패했어요");
      setPhase("idle");
    }
  };

  if (!isOpen || typeof document === "undefined") return null;

  // 관리자 QA 모드는 종료·시간창 밖 경기에도 테스트 업로드가 가능해야 한다(지오펜스 우회와 동일 정책).
  // 서버도 admin QA는 uploadOpen 게이트를 우회한다. 일반 유저는 그대로 마감 사유로 버튼 비활성.
  const gateReason = !isAdmin && venue && !venue.uploadOpen ? venue.reason : null;

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
          className="relative w-full max-w-lg mx-auto bg-bg-secondary rounded-t-3xl max-h-[90dvh] overflow-y-auto flex flex-col"
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

            {!previewUrl ? (
              <button
                onClick={openPicker}
                disabled={submitting}
                className="flex flex-col items-center justify-center gap-2 h-48 rounded-2xl border-2 border-dashed border-border text-text-tertiary active:bg-bg-tertiary disabled:opacity-40"
              >
                <VideoIcon size={28} />
                <span className="text-sm">현장 사진·영상 선택</span>
                <span className="text-[11px] text-text-tertiary/70">영상은 15초 이하 · 세로 추천</span>
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
              disabled={!file || submitting || !!gateReason || !agreed}
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
