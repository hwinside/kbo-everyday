# Graph Report - .  (2026-07-22)

## Corpus Check
- 828 files · ~0 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 3470 nodes · 5480 edges · 142 communities detected
- Extraction: 77% EXTRACTED · 23% INFERRED · 0% AMBIGUOUS · INFERRED: 1276 edges (avg confidence: 0.5)
- Token cost: 0 input · 0 output

## God Nodes (most connected - your core abstractions)
1. `GET()` - 121 edges
2. `POST()` - 58 edges
3. `CodingKeys` - 31 edges
4. `KboGameTileService` - 30 edges
5. `WearPushPolicyTest` - 29 edges
6. `CodingKeys` - 29 edges
7. `GameScoreWidget` - 28 edges
8. `GameNotificationPlugin` - 25 edges
9. `NewsArticleBrowserViewController` - 24 edges
10. `PlayerCardWidget` - 20 edges

## Surprising Connections (you probably didn't know these)
- `fetchData()` --calls--> `getPin()`  [INFERRED]
  src/app/admin/monitoring/page.tsx → src/app/admin/whats-new/page.tsx
- `sendDM()` --calls--> `getPin()`  [INFERRED]
  src/app/admin/tester-signups/page.tsx → src/app/admin/whats-new/page.tsx
- `remove()` --calls--> `getPin()`  [INFERRED]
  src/app/admin/venue-stories/page.tsx → src/app/admin/whats-new/page.tsx
- `GET()` --calls--> `getAccessToken()`  [INFERRED]
  src/app/auth/callback/route.ts → src/app/api/admin/analytics/route.ts
- `GET()` --calls--> `ga4Report()`  [INFERRED]
  src/app/auth/callback/route.ts → src/app/api/admin/analytics/route.ts

## Communities

### Community 0 - "Community 0"
Cohesion: 0.01
Nodes (63): getBadgeInfo(), parseDynamicBadge(), DailyAnalysisCard(), formatReferenceDate(), stripTemporal(), getGradeByPoints(), getNextGrade(), getProgressToNext() (+55 more)

### Community 1 - "Community 1"
Cohesion: 0.01
Nodes (83): getOAuthCallbackUrl(), signInWithApple(), signInWithGoogle(), signInWithKakao(), handleVisibilityChange(), loadProfile(), refreshProfile(), syncProfileToLocal() (+75 more)

### Community 2 - "Community 2"
Cohesion: 0.02
Nodes (220): canBypassVenueGeofenceForQa(), isAdminEmail(), aggregateDefense(), parseInnings(), addDaysIso(), attachThumbnails(), authorized(), blockedAuthorIds() (+212 more)

### Community 3 - "Community 3"
Cohesion: 0.01
Nodes (53): classifyIsPitcher(), findBatter(), findPitcher(), check(), publicFileExists(), decompose(), getChosung(), groupQueryToSyllables() (+45 more)

### Community 4 - "Community 4"
Cohesion: 0.02
Nodes (129): ActivityAttributes, AppEntity, AppIntentTimelineProvider, Codable, CodingKey, Decodable, EntityQuery, Hashable (+121 more)

### Community 5 - "Community 5"
Cohesion: 0.02
Nodes (63): clampOuts(), diamond(), inningLabel(), parseTeamCodes(), pushAndroidWidgetLiveUpdates(), safeInt(), scheduledStartMs(), checkAndAlert() (+55 more)

### Community 6 - "Community 6"
Cohesion: 0.02
Nodes (43): extractTableRow(), parseHitterBasic(), parsePitcherBasic(), safeInt(), fetchOnce(), isKeyboardOpen(), loop(), findRow() (+35 more)

### Community 7 - "Community 7"
Cohesion: 0.02
Nodes (35): PostLabel(), resolveLabel(), resolveThumb(), deriveBrandContext(), findPlayerByKboId(), getPostScopeLabel(), isShortText(), stripUrls() (+27 more)

### Community 8 - "Community 8"
Cohesion: 0.02
Nodes (59): buildStandingsPrompt(), buildTitlePrompt(), callGemini(), fetchBatterTitleEntries(), fetchHtml(), fetchNewsHeadlines(), fetchPitcherTitleEntries(), getKSTDate() (+51 more)

### Community 9 - "Community 9"
Cohesion: 0.02
Nodes (45): buildDiscoveryQueries(), hasLatinToken(), gatedActivations(), ok(), runFailurePropagationTests(), titleHasTeam(), decodeHtmlEntities(), extractMetaImage() (+37 more)

