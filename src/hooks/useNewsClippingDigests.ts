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

/** 실제 조회기. 테스트는 이 자리에 가짜를 끼운다. */
async function fetchDigestRows(ids: number[]): Promise<DigestFetchResult> {
  // query-guard: bounded -- ids 는 현재 화면 메시지에서 뽑은 digest_id 집합(대화 1개당
  // 최대 100 메시지)이고 PK(id) 일치 조회다.
  const { data, error } = await supabase
    .from("news_clipping_digests")
    .select("id, clip_date, team_id, team_name, overview, articles")
    .in("id", ids);
  if (error) return { rows: [], error: error.message };
  return { rows: (data ?? []) as NewsClippingDigest[] };
}

/**
 * 참조형 뉴스클리핑 쪽지(payload.digest_id)가 가리키는 기사 묶음을 배치 조회한다.
 *
 * 2026-08-20 정규화 이전에는 같은 기사 묶음(약 2KB)이 수신자 수만큼 dm_messages.payload 에
 * 복제 저장됐다(8/18 KIA 6,102행 / distinct 120). 이제 digest 1행을 참조하므로 클라가
 * 한 번 조회해서 여러 쪽지에 공유한다.
 *
 * ⚠️ 재시도·겹침·부분누락 로직은 이 훅이 아니라 NewsClippingDigestLoader 가 갖는다.
 *    2차 구현은 실패 시 ref 만 갱신해 effect 가 다시 돌지 않았고, 그래서 **재시도가
 *    실제로는 한 번도 일어나지 않았다**(삼순 blocker 1). 리렌더를 재시도 트리거로 쓰면
 *    조용한 대화에서 영구 실패한다.
 *
 * ⚠️ 삼순 blocker (4차, 2026-08-20): 3차 구현은 로더를 **render 에서** 만들고 cleanup 에서
 *    `loaderRef.current = null` 로 지웠다. Next 16 App Router 는 StrictMode 가 기본이라
 *    dev 의 effect 는 `setup → cleanup → setup` 으로 두 번 도는데, **두 번째 setup 앞에는
 *    render 가 없다.** 그래서 두 번째 setup 에서 `loaderRef.current` 가 null 이라
 *    `wantedKey` effect 가 아무것도 안 하고 끝났다 — 실제 화면에서 카드가 안 뜬다.
 *    (순수 로더 테스트 8-1~8-7 은 이 배선을 안 태우므로 이 결함을 못 봤다.)
 *    → 로더의 **생성·폐기 소유권을 mount effect 에 둔다.** effect 는 선언 순서대로 돌므로
 *      이 effect 가 request effect 보다 먼저 있으면 재-setup 때도 로더가 먼저 살아난다.
 *      digest 캐시는 **훅이 소유**해 로더에 넘긴다(로더는 그 Map 을 그대로 쓴다).
 *      그래야 폐기된 첫 로더의 늦은 응답도 버려지지 않고, 재조회·깜박임이 없다.
 */
export function useNewsClippingDigests(
  payloads: unknown[],
  // 테스트 주입용. 프로덕션 호출부는 넘기지 않는다.
  fetcher: (ids: number[]) => Promise<DigestFetchResult> = fetchDigestRows,
): Map<number, NewsClippingDigest> {
  const [digests, setDigests] = useState<Map<number, NewsClippingDigest>>(new Map());
  const loaderRef = useRef<NewsClippingDigestLoader | null>(null);
  /** 훅이 소유하는 digest 캐시 — 로더 교체를 넘어 살아남는다. */
  const cacheRef = useRef<Map<number, NewsClippingDigest>>(new Map());
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const wantedIds: number[] = [];
  for (const p of payloads) {
    if (!isRefNewsClippingPayload(p)) continue;
    if (!wantedIds.includes(p.digest_id)) wantedIds.push(p.digest_id);
  }
  // 의존성 안정화: 배열 자체는 매 렌더 새 참조이므로 정렬된 키 문자열로 비교한다.
  const wantedKey = wantedIds.slice().sort((a, b) => a - b).join(",");
  const wantedKeyRef = useRef(wantedKey);
  wantedKeyRef.current = wantedKey;

  // ① 로더 수명 = 이 effect 의 수명. **반드시 request effect 보다 먼저 선언한다.**
  useEffect(() => {
    const loader = new NewsClippingDigestLoader(
      (ids) => fetcherRef.current(ids),
      {
        onChange: (next) => setDigests(next),
        cache: cacheRef.current,
        onError: (message) => {
          // 실패는 조용히 둔다 — 카드가 아니라 텍스트 본문이 렌더된다(fail-close).
          console.error("[news-clipping] digest fetch failed:", message);
        },
      },
    );
    loaderRef.current = loader;
    // 캐시에 이미 있는 digest 를 상태에 즉시 반영한다 — 재마운트 시 카드가 깜박이지 않는다.
    if (cacheRef.current.size > 0) setDigests(new Map(cacheRef.current));
    // 재-setup 이면 render 없이 여기로 오므로, 현재 필요한 id 를 여기서 곧바로 요청한다.
    // (아래 request effect 는 wantedKey 가 안 바뀌면 다시 돌지 않는다.)
    if (wantedKeyRef.current) {
      loader.request(wantedKeyRef.current.split(",").map((v) => Number(v)));
    }
    return () => {
      loader.dispose();
      if (loaderRef.current === loader) loaderRef.current = null;
    };
  }, []);

  // ② 화면에 필요한 digest_id 가 바뀔 때 요청한다.
  useEffect(() => {
    const loader = loaderRef.current;
    if (!loader || !wantedKey) return;
    loader.request(wantedKey.split(",").map((v) => Number(v)));
  }, [wantedKey]);

  return digests;
}
