"use client";

import { useEffect, useState, useCallback, useRef } from "react";
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

const PAGE_SIZE = 50;

type ChatRow = ChatMessage & { profiles?: { nickname?: string; team_id?: number; grade?: string } };

function mapRow(r: ChatRow): ChatMessage {
  return {
    id: r.id,
    room_id: r.room_id,
    user_id: r.user_id,
    content: r.content,
    created_at: r.created_at,
    nickname: r.profiles?.nickname,
    team_id: r.profiles?.team_id,
    grade: r.profiles?.grade,
  };
}

export function useChat(roomId: string) {
  const { user, profile } = useAuth();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [cooldown, setCooldown] = useState(false);
  const [cooldownReason, setCooldownReason] = useState<string>("");
  const lastSentRef = useRef(0);
  const sentTimestampsRef = useRef<number[]>([]);
  const recentContentsRef = useRef<string[]>([]);
  // 가장 오래된 메시지의 created_at — loadMore 커서. 방 전환 시 리셋.
  const oldestCursorRef = useRef<string | null>(null);
  // loadMore 동시 호출 가드 (IntersectionObserver가 다중 fire할 수 있음)
  const loadingMoreRef = useRef(false);

  // 최근 메시지 로드
  useEffect(() => {
    if (!roomId) return;
    setLoading(true);  // 방 전환 시 로딩 리셋
    setMessages([]);
    setHasMore(true);
    oldestCursorRef.current = null;

    async function load() {
      try {
        const { data, error } = await supabase
          .from("chat_messages")
          .select("*, profiles(nickname, team_id, grade)")
          .eq("room_id", roomId)
          .order("created_at", { ascending: false })
          .limit(PAGE_SIZE);

        if (error) {
          console.error("[useChat] load error:", error.message);
        }

        if (data) {
          const mapped = (data as ChatRow[]).reverse().map(mapRow);
          setMessages(mapped);
          if (mapped.length > 0) {
            oldestCursorRef.current = mapped[0].created_at;
          }
          if (data.length < PAGE_SIZE) setHasMore(false);
        }
      } catch (err) {
        console.error("[useChat] unexpected error:", err);
      } finally {
        setLoading(false);
      }
    }

    load();
  }, [roomId]);

  // Realtime 구독 (보조 경로: 다른 유저 메시지 수신용)
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

          // id dedupe: 본인 optimistic append와 중복 방지
          setMessages((prev) => {
            if (prev.some((m) => m.id === newMsg.id)) return prev;
            return [...prev, newMsg];
          });
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [roomId]);

  // 이전(더 오래된) 메시지 페이지 로드. cursor=oldestCursorRef.current 미만의 50개.
  const loadMore = useCallback(async () => {
    if (!roomId) return;
    if (loadingMoreRef.current) return;
    if (!oldestCursorRef.current) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      const cursor = oldestCursorRef.current;
      const { data, error } = await supabase
        .from("chat_messages")
        .select("*, profiles(nickname, team_id, grade)")
        .eq("room_id", roomId)
        .lt("created_at", cursor)
        .order("created_at", { ascending: false })
        .limit(PAGE_SIZE);

      if (error) {
        console.error("[useChat] loadMore error:", error.message);
        return;
      }

      const rows = (data ?? []) as ChatRow[];
      if (rows.length === 0) {
        setHasMore(false);
        return;
      }

      const mapped = [...rows].reverse().map(mapRow);
      // 새 cursor = 새로 가져온 페이지의 가장 오래된 것
      oldestCursorRef.current = mapped[0].created_at;
      if (rows.length < PAGE_SIZE) setHasMore(false);

      setMessages((prev) => {
        const existing = new Set(prev.map((m) => m.id));
        const fresh = mapped.filter((m) => !existing.has(m.id));
        return [...fresh, ...prev];
      });
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, [roomId]);

  // 메시지 전송 (주 경로: insert 결과 즉시 local append)
  const sendMessage = useCallback(
    async (content: string) => {
      if (!user || !content.trim() || content.trim().length > 120) return false;

      const now = Date.now();
      const trimmed = content.trim();
      const COOLDOWN_MS = 3000;

      // 기본 3초 쿨다운
      if (now - lastSentRef.current < COOLDOWN_MS) return false;

      // 슬라이딩 윈도우: 60초 내 10건 초과 시 30초 뮤트
      const WINDOW_MS = 60_000;
      const MAX_IN_WINDOW = 10;
      const MUTE_MS = 30_000;
      sentTimestampsRef.current = sentTimestampsRef.current.filter((t) => now - t < WINDOW_MS);
      if (sentTimestampsRef.current.length >= MAX_IN_WINDOW) {
        setCooldown(true);
        setCooldownReason("잠시 후 다시 입력해 주세요");
        setTimeout(() => { setCooldown(false); setCooldownReason(""); }, MUTE_MS);
        return false;
      }

      // 동일 메시지 차단: 최근 5건 내 같은 내용
      if (recentContentsRef.current.includes(trimmed)) {
        setCooldown(true);
        setCooldownReason("같은 메시지는 반복해서 보낼 수 없어요");
        setTimeout(() => { setCooldown(false); setCooldownReason(""); }, COOLDOWN_MS);
        return false;
      }

      lastSentRef.current = now;
      sentTimestampsRef.current.push(now);
      recentContentsRef.current = [...recentContentsRef.current.slice(-4), trimmed];
      setCooldown(true);
      setCooldownReason("");
      setTimeout(() => setCooldown(false), COOLDOWN_MS);

      const { data, error } = await supabase
        .from("chat_messages")
        .insert({
          room_id: roomId,
          user_id: user.id,
          content: content.trim(),
        })
        .select("*, profiles(nickname, team_id, grade)")
        .single();

      if (error || !data) {
        console.error("[useChat] send error:", error?.message);
        return false;
      }

      const row = data as ChatRow;
      const newMsg: ChatMessage = {
        id: row.id,
        room_id: row.room_id,
        user_id: row.user_id,
        content: row.content,
        created_at: row.created_at,
        nickname: row.profiles?.nickname ?? profile?.nickname ?? "익명",
        team_id: row.profiles?.team_id ?? (profile?.team_id != null ? Number(profile.team_id) : undefined),
        grade: row.profiles?.grade ?? profile?.grade,
      };

      // Realtime 이벤트와 dedupe: id 기준
      setMessages((prev) => {
        if (prev.some((m) => m.id === newMsg.id)) return prev;
        return [...prev, newMsg];
      });

      return true;
    },
    [user, profile, roomId]
  );

  return { messages, loading, loadingMore, hasMore, loadMore, sendMessage, cooldown, cooldownReason, isLoggedIn: !!user };
}
