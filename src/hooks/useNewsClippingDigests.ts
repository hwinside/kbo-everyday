"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
 * ⚠️ 삼순 blocker 1 (2026-08-20): 1차 구현은 요청 단위 generation fence 를 썼다. A 조회 중
 *    Realtime 으로 B 가 들어오면 generation 이 바뀌어 **A 응답이 통째로 폐기**되는데, A 의 id 는
 *    이미 `attempted` 에 들어가 있어 **영원히 재조회되지 않았다**. 그 쪽지는 계속 텍스트로 남는다.
 *    → generation fence 를 버리고 요청별 in-flight 추적 + 결과 merge 로 바꾼다.
 *       - 성공한 id 만 캐시에 남는다.
 *       - 실패/미해결 id 는 in-flight 에서 풀려 다음 렌더에 재시도된다.
 *       - 언마운트 뒤에는 setState 를 하지 않는다(폐기 대상은 상태 갱신뿐, 재시도 자격은 유지).
 */
export function useNewsClippingDigests(
  payloads: unknown[],
): Map<number, NewsClippingDigest> {
  const [digests, setDigests] = useState<Map<number, NewsClippingDigest>>(new Map());
  /** 지금 요청 중인 id — 같은 id 를 동시에 두 번 조회하지 않기 위한 것뿐이다. */
  const inFlightRef = useRef<Set<number>>(new Set());
  /** 이미 성공적으로 받은 id — 재조회 불필요. */
  const resolvedRef = useRef<Set<number>>(new Set());
  /** 실패 id 별 시도 횟수 — 무한 재시도를 막되, 영구 차단은 하지 않는다. */
  const failureRef = useRef<Map<number, number>>(new Map());
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  /** 같은 id 를 계속 두드리지 않도록 하는 상한. 넘으면 그 세션에서는 텍스트로 렌더된다. */
  const MAX_ATTEMPTS = 3;

  const wantedIds: number[] = [];
  for (const p of payloads) {
    if (!isRefNewsClippingPayload(p)) continue;
    if (!wantedIds.includes(p.digest_id)) wantedIds.push(p.digest_id);
  }
  // 의존성 안정화: 배열 자체는 매 렌더 새 참조이므로 정렬된 키 문자열로 비교한다.
  const wantedKey = wantedIds.slice().sort((a, b) => a - b).join(",");

  const fetchDigests = useCallback(async (ids: number[]) => {
    if (ids.length === 0) return;
    for (const id of ids) inFlightRef.current.add(id);

    try {
      // query-guard: bounded -- ids 는 현재 화면 메시지에서 뽑은 digest_id 집합(대화 1개당
      // 최대 100 메시지)이고 PK(id) 일치 조회다.
      const { data, error } = await supabase
        .from("news_clipping_digests")
        .select("id, clip_date, team_id, team_name, overview, articles")
        .in("id", ids);

      const received = new Set<number>();
      if (!error && data) {
        const rows = (data as NewsClippingDigest[]).filter(
          (row) => Array.isArray(row.articles) && row.articles.length > 0,
        );
        for (const row of rows) {
          received.add(row.id);
          resolvedRef.current.add(row.id);
        }
        // ⚠️ 언마운트됐어도 resolvedRef 는 갱신한다 — 그래야 재마운트 시 재조회가 준다.
        //    다만 setState 는 마운트 상태에서만 한다.
        if (mountedRef.current && rows.length > 0) {
          setDigests((prev) => {
            const next = new Map(prev);
            for (const row of rows) next.set(row.id, row);
            return next;
          });
        }
      } else if (error) {
        // 실패는 조용히 둔다 — 카드가 아니라 텍스트 본문이 렌더된다(fail-close).
        console.error("[news-clipping] digest fetch failed:", error.message);
      }

      // 못 받은 id 는 실패로 기록하고 in-flight 에서 풀어 재시도 자격을 남긴다.
      // (1차 구현은 여기서 영구 차단됐다 — 그게 blocker 1 이다.)
      for (const id of ids) {
        if (received.has(id)) {
          failureRef.current.delete(id);
        } else {
          failureRef.current.set(id, (failureRef.current.get(id) ?? 0) + 1);
        }
      }
    } finally {
      for (const id of ids) inFlightRef.current.delete(id);
    }
  }, []);

  useEffect(() => {
    if (!wantedKey) return;
    const ids = wantedKey
      .split(",")
      .map((v) => Number(v))
      .filter(
        (v) =>
          Number.isFinite(v) &&
          !resolvedRef.current.has(v) &&
          !inFlightRef.current.has(v) &&
          (failureRef.current.get(v) ?? 0) < MAX_ATTEMPTS,
      );
    if (ids.length === 0) return;
    void fetchDigests(ids);
  }, [wantedKey, fetchDigests]);

  return digests;
}
