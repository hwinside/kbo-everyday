"use client";

import { motion, AnimatePresence } from "framer-motion";
import { ImagePlus, PenLine, BarChart3 } from "lucide-react";

interface WriteEntrySheetProps {
  isOpen: boolean;
  onClose: () => void;
  /** 사진글(이미지·동영상 중심) 선택 */
  onChoosePhoto: () => void;
  /** 일반글(텍스트 중심) 선택 */
  onChooseText: () => void;
  /** 투표글 선택. 주지 않으면 투표 진입 버튼을 숨긴다(점진적 롤아웃). */
  onChoosePoll?: () => void;
}

/**
 * ⑦ 글쓰기 진입 첫 화면 — 사진글/일반글 타입 선택.
 * 통합 피드라 작성 폼이 곧장 뜨면 "일반글만 쓰는 화면"으로 오인되므로,
 * FAB 탭 시 타입부터 고르게 한 뒤 해당 컴포저(WritePhotoPost/WritePost)로 분기한다.
 */
export default function WriteEntrySheet({ isOpen, onClose, onChoosePhoto, onChooseText, onChoosePoll }: WriteEntrySheetProps) {
  if (!isOpen) return null;

  return (
    <AnimatePresence>
      <motion.div
        className="fixed inset-0 z-[10000] flex items-end"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
      >
        <div className="absolute inset-0 bg-black/60" onClick={onClose} />
        <motion.div
          className="relative w-full max-w-lg mx-auto bg-bg-secondary rounded-t-3xl"
          initial={{ y: "100%" }}
          animate={{ y: 0 }}
          exit={{ y: "100%" }}
          transition={{ type: "spring", damping: 25 }}
        >
          <div className="px-5 py-4 border-b border-border">
            <h2 className="text-lg font-bold text-text-primary">어떤 글을 쓸까요?</h2>
          </div>
          <div className={`px-5 py-4 grid ${onChoosePoll ? "grid-cols-3" : "grid-cols-2"} gap-3 pb-[calc(1rem+var(--safe-area-inset-bottom, env(safe-area-inset-bottom)))]`}>
            <button
              onClick={onChoosePhoto}
              className="flex flex-col items-center gap-2 p-5 rounded-2xl bg-bg-tertiary active:scale-95 transition-transform"
            >
              <ImagePlus size={28} className="text-accent" />
              <span className="text-sm font-semibold text-text-primary">사진글</span>
              <span className="text-xs text-text-tertiary">이미지·동영상</span>
            </button>
            <button
              onClick={onChooseText}
              className="flex flex-col items-center gap-2 p-5 rounded-2xl bg-bg-tertiary active:scale-95 transition-transform"
            >
              <PenLine size={28} className="text-accent" />
              <span className="text-sm font-semibold text-text-primary">일반글</span>
              <span className="text-xs text-text-tertiary">텍스트 중심</span>
            </button>
            {onChoosePoll && (
              <button
                onClick={onChoosePoll}
                className="flex flex-col items-center gap-2 p-5 rounded-2xl bg-bg-tertiary active:scale-95 transition-transform"
              >
                <BarChart3 size={28} className="text-accent" />
                <span className="text-sm font-semibold text-text-primary">투표</span>
                <span className="text-xs text-text-tertiary">팀·선수·기타</span>
              </button>
            )}
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
