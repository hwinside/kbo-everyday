"use client";

import { useEffect, useState, useCallback } from "react";
import { supabase } from "./client";
import { useAuth } from "./AuthContext";

export function useUnreadDMCount() {
  const { user } = useAuth();
  const [count, setCount] = useState(0);

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

  useEffect(() => { load(); }, [load]); // eslint-disable-line react-hooks/set-state-in-effect

  // Realtime 구독 — dm_messages INSERT 시 리카운트
  useEffect(() => {
    if (!user) return;

    const channel = supabase
      .channel("dm-unread-count")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "dm_messages" },
        () => { load(); }
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [user, load]);

  return count;
}
