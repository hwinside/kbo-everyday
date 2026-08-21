"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { supabase } from "./client";
import { useAuth } from "./AuthContext";
import { usePollingFallback } from "./usePollingFallback";
import { BASEBALL_GENIUS_USER_ID } from "@/lib/constants/baseball-genius";

// Realtime 구독이 죽어 있는 동안(피크 구독풀 타임아웃)만 도는 안전망 폴링 주기.
const DM_UNREAD_POLL_MS = 30_000;

export function useUnreadDMCount() {
  const { user } = useAuth();
  const [count, setCount] = useState(0);
  const [realtimeHealthy, setRealtimeHealthy] = useState(false);
  const channelGenerationRef = useRef(0);

  const load = useCallback(async () => {
    if (!user) { setCount(0); return; }

    // query-guard: bounded -- 미읽음 배지는 최신 대화 500개만 집계하며 RPC도 동일 상한을 강제한다.
    // 야잘알봇 제외는 **서버쪽**에서 한다(삼순 NO-GO ②) — limit(500) 뒤 클라 필터만 있으면
    // 봇방이 일반방 1칸을 먹는 경계가 생긴다. 클라 필터는 방어용으로 유지.
    const { data: convs } = await supabase
      .from("dm_conversations")
      .select("id, user1_id, user2_id")
      .or(`user1_id.eq.${user.id},user2_id.eq.${user.id}`)
      // ⚠️ `.not(col, "eq", v)` 는 NULL 비안전 — 탈퇴로 participant 가 NULL 이면
      // `NULL != v` 가 NULL 로 평가돼 그 대화까지 사라진다(삼순 NO-GO). 양쪽 모두
      // `IS NULL OR != bot` 으로 NULL-safe 하게 제외한다.
      .or(`user1_id.is.null,user1_id.neq.${BASEBALL_GENIUS_USER_ID}`)
      .or(`user2_id.is.null,user2_id.neq.${BASEBALL_GENIUS_USER_ID}`)
      .order("last_message_at", { ascending: false })
      .limit(500);

    if (!convs || convs.length === 0) { setCount(0); return; }

    // 야잘알봇 대화는 배지에서 제외한다 (2026-08-21) — 쪽지함 목록에서 숨겼으므로
    // 여기 포함되면 유저가 지울 수 없는 배지가 된다(목록에 해당 방이 안 보임).
    const convIds = convs
      .filter((c: { user1_id: string | null; user2_id: string | null }) =>
        c.user1_id !== BASEBALL_GENIUS_USER_ID && c.user2_id !== BASEBALL_GENIUS_USER_ID)
      .map((c: { id: string }) => c.id);

    if (convIds.length === 0) { setCount(0); return; }

    // query-guard: bounded -- RPC는 요청 대화당 최대 한 행을 반환하고 501개 이상은 빈 결과로 fail-close
    const { data: unreadRows } = await supabase
      .rpc("dm_unread_counts", { p_conversation_ids: convIds });

    setCount(
      (unreadRows ?? []).reduce(
        (total: number, row: { unread_count: number | string }) =>
          total + Number(row.unread_count),
        0,
      ),
    );
  }, [user]);

  // 초기 load·Realtime refresh·폴링 폴백 모두 단일 request owner(single-flight)로 실행.
  // (컨슈머 효과보다 먼저 호출해 컨트롤러가 선생성되게 한다.)
  const requestLoad = usePollingFallback(load, {
    enabled: !!user,
    healthy: realtimeHealthy,
    intervalMs: DM_UNREAD_POLL_MS,
  });

  useEffect(() => { requestLoad(); }, [load, requestLoad]);

  // Realtime 구독 — dm_messages INSERT 시 리카운트. 구독 상태를 폴링 폴백에 전달.
  useEffect(() => {
    if (!user) return;
    const generation = ++channelGenerationRef.current;

    const channel = supabase
      .channel("dm-unread-count")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "dm_messages" },
        () => { requestLoad(); }
      )
      .subscribe((status) => {
        if (channelGenerationRef.current !== generation) return;
        setRealtimeHealthy(status === "SUBSCRIBED");
      });

    return () => {
      if (channelGenerationRef.current === generation) {
        channelGenerationRef.current += 1;
        setRealtimeHealthy(false);
      }
      void supabase.removeChannel(channel);
    };
  }, [user, requestLoad]);

  return count;
}