### Community 10 - "Community 10"
Cohesion: 0.03
Nodes (34): classifyResultMirror(), parseInningRelaysMirror(), getDuration(), isEpic(), isHomerun(), isVictory(), aggregatePitcherNames(), diffBatters() (+26 more)

### Community 11 - "Community 11"
Cohesion: 0.05
Nodes (27): cardGradient(), Color, DiamondView, DITeam, inningRun(), KBOActivityCard, KBOLockScreenCard, KBOWatchSmallCard (+19 more)

### Community 12 - "Community 12"
Cohesion: 0.04
Nodes (28): collectActivityDays(), computeCohortRetention(), computeDailyCohortRetention(), computeGamedayRetention(), computeVisitDistribution(), fetchAllPages(), isoWeek(), addKSTDays() (+20 more)

### Community 13 - "Community 13"
Cohesion: 0.04
Nodes (37): assertClean(), assertRunMode(), buildRows(), dateRange(), getTokens(), grab(), insertRows(), isoDate() (+29 more)

### Community 14 - "Community 14"
Cohesion: 0.05
Nodes (36): GameWidgetEntry, GameWidgetProvider, HomeWidgetEmptyCard, HomeWidgetScheduledCard, HomeWidgetSmallCard, KBOHomeWidget, KBOHomeWidgetEntryView, loadSnapshot() (+28 more)

### Community 15 - "Community 15"
Cohesion: 0.05
Nodes (48): AckPost, definitiveReject, retryable, success, unknownToken, Action, discard, done (+40 more)

### Community 16 - "Community 16"
Cohesion: 0.07
Nodes (36): appendAttribution(), decodeHtmlEntities(), extractInstagramHandle(), getPlatformLabel(), getThreadsHandle(), hasExistingAttribution(), resolveHandle(), decodeHtmlEntities() (+28 more)

### Community 17 - "Community 17"
Cohesion: 0.06
Nodes (11): AppReviewPlugin, CAPBridgedPlugin, CAPPlugin, LiveActivityPlugin, MetaAppEventsPlugin, NewsArticleBrowserPlugin, NewsArticleBrowserViewController, UIViewController (+3 more)

### Community 18 - "Community 18"
Cohesion: 0.07
Nodes (15): hexifyRgba(), main(), runChecks(), contrastRatio(), meetsAA(), meetsAALarge(), getSectionOrder(), normalizeOrder() (+7 more)

### Community 19 - "Community 19"
Cohesion: 0.06
Nodes (2): KboGameTileService, SpanChunk

### Community 20 - "Community 20"
Cohesion: 0.07
Nodes (1): WearPushPolicyTest

### Community 21 - "Community 21"
Cohesion: 0.13
Nodes (2): Eff, GameScoreWidget

### Community 22 - "Community 22"
Cohesion: 0.08
Nodes (2): toWeeklyTrend(), weekOf()

### Community 23 - "Community 23"
Cohesion: 0.08
Nodes (13): AnyObject, App, CAPBridgedPlugin, CAPBridgeProtocol, CAPPlugin, CAPPluginCall, CAPPluginMethod, KBOWatchApp (+5 more)

### Community 24 - "Community 24"
Cohesion: 0.14
Nodes (1): GameNotificationPlugin

### Community 25 - "Community 25"
Cohesion: 0.15
Nodes (24): build_structured_profile(), clean_text(), cut_at_sentence(), extract_evaluation_from_tmi(), extract_pitches(), fetch_html(), fetch_sub_page(), filter_lines() (+16 more)

### Community 26 - "Community 26"
Cohesion: 0.08
Nodes (2): FakeEditor, FakeSharedPreferences

### Community 27 - "Community 27"
Cohesion: 0.12
Nodes (6): parseIpToThirds(), sumBatterField(), sumInnings(), sumPitcherField(), teamAvg(), teamEra()

### Community 28 - "Community 28"
Cohesion: 0.2
Nodes (20): build_structured_profile(), clean_text(), cut_at_sentence(), dedup_intl(), extract_evaluation_from_tmi(), extract_pitches(), fetch_html(), fetch_sub_page() (+12 more)

