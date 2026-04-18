# Design V2 Reference — v0 Draft → Final Freeze Diff

> 수령: 2026-04-19 05:33 KST (하린아빠 슬랙 `#discussion` 최종본 도착)
> v0 draft: 2026-04-19 04:52 KST
> Freeze 리뷰 담당: 삼순이 (CSO)
> 상태: ⏳ *freeze 리뷰 대기 중*

## 🎯 TL;DR

*재작업 위험 매우 낮음* — 최종본은 v0 baseline을 그대로 유지하면서 *신규 콘텐츠만 추가*한 구조. Plan/Tasks의 [PROVISIONAL] 항목 중 *토큰·프리미티브·로고는 그대로 착수 가능*.

## 📊 파일 변경 매트릭스

| 파일 | v0 상태 | Final 상태 | 영향도 |
|---|---|---|---|
| `shared/tokens.js` | ✅ 있음 | ✅ *byte-for-byte 동일* | 🟢 없음 |
| `shared/atoms.jsx` | ✅ 있음 | ✅ *byte-for-byte 동일* | 🟢 없음 |
| `shared/shell.jsx` | ✅ 있음 | ✅ *byte-for-byte 동일* | 🟢 없음 |
| `shared/design-canvas.jsx` | ✅ 있음 | ✅ *byte-for-byte 동일* | 🟢 없음 |
| `logos/*.svg` (10팀) | ✅ 있음 | ✅ *10개 모두 동일* | 🟢 없음 |
| `screens/screens-game.jsx` | ✅ 있음 | ✅ *동일* | 🟢 없음 |
| `screens/screens-team.jsx` | ✅ 있음 | ✅ *동일* | 🟢 없음 |
| `screens/screens-community.jsx` | ✅ 있음 | ✅ *동일* | 🟢 없음 |
| `screens-extra.jsx` | ✅ 있음 | ✅ *동일* | 🟢 없음 |
| `index.html` | ✅ 있음 | ⚠️ 변경 (전체 모킹 결합) | 🟡 중 (참고용만, 구현 영향 없음) |
| `screens/screens-player.jsx` | ✅ 있음 | ⚠️ +140줄 (2 신규 함수) | 🟡 중 |
| `screens/screens-my.jsx` | ❌ 없음 | 🆕 *신규* (903줄) | 🔵 신규 |
| `screens/screens-more.jsx` | ❌ 없음 | 🆕 *신규* (539줄) | 🔵 신규 |
| `screens/modals.jsx` | ❌ 없음 | 🆕 *신규* (415줄) | 🔵 신규 |
| `flows.html` | ❌ 없음 | 🆕 *신규* (1068줄, 플로우차트) | 🔵 신규 |
| `index-print.html` | ❌ 없음 | 🆕 *신규* (5764줄, 인쇄용 레이아웃) | 🔵 없음 (문서용) |

## 🆕 신규 화면 (V2 1차 범위 체크 필요)

### `screens-my.jsx` — My 영역 대폭 확장
- `ScreenProfileEdit` (프로필 수정)
- `ScreenProfilePublic` (공개 프로필)
- `ScreenSettings` (설정)
- `ScreenFollowList` (팔로우 목록)
- `ScreenInvite` (친구 초대)
- `ScreenMessages` (DM 목록)
- `ScreenMessageChat` (1:1 채팅)

⚠️ *scope 결정 필요*: `specs/design-v2-migration.md` v0.4 스펙에는 "My 페이지 V2화" 포함이지만, *DM/친구 초대/팔로우 시스템은 신규 기능*. scope freeze 룰에 따라 *V2 1차 out of scope*.

### `screens-more.jsx` — 부가 기능 신규
- `ScreenPredictVote` (승부예측 투표)
- `ScreenHighlights` (하이라이트 영상)
- `ScreenNewsList` / `ScreenNewsDetail` (뉴스)
- `ScreenTickets` (티켓팅)
- `ScreenStadium` (구장 정보)

⚠️ *scope 결정 필요*: 승부예측·하이라이트는 V1에 이미 있음 → V2화만. *뉴스·티켓·구장은 전부 신규 기능*. V2 1차 out of scope.

