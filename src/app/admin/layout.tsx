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
  Menu,
  X,
  Lock,
  Bell,
  TrendingUp,
  Sparkles,
  Smartphone,
  BarChart3,
  Download,
  RadioTower,
  Image as ImageIcon,
} from "lucide-react";
import { useAdminUnreadDMCount } from "@/lib/admin/useAdminUnreadDMCount";
import { useAdminBatchHealthCount } from "@/lib/admin/useAdminBatchHealthCount";

// PIN 저장을 localStorage(영구)로 승격 — Safari/PWA 세션이 끝나도 로그인 유지 (2026-07-18).
// 기존 어드민 페이지들은 sessionStorage.getItem("admin_pin")을 읽으므로,
// 복원 시 sessionStorage에도 시드해 하위 호환을 유지한다.
function getStoredAdminPin(): string {
  if (typeof window === "undefined") return "";
  return localStorage.getItem("admin_pin") || sessionStorage.getItem("admin_pin") || "";
}

function storeAdminPin(pin: string) {
  localStorage.setItem("admin_pin", pin);
  sessionStorage.setItem("admin_pin", pin);
}

async function syncAdminPushSubscription(sub: PushSubscription): Promise<boolean> {
  const pin = getStoredAdminPin();
  if (!pin) return false;
  try {
    const res = await fetch("/api/admin/push/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-admin-pin": pin },
      body: JSON.stringify({ subscription: sub.toJSON() }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

const NAV_ITEMS = [
  { href: "/admin", label: "개요", icon: LayoutDashboard },
  { href: "/admin/users", label: "유저", icon: Users },
  { href: "/admin/traffic", label: "트래픽", icon: BarChart3 },
  { href: "/admin/downloads", label: "다운로드", icon: Download },
  { href: "/admin/retention", label: "리텐션", icon: TrendingUp },
  { href: "/admin/content", label: "콘텐츠", icon: FileText },
  { href: "/admin/jobs", label: "크롤러/배치", icon: Bot },
  { href: "/admin/messages", label: "쪽지함", icon: Mail },
  { href: "/admin/feedback", label: "건의함", icon: MessageSquare },
  { href: "/admin/whats-new", label: "새 소식", icon: Sparkles },
  { href: "/admin/tester-signups", label: "테스터 신청", icon: Smartphone },
  { href: "/admin/hero-compare", label: "히어로샷 비교", icon: ImageIcon },
  { href: "/admin/live-activity", label: "잠금화면 LA", icon: RadioTower },
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
      storeAdminPin(pin);
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

// 어드민 PWA 웹푸시 토글 (2026-07-18) — iOS 16.4+는 홈 화면 추가 앱에서만 PushManager 지원.
// 사용자 제스처(버튼 탭)로만 권한 요청 가능하므로 자동 프롬프트는 하지 않는다.
type AdminPushState = "unsupported" | "standalone-required" | "off" | "on" | "denied" | "busy";

function AdminPushToggle() {
  const [state, setState] = useState<AdminPushState>("off");

  useEffect(() => {
    if (typeof window === "undefined" || !("Notification" in window) || !("serviceWorker" in navigator)) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setState("unsupported");
      return;
    }
    if (!("PushManager" in window)) {
      // iOS Safari 탭에서는 PushManager가 없고, 홈 화면 앱에서만 지원된다
      setState("standalone-required");
      return;
    }
    if (Notification.permission === "denied") {
      setState("denied");
      return;
    }
    navigator.serviceWorker.ready
      .then(async (reg) => {
        const sub = await reg.pushManager.getSubscription();
        if (sub && Notification.permission === "granted") {
          setState("on");
          // 서버 재동기화 (엔드포인트 회전 대비, best-effort)
          void syncAdminPushSubscription(sub);
        }
      })
      .catch(() => {});
  }, []);

  const enable = async () => {
    setState("busy");
    try {
      const perm = await Notification.requestPermission();
      if (perm !== "granted") {
        setState(perm === "denied" ? "denied" : "off");
        return;
      }
      const reg = await navigator.serviceWorker.ready;
      const sub =
        (await reg.pushManager.getSubscription()) ||
        (await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY,
        }));
      const ok = await syncAdminPushSubscription(sub);
      setState(ok ? "on" : "off");
    } catch {
      setState("off");
    }
  };

  if (state === "unsupported") return null;
  if (state === "standalone-required") {
    return <p className="text-xs text-[#636366]">알림은 홈 화면에 추가한 앱에서 쾜 수 있어요</p>;
  }
  if (state === "denied") {
    return <p className="text-xs text-[#636366]">알림 권한 거부됨 — 설정에서 허용 필요</p>;
  }
  if (state === "on") {
    return (
      <p className="flex items-center gap-1.5 text-xs text-[#30D158]">
        <Bell className="w-3.5 h-3.5" /> 알림 켜짐
      </p>
    );
  }
  return (
    <button
      onClick={enable}
      disabled={state === "busy"}
      className="flex items-center gap-1.5 text-xs text-[#8E8E93] hover:text-white transition-colors disabled:opacity-50"
    >
      <Bell className="w-3.5 h-3.5" /> {state === "busy" ? "설정 중..." : "알림 켜기"}
    </button>
  );
}

function Sidebar({ mobile, onClose, unreadDM, batchProblems }: { mobile?: boolean; onClose?: () => void; unreadDM: number; batchProblems: number }) {
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
                {href === "/admin/messages" && unreadDM > 0 && (
                  <span className="ml-auto min-w-[18px] h-[18px] px-1 rounded-full bg-red-500 flex items-center justify-center text-[10px] font-bold text-white leading-none">
                    {unreadDM > 99 ? "99+" : unreadDM}
                  </span>
                )}
                {href === "/admin/jobs" && batchProblems > 0 && (
                  <span className="ml-auto min-w-[18px] h-[18px] px-1 rounded-full bg-red-500 flex items-center justify-center text-[10px] font-bold text-white leading-none">
                    {batchProblems > 99 ? "99+" : batchProblems}
                  </span>
                )}
              </Link>
            );
          })}
        </nav>
        <div className="p-4 border-t border-white/8 space-y-2">
          <AdminPushToggle />
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
  const unreadDM = useAdminUnreadDMCount(30000, authed);
  const batchProblems = useAdminBatchHealthCount(60000, authed);

  // PWA: /admin을 홈 화면 앱("크보팬 어드민")으로 추가할 수 있게 manifest를 교체 (2026-07-18).
  // 어드민 이탈 시 원복해 일반 페이지의 "크보팬" 매니페스트에 영향을 주지 않는다.
  useEffect(() => {
    const link = document.querySelector<HTMLLinkElement>('link[rel="manifest"]');
    const prevHref = link?.getAttribute("href") ?? null;
    link?.setAttribute("href", "/admin-manifest.json");

    let titleMeta = document.querySelector<HTMLMetaElement>('meta[name="apple-mobile-web-app-title"]');
    const created = !titleMeta;
    const prevTitle = titleMeta?.content ?? null;
    if (!titleMeta) {
      titleMeta = document.createElement("meta");
      titleMeta.name = "apple-mobile-web-app-title";
      document.head.appendChild(titleMeta);
    }
    titleMeta.content = "크보팬 어드민";

    return () => {
      if (link && prevHref) link.setAttribute("href", prevHref);
      if (created) titleMeta?.remove();
      else if (titleMeta && prevTitle) titleMeta.content = prevTitle;
    };
  }, []);

  useEffect(() => {
    const pin = getStoredAdminPin();
    if (pin) {
      // 기존 페이지들의 sessionStorage 읽기 호환 유지
      sessionStorage.setItem("admin_pin", pin);
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
      <Sidebar unreadDM={unreadDM} batchProblems={batchProblems} />
      {mobileOpen && <Sidebar mobile onClose={() => setMobileOpen(false)} unreadDM={unreadDM} batchProblems={batchProblems} />}
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
