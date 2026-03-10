# 밈 에디터 MVP 구현 스펙

> **컨펌:** 2026-03-10 하린아빠 승인
> **스코프:** 사진 작성폼 3스텝 리빌드 + 정적 밈 에디터 MVP

---

## 1. 현재 상태

### 기존 코드
- `src/components/community/WritePhotoPost.tsx` — 사진 3장 + 캡션 단순 폼 (184줄)
- `src/components/community/PhotoFeed.tsx` — 인스타형 세로 피드 (365줄)
- `src/lib/supabase/usePosts.ts` — CRUD 훅 (contentType: 'photo' 필터 지원)
- `browser-image-compression` 설치됨

### 미구현
- Fabric.js, 밈 에디터, 경기/선수 태깅 전부 없음

---

## 2. 구현 범위

### A. 작성폼 리빌드 — 3스텝 플로우

기존 `WritePhotoPost.tsx`를 전면 개편.

**Step 1: 미디어 선택**
- 갤러리에서 사진 선택, 최대 3장
- 기존 로직 재사용 (browser-image-compression, 1200px 리사이즈)
- 선택된 사진 가로 스크롤 미리보기 + 삭제 버튼

**Step 2: 밈 편집 (선택적, 스킵 가능)**
- "편집" 버튼 탭 → 밈 에디터 진입
- "다음" 버튼 탭 → 편집 스킵하고 Step 3으로
- 편집은 사진 1장씩 (캐러셀로 전환)
- 편집 완료 시 canvas.toBlob()으로 편집된 이미지를 원본 대체

**Step 3: 정보 입력 (한 화면)**
- 사진 미리보기 (수평 스크롤, 작은 썸네일)
- 캡션 textarea (선택사항)
- 경기 연결 (자동 추천 + 원탭)
- 선수 태그 (경기 연결 시 출전 선수 자동 표시)
- 해시태그 (자동 생성 + 직접 추가)
- "게시하기" 버튼

### B. 밈 에디터 (Fabric.js)

**라이브러리:** `fabric` (v7.x, MIT)

**텍스트 도구**
- 텍스트 추가 버튼 → 캔버스 중앙에 기본 텍스트 생성
- 스타일 프리셋:
  - "밈체" — Impact 폰트 (또는 유사 웹폰트), 흰색, 검정 테두리 (strokeWidth: 3)
  - "고딕" — Pretendard, 흰색
  - "손글씨" — 손글씨 웹폰트
- 색상 선택: 흰/검/빨/파/노 프리셋 + 커스텀
- 크기 슬라이더
- 드래그로 위치 이동, 코너 핸들로 리사이즈
- 더블탭으로 텍스트 편집 모드 진입

**스티커 도구**
- SVG/PNG 에셋을 카테고리별 그리드로 표시
- 탭하면 캔버스 중앙에 추가
- 드래그/리사이즈 가능
- 카테고리:
  - 🔥 인기: "실화?", "ㅋㅋㅋ", "ㄷㄷ", "레전드", "이게 야구다", "홈런!", "삼진!", "인정"
  - ⚾ 야구: 야구공, 배트, 글러브, 헬멧, 스코어보드 등 아이콘
  - 😂 밈 텍스트: "미쳤다", "갓", "핵", "역대급", "오지다", "꿀잼", "노잼"
  - 💬 말풍선: 둥근말풍선, 외침말풍선, 생각말풍선
- 총 20~30개 에셋 (SVG 자체 제작)

**밈 템플릿 3종**
1. "상/하단 텍스트" — 사진 상단+하단에 밈체 텍스트 자동 배치
2. "캡션바" — 사진 하단에 검정 바 + 흰색 텍스트
3. "직관인증" — 날짜/구장 텍스트가 프레임처럼 표시

**캔버스 인터랙션**
- 1손가락 드래그 = 오브젝트 이동
- 코너 핸들 드래그 = 리사이즈
- 탭 = 선택
- 더블탭 = 텍스트 편집
- 배경 탭 = 선택 해제
- (핀치줌/회전은 MVP 제외)

**내보내기**
- canvas.toBlob('image/jpeg', 0.9) → File 객체로 변환
- 편집된 이미지가 원본을 대체하여 Step 3로 전달

### C. 경기 연결 UX

