"use client";

import { useState, useRef, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, Image as ImageIcon, XCircle, ChevronDown } from "lucide-react";
import Image from "next/image";
import imageCompression from "browser-image-compression";
import { uploadImages, computeImageHashes } from "@/lib/supabase/usePosts";
import TeamTagger from "./TeamTagger";
import PlayerTagger from "./PlayerTagger";
import LinkPreview from "./LinkPreview";
import { formatPlayerTag } from "@/lib/utils/player-tags";
import { useAuth } from "@/lib/supabase/AuthContext";
import { getTeamById } from "@/lib/constants/teams";
import { hasRequiredTeamTag } from "@/lib/utils/post-scope";

export interface SeatInfo {
  zone: string;
  block?: string;
  row?: string;
  seat?: string;
}

/** V3 태그 모델: 팀태그 0 + 선수태그 0 = 자유글. */
export interface PostTags {
  teamTags: string[];
  playerTags: string[];
}

interface PlayerTag {
  kboId: string;
  name: string;
  teamId: number;
}

interface WritePostProps {
  isOpen: boolean;
  onClose: () => void;
  teamName?: string;
  onSubmit?: (title: string, content: string, imageUrls: string[], seatInfo?: SeatInfo, tags?: PostTags) => Promise<void>;
  /** 좌석팁 모드: 구역/좌석 입력 + 이미지 첨부 활성화 */
  seatTipMode?: boolean;
  /** V3 태그 피커(팀·선수 복수태그) 노출. 켜면 onSubmit 5번째 인자로 tags 전달. */
  enableTags?: boolean;
  /** 태그 피커 초기 팀태그(보통 최애팀 슬러그). enableTags일 때만 사용. */
  defaultTeamSlugs?: string[];
  /** 태그 피커 초기 선수태그(현재 선수 페이지·최애선수). enableTags일 때만 사용. */
  defaultPlayerTag?: PlayerTag;
  /** 구장별 구역 모드 (드롭다운 선택지) */
  zones?: string[];
  /** 수정 모드 — 닫힌 후 다시 열릴 때 초기값으로 폼 리셋. 이미지 URL을 주면 기존 이미지 재사용. */
  initialTitle?: string;
  initialContent?: string;
  initialImageUrls?: string[];
  initialSeatInfo?: SeatInfo | null;
  /** 제출 버튼 텍스트. 입력 시 메뉴 접두사도 그대로 사용 (“저장” → “저장 중...”). */
  submitText?: string;
}

const MAX_IMAGES = 3;

type WriteImage = { preview: string; file?: File; existingUrl?: string };

