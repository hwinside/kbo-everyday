# PR3: 사진 게시판 (Photo Board)

## 목표
팀탭/선수탭에 **인스타 피드형 사진 게시판** 추가. 기존 게시판은 "일반"으로, 새로 "사진" 탭 추가.

## DB (이미 적용됨)
- `posts.content_type`: `'general'` (기존글) | `'photo'`
- 인덱스: `idx_posts_content ON posts(board_type, board_id, content_type, created_at DESC)`

## 변경 범위

### 1. 팀탭 (`src/app/(main)/community/teams/[teamId]/page.tsx`)
- 기존 토글: `[팀 게시판] / [선수 게시판]` → 변경: `[일반] / [사진]`
- "일반" 선택시: 기존 팀 게시판 로직 그대로 (board_type='team', content_type='general')
- "사진" 선택시: 사진 피드 표시 (board_type='team', content_type='photo')
- **선수 게시판 토글 완전 제거** (선수탭과 중복이므로)
- 정렬: 최신(기본) / 인기 토글 유지

### 2. 선수탭 (`src/app/(main)/community/players/page.tsx`)
- 토글 추가: `[일반] / [사진]` (기존에는 토글 없었음)
- "일반": 기존 최애선수 피드 그대로 (board_type='player', content_type='general')
- "사진": 최애선수 사진 피드 (board_type='player', content_type='photo')
- 최애선수 칩 필터 + 최신/인기 토글은 양쪽 다 유지

### 3. 사진 피드 컴포넌트 (새로 만들기)
- 파일: `src/components/community/PhotoFeed.tsx`
- **인스타 피드형** 세로 스크롤 (그리드 아님!)
- 카드 구성 (위→아래):
  1. 프로필 헤더: 닉네임 + 등급 배지 + 시간
  2. 사진 영역: 1장이면 그대로, 2~3장이면 **좌우 스와이프 캐러셀** + 인디케이터 점
  3. 액션 바: ❤️ 좋아요 + 💬 댓글수
  4. 캡션: 본문 텍스트 (있으면 표시)
- 빈 상태: "아직 사진이 없어요. 첫 번째 사진을 올려보세요!"

### 4. 사진 글쓰기 컴포넌트 (새로 만들기)
- 파일: `src/components/community/WritePhotoPost.tsx`
- **제목 필드 없음** (인스타처럼 사진+캡션만)
- 사진 선택: 최대 3장 (필수 1장 이상)
- 캡션(본문): textarea, 선택사항
- 사진 업로드 Flow:
  1. 유저가 사진 선택
  2. 클라이언트에서 리사이즈 (최대 1200px width) — `browser-image-compression` 라이브러리 사용
  3. Supabase Storage `photos` 버킷에 업로드
  4. public URL을 `image_urls`에 저장
  5. posts 테이블에 insert (board_type, board_id, content_type='photo', title='', content=캡션, image_urls)

### 5. usePosts 훅 수정 (`src/lib/supabase/usePosts.ts`)
- `createPost` 파라미터에 `contentType?: 'general' | 'photo'` 추가
- `fetchPosts`에 `contentType` 필터 추가
- `uploadImage` 함수 추가 (Storage 업로드 + public URL 반환)

### 6. 기존 코드 수정
- 기존 쿼리에 `.eq("content_type", "general")` 추가 (일반 게시판에서 사진글 안 섞이게)
- WritePost.tsx의 이미지 업로드 로직은 OFF 상태 유지 (일반 게시판은 텍스트만)

## UI 디자인 가이드
- 다크모드 기반 (#0A0A0B 배경)
- 카드 배경: bg-bg-secondary
- 사진: rounded-xl, 가로폭 100%, aspect-ratio 유지
- 캐러셀 인디케이터: 하단 중앙에 작은 점 (현재 = 흰색, 나머지 = 회색)
- 좋아요 하트: 빈 하트 ♡ → 탭 → 빨간 ❤️
- 전체적으로 기존 community 페이지 스타일과 일관성 유지

## 주의사항
- WritePost.tsx(일반 글쓰기)는 건드리지 않음
- 기존 일반 게시판 기능이 깨지면 안 됨
- Supabase Storage `photos` 버킷 RLS: 인증된 유저만 업로드, 누구나 읽기
- `browser-image-compression`이 없으면 `npm install browser-image-compression` 필요

## 참고: 기존 파일 구조
```
src/components/community/WritePost.tsx  — 일반 글쓰기 (수정하지 않음)
src/lib/supabase/usePosts.ts           — 게시글 CRUD 훅
src/app/(main)/community/teams/[teamId]/page.tsx  — 팀 커뮤니티
src/app/(main)/community/players/page.tsx          — 선수 커뮤니티
```
