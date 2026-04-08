# Graph Report - .  (2026-04-08)

## Corpus Check
- Large corpus: 1202 files · ~938,817 words. Semantic extraction will be expensive (many Claude tokens). Consider running on a subfolder, or use --no-semantic to run AST-only.

## Summary
- 806 nodes · 1270 edges · 47 communities detected
- Extraction: 82% EXTRACTED · 18% INFERRED · 0% AMBIGUOUS · INFERRED: 231 edges (avg confidence: 0.51)
- Token cost: 0 input · 0 output

## God Nodes (most connected - your core abstractions)
1. `GET()` - 35 edges
2. `크보 에브리데이 플랫폼` - 22 edges
3. `POST()` - 14 edges
4. `buildPreviewPrompt()` - 10 edges
5. `build_structured_profile()` - 9 edges
6. `build_structured_profile()` - 9 edges
7. `getTeamShortName()` - 9 edges
8. `실시간 경기 트래커` - 9 edges
9. `main()` - 8 edges
10. `커뮤니티 게시판 시스템` - 8 edges

## Surprising Connections (you probably didn't know these)
- `시드 콘텐츠 (15개 게시글)` --references--> `커뮤니티 게시판 시스템`  [INFERRED]
  scripts/seed-content/14-크보팬소개.md → specs/community/spec.md
- `삼식이 (CTO, AI Agent)` --references--> `크보 에브리데이 플랫폼`  [EXTRACTED]
  CLAUDE.md → specs/constitution.md
- `GET()` --calls--> `parseLineup()`  [INFERRED]
  src/app/api/cron/stats/route.ts → src/app/api/game-detail/route.ts
- `GET()` --calls--> `searchPlayer()`  [INFERRED]
  src/app/api/cron/stats/route.ts → src/app/api/player-teams/route.ts
- `GET()` --calls--> `fetchAllPlayerTeams()`  [INFERRED]
  src/app/api/cron/stats/route.ts → src/app/api/player-teams/route.ts

## Hyperedges (group relationships)
- **실시간 데이터 파이프라인** — data_kbo_api, feature_game_tracker, spec_text_relay, spec_phase2_live, spec_live_stats_tab, data_naver_sports [INFERRED 0.85]
- **커뮤니티 콘텐츠 시스템** — feature_community, feature_player_board, feature_game_chat, spec_photo_board, spec_meme_editor, spec_fan_editor [INFERRED 0.80]
- **수익화 스택** — biz_monetization, constitution_admob, constitution_adsense, constitution_kakao_adfit [EXTRACTED 1.00]

## Communities

### Community 0 - "Badges & Awards System"
Cohesion: 0.02
Nodes (13): getBadgeInfo(), parseDynamicBadge(), deriveGameState(), resolveRunnerName(), toDefenders(), apiFetch(), boardIdToTeamName(), buildPreseasonFallback() (+5 more)

### Community 1 - "API & Error Handling"
Cohesion: 0.05
Nodes (65): buildPreviewPrompt(), buildPrompt(), cacheKey(), classifyResult(), decodeHtmlEntities(), escapeRegex(), extractMatchup(), extractMeta() (+57 more)

### Community 2 - "UI Components & Avatars"
Cohesion: 0.04
Nodes (6): getTeamBorderColor(), getTeamBorderColorById(), getCompareBarColors(), getTeamBgColor(), hexLuminance(), hexToHue()

### Community 3 - "Platform Architecture & Specs"
Cohesion: 0.04
Nodes (62): 수익화 전략 (3단계), Fabric.js (밈 에디터), GIPHY 스티커 연동, 683명 전 선수 프로필, 모바일 퍼스트, PWA (Progressive Web App), 실시간성 (WebSocket/Realtime), Row Level Security (RLS) (+54 more)

### Community 4 - "Stats & Player Analysis"
Cohesion: 0.06
Nodes (0): 

### Community 5 - "Auth & User Profile"
Cohesion: 0.06
Nodes (10): checkAndAwardBadges(), getDynamicBadges(), getUserStats(), handleClose(), resetForm(), compressImage(), uploadImage(), getDevice() (+2 more)

### Community 6 - "Favorites & Player Traits"
Cohesion: 0.05
Nodes (2): loadCachedNews(), toHomeNewsItems()

### Community 7 - "Analytics & Auth Services"
Cohesion: 0.07
Nodes (10): daysFromKSTToday(), getKSTDateRange(), getKSTToday(), clearCookie(), clearMyTeamId(), setCookie(), setMyTeamId(), getOnboardingStatus() (+2 more)

