import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 인증 = 토큰 자체(draft 와 동일한 1회용 토큰). GET 은 확인 화면만(비변경 → 프리패치 안전),
// POST 는 '이관 요청' 마킹만 한다. 실제 #cs 게시는 cs-relay cron 이 다음 틱에 수행(서버는 Slack 미접근).

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function page(title: string, inner: string): NextResponse {
  const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)}</title>
<style>
:root { color-scheme: dark; }
body { margin:0; background:#0A0A0B; color:#EDEDED; font-family:-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Malgun Gothic",sans-serif; }
.wrap { max-width:640px; margin:0 auto; padding:32px 20px 64px; }
h1 { font-size:18px; margin:0 0 16px; }
.card { background:#151518; border:1px solid #26262b; border-radius:12px; padding:16px; }
.meta { color:#9a9aa2; font-size:13px; margin-bottom:12px; }
pre { white-space:pre-wrap; word-break:break-word; font-family:inherit; font-size:15px; line-height:1.55; margin:0; }
button { width:100%; margin-top:20px; padding:14px; font-size:16px; font-weight:600; border:0; border-radius:12px; background:#8957e5; color:#fff; cursor:pointer; }
button:active { opacity:.85; }
.ok { color:#3fb950; } .warn { color:#d29922; } .err { color:#f85149; }
.small { color:#9a9aa2; font-size:12px; margin-top:16px; }
</style></head><body><div class="wrap">${inner}</div></body></html>`;
  return new NextResponse(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store, max-age=0",
    },
  });
}

type Draft = {
  token: string;
  title: string | null;
  cs_content: string | null;
  status: string;
  expires_at: string;
  escalate_requested_at: string | null;
  escalated_at: string | null;
};

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  const admin = getSupabaseAdmin();
  const { data } = await admin
    .from("cs_reply_drafts")
    .select("token, title, cs_content, status, expires_at, escalate_requested_at, escalated_at")
    .eq("token", token)
    .maybeSingle();
  const draft = data as Draft | null;

  if (!draft) {
    return page("링크 만료", `<h1 class="warn">만료되었거나 잘못된 링크예요</h1><div class="card">이 이관 링크는 더 이상 유효하지 않습니다.</div>`);
  }
  if (draft.escalated_at) {
    return page("이관 완료", `<h1 class="ok">이미 #cs로 이관됐어요 ✅</h1><div class="card">#cs 채널 스레드에서 이어서 논의하실 수 있어요.</div>`);
  }
  // 발송(sent)된 건도 이관 가능 — 이관은 유저 재발송이 아니라 #cs에 팀 논의 스레드만 여는 것이라
  // 발송/이관은 상호배타가 아니다(하린아빠 요청). 취소/만료/이관완료/원문없음 가드만 유지.
  if (draft.status === "canceled" || new Date(draft.expires_at) < new Date()) {
    return page("링크 만료", `<h1 class="warn">만료되었거나 취소된 항목이에요</h1><div class="card">이 이관 링크는 더 이상 유효하지 않습니다.</div>`);
  }
  if (draft.escalate_requested_at) {
    return page("이관 요청됨", `<h1 class="warn">이관이 요청됐어요</h1><div class="card">곧(최대 5분 내) #cs 채널에 스레드가 생성됩니다.</div>`);
  }
  if (!draft.title || !draft.cs_content) {
    return page("이관 불가", `<h1 class="err">이관 정보가 없어요</h1><div class="card">이 항목은 이관에 필요한 제목/원문이 저장돼 있지 않습니다.</div>`);
  }

  return page(
    "CS 이관 확인",
    `<h1>이 CS를 #cs로 이관할까요?</h1>
<div class="meta">#cs 채널에 아래 제목으로 톱레벨 글이 열리고, CS 원문이 스레드로 붙습니다.</div>
<div class="card"><pre><b>${esc(draft.title)}</b>

${esc(draft.cs_content)}</pre></div>
<form method="post" action="/api/cs/escalate/${esc(draft.token)}">
<button type="submit">#cs로 이관</button>
</form>
<div class="small">이관 버튼을 눌러야 요청됩니다. 요청 후 최대 5분 내 스레드가 생성돼요.</div>`,
  );
}

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return page("설정 오류", `<h1 class="err">서버 설정 오류</h1><div class="card">잠시 후 다시 시도해주세요.</div>`);
  }
  const admin = getSupabaseAdmin();
  const now = new Date().toISOString();

  // 원자적 선점: 아직 이관 요청 전 + (pending 또는 sent) + 미만료 + 미이관 draft만 escalate_requested_at 을 찍는다.
  // 발송(sent)된 건도 이관 허용 — 이관은 #cs 팀 논의 스레드만 여는 것이라 발송/이관은 상호배타가 아니다.
  // (title/cs_content 가 있어야 cron 이 게시 가능.)
  const { data: claimedRow } = await admin
    .from("cs_reply_drafts")
    .update({ escalate_requested_at: now })
    .eq("token", token)
    .in("status", ["pending", "sent"])
    .gte("expires_at", now)
    .is("escalate_requested_at", null)
    .is("escalated_at", null)
    .not("title", "is", null)
    .not("cs_content", "is", null)
    .select("token")
    .maybeSingle();

  if (!claimedRow) {
    return page("처리됨", `<h1 class="warn">이미 이관됐거나 이관할 수 없는 항목이에요</h1><div class="card">중복 이관은 되지 않습니다.</div>`);
  }

  return page("이관 요청 완료", `<h1 class="ok">#cs로 이관 요청됐어요 ✅</h1><div class="card">곧(최대 5분 내) #cs 채널에 제목 글 + CS 원문 스레드가 생성됩니다. 거기서 이어서 논의해주세요.</div>`);
}
