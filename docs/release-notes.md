# Release Notes (append-only)

> Rule: 1 deploy = 1 entry (append-only)

---

## 2026-08-03 05:46 KST — 야잘알봇 캐릭터·헤더 바로가기·답변 상태 (#1039/#1057/#1058)

- **환경:** prod/web (Vercel) + Supabase migration
- **Commit:** `0107a562276e8f2aa9ae8e0dfdc766c70faf232c` (#1039) → `04fed9c0b2a30e1a6a4f56b23169077f5e023736` (#1057) → `1c435016b8d8ccba4831544ebdf3efab679786a3` (#1058 최종)
- **변경사항:** 일반 사용자 쪽지함 목록·대화 헤더의 야잘알 캐릭터 공개, 로그인 홈·뉴스 헤더에서 쪽지 아이콘 왼쪽 한 탭 진입, 비로그인 버튼 DOM 0·직접 URL 이탈, 서버 payload(`reply_kind` + `match_path`) 기반 답변 상태(`answering`/`praised`/`unknown`/`idle`) 표시
- **DB:** `20260802_ops_message_payload.sql` 선적용. `admin_send_ops_message` 8인자 RPC 단일화, payload까지 dedup 동일성에 포함. 운영 실측 `anon=false`·`authenticated=false`·`service_role=true`, migration ledger 1건
- **리스크/롤백:** 중간. UI 문제 시 #1058→#1057→#1039 역순 revert. DB 롤백은 8인자 RPC 제거 후 7인자 시그니처 복원 필요
- **확인 항목:**
  - [x] 삼순 exact GO 결속 후 순차 squash merge
  - [x] Vercel Production `dpl_EwTEjeCqKdrUmPwjrxfpWiZugSdX` READY·`keubo.fan` alias
  - [x] 전용 테스트 계정 End-User QA: 헤더 진입 21/21, 답변 상태·payload 15/15, 공개 아바타·390px 레이아웃 36/36
  - [x] 테스트 대화·메시지·프로필·auth 잔존 0

---

## 2026-07-31 13:52 KST — 쇼츠 scope 필터(#973) + 예고선발 공개 알림(#974) [CS 제안]

- **환경:** prod/web (Vercel)
- **Commit:** `fdd165ee9b6c27b58636c3decc7cb78e8b3181a9` (#973) · `9c5772726b660b370c73fd0250592d83e23ecba4` (#974 최종 배포 커밋)
- **배경:** 유저 제안(#cs `1785380092`, DM conv cf07bbc6) — ①쇼츠를 최애선수만이 아니라 마이팀·전체로 골라 보기 ②예고선발(선발 투수) 공개 즉시 알림
- **변경사항:**
  - (#973) 쇼츠 피드에 `최애선수 · 마이팀 · 전체` scope 필터. 단순 화면 필터가 아니라 API `scope=favorite_players|my_team|all` 쿼리 분리(순수함수 `shorts-feed-scope.ts`), scope 미지정=기존 혼합 피드(하위호환), HomeHighlights 3칩 + localStorage 유지. race LatestOnlyGate + abort/실패 stale 차단, 칩 항상 1개 활성
  - (#974) 최애팀 경기 예고선발 공식 공개 시 즉시 푸시 1회. 라인업 확정 푸시(#952) 원장 아키텍처를 event `starter_announce`로 클론 — `(game_id, team_id)` 스냅샷·lease fencing·at-most-once dispatch·due-ledger drainer. 실제 빈값→공식값 전이만 발송(baseline stale burst 차단). 각 `(game_id, team_id)`당 1회·공식→공식 변경 재발송 0; 연전/더블헤더는 gameId별 분리. `starter_announce` pref 기본 on
- **DB:** migration `20260730_starter_announce_notify.sql` 프로덕션 선적용(Management API HTTP 201) — `starter_announce` 컬럼 + `game_starter_observation`·`game_starter_notify_state`·`starter_announce_delivery_ledger` 3테이블 RLS ON(정책 0) + snapshot/observe/claim/mark/settle/finalize/list_due 7 RPC(anon/authenticated EXECUTE revoke, service_role 전용)
- **리스크/롤백:** 낮음. #973은 migration 없음, scope 미지정 시 기존 동작 불변. #974는 신규 알림 종류 추가(전이 게이트로 오발송 차단). 문제 시 각 squash revert
- **확인 항목:**
  - [x] 삼순 GO exact 그대로 squash 머지 (#973 `8bcd58ba5`, #974 `744338af8`)
  - [x] Vercel Production Ready(커밋 `9c5772726`) + `keubo.fan` HTTP 200
  - [x] 쇼츠 scope 프로덕션 스모크: all=3 / my_team(LG)=3 / favorite_players 미지정=0(임의 폴백 없음) / 무scope=3(하위호환)
  - [x] DB sanity: starter_announce 컬럼 + 3테이블 RLS ON(정책 0) + 7 RPC anon/auth EXECUTE revoke·service_role only
  - [x] 건의 유저 완료 회신(conv cf07bbc6, dm_messages id 292539)
  - [ ] 예고선발 알림 실제 푸시 실수신 자연관찰 (서버 cron 푸시라 다음 실경기 예고선발 공개 시, HOLD)

---

## 2026-07-31 17:32 KST — 야잘알봇 v2 S0 멀티턴 맥락 (#1011)

- **환경:** prod/web (Vercel) + Supabase migration
- **Commit:** `882f1a1744fb9ead6197a133421b347b3836c96a` (squash, reviewed exact `b623a2cf014ed356d71645015eae50e89415d0b4`)
- **배경:** 야잘알봇의 후속 질문(`또 다른 경우는?`)이 맥락 부재로 `blocked` 차단되던 버그 해소(spec §4 rev0.6, Notion `3aec901bb37281408cecf4c700b96487`). S0 전용 — S1a/S1b/S2는 HOLD.
- **변경사항:**
  - B1 직전 user turn 1개만 후속 맥락 source·중간 blocked/in-flight/new-topic barrier(과거 폴백 금지)
  - B2 `genius_question_jobs.message_id` join + answer DM `dedup_key='baseball-genius:'||q.id` exact join, answered_at=answer created_at, answer DM 실존 시만 source
  - B3 자격=`genius_question_jobs.source IN (dictionary,cache,llm)` fail-closed(logs.match_path는 FK 없어 미사용)
  - B4 closed-set 정규화 full-string 후속 문법 SSOT 상수
  - B5 TTL=answer DM created_at 기준 600.000초·`genius_qa_cache` read+write bypass
  - 신규 RPC `baseball_genius_previous_turn(bigint)`(SECURITY DEFINER, GRANT service_role 명시·anon/auth REVOKE)·인덱스·`context_missing` route/match_path
- **DB:** migration `20260731_baseball_genius_previous_turn.sql` 프로덕션 적용(Management API HTTP 201). ⚠️ 하린아빠 GitHub 직접 머지로 "migration 선적용→머지" 순서 역전 — 미적용 구간에는 RPC error를 catch해 context=null로 `context_missing` 처리(의도치 않은 맥락 주입 없이 fail-closed). live/DB는 정상이나 미적용 구간 DM 영향은 미검증(장애 증거 없음), 머지 감지 즉시 적용.
- **리스크/롤백:** 낮음. 미적용·오류 경로 전부 fail-closed(context=null→`context_missing`, 의도치 않은 맥락 주입 없음). 롤백은 squash revert + migration full reverse — `baseball_genius_previous_turn(bigint)` DROP FUNCTION + `idx_dm_messages_conversation_sender_recent` DROP INDEX + `genius_question_logs.match_path` CHECK를 `context_missing` 제외한 기존 allowlist로 복원.
- **확인 항목:**
  - [x] 삼순 코드리뷰 GO(3왕복, exact `b623a2cf014ed356d71645015eae50e89415d0b4`) + 하린아빠 `머지ok`
  - [x] Vercel Production Ready(`882f1a1744fb9ead6197a133421b347b3836c96a`, deployment `5688672207`) + `keubo.fan` HTTP 200
  - [x] migration 적용·실측: RPC ACL service=true/anon·auth=false, 인덱스, `context_missing` CHECK, RPC smoke 0행
  - [x] AC1~15 + RPC ACL 결함주입 RED→GREEN, tsc/eslint/prebuild PASS
  - [ ] 배포 후 실제 계정 직접 첫 질문→후속 질문 2턴 End-User QA — HOLD

---

## 2026-05-02 21:31 KST — 크관 채팅 iOS 키보드 하단 gap 방어 + BrowserStack QA 스크립트

- **환경:** prod/web (Vercel)
- **Commit:** 49953d7783fe0ab14300128f7f3895a177c4d198
- **변경사항:**
  - iOS Safari 키보드 오픈 상태에서 스크롤 시 입력창 아래로 뒤쪽 페이지/빈틈이 비쳐 보이는 현상 방어
  - keyboard panel 아래 영역에 opaque blocker를 추가해 composer 아래~layout viewport bottom을 덮음
  - keyboard panel/message 영역에 overscroll 방어 클래스 추가
  - BrowserStack iPhone Safari QA 스크립트 `pnpm qa:ios-safari-keyboard` 추가
- **리스크/롤백:** 중간. 크관 채팅 iOS 키보드 포커스/스크롤 레이아웃 한정 변경이며 문제 시 `49953d77` revert
- **확인 항목:**
  - [x] `pnpm exec tsc --noEmit` 통과
  - [x] `pnpm exec eslint src/components/game/GameChat.tsx` error 0
  - [x] `pnpm build` 통과
  - [x] local fake keyboard QA: 최신댓글 5개, 마지막 댓글↔입력창 gap 8px, blocker top=composer bottom 확인
  - [x] Vercel production Ready + `keubo.fan` alias 확인
  - [~] BrowserStack Automate iPhone Safari 접속/스크린샷/DOM metrics 수집 성공, 단 소프트 키보드 visualViewport 변화가 없어 최종 시각 QA는 inconclusive
  - [ ] iOS Safari/BrowserStack Live에서 실제 키보드 시각 QA 최종 확인

---

## 2026-05-02 20:38 KST — 크관 채팅 iOS 키보드 포커스 V2 후속 보정

- **환경:** prod/web (Vercel)
- **Commit:** a2ad2e07f0c27461af7c257f8513fd25a41b6e89
- **변경사항:**
  - iOS Safari에서 자동완성/연락처 바 애니메이션 중 tiny `visualViewport.height` 샘플이 들어와 입력창이 상단으로 밀리는 문제 방어
  - 키보드 오픈 상태에서 최신 댓글 5개를 inner wrapper `mt-auto`로 입력창 바로 위에 고정
  - 키보드 닫힘 후 예약 auto-align을 제거해 닫힌 상태의 사용자 스크롤이 다시 채팅 입력창으로 끌려 내려가지 않도록 수정
- **리스크/롤백:** 중간. 크관 채팅 iOS 포커스 레이아웃 한정 변경이며 문제 시 `a2ad2e07` revert
- **확인 항목:**
  - [x] `pnpm exec tsc --noEmit` 통과
  - [x] `pnpm exec eslint src/components/game/GameChat.tsx` error 0
  - [x] `pnpm build` 통과
  - [x] Vercel production Ready + `keubo.fan` alias 확인
  - [x] prod fake tiny viewport QA: 메시지 5개, 마지막 댓글↔입력창 gap 8px, blur 후 upward scrollY 1664→788 확인
  - [ ] iOS Safari 실기기 최종 확인

---

## 2026-05-02 20:16 KST — 크관 채팅 iOS 키보드 포커스 안정화 V2

- **환경:** prod/web (Vercel)
- **Commit:** 65701d9a2170631d6b9be90c59c499272020594a
- **변경사항:**
  - 크관 채팅 입력 포커스 시 iOS Safari에서 댓글/입력창 위치가 매번 달라지는 문제 수정
  - `keyboardInset` 역산 대신 `visualViewport`의 `{top, height}`를 직접 fixed panel 크기로 사용
  - 키보드 열림 상태에서는 최신 댓글 5개만 입력창 바로 위에 bottom-align하고, 방 선택/분위기 게이지는 숨김
  - body scroll lock 제거로 focus/blur/viewport 이벤트 순서 경쟁 완화
- **리스크/롤백:** 중간. iOS 키보드 포커스 레이아웃 한정 변경이며 문제 시 `65701d9a` revert
- **확인 항목:**
  - [x] `pnpm exec tsc --noEmit` 통과
  - [x] `pnpm exec eslint src/components/game/GameChat.tsx` error 0
  - [x] `pnpm build` 통과
  - [x] Vercel production Ready + `keubo.fan` alias 확인
  - [ ] iOS Safari 실기기에서 키보드 오픈 시 최신댓글 5개 → 입력창 → 키보드 순서 최종 확인

## 2026-05-02 04:52 KST — 댓글 시트 아래 스와이프 닫기 추가

- **환경:** prod/web (Vercel)
- **Commit:** 825460b91e7a43aa17f83e9176c59f40fa6f282c
- **변경사항:**
  - 댓글 시트 전체에서 아래로 쓸어내리면 닫히도록 터치 제스처 추가
  - 댓글 목록이 스크롤된 상태에서는 기존 스크롤을 우선하고, 최상단에서 아래 스와이프할 때만 닫힘
  - 입력창 터치/입력 중 제스처 오작동 방지
- **리스크/롤백:** 낮음. 댓글 시트 터치 핸들러만 추가, 문제 시 해당 커밋 revert
- **확인 항목:**
  - [x] `pnpm exec tsc --noEmit` 통과
  - [x] `pnpm exec eslint src/components/community/CommentSheet.tsx` error 0 (기존 warning 3개)
  - [x] `pnpm build` 통과
  - [x] 로컬 모바일 viewport에서 touchstart/move/end 아래 스와이프 시 시트 닫힘 확인

---

## 2026-05-02 04:40 KST — 사진게시판 댓글 시트 iOS viewport 안정화

- **환경:** prod/web (Vercel)
- **Commit:** da40e493803bb0208bf64142b34fcc6a21e3474e
- **변경사항:**
  - 사진게시판 댓글 시트가 iOS Safari/WebView 키보드 이벤트 후 아래 피드/미디어를 노출하며 축소되는 문제 수정
  - `visualViewport`의 stale keyboard inset을 sheet `bottom`에 직접 적용하지 않도록 변경
  - 댓글 시트를 visual viewport 기준 `top + height`로 고정하고, 입력영역 safe-area padding만 별도 처리
- **리스크/롤백:** 낮음~중간. 댓글 시트 레이아웃 단일 컴포넌트 변경이며 문제 시 직전 커밋으로 롤백 가능
- **확인 항목:**
  - [x] `pnpm exec tsc --noEmit` 통과
  - [x] `pnpm exec eslint src/components/community/CommentSheet.tsx` error 0 (기존 warning 3개)
  - [x] `pnpm build` 통과
  - [x] Vercel production Ready + `keubo.fan` alias 확인
  - [x] production 모바일 viewport/keyboard-like shrink/restore에서 sheet bottom gap 0 확인

---

## 2026-03-11 16:51 KST — 밈 에디터 2차 (식별자 통합 + 반전 + GIPHY)

- **환경:** prod/web (Vercel)
- **Commits:**
  - 23cf679c (kboId 통합 + player_tags kboId 저장)
  - f768290a (에셋 좌우/상하 반전)
  - 288285b0 (GIPHY 스티커 연동)
- **변경사항:**
  - PlayerTagger: players.ts 목업(내부 id) → players-roster.json(684명, kboId) 전환
  - player_tags DB 저장: name-only → "kboId:name" 포맷 (기존 데이터 하위호환)
  - 밈 에디터 선택 에셋에 좌우/상하 반전 버튼 추가 (Fabric.js flipX/flipY)
  - StickerTool에 GIPHY 탭 추가 (검색 + 트렌딩, rating=g SafeSearch)
  - 스티커는 정적 이미지(still)로 canvas 삽입
  - "Powered by GIPHY" attribution 표시
- **리스크:** 낮음 (UI 기능 추가, 기존 데이터 무중단 호환)
- **환경변수:** Vercel에 `NEXT_PUBLIC_GIPHY_API_KEY` 추가 필요
- **확인 항목:**
  - [ ] 선수 태그 선택 시 684명 전체 검색 가능
  - [ ] 동명이인(김현수 LG/KT) 태그 → 각각 올바른 선수 페이지 링크
  - [ ] 에셋 선택 후 좌우/상하 반전 정상 동작
  - [ ] GIPHY 탭에서 스티커 검색 + 삽입 정상 (env key 설정 후)
  - [ ] env key 없으면 GIPHY 탭 숨김 (graceful fallback)

---

## 2026-03-10 22:41 KST — 동명이인 선수 사진 중복 버그 수정

- **환경:** prod/web (Vercel)
- **Commit:** 8afddf0da91f9e8ca78ec8f13a955a1b8c24f4b5
- **변경사항:**
  - 선수 사진 조회를 name 기반 → kboId 기반으로 전환 (name fallback 유지)
  - 동명이인 27그룹 중 19그룹(35명)의 사진 오류 해결
  - PLAYER_PHOTO_ID_SET 추가 (584개 kboId, O(1) lookup)
  - teams/[teamId] 페이지 roster key를 name→kboId로 변경
- **리스크:** 낮음 (사진 표시 로직만 변경, 데이터/DB 변경 없음)
- **확인 항목:**
  - [ ] 김현수 검색 시 KIA/KT 각각 다른 사진 표시
  - [ ] 팀 페이지에서 동명이인 선수 모두 정상 표시
  - [ ] 사진 없는 선수는 기본 아바타 표시 (잘못된 사진 대신)
  - [ ] 라이브 경기 컴포넌트(라인업 등) 정상 작동

---

## 2026-03-09 10:18 KST — 댓글 아바타 통일

- **환경:** prod/web (Vercel)
- **Commit:** 03d27fb
- **변경사항:**
  - 사진게시판 댓글 작성 직후 새싹 폴백 → 아바타 정상 표시
  - 일반게시판 댓글을 팀레이블에서 아바타+등급뱃지로 통일
  - Comment 인터페이스/쿼리에 avatar_url 필드 추가
- **리스크:** 낮음 (프론트 전용, DB 변경 없음)
- **확인 항목:**
  - [ ] 사진게시판 댓글 작성 직후 아바타 표시
  - [ ] 일반게시판 댓글에 아바타+등급뱃지 표시
  - [ ] 기존 댓글 조회 시 아바타 정상 렌더링

---

## 2026-03-08 21:14 KST — 경기 상세 라운드3: BSO 위치, 여백, 채팅 팬방 분리

- **환경:** prod/web (Vercel)
- **Commit:** `82ad116`

### 변경사항
1. **BSO 전광판** → 그라운드 밖 우하단으로 최종 이동 (1루수 겹침 완전 해소)
2. **상단 여백 축소** — 헤더 py 2.5→1.5, ScoreBar top offset 60→36px
3. **스코어바 수평 얼라인** — 로고+팀명+점수 한 줄 정렬, 48px 확대
4. **채팅 팬방 독립 스레드** — 전체/홈팬방/원정팬방 각각 별도 roomId, 팬방은 해당 팀 팬만 글쓰기
5. **채팅 입력창** — safe-area-inset-bottom 적용 (iPhone 홈바 대응)

### 확인 항목
- [x] BSO 겹침 해소
- [x] 상단 여백 + 스코어바 정렬
- [x] 채팅 팬방 전환 시 독립 스레드 동작
- [x] 하린아빠 최종 확인 완료 ✅

---

## 2026-03-08 20:14 KST — 경기 상세 QA 피드백 5건 수정

- **환경:** prod/web (Vercel)
- **Commit:** `0991fe6286a52727501190fe9491971aad9d4169`

### 변경사항
1. **스코어 중앙정렬 + 크기 확대** — 32→40px, live/non-live 통일
2. **BSO 전광판 UI** — 그라운드 분리 표시 → FieldView 우하단 오버레이 (B/S/O 도트)
3. **두산 사진없는 선수 3명 교체** — 곽빈→최승용, 김재환→김인태, 박세혁→전다민 + 중계 텍스트 반영
4. **선수 클릭 빈 페이지 수정** — "선수 정보 준비 중" + 돌아가기 버튼
5. **채팅 입력창 중복 제거** — 페이지 하단 고정 입력창 삭제 (GameChat 내 입력창만 유지)

### 확인 항목
- [ ] 경기 상세 스코어 크기/정렬 확인
- [ ] BSO 전광판이 그라운드 우하단에 표시되는지 확인
- [ ] 두산 선수 사진 3명 정상 표시 확인
- [ ] 선수 클릭 시 빈 페이지 대신 안내문 + 돌아가기 동작

---

## 2026-03-08 17:30 KST — v8.8 경기 상세 페이지 Phase 1 구현

- **환경**: prod/web (keubo.fan)
- **Commit**: 6e2d2e7fd6803c431eecdc9b7b8300d42ed933e6
- **변경사항**:
  - ScoreBar 신규 — sticky 스코어바 (BSO 텍스트, 주자 미니 다이아몬드)
  - LinescoreTable 신규 — 9이닝 라인스코어 (R/H/E 포함)
  - FieldViewV2 신규 — v8.8 다이아몬드 수비배치 (완벽 좌우 대칭, 황토색 infield, 28px 원형 사진 마커, On-deck 오버레이)
  - MatchupCard 신규 — 투타 매치업 (ERA/타율 static JSON 조회, 2줄 리치 스탯)
  - page.tsx 레이아웃 리팩토링 (Header → ScoreBar → Linescore → FieldView → Matchup → Tabs)
  - AI 분석 버튼 헤더에서 제거
- **리스크**: 없음 (mock 데이터 기반, Phase 2에서 실시간 크롤링 추가 예정)
- **확인**:
  - [x] pnpm build 성공
  - [ ] 스코어바 sticky 동작 + BSO/주자
  - [ ] 다이아몬드 좌우 대칭
  - [ ] 투타 매치업 ERA/타율
  - [ ] 모바일 430px 레이아웃

---

## 2026-03-08 09:30 KST — 경기 상세 페이지 대폭 개선

- **환경**: prod/web (keubo.fan)
- **Commits**: 14237fc → 9552639166ef04f4f00dc1b108f50640907104bf
- **변경사항**:
  - 라디오 바 제거 (기능 미구현 상태였음)
  - 이닝별 라인스코어 LIVE 경기에서도 표시
  - 스코어 헤더 컴팩트화 (로고 52→40px, 점수 3xl→2xl)
  - 투타 매치업 강화: PlayerAvatar + ERA/투구수/타율/오늘성적
  - 대기 타석 표시 (OnDeckBatters, 현재 타자 기준 다음 3명)
  - 수비 배치 FieldView 신규 (다이아몬드 9포지션 + 주자 이름)
  - GameState에 runner1bName/2bName/3bName 필드 추가
  - Mock 데이터: 만루 상황으로 변경 (주자 확인용)
- **리스크**: 없음 (mock 데이터 기반, 실시간 API 미연동)
- **확인**:
  - [x] 빌드 성공
  - [x] 수비 포지션 배치 확인 (투수 마운드 중앙, 내야수 다이아몬드 위)
  - [x] 만루 주자 3명 + 이름 표시
  - [x] 투타 스탯 + 선수 사진 표시

---

## 2026-03-08 05:30 KST — PWA 재설치 온보딩 버그 수정

- **환경**: prod/web (keubo.fan)
- **Commit**: 932930b0eedea9f7ed1389be0416113f82440b3b
- **변경사항**:
  - PWA 삭제→재설치 시 로그인 유저에게 온보딩(팀/최애선수 선택)이 다시 노출되던 버그 수정
  - AuthContext `syncProfileToLocal()`에서 DB team_id 있으면 온보딩 상태도 함께 복원
  - 홈 페이지 useEffect에서 profile+team_id 체크를 최우선으로 (localStorage 무관하게 스킵)
  - profile 로딩 중(null)일 때 온보딩 표시 방지 (레이스 컨디션 차단)
- **리스크/롤백**: 낮음 / `a1592dd`로 revert 가능
- **확인 항목**:
  - [x] PWA 삭제→재설치→로그인 시 온보딩 미노출
  - [x] 비로그인 첫 방문 시 정상 온보딩 표시
  - [x] 빌드 성공

---

## 2026-03-08 05:50 KST — PR3 사진 게시판 + 인스타 비율

- **환경:** prod/web (Vercel)
- **Commits:** `932930b50a0e3a5e4f8c0b6e6e1a2c3d4f5a6b7c`, `87fecc44aeb50885b2e81013742cee8f6e2c5b5d`
- **변경사항:**
  - 팀탭/선수탭에 [일반/사진] 토글 추가
  - 인스타 피드형 사진 게시판 (PhotoFeed, WritePhotoPost 컴포넌트)
  - 캐러셀 스와이프 (1~3장, dot indicator)
  - 사진 비율 4:5 고정 + object-cover (인스타 방식)
  - usePosts에 content_type 필터 + 이미지 업로드 함수
  - Next.js Image remotePatterns에 Supabase Storage 도메인 추가
  - 팀탭에서 선수 게시판 토글 제거 (선수탭과 중복)
- **리스크/롤백:** `fb80c52`로 revert 가능. DB content_type 컬럼은 default='general'이라 기존 데이터 영향 없음.
- **확인 항목:**
  - [x] 팀탭 일반/사진 토글 정상
  - [x] 사진 피드 이미지 로딩 정상
  - [x] 혼합 비율 캐러셀 스와이프 높이 일정
  - [x] 일반탭 기존 기능 정상

---

## 2026-03-08 03:41 KST — 커뮤니티 OG 카드 + 게시글 라우팅 정상화

- **환경:** prod/web (Vercel)
- **Commits:**
  - `731d192b1d5370ddb2c040b370c5f0b1de4cac4d` — 게시글 클릭 → 상세 이동 연결 + LinkPreview 이벤트 충돌 수정
  - `3a72c4fe2973dd2a78f8c7b43092b532a7b3ed00` — www. 시작 URL도 OG 프리뷰 지원
  - `7fbd1c507ac2a5c6446c0eb30605653ea569a93a` — OG 카드 컴팩트 + 팀 글 상세 라우팅 정상화

### 변경사항
- **P0 수정**: 게시글 목록에서 클릭해도 상세 페이지로 이동하지 않던 버그 수정 (PostList → PostCard onPress 미전달)
- **OG 카드 컴팩트화**: 세로 풀사이즈 → 가로 레이아웃 (80px 썸네일 + 텍스트, 카톡/슬랙 스타일)
- **www. URL 지원**: `www.` 시작 URL도 OG 프리뷰 자동 감지 + `https://` prefix
- **팀 게시판 라우팅 정상화**: 팀 글 상세 → `/community/teams/{teamId}/posts/{postId}` 신규 라우트 (탭 활성 유지 + "LG 게시판" 헤더)
- **뒤로가기 2개 중복 해소**: 상세 페이지에서 커뮤니티 탭 헤더 자동 숨김
- **PostDetail 공통 컴포넌트**: 자유/선수/팀 상세 페이지 통합 (-313줄 중복 제거)

### 리스크/롤백
- `git revert 7fbd1c5` + `git revert 3a72c4f` + `git revert 731d192`
- PostDetail 공통 컴포넌트: 기존 코드 그대로 옮긴 것, 로직 변경은 headerTitle prop 하나뿐

### 확인 항목
- [x] 팀 글 상세: 팀 탭 활성 + "LG 트윈스 게시판" 헤더
- [x] OG 카드 컴팩트 (가로형) + PC 가로폭 제한 (max-w-lg)
- [x] 뒤로가기 1개만 표시
- [x] 댓글/좋아요 정상
- [x] iPhone PWA 상단 여백/댓글 입력 잘림 해소
- [x] OG 제목 HTML 엔티티 정상 디코딩

### 후속 커밋 (같은 배포 사이클)
- `450efef` — 팀 게시판 헤더 fullName + OG PC 가로폭 + iPhone PWA 수정
- `428b83e` — OG 엔티티 디코딩 + UI 마감 패치 (URL 축약/터치영역/빈댓글)
- `e1d8bee` — OG 카드 렌더링 시점 HTML 엔티티 이중 디코딩

---

## Template

Release: `YYYY-MM-DD HH:mm KST`
Env: prod (`keubo.fan`)
Commit/Tag: `abcdef1` (필수)
Owner: 삼식이
Links: PR/이슈/슬랙스레드(선택)

Summary (3줄 이내)

- ...

Changes (구체)

- [Fix] ...
- [UI/UX] ...
- [Perf] ...
- [Ops] ...

User Impact / Notes

- 영향 범위(예: iOS PWA, 커뮤니티>티켓)
- 사용자가 체감하는 변화/주의사항

QA Checklist (체크된 것만)

- [ ] iOS PWA
- [ ] Mobile Safari/Chrome
- [ ] 주요 플로우 2~3개

Rollback

- 롤백 기준(증상): ...
- 롤백 커밋/방법: ...

---

## Releases

Release: `2026-03-07 19:29 KST`
Env: prod (`keubo.fan`)
Commit/Tag: `772aa02`
Owner: 삼식이
Links: (slack) https://keubofan.slack.com/archives/C0AKRDUGC2U/p1772875881024139

Summary (3줄 이내)

- 커뮤니티 > 티켓 탭 첫 진입 UX 개선(배너 슬림/필터 진입점)
- 티켓 FAB 스크롤 토글 제거(항상 고정 노출)

Changes (구체)

- [UI/UX] 티켓 안내 배너 2개 → 1개 통합 + “정가 이하 원칙” 접기/펼치기
- [UI/UX] 팀 필터 영역에 라벨 추가 + `필터` 바텀시트(구장 선택) 제공
- [Fix] 팀 칩 영역 가로 오버플로우로 화면 밀리던 현상 완화(칩 row overflow 처리)
- [UI/UX] FAB 위치 보정(하단 네비 가림 최소화) + 스크롤 hide/show 제거

User Impact / Notes

- 커뮤니티 > 티켓 탭 첫 진입에서 리스트가 더 빨리 보이고, 필터 진입이 명확해짐
- 구장 CTA로 진입 시 `/community/tickets?venue=...` URL로 필터 유지

QA Checklist (체크된 것만)

- [ ] iOS PWA
- [x] Desktop Chrome (sanity)
- [ ] Mobile Safari/Chrome
- [ ] 주요 플로우 2~3개

Rollback

- 롤백 기준(증상): 티켓 탭 첫 진입에서 필터 시트/배너 동작 오류, 레이아웃 깨짐
- 롤백 커밋/방법: `git revert 772aa02` (필요 시 직전 릴리즈로 단계적 revert)

---
