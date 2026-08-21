"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/supabase/AuthContext";
import { getExistingConversation } from "@/lib/supabase/useDM";
import {
  BASEBALL_GENIUS_NAME,
  BASEBALL_GENIUS_USER_ID,
  geniusMotionPosterSrc,
  geniusMotionSrc,
} from "@/lib/constants/baseball-genius";

/**
 * 홈 헤더의 야잘알봇 진입점 (2026-08-02 최초 지시 → 2026-08-21 하린아빠 "홈에 야잘알봇 꺼내기"로 재노출).
 *
 * 기존 경로는 쪽지 아이콘 → 쪽지 목록 → 최상단 야잘알봇 카드 → 대화 시작으로 3탭이었다.
 * 마스코트를 쪽지 아이콘 왼쪽에 두고 한 탭에 대화창까지 보낸다.
 * 같은 지시로 쪽지함 목록의 야잘알봇 고정방은 제거됐다 — 이 버튼이 유일한 진입점이다.
 *
 * 마스코트는 스윙/투구 애니메이션 2종을 **랜덤**으로 노출한다 (2026-08-21 하린아빠
 * "스윙, 투구 모션 2가지를 랜덤으로 노출"). 답변 마스코트(GeniusMascotImage)의
 * messageId 시드 결정론과 달리 여기는 고를 메시지가 없다 — 마운트 시 1회 추첨하고,
 * 렌더마다 재추첨하지 않도록 useState lazy initializer 에 고정한다.
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

  // 스윙/투구 랜덤 추첨 — 마운트 1회 고정. 렌더마다 바뀌면 리렌더 때 이미지가 교체돼
  // 애니메이션이 처음부터 다시 시작하며 깜빡인다.
  const [clip] = useState<"swing" | "pitching">(() =>
    Math.random() < 0.5 ? "swing" : "pitching",
  );

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
      {/* 컨테이너는 헤더 공용 44px 터치 타깃 유지. 캐릭터 그림은 **29px** — 최초 22px
          (아이콘 정합)에서 2026-08-21 23:06 하린아빠 "너무 작아서 잘 안보인다,
          30% 키워줘"로 22×1.3≈29px. 폭 ~40px로 44px 슬롯 안이라 헤더 불증가
          (20:48 지시)는 그대로 유지된다. */}
      {/* ⚠️ 애니메이션 WebP 는 CSS 로 멈출 수 없다(재생 주체가 이미지 디코더) —
          prefers-reduced-motion 에서는 <source media> 로 정지 poster 자산을 대신
          로드해야 실제로 멈춘다(GeniusMascotImage 와 동일 계약). */}
      {/* pointer-events-none: 탭 판정은 44px 버튼 자신만 한다(삼순 NO-GO ①).
          22px 축소로 overflow 는 사라졌지만(폭 ~31px) 방어로 유지한다. */}
      <picture className="pointer-events-none">
        <source
          media="(prefers-reduced-motion: reduce)"
          srcSet={geniusMotionPosterSrc(clip)}
          type="image/webp"
          data-testid="genius-entry-reduced-source"
        />
        {/* eslint-disable-next-line @next/next/no-img-element -- 애니메이션 WebP (next/image 는 최적화 과정에서 애니메이션을 정지시킨다) */}
        <img
          src={geniusMotionSrc(clip)}
          alt=""
          aria-hidden
          data-clip={clip}
          className="h-[29px] w-auto max-w-none object-contain"
        />
      </picture>
    </button>
  );
}
