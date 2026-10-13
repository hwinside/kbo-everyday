"use client";

import { useState } from "react";
import { ArrowLeft } from "lucide-react";
import { useSafeBack } from "@/lib/hooks/useSafeBack";
import { useAuth } from "@/lib/supabase/AuthContext";
import LoginSheet from "@/components/auth/LoginSheet";
import BlockManagement from "@/components/profile/BlockManagement";

export default function BlocksPage() {
  const goBack = useSafeBack("/my");
  const { user, loading } = useAuth();
  const [showLogin, setShowLogin] = useState(false);

  return (
    <div className="min-h-screen bg-bg-primary pb-24">
      <header className="sticky top-0 z-30 border-b border-border bg-bg-primary" style={{ paddingTop: "var(--safe-area-inset-top, env(safe-area-inset-top, 0px))", marginTop: "calc(var(--safe-area-inset-top, env(safe-area-inset-top, 0px)) * -1)" }}>
        <div className="flex min-h-11 items-center gap-3 px-5">
          <button onClick={goBack} aria-label="뒤로가기" className="-ml-2 flex h-11 w-11 items-center justify-center text-text-primary"><ArrowLeft size={24} /></button>
          <h1 className="text-lg font-bold text-text-primary">차단 관리</h1>
        </div>
      </header>
      <div className="p-5">
        {loading ? <p role="status" className="py-8 text-center text-sm text-text-tertiary">불러오는 중...</p> : user ? <BlockManagement key={user.id} /> : (
          <div className="py-16 text-center">
            <p className="text-sm text-text-secondary">로그인 후 이용할 수 있어요</p>
            <button onClick={() => setShowLogin(true)} className="mt-4 min-h-11 rounded-full bg-accent px-5 text-sm font-semibold text-white">로그인</button>
          </div>
        )}
      </div>
      <LoginSheet isOpen={showLogin} onClose={() => setShowLogin(false)} />
    </div>
  );
}
