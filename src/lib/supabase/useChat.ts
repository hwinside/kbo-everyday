"use client";

import { useEffect, useState, useCallback } from "react";
import { supabase } from "./client";
import { useAuth } from "./AuthContext";

export interface ChatMessage {
  id: number;
  room_id: string;
  user_id: string;
  content: string;
  created_at: string;
  // joined from profiles
  nickname?: string;
  team_id?: number;
  grade?: string;
}

export function useChat(roomId: string) {
  const { user, profile } = useAuth();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);

  // 최근 메시지 로드
  useEffect(() => {
    if (!roomId) return;
    setLoading(true);  // 방 전환 시 로딩 리셋

    async function load() {
      try {
        const { data, error } = await supabase
          .from("chat_messages")
          .select("*, profiles(nickname, team_id, grade)")
          .eq("room_id", roomId)
          .order("created_at", { ascending: false })
          .limit(50);

        if (error) {
          console.error("[useChat] load error:", error.message);
        }

        if (data) {
          const mapped = data.reverse().map((m: ChatMessage & { profiles?: { nickname?: string; team_id?: number; grade?: string } }) => ({
            id: m.id,
            room_id: m.room_id,
            user_id: m.user_id,
            content: m.content,
            created_at: m.created_at,
            nickname: m.profiles?.nickname,
            team_id: m.profiles?.team_id,
            grade: m.profiles?.grade,
          }));
          setMessages(mapped);
        }
      } catch (err) {
        console.error("[useChat] unexpected error:", err);
      } finally {
        setLoading(false);
      }
    }

    load();
  }, [roomId]);

  // Realtime 구독
  useEffect(() => {
    if (!roomId) return;

    const channel = supabase
      .channel(`chat:${roomId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "chat_messages",
          filter: `room_id=eq.${roomId}`,
        },
        async (payload) => {
          const msg = payload.new as ChatMessage;
          // 프로필 조회
          const { data: prof } = await supabase
            .from("profiles")
            .select("nickname, team_id, grade")
            .eq("id", msg.user_id)
            .single();

          const newMsg: ChatMessage = {
            ...msg,
            nickname: prof?.nickname ?? "익명",
            team_id: prof?.team_id,
            grade: prof?.grade,
          };

          setMessages((prev) => [...prev, newMsg]);
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [roomId]);

  // 메시지 전송
  const sendMessage = useCallback(
    async (content: string) => {
      if (!user || !content.trim()) return false;

      const { error } = await supabase.from("chat_messages").insert({
        room_id: roomId,
        user_id: user.id,
        content: content.trim(),
      });

      return !error;
    },
    [user, roomId]
  );

  return { messages, loading, sendMessage, isLoggedIn: !!user };
}
