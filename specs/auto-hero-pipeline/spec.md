# Auto Hero Pipeline — 자동 hero 생성 파이프라인

> 작성: 2026-05-08 / 작성자: 삼식이 / 상태: **APPROVED — 결정 완료, plan 작성 단계**
> 출발 스레드: Slack `#design` `1776576335.566689`

## 1. 배경 / Why

현재 hero(선수 cutout) 생성 파이프라인:

- 프로덕션 서빙: webp 자산이 git repo (`public/players-hero-v2/webp/*.webp`) 에 커밋되어 있어 *Vercel 빌드만으로 정적 서빙* — 맥미니 의존성 0
- 자산 생성: 기존 **맥미니 launchd**는 현재 비활성(`launchctl disable + bootout`, plist/스크립트 보존). 신규 생성은 GitHub Actions로 이전 → `phase2-pipeline.sh` 계열 successor 실행 (Nano Banana Pro 2K → remove.bg HD → OpenCV face-detect → cwebp)
- 입력: `scripts/cutouts-v2/phase2-todo.json` 정적 파일 — 신규 선수 자동 감지 메커니즘 없음
- 2026-05-08 09:05 시점 769/769 완료 → 일일 잡 효용 종료
- 핵심 제약: face-detect crop이 OpenCV Haar Cascade(Python) 의존 → Vercel 서버리스 불가

## 2. 목표 / What

**신규 선수 등록 시 hero 이미지가 맥미니 의존성 없이 자동 생성 → 어드민 승인 → prod까지 반영**되는 파이프라인 구축.

성공 기준:
- 새 선수가 `players-roster.json` PR로 머지된 후 *48시간 이내* (감지 24h + 어드민 승인 24h) prod에 hero 서빙
- 맥미니가 꺼져 있어도 정상 동작
- 품질 검증: 어드민 *원본 ↔ hero* 비교 후 승인 통과한 자산만 prod 반영

## 3. 결정 사항 (확정)

### 3.1 호스팅: GitHub Actions (Option A)
- Runner: `ubuntu-latest`, Python + opencv-python + imagemagick + cwebp + jq
- Schedule: `cron: '0 0 * * *'` (매일 09:00 KST = 00:00 UTC) + `workflow_dispatch`
- Secrets: `GEMINI_API_KEY`, `REMOVE_BG_API_KEY`, `SUPABASE_SERVICE_ROLE`, `GH_PUSH_TOKEN`

### 3.2 로스터 SSOT: `players-roster.json`
- Phase 1.5 Fortress 정책 (2026-04-20 시행) 준수
- 갱신은 static JSON PR로만 — 본 파이프라인은 *읽기 전용*
- 신규 감지 로직: `players-roster.json`의 kboId 목록 vs `public/players-hero-v2/webp/` 디렉토리 diff
- *Supabase write 없음* — Fortress 폐기 사유와 충돌하지 않게

### 3.3 push 모델: 어드민 승인 큐 (★ 핵심 차별점)
- 자동 push 금지. 신규 hero는 **승인 대기열**로 들어가고, 어드민이 *원본 ↔ hero* 시각 검증 후 승인할 때만 prod 반영
- 워크플로우 자체에서 push하지 않고, 어드민이 트리거 → GitHub API or Supabase Edge Function이 commit/push 실행

### 3.4 원본 사진 자동 수급
- KBO 네이버 CDN 자동 다운로드: `https://6ptotvmi5753.edge.naverncp.com/KBO_IMAGE/person/middle/2026/{kboId}.jpg`
- 현재 `/api/cron/photos`가 HEAD 체크만 하는 걸 *다운로드까지* 확장
- 미수급 시 (외국인 / CDN 갱신 지연 / 한국 선수 누락):
  1. 앱 실제 선수 페이지는 기존 일반 프로필 헤더로 fallback 유지 (*placeholder hero 실제 노출 금지*)
  2. 어드민 큐에는 placeholder/status 카드로 *"원본 사진 수급 필요"* 표시 + 수동 jpg 업로드 UI 제공
  3. 어드민이 jpg 업로드 시 → 자동 hero 재생성 → 다시 승인 큐로

## 4. 컴포넌트 구조

### 4.1 GitHub Actions 워크플로우
- `.github/workflows/auto-hero-pipeline.yml`
- 단계: setup → roster diff → photo fetch → hero generate (face-detect 포함) → asset upload to Supabase Storage → pending_hero_review row insert → Slack 알림

### 4.2 Supabase
- 테이블 `pending_hero_review`:
  ```
  id (uuid), kboId (text), playerName (text), teamName (text),
  src_jpg_url (text), generated_webp_url (text),
  status (text: 'pending' | 'approved' | 'rejected' | 'no_src'),
  generated_at (timestamptz), reviewed_by (uuid?), reviewed_at (timestamptz?),
  notes (text?)
  ```
- Storage bucket: `hero-pending/` (승인 전 임시 저장)

### 4.3 어드민 페이지
- `/admin/hero-review` — 승인 대기 리스트, 원본↔hero 나란히 보기, 승인/거절 버튼, 수동 jpg 업로드(NO SRC JPG 케이스)
- 승인 시 → `/api/admin/hero-approve` → Supabase Storage에서 webp 다운로드 → git commit → push (또는 PR open)

### 4.4 알림
- Slack `#design` 스레드: 신규 감지 N건, 승인 대기 N건, 부분 실패 등
- 미수급 시 별도 메시지 ("원본 사진 수급 필요" + 어드민 링크)

## 5. 비범위 / Out of Scope

- 외국인 선수 사진 자동 수급 (별도 트랙)
- 기존 769명 hero 재생성 (필요 시 수동 트리거 유지)
- face-detect 알고리즘 자체 개선 (Haar → DNN 등은 별건)

## 6. 위험 / Risks

| Risk | Mitigation |
|---|---|
| GH Actions에서 push 권한 노출 | 어드민 승인 큐 모델로 자동 push 제거 → 사람 게이트 |
| KBO CDN 갱신 지연으로 `NO SRC JPG` 잔존 | 앱은 일반 프로필 fallback, 어드민 알림 + 매일 재시도 |
| API 키(Gemini/remove.bg) 비용 폭증 | rate limit + 신규만 처리 (전체 재생성 X) |
| `players-roster.json` 직접 변경 충돌 | 본 파이프라인은 읽기 전용, write 금지 |
| Supabase Storage cost | webp 한 장 ~50KB, 대기 큐 평소 0~5건이라 무시 가능 |

## 7. 다음 단계

- `plan.md` — 구현 순서, 파일 구조, 의존성 (작성 진행)
- `tasks.md` — 작업 단위 분해, 예상 소요
- ⏸️ CHECKPOINT — 하린아빠 리뷰
- 구현 / 검증

## 8. 참고

- 비활성된 launchd: `~/Library/LaunchAgents/com.harinclaw.kbo-hero-resume.plist` (`launchctl print-disabled`에 disabled 등록)
- 기존 파이프라인: `scripts/cutouts-v2/{phase2-pipeline.sh, resume-missing.sh, copy-to-hero.sh}`
- 폐기된 roster cron: `src/app/api/cron/roster/route.ts` (410 Gone, 2026-04-20)
- 현 photo 체크 cron: `src/app/api/cron/photos/route.ts` (HEAD only, 매주 일 21시)
- Roster Fortress 정책: `specs/roster-ssot-fortress.md`
