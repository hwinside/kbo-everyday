# 크관(GameChat) 본인+운영자 채팅 삭제 v1

- **등록일**: 2026-05-26
- **상태**: 스펙 v3 (삼순이 NO-GO 18:54 + 반영기준 19:12 + 19:17 반영)
- **출처**: CS — "본인이 쓴 크관 채팅 삭제할 수 있도록 해달라" (#cs 스레드 `1779787469.325059`)
- **PR 시리즈**: PR1 DB(RPC+컬럼) → PR2 본인 RPC 호출 → PR3 본인 UI → PR4 어드민 모더레이션 (각 push 별도 승인)

> 🔒 **삼순이 GO 게이트 (v3 반영)**: `RLS 우회 불가 + public SELECT 원문 미노출`
> - broad `FOR UPDATE` RLS *금지*
> - 삭제는 `delete_own_chat_message` RPC 전용 (클라 `.update()` 직접 호출 X)
> - `content` *DB 레벨* 마스킹 (`삭제된 메시지입니다`로 덮어쓰기 — 원문 영구 손실)
> - `deleted_at IS NULL` 체크로 *undelete/redelete* 원천 차단

---

## 1. 문제·가치

- 크관(GameChat)에서 *본인이 쓴 메시지를 되돌릴 방법이 없음*. 오타·실언·정보 노출 시 회수 불가.
- 커뮤니티 댓글/게시글은 4/21 v1으로 본인 수정·삭제 가능. 크관만 누락 → 일관성 갭.
- 운영자가 부적절한 메시지를 즉시 가릴 모더레이션 수단 부재.
- 보안: anon 클라가 broad UPDATE 정책으로 `content/room_id/created_at` 등을 직접 갈아치우는 길을 열어선 안 됨 (삼순이 18:54 지적).

## 2. 핵심 경험

| 시나리오 | 동작 |
| --- | --- |
| **본인 말풍선 롱탭(모바일) / 우클릭(데스크)** | ⋯ 메뉴 노출 → *삭제* |
| *삭제* 탭 → confirm("이 메시지를 삭제할까요?") | OK → `supabase.rpc("delete_own_chat_message", { p_message_id })` → optimistic placeholder → Realtime UPDATE broadcast |
| 다른 디바이스/유저 화면 | Realtime UPDATE 수신 → 동일 자리에 *삭제된 메시지입니다* placeholder (italic, gray-500). **DB의 `content` 자체도 마스킹된 문구**라 anon SELECT 원문 노출 X |
| 타인 말풍선 롱탭 (일반 유저) | ⋯ 메뉴 *미노출* (UI 가드) |
| 비로그인 유저 | 메뉴 자체 비노출 |
| **운영자(어드민)** — `/admin/community` 채팅 모더레이션 섹션 | 룸 선택 + 메시지 리스트 + 각 메시지 *삭제* 버튼 → `POST /api/admin/chat/delete-message` (service_role + requireAdmin) → 동일 마스킹 + Realtime UPDATE |

> ⚠️ 어드민은 GameChat 일반 UI 안에서 직접 삭제하지 않습니다 (보안 + 일관성). `/admin/community` 전용.

## 3. 데이터 모델

### 3-1. 컬럼 추가

```sql
ALTER TABLE chat_messages
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS deleted_by UUID REFERENCES profiles(id) ON DELETE SET NULL;
```

- `deleted_at`: soft delete 시각.
- `deleted_by`: 누가 삭제했는지 (본인 = `user_id` 동일, 어드민 = 어드민 user_id). v1 감사로그 최소 단위.
- `content` 자체는 RPC가 *덮어쓰기*로 마스킹 → DB에서 원문 영구 손실 (v1 트레이드오프). 원문 보관은 v2 별도 `chat_audit_log`로.

### 3-2. RLS 정책 — broad UPDATE 추가 *금지*

기존 정책 유지 (schema.sql:104-106):
- SELECT: anyone
- INSERT: `auth.uid() = user_id`

> ❌ `CREATE POLICY ... FOR UPDATE USING (auth.uid() = user_id)` 같은 broad 정책은 *추가하지 않음*. 본인이 `content`/`room_id`/`created_at`을 직접 바꾸는 경로를 열기 때문 (삼순이 18:54).
> ✅ 삭제는 SECURITY DEFINER RPC 1개로만 노출 (§3-3).
> ✅ DELETE 정책도 추가하지 않음 — hard delete 금지.

### 3-3. RPC — `delete_own_chat_message`

```sql
CREATE OR REPLACE FUNCTION delete_own_chat_message(p_message_id BIGINT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller UUID := auth.uid();
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '42501';
  END IF;

  UPDATE chat_messages
     SET content    = '삭제된 메시지입니다',
         deleted_at = now(),
         deleted_by = v_caller
   WHERE id = p_message_id
     AND user_id = v_caller       -- 본인만
     AND deleted_at IS NULL;      -- undelete/redelete 차단

  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_owner_or_already_deleted' USING ERRCODE = '42501';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION delete_own_chat_message(BIGINT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION delete_own_chat_message(BIGINT) TO authenticated;
```

- `SECURITY DEFINER` + `auth.uid()` 체크로 *서명자(본인)만* 삭제 가능. broad RLS 우회 차단.
- `WHERE deleted_at IS NULL`로 두 번째 호출(redelete) 또는 NULL로 되돌리는 undelete 원천 봉쇄.
- `content` 덮어쓰기를 *함수 내부에서만* 수행 → 클라가 임의 content로 마스킹 불가.
- 실패 시 명시적 예외 raise → 클라가 toast로 안내.

### 3-4. 어드민 모더레이션 — service_role 직접 마스킹

어드민은 RPC 거치지 않고 service_role로 직접 UPDATE (RLS 우회). 단 *동일 마스킹 로직*을 route handler에서 명시:

```ts
// /api/admin/chat/delete-message/route.ts (PR4)
const { error, count } = await supabaseAdmin
  .from("chat_messages")
  .update({
    content: "삭제된 메시지입니다",
    deleted_at: new Date().toISOString(),
    deleted_by: adminUserId,
  }, { count: "exact" })
  .eq("id", messageId)
  .is("deleted_at", null);  // 어드민도 undelete/redelete 차단

if (error || count === 0) return Response.json({ ok: false, ... }, { status: 4xx });
```

> 대안 검토: `admin_delete_chat_message(p_message_id, p_admin_uid)` RPC를 따로 두는 안. 어드민은 cookie auth로 `auth.uid()`가 안 잡힐 수 있어 service_role 직접 UPDATE 쪽이 더 단순. *단 마스킹 SQL은 RPC와 1:1 동일*해야 함 — PR4 리뷰 시 diff 검증.

## 4. API

### 4-1. 본인 삭제 — `useChat.ts`

```ts
// ChatMessage 타입에 추가
deleted_at: string | null;
deleted_by: string | null;

async function deleteMyMessage(id: number): Promise<{ ok: boolean; error?: string }> {
  if (!user) return { ok: false, error: "not_logged_in" };

  const { error } = await supabase.rpc("delete_own_chat_message", { p_message_id: id });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}
```

> ⚠️ 클라이언트가 `.from("chat_messages").update(...)`를 **직접 호출하지 않습니다** (삼순이 19:17). RPC만 사용.

`mapRow`에서 `deleted_at` + `deleted_by` 전달.

### 4-2. Realtime UPDATE

기존 채널이 INSERT만 subscribe하면 UPDATE 누락. `subscribe` 블록에 UPDATE event 추가:

```ts
.on("postgres_changes",
    { event: "UPDATE", schema: "public", table: "chat_messages", filter: `room_id=eq.${roomId}` },
    (payload) => {
      setMessages(prev => prev.map(m => m.id === payload.new.id
        ? { ...m, content: payload.new.content,           // 마스킹된 content
              deleted_at: payload.new.deleted_at,
              deleted_by: payload.new.deleted_by }
        : m
      ));
    })
```

### 4-3. 어드민 삭제 — `/api/admin/chat/delete-message` (POST, PR4)

§3-4 참조. `requireAdmin` 가드는 PR4 시작 전 코드베이스 기존 패턴(`/admin/*` 페이지 가드) 확인 후 동일 wiring.

## 5. UI

### 5-1. 메시지 렌더링 — `GameChat.tsx`

```tsx
{m.deleted_at ? (
  <span className="italic text-text-tertiary">{m.content}</span>  // DB가 이미 "삭제된 메시지입니다"
) : (
  <span>{m.content}</span>
)}
```

- DB가 마스킹된 content를 저장하므로 UI 분기는 italic/gray 스타일링만 담당.
- 닉네임/팀배지는 그대로 표시.

### 5-2. 본인 ⋯ 메뉴 — `GameChat.tsx`

- 메시지 long-press (≥500ms) → 메뉴 (커뮤니티 `CommentSheet` ⋯ 메뉴 패턴 재활용)
- 데스크 우클릭 fallback
- 메뉴 항목: `삭제` (단일, v1)
- confirm dialog → `deleteMyMessage(id)` → optimistic 즉시 messages 배열 patch (`{ content: "삭제된 메시지입니다", deleted_at: nowIso, deleted_by: user.id }`)
- RPC 에러 시 rollback + toast

가드:
- 본인 = `m.user_id === user?.id`인 경우만 메뉴 활성
- 이미 삭제된 메시지(`m.deleted_at`)는 메뉴 비노출
- 비로그인 시 메뉴 진입 차단 (`isLoggedIn === false`)

### 5-3. 어드민 모더레이션 — `/admin/community` 채팅 섹션 (PR4)

- 신규 탭 *채팅 모더레이션*
- 룸 선택 드롭다운 + 최신 50개 메시지 페이징
- 각 row: `nickname`, `content`, `created_at`, `deleted_at` + *삭제* 버튼
- 삭제 버튼 → confirm → `POST /api/admin/chat/delete-message` → row 갱신 + toast

> v1 스코프: 신고 큐 연동 X. 어드민이 룸 선택 → 수동 삭제. 신고/감사로그 자동화는 v2.

## 6. PR 분할

| PR | 내용 | 검증 |
| --- | --- | --- |
| **PR1** | `deleted_at` + `deleted_by` 컬럼 추가 + `delete_own_chat_message` RPC + GRANT/REVOKE | Supabase SQL Editor 실행. *broad UPDATE policy 없음* 재확인. anon 키로 직접 `.update()` 시도 → RLS 차단 확인. |
| **PR2** | `useChat.ts` `supabase.rpc("delete_own_chat_message")` + 타입 + Realtime UPDATE 핸들러 | 콘솔에서 본인 메시지 RPC 호출 → 성공 / 타인 메시지 RPC 호출 → `not_owner_or_already_deleted` 예외 / 동일 메시지 두 번 호출 → 같은 예외 |
| **PR3** | `GameChat.tsx` 본인 ⋯ 메뉴 + confirm + placeholder 렌더 | End-User QA §7-A |
| **PR4** | `/api/admin/chat/delete-message` route + `/admin/community` 모더레이션 탭 | End-User QA §7-B |

각 PR push는 **하린아빠 GO 별도 필요**. PR1만 머지하고 PR2~3 holding 상태에선 *기능 비활성* (RPC가 있어도 클라 호출 없음).

## 7. End-User Level QA — 3권한 + 보안 시나리오

### 7-A. 일반 유저 (PR3 머지 시점)

1. ✅ 본인 메시지 롱탭 → ⋯ → 삭제 → DB content가 *"삭제된 메시지입니다"*로 교체 + placeholder italic gray
2. ✅ 다른 탭/디바이스에서 동일 메시지 자리 placeholder (Realtime UPDATE)
3. ✅ 타인 메시지 롱탭 → 메뉴 미노출
4. ✅ 비로그인 상태 롱탭 → 메뉴 미노출
5. ✅ 삭제된 메시지 다시 롱탭 → 메뉴 미노출
6. ✅ **broad UPDATE 차단**: anon 키 SDK로 `supabase.from("chat_messages").update({ content: "악의적", deleted_at: null }).eq("id", X)` 시도 → RLS error 또는 0 rows
7. ✅ **undelete 차단**: 이미 삭제된 메시지에 RPC 재호출 → `not_owner_or_already_deleted` 예외 (`deleted_at IS NULL` 가드)
8. ✅ **redelete 차단**: 같은 본인이 이미 삭제된 자기 메시지 RPC 재호출 → 동일 예외
9. ✅ **content DB 마스킹**: 삭제 후 anon SELECT로 row 직접 조회 → `content`가 마스킹 문구 (원문 노출 0건)
10. ✅ 새로고침 후 placeholder 유지
11. ✅ DM/홈팀/원정팀 룸 동일 동작

### 7-B. 어드민 (PR4 머지 시점)

12. ✅ `/admin/community` 채팅 모더레이션 탭 → 룸 선택 → 메시지 리스트
13. ✅ 어드민이 타인 메시지 삭제 → row content 마스킹 + `deleted_by` = 어드민 user_id
14. ✅ 일반 유저 화면 Realtime UPDATE 즉시 반영
15. ✅ 비-어드민 유저가 어드민 페이지 진입 → 401
16. ✅ 이미 본인 삭제된 메시지에 어드민 재삭제 시도 → no-op (`.is("deleted_at", null)` 가드)

서버/DB PASS만으론 마감 금지 — *실제 로그인 유저 + 어드민 계정* 경험 레벨까지 확인.

## 8. 스코프 v1 → v2 이관

- 신고-삭제 자동 연동
- 본인 메시지 *수정* (인라인 에디터)
- 시간 제한 (예: 5분 이내만 본인 삭제)
- `chat_audit_log` 별도 테이블 — 원문 보존 + 삭제 사유 + 신고자 + IP
- 룸 단위 일괄 모더레이션 (스팸 봇 대응)
- 어드민이 *복원* (undelete) — 신중한 권한 게이트 + audit log 필요

## 9. 리스크 / 의문점

- **content 원문 영구 손실**: v1 트레이드오프. 신고/감사 보존이 필요하면 v2 `chat_audit_log`로 이관 (이번 v1엔 포함 X).
- **Realtime UPDATE filter 정확성**: `room_id=eq.${roomId}` filter가 supabase-js v2 spec에 맞는지 PR2에서 검증.
- **service_role 노출**: `/api/admin/chat/delete-message`가 Next.js Route Handler(서버사이드)에서만 실행 보장. 클라 번들 노출 절대 X.
- **`requireAdmin` 가드 존재**: 코드베이스 기존 어드민 페이지 가드 패턴(`/admin/*`) 확인 후 PR4에 wiring. 없으면 `getSupabaseAdmin` + cookie auth 패턴 도입.
- **신고 기능 의존성**: 현재 신고 시스템이 `chat_messages.content`를 *직접 표시*하는지 확인 필요. 표시한다면 마스킹된 문구가 신고 큐에 보임 → 모더레이션이 어려워짐. PR1 작업 직전에 `migration-moderation.sql`/신고 관련 코드 grep으로 점검.
- **Mood gauge 영향**: 게이지는 INSERT 카운트 기반이라 무관.

---

## 변경 이력
- 2026-05-26 18:43: v1 초안 (삼식이) — 본인만, 운영자 v2 이관
- 2026-05-26 19:13: v2 (삼식이) — 운영자 v1 포함, placeholder, `deleted_by`. *단, broad UPDATE RLS + 클라 직접 update + content 미마스킹*으로 삼순이 NO-GO (18:54, 19:17)
- 2026-05-26 19:24: v3 (삼식이) — *broad UPDATE RLS 제거*, `delete_own_chat_message` SECURITY DEFINER RPC 도입, content DB 레벨 마스킹, `deleted_at IS NULL` 가드로 undelete/redelete 차단, 어드민은 service_role 직접 마스킹 (RPC와 동일 SQL). QA 시나리오 16개로 확장 (broad UPDATE/undelete/redelete/content DB 마스킹 추가).
