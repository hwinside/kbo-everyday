import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import AdminShell from "./AdminShell";

// /admin 전용 PWA 메타데이터를 SSR HTML에 주입 (2026-07-19).
// iOS Safari "홈 화면에 추가"는 페이지 로드 시점 HTML의 manifest·앱 이름만 읽으므로,
// 클라이언트 동적 스왑(구 방식)은 반영되지 않았다 → 서버 렌더로 확정 주입한다.
// 중첩 layout metadata는 root와 병합되고, 같은 필드(manifest/appleWebApp)는 이쪽이 우선.
export const metadata: Metadata = {
  manifest: "/admin-manifest.json",
  title: "크보팬 어드민",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "크보팬 어드민",
  },
};

export const viewport: Viewport = {
  themeColor: "#0A0A0B",
};

export default function AdminLayout({ children }: { children: ReactNode }) {
  return <AdminShell>{children}</AdminShell>;
}
