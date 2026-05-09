# Auto Hero Pipeline — Implementation Plan

> Status: CHECKPOINT DRAFT
> Decision: Option A — GitHub Actions + Admin Approval Flow
> Source thread: Slack #design `1776576335.566689`

## 0. Non-negotiables

1. Mac mini dependency 제거
   - 기존 `com.harinclaw.kbo-hero-resume` launchd는 disabled 상태 유지.
   - 신규 hero 생성은 GitHub Actions에서 수행한다.

2. Roster SSOT 유지
   - 신규 선수 감지 source는 `src/lib/constants/players-roster.json`.
   - Supabase `players_roster`는 core roster admission source로 쓰지 않는다.

3. 자동 생성 ≠ 자동 노출
   - Actions는 원본 JPG와 hero 후보컷만 생성한다.
   - 실제 UI 노출은 관리자 승인 후 `hero-approved-kboids.json`에 들어간 선수만 허용한다.
   - 승인 전 hero placeholder를 선수 페이지에 노출하지 않는다. 기존 일반 프로필 헤더로 fallback한다.

4. 승인 단위
   - 관리자는 원본 JPG와 hero 후보컷을 모두 확인/승인해야 한다.
   - 둘 중 하나라도 반려면 prod 반영 금지.

## 1. Target Architecture

```text
players-roster.json
  ↓
GitHub Actions auto-hero workflow
  ├─ diff: roster kboId vs existing hero assets/approved list
  ├─ source fetch: public/players/{kboId}.jpg or KBO CDN patterns
  ├─ face-detect + hero candidate generation
  ├─ pending artifact upload: source jpg + hero webp + contact sheet
  └─ pending_hero_review row insert + Slack notify
        ↓
/admin/hero-review
  ├─ source review
  ├─ hero crop review
  ├─ approve/reject/manual source upload
  └─ approved-only PR trigger
        ↓
GitHub PR
  ├─ public/players-hero-v2/webp/{kboId}.webp
  ├─ public/players-hero/{kboId}.webp
  ├─ src/lib/constants/hero-approved-kboids.json
  └─ contact sheet / QA note
        ↓
Merge + Vercel deploy + smoke QA
```

## 2. Data Model

### 2.1 Supabase table: `pending_hero_review`

Recommended columns:

- `id uuid primary key default gen_random_uuid()`
- `kbo_id text not null`
- `player_name text not null`
- `team_name text not null`
- `team_id int null`
- `source_status text not null`
  - `fetched`, `manual_required`, `uploaded`, `rejected`
- `hero_status text not null`
  - `pending`, `generated`, `approved`, `rejected`, `failed`, `pr_created`, `merged`
- `source_url text null`
- `hero_url text null`
- `contact_sheet_url text null`
- `face_confidence numeric null`
- `face_bbox jsonb null`
- `failure_reason text null`
- `reviewed_source_by uuid null`
- `reviewed_source_at timestamptz null`
- `reviewed_hero_by uuid null`
- `reviewed_hero_at timestamptz null`
- `github_pr_url text null`
- `created_at timestamptz default now()`
- `updated_at timestamptz default now()`

Recommended unique index:

```sql
create unique index pending_hero_review_kbo_id_active_idx
on pending_hero_review (kbo_id)
where hero_status not in ('merged', 'rejected');
```

### 2.2 Storage

- Bucket: `hero-pending`
- Paths:
  - `source/{kboId}.jpg`
  - `candidate/{kboId}.webp`
  - `contact-sheet/{runId}.jpg`

## 3. GitHub Actions Workflow

File: `.github/workflows/auto-hero-pipeline.yml`

Triggers:

- `schedule`: daily 09:00 KST (`0 0 * * *` UTC)
- `workflow_dispatch` with optional `kbo_id`

Steps:

1. Checkout + setup Node/Python
2. Install tools
   - `opencv-python`
   - `pillow`
   - `imagemagick`
   - `webp`
   - existing project deps if needed
3. Detect target players
   - Read `players-roster.json`
   - Exclude ids already in `hero-approved-kboids.json`
   - Exclude ids with existing active `pending_hero_review`
   - Include ids missing from `public/players-hero-v2/webp` or explicitly dispatched
4. Fetch source JPG
   - Prefer `public/players/{kboId}.jpg` if committed
   - Else try KBO CDN patterns:
     - `https://6ptotvmi5753.edge.naverncp.com/KBO_IMAGE/person/middle/{season}/{kboId}.jpg`
     - Try current season then previous seasons within configured range
   - Require HTTP 200 + image MIME + decodable image
5. Face detect gate
   - Require exactly one primary face
   - Validate bbox center/size thresholds
   - If fail: create/update pending row as `manual_required` or `failed`, no hero candidate
6. Generate candidate
   - Reuse deterministic crop/fade/webp pipeline where possible
   - Keep output candidate-only; do not add to approved list
7. Upload artifacts
   - Source JPG
   - Candidate WEBP
   - Contact sheet / preview
8. Insert/update `pending_hero_review`
9. Slack notify summary

## 4. Admin Review Flow

Route: `/admin/hero-review`

### 4.1 List View

Filters:

- 승인 필요
- 원본 없음
- 생성 실패
- 반려
- 승인 완료
- PR 생성됨

Card fields:

- 선수명 / 팀 / kboId
- source image
- hero candidate
- face confidence / bbox
- status / failure reason
- actions

### 4.2 Actions

- Approve source
- Reject source
- Upload manual source JPG
- Regenerate hero
- Approve hero
- Reject hero
- Create PR for approved items

Activation rule:

```text
source approved && hero approved → PR creation enabled
```

## 5. PR Creation Flow

Preferred: approved-only PR, not direct main push.

PR includes:

- `public/players-hero-v2/webp/{kboId}.webp`
- `public/players-hero/{kboId}.webp`
- `src/lib/constants/hero-approved-kboids.json`
- Generated contact sheet or link in PR body
- Checklist:
  - source approved
  - hero approved
  - face detect passed
  - local manifest check passed

## 6. QA Gates

Pre-PR:

- Source image exists and decodes
- Face detection result recorded
- Candidate webp exists
- Candidate file size sane
- Contact sheet generated
- Approved source + approved hero required

CI:

- `npm run typecheck` or project equivalent
- `npm run lint` or targeted lint
- `bash scripts/generate-hero-manifest.sh`
- `node scripts/validate-roster.mjs`

Post-merge smoke:

- `/community/players/{kboId}` loads
- Player page uses `PlayerHero`, not fallback
- `/players-hero/{kboId}.webp` returns 200
- Mobile viewport visual smoke for at least one approved new player

## 7. Rollback

If bad hero reaches prod:

1. Remove kboId from `hero-approved-kboids.json`
2. Keep candidate asset for debugging unless offensive/broken
3. Merge hotfix
4. Player page falls back to normal profile header

## 8. Open Implementation Choices

1. PR creation mechanism
   - GitHub App token preferred over broad PAT.
2. Face detector implementation
   - Start with OpenCV Haar/DNN parity with current pipeline.
   - Upgrade detector only after baseline pipeline is stable.
3. Manual upload storage auth
   - Admin-only signed upload or server-side upload API.
