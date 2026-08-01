"use client";

// 어드민 야잘알봇 대화 모니터링 — **읽기 전용** (운영팀 쪽지함 UI 패턴 재사용).
// 알림·배지·읽음 처리·답장 없음. match_path 배지로 응답 경로/비용을 관측한다.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  ArrowLeft,
  BrainCircuit,
  Loader2,
  MessageCircle,
  User,
} from "lucide-react";
import { getTeamById } from "@/lib/constants/teams";
import {
  createLatestRequestGate,
  type DetailCursor,
} from "@/lib/admin/baseball-genius-monitor";

interface Conversation {
  id: string;
  other_user_id: string | null;
  other_nickname: string;
  other_team_id: number | null;
  last_message: string | null;
  last_message_at: string;
  user_msg_count: number;
  sys_msg_count: number;
}

interface InboxCursor {
  lastMessageAt: string;
  conversationId: string;
}

interface MessageLog {
  match_path: string;
  input_tokens: number | null;
  output_tokens: number | null;
}

interface Message {
  id: number;
  sender_id: string | null;
  sender_nickname: string;
  content: string;
  image_urls?: string[] | null;
  created_at: string;
  is_genius: boolean;
  log: MessageLog | null;
}

const MATCH_PATH_STYLES: Record<string, { label: string; color: string }> = {
  dictionary: { label: "사전", color: "#30D158" },
  cache: { label: "캐시", color: "#0A84FF" },
  llm: { label: "LLM", color: "#BF5AF2" },
  service_redirect: { label: "안내", color: "#64D2FF" },
  history_hold: { label: "보류", color: "#FFD60A" },
  context_missing: { label: "맥락없음", color: "#FFD60A" },
  ack: { label: "인사", color: "#5E5CE6" },
  blocked: { label: "차단", color: "#FF453A" },
  unsure: { label: "불확실", color: "#FF9F0A" },
  limited: { label: "한도", color: "#FF9F0A" },
  error: { label: "오류", color: "#FF453A" },
};