export default function WritePost({
  isOpen,
  onClose,
  teamName,
  onSubmit,
  seatTipMode,
  zones,
  initialTitle,
  initialContent,
  initialImageUrls,
  initialSeatInfo,
  submitText,
  enableTags,
  defaultTeamSlugs,
  defaultPlayerTag,
}: WritePostProps) {
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  // OG 프리뷰용 디바운스 텍스트 — 타이핑마다 og-meta fetch 하지 않도록 600ms 지연.
  const [linkPreviewText, setLinkPreviewText] = useState("");
  const [images, setImages] = useState<WriteImage[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // V3 태그(팀·선수 복수). enableTags일 때만 사용.
  const [teamSlugs, setTeamSlugs] = useState<string[]>([]);
  const [taggedPlayers, setTaggedPlayers] = useState<PlayerTag[]>([]);

  // 최애팀(profile.team_id) — board 컨텍스트가 없을 때 기본 선택 칩으로 사용.
  const { profile } = useAuth();
  const favoriteSlug = (() => {
    const id = (profile as Record<string, unknown> | null)?.team_id as number | undefined;
    return id ? getTeamById(id)?.slug : undefined;
  })();

  // 좌석팁 구조화 필드
  const [zone, setZone] = useState("");
  const [customZone, setCustomZone] = useState("");
  const [block, setBlock] = useState("");
  const [row, setRow] = useState("");
  const [seat, setSeat] = useState("");

  // OG 프리뷰: 본문 입력이 멈춘 뒤(600ms) linkPreviewText 갱신 → LinkPreview 가 URL 추출·og-meta fetch.
  useEffect(() => {
    const t = setTimeout(() => setLinkPreviewText(content), 600);
    return () => clearTimeout(t);
  }, [content]);

  // 모달이 열리는 edge에서만 초기값으로 리셋. 열린 상태에서는 부모 리렌더로 initial*이 바뀌더라도 입력 날리지 않도록.
  const wasOpenRef = useRef(false);
  useEffect(() => {
    if (isOpen && !wasOpenRef.current) {
      setTitle(initialTitle ?? "");
      setContent(initialContent ?? "");
      setImages((initialImageUrls ?? []).map((url) => ({ preview: url, existingUrl: url })));
      const z = initialSeatInfo?.zone ?? "";
      const isCustom = !!z && !!zones?.length && !zones.includes(z);
      setZone(isCustom ? "__custom__" : z);
      setCustomZone(isCustom ? z : "");
      setBlock(initialSeatInfo?.block ?? "");
      setRow(initialSeatInfo?.row ?? "");
      setSeat(initialSeatInfo?.seat ?? "");
      // board 컨텍스트(defaultTeamSlugs)가 있으면 그것, 없으면 최애팀을 기본 선택(해제 가능).
      setTeamSlugs(
        defaultTeamSlugs?.length
          ? defaultTeamSlugs
          : enableTags && !seatTipMode && favoriteSlug
            ? [favoriteSlug]
            : [],
      );
      setTaggedPlayers(defaultPlayerTag ? [defaultPlayerTag] : []);
    }
    wasOpenRef.current = isOpen;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  const isCustomZone = zone === "__custom__";
  const effectiveZone = isCustomZone ? customZone.trim() : zone;

  async function handleImageSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (!files) return;
    const remaining = MAX_IMAGES - images.length;
    const selected = Array.from(files).slice(0, remaining);

    for (const file of selected) {
      try {
        const compressed = await imageCompression(file, {
          maxWidthOrHeight: 1200,
          maxSizeMB: 1,
          useWebWorker: true,
        });
        const preview = URL.createObjectURL(compressed);
        setImages((prev) => [...prev, { preview, file: compressed }]);
      } catch {
        const preview = URL.createObjectURL(file);
        setImages((prev) => [...prev, { preview, file }]);
      }
    }
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function removeImage(index: number) {
    setImages((prev) => {
      const target = prev[index];
      // 새로 설정된 File이 있는 항목만 blob URL revoke. 기존 이미지는 외부 URL이므로 skip.
      if (target.file) URL.revokeObjectURL(target.preview);
      return prev.filter((_, i) => i !== index);
    });
  }

  function reset() {
    setImages((prev) => {
      prev.forEach((img) => {
        if (img.file) URL.revokeObjectURL(img.preview);
      });
      return [];
    });
    setTitle("");
    setContent("");
    setZone("");
    setCustomZone("");
    setBlock("");
    setRow("");
    setSeat("");
    setTeamSlugs([]);
    setTaggedPlayers([]);
  }

  async function handleSubmit() {
    if (!content.trim() || submittingRef.current) return; // 제목 제거 → 본문만 필수
    if (seatTipMode && !effectiveZone) return; // 구역 필수
    // 최소 1팀 태그 — 버튼 disabled 우회(Enter 제출 등) 방어.
    if (enableTags && !seatTipMode && !hasRequiredTeamTag(teamSlugs)) return;

    submittingRef.current = true;
    setSubmitting(true);
    try {
      const seatInfo: SeatInfo | undefined = seatTipMode && effectiveZone
        ? {
            zone: effectiveZone,
            ...(block.trim() ? { block: block.trim() } : {}),
            ...(row.trim() ? { row: row.trim() } : {}),
            ...(seat.trim() ? { seat: seat.trim() } : {}),
          }
        : undefined;

      // 이미지 업로드 — 기존 URL + 새로 첨부된 파일 혼합 처리
      let imageUrls: string[] = [];
      if (seatTipMode && images.length > 0) {
        const existingUrls = images.flatMap((img) => (img.existingUrl ? [img.existingUrl] : []));
        const filesToUpload = images.flatMap((img) => (img.file ? [img.file] : []));
        const uploadedUrls = filesToUpload.length > 0 ? await uploadImages(filesToUpload) : [];
        imageUrls = [...existingUrls, ...uploadedUrls];
      }

      const tags: PostTags | undefined = enableTags
        ? {
            teamTags: teamSlugs,
            playerTags: taggedPlayers.map((p) => formatPlayerTag(p.kboId, p.name)),
          }
        : undefined;

      if (onSubmit) await onSubmit(title.trim(), content.trim(), imageUrls, seatInfo, tags);
    } catch (e: unknown) {
      alert("등록 실패: " + ((e as Error).message || JSON.stringify(e)));
      submittingRef.current = false;
      setSubmitting(false);
      return;
    }
    submittingRef.current = false;
    setSubmitting(false);
    onClose();
    reset();
  }

  // 게시글은 **명시적 team_tags 1개 이상** 필수(하린아빠 2026-08-06 / 삼순 정정).
  // 선수 태그의 소속팀은 이 필수조건을 대신하지 않는다.
  // 좌석팁(seatTipMode)은 태그 피커 자체가 안 떴니 적용 제외.
  const hasTeamScope = hasRequiredTeamTag(teamSlugs);
  const teamScopeOk = !enableTags || seatTipMode || hasTeamScope;
  const canSubmit = content.trim() && (!seatTipMode || effectiveZone) && teamScopeOk;

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-black/60"
            onClick={onClose}
          />
          <motion.div
            initial={{ y: "100%" }}
            animate={{ y: 0 }}
            exit={{ y: "100%" }}
            transition={{ type: "spring", damping: 30, stiffness: 300 }}
            className="fixed inset-0 z-50 bg-bg-primary overflow-y-auto flex flex-col"
          >
            <div className="flex items-center justify-between px-5 py-3" style={{ paddingTop: "max(env(safe-area-inset-top, 0px), 12px)" }}>
              <button onClick={onClose} className="text-text-secondary p-1">
                <X size={24} />
              </button>
              <h2 className="text-lg font-semibold text-text-primary">
                {seatTipMode ? (teamName ? `${teamName} 글쓰기` : "글쓰기") : "일반글 작성"}
              </h2>
              <button
                onClick={handleSubmit}
                disabled={!canSubmit || submitting}
                className="rounded-full bg-accent px-4 py-1.5 text-base font-semibold text-white disabled:opacity-40 transition-opacity"
              >
                {submitting ? `${submitText ?? "등록"} 중...` : (submitText ?? "등록")}
              </button>
            </div>
            <div className="px-5 pb-8 space-y-4">
              {/* 좌석팁: 구역/좌석 입력 */}
              {seatTipMode && (
                <div className="space-y-3">
                  <div className="relative">
                    <select
                      value={zone}
                      onChange={(e) => setZone(e.target.value)}
                      className="w-full appearance-none rounded-xl bg-bg-tertiary px-5 py-4 pr-10 text-base text-text-primary outline-none"
                    >
                      <option value="" disabled>대략 위치 선택 *</option>
                      {zones?.map((z) => (
                        <option key={z} value={z}>{z}</option>
                      ))}
                      <option value="__custom__">기타 (직접 입력)</option>
                    </select>
                    <ChevronDown size={18} className="absolute right-4 top-1/2 -translate-y-1/2 text-text-tertiary pointer-events-none" />
                  </div>
                  {isCustomZone && (
                    <input
                      type="text"
                      placeholder="구역명을 입력하세요 (예: VIP석, 파티데크)"
                      value={customZone}
                      onChange={(e) => setCustomZone(e.target.value)}
                      maxLength={30}
                      className="w-full rounded-xl bg-bg-tertiary px-5 py-4 text-base text-text-primary placeholder:text-text-tertiary outline-none"
                    />
                  )}
                  <div className="flex gap-2">
                    <input
                      type="text"
                      placeholder="블록 (선택)"
                      value={block}
                      onChange={(e) => setBlock(e.target.value)}
                      maxLength={10}
                      className="min-w-0 flex-1 rounded-xl bg-bg-tertiary px-4 py-3 text-sm text-text-primary placeholder:text-text-tertiary outline-none"
                    />
                    <input
                      type="text"
                      placeholder="열 (선택)"
                      value={row}
                      onChange={(e) => setRow(e.target.value)}
                      maxLength={10}
                      className="min-w-0 flex-1 rounded-xl bg-bg-tertiary px-4 py-3 text-sm text-text-primary placeholder:text-text-tertiary outline-none"
                    />
                    <input
                      type="text"
                      placeholder="좌석 (선택)"
                      value={seat}
                      onChange={(e) => setSeat(e.target.value)}
                      maxLength={10}
                      className="min-w-0 flex-1 rounded-xl bg-bg-tertiary px-4 py-3 text-sm text-text-primary placeholder:text-text-tertiary outline-none"
                    />
                  </div>
                </div>
              )}

              {/* 제목 필드 제거(V3 §6) — 피드가 제목/본문 구분 없는 통합 형식. 본문만 입력. */}
              <textarea
                placeholder={seatTipMode ? "좌석 팁을 작성해주세요 (시야, 그늘, 통로/벽, 음식 접근성 등)" : "내용을 입력하세요"}
                value={content}
                onChange={(e) => setContent(e.target.value)}
                className="w-full min-h-[200px] resize-none rounded-xl bg-bg-tertiary px-5 py-4 text-base text-text-primary placeholder:text-text-tertiary outline-none"
              />

              {/* ② 일반글: 본문에 OG 링크 입력 시 즉시 미리보기 (좌석팁 제외) */}
              {!seatTipMode && <LinkPreview text={linkPreviewText} maxPreviews={1} />}

              {/* V3 태그 피커 — 팀·선수 복수태그 (enableTags, 좌석팁 제외) */}
              {enableTags && !seatTipMode && (
                <div className="space-y-4">
                  <TeamTagger
                    selectedSlugs={teamSlugs}
                    onToggle={(slug) =>
                      setTeamSlugs((prev) =>
                        prev.includes(slug) ? prev.filter((s) => s !== slug) : [...prev, slug],
                      )
                    }
                    onSetAll={setTeamSlugs}
                  />
                  {!hasTeamScope && (
                    <p className="text-xs text-[#FF453A]">팀을 최소 1개 선택해주세요 (모든 팀에 공개하려면 ‘전체 선택’).</p>
                  )}
                  <PlayerTagger
                    game={null}
                    selectedPlayers={taggedPlayers}
                    onToggle={(player) =>
                      setTaggedPlayers((prev) =>
                        prev.some((p) => p.kboId === player.kboId)
                          ? prev.filter((p) => p.kboId !== player.kboId)
                          : [...prev, player],
                      )
                    }
                  />
                </div>
              )}

              {/* 이미지 첨부 — 좌석팁에서 활성화 */}
              {seatTipMode && (
                <>
                  {images.length > 0 && (
                    <div className="flex gap-2 overflow-x-auto pb-1">
                      {images.map((img, i) => (
                        <div key={i} className="relative flex-shrink-0 w-20 h-20 rounded-lg overflow-hidden">
                          <Image src={img.preview} alt="" fill className="object-cover" />
                          <button
                            onClick={() => removeImage(i)}
                            className="absolute -top-1 -right-1 bg-black/70 rounded-full p-0.5"
                          >
                            <XCircle size={18} className="text-white" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    multiple
                    onChange={handleImageSelect}
                    className="hidden"
                  />
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    disabled={images.length >= MAX_IMAGES}
                    className="flex items-center gap-4 rounded-xl bg-bg-tertiary px-5 py-4 text-base text-text-secondary hover:text-text-primary transition-colors disabled:opacity-40"
                  >
                    <ImageIcon size={22} />
                    사진 첨부 ({images.length}/{MAX_IMAGES})
                  </button>
                </>
              )}
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
