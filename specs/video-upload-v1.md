# 사진게시판 동영상(mp4/gif) 업로드 v1

## 배경
MLBPARK 한국야구타운 기준, gif 게시물이 하루 수십 건씩 올라오며 조회수도 높다.
크보팬 사진게시판에서 동영상을 서빙 못하는 것이 큰 약점 → mp4+GIF 업로드 지원.

## 스코프 (v1)
- 게시글 작성 시 mp4 + GIF 파일 업로드 허용
- 제한: 15초 이하, 20MB 이하
- GIF 업로드 시 **클라이언트에서 mp4로 변환** 후 업로드 (ffmpeg.wasm 또는 경량 라이브러리)
  - 변환 실패 시 원본 GIF 그대로 업로드 (fallback)
- 서빙 SSOT: mp4 (GIF → mp4 변환 후 저장)
- 피드: `<video autoplay muted loop playsInline>` (GIF처럼 인라인 자동재생)
- 상세: 탭하면 소리 ON + 네이티브 컨트롤 노출
- 썸네일: 브라우저 네이티브 `<video>` 첫 프레임 (별도 생성 없음)
- Supabase Storage `videos` 버킷 사용

## v1에서 빠지는 것
- 서버사이드 트랜스코딩/해상도 변환
- 외부 URL 임베드
- 고급 모더레이션 (기존 신고 기능 활용)

## 기술 설계

### DB 변경
- `posts` 테이블에 `video_urls text[] default '{}'` 컬럼 추가
- 기존 `image_urls`는 그대로 유지 (사진+영상 혼합 게시 가능)

### Supabase Storage
- 새 버킷: `videos` (public, 20MB limit)
- 경로: `{user_id}/{timestamp}-{random}.mp4`

### 파일 변경 목록

#### 1. `src/lib/supabase/usePosts.ts`
- `Post` 인터페이스에 `video_urls?: string[]` 추가
- `uploadVideos(files: File[]): Promise<string[]>` 함수 추가 (videos 버킷)
- `createPost` params에 `videoUrls?: string[]` 추가
- select 쿼리에 `video_urls` 포함

#### 2. `src/components/community/WritePhotoPost.tsx`
- 파일 선택 시 accept에 `video/mp4,image/gif` 추가
- GIF 파일 선택 시 → 클라이언트에서 mp4 변환 시도 (실패 시 원본 업로드)
- mp4 파일: duration 체크 (15초 초과 시 에러 toast)
- 파일 크기 20MB 초과 시 에러 toast
- 미리보기: 영상은 `<video>` 태그로 표시 (자동재생, 음소거, 루프)
- 제출 시 이미지는 `uploadImages()`, 영상은 `uploadVideos()`로 분리 업로드
- Step 1 (미디어 선택) UI에 "사진 · 영상" 안내 텍스트

#### 3. `src/components/community/PhotoFeed.tsx`
- `PhotoCarousel` 컴포넌트에서 이미지/영상 구분 렌더링
- 영상: `<video autoplay muted loop playsInline>` 인라인 재생
- URL 확장자 `.mp4` 또는 video MIME으로 구분
- 썸네일은 별도 생성 없이 `<video>` 첫 프레임 활용

#### 4. `src/components/community/PostDetail.tsx`
- 이미지 갤러리에서 영상 URL 감지 → `<video controls>` 렌더
- 탭하면 소리 ON, 풀 컨트롤 노출

#### 5. `src/components/community/PostCard.tsx`
- 카드 썸네일에서 영상 감지 시 재생 아이콘 오버레이 표시

### GIF → mp4 변환 (클라이언트)
- `@nicebyte/gif-to-mp4-wasm` 또는 `gifuct-js` + canvas → MediaRecorder 패턴
- 변환 중 로딩 스피너 표시
- 변환 실패 시 → 원본 GIF 그대로 `videos` 버킷에 업로드 (GIF도 `<video>`에서 재생 가능하진 않으므로, fallback으로 `<img>` 표시)
  - 실제로는 변환 실패 시 GIF를 그대로 photos 버킷에 이미지로 업로드하는 게 더 안전
  - **결정: GIF 변환 실패 시 photos 버킷에 원본 GIF 이미지로 업로드 (기존 이미지 플로우)**

### 영상 vs 이미지 구분 로직
```ts
function isVideoUrl(url: string): boolean {
  return /\.(mp4|webm)$/i.test(new URL(url).pathname);
}
```
- `video_urls` 배열에 있으면 영상, `image_urls`에 있으면 이미지
- 렌더 시 두 배열 합쳐서 순서대로 표시 (이미지 먼저, 영상 뒤)

### 제한 체크 (클라이언트)
```ts
// Duration check
const video = document.createElement('video');
video.preload = 'metadata';
video.src = URL.createObjectURL(file);
await new Promise(r => video.onloadedmetadata = r);
if (video.duration > 15) throw new Error('15초 이하만 업로드 가능합니다');

// Size check
if (file.size > 20 * 1024 * 1024) throw new Error('20MB 이하만 업로드 가능합니다');
```

## GIF→mp4 변환 접근 (심플 버전)
서버사이드 ffmpeg 없이, 클라이언트 순수 접근:
1. **가장 심플**: GIF 변환은 v1에서 아예 안 하고, GIF를 그대로 `<img>`로 서빙 (기존 이미지 플로우). 유저가 mp4를 직접 올리면 `<video>`로 서빙.
2. **중간**: `ffmpeg.wasm` 사용 (번들 사이즈 ~25MB 문제)
3. **경량**: canvas + MediaRecorder (품질/호환성 이슈)

→ **v1 결정: 옵션 1 (GIF는 이미지로, mp4만 영상으로)**
- GIF 업로드 → 기존 photos 버킷 이미지로 저장 → `<img>` 표시 (기존과 동일)
- mp4 업로드 → videos 버킷 → `<video>` 표시
- GIF→mp4 자동 변환은 v2 (서버사이드 or ffmpeg.wasm)

이렇게 하면 v1 스코프가 **매우 얇아지면서도**, mp4 업로드+자동재생이라는 핵심 가치를 바로 제공.
GIF 유저는 기존처럼 애니 GIF `<img>` 태그로 보이고, mp4 유저는 인라인 자동재생.

## Supabase Migration SQL
```sql
-- videos 버킷 생성
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('videos', 'videos', true, 20971520)
ON CONFLICT (id) DO NOTHING;

-- videos 버킷 RLS
CREATE POLICY "Anyone can view videos" ON storage.objects
  FOR SELECT USING (bucket_id = 'videos');

CREATE POLICY "Authenticated users can upload videos" ON storage.objects
  FOR INSERT WITH CHECK (bucket_id = 'videos' AND auth.role() = 'authenticated');

CREATE POLICY "Users can delete own videos" ON storage.objects
  FOR DELETE USING (bucket_id = 'videos' AND auth.uid()::text = (storage.foldername(name))[1]);

-- posts 테이블에 video_urls 추가
ALTER TABLE posts ADD COLUMN IF NOT EXISTS video_urls text[] DEFAULT '{}';
```

## 확인 사항
- [ ] Supabase Storage 비용: 현재 유저 20명 미만이라 당분간 무시
- [ ] 모더레이션: 기존 신고 기능 활용
- [ ] 모바일 자동재생: iOS Safari는 muted+playsInline이면 자동재생 허용
