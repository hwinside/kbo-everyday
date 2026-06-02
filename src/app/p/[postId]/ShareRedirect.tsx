"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/** /p/[id] 진입 시 사람은 실제 게시글 상세로 이동. (크롤러는 OG만 읽고 떠남) */
export default function ShareRedirect({ to }: { to: string }) {
  const router = useRouter();
  useEffect(() => {
    router.replace(to);
  }, [to, router]);

  return <div className="flex items-center justify-center h-screen text-text-secondary">이동 중…</div>;
}
