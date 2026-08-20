"use client";

import {
  GENIUS_MASCOT_IMG_CLASS,
  type GeniusMascotMotion,
  geniusMotionClipFor,
  geniusMotionPosterSrc,
  geniusMotionSrc,
  type GeniusAnswerPlayerRole,
  type GeniusReplyKind,
} from "@/lib/constants/baseball-genius";

/**
 * 야잘알봇 마스코트 — **렌더 계약 단일 지점**.
 *
 * 2026-08-16 하린아빠 13:48 "지금 연결된건 움직이는 것 같지도 않아. 모두 폐기하고
 * 활발하게 움직이는 버전들로 교체" → 정적 PNG + CSS transform 구조를 **폐기**하고
 * 실제 영상에서 뽑은 WebP 애니메이션 13종으로 전환했다.
 *
 * 종전 구조가 왜 실패했나: 마스코트 표정은 정적 PNG 5장이었고 움직임은 CSS
 * `transform` 이었다. §7.6 감정 모션은 인사·칭찬·거절에만 붙어 **지식 답변에는
 * 아무 모션도 없었고**, 8/16 오전에 넣은 idle bob(-2.5px)은 진폭이 너무 작아
 * 실기기에서 "안 움직인다"로 읽혔다. 자산 자체가 정지 이미지인 한 CSS 로는
 * 스윙·투구 같은 동작을 만들 수 없다.
 *
 * 이 컴포넌트가 소유하는 것:
 *  · 크기 = GENIUS_MASCOT_IMG_CLASS (96px, 헤더 마스코트와 동일 규격)
 *  · 어느 클립인가 = geniusMotionClipFor(replyKind, messageId, teams) — 결정론
 *  · reduced-motion 대응 = **자산 교체**(<picture> media 쿼리). CSS 로는 못 멈춘다.
 *
 * 소유권 판정("전체 마스코트 최대 1개")은 여전히 호출부(page)가 한다 — 여기서 하지 않는다.
 */
export default function GeniusMascotImage({
  replyKind = null,
  messageId,
  motion = null,
  motionIntent = null,
  answerTeamId = null,
  favoriteTeamId = null,
  answerPlayerRole = null,
  testId,
}: {
  /** 답변 의미 분류. null 이면 legacy(payload 없는 과거 답변)로 보고 야구 동작을 준다. */
  replyKind?: GeniusReplyKind | null;
  /** 클립 선택 시드. 같은 메시지는 reload·재진입·다른 기기에서도 같은 동작이 나온다. */
  messageId: number;
  /**
   * 서버가 §7.6 SSOT 로 계산해 payload 에 실은 감정 모션 (인사=excited /
   * 감사·칭찬=headspin / 거절=bored). **의미**가 여기 들어있어 시드 교대보다 우선한다.
   */
  motion?: GeniusMascotMotion | null;
  /**
   * 쿨다운(#1202)과 **무관한** §7.6 의도 모션.
   *
   * `motion` 은 DB 쿨다운이 승인해야 실린다 — 30초 내 재인사면 비어버린다. 그때
   * intent 가 없으면 "감사"·"인사"·"범위 안내"가 전부 같은 폴백으로 무너진다
   * (삼순 2026-08-16 P0). 의미 판정은 intent 로, 감정 클립 재생 여부는 motion 으로.
   */
  motionIntent?: GeniusMascotMotion | null;
  /**
   * 답변이 다루는 구단 canonical id (서버 payload). 유저 최애팀과 **exact 일치**할 때만
   * 응원 7종이 재생된다 — 하린아빠 2026-08-16 14:09 "응원세트는 최애팀 관련 답변 이후에".
   * 값이 없으면(구단 미특정·거절·되묻기) 응원은 안 붙는다(fail-close).
   */
  answerTeamId?: number | null;
  /** 보고 있는 유저의 최애팀 id (프로필). 미설정이면 응원 없음. */
  favoriteTeamId?: number | null;
  /**
   * 답변 대상 선수의 역할 (서버 payload). 확정되면 투수=pitching / 타자·야수=swing 으로
   * 재생한다(하린아빠 2026-08-19). 없으면 기존 교대 그대로다(fail-close).
   */
  answerPlayerRole?: GeniusAnswerPlayerRole | null;
  /** 게이트가 소유권을 세는 앵커. 사용처마다 다르므로 호출부가 준다. */
  testId: string;
}) {
  const clip = geniusMotionClipFor(replyKind, messageId, { motion, motionIntent, answerTeamId, favoriteTeamId, answerPlayerRole });
  return (
    // ⚠️ 애니메이션 WebP 는 CSS `animation: none` 으로 멈출 수 없다 — 재생 주체가
    // 이미지 디코더라 CSS 가 관여하지 못한다. `prefers-reduced-motion` 에서는
    // <source media> 로 **정지 poster 자산을 대신 로드**해야 실제로 멈춘다.
    // (브라우저는 매칭된 source 하나만 받으므로 애니메이션 파일을 받지도 않는다.)
    <picture>
      <source
        media="(prefers-reduced-motion: reduce)"
        srcSet={geniusMotionPosterSrc(clip)}
        type="image/webp"
        data-testid={`${testId}-reduced-source`}
      />
      {/* eslint-disable-next-line @next/next/no-img-element -- 애니메이션 WebP (next/image 는 애니메이션을 최적화 과정에서 정지시킨다) */}
      <img
        src={geniusMotionSrc(clip)}
        alt=""
        aria-hidden
        data-testid={testId}
        data-clip={clip}
        className={GENIUS_MASCOT_IMG_CLASS}
      />
    </picture>
  );
}
