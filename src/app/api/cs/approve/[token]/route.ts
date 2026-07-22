import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { sendOpsMessageToUser } from "@/lib/cs/send-ops-message";
import { verifyDraftTarget } from "@/lib/cs/verify-draft-target";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 인증 = 토큰 자체(고엔트로피 1회용). GET 은 확인 화면만 렌더(비변경 → 프리패치 안전),
// 실제 발송은 POST 에서만 수행한다.

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
button { width:100%; margin-top:20px; padding:14px; font-size:16px; font-weight:600; border:0; border-radius:12px; background:#2f81f7; color:#fff; cursor:pointer; }
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
  cs_id: string;
  title: string | null;
  kind: "feedback" | "dm" | "store_review";
  user_id: string | null;
  conversation_id: string | null;
  feedback_id: string | null;
  body: string;
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
    .select("*")
    .eq("token", token)
    .maybeSingle();
  const draft = data as Draft | null;

  if (!draft) {
    return page("링크 만료", `<h1 class="warn">만료되었거나 잘못된 링크예요</h1><div class="card">이 회신 링크는 더 이상 유효하지 않습니다.</div>`);
  }
  if (draft.status === "sent") {
    if (draft.kind === "store_review") {
      return page("게시 완료", `<h1 class="ok">스토어 답변이 게시 처리됐어요 ✅</h1><div class="card"><pre>${esc(draft.body)}</pre></div>`);
    }
    return page("발송 완료", `<h1 class="ok">이미 발송된 회신이에요 ✅</h1><div class="card"><pre>${esc(draft.body)}</pre></div>`);
  }
  if (draft.kind === "store_review" && (draft.status === "approved" || draft.status === "processing")) {
    return page("게시 대기", `<h1 class="warn">스토어 게시 요청이 접수됐어요</h1><div class="card"><pre>${esc(draft.body)}</pre></div><div class="small">최대 5분 내 현재 리뷰 상태를 다시 확인한 뒤 공개 답변을 게시합니다.</div>`);
  }
  if (draft.status === "canceled" || new Date(draft.expires_at) < new Date()) {
    return page("링크 만료", `<h1 class="warn">만료되었거나 취소된 회신이에요</h1><div class="card"><pre>${esc(draft.body)}</pre></div>`);
  }
  // 수신자 닉네임(있으면 표기)
  const { data: prof } = draft.user_id
    ? await admin.from("profiles").select("nickname").eq("id", draft.user_id).maybeSingle()
    : { data: null };
  const who = prof?.nickname ? `${prof.nickname}님에게` : "이 유저에게";
  const kindLabel = draft.kind === "feedback" ? "건의함" : draft.kind === "dm" ? "쪽지" : "스토어 공개 답변";
  const titleLine = draft.title ? `<div class="meta">건: ${esc(draft.title)}</div>` : "";

  // 이관된 건도 발송은 허용하되, 논의 중 경고를 명시한다 (2026-07-21 하린아빠 결정).
  if (draft.escalate_requested_at || draft.escalated_at) {
    return page(
      "이관된 건 발송 확인",
      `<h1 class="warn">⚠️ 이 건은 #cs로 이관돼 논의 중이에요</h1>
${titleLine}
<div class="meta">${esc(who)} · ${kindLabel} 회신 · 팀 논의가 끝나지 않았을 수 있어요</div>
<div class="card"><pre>${esc(draft.body)}</pre></div>
<form method="post" action="/api/cs/approve/${esc(draft.token)}">
<button type="submit">논의 중이지만 ${draft.kind === "store_review" ? "스토어 게시 요청" : "그대로 발송"}</button>
</form>
<div class="small">발송 버튼을 눌러야 실제로 전송됩니다. #cs 스레드 논의 내용과 다른 초안일 수 있으니 확인 후 발송해주세요.</div>`,
    );
  }

  if (draft.kind === "store_review") {
    return page(
      "스토어 답변 확인",
      `<h1>이 답변을 스토어에 그대로 게시할까요?</h1>
${titleLine}
<div class="meta">App Store·Google Play 공개 답변</div>
<div class="card"><pre>${esc(draft.body)}</pre></div>
<form method="post" action="/api/cs/approve/${esc(draft.token)}">
<button type="submit">스토어에 그대로 게시 요청</button>
</form>
<div class="small">버튼을 눌러야 요청됩니다. 최대 5분 내 리뷰 수정·기답변 여부를 다시 확인한 뒤 게시합니다.</div>`,
    );
  }

  return page(
    "회신 확인",
    `<h1>이 내용 그대로 발송할까요?</h1>
${titleLine}
<div class="meta">${esc(who)} · ${kindLabel} 회신</div>
<div class="card"><pre>${esc(draft.body)}</pre></div>
<form method="post" action="/api/cs/approve/${esc(draft.token)}">
<button type="submit">그대로 발송</button>
</form>
<div class="small">발송 버튼을 눌러야 실제로 전송됩니다. 링크를 열기만 한 상태에서는 전송되지 않아요.</div>`,
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

  const { data: currentRow } = await admin
    .from("cs_reply_drafts")
    .select("kind")
    .eq("token", token)
    .maybeSingle();

  if (currentRow?.kind === "store_review") {
    const { data: approved } = await admin
      .from("cs_reply_drafts")
      .update({ status: "approved", approved_at: now })
      .eq("token", token)
      .eq("kind", "store_review")
      .eq("status", "pending")
      .gte("expires_at", now)
      .select("body")
      .maybeSingle();
    if (!approved) {
      return page("처리됨", `<h1 class="warn">이미 처리됐거나 만료된 답변이에요</h1><div class="card">중복 게시 요청은 되지 않습니다.</div>`);
    }
    return page("게시 요청 완료", `<h1 class="ok">스토어 게시 요청이 접수됐어요 ✅</h1><div class="card"><pre>${esc(approved.body)}</pre></div><div class="small">최대 5분 내 현재 리뷰 상태를 다시 확인한 뒤 공개 답변을 게시합니다.</div>`);
  }

  const systemUserId = process.env.SYSTEM_USER_ID;
  if (!systemUserId) {
    return page("설정 오류", `<h1 class="err">서버 설정 오류</h1><div class="card">잠시 후 다시 시도해주세요.</div>`);
  }

  // 원자적 선점: pending + 미만료 건만 sent 로 전이(중복 발송/더블클릭 방지).
  // 이관(escalate)된 건도 발송 허용 — GET 확인 화면에서 "논의 중" 경고를 거친 명시 발송이다 (2026-07-21).
  const { data: claimedRow } = await admin
    .from("cs_reply_drafts")
    .update({ status: "sent", sent_at: now })
    .eq("token", token)
    .eq("status", "pending")
    .gte("expires_at", now)
    .select("*")
    .maybeSingle();
  const claimed = claimedRow as Draft | null;

  if (!claimed) {
    // 이미 처리됐거나 만료/무효
    return page("처리됨", `<h1 class="warn">이미 처리됐거나 만료된 회신이에요</h1><div class="card">중복 발송은 되지 않습니다.</div>`);
  }

  if (claimed.kind === "store_review") {
    await admin
      .from("cs_reply_drafts")
      .update({ status: "pending", sent_at: null })
      .eq("token", token);
    return page("처리 실패", `<h1 class="err">스토어 답변 상태 전환에 실패했어요</h1><div class="card">잠시 후 다시 시도해주세요.</div>`);
  }

  // 발송 직전 재검증(defense in depth). draft 생성 단계에서 이미 막히지만,
  // cron/호출부 버그로 잘못된 draft가 만들어졌을 가능성에 대비해 한 번 더 확인한다.
  const isValidTarget = await verifyDraftTarget(
    admin,
    claimed.kind,
    claimed.user_id || "",
    claimed.conversation_id,
    claimed.feedback_id,
    systemUserId,
  );
  if (!isValidTarget) {
    // 선점 롤백 후 발송 차단
    await admin
      .from("cs_reply_drafts")
      .update({ status: "pending", sent_at: null })
      .eq("token", token);
    return page("발송 실패", `<h1 class="err">회신 대상 검증에 실패했어요</h1><div class="card">잠시 후 다시 시도해주세요.</div>`);
  }

  const res = await sendOpsMessageToUser(admin, systemUserId, claimed.user_id || "", claimed.body);
  if (!res.ok) {
    // 발송 실패 → 선점 롤백(재시도 가능하게)
    await admin
      .from("cs_reply_drafts")
      .update({ status: "pending", sent_at: null })
      .eq("token", token);
    return page("발송 실패", `<h1 class="err">발송에 실패했어요 (${esc(res.reason)})</h1><div class="card">잠시 후 다시 시도해주세요.</div>`);
  }

  // 후처리(실패해도 발송은 성공이므로 best-effort)
  if (claimed.kind === "feedback" && claimed.feedback_id != null) {
    await admin.from("feedback").update({ status: "resolved" }).eq("id", claimed.feedback_id);
  }
  if (claimed.kind === "dm") {
    await admin
      .from("dm_messages")
      .update({ is_read: true })
      .eq("conversation_id", res.conversationId)
      .neq("sender_id", systemUserId)
      .eq("is_read", false);
  }

  return page("발송 완료", `<h1 class="ok">발송 완료됐어요 ✅</h1><div class="card"><pre>${esc(claimed.body)}</pre></div>`);
}