### Community 29 - "Community 29"
Cohesion: 0.15
Nodes (9): buildNewsCommentsUrl(), handleExternalAnchorClick(), handleNewsArticleAnchorClick(), isHttpUrl(), isNativeRuntime(), openExternalUrl(), openInNewTab(), openLegacyNativeBrowser() (+1 more)

### Community 30 - "Community 30"
Cohesion: 0.14
Nodes (12): allowViewRequest(), evictIfNeeded(), shouldAllowView(), canCountImpression(), currentViewerKey(), markImpressionSeen(), impressionDedupKey(), shouldCountImpression() (+4 more)

### Community 31 - "Community 31"
Cohesion: 0.23
Nodes (1): PlayerCardWidget

### Community 32 - "Community 32"
Cohesion: 0.14
Nodes (7): checkConcurrent(), InMemoryAlertState, ageHours(), computeJobHealth(), decideAdminAlerts(), fmtAge(), isProblem()

### Community 33 - "Community 33"
Cohesion: 0.11
Nodes (1): WearTilePolicyTest

### Community 34 - "Community 34"
Cohesion: 0.15
Nodes (9): decideProbe(), magicMediaType(), parseTotalSize(), probeMediaObject(), readCapped(), pager(), row(), ok() (+1 more)

### Community 35 - "Community 35"
Cohesion: 0.11
Nodes (0):

### Community 36 - "Community 36"
Cohesion: 0.12
Nodes (2): nodeBlocksPull(), pullStartIsBlocked()

### Community 37 - "Community 37"
Cohesion: 0.12
Nodes (1): WearStore

### Community 38 - "Community 38"
Cohesion: 0.12
Nodes (1): WearStoreTest

### Community 39 - "Community 39"
Cohesion: 0.14
Nodes (2): androidUserIds(), main()

### Community 40 - "Community 40"
Cohesion: 0.12
Nodes (1): WearFetcher

### Community 41 - "Community 41"
Cohesion: 0.14
Nodes (1): WidgetUpdatePolicyTest

### Community 42 - "Community 42"
Cohesion: 0.2
Nodes (8): calcBatterSaber(), calcPitcherSaber(), estimateBatterWAR(), estimatePitcherWAR(), parseInnings(), parseOfficialRate(), main(), report()

