"use client";

import { useState, useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import { motion } from "framer-motion";
import { Gift, ArrowRight, CheckCircle, XCircle } from "lucide-react";
import { useAuth } from "@/lib/supabase/AuthContext";

export default function InviteCodePage() {
  const { code } = useParams<{ code: string }>();
  const router = useRouter();
  const { user, profile, loading: authLoading } = useAuth();
  const [status, setStatus] = useState<"idle" | "confirm" | "loading" | "success" | "already" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");

  useEffect(() => {
    if (authLoading) return;

    // 비로그인: localStorage에 코드 저장 후 홈으로
    if (!user) {
      localStorage.setItem("kbo-pending-invite", code);
      router.push("/");
      return;
    }

    // 로그인 + 프로필 없음 (가입 중): localStorage에 코드 저장
    if (!profile) {
      localStorage.setItem("kbo-pending-invite", code);
      return;
    }

    // 이미 초대받은 계정
    if (profile.invited_by) {
      setStatus("already");
      return;
    }

    // 자동등록 안 함 — 명시적 확인 대기
    setStatus("confirm");
  }, [authLoading, user, profile, code, router]);

  async function registerCode() {
    setStatus("loading");
    try {
      const res = await fetch("/api/invite/use", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, userId: user!.id }),
      });
      if (res.ok) {
        setStatus("success");
        localStorage.removeItem("kbo-pending-invite");
      } else {
        const json = await res.json();
        setErrorMsg(json.error || "등록에 실패했습니다");
        setStatus("error");
      }
    } catch {
      setErrorMsg("네트워크 오류가 발생했습니다");
      setStatus("error");
    }
  }

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-bg-primary">
        <div className="w-8 h-8 border-2 border-accent border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  // 비로그인은 이미 redirect됨
  if (!user) return null;

  return (
    <div className="min-h-screen flex items-center justify-center bg-bg-primary px-5">
      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 20 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        className="w-full max-w-md glass-card p-8 text-center space-y-5"
      >
        {status === "idle" || status === "loading" ? (
          <>
            <div className="w-16 h-16 rounded-full bg-accent/10 flex items-center justify-center mx-auto">
              <Gift size={32} className="text-accent" />
            </div>
            <h1 className="text-xl font-bold text-text-primary">{status === "loading" ? "초대코드 등록 중..." : "준비 중..."}</h1>
            <div className="w-6 h-6 border-2 border-accent border-t-transparent rounded-full animate-spin mx-auto" />
          </>
        ) : status === "confirm" ? (
          <>
            <div className="w-16 h-16 rounded-full bg-accent/10 flex items-center justify-center mx-auto">
              <Gift size={32} className="text-accent" />
            </div>
            <h1 className="text-xl font-bold text-text-primary">초대코드가 도착했어요!</h1>
            <p className="text-sm text-text-secondary">코드: <span className="font-mono font-bold">{code}</span></p>
            <p className="text-sm text-text-secondary">이 초대코드를 등록하시겠어요?</p>
            <div className="flex gap-3 justify-center">
              <button
                onClick={() => registerCode()}
                className="inline-flex items-center gap-2 bg-accent text-white font-semibold px-6 py-3 rounded-xl"
              >
                등록하기
              </button>
              <button
                onClick={() => router.push("/")}
                className="inline-flex items-center gap-2 bg-bg-tertiary text-text-primary font-semibold px-6 py-3 rounded-xl"
              >
                건너뛰기
              </button>
            </div>
          </>
        ) : status === "success" ? (
          <>
            <div className="w-16 h-16 rounded-full bg-green-500/10 flex items-center justify-center mx-auto">
              <CheckCircle size={32} className="text-green-400" />
            </div>
            <h1 className="text-xl font-bold text-text-primary">초대코드 등록 완료!</h1>
            <p className="text-sm text-text-secondary">크보팬에 오신 것을 환영합니다 ⚾</p>
            <button
              onClick={() => router.push("/")}
              className="inline-flex items-center gap-2 bg-accent text-white font-semibold px-6 py-3 rounded-xl"
            >
              홈으로 <ArrowRight size={18} />
            </button>
          </>
        ) : status === "already" ? (
          <>
            <div className="w-16 h-16 rounded-full bg-yellow-500/10 flex items-center justify-center mx-auto">
              <Gift size={32} className="text-yellow-400" />
            </div>
            <h1 className="text-xl font-bold text-text-primary">이미 가입된 계정이에요</h1>
            <p className="text-sm text-text-secondary">이미 초대를 통해 가입하셨습니다</p>
            <button
              onClick={() => router.push("/")}
              className="inline-flex items-center gap-2 bg-accent text-white font-semibold px-6 py-3 rounded-xl"
            >
              홈으로 <ArrowRight size={18} />
            </button>
          </>
        ) : (
          <>
            <div className="w-16 h-16 rounded-full bg-red-500/10 flex items-center justify-center mx-auto">
              <XCircle size={32} className="text-red-400" />
            </div>
            <h1 className="text-xl font-bold text-text-primary">등록 실패</h1>
            <p className="text-sm text-red-400">{errorMsg}</p>
            <button
              onClick={() => router.push("/")}
              className="inline-flex items-center gap-2 bg-bg-tertiary text-text-primary font-semibold px-6 py-3 rounded-xl"
            >
              홈으로 <ArrowRight size={18} />
            </button>
          </>
        )}
      </motion.div>
    </div>
  );
}
