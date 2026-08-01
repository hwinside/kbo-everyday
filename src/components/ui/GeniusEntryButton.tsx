"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/supabase/AuthContext";
import { getExistingConversation } from "@/lib/supabase/useDM";
import { BASEBALL_GENIUS_NAME, BASEBALL_GENIUS_USER_ID } from "@/lib/constants/baseball-genius";

/**
 * 전역 헤더의 야잘알봇 진입점 (2026-08-02 하린아빠 지시).
 *
 * 기존 경로는 쪽지 아이콘 → 쪽지 목록 → 최상단 야잘알봇 카드 → 대화 시작으로 3탭이었다.
 * 마스코트를 쪽지 아이콘 왼쪽에 두고 한 탭에 대화창까지 보낸다.
 *
 * 비로그인은 **진입 자체가 불가능**하다 (2026-08-02 하린아빠 "비로그인 상태면 진입 불가능해야돼").
 * 버튼을 아예 렌더하지 않는다 — 로그인 시트로 유도하지 않는다.
 * 세션 확정 전(loading)에도 렌더하지 않는다. 잠깐 보였다 사라지면 비로그인 유저에게
 * "있었는데 없어진" 진입점이 되고, 그 찰나에 눌리면 가드가 무의미해진다.
 *
 * 라우팅은 DMButton 과 동일 계약을 재사용한다:
 *  - 기존 대화가 있으면 그 방, 없으면 `/messages/new-{botId}` 초안 방(진입 즉시 입력 가능)
 *
 * 슬롯은 헤더 44px 규격 안에서 다른 헤더 아이콘(h-11 w-11)과 같은 터치 타깃을 쓰고,
 * 마스코트만 슬롯보다 크게 그린다(세로로 긴 종횡비라 원형 크롭 없이 전신).
 */
export default function GeniusEntryButton() {
  const router = useRouter();
  const { user, loading } = useAuth();
  const [pending, setPending] = useState(false);

  // 비로그인·세션 미확정이면 진입점 자체를 노출하지 않는다.
  if (loading || !user) return null;

  const handleClick = async () => {
    // 렌더 가드와 별개로 한 번 더 확인한다. 클릭 시점에 세션이 만료됐을 수 있고,
    // 그때 조회/생성으로 내려가면 주인 없는 빈 대화가 생긴다.
    if (!user) return;
    setPending(true);
    try {
      const convId = await getExistingConversation(user.id, BASEBALL_GENIUS_USER_ID);
      router.push(convId ? `/messages/${convId}` : `/messages/new-${BASEBALL_GENIUS_USER_ID}`);
    } finally {
      setPending(false);
    }
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={pending}
      aria-label={`${BASEBALL_GENIUS_NAME}에게 물어보기`}
      data-testid="genius-entry-button"
      className="relative flex h-11 w-11 items-center justify-center rounded-full transition-colors hover:bg-bg-tertiary disabled:opacity-50"
    >
      {/* 컨테이너는 헤더 공용 44px 터치 타깃 유지, 캐릭터만 40px 높이로 그린다.
          원형 크롭을 하면 세로로 긴 캐릭터의 머리·발이 잘려 누군지 안 보인다. */}
      {/* eslint-disable-next-line @next/next/no-img-element -- 정적 마스코트 PNG, 헤더에서 next/image 추가 오버헤드 불필요 */}
      <img
        src="/mascot/yajalal-avatar.png"
        alt=""
        aria-hidden
        className="h-10 w-auto max-w-none object-contain"
      />
    </button>
  );
}
