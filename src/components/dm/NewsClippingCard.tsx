"use client";

import type { NewsClippingView } from "@/types/news-clipping";
import NewsCommentButton from "@/components/news/NewsCommentButton";
import { useNewsArticleBrowser } from "@/hooks/useNewsArticleBrowser";

// 뉴스클리핑 쪽지 카드 — 뉴스카드와 동일한 구성(OG 사진+제목, 탭하면 원문)
// 아래에 LLM 3줄 요약. 쪽지 말풍선 자리에 렌더된다.
//
// 2026-08-20: payload 직접 수신 → NewsClippingView 수신으로 변경.
// legacy(payload 안에 articles) / ref(digest 참조) 두 형태를 호출부가 view 로 정규화해서
// 넘긴다. 카드는 어느 형태에서 왔는지 알 필요가 없다.

function formatDateLabel(isoDate: string): string {
  const [, m, d] = isoDate.split("-").map((v) => parseInt(v, 10));
  if (!m || !d) return isoDate;
  return `${m}월 ${d}일`;
}

export default function NewsClippingCard({ view }: { view: NewsClippingView }) {
  const { openArticle } = useNewsArticleBrowser();

  return (
    <div className="rounded-2xl rounded-bl-md bg-bg-tertiary overflow-hidden">
      {/* 헤더 + 데일리 총평 */}
      <div className="px-3.5 pt-3 pb-2">
        <p className="text-sm font-bold text-text-primary">📰 오늘의 {view.team_name} 뉴스클리핑</p>
        <p className="text-[10px] text-text-tertiary mt-0.5">
          {formatDateLabel(view.date)} 주요 뉴스 {view.articles.length}건
        </p>
        {view.intro && (
          <p className="mt-2 whitespace-pre-line rounded-lg bg-bg-secondary px-2.5 py-2 text-xs leading-relaxed text-text-secondary">
            {view.intro}
          </p>
        )}
        {view.overview && (
          <p className="text-xs text-text-secondary mt-1.5 leading-relaxed">{view.overview}</p>
        )}
      </div>

      {/* 기사 카드 목록 */}
      <div className="px-2 pb-2 space-y-2">
        {view.articles.map((article) => {
          const discussion = {
            url: article.link,
            canonicalUrl: article.original_link || article.link,
            title: article.title,
            thumbnailUrl: article.thumbnail_url,
            teamId: view.team_id,
          };
          return (
          <div key={article.link} className="rounded-xl bg-bg-secondary border border-border overflow-hidden">
            <button
              type="button"
              onClick={() => openArticle(discussion)}
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
            <div className="flex justify-end border-t border-border px-3 py-2">
              <NewsCommentButton
                article={discussion}
                className="bg-bg-tertiary text-text-secondary hover:bg-bg-primary"
              />
            </div>
          </div>
          );
        })}
      </div>
    </div>
  );
}
