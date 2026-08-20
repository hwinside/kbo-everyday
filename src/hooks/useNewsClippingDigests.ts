"use client";

import { useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabase/client";
import {
  NewsClippingDigestLoader,
  type DigestFetchResult,
} from "@/lib/news-clipping-digest-loader";
import {
  isRefNewsClippingPayload,
  type NewsClippingDigest,
} from "@/types/news-clipping";

/**
 * 참조형 뉴스클리핑 쪽지(payload.digest_id)가 가리키는 기사 묶음을 배치 조회한다.
 *
 * 2026-08-20 정규화 이전에는 같은 기사 묶음(약 2KB)이 수신자 수만큼 dm_messages.payload 에
 * 복제 저장됐다(8/18 KIA 6,102행 / distinct 120). 이제 digest 1행을 참조하므로 클라가
 * 한 번 조회해서 여러 쪽지에 공유한다.
 *
 * ⚠️ 재시도·겹침·부분누락 로직은 이 훅이 아니라 NewsClippingDigestLoader 가 갖는다.
 *    이유: 2차 구현은 실패 시 ref 만 갱신해 effect 가 다시 돌지 않았고, 그래서 **재시도가
 *    실제로는 한 번도 일어나지 않았다**(삼순 blocker 1). 리렌더를 재시도 트리거로 쓰면
 *    조용한 대화에서 영구 실패한다. 로더가 자기 타이머로 backoff 재시도를 소유하고,
 *    hook 없이 직접 테스트된다(scripts/qa/news-clipping-digest-smoke.ts).
 */
export function useNewsClippingDigests(
  payloads: unknown[],
): Map<number, NewsClippingDigest> {
  const [digests, setDigests] = useState<Map<number, NewsClippingDigest>>(new Map());
  const loaderRef = useRef<NewsClippingDigestLoader | null>(null);

  if (loaderRef.current === null) {
    const fetcher = async (ids: number[]): Promise<DigestFetchResult> => {
      // query-guard: bounded -- ids 는 현재 화면 메시지에서 뽑은 digest_id 집합(대화 1개당
      // 최대 100 메시지)이고 PK(id) 일치 조회다.
      const { data, error } = await supabase
        .from("news_clipping_digests")
        .select("id, clip_date, team_id, team_name, overview, articles")
        .in("id", ids);
      if (error) return { rows: [], error: error.message };
      return { rows: (data ?? []) as NewsClippingDigest[] };
    };
    loaderRef.current = new NewsClippingDigestLoader(fetcher, {
      onChange: (next) => setDigests(next),
      onError: (message) => {
        // 실패는 조용히 둔다 — 카드가 아니라 텍스트 본문이 렌더된다(fail-close).
        console.error("[news-clipping] digest fetch failed:", message);
      },
    });
  }

  const wantedIds: number[] = [];
  for (const p of payloads) {
    if (!isRefNewsClippingPayload(p)) continue;
    if (!wantedIds.includes(p.digest_id)) wantedIds.push(p.digest_id);
  }
  // 의존성 안정화: 배열 자체는 매 렌더 새 참조이므로 정렬된 키 문자열로 비교한다.
  const wantedKey = wantedIds.slice().sort((a, b) => a - b).join(",");

  useEffect(() => {
    const loader = loaderRef.current;
    if (!loader || !wantedKey) return;
    loader.request(wantedKey.split(",").map((v) => Number(v)));
  }, [wantedKey]);

  useEffect(() => {
    return () => {
      loaderRef.current?.dispose();
      loaderRef.current = null;
    };
  }, []);

  return digests;
}
