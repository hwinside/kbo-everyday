"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { supabase } from "./client";
import { useAuth } from "./AuthContext";
import { normalizeForFloodKey } from "@/lib/utils/normalize-message";

export interface ChatMessage {
  id: number;
  room_id: string;
  user_id: string;
  content: string;
  created_at: string;
  deleted_at?: string | null;
  deleted_by?: string | null;
  // joined from profiles
  nickname?: string;
  team_id?: number;
  grade?: string;
}

const PAGE_SIZE = 50;
const DELETED_PLACEHOLDER = "삭제된 메시지입니다";

type ChatRow = ChatMessage & { profiles?: { nickname?: string; team_id?: number; grade?: string } };

function mapRow(r: ChatRow): ChatMessage {
  return {
    id: r.id,
    room_id: r.room_id,
    user_id: r.user_id,
    content: r.content,
    created_at: r.created_at,
    deleted_at: r.deleted_at ?? null,
    deleted_by: r.deleted_by ?? null,
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
  // 가장 최신 메시지의 created_at — visibility 복귀/재구독 시 gap backfill 커서.
  const latestCreatedAtRef = useRef<string | null>(null);
  // loadMore 동시 호출 가드 (IntersectionObserver가 다중 fire할 수 있음)
  const loadingMoreRef = useRef(false);

  // 최근 메시지 로드
  useEffect(() => {
    if (!roomId) return;
    setLoading(true);  // 방 전환 시 로딩 리셋
    setMessages([]);
    setHasMore(true);
    oldestCursorRef.current = null;
    latestCreatedAtRef.current = null;

    async function load() {
      try {
        const { data, error } = await supabase
          .from("chat_messages")
          .select("*, profiles!user_id(nickname, team_id, grade)")
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
            latestCreatedAtRef.current = mapped[mapped.length - 1].created_at;
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

  // Realtime 구독 (보조 경로: 다른 유저 메시지 수신용).
  // PWA/iOS Safari가 백그라운드 진입했다가 복귀하면 WebSocket이 dead 상태로
  // 남는 경우가 있어 새 INSERT가 영영 안 들어옴 → 사용자는 "나갔다 들어와야
  // 보임"으로 인지. status 콜백으로 dead 채널 감지 + visibility/online 복귀
  // 시 채널 재구독 + 누락 메시지 backfill 둘 다 수행.
  useEffect(() => {
    if (!roomId) return;

    let channel: RealtimeChannel | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    const handleInsert = async (payload: { new: ChatMessage }) => {
      const msg = payload.new;
      const { data: prof } = await supabase
        .from("profiles")
        .select("nickname, team_id, grade")
        .eq("id", msg.user_id)
        .single();
      if (cancelled) return;

      const newMsg: ChatMessage = {
        ...msg,
        nickname: prof?.nickname ?? "익명",
        team_id: prof?.team_id,
        grade: prof?.grade,
      };

      setMessages((prev) => {
        if (prev.some((m) => m.id === newMsg.id)) return prev;
        if (newMsg.created_at) {
          const cur = latestCreatedAtRef.current;
          if (!cur || newMsg.created_at > cur) {
            latestCreatedAtRef.current = newMsg.created_at;
          }
        }
        return [...prev, newMsg];
      });
    };

    const handleUpdate = (payload: { new: ChatMessage }) => {
      const updated = payload.new;
      setMessages((prev) =>
        prev.map((m) =>
          m.id === updated.id
            ? {
                ...m,
                content: updated.content,
                deleted_at: updated.deleted_at ?? null,
                deleted_by: updated.deleted_by ?? null,
              }
            : m
        )
      );
    };

    // 누락된 신규 메시지 채우기.
    // - cursor 있음(정상): 마지막으로 본 created_at 이후 INSERT 100건까지 (asc).
    // - cursor 없음(fallback): 빈/조용한 방에서 초기 load 후 한 건도 없던 상태.
    //   realtime이 dead였던 동안 들어온 첫 메시지를 못 받을 수 있어 최신
    //   PAGE_SIZE건을 강제 fetch (desc → asc 변환). 어느 경로든 id dedupe로 중복 흡수.
    const backfill = async () => {
      const cursor = latestCreatedAtRef.current;
      let query = supabase
        .from("chat_messages")
        .select("*, profiles!user_id(nickname, team_id, grade)")
        .eq("room_id", roomId);
      if (cursor) {
        query = query.gt("created_at", cursor).order("created_at", { ascending: true }).limit(100);
      } else {
        query = query.order("created_at", { ascending: false }).limit(PAGE_SIZE);
      }
      const { data, error } = await query;
      if (cancelled) return;
      if (error) {
        console.error("[useChat] backfill error:", error.message);
        return;
      }
      if (!data || data.length === 0) return;
      // cursor 없는 경로는 desc로 받았으므로 asc로 뒤집어 통일.
      const rows = cursor ? (data as ChatRow[]) : (data as ChatRow[]).slice().reverse();
      const fresh = rows.map(mapRow);
      const reachedEnd = !cursor && data.length < PAGE_SIZE;
      setMessages((prev) => {
        const existing = new Set(prev.map((m) => m.id));
        const added = fresh.filter((m) => !existing.has(m.id));
        if (added.length === 0) return prev;
        const lastAt = added[added.length - 1].created_at;
        if (lastAt && (!latestCreatedAtRef.current || lastAt > latestCreatedAtRef.current)) {
          latestCreatedAtRef.current = lastAt;
        }
        const firstAt = added[0].created_at;
        if (firstAt && (!oldestCursorRef.current || firstAt < oldestCursorRef.current)) {
          oldestCursorRef.current = firstAt;
        }
        return [...prev, ...added];
      });
      if (reachedEnd) setHasMore(false);
    };

    const subscribe = () => {
      if (cancelled) return;
      channel = supabase
        .channel(`chat:${roomId}`)
        .on(
          "postgres_changes",
          {
            event: "INSERT",
            schema: "public",
            table: "chat_messages",
            filter: `room_id=eq.${roomId}`,
          },
          handleInsert
        )
        .on(
          "postgres_changes",
          {
            event: "UPDATE",
            schema: "public",
            table: "chat_messages",
            filter: `room_id=eq.${roomId}`,
          },
          handleUpdate
        )
        .subscribe((status) => {
          if (cancelled) return;
          if (status === "SUBSCRIBED") {
            // 재구독 직후 누락 흡수 (백그라운드 동안 들어온 메시지)
            void backfill();
          } else if (
            status === "CHANNEL_ERROR" ||
            status === "TIMED_OUT" ||
            status === "CLOSED"
          ) {
            scheduleReconnect(1000);
          }
        });
    };

    const scheduleReconnect = (delay: number) => {
      if (cancelled || reconnectTimer) return;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (cancelled) return;
        if (channel) {
          supabase.removeChannel(channel);
          channel = null;
        }
        subscribe();
      }, delay);
    };

    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      // 보이는 즉시 gap 메우기. 채널이 살아있으면 backfill만으로 충분히 빠름.
      void backfill();
      // 채널이 dead일 수도 있으므로 즉시 재구독 (subscribe 콜백이 SUBSCRIBED
      // 재진입 시 backfill을 한 번 더 호출하지만, prev.some(id) dedupe로 무해).
      scheduleReconnect(0);
    };

    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onVisible);

    subscribe();

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onVisible);
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (channel) {
        supabase.removeChannel(channel);
        channel = null;
      }
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
        .select("*, profiles!user_id(nickname, team_id, grade)")
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

      // 동일/변형 도배 차단: 정규화 키 기준 최근 5건 내 같은 내용
      // (ㄷㄷㄷ → ㄷㄷㄷㄷ → "ㄷ ㄷ ㄷ" 변형이 같은 키로 묶여 차단됨)
      const floodKey = normalizeForFloodKey(trimmed);
      if (recentContentsRef.current.includes(floodKey)) {
        setCooldown(true);
        setCooldownReason("같은 메시지는 반복해서 보낼 수 없어요");
        setTimeout(() => { setCooldown(false); setCooldownReason(""); }, COOLDOWN_MS);
        return false;
      }

      lastSentRef.current = now;
      sentTimestampsRef.current.push(now);
      recentContentsRef.current = [...recentContentsRef.current.slice(-4), floodKey];
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
        .select("*, profiles!user_id(nickname, team_id, grade)")
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
        if (newMsg.created_at) {
          const cur = latestCreatedAtRef.current;
          if (!cur || newMsg.created_at > cur) {
            latestCreatedAtRef.current = newMsg.created_at;
          }
        }
        return [...prev, newMsg];
      });

      return true;
    },
    [user, profile, roomId]
  );

  // 본인 메시지 삭제 — SECURITY DEFINER RPC 경유 (스펙 §3, GO 게이트 4건).
  // 클라이언트가 chat_messages를 직접 .update() 하는 경로는 금지.
  const deleteMyMessage = useCallback(
    async (messageId: number) => {
      if (!user) return false;
      const { error } = await supabase.rpc("delete_own_chat_message", { p_message_id: messageId });
      if (error) {
        console.error("[useChat] delete error:", error.message);
        return false;
      }
      // optimistic: Realtime UPDATE도 곧 도착하지만, 본인 디바이스 즉시 갱신.
      // DB가 content를 동일 placeholder로 덮어쓰므로 깜빡임 없음.
      setMessages((prev) =>
        prev.map((m) =>
          m.id === messageId
            ? {
                ...m,
                content: DELETED_PLACEHOLDER,
                deleted_at: new Date().toISOString(),
                deleted_by: user.id,
              }
            : m
        )
      );
      return true;
    },
    [user]
  );

  // 운영자 삭제 — 타인 메시지 soft-delete. SECURITY DEFINER RPC가 서버측 is_operator 확인.
  // 클라이언트가 chat_messages를 직접 .update() 하는 경로는 금지(본인삭제와 동일).
  const deleteAnyMessage = useCallback(
    async (messageId: number) => {
      if (!user) return false;
      const { error } = await supabase.rpc("delete_any_chat_message", { p_message_id: messageId });
      if (error) {
        console.error("[useChat] operator delete error:", error.message);
        return false;
      }
      setMessages((prev) =>
        prev.map((m) =>
          m.id === messageId
            ? {
                ...m,
                content: DELETED_PLACEHOLDER,
                deleted_at: new Date().toISOString(),
                deleted_by: user.id,
              }
            : m
        )
      );
      return true;
    },
    [user]
  );

  return { messages, loading, loadingMore, hasMore, loadMore, sendMessage, deleteMyMessage, deleteAnyMessage, cooldown, cooldownReason, isLoggedIn: !!user };
}
