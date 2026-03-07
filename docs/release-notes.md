# Release Notes (append-only)

> Rule: 1 deploy = 1 entry (append-only)

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


