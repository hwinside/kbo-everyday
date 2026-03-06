# 크보팬 어드민 Growth 스펙 (P0)

작성: 삼순이(전략/마케팅)

목표: 커뮤니티 확산(클리앙/엠팍/디시/펨코 등) 활동의 성과를 **어드민에서 즉시 확인**하고, 가입/활성화 병목을 찾을 수 있게 한다.

---

## P0-1. UTM/Referrer 대시보드

### 1) 유저 스토리
- 운영자는 “어제 올린 **클리앙 글 A**가 실제로 **가입**에 기여했는지”를 본다.
- 운영자는 “유입은 많은데 가입이 낮은” 랜딩/캠페인을 찾아 문구/UX를 고친다.

### 2) 최소 지표(정의)
- Sessions(또는 Visits): 방문 세션 수
- UV: 고유 방문자 수
- Signups: 가입 완료 수
- Signup CVR: Signups / UV
- Activation(선택): 활성화 완료 수(아래 P0-2 정의)

차원(Dimensions)
- date (KST)
- utm_source, utm_medium, utm_campaign, utm_content, utm_term
- referrer_host (예: clien.net, mlbpark.donga.com)
- landing_path (예: /, /teams/LG, /posts/123)
- device_type (mobile/desktop)

### 3) 구현 옵션

**옵션 A: GA4 연동(빠름)**
- GA4 Property: `G-1H8RNYVFE9`
- 어드민에서 GA Reporting API로:
  - Acquisition(utm/referrer)
  - Landing page
  - Conversions(회원가입 이벤트) 집계
- 장점: 빠름, 수집 안정
- 단점: 유저 단위 세그먼트/자체 이벤트 확장 시 제약

**옵션 B: 자체 Referrer/UTM 로깅(확장성)**
- 첫 랜딩 시 쿼리스트링(utm_*) + document.referrer + landing_path를 서버/DB에 저장
- 로그인/가입과 연결 가능
- 장점: 퍼널/리텐션과 자연스럽게 결합
- 단점: 구현/데이터 정합성 챙겨야 함(세션/중복)

> 추천: 단기(P0)는 **옵션 B 최소 버전**으로 시작(테이블 1개) + 필요한 경우 GA4로 교차 검증.

### 4) 데이터 모델(초안)
테이블: `traffic_attribution`
- id (uuid)
- created_at (timestamptz)
- date_kst (date, 집계 편의)
- anon_id (uuid; 쿠키/로컬스토리지 기반)
- user_id (uuid, nullable; 가입/로그인 후 연결)
- session_id (uuid; 30분 비활동 시 새 세션)
- landing_path (text)
- referrer (text)
- referrer_host (text)
- utm_source (text)
- utm_medium (text)
- utm_campaign (text)
- utm_content (text)
- utm_term (text)
- device_type (text)

필수 수집 시점
- 첫 페이지 로드(landing)
- 가입 완료 시점에 anon_id → user_id 연결 업데이트

### 5) 어드민 화면(초안)
- 상단 카드: UV, Signups, Signup CVR, (Activation)
- 표: source/medium/campaign별 UV/Signups/CVR Top
- 표: referrer_host별 유입/전환 Top
- 표: landing_path별 유입/전환 Top
- 필터: 날짜, source, campaign, referrer_host, device

### 6) 수용 기준(AC)
- UTM 링크로 유입된 트래픽이 다음날 어드민에 집계되어 보인다.
- 클리앙/엠팍 등 referrer_host가 상위 목록에 노출된다.
- 특정 캠페인(utm_campaign)별 가입 전환율 비교가 가능하다.

---

## P0-2. 퍼널(이벤트 로깅 기반)

### 1) 유저 스토리
- 운영자는 “가입은 했는데 **첫 댓글/첫 글**까지 못 가는 비율”을 본다.
- 운영자는 “팀 선택/알림 허용” 같은 초기 세팅에서 이탈이 큰지 확인한다.

### 2) 이벤트 설계(최소)
테이블: `events`
- id (uuid)
- created_at (timestamptz)
- date_kst (date)
- anon_id (uuid)
- user_id (uuid, nullable)
- event_name (text)
- event_props (jsonb)

필수 이벤트(추천)
- `page_view` (props: path, referrer_host)
- `signup_completed`
- `team_selected` (props: team)
- `post_created` (props: team_board)
- `comment_created`
- `photo_uploaded` (직찍)
- `notification_opt_in` (props: platform)

### 3) 퍼널 정의(초안)
- F0: UV(= unique anon_id with page_view)
- F1: signup_completed
- F2: activation (선택, 아래 중 1개라도 만족)
  - post_created OR comment_created OR photo_uploaded

화면
- 기간 선택(일/주)
- 퍼널 단계별 사용자 수/전환율
- 활성화까지 평균 시간(가입→첫 행동)

### 4) 수용 기준(AC)
- 기간을 바꿔가며 퍼널 전환율이 계산된다.
- “활성화 정의”를 1~2개 프리셋으로 제공한다.

---

## P0-3. 배너/공지 관리(운영 레버)

### 1) 유저 스토리
- 운영자는 ‘지금은 오픈베타/피드백 모집’을 홈 상단에 띄웠다가, 필요 시 즉시 내린다.
- 운영자는 배너 클릭/전환(가입/피드백)을 본다.

### 2) 데이터 모델(초안)
테이블: `admin_banners`
- id (uuid)
- title (text)
- body (text)
- image_url (text, optional)
- link_url (text)
- placement (text: home_top / team_top / etc)
- start_at, end_at (timestamptz)
- is_active (bool)
- created_at, updated_at

이벤트
- `banner_impression` (props: banner_id, placement)
- `banner_click` (props: banner_id, placement)

### 3) 어드민 화면
- 리스트: 활성/예약/종료
- CRUD: 작성/미리보기/스케줄링
- 성과: 노출, 클릭, CTR, 클릭 후 가입 기여(가능하면)

### 4) 수용 기준(AC)
- 배너를 생성/활성화하면 프론트에 노출된다.
- 스케줄(시작/종료)이 정상 동작한다.
- 배너 CTR을 기간별로 볼 수 있다.

---

## 구현 순서 제안(개발 순서)
1) `events` / `traffic_attribution` 로깅부터(수집이 먼저)
2) P0-2 퍼널(내부 데이터만으로 빠르게 완성)
3) P0-1 어트리뷰션 대시보드(집계/차트)
4) P0-3 배너 CRUD + impression/click 로깅

---

## 결정 사항 (2026-03-06)
1) **anon_id**: 쿠키 + localStorage 하이브리드. 만료 **180일(sliding)**. **session_id는 30분 비활동 시 갱신**.
2) **signup_completed 정의**: 이메일/소셜 등 **인증 완료 시점**.
3) **Activation 정의(2트랙)**
   - Activation(라이트): `comment_created` OR `post_created`
   - Activation(코어): `post_created` OR `photo_uploaded`
4) **데이터 소스 전략**: 자체 로그(traffic_attribution/events)를 **주 데이터 소스**로 사용. GA4는 **검증/참고용**.
