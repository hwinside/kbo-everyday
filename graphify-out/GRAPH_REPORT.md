# Graph Report - .  (2026-08-02)

## Corpus Check
- 1162 files · ~0 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 5333 nodes · 8611 edges · 186 communities detected
- Extraction: 75% EXTRACTED · 25% INFERRED · 0% AMBIGUOUS · INFERRED: 2162 edges (avg confidence: 0.5)
- Token cost: 0 input · 0 output

## God Nodes (most connected - your core abstractions)
1. `GET()` - 160 edges
2. `POST()` - 66 edges
3. `CodingKeys` - 31 edges
4. `KboGameTileService` - 30 edges
5. `WearPushPolicyTest` - 29 edges
6. `CodingKeys` - 29 edges
7. `GameScoreWidget` - 28 edges
8. `GameNotificationPlugin` - 27 edges
9. `NewsArticleBrowserViewController` - 27 edges
10. `VenueMediaLibraryPlugin` - 24 edges

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
Nodes (92): getCroppedBlob(), handleCropConfirm(), getBadgeInfo(), parseDynamicBadge(), DailyAnalysisCard(), formatReferenceDate(), stripTemporal(), addKSTDays() (+84 more)

### Community 1 - "Community 1"
Cohesion: 0.01
Nodes (317): aggregateDefense(), parseInnings(), check(), main(), check(), main(), addDaysIso(), applyRunnerStats() (+309 more)

### Community 2 - "Community 2"
Cohesion: 0.01
Nodes (91): handleVisibilityChange(), loadProfile(), refreshProfile(), syncProfileToLocal(), syncSession(), isGifComment(), isImageComment(), isOwnPhotoComment() (+83 more)

### Community 3 - "Community 3"
Cohesion: 0.01
Nodes (118): clampOuts(), diamond(), inningLabel(), parseTeamCodes(), pushAndroidWidgetLiveUpdates(), safeInt(), scheduledStartMs(), shouldSkipWidgetPush() (+110 more)

### Community 4 - "Community 4"
Cohesion: 0.01
Nodes (165): ActivityAttributes, AppEntity, AppIntentTimelineProvider, Codable, CodingKey, Decodable, EntityQuery, Hashable (+157 more)

### Community 5 - "Community 5"
Cohesion: 0.02
Nodes (113): inject(), legacyRawFetchTodayGames(), main(), computeStandings(), main(), nextDayYmd(), buildGameIngestion(), canonicalPayloadHash() (+105 more)

### Community 6 - "Community 6"
Cohesion: 0.02
Nodes (57): extractTableRow(), parseHitterBasic(), parsePitcherBasic(), safeInt(), check(), installFetch(), main(), sleep() (+49 more)

### Community 7 - "Community 7"
Cohesion: 0.02
Nodes (71): coversAllKboTeams(), fetchTeamRecordsForDisplay(), hasCanonicalTeamIdentity(), isFiniteNumber(), isFiniteNumericString(), isRecordsData(), isTeamBatting(), isTeamPitching() (+63 more)

### Community 8 - "Community 8"
Cohesion: 0.02
Nodes (40): classifyIsPitcher(), findBatter(), findPitcher(), check(), publicFileExists(), decompose(), getChosung(), groupQueryToSyllables() (+32 more)

### Community 9 - "Community 9"
Cohesion: 0.02
Nodes (50): cardGradient(), Color, DiamondView, DITeam, Image, inningRun(), KBOActivityCard, KBOLockScreenCard (+42 more)

### Community 10 - "Community 10"
Cohesion: 0.02
Nodes (69): hexifyRgba(), main(), runChecks(), contrastRatio(), meetsAA(), meetsAALarge(), cancelBody(), decideProbe() (+61 more)

### Community 11 - "Community 11"
Cohesion: 0.02
Nodes (52): buildDiscoveryQueries(), hasLatinToken(), gatedActivations(), ok(), runFailurePropagationTests(), titleHasTeam(), abortAwareHang(), main() (+44 more)

### Community 12 - "Community 12"
Cohesion: 0.02
Nodes (56): boxScore(), cells(), json(), main(), scenario(), scoreboard(), main(), routeFailureMatrix() (+48 more)

