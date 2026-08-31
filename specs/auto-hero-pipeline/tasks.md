# Auto Hero Pipeline — Tasks

> Status: CHECKPOINT DRAFT
> Owner split: 삼식이 implementation, 삼순이 review/QA/GO-NO-GO

## Phase 0 — Safety / Current State

- [x] Disable Mac mini launchd `com.harinclaw.kbo-hero-resume`
- [x] Keep plist/scripts/logs for manual recovery
- [ ] Confirm production hero serving remains static-file based and unaffected

## Phase 1 — Detector + Source Fetch

- [ ] Add script: `scripts/hero/detect-missing-hero.mjs`
  - Input: `players-roster.json`, `hero-approved-kboids.json`, `public/players-hero-v2/webp`
  - Output: missing/unapproved candidates JSON
- [ ] Add script: `scripts/hero/fetch-source-photo.mjs`
  - Prefer committed `public/players/{kboId}.jpg`
  - Try KBO CDN season patterns
  - Validate HTTP 200, MIME, decodable image
  - Output source JPG path or `NO_SRC_JPG`
- [ ] Add no-source queue handling
  - Insert/update pending review row with `source_status=manual_required`
  - Slack summary includes `NO SRC JPG` ids

## Phase 2 — Face Detect + Candidate Generation

- [ ] Extract current face-detect/crop logic into Actions-safe script
- [ ] Generate candidate WEBP into temp artifact path
- [ ] Record face bbox/confidence
- [ ] Fail closed on:
  - no face
  - multiple faces
  - too small/large bbox
  - crop outside safe bounds
  - image decode failure
- [ ] Generate contact sheet for all candidates in the run

## Phase 3 — GitHub Actions Workflow

- [ ] Add `.github/workflows/auto-hero-pipeline.yml`
- [ ] Support scheduled run + `workflow_dispatch`
- [ ] Install required Python/system deps
- [ ] Run detector/source fetch/generator
- [ ] Upload artifacts to Supabase Storage or GitHub artifact
- [ ] Insert/update pending review rows
- [ ] Send Slack summary
- [ ] Dry-run mode for first rehearsal

## Phase 4 — Supabase Schema / Storage

- [ ] Migration: `pending_hero_review` table
- [ ] Unique active kboId index
- [ ] RLS/admin policy
- [ ] Storage bucket `hero-pending`
- [ ] Signed URL/read policy for admin page

## Phase 5 — Admin UI

- [ ] Add `/admin/hero-review`
- [ ] List pending/rejected/no-source/approved items
- [ ] Show source JPG and hero candidate side-by-side
- [ ] Add approve/reject source
- [ ] Add approve/reject hero
- [ ] Add manual source JPG upload
- [ ] Add regenerate action
- [ ] Add approved-only PR trigger

## Phase 6 — PR Creation

- [ ] Implement server-side GitHub PR creation endpoint or GitHub App flow
- [ ] Approved items only
- [ ] Modify:
  - `public/players-hero-v2/webp/{kboId}.webp`
  - `public/players-hero/{kboId}.webp`
  - `src/lib/constants/hero-approved-kboids.json`
- [ ] PR body includes contact sheet/preview links and approval metadata
- [ ] Do not push directly to main

## Phase 7 — Validation / QA

- [ ] Unit test detector with known approved/missing ids
- [ ] Fixture test `NO SRC JPG`
- [ ] Fixture test face-detect fail closed
- [ ] Rehearsal with one known existing player in dry-run mode
- [ ] Admin UI smoke: approve/reject/upload/regenerate
- [ ] PR creation smoke on test branch
- [ ] Production smoke after merge

## GO / NO-GO Criteria

GO if:

- Mac mini is not required
- Missing hero detection uses `players-roster.json`
- NO SRC JPG does not create visible bad hero
- Admin approval is required before UI exposure
- Approved PR changes are minimal and inspectable
- Rollback is one-line allowlist removal

NO-GO if:

- Any unapproved candidate can appear on production player page
- Supabase becomes roster admission SSOT
- GitHub Actions pushes directly to main without approval
- Face-detect failure still generates a visible hero
- Admin cannot inspect original source and generated hero together
