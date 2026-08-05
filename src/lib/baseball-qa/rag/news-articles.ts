// 야잘알봇 최신 맥락 근거(tier2) — 구단 기사 원장 적재 계약.
//
// 왜 이 파일이 따로 있는가
//   뉴스클리핑(/api/cron/news-clipping)은 이미 매일 10개 구단 기사를 네이버에서 긁는다.
//   다만 클리핑 카드용 필터(사진기사·타팀 제목·제목 신호 게이트)를 통과한 25건 중
//   Gemini 가 5건만 골라 발송하고 **나머지를 전부 버린다**.
//   RAG 근거로는 그 버려지는 쪽이 더 중요하다:
//     · `선두 KT, 한화 12-1 완파…(종합)` 같은 종합기사는 isOtherTeamTitle 에 걸려 카드에서 빠지지만
//       "어제 두산:LG 3피트 논란" 의 실제 근거 문장을 담고 있다(실측 확인).
//   그래서 적재는 **클리핑 필터 이전 raw 후보** 단계에서 분기하고,
//   클리핑 발송 로직은 한 줄도 건드리지 않는다. 네이버 추가 호출도 0이다.
//
// 계약
//   · 저장 범위는 네이버 검색 API 가 주는 제목 + description 발췌뿐이다. 본문 크롤 금지.
//   · tier2 고정. 스코어·기록 수치는 이 근거로 확정하지 않는다(kbo_structured 우선).
//   · 한 기사가 여러 구단에 걸리면 team_ids 를 합집합으로 병합해 한 행으로 유지한다.
//   · published_at 30일 초과분은 적재하지 않는다(purge 와 이중 방어).

import { createHash } from "node:crypto";
import type { NewsItem } from "@/types/api";
import { isNaverNewsUrl } from "@/lib/news-relevance";

/** 기사 보유 기간. migration(서빙 뷰 술어 + purge 함수)과 같은 값이어야 한다. */
export const NEWS_RETENTION_DAYS = 30;

/**
 * 백필 창(일). 보유기간과 별개다 — 보유는 30일까지 두되, 한 번에 거슬러 채우는 범위는 14일이다.
 * (2026-08-07 하린아빠 기준) 그 이상은 검색 결과창 한계로 fan-out 비용만 커지고
 * 실제 답변 품질 기여는 작다. 이후 날짜는 일일 cron 이 채운다.
 */
export const NEWS_BACKFILL_DAYS = 14;

/** 임베딩 실패 재시도 상한. DB CHECK(embed_attempts BETWEEN 0 AND 5)와 같은 값. */
export const NEWS_EMBED_MAX_ATTEMPTS = 5;

export interface NewsArticleRow {
  article_key: string;
  team_ids: number[];
  title: string;
  description: string;
  link: string;
  original_link: string;
  press_host: string | null;
  published_at: string;
  content_hash: string;
}

/** 네이버 link 기준 안정 식별자. 같은 기사를 여러 팀 쿼리가 물어와도 한 행으로 수렴한다. */
export function articleKeyFor(link: string): string {
  return createHash("sha256").update(link.trim()).digest("hex");
}

export function contentHashFor(title: string, description: string): string {
  return createHash("sha256").update(`${title.trim()}\n${description.trim()}`).digest("hex");
}

/** 출처 표기용 언론사 호스트. 파싱 불가는 null(적재는 계속) — 표기 품질 문제지 근거 무효 사유가 아니다. */
export function pressHostFor(originalLink: string | undefined, link: string): string | null {
  const raw = originalLink?.trim() || link.trim();
  try {
    return new URL(raw).hostname.replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

/** 기사 본문(임베딩·프롬프트 입력). DB 생성 컬럼과 같은 규칙이라 어긋날 수 없다. */
export function articleContent(title: string, description: string): string {
  return `${title.trim()}\n${description.trim()}`;
}

function isWithinRetention(publishedAtMs: number, nowMs: number): boolean {
  return publishedAtMs >= nowMs - NEWS_RETENTION_DAYS * 24 * 60 * 60 * 1000;
}

/**
 * raw 네이버 후보 → 적재 행.
 *
 * 여기서 거르는 것은 **근거로 쓸 수 없는 것**뿐이다(클리핑 카드 품질 필터와 다르다):
 *   · 네이버 뉴스 URL 이 아닌 기사 — 링크 표기·중복판정 기준이 깨진다
 *   · 제목/발췌가 빈 기사 — 임베딩할 내용이 없다(DB CHECK 와 동일 계약)
 *   · pubDate 파싱 불가 — 시의성 판정이 불가능하다
 *   · 보유기간 초과 — 적재 즉시 purge 대상이 될 행을 넣지 않는다
 * 사진기사·타팀 제목·제목 신호 게이트는 **적용하지 않는다**(위 파일 주석의 종합기사 사례).
 */
export function toNewsArticleRows(
  items: NewsItem[],
  teamId: number,
  now: Date = new Date(),
): NewsArticleRow[] {
  const nowMs = now.getTime();
  const byKey = new Map<string, NewsArticleRow>();

  for (const item of items) {
    const title = item.title?.trim() ?? "";
    const description = item.description?.trim() ?? "";
    const link = item.link?.trim() ?? "";
    if (!title || !description || !link) continue;
    if (!isNaverNewsUrl(link)) continue;

    const publishedMs = Date.parse(item.pubDate);
    if (Number.isNaN(publishedMs)) continue;
    if (!isWithinRetention(publishedMs, nowMs)) continue;

    const key = articleKeyFor(link);
    const existing = byKey.get(key);
    if (existing) {
      // 같은 배치 안에서의 팀 중복(예: 잠실 더비가 두 팀 쿼리에 다 걸림)은 여기서 합친다.
      if (!existing.team_ids.includes(teamId)) existing.team_ids.push(teamId);
      continue;
    }

    byKey.set(key, {
      article_key: key,
      team_ids: [teamId],
      title,
      description,
      link,
      original_link: item.originalLink?.trim() || link,
      press_host: pressHostFor(item.originalLink, link),
      published_at: new Date(publishedMs).toISOString(),
      content_hash: contentHashFor(title, description),
    });
  }

  return [...byKey.values()];
}
