"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, Heart, ChevronLeft, ChevronRight, Camera } from "lucide-react";
import Image from "next/image";

interface Photo {
  id: number;
  imageUrl: string;
  author: string;
  likes: number;
  timeAgo: string;
  caption?: string;
}

const MOCK_PHOTOS: Photo[] = [
  { id: 1, imageUrl: "https://picsum.photos/seed/kbo1/400/400", author: "직관러88", likes: 234, timeAgo: "2시간 전", caption: "오늘 잠실 직관 🔥" },
  { id: 2, imageUrl: "https://picsum.photos/seed/kbo2/400/400", author: "덕후일기", likes: 187, timeAgo: "3시간 전", caption: "사인받았다!! 떨려서 손이 후들후들" },
  { id: 3, imageUrl: "https://picsum.photos/seed/kbo3/400/400", author: "카메라맨", likes: 312, timeAgo: "5시간 전", caption: "홈런 치는 순간 포착 📸" },
  { id: 4, imageUrl: "https://picsum.photos/seed/kbo4/400/400", author: "뉴비팬", likes: 56, timeAgo: "6시간 전", caption: "첫 직관인데 너무 멋있었어요" },
  { id: 5, imageUrl: "https://picsum.photos/seed/kbo5/400/400", author: "시즌권자", likes: 423, timeAgo: "8시간 전", caption: "불펜 피칭 연습 중" },
  { id: 6, imageUrl: "https://picsum.photos/seed/kbo6/400/400", author: "야구사진관", likes: 189, timeAgo: "10시간 전", caption: "수비 다이빙 캐치!" },
  { id: 7, imageUrl: "https://picsum.photos/seed/kbo7/400/400", author: "응원단장", likes: 145, timeAgo: "12시간 전", caption: "응원하는 모습 🙌" },
  { id: 8, imageUrl: "https://picsum.photos/seed/kbo8/400/400", author: "직관마스터", likes: 267, timeAgo: "1일 전", caption: "세레머니 직찍" },
  { id: 9, imageUrl: "https://picsum.photos/seed/kbo9/400/400", author: "팬카페운영자", likes: 98, timeAgo: "1일 전", caption: "팬미팅 단체사진" },
];

function PhotoViewer({ photos, index, onClose, onNav }: {
  photos: Photo[];
  index: number;
  onClose: () => void;
  onNav: (i: number) => void;
}) {
  const photo = photos[index];
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 bg-black/95 flex flex-col"
      onClick={onClose}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3" onClick={e => e.stopPropagation()}>
        <span className="text-sm text-white/70">{photo.author}</span>
        <button onClick={onClose}><X size={24} className="text-white/70" /></button>
      </div>

      {/* Image */}
      <div className="flex-1 flex items-center justify-center relative" onClick={e => e.stopPropagation()}>
        {index > 0 && (
          <button onClick={() => onNav(index - 1)} className="absolute left-2 z-10 p-2 bg-white/10 rounded-full">
            <ChevronLeft size={24} className="text-white" />
          </button>
        )}
        <Image
          src={photo.imageUrl}
          alt=""
          width={400}
          height={400}
          unoptimized
          className="max-w-full max-h-[70vh] object-contain"
        />
        {index < photos.length - 1 && (
          <button onClick={() => onNav(index + 1)} className="absolute right-2 z-10 p-2 bg-white/10 rounded-full">
            <ChevronRight size={24} className="text-white" />
          </button>
        )}
      </div>

      {/* Caption */}
      <div className="px-4 py-3" onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-2 mb-1">
          <Heart size={16} className="text-red-400" fill="currentColor" />
          <span className="text-sm text-white/80">{photo.likes}</span>
          <span className="text-xs text-white/40 ml-auto">{photo.timeAgo}</span>
        </div>
        {photo.caption && <p className="text-sm text-white/70">{photo.caption}</p>}
      </div>
    </motion.div>
  );
}

export default function PhotoGallery({ teamColor }: { teamColor: string }) {
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);

  return (
    <>
      {MOCK_PHOTOS.length === 0 ? (
        <div className="text-center py-12 text-text-tertiary">
          <Camera size={32} className="mx-auto mb-2 opacity-50" />
          <p className="text-sm">아직 직찍이 없어요</p>
          <p className="text-xs mt-1">직관에서 찍은 사진을 공유해보세요! 📸</p>
        </div>
      ) : (
        <div className="grid grid-cols-3 gap-0.5">
          {MOCK_PHOTOS.map((photo, i) => (
            <motion.div
              key={photo.id}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: i * 0.03 }}
              className="relative aspect-square cursor-pointer group"
              onClick={() => setViewerIndex(i)}
            >
              <Image
                src={photo.imageUrl}
                alt=""
                fill
                unoptimized
                className="object-cover"
              />
              <div className="absolute inset-0 bg-black/0 group-active:bg-black/30 transition-colors flex items-center justify-center opacity-0 group-active:opacity-100">
                <div className="flex items-center gap-1">
                  <Heart size={14} className="text-white" fill="white" />
                  <span className="text-xs text-white font-bold">{photo.likes}</span>
                </div>
              </div>
            </motion.div>
          ))}
        </div>
      )}

      <AnimatePresence>
        {viewerIndex !== null && (
          <PhotoViewer
            photos={MOCK_PHOTOS}
            index={viewerIndex}
            onClose={() => setViewerIndex(null)}
            onNav={setViewerIndex}
          />
        )}
      </AnimatePresence>
    </>
  );
}
