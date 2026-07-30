"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { supabase } from "./client";
import { useAuth } from "./AuthContext";
import { usePollingFallback } from "./usePollingFallback";

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
    const { data: convs } = await supabase
      .from("dm_conversations")
      .select("id")
      .or(`user1_id.eq.${user.id},user2_id.eq.${user.id}`)
      .order("last_message_at", { ascending: false })
      .limit(500);

    if (!convs || convs.length === 0) { setCount(0); return; }

    const convIds = convs.map((c: { id: string }) => c.id);

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
