"use client";

import { useState, useEffect, useCallback, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import PullToRefresh from "@/components/PullToRefresh";
import {
  LayoutDashboard,
  Users,
  FileText,
  Bot,
  MessageSquare,
  ShieldAlert,
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
  BrainCircuit,
} from "lucide-react";
import { useAdminUnreadDMCount } from "@/lib/admin/useAdminUnreadDMCount";
import { useAdminBatchHealthCount } from "@/lib/admin/useAdminBatchHealthCount";
import { ADMIN_SESSION_SENTINEL } from "@/lib/admin/constants";

// 인증 유지 = 서버 발급 HttpOnly 세션 쿠키 (2026-07-18, PR #681 삼순 P0 반영).
// PIN 원문은 어떤 클라 storage에도 저장하지 않는다. 기존 어드민 페이지들은
// sessionStorage.getItem("admin_pin")을 읽어 x-admin-pin 헤더로 보내므로(빈값이면
// fetch 자체를 skip하는 가드도 있음), 비밀이 아닌 센티넬 "session"을 시드해 호환을
// 유지한다 — 서버는 PIN 검증 실패(또는 센티넬 skip) 시 세션 쿠키로 인증한다(isAdminAuthedRequest).
// 센티넬 값은 constants.ts SSOT — 서버 pin.ts가 동일 상수로 scrypt skip 판정을 한다.
function seedSessionSentinel() {
  sessionStorage.setItem("admin_pin", ADMIN_SESSION_SENTINEL);
}

async function syncAdminPushSubscription(sub: PushSubscription): Promise<boolean> {
  try {
    // 인증은 HttpOnly 세션 쿠키가 동반된다 (same-origin fetch 기본 포함)
    const res = await fetch("/api/admin/push/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subscription: sub.toJSON() }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function removeAdminPushSubscription(endpoint: string): Promise<boolean> {
  try {
    const res = await fetch("/api/admin/push/subscribe", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint }),
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
  { href: "/admin/baseball-genius", label: "야잘알봇", icon: BrainCircuit },
  { href: "/admin/reports", label: "신고 관리", icon: ShieldAlert },
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
      seedSessionSentinel();
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
    if (typeof window === "undefined") return;
    // iOS는 Safari 탭에서 Notification/PushManager 자체가 없을 수 있어 기능 감지보다
    // 먼저 "홈 화면 앱 아님"을 명시 판별해 설치 안내를 띄운다 (삼순 P2 반영)
    const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent);
    const standalone =
      window.matchMedia?.("(display-mode: standalone)")?.matches === true ||
      (navigator as { standalone?: boolean }).standalone === true;
    if (isIOS && !standalone) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setState("standalone-required");
      return;
    }
    if (!("Notification" in window) || !("serviceWorker" in navigator)) {
      setState("unsupported");
      return;
    }
    if (!("PushManager" in window)) {
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

  const disable = async () => {
    setState("busy");
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        // 서버 삭제 실패 = stale row 잔존 → 성공(off) 표시 금지 (삼순 조건부 GO 잔여 P2)
        const serverOk = await removeAdminPushSubscription(sub.endpoint);
        if (!serverOk) {
          setState("on");
          return;
        }
        // 브라우저 unsubscribe 실패 = 구독 유지 → 재접속 시 재동기화로 다시 on될 수 있음 → 성공 표시 금지
        const unsubOk = await sub.unsubscribe();
        if (!unsubOk) {
          setState("on");
          return;
        }
      }
      setState("off");
    } catch {
      setState("on");
    }
  };

  if (state === "unsupported") return null;
  if (state === "standalone-required") {
    return <p className="text-xs text-[#636366]">알림은 홈 화면에 추가한 앱에서 켤 수 있어요</p>;
  }
  if (state === "denied") {
    return <p className="text-xs text-[#636366]">알림 권한 거부됨 — 설정에서 허용 필요</p>;
  }
  if (state === "on") {
    return (
      <button
        onClick={disable}
        className="flex items-center gap-1.5 text-xs text-[#30D158] hover:text-white transition-colors"
      >
        <Bell className="w-3.5 h-3.5" /> 알림 켜짐 — 끄기
      </button>
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
      {/* 모바일 drawer는 fixed 컨테이너라 메뉴가 뷰포트보다 길어지면 하단이 잘렸다
          (2026-07-30) → 높이를 h-dvh로 고정하고 nav만 내부 스크롤시킨다. */}
      <div
        className={`${
          mobile ? "relative z-10 w-64 h-dvh" : "w-60 min-h-screen"
        } flex flex-col border-r border-white/8`}
        style={{ background: "#101012" }}
      >
        <div
          className="flex items-center justify-between p-5 border-b border-white/8"
          style={mobile ? { paddingTop: "calc(var(--safe-area-inset-top, env(safe-area-inset-top)) + 1.25rem)" } : undefined}
        >
          <div className="flex items-center gap-2">
            <img src="/logo.png" alt="크보팬" style={{height: "28px", objectFit: "contain"}} />
            <h2 className="font-bold text-lg">어드민</h2>
          </div>
          {mobile && (
            <button onClick={onClose} aria-label="메뉴 닫기" className="flex h-11 w-11 items-center justify-center rounded-lg text-[#8E8E93] active:bg-white/10">
              <X className="w-5 h-5" />
            </button>
          )}
        </div>
        <nav className="flex-1 min-h-0 overflow-y-auto p-3 space-y-1">
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
        <div
          className="p-4 border-t border-white/8 space-y-2"
          style={mobile ? { paddingBottom: "calc(var(--safe-area-inset-bottom, env(safe-area-inset-bottom)) + 1rem)" } : undefined}
        >
          <AdminPushToggle />
          <p className="text-xs text-[#636366]">크보팬 v0.9</p>
        </div>
      </div>
    </aside>
  );
}

export default function AdminShell({ children }: { children: ReactNode }) {
  const [authed, setAuthed] = useState(false);
  const [checking, setChecking] = useState(true);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const router = useRouter();
  const unreadDM = useAdminUnreadDMCount(30000, authed);
  const batchProblems = useAdminBatchHealthCount(60000, authed);

  // 당겨서 새로고침(#713 홈 확장) — 어드민 페이지는 각자 client fetch(useEffect mount 1회)라
  // router.refresh()(서버 컴포넌트 revalidate)만으로는 클라 상태가 안 바뀐다.
  // → 콘텐츠 래퍼 key를 bump해 페이지 subtree를 remount, 모든 페이지의 fetch effect를 재실행한다
  //   (페이지별 nonce 배선 없이 전 어드민 페이지 범용 갱신).
  const handleRefresh = useCallback(async () => {
    router.refresh();
    setRefreshNonce((n) => n + 1);
    // 스피너가 눈에 보이도록 최소 노출 시간 확보
    await new Promise((res) => setTimeout(res, 500));
  }, [router]);

  // PWA manifest·앱 이름은 server layout(layout.tsx metadata)에서 SSR HTML로 주입한다.
  // — iOS Safari가 "홈 화면에 추가"할 때 페이지 로드 시점의 HTML manifest만 읽기 때문에
  //   클라이언트 동적 교체(기존 useEffect)는 반영되지 않았다(루트 manifest로 추가되던 버그).

  useEffect(() => {
    // 1) 구버전 탭의 sessionStorage PIN(원문)이 남아있으면 그걸로 재인증해 세션 쿠키로 전환
    // 2) 아니면 HttpOnly 세션 쿠키만으로 재인증 (PIN 재입력 없음)
    const legacyPin = sessionStorage.getItem("admin_pin");
    const body =
      legacyPin && legacyPin !== ADMIN_SESSION_SENTINEL ? { pin: legacyPin } : {};
    fetch("/api/admin/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
      .then((res) => {
        if (res.ok) seedSessionSentinel();
        setAuthed(res.ok);
        setChecking(false);
      })
      .catch(() => {
        setAuthed(false);
        setChecking(false);
      });
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
        {/* PWA standalone(black-translucent 상태바)에서 헤더가 상태바 밑까지 올라와 햄버거가
            시계/배터리와 겹쳐 탭이 안 먹던 문제 → safe-area-inset-top 만큼 내립니다 (2026-07-19). */}
        <header
          className="sticky top-0 z-40 flex items-center gap-4 px-4 py-3 border-b border-white/8 backdrop-blur-xl bg-[#0A0A0B]/80 lg:hidden"
          style={{ paddingTop: "calc(var(--safe-area-inset-top, env(safe-area-inset-top)) + 0.75rem)" }}
        >
          <button
            onClick={() => setMobileOpen(true)}
            aria-label="메뉴 열기"
            className="flex h-11 w-11 items-center justify-center rounded-lg -ml-1 active:bg-white/10"
          >
            <Menu className="w-6 h-6" />
          </button>
          <div className="flex items-center gap-2">
            <img src="/logo.png" alt="크보팬" style={{height: "24px", objectFit: "contain"}} />
            <h1 className="font-bold">어드민</h1>
          </div>
        </header>
        <PullToRefresh onRefresh={handleRefresh}>
          <div key={refreshNonce} className="p-4 lg:p-8 max-w-[1600px]">{children}</div>
        </PullToRefresh>
      </main>
    </div>
  );
}