function timeAgo(dateStr: string) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "방금";
  if (mins < 60) return `${mins}분 전`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}시간 전`;
  const days = Math.floor(hours / 24);
  return `${days}일 전`;
}

function getTeamColor(teamId: number | null) {
  if (!teamId) return "#6366F1";
  const team = getTeamById(teamId);
  return team?.colorPrimary || "#6366F1";
}

function MatchPathBadge({ log }: { log: MessageLog }) {
  const style = MATCH_PATH_STYLES[log.match_path] ?? {
    label: log.match_path,
    color: "#8E8E93",
  };
  const tokens =
    log.match_path === "llm" && (log.input_tokens || log.output_tokens)
      ? ` ${log.input_tokens ?? 0}→${log.output_tokens ?? 0}tok`
      : "";
  return (
    <span
      className="inline-flex items-center rounded-md px-1.5 py-0.5 text-[10px] font-semibold leading-none"
      style={{ background: `${style.color}20`, color: style.color }}
      title={`match_path: ${log.match_path}`}
    >
      {style.label}
      {tokens}
    </span>
  );
}

export default function AdminBaseballGeniusPage() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<InboxCursor | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [selectedConv, setSelectedConv] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [msgLoading, setMsgLoading] = useState(false);
  const [msgLoadingMore, setMsgLoadingMore] = useState(false);
  const [msgError, setMsgError] = useState(false);
  const [messageCursor, setMessageCursor] = useState<DetailCursor | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const detailRequestGate = useRef(createLatestRequestGate());
  const detailAbort = useRef<AbortController | null>(null);

  const getPin = useCallback(() => {
    if (typeof window !== "undefined") {
      return sessionStorage.getItem("admin_pin") || "";
    }
    return "";
  }, []);

  const loadConversations = useCallback(
    async (cursor: InboxCursor | null = null, append = false) => {
      if (append) {
        setLoadingMore(true);
      } else {
        setLoading(true);
        setLoadError(false);
      }
      try {
        const params = new URLSearchParams();
        if (cursor) {
          params.set("cursorAt", cursor.lastMessageAt);
          params.set("cursorId", cursor.conversationId);
        }
        const res = await fetch(`/api/admin/baseball-genius?${params}`, {
          headers: { "x-admin-pin": getPin() },
        });
        if (!res.ok) throw new Error("load failed");
        const json = await res.json();
        const incoming = (json.conversations || []) as Conversation[];
        setConversations((previous) => {
          if (!append) return incoming;
          const previousIds = new Set(previous.map((c) => c.id));
          return [...previous, ...incoming.filter((c) => !previousIds.has(c.id))];
        });
        setNextCursor(json.nextCursor || null);
      } catch {
        if (!append) setLoadError(true);
      }
      setLoading(false);
      setLoadingMore(false);
    },
    [getPin]
  );

  useEffect(() => {
    loadConversations();
  }, [loadConversations]);

  async function loadMessages(
    conv: Conversation,
    cursor: DetailCursor | null = null,
    append = false,
  ) {
    const requestToken = detailRequestGate.current.begin();
    detailAbort.current?.abort();
    const controller = new AbortController();
    detailAbort.current = controller;
    if (append) {
      setMsgLoadingMore(true);
    } else {
      setSelectedConv(conv);
      setMsgLoading(true);
      setMessages([]);
      setMessageCursor(null);
    }
    setMsgError(false);
    try {
      const params = new URLSearchParams({ conversationId: conv.id });
      if (cursor) {
        params.set("messageAt", cursor.messageAt);
        params.set("messageId", cursor.messageId);
      }
      const res = await fetch(`/api/admin/baseball-genius?${params}`, {
        headers: { "x-admin-pin": getPin() },
        signal: controller.signal,
      });
      if (!res.ok) throw new Error("load messages failed");
      const json = await res.json();
      if (!detailRequestGate.current.isCurrent(requestToken)) return;
      const incoming = (json.messages || []) as Message[];
      setMessages((previous) => append ? [...incoming, ...previous] : incoming);
      setMessageCursor(json.nextCursor || null);
      if (!append) {
        requestAnimationFrame(() => {
          messagesEndRef.current?.scrollIntoView({ behavior: "auto" });
        });
      }
    } catch (error) {
      if ((error as Error).name !== "AbortError" && detailRequestGate.current.isCurrent(requestToken)) {
        setMsgError(true);
      }
    } finally {
      if (detailRequestGate.current.isCurrent(requestToken)) {
        setMsgLoading(false);
        setMsgLoadingMore(false);
      }
    }
  }

  useEffect(() => () => detailAbort.current?.abort(), []);

  // 대화 상세 (읽기 전용 타임라인)
  if (selectedConv) {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <button
            onClick={() => {
              detailRequestGate.current.invalidate();
              detailAbort.current?.abort();
              setSelectedConv(null);
              setMessages([]);
              setMsgError(false);
              setMessageCursor(null);
            }}
            className="p-2 rounded-lg hover:bg-white/5 transition-colors"
            aria-label="목록으로"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div className="flex items-center gap-2">
            <div
              className="w-8 h-8 rounded-full flex items-center justify-center"
              style={{ background: `${getTeamColor(selectedConv.other_team_id)}20` }}
            >
              <User
                className="w-4 h-4"
                style={{ color: getTeamColor(selectedConv.other_team_id) }}
              />
            </div>
            <h1 className="text-lg font-bold">{selectedConv.other_nickname}</h1>
            <span className="text-xs text-[#636366]">읽기 전용</span>
          </div>
        </div>

        <div className="glass-card p-4 space-y-3 max-h-[70vh] overflow-y-auto">
          {msgLoading ? (
            <div className="flex justify-center py-8">
              <Loader2 className="w-6 h-6 animate-spin text-[#6366F1]" />
            </div>
          ) : msgError ? (
            <div className="py-10 text-center">
              <AlertCircle className="mx-auto mb-3 h-10 w-10 text-[#FF453A]" />
              <p className="mb-4 text-sm text-[#8E8E93]">대화를 불러오지 못했습니다</p>
              <button
                type="button"
                onClick={() => loadMessages(selectedConv)}
                className="rounded-lg border border-white/10 px-4 py-2 text-sm hover:bg-white/5"
              >
                다시 시도
              </button>
            </div>
          ) : messages.length === 0 ? (
            <p className="text-center text-[#8E8E93] py-8">메시지 없음</p>
          ) : (
            <>
              {messageCursor && (
                <button
                  type="button"
                  onClick={() => loadMessages(selectedConv, messageCursor, true)}
                  disabled={msgLoadingMore}
                  className="mx-auto block rounded-lg border border-white/10 px-4 py-2 text-sm text-[#8E8E93] hover:bg-white/5 disabled:opacity-50"
                >
                  {msgLoadingMore ? "불러오는 중..." : "이전 대화 더 보기"}
                </button>
              )}
              {messages.map((msg) => (
                <div
                  key={msg.id}
                  className={`flex ${msg.is_genius ? "justify-end" : "justify-start"}`}
                >
                  <div
                    className={`max-w-[75%] px-4 py-2.5 rounded-2xl text-sm ${
                      msg.is_genius ? "bg-[#6366F1] text-white" : "bg-white/8 text-white"
                    }`}
                  >
                    {!msg.is_genius && (
                      <div className="flex items-center gap-1.5 mb-1">
                        <p className="text-xs text-[#8E8E93]">{msg.sender_nickname}</p>
                        {msg.log && <MatchPathBadge log={msg.log} />}
                      </div>
                    )}
                    {msg.content ? (
                      <p className="whitespace-pre-wrap break-words">{msg.content}</p>
                    ) : null}
                    <p
                      className={`text-xs mt-1 ${msg.is_genius ? "text-white/60" : "text-[#636366]"}`}
                    >
                      {timeAgo(msg.created_at)}
                    </p>
                  </div>
                </div>
              ))}
            </>
          )}
          <div ref={messagesEndRef} />
        </div>
      </div>
    );
  }

  // 대화 목록
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <BrainCircuit className="w-6 h-6 text-[#6366F1]" />
        <h1 className="text-2xl font-bold">야잘알봇 대화</h1>
        <span className="text-xs text-[#636366]">읽기 전용 모니터링</span>
      </div>

      <div className="text-sm text-[#8E8E93]">
        {loading ? "로딩 중..." : `${conversations.length}개 대화`}
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-32">
          <Loader2 className="w-8 h-8 animate-spin text-[#6366F1]" />
        </div>
      ) : loadError && conversations.length === 0 ? (
        <div className="glass-card p-12 text-center">
          <AlertCircle className="w-12 h-12 text-[#FF453A] mx-auto mb-3" />
          <p className="text-[#8E8E93]">대화 목록을 불러오지 못했습니다</p>
        </div>
      ) : conversations.length === 0 ? (
        <div className="glass-card p-12 text-center">
          <MessageCircle className="w-12 h-12 text-[#636366] mx-auto mb-3" />
          <p className="text-[#8E8E93]">야잘알봇 대화가 없습니다</p>
        </div>
      ) : (
        <div className="space-y-2">
          {conversations.map((conv) => (
            <button
              key={conv.id}
              onClick={() => loadMessages(conv)}
              className="w-full text-left glass-card p-4 hover:bg-white/5 transition-colors rounded-xl"
            >
              <div className="flex items-center gap-3">
                <div
                  className="w-10 h-10 rounded-full flex items-center justify-center shrink-0"
                  style={{ background: `${getTeamColor(conv.other_team_id)}20` }}
                >
                  <User
                    className="w-5 h-5"
                    style={{ color: getTeamColor(conv.other_team_id) }}
                  />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between">
                    <span className="font-medium text-sm">{conv.other_nickname}</span>
                    <span className="text-xs text-[#636366]">
                      {timeAgo(conv.last_message_at)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-2 mt-0.5">
                    <p className="text-sm text-[#8E8E93] truncate">
                      {conv.last_message || "새 대화"}
                    </p>
                    <span className="text-xs text-[#636366] shrink-0">
                      질문 {conv.user_msg_count} · 답변 {conv.sys_msg_count}
                    </span>
                  </div>
                </div>
              </div>
            </button>
          ))}
          {nextCursor && (
            <button
              type="button"
              onClick={() => loadConversations(nextCursor, true)}
              disabled={loadingMore}
              className="w-full rounded-xl border border-white/10 py-3 text-sm text-[#8E8E93] transition-colors hover:bg-white/5 hover:text-white disabled:opacity-50"
            >
              {loadingMore ? "불러오는 중..." : "이전 대화 더 보기"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