### Community 13 - "Community 13"
Cohesion: 0.03
Nodes (15): AppIntent, isFollowupPhrase(), normalizeFollowup(), ExampleInstrumentedTest, GameNotificationPlugin, GameScoreWidgetSmall, LiveUpdateDismissReceiver, NativeLiveState (+7 more)

### Community 14 - "Community 14"
Cohesion: 0.03
Nodes (40): classifyResultMirror(), parseInningRelaysMirror(), aggregatePitcherNames(), diffBatters(), generateEvents(), inningKey(), makeEvent(), makeSnapshot() (+32 more)

### Community 15 - "Community 15"
Cohesion: 0.03
Nodes (32): main(), read(), buildNewsCommentsUrl(), getInjectedCapacitor(), handleExternalAnchorClick(), handleNewsArticleAnchorClick(), isHttpUrl(), isNativeRuntime() (+24 more)

### Community 16 - "Community 16"
Cohesion: 0.05
Nodes (58): ctxDeps(), eligibleTurn(), freshCtx(), main(), previousTurn(), seedTurn(), setupContextDb(), verifyAcPipeline() (+50 more)

### Community 17 - "Community 17"
Cohesion: 0.03
Nodes (18): check(), deferred(), main(), parseIpToThirds(), sumBatterField(), sumInnings(), sumPitcherField(), teamAvg() (+10 more)

### Community 18 - "Community 18"
Cohesion: 0.04
Nodes (11): AppReviewPlugin, CAPBridgedPlugin, CAPPlugin, LiveActivityPlugin, MetaAppEventsPlugin, NewsArticleBrowserPlugin, NewsArticleBrowserViewController, UIViewController (+3 more)

### Community 19 - "Community 19"
Cohesion: 0.06
Nodes (58): buildA1(), buildB(), buildC1(), buildC2(), buildC4(), buildC5(), buildC6(), buildCContext() (+50 more)

### Community 20 - "Community 20"
Cohesion: 0.04
Nodes (20): canBypassVenueGeofenceForQa(), isAdminEmail(), evaluateCommentAbuse(), evaluateCommentRate(), computeScrollLockStyle(), lockRootScroll(), iso(), row() (+12 more)

### Community 21 - "Community 21"
Cohesion: 0.05
Nodes (38): ackConfirmationPage(), alertContext(), alertFingerprint(), AlertIngressCoordinator, alertLinks(), alertSeverity(), alertSourceStartedAt(), alertSummary() (+30 more)

### Community 22 - "Community 22"
Cohesion: 0.03
Nodes (54): AckPost, definitiveReject, retryable, success, unknownToken, Action, discard, done (+46 more)

### Community 23 - "Community 23"
Cohesion: 0.04
Nodes (24): AnyObject, App, getUserFacingAuthError(), getUserFacingAuthErrorFromUrl(), getOAuthCallbackUrl(), signInWithApple(), signInWithGoogle(), signInWithKakao() (+16 more)

### Community 24 - "Community 24"
Cohesion: 0.05
Nodes (24): buildStandingsPrompt(), callGemini(), fetchBatterTitleEntries(), fetchHtml(), fetchNewsHeadlines(), fetchPitcherTitleEntries(), getKSTDate(), isoAddDays() (+16 more)

### Community 25 - "Community 25"
Cohesion: 0.06
Nodes (37): appendAttribution(), decodeHtmlEntities(), extractInstagramHandle(), getPlatformLabel(), getThreadsHandle(), hasExistingAttribution(), resolveHandle(), decodeHtmlEntities() (+29 more)

### Community 26 - "Community 26"
Cohesion: 0.06
Nodes (28): checkAndAlert(), deliverAndSettle(), drainApiFallbackAlerts(), firstRow(), saveToSupabase(), sendDegradationTelegramAlert(), sendTelegramAlert(), settleAttempt() (+20 more)

### Community 27 - "Community 27"
Cohesion: 0.07
Nodes (27): budget(), hardTimeoutNaverReserve(), naverConfirmFallback(), ok(), run(), sessionStallMustNotSkipLineupSignal(), deliverLineupBatch(), deliverLineupConfirm() (+19 more)