### Community 43 - "Community 43"
Cohesion: 0.27
Nodes (12): build(), _defringe(), main(), _place_legacy(), _place_silhouette(), 컷아웃 알파에서 정수리·어깨선을 직접 검출 → 어깨선을 캔버스 하단에 앵커.     얼굴 크기가 선수 간 통일되고 비율은 원본 그대로(균등 스케, 머지 게이트: hero-approved 목록과 실제 webp 정합성 + 규격(752x944 RGBA, 비어있지 않은 알파)., Bleed nearest fully-opaque color into edge/transparent pixels (kills white halo) (+4 more)

### Community 44 - "Community 44"
Cohesion: 0.19
Nodes (6): findAppleTopFreeSegment(), rankFromAppleChartHtml(), appleChart(), appleHtml(), check(), main()

### Community 45 - "Community 45"
Cohesion: 0.17
Nodes (4): LongSpec, RankGauge, ShortSpec, WearComplicationPolicy

### Community 46 - "Community 46"
Cohesion: 0.32
Nodes (11): build_structured_profile(), fetch_html(), filter_neg(), get_players(), html_to_text(), load_json(), main(), parse_infobox() (+3 more)

### Community 47 - "Community 47"
Cohesion: 0.21
Nodes (4): findCandidates(), matchMlbparkPost(), normalizeTag(), resolveTeamFromTags()

### Community 48 - "Community 48"
Cohesion: 0.29
Nodes (1): ComposeLiveCardTest

### Community 49 - "Community 49"
Cohesion: 0.31
Nodes (1): NativeLiveEnvelopeTest

### Community 50 - "Community 50"
Cohesion: 0.18
Nodes (1): Pr723FaultMatrixTest

### Community 51 - "Community 51"
Cohesion: 0.18
Nodes (6): Decision, Drop, NoOp, PushState, Render, WearPushPolicy

### Community 52 - "Community 52"
Cohesion: 0.2
Nodes (3): AppDelegate, UIApplicationDelegate, UIResponder

### Community 53 - "Community 53"
Cohesion: 0.33
Nodes (10): build_profile(), crawl_page(), filter_negative(), get_all_players(), load_json(), main(), parse_body_sections(), parse_infobox() (+2 more)

### Community 54 - "Community 54"
Cohesion: 0.35
Nodes (10): build_profile(), fetch_html(), filter_negative(), get_all_players(), html_to_text(), load_json(), main(), parse_html() (+2 more)

### Community 55 - "Community 55"
Cohesion: 0.27
Nodes (6): articleKeyForUrl(), NewsDiscussionInputError, normalizeArticleUrl(), optionalText(), parseHttpUrl(), parseNewsDiscussionInput()

### Community 56 - "Community 56"
Cohesion: 0.2
Nodes (1): WearTeam

### Community 57 - "Community 57"
Cohesion: 0.33
Nodes (6): fetchGamesByDate(), fetchLineup(), findPrev(), main(), parseLineupRows(), shiftDate()

### Community 58 - "Community 58"
Cohesion: 0.36
Nodes (9): crawl_namuwiki(), get_all_players(), load_checkpoint(), load_enriched(), main(), parse_profile(), 텍스트에서 프로필 추출 — bio/career/tmi 모두 풍성하게, save_checkpoint() (+1 more)

### Community 59 - "Community 59"
Cohesion: 0.33
Nodes (6): fetchGamesByDate(), fetchLineup(), findPrev(), main(), parseLineupRows(), shiftDate()

### Community 60 - "Community 60"
Cohesion: 0.31
Nodes (1): MainActivity

### Community 61 - "Community 61"
Cohesion: 0.22
Nodes (2): KboComplicationServiceBase, WearComplicationUpdater

### Community 62 - "Community 62"
Cohesion: 0.22
Nodes (2): WearBases, WearSnapshot

### Community 63 - "Community 63"
Cohesion: 0.22
Nodes (1): WearComplicationPolicyTest

### Community 64 - "Community 64"
Cohesion: 0.25
Nodes (1): KboRankComplicationService

### Community 65 - "Community 65"
Cohesion: 0.48
Nodes (1): KboMessagingService

### Community 66 - "Community 66"
Cohesion: 0.38
Nodes (1): NativeLiveEnvelope

### Community 67 - "Community 67"
Cohesion: 0.29
Nodes (1): Pr723WearFaultMatrixTest

### Community 68 - "Community 68"
Cohesion: 0.43
Nodes (6): clean_section(), detect_wrong_person(), extract_basic_info(), main(), bio에서 기본 인적사항 추출 및 정리, should_skip()

### Community 69 - "Community 69"
Cohesion: 0.38
Nodes (3): fetchInning(), fetchNaverRelayBatterCounts(), tallyHitsFromRelays()

### Community 70 - "Community 70"
Cohesion: 0.53
Nodes (1): PlayerCardWidgetConfigure

### Community 71 - "Community 71"
Cohesion: 0.33
Nodes (1): WidgetUpdatePolicy

### Community 72 - "Community 72"
Cohesion: 0.33
Nodes (1): KboGameComplicationService

### Community 73 - "Community 73"
Cohesion: 0.33
Nodes (1): WearTilePolicy

### Community 74 - "Community 74"
Cohesion: 0.33
Nodes (0):

### Community 75 - "Community 75"
Cohesion: 0.6
Nodes (5): makeMockDb(), makeMockRunner(), makeMockStorage(), ok(), run()

### Community 76 - "Community 76"
Cohesion: 0.67
Nodes (5): luminance(), mix(), onDarkColor(), teamPalette(), withAlpha()

### Community 77 - "Community 77"
Cohesion: 0.53
Nodes (4): getAdminPinFromRequest(), isAdminAuthedRequest(), parseScryptHash(), verifyAdminPinValue()

### Community 78 - "Community 78"
Cohesion: 0.53
Nodes (4): b64url(), fetchIosDownloads(), isDownloadType(), makeToken()

### Community 79 - "Community 79"
Cohesion: 0.6
Nodes (4): appearsAsObject(), appearsAsSubject(), loserClaimedWin(), loserIsClaimedVictor()

### Community 80 - "Community 80"
Cohesion: 0.53
Nodes (3): detectNativeRuntime(), getInjectedCapacitor(), requestAppReview()

### Community 81 - "Community 81"
Cohesion: 0.53
Nodes (4): b64url(), decodeCsv(), fetchAndroidDownloads(), makeToken()

### Community 82 - "Community 82"
Cohesion: 0.47
Nodes (3): classifyWatchPlatform(), proxy(), recordWatchPing()

### Community 83 - "Community 83"
Cohesion: 0.4
Nodes (1): GameStateListenerService

### Community 84 - "Community 84"
Cohesion: 0.4
Nodes (0):

### Community 85 - "Community 85"
Cohesion: 0.4
Nodes (3): KBOWatchWidgetBundle, KBOWidgetBundle, WidgetBundle

### Community 86 - "Community 86"
Cohesion: 0.7
Nodes (4): detectAllTeams(), detectTeam(), main(), matchPlayersPrecision()

### Community 87 - "Community 87"
Cohesion: 0.7
Nodes (4): clean_section(), detect_wrong_person(), main(), should_skip()

### Community 88 - "Community 88"
Cohesion: 0.7
Nodes (4): clean(), crawl(), main(), parse()

### Community 89 - "Community 89"
Cohesion: 0.6
Nodes (3): hasBaseRunnerContradiction(), homerRunCount(), mentionsHomer()

### Community 90 - "Community 90"
Cohesion: 0.5
Nodes (1): NativeLiveState

### Community 91 - "Community 91"
Cohesion: 0.5
Nodes (1): OAuthBrowserPlugin

### Community 92 - "Community 92"
Cohesion: 0.5
Nodes (2): CAPBridgeViewController, MainViewController

### Community 93 - "Community 93"
Cohesion: 0.83
Nodes (3): listHitterIds(), main(), position()

### Community 94 - "Community 94"
Cohesion: 0.83
Nodes (3): fetch(), main(), roster_ids()

### Community 95 - "Community 95"
Cohesion: 0.5
Nodes (0):

### Community 96 - "Community 96"
Cohesion: 0.67
Nodes (1): LaChannelAckPolicySmoke

### Community 97 - "Community 97"
Cohesion: 0.83
Nodes (3): main(), parseMarkdown(), randomDelay()

### Community 98 - "Community 98"
Cohesion: 0.67
Nodes (2): main(), parseMd()

### Community 99 - "Community 99"
Cohesion: 0.67
Nodes (2): main(), testApi()

### Community 100 - "Community 100"
Cohesion: 0.83
Nodes (3): getInjectedCapacitor(), logNativeMetaEvent(), normalizeParameters()

### Community 101 - "Community 101"
Cohesion: 0.67
Nodes (1): ExampleInstrumentedTest

### Community 102 - "Community 102"
Cohesion: 0.67
Nodes (1): GameScoreWidgetSmall

### Community 103 - "Community 103"
Cohesion: 0.67
Nodes (1): LiveUpdateDismissReceiver

### Community 104 - "Community 104"
Cohesion: 0.67
Nodes (1): ExampleUnitTest

### Community 105 - "Community 105"
Cohesion: 0.67
Nodes (1): MyTeamListenerService

### Community 106 - "Community 106"
Cohesion: 1.0
Nodes (2): main(), searchYouTube()

### Community 107 - "Community 107"
Cohesion: 1.0
Nodes (2): findAuthUserByEmail(), main()

### Community 108 - "Community 108"
Cohesion: 1.0
Nodes (2): handleClick(), trackEvent()

### Community 109 - "Community 109"
Cohesion: 0.67
Nodes (0):

### Community 110 - "Community 110"
Cohesion: 0.67
Nodes (0):

### Community 111 - "Community 111"
Cohesion: 1.0
Nodes (2): parseDesignVersion(), resolveDesignVersion()

### Community 112 - "Community 112"
Cohesion: 0.67
Nodes (0):

### Community 113 - "Community 113"
Cohesion: 1.0
Nodes (0):

### Community 114 - "Community 114"
Cohesion: 1.0
Nodes (0):

### Community 115 - "Community 115"
Cohesion: 1.0
Nodes (0):

### Community 116 - "Community 116"
Cohesion: 1.0
Nodes (0):

### Community 117 - "Community 117"
Cohesion: 1.0
Nodes (0):

### Community 118 - "Community 118"
Cohesion: 1.0
Nodes (0):

### Community 119 - "Community 119"
Cohesion: 1.0
Nodes (0):

### Community 120 - "Community 120"
Cohesion: 1.0
Nodes (0):

### Community 121 - "Community 121"
Cohesion: 1.0
Nodes (0):

### Community 122 - "Community 122"
Cohesion: 1.0
Nodes (0):

### Community 123 - "Community 123"
Cohesion: 1.0
Nodes (0):

### Community 124 - "Community 124"
Cohesion: 1.0
Nodes (0):

### Community 125 - "Community 125"
Cohesion: 1.0
Nodes (0):

### Community 126 - "Community 126"
Cohesion: 1.0
Nodes (0):

### Community 127 - "Community 127"
Cohesion: 1.0
Nodes (0):

### Community 128 - "Community 128"
Cohesion: 1.0
Nodes (0):

### Community 129 - "Community 129"
Cohesion: 1.0
Nodes (0):

### Community 130 - "Community 130"
Cohesion: 1.0
Nodes (0):

### Community 131 - "Community 131"
Cohesion: 1.0
Nodes (0):

### Community 132 - "Community 132"
Cohesion: 1.0
Nodes (0):

### Community 133 - "Community 133"
Cohesion: 1.0
Nodes (0):

### Community 134 - "Community 134"
Cohesion: 1.0
Nodes (0):

### Community 135 - "Community 135"
Cohesion: 1.0
Nodes (0):

### Community 136 - "Community 136"
Cohesion: 1.0
Nodes (0):

### Community 137 - "Community 137"
Cohesion: 1.0
Nodes (0):

### Community 138 - "Community 138"
Cohesion: 1.0
Nodes (0):

### Community 139 - "Community 139"
Cohesion: 1.0
Nodes (0):

### Community 140 - "Community 140"
Cohesion: 1.0
Nodes (0):

### Community 141 - "Community 141"
Cohesion: 1.0
Nodes (0):

## Knowledge Gaps
- **107 isolated node(s):** `Eff`, `SpanChunk`, `ShortSpec`, `LongSpec`, `RankGauge` (+102 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **Thin community `Community 113`** (2 nodes): `photo-post-qa.spec.ts`, `ensureTestImage()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 114`** (2 nodes): `activate-urgent-notice.ts`, `main()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 115`** (2 nodes): `deactivate-urgent-notice.ts`, `main()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 116`** (2 nodes): `photos-helper-signature.ts`, `fail()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 117`** (2 nodes): `seed-channel-pool.ts`, `main()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 118`** (2 nodes): `seed-gif-collector-bot.ts`, `main()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 119`** (2 nodes): `seed-jjal-collector-bot.ts`, `main()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 120`** (2 nodes): `robots.ts`, `robots()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 121`** (2 nodes): `StadiumInfo.tsx`, `stadiumId()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 122`** (2 nodes): `StatusBadge.tsx`, `StatusBadge()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 123`** (2 nodes): `awards.ts`, `getPlayerAwards()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 124`** (2 nodes): `leaderboard-exclusions.ts`, `isInternalUser()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 125`** (1 nodes): `cordova.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 126`** (1 nodes): `cordova_plugins.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 127`** (1 nodes): `capacitor.config.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 128`** (1 nodes): `api.spec.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 129`** (1 nodes): `interaction.spec.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 130`** (1 nodes): `navigation.spec.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 131`** (1 nodes): `Package.swift`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 132`** (1 nodes): `CapApp-SPM.swift`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 133`** (1 nodes): `next-env.d.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 134`** (1 nodes): `next.config.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 135`** (1 nodes): `playwright.config.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 136`** (1 nodes): `sw.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 137`** (1 nodes): `RadioPlayer.tsx`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 138`** (1 nodes): `TeamComparisonBar.tsx`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 139`** (1 nodes): `player-profiles.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 140`** (1 nodes): `writing-points.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 141`** (1 nodes): `index.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Are the 120 inferred relationships involving `GET()` (e.g. with `verifyPin()` and `getAccessToken()`) actually correct?**
  _`GET()` has 120 INFERRED edges - model-reasoned connections that need verification._
- **Are the 57 inferred relationships involving `POST()` (e.g. with `verifyPin()` and `getClientIp()`) actually correct?**
  _`POST()` has 57 INFERRED edges - model-reasoned connections that need verification._
- **What connects `Eff`, `SpanChunk`, `ShortSpec` to the rest of the system?**
  _107 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.01 - nodes in this community are weakly interconnected._
- **Should `Community 1` be split into smaller, more focused modules?**
  _Cohesion score 0.01 - nodes in this community are weakly interconnected._
- **Should `Community 2` be split into smaller, more focused modules?**
  _Cohesion score 0.02 - nodes in this community are weakly interconnected._
- **Should `Community 3` be split into smaller, more focused modules?**
  _Cohesion score 0.01 - nodes in this community are weakly interconnected._