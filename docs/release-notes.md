# Release Notes (append-only)

> Rule: 1 deploy = 1 entry (append-only)

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


