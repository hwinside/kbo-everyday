"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, Copy, Loader2, Send, Smartphone, MessageSquare } from "lucide-react";

interface Signup {
  id: number;
  user_id: string;
  account_email: string | null;
  play_store_email: string;
  device_info: string | null;
  created_at: string;
}

/** 다운로드 안내 쪽지 기본 템플릿 — '(다운로드 링크)'를 실제 링크로 바꿔 발송. */
const DM_TEMPLATE = `안녕하세요, 크보팬 운영팀입니다 🐾 테스터 등록이 완료됐어요! 아래 링크에서 앱을 설치하시면 바로 참여하실 수 있어요.
👉 (다운로드 링크)
설치 후 의견은 마이페이지 '피드백 보내기'(📱안드로이드앱 테스트)로 보내주세요! 사용하시면서 불편하시거나 개선이 필요한 부분, 바라는 점이 있으실 경우 의견 보내주시면 적극적으로 서비스에 반영하겠습니다.

크보팬 드림`;

function getPin(): string {
  return typeof window !== "undefined" ? sessionStorage.getItem("admin_pin") || "" : "";
}

/** Android UA에서 기기모델 추출 (예: "...; SM-S921N Build/...") */
function deviceModel(ua: string | null): string {
  if (!ua) return "-";
  const m = ua.match(/Android[^;]*;\s*([^;)]+?)\s*(?:Build\/|\))/);
  if (m?.[1]) return m[1].trim();
  if (/iPhone|iPad/i.test(ua)) return "iOS";
  if (/Android/i.test(ua)) return "Android";
  return "기타";
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString("ko-KR", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function AdminTesterSignupsPage() {
  const [items, setItems] = useState<Signup[]>([]);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  // 쪽지 컴포저 상태
  const [openId, setOpenId] = useState<number | null>(null);
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [sendingId, setSendingId] = useState<number | null>(null);
  const [sentIds, setSentIds] = useState<Set<number>>(new Set());
  // '(다운로드 링크)' placeholder 미교체 상태로 발송 시도 시 경고 표시할 신청 id
  const [warnId, setWarnId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/tester-signups", {
        headers: { "x-admin-pin": getPin() },
      });
      if (res.ok) {
        const j = await res.json();
        setItems(j.data ?? []);
      }
    } catch {
      /* noop */
    }
    setLoading(false);
  }, []);

  // 마운트 시 목록 로드 — load() 첫 동기 호출이 setLoading(true)라 룰이 잡지만 의도된 패턴
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { load(); }, [load]);

  const copyAll = async () => {
    const emails = items.map((i) => i.play_store_email).join(", ");
    try {
      await navigator.clipboard.writeText(emails);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* noop */
    }
  };

  const toggleComposer = (it: Signup) => {
    if (warnId === it.id) setWarnId(null);
    setOpenId((cur) => (cur === it.id ? null : it.id));
    setDrafts((prev) => (prev[it.id] !== undefined ? prev : { ...prev, [it.id]: DM_TEMPLATE }));
  };

  const sendDM = async (it: Signup) => {
    const content = (drafts[it.id] ?? "").trim();
    if (!content) return;
    // 발송 전 가드 — '(다운로드 링크)' placeholder를 실제 링크로 안 바꿨으면 차단(실수 방지).
    if (content.includes("(다운로드 링크)")) {
      setWarnId(it.id);
      return;
    }
    setWarnId(null);
    setSendingId(it.id);
    try {
      const res = await fetch("/api/admin/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-admin-pin": getPin() },
        body: JSON.stringify({ action: "send_to_user", userId: it.user_id, content }),
      });
      if (res.ok) {
        setSentIds((prev) => new Set(prev).add(it.id));
        setOpenId(null);
      }
    } catch {
      /* noop */
    }
    setSendingId(null);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="flex items-center gap-2 text-2xl font-bold">
          <Smartphone size={22} /> 테스터 신청
        </h1>
        {items.length > 0 && (
          <button
            onClick={copyAll}
            className="flex items-center gap-1 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-500"
          >
            {copied ? <Check size={16} /> : <Copy size={16} />}
            {copied ? "복사됨" : "이메일 전체 복사"}
          </button>
        )}
      </div>
      <p className="text-sm text-text-secondary">
        총 {items.length}명 신청 · 플레이스토어 이메일을 Play Console 비공개 테스트 테스터에 추가한 뒤,
        각 신청자에게 다운로드 링크 쪽지를 보내세요.
      </p>

      {loading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="animate-spin text-text-tertiary" size={24} />
        </div>
      ) : items.length === 0 ? (
        <div className="py-12 text-center text-sm text-text-tertiary">아직 신청자가 없습니다</div>
      ) : (
        <div className="space-y-2">
          {items.map((it) => (
            <div
              key={it.id}
              className="rounded-xl border border-[var(--color-border)] bg-[var(--bg-secondary)] p-4"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="break-all text-sm font-semibold text-text-primary">
                    {it.play_store_email}
                  </p>
                  <p className="mt-0.5 break-all text-xs text-text-tertiary">
                    가입 계정: {it.account_email || "-"}
                  </p>
                  <p className="mt-0.5 text-xs text-text-tertiary">기기: {deviceModel(it.device_info)}</p>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-2">
                  <span className="text-xs text-text-tertiary">{formatDate(it.created_at)}</span>
                  <button
                    onClick={() => toggleComposer(it)}
                    className="flex items-center gap-1 rounded-lg bg-green-600 px-2.5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-green-500"
                  >
                    {sentIds.has(it.id) ? <Check size={13} /> : <MessageSquare size={13} />}
                    {sentIds.has(it.id) ? "발송됨" : "쪽지 보내기"}
                  </button>
                </div>
              </div>

              {openId === it.id && (
                <div className="mt-3 space-y-2 border-t border-[var(--color-border)] pt-3">
                  <textarea
                    value={drafts[it.id] ?? ""}
                    onChange={(e) => {
                      setDrafts((prev) => ({ ...prev, [it.id]: e.target.value }));
                      if (warnId === it.id) setWarnId(null);
                    }}
                    rows={7}
                    className="w-full resize-y rounded-lg bg-[var(--bg-tertiary)] px-3 py-2 text-sm text-text-primary outline-none"
                    placeholder="쪽지 내용"
                  />
                  <p className="text-[11px] text-text-tertiary">
                    <code>(다운로드 링크)</code>를 실제 Play 스토어 링크로 바꿔서 보내세요. 링크는 쪽지에서
                    클릭하면 바로 열립니다.
                  </p>
                  {warnId === it.id && (
                    <p className="text-[11px] font-medium text-red-400">
                      ⚠️ <code>(다운로드 링크)</code>가 그대로 남아 있어요. 실제 Play 스토어 링크로 바꾼 뒤 발송하세요.
                    </p>
                  )}
                  <div className="flex justify-end gap-2">
                    <button
                      onClick={() => setOpenId(null)}
                      className="rounded-lg px-3 py-1.5 text-xs text-text-secondary hover:text-text-primary"
                    >
                      취소
                    </button>
                    <button
                      onClick={() => sendDM(it)}
                      disabled={sendingId === it.id || !(drafts[it.id]?.trim())}
                      className="flex items-center gap-1 rounded-lg bg-green-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-green-500 disabled:opacity-40"
                    >
                      {sendingId === it.id ? (
                        <Loader2 size={13} className="animate-spin" />
                      ) : (
                        <Send size={13} />
                      )}
                      쪽지 발송
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
