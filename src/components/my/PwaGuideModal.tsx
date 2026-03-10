"use client";

import { motion } from "framer-motion";

interface PwaGuideModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function PwaGuideModal({ isOpen, onClose }: PwaGuideModalProps) {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-5" onClick={onClose}>
      <motion.div
        initial={{ scale: 0.9, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        className="w-full max-w-sm rounded-2xl bg-bg-secondary p-6"
        onClick={e => e.stopPropagation()}
      >
        <div className="text-center">
          <p className="text-3xl mb-3">📲</p>
          <h3 className="text-lg font-bold text-text-primary mb-2">홈 화면에 추가해주세요!</h3>
          <p className="text-sm text-text-secondary mb-4">
            앱처럼 사용하고 푸시 알림도 받을 수 있어요
          </p>
          <div className="glass-card p-4 text-left space-y-3 mb-5">
            <div className="flex items-center gap-3">
              <span className="flex-shrink-0 w-6 h-6 rounded-full bg-accent flex items-center justify-center text-xs font-bold text-white">1</span>
              <p className="text-sm text-text-primary">하단 공유 버튼 <span className="inline-block w-5 h-5 text-center">⎋</span> 탭</p>
            </div>
            <div className="flex items-center gap-3">
              <span className="flex-shrink-0 w-6 h-6 rounded-full bg-accent flex items-center justify-center text-xs font-bold text-white">2</span>
              <p className="text-sm text-text-primary">&quot;홈 화면에 추가&quot; 선택</p>
            </div>
            <div className="flex items-center gap-3">
              <span className="flex-shrink-0 w-6 h-6 rounded-full bg-accent flex items-center justify-center text-xs font-bold text-white">3</span>
              <p className="text-sm text-text-primary">홈 화면에서 크보팬 실행!</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="w-full rounded-xl bg-accent py-3 text-sm font-semibold text-white"
          >
            확인
          </button>
        </div>
      </motion.div>
    </div>
  );
}
