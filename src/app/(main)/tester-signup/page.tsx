"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, CheckCircle2, Loader2, Smartphone } from "lucide-react";
import { useAuth } from "@/lib/supabase/AuthContext";
import { supabase } from "@/lib/supabase/client";
import LoginSheet from "@/components/auth/LoginSheet";
import { isAndroidWeb } from "@/lib/capacitor/platform";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function TesterSignupPage() {
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();

  const [eligible, setEligible] = useState<boolean | null>(null);
  const [email, setEmail] = useState("");
  const [existing, setExisting] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const [showLogin, setShowLogin] = useState(false);

  // 안드로이드 모바일웹 게이트 — 클라이언트에서만 판정 가능
  useEffect(() => {
    setEligible(isAndroidWeb());
  }, []);

  // 로그인 유저의 기존 신청 내역 확인 (있으면 이메일 프리필)
  useEffect(() => {
    let cancelled = false;
    async function check() {
      if (authLoading) return;
      if (!user) {
        setChecking(false);
        return;
      }
      try {
        const { data: { session } } = await supabase.auth.getSession();
        const token = session?.access_token;
        if (token) {
          const res = await fetch("/api/tester-signup", {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (res.ok) {
            const data = await res.json();
            if (!cancelled && data.signed) {
              setExisting(data.playStoreEmail);
              setEmail(data.playStoreEmail ?? "");
            }
          }
        }
      } catch {
        /* noop */
      }
      if (!cancelled) setChecking(false);
    }
    check();
    return () => {
      cancelled = true;
    };
  }, [user, authLoading]);

  const handleSubmit = useCallback(async () => {
    const trimmed = email.trim();
    if (!EMAIL_RE.test(trimmed)) {
      setError("올바른 이메일 주소를 입력해주세요");
      return;
    }
    setLoading(true);
    setError("");
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) {
        setShowLogin(true);
        return;
      }
      const res = await fetch("/api/tester-signup", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          playStoreEmail: trimmed,
          deviceInfo: navigator.userAgent,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "신청에 실패했어요");
        return;
      }
      setDone(true);
    } catch {
      setError("네트워크 오류가 발생했어요");
    } finally {
      setLoading(false);
    }
  }, [email]);

  const header = (
    <div className="mb-6 flex items-center gap-3">
      <button onClick={() => router.back()} className="text-text-secondary">
        <ArrowLeft size={22} />
      </button>
      <h1 className="flex items-center gap-2 text-lg font-bold text-text-primary">
        <Smartphone size={18} className="text-accent" />
        테스터 신청
      </h1>
    </div>
  );

  // 플랫폼 판정 전 또는 인증 로딩 중
  if (eligible === null || authLoading || (user && checking)) {
    return (
      <div className="min-h-screen px-5 pt-4 pb-24">
        {header}
        <div className="mt-20 flex justify-center">
          <Loader2 className="animate-spin text-text-tertiary" size={24} />
        </div>
      </div>
    );
  }

  // 안드로이드 모바일웹이 아닌 경우 — iOS/데스크톱/앱 접근 차단
  if (!eligible) {
    return (
      <div className="min-h-screen px-5 pt-4 pb-24">
        {header}
        <div className="mt-16 flex flex-col items-center gap-3 text-center">
          <Smartphone size={40} className="text-text-tertiary" />
          <p className="text-sm font-semibold text-text-primary">
            안드로이드 모바일에서만 신청 가능해요
          </p>
          <p className="text-xs leading-relaxed text-text-secondary">
            이 페이지는 안드로이드 기기의 모바일 브라우저에서
            <br />
            접속하셔야 신청하실 수 있어요.
          </p>
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen px-5 pt-4 pb-24">
        {header}
        <div className="mt-16 space-y-4 text-center">
          <p className="text-sm text-text-secondary">테스터 신청은 로그인 후 가능해요.</p>
          <button
            onClick={() => setShowLogin(true)}
            className="rounded-xl bg-accent px-5 py-3 text-sm font-semibold text-white"
          >
            로그인하기
          </button>
        </div>
        <LoginSheet isOpen={showLogin} onClose={() => setShowLogin(false)} />
      </div>
    );
  }

  if (done) {
    return (
      <div className="min-h-screen px-5 pt-4 pb-24">
        {header}
        <div className="mt-16 flex flex-col items-center gap-4 text-center">
          <CheckCircle2 size={48} className="text-green-400" />
          <p className="text-base font-semibold text-text-primary">테스터 신청이 완료됐어요!</p>
          <p className="text-sm leading-relaxed text-text-secondary">
            <span className="font-medium text-text-primary">{email.trim()}</span> 주소로
            <br />
            순차적으로 테스터 등록을 진행해드릴게요.
            <br />
            등록이 완료되면 플레이스토어에서 크보팬 앱을 설치하실 수 있어요.
          </p>
          <button
            onClick={() => router.push("/")}
            className="mt-2 rounded-xl bg-white/10 px-5 py-3 text-sm font-medium text-text-primary"
          >
            홈으로
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen px-5 pt-4 pb-24">
      {header}
      <div className="space-y-5">
        <div className="rounded-2xl bg-bg-secondary p-5">
          <h2 className="mb-2 text-base font-semibold text-text-primary">🎟️ 안드로이드 테스터 모집</h2>
          <p className="text-sm leading-relaxed text-text-secondary">
            구글 플레이스토어에 <span className="font-medium text-text-primary">로그인된 Gmail 주소</span>를
            입력해주세요. 이 주소로 테스터 등록을 진행하고, 등록이 완료되면 플레이스토어에서 크보팬 앱을
            설치하실 수 있어요.
          </p>
        </div>

        {existing && (
          <p className="text-xs text-amber-400">
            이미 <span className="font-medium">{existing}</span>(으)로 신청하셨어요. 주소를 바꾸려면 새로
            입력 후 다시 제출하세요.
          </p>
        )}

        <div>
          <label className="mb-1.5 block text-xs text-text-secondary">플레이스토어 Gmail 주소</label>
          <input
            type="email"
            inputMode="email"
            autoCapitalize="off"
            autoCorrect="off"
            placeholder="example@gmail.com"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              setError("");
            }}
            maxLength={254}
            className="w-full rounded-xl bg-bg-tertiary px-4 py-3 text-sm text-text-primary outline-none placeholder:text-text-tertiary focus:ring-1 focus:ring-accent"
          />
          {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
        </div>

        <button
          onClick={handleSubmit}
          disabled={loading || !email.trim()}
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-accent py-3.5 text-sm font-semibold text-white transition-opacity disabled:opacity-40"
        >
          {loading && <Loader2 size={16} className="animate-spin" />}
          {existing ? "신청 정보 수정" : "테스터 신청하기"}
        </button>

        <p className="text-[11px] leading-relaxed text-text-tertiary">
          입력하신 이메일은 테스터 등록 목적으로만 사용되며, 가입 계정 정보와 함께 안전하게 보관됩니다.
        </p>
      </div>

      <LoginSheet isOpen={showLogin} onClose={() => setShowLogin(false)} />
    </div>
  );
}
