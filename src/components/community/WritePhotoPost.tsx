"use client";

import { useState, useRef, useMemo, useCallback, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, Plus, XCircle, Loader2, ChevronLeft, Pencil, SkipForward, Play } from "lucide-react";
import Image from "next/image";
import imageCompression from "browser-image-compression";
import { createPost, uploadImages, uploadVideos, computeImageHashes } from "@/lib/supabase/usePosts";
import MemeEditor from "@/components/editor/MemeEditor";
import GamePicker, { type PickedGame } from "./GamePicker";
import PlayerTagger from "./PlayerTagger";
import TeamTagger from "./TeamTagger";
import { hasRequiredTeamTag, isAllTeamsSelected } from "@/lib/utils/post-scope";
import { useAllTeamsScopeConfirm } from "./useAllTeamsScopeConfirm";
import HashtagInput from "./HashtagInput";
import { getTeamById, TEAMS } from "@/lib/constants/teams";
import { formatPlayerTag } from "@/lib/utils/player-tags";
import { useAuth } from "@/lib/supabase/AuthContext";

interface WritePhotoPostProps {
  isOpen: boolean;
  onClose: () => void;
  teamName?: string;
  boardType: string;
  boardId: string;
  defaultPlayerTag?: { kboId: string; name: string; teamId: number };
  /** V3 팀태그 초기값(보통 글이 속한 팀 슬러그). 사진 글도 팀 피드에 노출되도록 team_tags 부여. */
  defaultTeamSlugs?: string[];
  onSuccess?: () => void;
}

type Step = 1 | 2 | 3;

interface MediaItem {
  preview: string;
  file: File;
  edited: boolean;
  type: "image" | "video";
}

interface PlayerTag {
  kboId: string;
  name: string;
  teamId: number;
}

const MAX_MEDIA_ITEMS = 5;

