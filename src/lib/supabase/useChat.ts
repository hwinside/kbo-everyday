"use client";

import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { supabase } from "./client";
import { useAuth } from "./AuthContext";
import { normalizeForFloodKey } from "@/lib/utils/normalize-message";
import { checkObjectionableContent } from "@/lib/moderation/content-filter";

export interface ChatMessage {
  id: number;
  room_id: string;
  user_id: string;
  content: string;
  created_at: string;
  deleted_at?: string | null;
  deleted_by?: string | null;
  // 1-depth 답글: 가리키는 원글(루트) id. null이면 루트 메시지.
  reply_to_id?: number | null;
  // joined from profiles
  nickname?: string;
  team_id?: number;
  grade?: string;
}

const PAGE_SIZE = 50;
const DELETED_PLACEHOLDER = "삭제된 메시지입니다";

export interface ChatCounts {
  total: number;
  home: number;
  away: number;
}

// 카운트 head 쿼리 재조회(reconcile) 최소 간격 — 즉시성은 낙관적 증분이
// 담당하므로 서버 재조회는 드리프트 교정용으로만 느슐하게(과도한 폴링 방지).
const COUNTS_MIN_INTERVAL_MS = 15000;

// 낙관적 증분 추적자 — 서버 베이스라인 이후 도착분만 세고, id 기준 dedupe로
// backfill/재구독 시 같은 메시지를 두 번 세지 않는다.
export interface ChatCountTracker {
  // 베이스라인(서버 count) 포충 상한 id — 이보다 큰 id만 낙관적 +1 대상.
  // 첫 서버 카운트 전에는 Infinity(증분 금지).
  baselineMaxId: number;
  // 관찰한 메시지 id → { 삭제 여부, 작성자 최애팀 }. 삭제 전이(-1) 감지용.
  known: Map<number, { deleted: boolean; teamId?: number }>;
}

/**
 * messages 스냅샷을 훑어 tracker에 없던 새 메시지/삭제 전이를 반영하고
 * 이번 패스의 카운트 증감분을 반환한다 (순수 함수 + tracker 누적, 테스트 가능).
 * - 새 id > baselineMaxId & 미삭제 → +1 (loadMore prepend된 과거 id는 베이스라인에 이미 포함이라 제외)
 * - 이미 세었거나 베이스라인에 포함된 메시지가 삭제로 전이 → -1
 * - 처음부터 삭제 상태로 관찰된 메시지는 카운트 불변 (서버 count도 이미 제외)
 */
export function trackCountDeltas(
  tracker: ChatCountTracker,
  messages: Pick<ChatMessage, "id" | "deleted_at" | "team_id">[],
  homeTeamId: number,
  awayTeamId: number
): ChatCounts {
  const d: ChatCounts = { total: 0, home: 0, away: 0 };
  const bump = (teamId: number | undefined, sign: 1 | -1) => {
    d.total += sign;
    if (teamId === homeTeamId) d.home += sign;
    else if (teamId === awayTeamId) d.away += sign;
  };
  for (const m of messages) {
    const prev = tracker.known.get(m.id);
    const deleted = !!m.deleted_at;
    if (prev) {
      if (!prev.deleted && deleted) {
        prev.deleted = true;
        bump(prev.teamId, -1);
      }
    } else {
      tracker.known.set(m.id, { deleted, teamId: m.team_id });
      if (m.id > tracker.baselineMaxId && !deleted) bump(m.team_id, 1);
    }
  }
  return d;
}

const ZERO_DELTA: ChatCounts = { total: 0, home: 0, away: 0 };

/**
 * 방 누적 메시지 카운트(삭제 제외) + 홈/원정 최애팀 유저 글 수 — 실시간 느낌.
 * - 서버 count(head:true) 쿼리 3발 병렬 = 베이스라인 (로드된 페이지와 무관한 실제 누적치).
 * - 새 메시지 도착(본인 전송 + realtime/backfill 수신) 시 즉시 낙관적 +1,
 *   삭제 전이 시 -1. 서버 재조회(최소 15초 간격)는 드리프트 reconcile용.
 * - 삭제(soft delete)된 메시지는 UI에서 숨기므로 카운트에서도 제외해 일관성 유지.
 */
