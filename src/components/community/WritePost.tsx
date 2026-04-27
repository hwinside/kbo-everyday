"use client";

import { useState, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, Image as ImageIcon, XCircle, ChevronDown } from "lucide-react";
import Image from "next/image";
import imageCompression from "browser-image-compression";
import { uploadImages, computeImageHashes } from "@/lib/supabase/usePosts";

export interface SeatInfo {
  zone: string;
  block?: string;
  row?: string;
  seat?: string;
}

interface WritePostProps {
  isOpen: boolean;
  onClose: () => void;
  teamName?: string;
  onSubmit?: (title: string, content: string, imageUrls: string[], seatInfo?: SeatInfo) => Promise<void>;
  /** 좌석팁 모드: 구역/좌석 입력 + 이미지 첨부 활성화 */
  seatTipMode?: boolean;
  /** 구장별 구역 목록 (드롭다운 선택지) */
  zones?: string[];
}

const MAX_IMAGES = 3;

export default function WritePost({ isOpen, onClose, teamName, onSubmit, seatTipMode, zones }: WritePostProps) {
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [images, setImages] = useState<{preview: string; file: File}[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 좌석팁 구조화 필드
  const [zone, setZone] = useState("");
  const [customZone, setCustomZone] = useState("");
  const [block, setBlock] = useState("");
  const [row, setRow] = useState("");
  const [seat, setSeat] = useState("");

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
      URL.revokeObjectURL(prev[index].preview);
      return prev.filter((_, i) => i !== index);
    });
  }

  function reset() {
    setTitle("");
    setContent("");
    setImages([]);
    setZone("");
    setCustomZone("");
    setBlock("");
    setRow("");
    setSeat("");
  }

  async function handleSubmit() {
    if (!title.trim() || !content.trim() || submittingRef.current) return;
    if (seatTipMode && !effectiveZone) return; // 구역 필수

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

      // 이미지 업로드
      let imageUrls: string[] = [];
      if (seatTipMode && images.length > 0) {
        const files = images.map((img) => img.file);
        imageUrls = await uploadImages(files);
      }

      if (onSubmit) await onSubmit(title.trim(), content.trim(), imageUrls, seatInfo);
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

  const canSubmit = title.trim() && content.trim() && (!seatTipMode || effectiveZone);

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
                {teamName ? `${teamName} 글쓰기` : "글쓰기"}
              </h2>
              <button
                onClick={handleSubmit}
                disabled={!canSubmit || submitting}
                className="rounded-full bg-accent px-4 py-1.5 text-base font-semibold text-white disabled:opacity-40 transition-opacity"
              >
                {submitting ? "등록 중..." : "등록"}
              </button>
            </div>
            <div className="px-5 pb-8 space-y-4 flex-1 flex flex-col">
              {/* 좌석팁: 구역/좌석 입력 */}
              {seatTipMode && (
                <div className="space-y-3">
                  <div className="relative">
                    <select
                      value={zone}
                      onChange={(e) => setZone(e.target.value)}
                      className="w-full appearance-none rounded-xl bg-bg-tertiary px-5 py-4 pr-10 text-base text-text-primary outline-none"
                    >
                      <option value="" disabled>구역 선택 *</option>
                      {zones?.map((z) => (
                        <option key={z} value={z}>{z}</option>
                      ))}
                      <option value="__custom__">직접 입력</option>
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
                      className="flex-1 rounded-xl bg-bg-tertiary px-4 py-3 text-sm text-text-primary placeholder:text-text-tertiary outline-none"
                    />
                    <input
                      type="text"
                      placeholder="열 (선택)"
                      value={row}
                      onChange={(e) => setRow(e.target.value)}
                      maxLength={10}
                      className="flex-1 rounded-xl bg-bg-tertiary px-4 py-3 text-sm text-text-primary placeholder:text-text-tertiary outline-none"
                    />
                    <input
                      type="text"
                      placeholder="좌석 (선택)"
                      value={seat}
                      onChange={(e) => setSeat(e.target.value)}
                      maxLength={10}
                      className="flex-1 rounded-xl bg-bg-tertiary px-4 py-3 text-sm text-text-primary placeholder:text-text-tertiary outline-none"
                    />
                  </div>
                </div>
              )}

              <input
                type="text"
                placeholder="제목"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={100}
                className="w-full rounded-xl bg-bg-tertiary px-5 py-4 text-base text-text-primary placeholder:text-text-tertiary outline-none"
              />
              <textarea
                placeholder={seatTipMode ? "좌석 팁을 작성해주세요 (시야, 그늘, 통로/벽, 음식 접근성 등)" : "내용을 입력하세요"}
                value={content}
                onChange={(e) => setContent(e.target.value)}
                className="w-full flex-1 min-h-[200px] resize-none rounded-xl bg-bg-tertiary px-5 py-4 text-base text-text-primary placeholder:text-text-tertiary outline-none"
              />

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
