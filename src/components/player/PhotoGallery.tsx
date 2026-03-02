"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, Heart, ChevronLeft, ChevronRight, Camera, Send, Share2 } from "lucide-react";
import Image from "next/image";

interface Comment {
  id: number;
  author: string;
  text: string;
  timeAgo: string;
}

interface Photo {
  id: number;
  imageUrl: string;
  author: string;
  likes: number;
  timeAgo: string;
  caption?: string;
  comments: Comment[];
}

const MOCK_PHOTOS: Photo[] = [
  { id: 1, imageUrl: "https://picsum.photos/seed/kbo1/400/400", author: "직관러88", likes: 234, timeAgo: "2시간 전", caption: "오늘 잠실 직관 🔥", comments: [
    { id: 1, author: "야구팬", text: "와 진짜 잘 찍으셨다!", timeAgo: "1시간 전" },
    { id: 2, author: "엘지빠", text: "나도 갔었는데 ㅠ 못 봤어", timeAgo: "30분 전" },
  ]},
  { id: 2, imageUrl: "https://picsum.photos/seed/kbo2/400/400", author: "덕후일기", likes: 187, timeAgo: "3시간 전", caption: "사인받았다!! 떨려서 손이 후들후들", comments: [
    { id: 3, author: "부러움", text: "어떻게 받으신 거예요?! 부럽ㅠ", timeAgo: "2시간 전" },
  ]},
  { id: 3, imageUrl: "https://picsum.photos/seed/kbo3/400/400", author: "카메라맨", likes: 312, timeAgo: "5시간 전", caption: "홈런 치는 순간 포착 📸", comments: [
    { id: 4, author: "스탯덕후", text: "이거 몇 호 홈런이었죠?", timeAgo: "4시간 전" },
    { id: 5, author: "카메라맨", text: "시즌 12호요!", timeAgo: "3시간 전" },
    { id: 6, author: "직관러", text: "카메라 뭐 쓰세요? 너무 선명", timeAgo: "2시간 전" },
  ]},
  { id: 4, imageUrl: "https://picsum.photos/seed/kbo4/400/400", author: "뉴비팬", likes: 56, timeAgo: "6시간 전", caption: "첫 직관인데 너무 멋있었어요", comments: [] },
  { id: 5, imageUrl: "https://picsum.photos/seed/kbo5/400/400", author: "시즌권자", likes: 423, timeAgo: "8시간 전", caption: "불펜 피칭 연습 중", comments: [
    { id: 7, author: "투수덕후", text: "폼 진짜 깔끔하다...", timeAgo: "7시간 전" },
  ]},
  { id: 6, imageUrl: "https://picsum.photos/seed/kbo6/400/400", author: "야구사진관", likes: 189, timeAgo: "10시간 전", caption: "수비 다이빙 캐치!", comments: [] },
  { id: 7, imageUrl: "https://picsum.photos/seed/kbo7/400/400", author: "응원단장", likes: 145, timeAgo: "12시간 전", caption: "응원하는 모습 🙌", comments: [] },
  { id: 8, imageUrl: "https://picsum.photos/seed/kbo8/400/400", author: "직관마스터", likes: 267, timeAgo: "1일 전", caption: "세레머니 직찍", comments: [
    { id: 8, author: "팬1", text: "이 세레머니 매번 봐도 좋아ㅋㅋ", timeAgo: "20시간 전" },
  ]},
  { id: 9, imageUrl: "https://picsum.photos/seed/kbo9/400/400", author: "팬카페운영자", likes: 98, timeAgo: "1일 전", caption: "팬미팅 단체사진", comments: [] },
];

function PhotoViewer({ photos, index, onClose, onNav }: {
  photos: Photo[];
  index: number;
  onClose: () => void;
  onNav: (i: number) => void;
}) {
  const photo = photos[index];
  const [comment, setComment] = useState("");
  const [liked, setLiked] = useState(false);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 bg-black flex flex-col"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
        <span className="text-sm font-semibold text-white">{photo.author}</span>
        <div className="flex items-center gap-2">
          <span className="text-xs text-white/40">{photo.timeAgo}</span>
          
          <button onClick={async () => {
            const url = `${window.location.origin}${window.location.pathname}?photo=${photo.id}`;
            if (navigator.share) {
              await navigator.share({ title: `${photo.author}의 직찍`, text: photo.caption || "크보 에브리데이 직찍", url });
            } else {
              await navigator.clipboard.writeText(url);
              alert("링크가 복사되었습니다!");
            }
          }}><Share2 size={20} className="text-white/70" /></button>
          <button onClick={onClose}><X size={22} className="text-white/70" /></button>
        </div>
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto">
        {/* Image */}
        <div className="relative">
          <div className="aspect-square relative">
            <Image src={photo.imageUrl} alt="" fill unoptimized className="object-cover" />
          </div>
          {index > 0 && (
            <button onClick={() => onNav(index - 1)} className="absolute left-2 top-1/2 -translate-y-1/2 p-1.5 bg-black/50 rounded-full">
              <ChevronLeft size={20} className="text-white" />
            </button>
          )}
          {index < photos.length - 1 && (
            <button onClick={() => onNav(index + 1)} className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 bg-black/50 rounded-full">
              <ChevronRight size={20} className="text-white" />
            </button>
          )}
        </div>

        {/* Actions */}
        <div className="px-4 py-2 flex items-center gap-4">
          <button onClick={() => setLiked(!liked)}>
            <Heart size={22} className={liked ? "text-red-500" : "text-white/70"} fill={liked ? "currentColor" : "none"} />
          </button>
          <span className="text-sm text-white/80">{photo.likes + (liked ? 1 : 0)}</span>
          <span className="text-xs text-white/40 ml-auto">{photo.comments.length}개의 댓글</span>
        </div>

        {/* Caption */}
        {photo.caption && (
          <div className="px-4 pb-2">
            <p className="text-sm text-white/90"><span className="font-semibold mr-1.5">{photo.author}</span>{photo.caption}</p>
          </div>
        )}

        {/* Comments */}
        <div className="px-4 pb-4 space-y-2.5">
          {photo.comments.map(c => (
            <div key={c.id}>
              <p className="text-sm text-white/80">
                <span className="font-semibold text-white/90 mr-1.5">{c.author}</span>
                {c.text}
              </p>
              <span className="text-xs text-white/30">{c.timeAgo}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Comment input */}
      <div className="border-t border-white/10 px-4 py-3 flex items-center gap-3">
        <input
          type="text"
          value={comment}
          onChange={e => setComment(e.target.value)}
          placeholder="댓글 달기..."
          className="flex-1 bg-transparent text-sm text-white placeholder:text-white/30 focus:outline-none"
        />
        <button disabled={!comment.trim()} className="text-accent disabled:opacity-30">
          <Send size={20} />
        </button>
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
              <Image src={photo.imageUrl} alt="" fill unoptimized className="object-cover" />
              <div className="absolute inset-0 bg-black/0 group-active:bg-black/30 transition-colors flex items-center justify-center opacity-0 group-active:opacity-100">
                <div className="flex items-center gap-1">
                  <Heart size={14} className="text-white" fill="white" />
                  <span className="text-xs text-white font-bold">{photo.likes}</span>
                </div>
              </div>
              {photo.comments.length > 0 && (
                <div className="absolute bottom-1 right-1 bg-black/60 rounded-full px-1.5 py-0.5 flex items-center gap-0.5">
                  <span className="text-[10px] text-white/80">💬 {photo.comments.length}</span>
                </div>
              )}
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