### Community 8 - "Comments & Grading System"
Cohesion: 0.07
Nodes (9): getGradeByPoints(), getNextGrade(), getProgressToNext(), handleDoubleTap(), handleLike(), goBack(), handleClose(), handleSubmit() (+1 more)

### Community 9 - "Game Stats & Relay"
Cohesion: 0.09
Nodes (8): parseIpToThirds(), sumBatterField(), sumInnings(), sumPitcherField(), teamAvg(), teamEra(), getSystemTheme(), resolveTheme()

### Community 10 - "Player Profile Enrichment v6"
Cohesion: 0.15
Nodes (24): build_structured_profile(), clean_text(), cut_at_sentence(), extract_evaluation_from_tmi(), extract_pitches(), fetch_html(), fetch_sub_page(), filter_lines() (+16 more)

### Community 11 - "Player Profile Enrichment v7"
Cohesion: 0.2
Nodes (20): build_structured_profile(), clean_text(), cut_at_sentence(), dedup_intl(), extract_evaluation_from_tmi(), extract_pitches(), fetch_html(), fetch_sub_page() (+12 more)

### Community 12 - "Meme Editor & Stickers"
Cohesion: 0.11
Nodes (0): 

### Community 13 - "Event Generator & Text Builder"
Cohesion: 0.16
Nodes (8): aggregateBatters(), aggregatePitcherNames(), generateEvents(), makeEvent(), makeSnapshot(), nextSeq(), buildEventText(), inningLabel()

### Community 14 - "Player Profile Enrichment v5"
Cohesion: 0.32
Nodes (11): build_structured_profile(), fetch_html(), filter_neg(), get_players(), html_to_text(), load_json(), main(), parse_infobox() (+3 more)

### Community 15 - "KBO API Client"
Cohesion: 0.21
Nodes (5): bsStripHtml(), fetchBoxScore(), parseBoxScore(), parseGame(), parseGameStatus()

### Community 16 - "Player Profile Enrichment v3"
Cohesion: 0.33
Nodes (10): build_profile(), crawl_page(), filter_negative(), get_all_players(), load_json(), main(), parse_body_sections(), parse_infobox() (+2 more)

### Community 17 - "Player Profile Enrichment v4"
Cohesion: 0.35
Nodes (10): build_profile(), fetch_html(), filter_negative(), get_all_players(), html_to_text(), load_json(), main(), parse_html() (+2 more)

### Community 18 - "NamuWiki Profile Crawler"
Cohesion: 0.36
Nodes (9): crawl_namuwiki(), get_all_players(), load_checkpoint(), load_enriched(), main(), parse_profile(), 텍스트에서 프로필 추출 — bio/career/tmi 모두 풍성하게, save_checkpoint() (+1 more)

### Community 19 - "Sabermetrics & Niche Stats"
Cohesion: 0.24
Nodes (4): calcBatterSaber(), calcPitcherSaber(), estimateBatterWAR(), estimatePitcherWAR()

### Community 20 - "Profile Data Cleaning"
Cohesion: 0.43
Nodes (6): clean_section(), detect_wrong_person(), extract_basic_info(), main(), bio에서 기본 인적사항 추출 및 정리, should_skip()

### Community 21 - "Profile Cleaning v2"
Cohesion: 0.7
Nodes (4): clean_section(), detect_wrong_person(), main(), should_skip()

### Community 22 - "Retry Enrichment Pipeline"
Cohesion: 0.7
Nodes (4): clean(), crawl(), main(), parse()

### Community 23 - "Seed Posts Pipeline"
Cohesion: 0.83
Nodes (3): main(), parseMarkdown(), randomDelay()

### Community 24 - "Smoke Tests"
Cohesion: 0.67
Nodes (2): main(), testApi()

### Community 25 - "Seed Upload Pipeline"
Cohesion: 0.67
Nodes (2): main(), parseMd()

### Community 26 - "PWA Install Banner"
Cohesion: 0.67
Nodes (2): dismiss(), install()

### Community 27 - "Design System Concepts"
Cohesion: 0.5
Nodes (4): 다크 모드 기본, 글래스모피즘 디자인, 다이나믹 팀 컬러 시스템, 디자인 시스템

### Community 28 - "Skeleton Loading UI"
Cohesion: 0.67
Nodes (0): 

### Community 29 - "Fan Features (Stadium/Tickets)"
Cohesion: 1.0
Nodes (3): 구장 가이드, 티켓 양도 게시판, 팬 특화 기능 (하린엄마 제안)

### Community 30 - "Photo Post QA"
Cohesion: 1.0
Nodes (0): 

### Community 31 - "Status Badge Component"
Cohesion: 1.0
Nodes (0): 

