"use client";

import { useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabase/client";
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
 * 계약:
 *  - 이미 받은 id 는 다시 조회하지 않는다(대화 스크롤/Realtime 추가 때 재요청 방지).
 *  - 조회 실패·미도착 상태에서는 해당 id 가 Map 에 없다 → 호출부의 toNewsClippingView 가
 *    null 을 돌려 카드 대신 텍스트 본문으로 fail-close 된다. 빈 카드를 그리지 않는다.
 *  - 언마운트/대화 전환 뒤 늦게 도착한 응답이 다른 대화 상태를 오염시키지 않도록 generation fence 를 쓴다.
 */
export function useNewsClippingDigests(
  payloads: unknown[],
): Map<number, NewsClippingDigest> {
  const [digests, setDigests] = useState<Map<number, NewsClippingDigest>>(new Map());
  // 조회를 이미 시도한 id(성공/실패 무관) — 실패 id 를 매 렌더마다 재조회하는 루프를 막는다.
  // ⚠️ 렌더 중에는 읽지 않는다(react-hooks/refs). 필터링은 effect 안에서 한다.
  const attemptedRef = useRef<Set<number>>(new Set());
  const generationRef = useRef(0);

  // 렌더 중엔 "무엇을 원하는가"만 순수 계산한다. 중복 제거는 effect 의 일.
  const wantedIds: number[] = [];
  for (const p of payloads) {
    if (isRefNewsClippingPayload(p) && !wantedIds.includes(p.digest_id)) {
      wantedIds.push(p.digest_id);
    }
  }
  // 의존성 안정화: 배열 자체는 매 렌더 새 참조이므로 정렬된 키 문자열로 비교한다.
  const wantedKey = wantedIds.slice().sort((a, b) => a - b).join(",");

  useEffect(() => {
    if (!wantedKey) return;
    const ids = wantedKey
      .split(",")
      .map((v) => Number(v))
      .filter((v) => Number.isFinite(v) && !attemptedRef.current.has(v));
    if (ids.length === 0) return;

    const generation = ++generationRef.current;
    for (const id of ids) attemptedRef.current.add(id);

    (async () => {
      const { data, error } = await supabase
        .from("news_clipping_digests")
        .select("id, clip_date, team_id, team_name, overview, articles")
        .in("id", ids);

      if (generation !== generationRef.current) return; // stale 응답 폐기
      if (error || !data) {
        // 실패는 조용히 둔다 — 카드가 아니라 텍스트 본문이 렌더된다(fail-close).
        console.error("[news-clipping] digest fetch failed:", error?.message);
        return;
      }
      setDigests((prev) => {
        const next = new Map(prev);
        for (const row of data as NewsClippingDigest[]) {
          if (Array.isArray(row.articles) && row.articles.length > 0) next.set(row.id, row);
        }
        return next;
      });
    })();
  }, [wantedKey]);

  return digests;
}