export function useChatCounts(
  roomId: string,
  homeTeamId: number,
  awayTeamId: number,
  messages: ChatMessage[]
) {
  const [counts, setCounts] = useState<ChatCounts | null>(null);
  const [delta, setDelta] = useState<ChatCounts>(ZERO_DELTA);
  // 마지막 조회 시각 — roomId별로 기록해 방 전환 시 디바운스 없이 즉시 조회.
  const lastFetchRef = useRef<{ roomId: string; at: number }>({ roomId: "", at: 0 });
  // roomId별 추적자 — 방 전환 시 effect 안에서 레이지하게 리셋 (렌더 중 ref 쓰기 금지).
  const trackerRef = useRef<{ roomId: string; tracker: ChatCountTracker }>({
    roomId: "",
    tracker: { baselineMaxId: Infinity, known: new Map() },
  });
  const trackerFor = useCallback((rid: string): ChatCountTracker => {
    if (trackerRef.current.roomId !== rid) {
      trackerRef.current = { roomId: rid, tracker: { baselineMaxId: Infinity, known: new Map() } };
    }
    return trackerRef.current.tracker;
  }, []);
  // fetch 완료 시점의 최신 messages로 베이스라인을 재설정하기 위한 ref
  // (아래 낙관적 증분 effect에서 갱신 — 렌더 중 쓰기 금지).
  const messagesRef = useRef(messages);

  // 재조회 트리거: 마지막(최신) 메시지 id. 전송/수신(append)시만 바뀌고
  // loadMore(prepend)에는 불변 — 과거 페이지 로드로 재조회 안 함.
  const refreshKey = messages.length > 0 ? messages[messages.length - 1].id : 0;

  // 방 전환 시 렌더 중 리셋 (React 권장 "adjusting state when props change" 패턴).
  const [prevRoomId, setPrevRoomId] = useState(roomId);
  if (prevRoomId !== roomId) {
    setPrevRoomId(roomId);
    setCounts(null);
    setDelta(ZERO_DELTA);
  }

  useEffect(() => {
    if (!roomId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const baseCount = () =>
      supabase
        .from("chat_messages")
        .select("id", { count: "exact", head: true })
        .eq("room_id", roomId)
        .is("deleted_at", null);

    const teamCount = (teamId: number) =>
      supabase
        .from("chat_messages")
        .select("id, profiles!user_id!inner(team_id)", { count: "exact", head: true })
        .eq("room_id", roomId)
        .is("deleted_at", null)
        .eq("profiles.team_id", teamId);

    const fetchCounts = async () => {
      lastFetchRef.current = { roomId, at: Date.now() };
      const [totalRes, homeRes, awayRes] = await Promise.all([
        baseCount(),
        teamCount(homeTeamId),
        teamCount(awayTeamId),
      ]);
      if (cancelled) return;
      if (totalRes.error) {
        console.error("[useChatCounts] error:", totalRes.error.message);
        return;
      }
      setCounts({
        total: totalRes.count ?? 0,
        home: homeRes.error ? 0 : homeRes.count ?? 0,
        away: awayRes.error ? 0 : awayRes.count ?? 0,
      });
      // 베이스라인 재설정 — 현재 로드된 메시지는 서버 count에 포함된 것으로 보고
      // 이후 도착분만 낙관적 증분. 누적 delta는 reconcile되었으므로 0으로.
      const msgs = messagesRef.current;
      trackerRef.current = {
        roomId,
        tracker: {
          baselineMaxId: msgs.reduce((mx, m) => (m.id > mx ? m.id : mx), 0),
          known: new Map(msgs.map((m) => [m.id, { deleted: !!m.deleted_at, teamId: m.team_id }])),
        },
      };
      setDelta(ZERO_DELTA);
    };

    const last = lastFetchRef.current;
    const elapsed = last.roomId === roomId ? Date.now() - last.at : Infinity;
    if (elapsed >= COUNTS_MIN_INTERVAL_MS) {
      void fetchCounts();
    } else {
      timer = setTimeout(() => void fetchCounts(), COUNTS_MIN_INTERVAL_MS - elapsed);
    }

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [roomId, homeTeamId, awayTeamId, refreshKey]);

  // 낙관적 즉시 증분: messages 변화마다 새 도착/삭제 전이분만 반영 (id dedupe).
  useEffect(() => {
    messagesRef.current = messages;
    const d = trackCountDeltas(trackerFor(roomId), messages, homeTeamId, awayTeamId);
    if (d.total !== 0 || d.home !== 0 || d.away !== 0) {
      setDelta((prev) => ({
        total: prev.total + d.total,
        home: prev.home + d.home,
        away: prev.away + d.away,
      }));
    }
  }, [roomId, messages, homeTeamId, awayTeamId, trackerFor]);

  return useMemo<ChatCounts | null>(() => {
    if (!counts) return null;
    return {
      total: Math.max(0, counts.total + delta.total),
      home: Math.max(0, counts.home + delta.home),
      away: Math.max(0, counts.away + delta.away),
    };
  }, [counts, delta]);
}

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
    reply_to_id: r.reply_to_id ?? null,
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
  // 이미 fetch 시도한 (로드 안 된) 부모 메시지 id — 중복/무한 fetch 방지. 방 전환 시 리셋.
  const fetchedParentsRef = useRef<Set<number>>(new Set());

  // 최근 메시지 로드
  useEffect(() => {
    if (!roomId) return;
    setLoading(true);  // 방 전환 시 로딩 리셋
    setMessages([]);
    setHasMore(true);
    oldestCursorRef.current = null;
    latestCreatedAtRef.current = null;
    fetchedParentsRef.current = new Set();

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

  // 답글의 원글(루트)이 아직 로드되지 않은 경우(루트가 더 오래된 페이지에 있을 때)
  // 해당 루트를 보충 fetch한다. 그래야 답글이 원글 아래로 그룹핑되어 노출된다.
  // fetchedParentsRef로 같은 id 재요청을 막아 무한 루프를 방지(없는 id도 1회만 시도).
  useEffect(() => {
    if (!roomId) return;
    const loadedIds = new Set(messages.map((m) => m.id));
    const missing = Array.from(
      new Set(
        messages
          .filter((m) => m.reply_to_id != null && !loadedIds.has(m.reply_to_id))
          .map((m) => m.reply_to_id as number)
      )
    ).filter((pid) => !fetchedParentsRef.current.has(pid));
    if (missing.length === 0) return;
    missing.forEach((pid) => fetchedParentsRef.current.add(pid));

    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from("chat_messages")
        .select("*, profiles!user_id(nickname, team_id, grade)")
        .eq("room_id", roomId) // cross-room 원글 보충 차단 — 현재 방 원글만 렌더
        .in("id", missing);
      if (cancelled || error || !data) return;
      const fetched = (data as ChatRow[]).map(mapRow);
      setMessages((prev) => {
        const existing = new Set(prev.map((m) => m.id));
        const added = fetched.filter((m) => !existing.has(m.id));
        if (added.length === 0) return prev;
        // created_at 오름차순 불변식 유지 (loadMore=prepend, append=push 전제).
        return [...prev, ...added].sort((a, b) =>
          a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0
        );
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [messages, roomId]);

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
    async (content: string, replyToId?: number | null) => {
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

      // 모더레이션 필터(욕설/스팸) — 전송 전 차단.
      const cf = checkObjectionableContent({ content: trimmed });
      if (!cf.allowed) {
        setCooldown(true);
        setCooldownReason(cf.issues[0] ?? "부적절한 표현이 포함되어 있습니다");
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
          ...(replyToId != null ? { reply_to_id: replyToId } : {}),
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
        reply_to_id: row.reply_to_id ?? null,
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
