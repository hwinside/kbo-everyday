"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, Copy, Loader2, Smartphone } from "lucide-react";

interface Signup {
  id: number;
  account_email: string | null;
  play_store_email: string;
  device_info: string | null;
  created_at: string;
}

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
        총 {items.length}명 신청 · 플레이스토어 이메일을 Play Console 비공개 테스트 테스터에 추가하세요.
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
                <span className="shrink-0 text-xs text-text-tertiary">{formatDate(it.created_at)}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
