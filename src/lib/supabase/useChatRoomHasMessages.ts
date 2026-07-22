"use client";

import { useEffect, useState } from "react";
import { supabase } from "./client";

export function useChatRoomHasMessages(roomId: string) {
  const [result, setResult] = useState({ roomId, hasMessages: false, loading: true });

  useEffect(() => {
    let cancelled = false;

    void supabase
      .from("chat_messages")
      .select("id")
      .eq("room_id", roomId)
      .limit(1)
      .then(({ data }) => {
        if (!cancelled) {
          setResult({ roomId, hasMessages: (data?.length ?? 0) > 0, loading: false });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [roomId]);

  return result.roomId === roomId
    ? { hasMessages: result.hasMessages, loading: result.loading }
    : { hasMessages: false, loading: true };
}