### Community 28 - "Community 28"
Cohesion: 0.07
Nodes (17): getDuration(), isEpic(), isHomerun(), isVictory(), isChunkLoadError(), maybeReloadForChunkError(), dwellPause(), dwellStartPage() (+9 more)

### Community 29 - "Community 29"
Cohesion: 0.09
Nodes (19): encodeDiaryCursor(), groupStoriesByGame(), isValidDiaryGameId(), paginateDiaryGames(), parseDiaryCursor(), pickThumbUrl(), isPrivateVenueBucket(), isPublicServablePrivateBucket() (+11 more)

### Community 30 - "Community 30"
Cohesion: 0.14
Nodes (28): ackChannelActivity(), end(), endCurrent(), enqueueChannelAck(), fetchActiveChannel(), flushChannelAckQueue(), flushPendingUpdateTokens(), migrateLegacyActivitiesOnForeground() (+20 more)

### Community 31 - "Community 31"
Cohesion: 0.06
Nodes (2): KboGameTileService, SpanChunk

### Community 32 - "Community 32"
Cohesion: 0.08
Nodes (16): kstDateString(), RosterCollectionError, validateRosterCollection(), yyyymmddToUtcDays(), diffRoster(), planTeamMoves(), formatPendingMessage(), notifyPendingMoves() (+8 more)

### Community 33 - "Community 33"
Cohesion: 0.13
Nodes (2): Eff, GameScoreWidget

### Community 34 - "Community 34"
Cohesion: 0.07
Nodes (1): WearPushPolicyTest

### Community 35 - "Community 35"
Cohesion: 0.12
Nodes (14): deliverStarterBatch(), finalizeStarterSnapshot(), listDueStarterSnapshots(), observeStarterAnnounceGames(), openStarterSnapshot(), remainingMs(), withAbort(), formatKstMonthDay() (+6 more)

### Community 36 - "Community 36"
Cohesion: 0.11
Nodes (11): calls(), check(), main(), setHidden(), settle(), sleep(), waitFor(), check() (+3 more)

### Community 37 - "Community 37"
Cohesion: 0.1
Nodes (13): calcBatterSaber(), calcPitcherSaber(), estimateBatterWAR(), estimatePitcherWAR(), parseInnings(), parseOfficialRate(), collectNaverPlayers(), expectThrow() (+5 more)

### Community 38 - "Community 38"
Cohesion: 0.09
Nodes (6): exerciseConsumer(), main(), ok(), zOf(), nodeBlocksPull(), pullStartIsBlocked()

### Community 39 - "Community 39"
Cohesion: 0.15
Nodes (24): build_structured_profile(), clean_text(), cut_at_sentence(), extract_evaluation_from_tmi(), extract_pitches(), fetch_html(), fetch_sub_page(), filter_lines() (+16 more)

### Community 40 - "Community 40"
Cohesion: 0.08
Nodes (2): FakeEditor, FakeSharedPreferences

### Community 41 - "Community 41"
Cohesion: 0.13
Nodes (15): collectActivityDays(), computeCohortRetention(), computeDailyCohortRetention(), computeGamedayRetention(), computeVisitDistribution(), fetchAllPages(), isoWeek(), check() (+7 more)

### Community 42 - "Community 42"
Cohesion: 0.2
Nodes (20): build_structured_profile(), clean_text(), cut_at_sentence(), dedup_intl(), extract_evaluation_from_tmi(), extract_pitches(), fetch_html(), fetch_sub_page() (+12 more)

### Community 43 - "Community 43"
Cohesion: 0.14
Nodes (7): checkConcurrent(), InMemoryAlertState, ageHours(), computeJobHealth(), decideAdminAlerts(), fmtAge(), isProblem()

### Community 44 - "Community 44"
Cohesion: 0.2
Nodes (14): assertClean(), assertRunMode(), buildRows(), dateRange(), getTokens(), grab(), insertRows(), isoDate() (+6 more)

### Community 45 - "Community 45"
Cohesion: 0.11
Nodes (1): WearTilePolicyTest

### Community 46 - "Community 46"
Cohesion: 0.11
Nodes (0):

### Community 47 - "Community 47"
Cohesion: 0.12
Nodes (1): WearStore

### Community 48 - "Community 48"
Cohesion: 0.12
Nodes (1): WearStoreTest

