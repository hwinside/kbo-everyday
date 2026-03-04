"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronLeft, Heart, MessageCircle, Plus } from "lucide-react";
import GlassCard from "@/components/ui/GlassCard";
import { useAuth } from "@/lib/supabase/AuthContext";
import LoginSheet from "@/components/auth/LoginSheet";

const MOCK_POSTS = [
  { id: 1, title: "오늘 경기 선발 라인업 예상해봅니다", author: "야구매니아", time: "10분 전", likes: 24, comments: 8 },
  { id: 2, title: "올해 신인왕 후보 누가 될까요?", author: "프로야구팬", time: "32분 전", likes: 18, comments: 12 },
  { id: 3, title: "어제 하이라이트 영상 봤는데 소름이었음", author: "홈런왕", time: "1시간 전", likes: 42, comments: 15 },
  { id: 4, title: "주말 직관 같이 가실 분!", author: "잠실매니아", time: "2시간 전", likes: 11, comments: 6 },
  { id: 5, title: "올해 우승팀 예측 투표합시다", author: "승부사", time: "3시간 전", likes: 35, comments: 21 },
];

export default function FreeBoardPage() {
  const router = useRouter();
  const { user } = useAuth();
  const [showLogin, setShowLogin] = useState(false);

  function handleWrite() {
    if (!user) {
      setShowLogin(true);
      return;
    }
    // TODO: navigate to write page
  }

  return (
    <div className="mx-auto max-w-lg pb-24">
      {/* Header */}
      <div className="flex items-center gap-3 px-5 pt-4 pb-5">
        <button
          onClick={() => router.back()}
          className="rounded-full p-1.5 text-text-secondary hover:bg-bg-tertiary transition-colors"
        >
          <ChevronLeft size={24} />
        </button>
        <h1 className="text-3xl font-extrabold tracking-tight text-text-primary">
          자유게시판
        </h1>
      </div>

      {/* Posts */}
      <div className="mx-5 space-y-3">
        {MOCK_POSTS.map((post) => (
          <GlassCard key={post.id} pressable className="p-4">
            <h3 className="text-sm font-semibold text-text-primary">{post.title}</h3>
            <div className="mt-2 flex items-center gap-4 text-xs text-text-tertiary">
              <span>{post.author}</span>
              <span>{post.time}</span>
              <span className="flex items-center gap-1">
                <Heart size={12} /> {post.likes}
              </span>
              <span className="flex items-center gap-1">
                <MessageCircle size={12} /> {post.comments}
              </span>
            </div>
          </GlassCard>
        ))}
      </div>

      {/* FAB */}
      <button
        onClick={handleWrite}
        className="fixed bottom-20 right-5 z-40 flex h-14 w-14 items-center justify-center rounded-full bg-accent text-white shadow-lg shadow-accent/30 transition-transform hover:scale-105 active:scale-95"
      >
        <Plus size={28} />
      </button>

      <LoginSheet isOpen={showLogin} onClose={() => setShowLogin(false)} />
    </div>
  );
}