**시간 기반 자동 추천**
- 현재 시간 기준 최근 24시간 이내 경기 목록 조회
- 내 팀(프로필 team_id) 경기 최상단
- 카드 UI로 원탭 선택
- "연결 안 함" 옵션

**데이터 소스**
- `games` 테이블 또는 static JSON에서 오늘/어제 경기 조회
- 표시: 팀명 vs 팀명 · 날짜 · 구장

### D. 선수 태그

**경기 연결 시**
- 해당 경기 양팀 주요 선수 목록 자동 표시
- 칩 UI로 원탭 태그 (토글)

**경기 미연결 시**
- 검색 입력 → 선수 검색
- 또는 내 최애선수 기반 추천

### E. 해시태그 자동 생성

**자동 추천 규칙:**
| 조건 | 태그 |
|------|------|
| 경기 연결됨 | #팀명 #상대팀명 |
| 선수 태그됨 | #선수명 |
| 사진 게시판 | #직관 |

- 자동 추천 태그: 탭하여 추가/제거
- 직접 입력도 가능

---

## 3. DB 변경

```sql
-- posts 테이블에 컬럼 추가
ALTER TABLE posts ADD COLUMN IF NOT EXISTS game_id TEXT;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS player_tags JSONB DEFAULT '[]';
ALTER TABLE posts ADD COLUMN IF NOT EXISTS hashtags JSONB DEFAULT '[]';

-- 인덱스
CREATE INDEX IF NOT EXISTS idx_posts_game ON posts(game_id) WHERE game_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_posts_hashtags ON posts USING GIN(hashtags) WHERE hashtags != '[]'::jsonb;
```

---

## 4. 파일 구조

```
src/components/editor/
├── MemeEditor.tsx          # 메인 에디터 (Fabric.js Canvas)
├── TextTool.tsx            # 텍스트 추가/스타일 패널
├── StickerTool.tsx         # 스티커 선택 패널
├── TemplateTool.tsx        # 밈 템플릿 선택
├── EditorToolbar.tsx       # 하단 도구 탭바
└── useCanvas.ts            # Fabric.js 초기화/관리 훅

src/components/community/
├── WritePhotoPost.tsx      # 전면 개편 (3스텝)
├── GamePicker.tsx          # 경기 연결 컴포넌트
├── PlayerTagger.tsx        # 선수 태그 컴포넌트
└── HashtagInput.tsx        # 해시태그 입력 컴포넌트

public/assets/stickers/
├── meme-text/              # 밈 텍스트 SVG
├── baseball/               # 야구 아이콘 SVG
└── balloons/               # 말풍선 SVG
```

---

## 5. 기술 스택

- **Fabric.js 7.x** (MIT) — `npm install fabric`
- **browser-image-compression** (기존 설치됨)
- **Supabase Storage** `photos` 버킷 (기존)
- **SVG 에셋** 자체 제작

---

## 6. UI 디자인 가이드

- 다크모드 (#0A0A0B 배경)
- 에디터 배경: bg-bg-primary
- 도구바: bg-bg-secondary, 하단 고정
- 스티커/텍스트 선택 패널: 하단 시트 (바텀 반)
- 버튼 스타일: 기존 community 컴포넌트와 일관성 유지
- 3스텝 진행 표시: 상단에 스텝 인디케이터 (● ○ ○)

---

## 7. 제외 범위 (명시적)

- ❌ GIF 생성/편집
- ❌ AI 밈 텍스트 추천
- ❌ GPS 기반 경기 자동 감지
- ❌ 사진 위 위치 핀 선수 태깅
- ❌ 핀치줌/회전 제스처
- ❌ 필터 (팀 컬러 등)
- ❌ 사진 10장 확장
- ❌ 커뮤니티 스티커 업로드
- ❌ 편집 히스토리 (Undo/Redo)

---

## 8. 구현 순서

1. `npm install fabric` + MemeEditor 기본 셸 (캔버스 렌더링)
2. 텍스트 도구 (추가/편집/스타일/밈체)
3. SVG 스티커 에셋 제작 + 스티커 도구
4. 밈 템플릿 3종
5. WritePhotoPost 3스텝 리빌드 (Step 1 미디어 → Step 2 에디터 → Step 3 정보)
6. GamePicker (경기 연결)
7. PlayerTagger + HashtagInput
8. DB 마이그레이션 (game_id, player_tags, hashtags)
9. usePosts 훅 수정 (새 필드 저장)
10. 통합 테스트
