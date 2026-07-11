"use client";

import type { NewsClippingPayload } from "@/types/news-clipping";

// 뉴스클리핑 쪽지 카드 — 뉴스카드와 동일한 구성(OG 사진+제목, 탭하면 원문)
// 아래에 LLM 3줄 요약. 쪽지 말풍선 자리에 렌더된다.

function formatDateLabel(isoDate: string): string {
  const [, m, d] = isoDate.split("-").map((v) => parseInt(v, 10));
  if (!m || !d) return isoDate;
  return `${m}월 ${d}일`;
}

export default function NewsClippingCard({ payload }: { payload: NewsClippingPayload }) {
  return (
    <div className="rounded-2xl rounded-bl-md bg-bg-tertiary overflow-hidden">
      {/* 헤더 + 데일리 총평 */}
      <div className="px-3.5 pt-3 pb-2">
        <p className="text-sm font-bold text-text-primary">📰 오늘의 {payload.team_name} 뉴스클리핑</p>
        <p className="text-[10px] text-text-tertiary mt-0.5">
          {formatDateLabel(payload.date)} 주요 뉴스 {payload.articles.length}건
        </p>
        {payload.overview && (
          <p className="text-xs text-text-secondary mt-1.5 leading-relaxed">{payload.overview}</p>
        )}
      </div>

      {/* 기사 카드 목록 */}
      <div className="px-2 pb-2 space-y-2">
        {payload.articles.map((article) => (
          <div key={article.link} className="rounded-xl bg-bg-secondary border border-border overflow-hidden">
            <button
              type="button"
              onClick={() => window.open(article.link, "_blank")}
              className="block w-full text-left"
            >
              {article.thumbnail_url && (
                // eslint-disable-next-line @next/next/no-img-element -- 외부 언론사 OG 이미지
                <img
                  src={article.thumbnail_url}
                  alt=""
                  loading="lazy"
                  className="w-full h-32 object-cover bg-black/10"
                  onError={(e) => { e.currentTarget.style.display = "none"; }}
                />
              )}
              <p className="px-3 pt-2.5 text-[13px] font-semibold text-text-primary leading-snug">
                {article.title}
              </p>
            </button>
            <ul className="px-3 pt-1.5 pb-2.5 space-y-1">
              {article.summary.map((line, i) => (
                <li key={i} className="flex gap-1.5 text-xs text-text-secondary leading-relaxed">
                  <span className="text-text-tertiary flex-shrink-0">·</span>
                  <span>{line}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}
