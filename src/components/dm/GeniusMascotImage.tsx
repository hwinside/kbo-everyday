"use client";

import {
  GENIUS_MASCOT_IDLE_MOTION_CLASS,
  GENIUS_MASCOT_IMG_CLASS,
  geniusMascotSrc,
  type GeniusMascotMotion,
  type GeniusMascotState,
} from "@/lib/constants/baseball-genius";

/**
 * 야잘알봇 마스코트 이미지 — **렌더 계약 단일 지점**(2026-08-16).
 *
 * 종전에는 답변(page)·생각중·실패 3곳이 각각 `h-8 w-auto max-w-none object-contain` 을
 * 문자열로 복제하고 있었다. 하린아빠 "캐릭터가 너무 작아서 잘 안보임" 지시로 96px 로
 * 키우면서, 다시 복제하면 다음 변경에서 한 곳만 고쳐지고 조용히 어긋난다
 * (M90 `게이트가 상수를 재구현하면 결함을 못 본다` 와 같은 축 — 사용처 복제도 같은 함정).
 *
 * 이 컴포넌트는 **표시 계약만** 소유한다:
 *  · 크기 = GENIUS_MASCOT_IMG_CLASS (96px, 헤더 마스코트와 동일 규격)
 *  · 상시 idle 미세 모션 = 래퍼 span 에 (감정 모션과 transform 충돌 없음)
 *  · 감정 모션(§7.6) = img 에 (기존 배선 그대로)
 *
 * 소유권 판정("전체 마스코트 최대 1개")은 여전히 호출부(page)가 한다 — 여기서 하지 않는다.
 */
export default function GeniusMascotImage({
  state,
  motion = null,
  testId,
  motionAttr = false,
}: {
  state: GeniusMascotState;
  /** §7.6 감정 모션. 지식 답변은 null 이며, 그때도 idle 미세 모션은 계속 돈다. */
  motion?: GeniusMascotMotion | null;
  /** 게이트가 소유권을 세는 앵커. 사용처마다 다르므로 호출부가 준다. */
  testId: string;
  /** `data-motion` 노출 여부 — 답변 마스코트만 모션 축을 갖는다(게이트 계약 유지). */
  motionAttr?: boolean;
}) {
  return (
    <span className={GENIUS_MASCOT_IDLE_MOTION_CLASS} aria-hidden>
      {/* eslint-disable-next-line @next/next/no-img-element -- 정적 마스코트 PNG(모션은 CSS 애니메이션) */}
      <img
        src={geniusMascotSrc(state)}
        alt=""
        aria-hidden
        data-testid={testId}
        data-state={state}
        data-mascot={state}
        {...(motionAttr ? { "data-motion": motion ?? undefined } : {})}
        className={`${GENIUS_MASCOT_IMG_CLASS}${motion ? ` genius-motion-${motion}` : ""}`}
      />
    </span>
  );
}