### Community 49 - "Community 49"
Cohesion: 0.15
Nodes (6): identityFingerprint(), playerCandidateTitles(), playerSource(), fetchHtml(), htmlMeta(), main()

### Community 50 - "Community 50"
Cohesion: 0.14
Nodes (2): androidUserIds(), main()

### Community 51 - "Community 51"
Cohesion: 0.12
Nodes (1): WearFetcher

### Community 52 - "Community 52"
Cohesion: 0.14
Nodes (1): WidgetUpdatePolicyTest

### Community 53 - "Community 53"
Cohesion: 0.22
Nodes (8): allRows(), batterUpserts(), installFetch(), main(), ok(), pitcherUpserts(), req(), run()

### Community 54 - "Community 54"
Cohesion: 0.27
Nodes (12): build(), _defringe(), main(), _place_legacy(), _place_silhouette(), 컷아웃 알파에서 정수리·어깨선을 직접 검출 → 어깨선을 캔버스 하단에 앵커.     얼굴 크기가 선수 간 통일되고 비율은 원본 그대로(균등 스케, 머지 게이트: hero-approved 목록과 실제 webp 정합성 + 규격(752x944 RGBA, 비어있지 않은 알파)., Bleed nearest fully-opaque color into edge/transparent pixels (kills white halo) (+4 more)

### Community 55 - "Community 55"
Cohesion: 0.19
Nodes (6): findAppleTopFreeSegment(), rankFromAppleChartHtml(), appleChart(), appleHtml(), check(), main()

### Community 56 - "Community 56"
Cohesion: 0.17
Nodes (4): LongSpec, RankGauge, ShortSpec, WearComplicationPolicy

### Community 57 - "Community 57"
Cohesion: 0.32
Nodes (11): build_structured_profile(), fetch_html(), filter_neg(), get_players(), html_to_text(), load_json(), main(), parse_infobox() (+3 more)

### Community 58 - "Community 58"
Cohesion: 0.21
Nodes (4): findCandidates(), matchMlbparkPost(), normalizeTag(), resolveTeamFromTags()

### Community 59 - "Community 59"
Cohesion: 0.29
Nodes (1): ComposeLiveCardTest

### Community 60 - "Community 60"
Cohesion: 0.31
Nodes (1): NativeLiveEnvelopeTest

### Community 61 - "Community 61"
Cohesion: 0.18
Nodes (1): Pr723FaultMatrixTest

### Community 62 - "Community 62"
Cohesion: 0.18
Nodes (6): Decision, Drop, NoOp, PushState, Render, WearPushPolicy

### Community 63 - "Community 63"
Cohesion: 0.2
Nodes (3): AppDelegate, UIApplicationDelegate, UIResponder

### Community 64 - "Community 64"
Cohesion: 0.33
Nodes (10): build_profile(), crawl_page(), filter_negative(), get_all_players(), load_json(), main(), parse_body_sections(), parse_infobox() (+2 more)

### Community 65 - "Community 65"
Cohesion: 0.35
Nodes (10): build_profile(), fetch_html(), filter_negative(), get_all_players(), html_to_text(), load_json(), main(), parse_html() (+2 more)

### Community 66 - "Community 66"
Cohesion: 0.35
Nodes (10): claim(), confirm(), drain(), eventCount(), expireLease(), main(), migration(), nack() (+2 more)

### Community 67 - "Community 67"
Cohesion: 0.27
Nodes (6): articleKeyForUrl(), NewsDiscussionInputError, normalizeArticleUrl(), optionalText(), parseHttpUrl(), parseNewsDiscussionInput()

### Community 68 - "Community 68"
Cohesion: 0.2
Nodes (1): WearTeam

### Community 69 - "Community 69"
Cohesion: 0.33
Nodes (6): fetchGamesByDate(), fetchLineup(), findPrev(), main(), parseLineupRows(), shiftDate()

### Community 70 - "Community 70"
Cohesion: 0.36
Nodes (9): crawl_namuwiki(), get_all_players(), load_checkpoint(), load_enriched(), main(), parse_profile(), 텍스트에서 프로필 추출 — bio/career/tmi 모두 풍성하게, save_checkpoint() (+1 more)

### Community 71 - "Community 71"
Cohesion: 0.33
Nodes (6): fetchGamesByDate(), fetchLineup(), findPrev(), main(), parseLineupRows(), shiftDate()

### Community 72 - "Community 72"
Cohesion: 0.33
Nodes (8): bufToHex(), computeStrongETag(), bodyOf(), check(), req(), run(), ifNoneMatchSatisfied(), jsonWithETag()

### Community 73 - "Community 73"
Cohesion: 0.31
Nodes (1): MainActivity

### Community 74 - "Community 74"
Cohesion: 0.22
Nodes (2): KboComplicationServiceBase, WearComplicationUpdater

### Community 75 - "Community 75"
Cohesion: 0.22
Nodes (2): WearBases, WearSnapshot

### Community 76 - "Community 76"
Cohesion: 0.22
Nodes (1): WearComplicationPolicyTest

### Community 77 - "Community 77"
Cohesion: 0.36
Nodes (7): getWritingLeaderboardRows(), queryAllLeaderboardRows(), check(), fakeClient(), main(), makeRows(), sortLeaderboardRows()

### Community 78 - "Community 78"
Cohesion: 0.44
Nodes (8): check(), game(), installDeferredFetch(), installFetch(), main(), setHidden(), sleep(), waitFor()

### Community 79 - "Community 79"
Cohesion: 0.33
Nodes (5): captureAdAttribution(), getStoredAttributionForEvent(), getStoredGclid(), readStored(), writeStored()

### Community 80 - "Community 80"
Cohesion: 0.28
Nodes (4): check(), componentRegression(), detectIosAppBuild(), getInjectedCapacitor()

### Community 81 - "Community 81"
Cohesion: 0.31
Nodes (3): check(), runActualRealtimeClientRegression(), runLifecycleRegression()

### Community 82 - "Community 82"
Cohesion: 0.25
Nodes (1): WidgetTapModeTest

### Community 83 - "Community 83"
Cohesion: 0.25
Nodes (1): KboRankComplicationService

### Community 84 - "Community 84"
Cohesion: 0.39
Nodes (5): addSlice(), ev(), minute(), rollup(), sliceKey()

### Community 85 - "Community 85"
Cohesion: 0.57
Nodes (1): KboMessagingService

### Community 86 - "Community 86"
Cohesion: 0.38
Nodes (1): NativeLiveEnvelope

### Community 87 - "Community 87"
Cohesion: 0.29
Nodes (1): Pr723WearFaultMatrixTest

### Community 88 - "Community 88"
Cohesion: 0.43
Nodes (6): clean_section(), detect_wrong_person(), extract_basic_info(), main(), bio에서 기본 인적사항 추출 및 정리, should_skip()

### Community 89 - "Community 89"
Cohesion: 0.52
Nodes (6): apply(), coverage(), expectCoverageRaise(), main(), migration(), scalar()

### Community 90 - "Community 90"
Cohesion: 0.57
Nodes (6): apply(), main(), migration(), preview(), previewFull(), scalar()

### Community 91 - "Community 91"
Cohesion: 0.43
Nodes (4): callGet(), json(), main(), seedPoll()

### Community 92 - "Community 92"
Cohesion: 0.38
Nodes (3): fetchInning(), fetchNaverRelayBatterCounts(), tallyHitsFromRelays()

### Community 93 - "Community 93"
Cohesion: 0.33
Nodes (1): WidgetUpdatePolicy

### Community 94 - "Community 94"
Cohesion: 0.33
Nodes (1): GameStateListenerService

### Community 95 - "Community 95"
Cohesion: 0.33
Nodes (1): KboGameComplicationService

### Community 96 - "Community 96"
Cohesion: 0.33
Nodes (1): WearTilePolicy

### Community 97 - "Community 97"
Cohesion: 0.6
Nodes (5): claim(), main(), migration(), ok(), save()

### Community 98 - "Community 98"
Cohesion: 0.6
Nodes (4): appearsAsObject(), appearsAsSubject(), loserClaimedWin(), loserIsClaimedVictor()

### Community 99 - "Community 99"
Cohesion: 0.6
Nodes (5): makeMockDb(), makeMockRunner(), makeMockStorage(), ok(), run()

### Community 100 - "Community 100"
Cohesion: 0.67
Nodes (5): luminance(), mix(), onDarkColor(), teamPalette(), withAlpha()

### Community 101 - "Community 101"
Cohesion: 0.53
Nodes (3): detectNativeRuntime(), getInjectedCapacitor(), requestAppReview()

### Community 102 - "Community 102"
Cohesion: 0.6
Nodes (5): alreadySentApology(), buildMessage(), ensureConversation(), main(), teamNameById()

### Community 103 - "Community 103"
Cohesion: 0.53
Nodes (4): getAdminPinFromRequest(), isAdminAuthedRequest(), parseScryptHash(), verifyAdminPinValue()

### Community 104 - "Community 104"
Cohesion: 0.53
Nodes (4): b64url(), fetchIosDownloads(), isDownloadType(), makeToken()

### Community 105 - "Community 105"
Cohesion: 0.53
Nodes (4): b64url(), decodeCsv(), fetchAndroidDownloads(), makeToken()

### Community 106 - "Community 106"
Cohesion: 0.33
Nodes (0):

### Community 107 - "Community 107"
Cohesion: 0.4
Nodes (0):

### Community 108 - "Community 108"
Cohesion: 0.4
Nodes (3): KBOWatchWidgetBundle, KBOWidgetBundle, WidgetBundle

### Community 109 - "Community 109"
Cohesion: 0.7
Nodes (4): detectAllTeams(), detectTeam(), main(), matchPlayersPrecision()

### Community 110 - "Community 110"
Cohesion: 0.7
Nodes (4): clean_section(), detect_wrong_person(), main(), should_skip()

### Community 111 - "Community 111"
Cohesion: 0.7
Nodes (4): assertLiveScale(), assertMaterializedHints(), assertNoAppliedMigrationDrift(), main()

### Community 112 - "Community 112"
Cohesion: 0.7
Nodes (4): clean(), crawl(), main(), parse()

### Community 113 - "Community 113"
Cohesion: 0.5
Nodes (2): storePlatformFromCsId(), validateStoreDraftBody()

### Community 114 - "Community 114"
Cohesion: 0.6
Nodes (3): hasBaseRunnerContradiction(), homerRunCount(), mentionsHomer()

### Community 115 - "Community 115"
Cohesion: 0.5
Nodes (2): check(), main()

### Community 116 - "Community 116"
Cohesion: 0.5
Nodes (1): NewsArticleBrowserUrlPolicy

### Community 117 - "Community 117"
Cohesion: 0.5
Nodes (1): OAuthBrowserPlugin

### Community 118 - "Community 118"
Cohesion: 0.5
Nodes (2): CAPBridgeViewController, MainViewController

### Community 119 - "Community 119"
Cohesion: 0.83
Nodes (3): listHitterIds(), main(), position()

### Community 120 - "Community 120"
Cohesion: 0.83
Nodes (3): fetch(), main(), roster_ids()

### Community 121 - "Community 121"
Cohesion: 0.5
Nodes (0):

### Community 122 - "Community 122"
Cohesion: 0.67
Nodes (1): LaChannelAckPolicySmoke

### Community 123 - "Community 123"
Cohesion: 0.67
Nodes (1): LaChannelMigrationPolicySmoke

### Community 124 - "Community 124"
Cohesion: 0.83
Nodes (3): main(), ok(), scalar()

### Community 125 - "Community 125"
Cohesion: 0.83
Nodes (3): main(), ok(), scalar()

### Community 126 - "Community 126"
Cohesion: 0.5
Nodes (0):

### Community 127 - "Community 127"
Cohesion: 0.67
Nodes (2): main(), withInjected()

### Community 128 - "Community 128"
Cohesion: 0.83
Nodes (3): main(), parseMarkdown(), randomDelay()

### Community 129 - "Community 129"
Cohesion: 0.67
Nodes (2): main(), parseMd()

### Community 130 - "Community 130"
Cohesion: 0.67
Nodes (2): main(), testApi()

### Community 131 - "Community 131"
Cohesion: 0.83
Nodes (3): getInjectedCapacitor(), logNativeMetaEvent(), normalizeParameters()

### Community 132 - "Community 132"
Cohesion: 0.5
Nodes (0):

### Community 133 - "Community 133"
Cohesion: 0.67
Nodes (1): ExampleUnitTest

### Community 134 - "Community 134"
Cohesion: 0.67
Nodes (1): NewsArticleBrowserUrlPolicyTest

### Community 135 - "Community 135"
Cohesion: 0.67
Nodes (1): MyTeamListenerService

### Community 136 - "Community 136"
Cohesion: 1.0
Nodes (2): main(), searchYouTube()

### Community 137 - "Community 137"
Cohesion: 1.0
Nodes (2): main(), ok()

### Community 138 - "Community 138"
Cohesion: 1.0
Nodes (2): main(), ok()

### Community 139 - "Community 139"
Cohesion: 1.0
Nodes (2): check(), main()

### Community 140 - "Community 140"
Cohesion: 1.0
Nodes (2): main(), ok()

### Community 141 - "Community 141"
Cohesion: 1.0
Nodes (2): check(), main()

### Community 142 - "Community 142"
Cohesion: 0.67
Nodes (0):

### Community 143 - "Community 143"
Cohesion: 1.0
Nodes (2): main(), ok()

### Community 144 - "Community 144"
Cohesion: 1.0
Nodes (2): loadDotEnv(), main()

### Community 145 - "Community 145"
Cohesion: 1.0
Nodes (2): main(), ok()

### Community 146 - "Community 146"
Cohesion: 1.0
Nodes (2): findAuthUserByEmail(), main()

### Community 147 - "Community 147"
Cohesion: 1.0
Nodes (2): handleClick(), trackEvent()

### Community 148 - "Community 148"
Cohesion: 0.67
Nodes (0):

### Community 149 - "Community 149"
Cohesion: 0.67
Nodes (0):

### Community 150 - "Community 150"
Cohesion: 1.0
Nodes (2): parseDesignVersion(), resolveDesignVersion()

### Community 151 - "Community 151"
Cohesion: 0.67
Nodes (0):

### Community 152 - "Community 152"
Cohesion: 1.0
Nodes (0):

### Community 153 - "Community 153"
Cohesion: 1.0
Nodes (0):

### Community 154 - "Community 154"
Cohesion: 1.0
Nodes (0):

### Community 155 - "Community 155"
Cohesion: 1.0
Nodes (0):

### Community 156 - "Community 156"
Cohesion: 1.0
Nodes (0):

### Community 157 - "Community 157"
Cohesion: 1.0
Nodes (0):

### Community 158 - "Community 158"
Cohesion: 1.0
Nodes (0):

### Community 159 - "Community 159"
Cohesion: 1.0
Nodes (0):

### Community 160 - "Community 160"
Cohesion: 1.0
Nodes (0):

### Community 161 - "Community 161"
Cohesion: 1.0
Nodes (0):

### Community 162 - "Community 162"
Cohesion: 1.0
Nodes (0):

### Community 163 - "Community 163"
Cohesion: 1.0
Nodes (0):

### Community 164 - "Community 164"
Cohesion: 1.0
Nodes (0):

### Community 165 - "Community 165"
Cohesion: 1.0
Nodes (0):

### Community 166 - "Community 166"
Cohesion: 1.0
Nodes (0):

### Community 167 - "Community 167"
Cohesion: 1.0
Nodes (0):

### Community 168 - "Community 168"
Cohesion: 1.0
Nodes (0):

### Community 169 - "Community 169"
Cohesion: 1.0
Nodes (0):

### Community 170 - "Community 170"
Cohesion: 1.0
Nodes (0):

### Community 171 - "Community 171"
Cohesion: 1.0
Nodes (0):

### Community 172 - "Community 172"
Cohesion: 1.0
Nodes (0):

### Community 173 - "Community 173"
Cohesion: 1.0
Nodes (0):

### Community 174 - "Community 174"
Cohesion: 1.0
Nodes (0):

### Community 175 - "Community 175"
Cohesion: 1.0
Nodes (0):

### Community 176 - "Community 176"
Cohesion: 1.0
Nodes (0):

### Community 177 - "Community 177"
Cohesion: 1.0
Nodes (0):

### Community 178 - "Community 178"
Cohesion: 1.0
Nodes (0):

### Community 179 - "Community 179"
Cohesion: 1.0
Nodes (0):

### Community 180 - "Community 180"
Cohesion: 1.0
Nodes (0):

### Community 181 - "Community 181"
Cohesion: 1.0
Nodes (0):

### Community 182 - "Community 182"
Cohesion: 1.0
Nodes (0):

### Community 183 - "Community 183"
Cohesion: 1.0
Nodes (0):

### Community 184 - "Community 184"
Cohesion: 1.0
Nodes (0):

### Community 185 - "Community 185"
Cohesion: 1.0
Nodes (0):

## Knowledge Gaps
- **128 isolated node(s):** `Eff`, `SpanChunk`, `ShortSpec`, `LongSpec`, `RankGauge` (+123 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **Thin community `Community 152`** (2 nodes): `photo-post-qa.spec.ts`, `ensureTestImage()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 153`** (2 nodes): `activate-urgent-notice.ts`, `main()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 154`** (2 nodes): `deactivate-urgent-notice.ts`, `main()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 155`** (2 nodes): `account-deletion-contract-smoke.ts`, `check()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 156`** (2 nodes): `kgwan-refresh-epoch-smoke.ts`, `ok()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 157`** (2 nodes): `mood-gauge-realtime-load-smoke.ts`, `check()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 158`** (2 nodes): `observability-config-smoke.ts`, `extractMetricNames()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 159`** (2 nodes): `photos-helper-signature.ts`, `fail()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 160`** (2 nodes): `roster-count-consistency-smoke.ts`, `read()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 161`** (2 nodes): `rpc-error-contract-smoke.ts`, `check()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 162`** (2 nodes): `share-og-missing-post-smoke.ts`, `main()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 163`** (2 nodes): `visibility-poller-adoption-smoke.ts`, `check()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 164`** (2 nodes): `seed-channel-pool.ts`, `main()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 165`** (2 nodes): `seed-gif-collector-bot.ts`, `main()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 166`** (2 nodes): `seed-jjal-collector-bot.ts`, `main()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 167`** (2 nodes): `robots.ts`, `robots()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 168`** (2 nodes): `StadiumInfo.tsx`, `stadiumId()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 169`** (2 nodes): `StatusBadge.tsx`, `StatusBadge()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 170`** (2 nodes): `awards.ts`, `getPlayerAwards()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 171`** (2 nodes): `leaderboard-exclusions.ts`, `isInternalUser()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 172`** (1 nodes): `capacitor.config.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 173`** (1 nodes): `api.spec.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 174`** (1 nodes): `interaction.spec.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 175`** (1 nodes): `navigation.spec.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 176`** (1 nodes): `Package.swift`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 177`** (1 nodes): `CapApp-SPM.swift`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 178`** (1 nodes): `next.config.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 179`** (1 nodes): `playwright.config.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 180`** (1 nodes): `sw.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 181`** (1 nodes): `standings-widget-games-smoke.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 182`** (1 nodes): `RadioPlayer.tsx`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 183`** (1 nodes): `TeamComparisonBar.tsx`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 184`** (1 nodes): `player-profiles.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 185`** (1 nodes): `writing-points.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `BaseDiamond` connect `Community 4` to `Community 9`?**
  _High betweenness centrality (0.029) - this node is a cross-community bridge._
- **Are the 159 inferred relationships involving `GET()` (e.g. with `verifyPin()` and `getAccessToken()`) actually correct?**
  _`GET()` has 159 INFERRED edges - model-reasoned connections that need verification._
- **Are the 65 inferred relationships involving `POST()` (e.g. with `verifyPin()` and `getClientIp()`) actually correct?**
  _`POST()` has 65 INFERRED edges - model-reasoned connections that need verification._
- **What connects `Eff`, `SpanChunk`, `ShortSpec` to the rest of the system?**
  _128 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.01 - nodes in this community are weakly interconnected._
- **Should `Community 1` be split into smaller, more focused modules?**
  _Cohesion score 0.01 - nodes in this community are weakly interconnected._
- **Should `Community 2` be split into smaller, more focused modules?**
  _Cohesion score 0.01 - nodes in this community are weakly interconnected._