### `screens/modals.jsx` — 공통 모달 패턴
- `ModalTeamPicker` (팀 선택)
- `ModalComposer` (글쓰기 sheet)
- `ModalCommentSheet` (댓글 sheet)
- `ModalContextMenu` (컨텍스트 메뉴)
- `ModalToasts` (토스트)
- `ModalUtility` (유틸리티 모달)

✅ *V2 1차 포함*: 프리미티브 레벨이라 Phase 1에 흡수 가능. *기존 컴포넌트 12종 → 18종으로 확장* 제안.

### `screens-player.jsx` +140줄
신규 2개 함수:
- `PlayerPortrait({ team, size = 180 })` — 선수 초상화 컴포넌트
- `RadarChart({ labels, player, league, color, leagueColor })` — 능력치 레이더 차트

→ 이미 Hero Phase 1 완료된 선수 페이지(V1)와 중복 가능성. *V2 1차 out of scope*.

## 🎨 토큰·헬퍼 변경

*전혀 없음*. `tokens.js`의 10팀 컬러·NEUTRAL·`teamPalette()` 모두 byte-for-byte 동일.

→ `src/design-v2/tokens.css` + `src/design-v2/team-palette.ts`는 v0 draft 기준으로 작성해도 *100% 재사용 가능*. [PROVISIONAL] 태그 해제 OK.

## 📝 권장 조치

### 즉시 [FROZEN] 승격 가능
- ✅ T1.1.1 `public/team-logos/` 10 SVG 복사
- ✅ T1.1.2 `src/design-v2/tokens.css`
- ✅ T1.1.3 `src/design-v2/team-palette.ts`
- ✅ T1.4.1~12 프리미티브 12종 (atoms.jsx 기준)
- ✅ T1.5.1b playground 전체 콘텐츠

### 프리미티브 확장 제안
- 기존 12종 → *18종* (modals.jsx 6종 추가)
  - `ModalSheet` (bottom sheet 공통)
  - `ToastStack` (토스트 매니저)
  - `ContextMenu`
  - `TeamPickerModal`
  - Composer/CommentSheet는 페이지 섹션 레벨이라 `src/components/v2/`로

### V2 1차 Scope 재확인 필요 (삼순이 판단)
최종본에 *신규 기능*이 대거 포함돼 있음. 아래 모두 *V2 1차 out of scope*로 둘지 확인:
1. ❓ DM/메시지 (`ScreenMessages`, `ScreenMessageChat`)
2. ❓ 팔로우 시스템 (`ScreenFollowList`, `ScreenInvite`)
3. ❓ 뉴스 페이지 (`ScreenNewsList`, `ScreenNewsDetail`)
4. ❓ 티켓팅 (`ScreenTickets`)
5. ❓ 구장 정보 (`ScreenStadium`)
6. ❓ 선수 Radar Chart (기존 Hero와 중복 가능성)

*삼식이 추천*: 전부 V2 1차 out of scope. *V2 GA 이후 별도 Phase로 백로그*. migration spec의 "신규 기능 추가 금지" 룰 엄수.

### Plan/Tasks 업데이트 필요 사항
- [ ] 모든 [PROVISIONAL] 태그를 [FROZEN]으로 전환
- [ ] `specs/design-v2-migration.md` §5 Out of scope에 위 6항목 명시 추가
- [ ] `specs/design-v2-migration-plan.md` §4 프리미티브 12종 → 18종 확장 반영
- [ ] `specs/design-v2-migration-tasks.md` Phase 1.4에 T1.4.13~18 추가 (modals)

## ⏭️ 다음 단계

1. 삼순이 *design-freeze 리뷰* → GO/NO-GO
2. 위 "Plan/Tasks 업데이트 필요 사항" 4건 반영 커밋
3. 하린아빠 *Phase 1 전체 착수 승인*
4. 🚀 Phase 1 첫 커밋: T1.3.1 DB 마이그레이션 + T1.1.2 tokens.css

## 📦 백업

v0 draft는 `specs/design-v2-reference.v0-backup/`에 안전 보관. 필요 시 언제든 비교 가능. (단, git에는 포함 안 함 — `.gitignore` 추가 예정)