export default function WritePhotoPost({
  isOpen,
  onClose,
  boardType,
  boardId,
  defaultPlayerTag,
  defaultTeamSlugs,
  onSuccess,
}: WritePhotoPostProps) {
  const [step, setStep] = useState<Step>(1);
  const [media, setMedia] = useState<MediaItem[]>([]);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [caption, setCaption] = useState("");
  const [selectedGame, setSelectedGame] = useState<PickedGame | null>(null);
  const [selectedPlayers, setSelectedPlayers] = useState<PlayerTag[]>(
    defaultPlayerTag ? [defaultPlayerTag] : []
  );
  const [teamSlugs, setTeamSlugs] = useState<string[]>(defaultTeamSlugs ?? []);
  // 전체공개(10구단 전부 선택) 시 예/아니요 확인창.
  const { confirmAllTeamsScope, allTeamsScopeDialog } = useAllTeamsScopeConfirm();
  const [hashtags, setHashtags] = useState<string[]>([]);
  // 게시글은 **명시적 team_tags 1개 이상** 필수(하린아빠 2026-08-06 / 삼순 정정).
  // 선수 태그의 소속팀은 이 필수조건을 대신하지 않는다.
  const hasTeamScope = hasRequiredTeamTag(teamSlugs);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const [toast, setToast] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Sync defaultPlayerTag when modal opens or player changes
  useEffect(() => {
    if (isOpen && defaultPlayerTag) {
      setSelectedPlayers((prev) => {
        const already = prev.some((p) => p.kboId === defaultPlayerTag.kboId);
        return already ? prev : [defaultPlayerTag, ...prev];
      });
    }
  }, [isOpen, defaultPlayerTag]);

  // Sync defaultTeamSlugs when modal opens (preselect 글이 속한 팀)
  useEffect(() => {
    if (isOpen && defaultTeamSlugs?.length) {
      setTeamSlugs((prev) => {
        const merged = [...prev];
        defaultTeamSlugs.forEach((s) => {
          if (!merged.includes(s)) merged.push(s);
        });
        return merged;
      });
    }
  }, [isOpen, defaultTeamSlugs]);

  // 최애팀(profile.team_id) — board 컨텍스트(defaultTeamSlugs)가 없을 때만 기본 선택(해제 가능).
  const { profile } = useAuth();
  const favoriteSlug = (() => {
    const id = (profile as Record<string, unknown> | null)?.team_id as number | undefined;
    return id ? getTeamById(id)?.slug : undefined;
  })();
  useEffect(() => {
    if (isOpen && !defaultTeamSlugs?.length && favoriteSlug) {
      setTeamSlugs((prev) => (prev.length ? prev : [favoriteSlug]));
    }
  }, [isOpen, defaultTeamSlugs, favoriteSlug]);

  const handleTeamToggle = useCallback((slug: string) => {
    setTeamSlugs((prev) =>
      prev.includes(slug) ? prev.filter((s) => s !== slug) : [...prev, slug]
    );
  }, []);

  // Team → stadium mapping
  const TEAM_STADIUMS: Record<number, string> = {
    1: "잠실야구장", 2: "잠실야구장", 3: "수원KT위즈파크",
    4: "인천SSG랜더스필드", 5: "창원NC파크", 6: "광주기아챔피언스필드",
    7: "사직야구장", 8: "대구삼성라이온즈파크", 9: "대전한화생명볼파크", 10: "고척스카이돔",
  };

  // Auto-generated hashtag suggestions (team context-aware)
  const autoTags = useMemo(() => {
    const tags: string[] = [];
    // If a game is selected, use home/away teams
    if (selectedGame) {
      const home = getTeamById(selectedGame.homeTeamId);
      const away = getTeamById(selectedGame.awayTeamId);
      if (home) tags.push(`#${home.shortName}`);
      if (away) tags.push(`#${away.shortName}`);
      const stadium = TEAM_STADIUMS[selectedGame.homeTeamId];
      if (stadium) tags.push(`#${stadium}`);
    }
    // Board context tags (team/player board)
    if (!selectedGame && boardType === "team") {
      // Try to resolve teamId from boardId (slug)
      const team = TEAMS.find((t) => t.slug === boardId);
      if (team) {
        tags.push(`#${team.shortName}`);
        const stadium = TEAM_STADIUMS[team.id];
        if (stadium) tags.push(`#${stadium}`);
      }
    }
    tags.push("#직관", "#KBO");
    selectedPlayers.forEach((p) => tags.push(`#${p.name}`));
    // Dedupe
    return [...new Set(tags)];
  }, [selectedGame, selectedPlayers, boardType, boardId]);

  async function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (!files) return;
    const remaining = MAX_MEDIA_ITEMS - media.length;
    const selected = Array.from(files).slice(0, remaining);

    for (const file of selected) {
      const isVideo = file.type === "video/mp4";
      const isGif = file.type === "image/gif";

      // 모든 파일 20MB 제한 (선택 시점 즉시 차단)
      if (file.size > 20 * 1024 * 1024) {
        setToast("파일 크기가 20MB를 초과했어요. 20MB 이하만 업로드 가능합니다.");
        continue;
      }

      if (isVideo) {
        try {
          await checkVideoDuration(file);
        } catch (err) {
          setToast((err as Error).message);
          continue;
        }
      }

      const preview = URL.createObjectURL(file);
      const type: "image" | "video" = isVideo ? "video" : "image";
      setMedia((prev) => [...prev, { preview, file, edited: false, type }]);
    }
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function checkVideoDuration(file: File): Promise<void> {
    return new Promise((resolve, reject) => {
      const video = document.createElement("video");
      video.preload = "metadata";
      video.src = URL.createObjectURL(file);
      video.onloadedmetadata = () => {
        URL.revokeObjectURL(video.src);
        if (video.duration > 15) {
          reject(new Error("15초 이하 영상만 업로드 가능합니다"));
        } else {
          resolve();
        }
      };
      video.onerror = () => {
        URL.revokeObjectURL(video.src);
        reject(new Error("영상 파일을 읽을 수 없습니다"));
      };
    });
  }

  function removeMedia(index: number) {
    setMedia((prev) => {
      URL.revokeObjectURL(prev[index].preview);
      return prev.filter((_, i) => i !== index);
    });
  }

  function handleEditorSave(file: File) {
    if (editingIndex === null) return;
    setMedia((prev) =>
      prev.map((item, i) => {
        if (i !== editingIndex) return item;
        URL.revokeObjectURL(item.preview);
        return { preview: URL.createObjectURL(file), file, edited: true, type: item.type };
      })
    );
    setEditingIndex(null);
  }

  const handlePlayerToggle = useCallback((player: PlayerTag) => {
    setSelectedPlayers((prev) => {
      const exists = prev.find((p) => p.kboId === player.kboId);
      if (exists) return prev.filter((p) => p.kboId !== player.kboId);
      return [...prev, player];
    });
  }, []);

  async function handleSubmit() {
    if (media.length === 0 || submittingRef.current) return;
    // 최소 1팀 태그 — 버튼 disabled 우회 방어.
    if (!hasRequiredTeamTag(teamSlugs)) return;

    // 전체공개(10구단 전부 선택) 시도 → 확인창. 예=그대로 등록 / 아니요=초안 유지 + 최애팀 1개 축소.
    if (isAllTeamsSelected(teamSlugs)) {
      const yes = await confirmAllTeamsScope();
      if (!yes) {
        if (favoriteSlug) setTeamSlugs([favoriteSlug]);
        return; // 등록하지 않고 작성중 유지.
      }
    }

    submittingRef.current = true;
    setSubmitting(true);

    try {
      const imageItems = media.filter((m) => m.type === "image");
      const videoItems = media.filter((m) => m.type === "video");

      let imageUrls: string[] = [];
      let videoUrls: string[] = [];
      let imageHashes: string[] = [];

      if (imageItems.length > 0) {
        // GIF는 압축하면 애니메이션이 깨지므로 원본 업로드
        const gifItems = imageItems.filter((m) => m.file.type === "image/gif");
        const nonGifItems = imageItems.filter((m) => m.file.type !== "image/gif");

        const compressed = await Promise.all(
          nonGifItems.map((img) =>
            imageCompression(img.file, {
              maxWidthOrHeight: 1200,
              maxSizeMB: 1,
              useWebWorker: true,
            })
          )
        );
        const allImageFiles = [...compressed, ...gifItems.map((g) => g.file)];
        imageUrls = await uploadImages(allImageFiles);
        imageHashes = await computeImageHashes(allImageFiles);
      }

      if (videoItems.length > 0) {
        videoUrls = await uploadVideos(videoItems.map((v) => v.file));
      }

      await createPost({
        boardType,
        boardId,
        title: "",
        content: caption.trim(),
        imageUrls,
        videoUrls,
        imageHashes,
        contentType: "photo",
        gameId: selectedGame?.id,
        teamTags: teamSlugs,
        playerTags: selectedPlayers.map((p) => formatPlayerTag(p.kboId, p.name)),
        hashtags: hashtags,
      });

      resetState();
      onClose();
      onSuccess?.();
    } catch (e: unknown) {
      const msg = (e as Error).message || JSON.stringify(e);
      if (msg.includes("이미 올린 사진")) {
        setToast("이미 올린 사진이에요. 다른 사진을 선택해 주세요.");
      } else if (msg.includes("exceeded") || msg.includes("maximum")) {
        setToast("파일 크기가 제한을 초과했어요. 20MB 이하만 업로드 가능합니다.");
      } else {
        setToast("업로드 실패: " + msg);
      }
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  function resetState() {
    setStep(1);
    setCaption("");
    media.forEach((m) => URL.revokeObjectURL(m.preview));
    setMedia([]);
    setSelectedGame(null);
    setSelectedPlayers(defaultPlayerTag ? [defaultPlayerTag] : []);
    setTeamSlugs(defaultTeamSlugs ?? []);
    setHashtags([]);
    setEditingIndex(null);
  }

  function handleClose() {
    resetState();
    onClose();
  }

  function goBack() {
    if (step === 1) {
      handleClose();
    } else {
      setStep((s) => (s - 1) as Step);
    }
  }

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[59] bg-black/60"
            onClick={handleClose}
          />
          <motion.div
            initial={{ y: "100%" }}
            animate={{ y: 0 }}
            exit={{ y: "100%" }}
            transition={{ type: "spring", damping: 30, stiffness: 300 }}
            className="fixed inset-0 z-[60] bg-bg-primary overflow-y-auto flex flex-col"
          >
            {/* Toast */}
            <AnimatePresence>
              {toast && (
                <motion.div
                  initial={{ opacity: 0, y: -20 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -20 }}
                  className="fixed top-12 left-4 right-4 z-[70] bg-red-500 text-white text-sm font-medium px-4 py-3 rounded-xl shadow-lg text-center"
                  onAnimationComplete={() => { setTimeout(() => setToast(null), 3000); }}
                >
                  {toast}
                </motion.div>
              )}
            </AnimatePresence>
            {/* Header */}
            <div
              className="flex items-center justify-between px-4 py-2"
              style={{ paddingTop: "max(env(safe-area-inset-top, 0px), 12px)" }}
            >
              <button onClick={step === 1 ? handleClose : undefined} className="flex items-center gap-0.5 text-text-secondary p-1">
                {step === 1 ? <X size={24} /> : <div className="w-6" />}
              </button>
              <h2 className="text-lg font-semibold text-text-primary">
                사진글 작성
              </h2>
              <div className="w-10" />
            </div>

            {/* Step indicator */}
            <div className="flex justify-center gap-2 pb-3">
              {[1, 2, 3].map((s) => (
                <div
                  key={s}
                  className={`w-2 h-2 rounded-full transition-colors ${
                    s === step ? "bg-accent" : s < step ? "bg-accent/40" : "bg-bg-tertiary"
                  }`}
                />
              ))}
            </div>

            {/* Step content */}
            <div className="flex-1 px-5 flex flex-col">
              <AnimatePresence mode="wait">
                {step === 1 && (
                  <motion.div
                    key="step1"
                    initial={{ opacity: 0, x: -20 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: 20 }}
                    className="flex-1 flex flex-col space-y-4"
                  >
                    <p className="text-sm text-text-secondary">사진 · 영상을 선택하세요 (최대 {MAX_MEDIA_ITEMS}개, 영상 15초/20MB)</p>

                    <div className="flex gap-3 overflow-x-auto scrollbar-hide pb-1">
                      {media.map((item, i) => (
                        <div key={i} className="relative flex-shrink-0 w-28 h-28 rounded-xl overflow-hidden bg-bg-tertiary">
                          {item.type === "video" ? (
                            <>
                              <video src={item.preview} className="w-full h-full object-cover" muted playsInline />
                              <div className="absolute inset-0 flex items-center justify-center">
                                <div className="w-8 h-8 rounded-full bg-black/50 flex items-center justify-center">
                                  <Play size={16} className="text-white ml-0.5" fill="white" />
                                </div>
                              </div>
                            </>
                          ) : (
                            <Image src={item.preview} alt={`preview ${i}`} fill className="object-cover" />
                          )}
                          <button
                            onClick={() => removeMedia(i)}
                            className="absolute top-1 right-1 bg-black/60 rounded-full p-0.5"
                          >
                            <XCircle size={20} className="text-white" />
                          </button>
                          {item.edited && (
                            <div className="absolute bottom-1 left-1 bg-accent/80 rounded-full px-1.5 py-0.5 text-[9px] text-white font-medium">
                              편집됨
                            </div>
                          )}
                        </div>
                      ))}
                      {media.length < MAX_MEDIA_ITEMS && (
                        <button
                          onClick={() => fileInputRef.current?.click()}
                          className="flex-shrink-0 w-28 h-28 rounded-xl bg-bg-tertiary flex flex-col items-center justify-center gap-1 text-text-tertiary hover:text-text-secondary transition-colors"
                        >
                          <Plus size={28} />
                          <span className="text-xs">{media.length}/{MAX_MEDIA_ITEMS}</span>
                        </button>
                      )}
                    </div>

                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/*,video/mp4"
                      multiple
                      onChange={handleFileSelect}
                      className="hidden"
                    />
                  </motion.div>
                )}

                {step === 2 && (
                  <motion.div
                    key="step2"
                    initial={{ opacity: 0, x: -20 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: 20 }}
                    className="flex-1 flex flex-col space-y-4"
                  >
                    <p className="text-sm text-text-secondary">밈 편집 (선택사항)</p>

                    <div className="flex gap-3 overflow-x-auto scrollbar-hide pb-1">
                      {media.map((item, i) => (
                        <div key={i} className="relative flex-shrink-0">
                          <div className="w-28 h-28 rounded-xl overflow-hidden bg-bg-tertiary">
                            {item.type === "video" ? (
                              <video src={item.preview} className="w-full h-full object-cover" muted playsInline />
                            ) : (
                              <Image src={item.preview} alt={`preview ${i}`} fill className="object-cover" />
                            )}
                          </div>
                          {item.type === "image" ? (
                            <button
                              onClick={() => setEditingIndex(i)}
                              className="absolute inset-0 flex items-center justify-center bg-black/40 rounded-xl"
                            >
                              <Pencil size={24} className="text-white" />
                            </button>
                          ) : (
                            <div className="absolute inset-0 flex items-center justify-center">
                              <div className="w-8 h-8 rounded-full bg-black/50 flex items-center justify-center">
                                <Play size={16} className="text-white ml-0.5" fill="white" />
                              </div>
                            </div>
                          )}
                          {item.edited && (
                            <div className="absolute bottom-1 left-1 bg-accent/80 rounded-full px-1.5 py-0.5 text-[9px] text-white font-medium">
                              편집됨
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </motion.div>
                )}

                {step === 3 && (
                  <motion.div
                    key="step3"
                    initial={{ opacity: 0, x: -20 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: 20 }}
                    className="flex-1 flex flex-col space-y-5 pb-4"
                  >
                    {/* Thumbnail preview — sized so 3 fit in one row */}
                    <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${Math.min(media.length, 3)}, 1fr)` }}>
                      {media.map((item, i) => (
                        <div key={i} className="relative aspect-square rounded-xl overflow-hidden bg-bg-tertiary">
                          {item.type === "video" ? (
                            <>
                              <video src={item.preview} className="w-full h-full object-cover" muted playsInline />
                              <div className="absolute inset-0 flex items-center justify-center">
                                <div className="w-8 h-8 rounded-full bg-black/50 flex items-center justify-center">
                                  <Play size={16} className="text-white ml-0.5" fill="white" />
                                </div>
                              </div>
                            </>
                          ) : (
                            <Image src={item.preview} alt={`thumb ${i}`} fill className="object-cover" />
                          )}
                          {item.edited && (
                            <div className="absolute bottom-1 left-1 bg-accent/80 rounded-full px-1.5 py-0.5 text-[9px] text-white font-medium">
                              편집됨
                            </div>
                          )}
                        </div>
                      ))}
                    </div>

                    {/* Body text */}
                    <div>
                      <p className="text-sm font-medium text-text-secondary mb-2">본문</p>
                      <textarea
                        placeholder="사진에 대해 적어보세요"
                        value={caption}
                        onChange={(e) => setCaption(e.target.value)}
                        rows={4}
                        className="w-full resize-none rounded-xl bg-bg-tertiary px-4 py-3 text-sm text-text-primary placeholder:text-text-tertiary outline-none"
                      />
                    </div>

                    {/* Game picker */}
                    <GamePicker
                      selectedGameId={selectedGame?.id ?? null}
                      onSelect={setSelectedGame}
                    />

                    {/* Team tagger — 사진 글도 팀 피드에 노출되도록 팀태그 부여. 최소 1팀 필수(2026-08-06). */}
                    <TeamTagger
                      selectedSlugs={teamSlugs}
                      onToggle={handleTeamToggle}
                    />
                    {!hasTeamScope && (
                      <p className="text-xs text-[#FF453A]">팀을 최소 1개 선택해주세요 (모든 팀에 공개하려면 10개 구단을 모두 선택).</p>
                    )}

                    {/* Player tagger */}
                    <PlayerTagger
                      game={selectedGame}
                      selectedPlayers={selectedPlayers}
                      onToggle={handlePlayerToggle}
                    />

                    {/* Hashtag input */}
                    <HashtagInput
                      autoTags={autoTags}
                      tags={hashtags}
                      onUpdate={setHashtags}
                    />
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            {/* Fixed bottom action bar */}
            <div
              className="sticky bottom-0 px-5 pt-3 pb-3 bg-bg-primary border-t border-border"
              style={{ paddingBottom: "max(env(safe-area-inset-bottom, 0px), 12px)" }}
            >
              {step === 1 && (
                <button
                  onClick={() => {
                    // 편집 가능한 이미지가 없으면 밈 편집 스킵 (GIF도 편집 불가)
                    const hasEditableImages = media.some((m) => m.type === "image" && m.file.type !== "image/gif");
                    setStep(hasEditableImages ? 2 : 3);
                  }}
                  disabled={media.length === 0}
                  className="w-full rounded-xl bg-accent py-3.5 text-base font-semibold text-white disabled:opacity-40 transition-opacity"
                >
                  다음
                </button>
              )}
              {step === 2 && (
                <div className="flex gap-3">
                  <button
                    onClick={goBack}
                    className="rounded-xl bg-bg-tertiary py-3.5 px-5 text-base font-medium text-text-secondary flex items-center justify-center gap-1"
                  >
                    <ChevronLeft size={18} />
                    이전
                  </button>
                  <button
                    onClick={() => setStep(3)}
                    className="flex-1 rounded-xl bg-bg-tertiary py-3.5 text-base font-medium text-text-secondary flex items-center justify-center gap-2"
                  >
                    <SkipForward size={18} />
                    건너뛰기
                  </button>
                  <button
                    onClick={() => setStep(3)}
                    className="flex-1 rounded-xl bg-accent py-3.5 text-base font-semibold text-white"
                  >
                    다음
                  </button>
                </div>
              )}
              {step === 3 && (
                <div className="flex gap-3">
                  <button
                    onClick={goBack}
                    className="rounded-xl bg-bg-tertiary py-3.5 px-5 text-base font-medium text-text-secondary flex items-center justify-center gap-1"
                  >
                    <ChevronLeft size={18} />
                    이전
                  </button>
                  <button
                    onClick={handleSubmit}
                    disabled={submitting || !hasTeamScope}
                    className="flex-1 rounded-xl bg-accent py-3.5 text-base font-semibold text-white disabled:opacity-40 transition-opacity flex items-center justify-center gap-2"
                  >
                    {submitting && <Loader2 size={18} className="animate-spin" />}
                    게시하기
                  </button>
                </div>
              )}
            </div>
          </motion.div>

          {/* Meme Editor overlay */}
          <AnimatePresence>
            {editingIndex !== null && media[editingIndex] && media[editingIndex].type === "image" && (
              <MemeEditor
                imageUrl={media[editingIndex].preview}
                onSave={handleEditorSave}
                onCancel={() => setEditingIndex(null)}
              />
            )}
          </AnimatePresence>
          {allTeamsScopeDialog}
        </>
      )}
    </AnimatePresence>
  );
}
