# Admin Dashboard 스펙

## 개요
크보 에브리데이 운영자용 관리 대시보드. 서비스 전반의 트래픽, 유저, 콘텐츠, 시스템 상태를 한눈에 모니터링하고, 크롤러/배치 작업 관리 및 CS 처리가 가능한 올인원 어드민.

## 기술 스택
- Next.js 페이지 (`/admin/*`), 별도 레이아웃 (TabBar 없음)
- `recharts` for 차트/시각화
- Supabase 직접 쿼리 (기존 테이블 + 신규 어드민 테이블)
- 다크 테마 유지 (앱과 동일한 #0A0A0B 베이스)
- PIN 인증 (환경변수 `ADMIN_PIN`)

## 접근 방식
- `/admin` → PIN 입력 화면 → 인증 후 대시보드
- 사이드바 네비게이션 (모바일은 햄버거 메뉴)
- 반응형 (데스크탑 최적화, 모바일 사용 가능)

## 탭 구성

### 1. Overview (홈)
- **KPI 카드** (오늘/7일/30일 토글): UV, PV, 가입자, 게시글, 댓글, 직찍
- **일별 트래픽 추이** — UV/PV 라인 차트 (30일)
- **인기 페이지 Top 10** — 바 차트
- **🚨 이상 감지 배너** — 최근 anomaly 알림 표시

### 2. Users (유저)
- **가입자 vs UV 추이** — 듀얼 라인 차트 (30일)
- **DAU / WAU / MAU** — 3개 라인 차트
- **팀별 분포** — 파이/도넛 차트
- **레벨 분포** — 바 차트
- **최근 가입자 리스트** — 테이블 (최근 50명)
- **코호트 리텐션 히트맵** — X: D0~D30, Y: 가입 주차별 (최근 8주)
- **코호트별 활동량** — 가입 주차별 게시글/댓글/예측 참여 수

### 3. Content (콘텐츠)
- **게시글/댓글 일별 추이** — 스택 바 차트
- **팀별 게시판 활성도** — 히트맵
- **직찍 업로드 추이**
- **인기 게시글 Top 10** — 테이블

### 4. Jobs (크롤러/배치)
- **작업 목록 카드** — 각 크롤러/배치잡 상태, 마지막 실행, 소요시간, 주기
- **실행 히스토리** — 테이블 (최근 100건, 필터: 작업명/상태)
- **수동 트리거 버튼**
- **에러 로그 뷰어**

### 5. Feedback (CS/건의함)
- **상태별 카운트 카드** — 접수/검토중/완료/반려
- **분류별 필터** — 버그/데이터수정/기능제안/콘텐츠/기타
- **인입 추이 차트** — 일별 (분류별 색상)
- **건별 상세** + 상태 변경 + 관리자 메모

### 6. System (시스템)
- **API 호출량** — Naver/YouTube/KBO
- **성능 모니터링** — Web Vitals (LCP/FID/CLS), API 응답시간 P50/P95/P99, 에러율
- **Supabase 사용량**
- **배포 히스토리**

## Supabase 신규 테이블

```sql
CREATE TABLE admin_page_views (
  id bigint generated always as identity primary key,
  visitor_id text NOT NULL,
  path text NOT NULL,
  referrer text,
  user_agent text,
  device text,
  user_id uuid REFERENCES auth.users(id),
  created_at timestamptz DEFAULT now()
);
CREATE INDEX idx_apv_created ON admin_page_views(created_at);
CREATE INDEX idx_apv_visitor ON admin_page_views(visitor_id);

CREATE TABLE admin_daily_stats (
  date date PRIMARY KEY,
  uv integer DEFAULT 0,
  pv integer DEFAULT 0,
  new_users integer DEFAULT 0,
  posts integer DEFAULT 0,
  comments integer DEFAULT 0,
  photos integer DEFAULT 0,
  predictions integer DEFAULT 0
);

CREATE TABLE admin_job_logs (
  id bigint generated always as identity primary key,
  job_name text NOT NULL,
  status text NOT NULL DEFAULT 'running',
  started_at timestamptz DEFAULT now(),
  finished_at timestamptz,
  duration_ms integer,
  result_summary text,
  error_message text
);
CREATE INDEX idx_ajl_job ON admin_job_logs(job_name, started_at DESC);

CREATE TABLE admin_anomaly_logs (
  id bigint generated always as identity primary key,
  type text NOT NULL,
  severity text NOT NULL DEFAULT 'warning',
  message text NOT NULL,
  details jsonb,
  acknowledged boolean DEFAULT false,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX idx_aal_created ON admin_anomaly_logs(created_at DESC);

CREATE TABLE admin_perf_metrics (
  id bigint generated always as identity primary key,
  path text NOT NULL,
  metric_name text NOT NULL,
  value float NOT NULL,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX idx_apm_created ON admin_perf_metrics(created_at);
```

## 클라이언트 트래킹
`src/lib/admin/tracker.ts`:
- 페이지 진입 시 admin_page_views INSERT
- visitor_id: localStorage UUID
- Web Vitals → admin_perf_metrics
- 로그인 유저는 user_id도 기록

## 이상 감지
트리거 조건: 트래픽 ±50%, API 에러율 10%+, P95>3초, 크롤러 3회 연속 실패

## PIN 인증
환경변수 ADMIN_PIN → sessionStorage 저장 → 모든 어드민 API 검증

## 파일 구조
```
src/app/admin/
  layout.tsx, page.tsx, users/page.tsx, content/page.tsx,
  jobs/page.tsx, feedback/page.tsx, system/page.tsx
src/lib/admin/
  tracker.ts, anomaly.ts
src/app/api/admin/
  stats/route.ts, jobs/route.ts, anomaly-check/route.ts
```

## 디자인
- #0A0A0B 배경, glass-card, accent 컬러
- KPI: 큰 숫자 + 전일 대비 ▲▼
- 코호트: 녹색 그라데이션 히트맵
- 이상 감지: 🚨 빨간색 배너
- "유려한 시각화" — 깔끔하고 정보 밀도 높게
