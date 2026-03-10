"use client";

import { useState, useRef, useMemo, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, Plus, XCircle, Loader2, ChevronLeft, Pencil, SkipForward } from "lucide-react";
import Image from "next/image";
import imageCompression from "browser-image-compression";
import { createPost, uploadImages } from "@/lib/supabase/usePosts";
import MemeEditor from "@/components/editor/MemeEditor";
import GamePicker, { type PickedGame } from "./GamePicker";
import PlayerTagger from "./PlayerTagger";
import HashtagInput from "./HashtagInput";
import { getTeamById } from "@/lib/constants/teams";

interface WritePhotoPostProps {
  isOpen: boolean;
  onClose: () => void;
  teamName?: string;
  boardType: string;
  boardId: string;
  onSuccess?: () => void;
}

type Step = 1 | 2 | 3;

interface ImageItem {
  preview: string;
  file: File;
  edited: boolean;
}

interface PlayerTag {
  id: number;
  name: string;
  teamId: number;
}

export default function WritePhotoPost({
  isOpen,
  onClose,
  teamName,
  boardType,
  boardId,
  onSuccess,
}: WritePhotoPostProps) {
  const [step, setStep] = useState<Step>(1);
  const [images, setImages] = useState<ImageItem[]>([]);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [caption, setCaption] = useState("");
  const [selectedGame, setSelectedGame] = useState<PickedGame | null>(null);
  const [selectedPlayers, setSelectedPlayers] = useState<PlayerTag[]>([]);
  const [hashtags, setHashtags] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Auto-generated hashtag suggestions
  const autoTags = useMemo(() => {
    const tags: string[] = ["#직관"];
    if (selectedGame) {
      const home = getTeamById(selectedGame.homeTeamId);
      const away = getTeamById(selectedGame.awayTeamId);
      if (home) tags.push(`#${home.shortName}`);
      if (away) tags.push(`#${away.shortName}`);
    }
    selectedPlayers.forEach((p) => tags.push(`#${p.name}`));
    return tags;
  }, [selectedGame, selectedPlayers]);

  function handleImageSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (!files) return;
    const remaining = 3 - images.length;
    Array.from(files)
      .slice(0, remaining)
      .forEach((file) => {
        const preview = URL.createObjectURL(file);
        setImages((prev) => [...prev, { preview, file, edited: false }]);
      });
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function removeImage(index: number) {
    setImages((prev) => {
      URL.revokeObjectURL(prev[index].preview);
      return prev.filter((_, i) => i !== index);
    });
  }

  function handleEditorSave(file: File) {
    if (editingIndex === null) return;
    setImages((prev) =>
      prev.map((img, i) => {
        if (i !== editingIndex) return img;
        URL.revokeObjectURL(img.preview);
        return { preview: URL.createObjectURL(file), file, edited: true };
      })
    );
    setEditingIndex(null);
  }

  const handlePlayerToggle = useCallback((player: PlayerTag) => {
    setSelectedPlayers((prev) => {
      const exists = prev.find((p) => p.id === player.id);
      if (exists) return prev.filter((p) => p.id !== player.id);
      return [...prev, player];
    });
  }, []);

  async function handleSubmit() {
    if (images.length === 0) return;
    setSubmitting(true);

    try {
      const compressed = await Promise.all(
        images.map((img) =>
          imageCompression(img.file, {
            maxWidthOrHeight: 1200,
            maxSizeMB: 1,
            useWebWorker: true,
          })
        )
      );

      const urls = await uploadImages(compressed);

      await createPost({
        boardType,
        boardId,
        title: "",
        content: caption.trim(),
        imageUrls: urls,
        contentType: "photo",
        gameId: selectedGame?.id,
        playerTags: selectedPlayers.map((p) => p.name),
        hashtags: hashtags,
      });

      // Reset & close
      resetState();
      onClose();
      onSuccess?.();
    } catch (e: unknown) {
      alert("업로드 실패: " + ((e as Error).message || JSON.stringify(e)));
    } finally {
      setSubmitting(false);
    }
  }

  function resetState() {
    setStep(1);
    setCaption("");
    images.forEach((img) => URL.revokeObjectURL(img.preview));
    setImages([]);
    setSelectedGame(null);
    setSelectedPlayers([]);
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
            {/* Header */}
            <div
              className="flex items-center justify-between px-4 py-2"
              style={{ paddingTop: "max(env(safe-area-inset-top, 0px), 12px)" }}
            >
              <button onClick={step === 1 ? handleClose : undefined} className="flex items-center gap-0.5 text-text-secondary p-1">
                {step === 1 ? <X size={24} /> : <div className="w-6" />}
              </button>
              <h2 className="text-base font-semibold text-text-primary">
                {teamName ? `${teamName} 사진` : "사진 올리기"}
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
                    <p className="text-sm text-text-secondary">사진을 선택하세요 (최대 3장)</p>

                    <div className="flex gap-3 overflow-x-auto scrollbar-hide pb-1">
                      {images.map((img, i) => (
                        <div key={i} className="relative flex-shrink-0 w-28 h-28 rounded-xl overflow-hidden bg-bg-tertiary">
                          <Image src={img.preview} alt={`preview ${i}`} fill className="object-cover" />
                          <button
                            onClick={() => removeImage(i)}
                            className="absolute top-1 right-1 bg-black/60 rounded-full p-0.5"
                          >
                            <XCircle size={20} className="text-white" />
                          </button>
                          {img.edited && (
                            <div className="absolute bottom-1 left-1 bg-accent/80 rounded-full px-1.5 py-0.5 text-[9px] text-white font-medium">
                              편집됨
                            </div>
                          )}
                        </div>
                      ))}
                      {images.length < 3 && (
                        <button
                          onClick={() => fileInputRef.current?.click()}
                          className="flex-shrink-0 w-28 h-28 rounded-xl bg-bg-tertiary flex flex-col items-center justify-center gap-1 text-text-tertiary hover:text-text-secondary transition-colors"
                        >
                          <Plus size={28} />
                          <span className="text-xs">{images.length}/3</span>
                        </button>
                      )}
                    </div>

                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/*"
                      multiple
                      onChange={handleImageSelect}
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
                      {images.map((img, i) => (
                        <div key={i} className="relative flex-shrink-0">
                          <div className="w-28 h-28 rounded-xl overflow-hidden bg-bg-tertiary">
                            <Image src={img.preview} alt={`preview ${i}`} fill className="object-cover" />
                          </div>
                          <button
                            onClick={() => setEditingIndex(i)}
                            className="absolute inset-0 flex items-center justify-center bg-black/40 rounded-xl"
                          >
                            <Pencil size={24} className="text-white" />
                          </button>
                          {img.edited && (
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
                    <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${Math.min(images.length, 3)}, 1fr)` }}>
                      {images.map((img, i) => (
                        <div key={i} className="relative aspect-square rounded-xl overflow-hidden bg-bg-tertiary">
                          <Image src={img.preview} alt={`thumb ${i}`} fill className="object-cover" />
                          {img.edited && (
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
                  onClick={() => setStep(2)}
                  disabled={images.length === 0}
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
                    disabled={submitting}
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
            {editingIndex !== null && images[editingIndex] && (
              <MemeEditor
                imageUrl={images[editingIndex].preview}
                onSave={handleEditorSave}
                onCancel={() => setEditingIndex(null)}
              />
            )}
          </AnimatePresence>
        </>
      )}
    </AnimatePresence>
  );
}
