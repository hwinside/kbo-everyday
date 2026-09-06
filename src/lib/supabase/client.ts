"use client";

import { createBrowserClient } from "@supabase/ssr";
import { authSessionDiagnostics } from "@/lib/auth/session-diagnostics";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

export const supabase = createBrowserClient(supabaseUrl, supabaseAnonKey, {
  global: {
    fetch: authSessionDiagnostics.observeFetch(supabaseUrl, (...args) => globalThis.fetch(...args)),
  },
});

/**
 * 네이티브(Capacitor/Android WebView)에서 supabase auth 락이 멈추면
 * `auth.getSession()`이 영구 hang → 호출하는 화면이 무한 스피너로 굳음.
 * (참고: #209/#419 — getSession도 supabase 락 경유라 위험)
 * 모든 await에 타임아웃 상한을 강제해 화면이 절대 굳지 않게 한다.
 * 락 경합이 일시적인 경우를 대비해 1회 짧게 재시도한다.
 */
type SupabaseSession = Awaited<ReturnType<typeof supabase.auth.getSession>>["data"]["session"];

export async function getSafeSession(timeoutMs = 6000): Promise<SupabaseSession> {
  const once = (): Promise<SupabaseSession> =>
    new Promise(resolve => {
      let settled = false;
      const done = (s: SupabaseSession) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(s);
      };
      const timer = setTimeout(() => done(null), timeoutMs);
      supabase.auth
        .getSession()
        .then(r => done(r.data.session))
        .catch(() => done(null));
    });
  const first = await once();
  if (first) return first;
  // 락 경합이 일시적인 경우를 대비해 1회 짧게 재시도
  return await once();
}
