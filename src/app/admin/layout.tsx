"use client";

import { useState, useEffect, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Users,
  FileText,
  Bot,
  MessageSquare,
  Mail,
  Activity,
  Image as ImageIcon,
  Menu,
  X,
  Lock,
  TrendingUp,
  Sparkles,
} from "lucide-react";

const NAV_ITEMS = [
  { href: "/admin", label: "개요", icon: LayoutDashboard },
  { href: "/admin/users", label: "유저", icon: Users },
  { href: "/admin/retention", label: "리텐션", icon: TrendingUp },
  { href: "/admin/content", label: "콘텐츠", icon: FileText },
  { href: "/admin/jobs", label: "크롤러/배치", icon: Bot },
  { href: "/admin/messages", label: "쪽지함", icon: Mail },
  { href: "/admin/feedback", label: "건의함", icon: MessageSquare },
  { href: "/admin/hero-shots", label: "히어로샷", icon: ImageIcon },
  { href: "/admin/whats-new", label: "새 소식", icon: Sparkles },
  { href: "/admin/system", label: "시스템", icon: Activity },
] as const;

function PinGate({ onAuth }: { onAuth: () => void }) {
  const [pin, setPin] = useState("");
  const [error, setError] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const res = await fetch("/api/admin/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin }),
    });
    if (res.ok) {
      sessionStorage.setItem("admin_pin", pin);
      onAuth();
    } else {
      setError(true);
      setPin("");
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center" style={{ background: "#0A0A0B" }}>
      <form onSubmit={handleSubmit} className="glass-card p-8 w-full max-w-sm text-center space-y-6">
        <div className="flex justify-center">
          <div className="w-16 h-16 rounded-2xl bg-[#6366F1]/20 flex items-center justify-center">
            <Lock className="w-8 h-8 text-[#6366F1]" />
          </div>
        </div>
        <h1 className="text-xl font-bold">관리자 인증</h1>
        <p className="text-sm text-[#8E8E93]">PIN을 입력하세요</p>
        <input
          type="password"
          value={pin}
          onChange={(e) => { setPin(e.target.value); setError(false); }}
          placeholder="••••••"
          className="w-full px-4 py-3 rounded-xl bg-white/5 border border-white/10 text-center text-lg tracking-[0.5em] outline-none focus:border-[#6366F1] transition-colors"
          autoFocus
        />
        {error && <p className="text-sm text-red-400">PIN이 올바르지 않습니다</p>}
        <button
          type="submit"
          className="w-full py-3 rounded-xl bg-[#6366F1] hover:bg-[#5558E6] text-white font-semibold transition-colors"
        >
          접속
        </button>
      </form>
    </div>
  );
}

function Sidebar({ mobile, onClose }: { mobile?: boolean; onClose?: () => void }) {
  const pathname = usePathname();

  return (
    <aside
      className={`${
        mobile
          ? "fixed inset-0 z-50 flex"
          : "hidden lg:flex flex-col w-60 min-h-screen"
      }`}
    >
      {mobile && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      )}
      <div
        className={`${
          mobile ? "relative z-10 w-64" : "w-60"
        } flex flex-col min-h-screen border-r border-white/8`}
        style={{ background: "#101012" }}
      >
        <div className="flex items-center justify-between p-5 border-b border-white/8">
          <div className="flex items-center gap-2">
            <img src="/logo.png" alt="크보팬" style={{height: "28px", objectFit: "contain"}} />
            <h2 className="font-bold text-lg">어드민</h2>
          </div>
          {mobile && (
            <button onClick={onClose} className="p-1 text-[#8E8E93]">
              <X className="w-5 h-5" />
            </button>
          )}
        </div>
        <nav className="flex-1 p-3 space-y-1">
          {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
            const active = href === "/admin" ? pathname === "/admin" : pathname.startsWith(href);
            return (
              <Link
                key={href}
                href={href}
                onClick={onClose}
                className={`flex items-center gap-3 px-4 py-2.5 rounded-xl text-sm font-medium transition-colors ${
                  active
                    ? "bg-[#6366F1]/15 text-[#6366F1]"
                    : "text-[#8E8E93] hover:text-white hover:bg-white/5"
                }`}
              >
                <Icon className="w-4.5 h-4.5" />
                {label}
              </Link>
            );
          })}
        </nav>
        <div className="p-4 border-t border-white/8">
          <p className="text-xs text-[#636366]">크보팬 v0.9</p>
        </div>
      </div>
    </aside>
  );
}

export default function AdminLayout({ children }: { children: ReactNode }) {
  const [authed, setAuthed] = useState(false);
  const [checking, setChecking] = useState(true);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    const pin = sessionStorage.getItem("admin_pin");
    if (pin) {
      fetch("/api/admin/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin }),
      }).then((res) => {
        setAuthed(res.ok);
        setChecking(false);
      });
    } else {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setChecking(false);
    }
  }, []);

  if (checking) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: "#0A0A0B" }}>
        <div className="w-8 h-8 border-2 border-[#6366F1] border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!authed) {
    return <PinGate onAuth={() => setAuthed(true)} />;
  }

  return (
    <div className="flex min-h-screen" style={{ background: "#0A0A0B" }}>
      <Sidebar />
      {mobileOpen && <Sidebar mobile onClose={() => setMobileOpen(false)} />}
      <main className="flex-1 min-w-0">
        <header className="sticky top-0 z-40 flex items-center gap-4 px-6 py-4 border-b border-white/8 backdrop-blur-xl bg-[#0A0A0B]/80 lg:hidden">
          <button onClick={() => setMobileOpen(true)} className="p-2 -ml-2">
            <Menu className="w-5 h-5" />
          </button>
          <div className="flex items-center gap-2">
            <img src="/logo.png" alt="크보팬" style={{height: "24px", objectFit: "contain"}} />
            <h1 className="font-bold">어드민</h1>
          </div>
        </header>
        <div className="p-4 lg:p-8 max-w-[1600px]">{children}</div>
      </main>
    </div>
  );
}