### Community 32 - "Stadium Info Component"
Cohesion: 1.0
Nodes (0): 

### Community 33 - "Next.js Env Config"
Cohesion: 1.0
Nodes (0): 

### Community 34 - "Playwright Config"
Cohesion: 1.0
Nodes (0): 

### Community 35 - "Next.js Config"
Cohesion: 1.0
Nodes (0): 

### Community 36 - "Service Worker"
Cohesion: 1.0
Nodes (0): 

### Community 37 - "Navigation E2E Spec"
Cohesion: 1.0
Nodes (0): 

### Community 38 - "Interaction E2E Spec"
Cohesion: 1.0
Nodes (0): 

### Community 39 - "API E2E Spec"
Cohesion: 1.0
Nodes (0): 

### Community 40 - "OpenGraph Image"
Cohesion: 1.0
Nodes (0): 

### Community 41 - "Team Comparison Bar"
Cohesion: 1.0
Nodes (0): 

### Community 42 - "Radio Player"
Cohesion: 1.0
Nodes (0): 

### Community 43 - "Index Exports"
Cohesion: 1.0
Nodes (0): 

### Community 44 - "Team Rules"
Cohesion: 1.0
Nodes (1): 팀 운영 규칙

### Community 45 - "Domain (keubo.fan)"
Cohesion: 1.0
Nodes (1): keubo.fan 도메인

### Community 46 - "Baseball Tutorial"
Cohesion: 1.0
Nodes (1): 야구 튜토리얼

## Knowledge Gaps
- **37 isolated node(s):** `bio에서 기본 인적사항 추출 및 정리`, `인포박스 + 본문 → bio/career/tmi`, `텍스트에서 프로필 추출 — bio/career/tmi 모두 풍성하게`, `하위문서 크롤링 (피드백 #5: 선수명/여담, 선수명/플레이 스타일)`, `피드백 #2,10,16,14,18: 텍스트 정제 강화` (+32 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **Thin community `Photo Post QA`** (2 nodes): `photo-post-qa.spec.ts`, `ensureTestImage()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Status Badge Component`** (2 nodes): `StatusBadge.tsx`, `StatusBadge()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Stadium Info Component`** (2 nodes): `StadiumInfo.tsx`, `stadiumId()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Next.js Env Config`** (1 nodes): `next-env.d.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Playwright Config`** (1 nodes): `playwright.config.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Next.js Config`** (1 nodes): `next.config.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Service Worker`** (1 nodes): `sw.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Navigation E2E Spec`** (1 nodes): `navigation.spec.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Interaction E2E Spec`** (1 nodes): `interaction.spec.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `API E2E Spec`** (1 nodes): `api.spec.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `OpenGraph Image`** (1 nodes): `opengraph-image.tsx`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Team Comparison Bar`** (1 nodes): `TeamComparisonBar.tsx`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Radio Player`** (1 nodes): `RadioPlayer.tsx`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Index Exports`** (1 nodes): `index.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Team Rules`** (1 nodes): `팀 운영 규칙`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Domain (keubo.fan)`** (1 nodes): `keubo.fan 도메인`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Baseball Tutorial`** (1 nodes): `야구 튜토리얼`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Are the 34 inferred relationships involving `GET()` (e.g. with `parseBoxScore()` and `parseScoreBoard()`) actually correct?**
  _`GET()` has 34 INFERRED edges - model-reasoned connections that need verification._
- **Are the 13 inferred relationships involving `POST()` (e.g. with `verifyPin()` and `generateCode()`) actually correct?**
  _`POST()` has 13 INFERRED edges - model-reasoned connections that need verification._
- **Are the 9 inferred relationships involving `buildPreviewPrompt()` (e.g. with `getTeamShortName()` and `getTeamName()`) actually correct?**
  _`buildPreviewPrompt()` has 9 INFERRED edges - model-reasoned connections that need verification._
- **Are the 8 inferred relationships involving `build_structured_profile()` (e.g. with `filter_lines()` and `extract_pitches()`) actually correct?**
  _`build_structured_profile()` has 8 INFERRED edges - model-reasoned connections that need verification._
- **What connects `bio에서 기본 인적사항 추출 및 정리`, `인포박스 + 본문 → bio/career/tmi`, `텍스트에서 프로필 추출 — bio/career/tmi 모두 풍성하게` to the rest of the system?**
  _37 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Badges & Awards System` be split into smaller, more focused modules?**
  _Cohesion score 0.02 - nodes in this community are weakly interconnected._
- **Should `API & Error Handling` be split into smaller, more focused modules?**
  _Cohesion score 0.05 - nodes in this community are weakly interconnected._