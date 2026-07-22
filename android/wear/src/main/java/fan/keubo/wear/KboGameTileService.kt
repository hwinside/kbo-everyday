package fan.keubo.wear

import androidx.concurrent.futures.CallbackToFutureAdapter
import androidx.wear.protolayout.ActionBuilders
import androidx.wear.protolayout.ColorBuilders.argb
import androidx.wear.protolayout.DimensionBuilders.dp
import androidx.wear.protolayout.DimensionBuilders.sp
import androidx.wear.protolayout.LayoutElementBuilders
import androidx.wear.protolayout.LayoutElementBuilders.Box
import androidx.wear.protolayout.LayoutElementBuilders.Column
import androidx.wear.protolayout.LayoutElementBuilders.FontStyle
import androidx.wear.protolayout.LayoutElementBuilders.LayoutElement
import androidx.wear.protolayout.LayoutElementBuilders.Row
import androidx.wear.protolayout.LayoutElementBuilders.Spacer
import androidx.wear.protolayout.LayoutElementBuilders.Spannable
import androidx.wear.protolayout.LayoutElementBuilders.SpanText
import androidx.wear.protolayout.LayoutElementBuilders.Text
import androidx.wear.protolayout.ModifiersBuilders
import androidx.wear.protolayout.ResourceBuilders
import androidx.wear.protolayout.TimelineBuilders
import androidx.wear.protolayout.TypeBuilders
import androidx.wear.protolayout.expression.DynamicBuilders.DynamicInstant
import androidx.wear.protolayout.expression.DynamicBuilders.DynamicInt32
import androidx.wear.protolayout.expression.DynamicBuilders.DynamicString
import androidx.wear.tiles.RequestBuilders
import androidx.wear.tiles.TileBuilders
import androidx.wear.tiles.TileService
import com.google.common.util.concurrent.ListenableFuture
import java.time.Instant
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread

/**
 * 슬라이스 A 타일 — 최애팀 다음경기·카운트다운·라이브 스코어 (애플워치 #635 패리티).
 *
 * cache-first(삼순 조건 1): onTileRequest는 어떤 경로에서도 네트워크를 기다리지 않는다.
 * 캐시가 있으면 즉시 렌더, 없으면(첫 실행) placeholder를 즉시 반환하고 single-flight
 * 백그라운드 sync가 끝나면 requestUpdate로 재렌더한다. Tile 10초 제한과 무관해진다.
 * 카운트다운(삼순 조건 2)은 Dynamic Expressions(플랫폼 시계) — 타일 재요청 없이 분단위 갱신.
 * freshness는 OS best-effort 힌트일 뿐 SLA가 아니다. 정책 수치·판정은 WearTilePolicy.
 */
class KboGameTileService : TileService() {

    companion object {
        private const val RES_VERSION = "2" // 팀로고 이미지 리소스 추가로 bump

        // 백그라운드 sync single-flight 게이트 — 동시 타일 요청이 스레드를 중복 생성하지 않게
        private val syncInFlight = AtomicBoolean(false)
    }

    override fun onTileRequest(
        requestParams: RequestBuilders.TileRequest,
    ): ListenableFuture<TileBuilders.Tile> {
        val ctx = applicationContext

        return CallbackToFutureAdapter.getFuture { completer ->
            val myTeam = WearStore.loadMyTeam(ctx)
            // 팀 변경 직후 잔존 캐시 방어(saveMyTeam이 atomic clear하지만 defense-in-depth)
            val cached = WearStore.loadCachedSnapshot(ctx)
                ?.takeIf { it.myTeamCode.equals(myTeam, ignoreCase = true) }
            val now = System.currentTimeMillis()

            when {
                myTeam.isEmpty() -> completer.set(buildTile(WearSnapshot.noTeam()))
                cached != null -> {
                    // cache-first: 즉시 렌더 + (stale이면) 백그라운드 sync 후 재요청
                    completer.set(buildTile(cached))
                    if (WearTilePolicy.isStale(cached, WearStore.lastSyncAt(ctx), now)) {
                        maybeStartSync(ctx)
                    }
                }
                else -> {
                    // 첫 실행(캐시 없음)도 placeholder 즉시 반환 — fetch를 기다리지 않는다
                    completer.set(buildTile(WearSnapshot.loading(myTeam)))
                    maybeStartSync(ctx)
                }
            }
            "KboGameTile"
        }
    }

    /**
     * single-flight 백그라운드 sync. MIN_SYNC_RETRY_MS 스로틀로 실패 시
     * requestUpdate ↔ onTileRequest 재귀 루프를 차단하고, 캐시가 실제로
     * 바뀌었을 때만 재렌더를 요청한다.
     */
    private fun maybeStartSync(ctx: android.content.Context) {
        val now = System.currentTimeMillis()
        if (!WearTilePolicy.canAttemptSync(WearStore.lastSyncAttemptAt(ctx), now)) return
        if (!syncInFlight.compareAndSet(false, true)) return
        WearStore.markSyncAttemptNow(ctx)
        thread(name = "kbo-tile-sync") {
            try {
                val before = WearStore.loadCachedSnapshot(ctx)
                WearFetcher.fetch(ctx)
                val after = WearStore.loadCachedSnapshot(ctx)
                // 삼순 blocker 2: updatedAt은 매 fetch 갱신되므로 data class `!=`는 항상 true.
                // contentSignature(updatedAt 제외)로 실제 상태 변화가 있을 때만 재렌더.
                if (after != null &&
                    (before == null || after.contentSignature() != before.contentSignature())
                ) {
                    getUpdater(ctx).requestUpdate(KboGameTileService::class.java)
                }
            } finally {
                syncInFlight.set(false)
            }
        }
    }

    override fun onTileResourcesRequest(
        requestParams: RequestBuilders.ResourcesRequest,
    ): ListenableFuture<ResourceBuilders.Resources> {
        return CallbackToFutureAdapter.getFuture { completer ->
            val builder = ResourceBuilders.Resources.Builder().setVersion(RES_VERSION)
            // 팀로고 10종 전부 매핑(96px PNG, 총 ~240KB) — 어느 매치업이 와도 커버
            for (id in 1..10) {
                val code = WearTeam.code(id)
                val res = WearTeam.logoRes(code)
                if (res != 0) {
                    builder.addIdToImageMapping(
                        WearTeam.logoResourceId(code),
                        ResourceBuilders.ImageResource.Builder()
                            .setAndroidResourceByResId(
                                ResourceBuilders.AndroidImageResourceByResId.Builder()
                                    .setResourceId(res)
                                    .build(),
                            )
                            .build(),
                    )
                }
            }
            completer.set(builder.build())
            "KboGameTileResources"
        }
    }

    // ── 타일 조립 ──

    private fun buildTile(snap: WearSnapshot): TileBuilders.Tile {
        val root = renderRoot(snap)
        val timeline = TimelineBuilders.Timeline.Builder()
            .addTimelineEntry(
                TimelineBuilders.TimelineEntry.Builder()
                    .setLayout(LayoutElementBuilders.Layout.Builder().setRoot(root).build())
                    .build(),
            )
            .build()
        return TileBuilders.Tile.Builder()
            .setResourcesVersion(RES_VERSION)
            .setTileTimeline(timeline)
            .setFreshnessIntervalMillis(
                WearTilePolicy.freshnessForMs(snap, System.currentTimeMillis()),
            )
            .build()
    }

    // ── 레이아웃 (애플워치 WatchGameCard 패리티 — 헤더 + 라운드 카드) ──

    private fun renderRoot(snap: WearSnapshot): LayoutElement {
        // 삼순 블로커 1(#661): 시스템 "애니메이션 제거" 설정 시 marquee 대신 말줄임 폴백.
        val reduceMotion = isReduceMotionEnabled(applicationContext)
        val content = when (snap.kind) {
            "live" -> withDetails(snap, headerAndCard(snap, liveInner(snap)), reduceMotion)
            "final" -> withDetails(snap, headerAndCard(snap, finalInner(snap)), reduceMotion)
            "scheduled" -> withDetails(snap, headerAndCard(snap, scheduledInner(snap)), reduceMotion)
            "cancelled" -> headerAndCard(snap, matchupMessageInner(snap, "경기 취소"))
            "noTeam" -> card(messageInner("크보팬 앱에서", "최애팀을 선택하세요"))
            "loading" -> card(messageInner("크보팬", "불러오는 중…"))
            else -> headerAndCard(snap, messageInner("오늘 경기 없음", ""))
        }

        val openApp = ModifiersBuilders.Clickable.Builder()
            .setId("open_app")
            .setOnClick(
                ActionBuilders.LaunchAction.Builder()
                    .setAndroidActivity(
                        ActionBuilders.AndroidActivity.Builder()
                            .setPackageName("fan.keubo.app")
                            .setClassName("fan.keubo.wear.MainActivity")
                            .build(),
                    )
                    .build(),
            )
            .build()

        return Box.Builder()
            .setWidth(androidx.wear.protolayout.DimensionBuilders.expand())
            .setHeight(androidx.wear.protolayout.DimensionBuilders.expand())
            .setModifiers(
                ModifiersBuilders.Modifiers.Builder()
                    .setClickable(openApp)
                    .setPadding(ModifiersBuilders.Padding.Builder().setAll(dp(6f)).build())
                    .build(),
            )
            .addContent(content)
            .build()
    }

    /** 상단 헤더: "크보팬 · MY TEAM" 캡션(승인 목업) + "LG · 2위 · 1위와 1.5경기차" (팀 컬러 + 순위) */
    private fun header(snap: WearSnapshot): LayoutElement {
        val myId = WearTeam.id(snap.myTeamCode)
        val name = WearTeam.short(snap.myTeamCode)
        val rank = if (snap.rankLine.isEmpty()) name else "$name · ${snap.rankLine}"
        return Column.Builder()
            .setHorizontalAlignment(LayoutElementBuilders.HORIZONTAL_ALIGN_CENTER)
            .addContent(text("크보팬 · MY TEAM", 9f, WearTeam.COLOR_TEXT_SECONDARY, bold = true))
            .addContent(vspace(1f))
            .addContent(text(rank, 12f, WearTeam.highlightColor(myId), bold = true))
            .build()
    }

    /** 헤더 + 라운드 카드 — 애플워치 WatchRootView(타이틀/카드/순위) 구조의 타일 판 */
    private fun headerAndCard(snap: WearSnapshot, inner: LayoutElement): LayoutElement =
        Column.Builder()
            .setHorizontalAlignment(LayoutElementBuilders.HORIZONTAL_ALIGN_CENTER)
            .addContent(header(snap))
            .addContent(vspace(4f))
            .addContent(card(inner, WearTeam.cardTint(WearTeam.id(snap.myTeamCode))))
            .build()

    /**
     * 라운드 카드 컨테이너 — 애플워치 WatchGameCard(cornerRadius 12) 패리티.
     * 배경은 최애팀 컬러 은은한 틴트(삼순 조건 — ProtoLayout은 그라데이션 미지원이라 단색 블렌딩).
     */
    private fun card(inner: LayoutElement, bg: Int = 0xE61C1C1F.toInt()): LayoutElement = Box.Builder()
        .setModifiers(
            ModifiersBuilders.Modifiers.Builder()
                .setBackground(
                    ModifiersBuilders.Background.Builder()
                        .setColor(argb(bg))
                        .setCorner(ModifiersBuilders.Corner.Builder().setRadius(dp(16f)).build())
                        .build(),
                )
                .setPadding(
                    ModifiersBuilders.Padding.Builder()
                        .setStart(dp(14f)).setEnd(dp(14f))
                        .setTop(dp(7f)).setBottom(dp(7f))
                        .build(),
                )
                .build(),
        )
        .addContent(inner)
        .build()

    /** 카드 상단 구장 한 줄(목업) — venue 있을 때만 */
    private fun venuePrefix(col: Column.Builder, snap: WearSnapshot) {
        snap.venue?.let {
            col.addContent(text(it, 10f, WearTeam.COLOR_TEXT_SECONDARY))
            col.addContent(vspace(2f))
        }
    }

    /** 상태별 하단 상세 행(목업) — LIVE=아웃·주자/투타/최근 플레이, 예정=선발, 종료=승/패(+세이브) 투수. */
    private fun withDetails(snap: WearSnapshot, main: LayoutElement, reduceMotion: Boolean): LayoutElement {
        val rows = detailRows(snap, reduceMotion)
        if (rows.isEmpty()) return main
        val col = Column.Builder()
            .setHorizontalAlignment(LayoutElementBuilders.HORIZONTAL_ALIGN_CENTER)
            .addContent(main)
        rows.forEach {
            col.addContent(vspace(3f))
            col.addContent(it)
        }
        return col.build()
    }

    private fun detailRows(snap: WearSnapshot, reduceMotion: Boolean): List<LayoutElement> {
        val rows = ArrayList<LayoutElement>()
        if (snap.isLive) {
            // 아웃카운트 도트 + 주자 다이아몬드
            val outsRow = Row.Builder()
                .setVerticalAlignment(LayoutElementBuilders.VERTICAL_ALIGN_CENTER)
                .addContent(text("O", 12f, WearTeam.COLOR_TEXT_PRIMARY, bold = true))
                .addContent(hspace(5f))
            for (i in 0 until 3) {
                val on = i < (snap.outs ?: 0)
                outsRow.addContent(text("●", 11f, if (on) WearTeam.COLOR_LIVE else WearTeam.COLOR_TEXT_TERTIARY))
                if (i < 2) outsRow.addContent(hspace(3f))
            }
            snap.bases?.let {
                outsRow.addContent(hspace(12f))
                outsRow.addContent(baseDiamond(it))
            }
            rows.add(rowBox(outsRow.build()))
            // 투수 · 타자 — 라벨(secondary)+이름(bold) 위계 유지한 Spannable marquee(삼순 재NO-GO #661).
            // Spannable.setOverflow/setMarqueeIterations는 Row와 달리 위계 있는 여러 span에도 발동한다.
            if (snap.pitcher != null || snap.batter != null) {
                val pairs = ArrayList<Pair<String, String>>()
                snap.pitcher?.let { pairs.add("투수" to it) }
                snap.batter?.let { pairs.add("타자" to it) }
                rows.add(
                    rowBox(
                        styledMarqueeText(labelNameChunks(pairs), reduceMotion),
                        expandWidth = true,
                    ),
                )
            }
            // 최근 플레이 한 줄 — 길면 marquee 드리프트(하린아빠 7/17), 행 폭은 카드 폭에 맞춰 고정
            snap.lastPlay?.let {
                rows.add(rowBox(marqueeText(it, 10f, WearTeam.COLOR_TEXT_PRIMARY, reduceMotion = reduceMotion), expandWidth = true))
            }
        } else if (snap.kind == "scheduled") {
            // 목업 v2: `선발 소형준 ● 웰스` — 라벨 secondary + 이름 bold + 핑크 도트 위계 유지(삼순 재NO-GO #661)
            snap.starters?.let { s ->
                val names = s.removePrefix("선발 ")   // 구버전 캐시("선발 A vs B") 방어
                val parts = names.split(" · ")
                val chunks = ArrayList<SpanChunk>()
                chunks.add(SpanChunk("선발 ", 10f, WearTeam.COLOR_TEXT_SECONDARY))
                if (parts.size == 2) {
                    chunks.add(SpanChunk(parts[0], 12f, WearTeam.COLOR_TEXT_PRIMARY, bold = true))
                    chunks.add(SpanChunk("  ●  ", 8f, WearTeam.COLOR_LIVE))
                    chunks.add(SpanChunk(parts[1], 12f, WearTeam.COLOR_TEXT_PRIMARY, bold = true))
                } else {
                    chunks.add(SpanChunk(names.replace(" vs ", " · "), 12f, WearTeam.COLOR_TEXT_PRIMARY, bold = true))
                }
                rows.add(rowBox(styledMarqueeText(chunks, reduceMotion), expandWidth = true))
            }
        } else if (snap.kind == "final" && (snap.winPitcher != null || snap.losePitcher != null)) {
            // 승/패 투수 한 줄 + 세이브 있을 때만 2행째 컴팩트 행(삼순 SSOT — 없으면 생략, 애플워치 동일)
            // 라벨(secondary)+이름(bold) 위계 유지한 Spannable marquee(삼순 재NO-GO #661)
            val wlPairs = ArrayList<Pair<String, String>>()
            snap.winPitcher?.let { wlPairs.add("승" to it) }
            snap.losePitcher?.let { wlPairs.add("패" to it) }
            rows.add(
                rowBox(
                    styledMarqueeText(labelNameChunks(wlPairs), reduceMotion),
                    expandWidth = true,
                ),
            )
            snap.savePitcher?.let {
                rows.add(
                    rowBox(
                        styledMarqueeText(labelNameChunks(listOf("세이브" to it)), reduceMotion),
                        expandWidth = true,
                    ),
                )
            }
        }
        return rows
    }

    /** 공통 상세 행 박스 — 어두운 라운드 박스(목업 하단 행 스타일, 흰 8%).
     *  expandWidth = marquee 행 전용: 텍스트가 부모 폭에 constrain돼야 marquee가 발동한다. */
    private fun rowBox(inner: LayoutElement, expandWidth: Boolean = false): LayoutElement = Box.Builder()
        .apply { if (expandWidth) setWidth(androidx.wear.protolayout.DimensionBuilders.expand()) }
        .setModifiers(
            ModifiersBuilders.Modifiers.Builder()
                .setBackground(
                    ModifiersBuilders.Background.Builder()
                        .setColor(argb(0x14FFFFFF))
                        .setCorner(ModifiersBuilders.Corner.Builder().setRadius(dp(10f)).build())
                        .build(),
                )
                .setPadding(
                    ModifiersBuilders.Padding.Builder()
                        .setStart(dp(10f)).setEnd(dp(10f))
                        .setTop(dp(3f)).setBottom(dp(3f))
                        .build(),
                )
                .build(),
        )
        .addContent(inner)
        .build()

    /** 예정: 구장 / 매치업(vs) / 카운트다운(오늘, Dynamic) 또는 일시 라인 */
    private fun scheduledInner(snap: WearSnapshot): LayoutElement {
        val col = Column.Builder()
            .setHorizontalAlignment(LayoutElementBuilders.HORIZONTAL_ALIGN_CENTER)
        venuePrefix(col, snap)
        col.addContent(matchupRow(snap, text("vs", 14f, WearTeam.COLOR_TEXT_SECONDARY, bold = true)))
            .addContent(vspace(3f))

        val start = snap.startAt
        if (start != null && WearFetcher.isCountdownToday(start)) {
            // 오늘 경기: Dynamic Expressions 카운트다운 (렌더 시점 임박이면 앰버)
            val color = if (WearFetcher.isImminent(start)) WearTeam.COLOR_AMBER
            else WearTeam.COLOR_TEXT_PRIMARY
            col.addContent(countdownText(start, color))
            col.addContent(vspace(2f))
            col.addContent(text(snap.line, 13f, WearTeam.COLOR_TEXT_SECONDARY))
        } else {
            // 미래 경기(다음 경기 폴백 포함): "7/16(수) 18:30"
            col.addContent(text(snap.line, 15f, WearTeam.COLOR_TEXT_PRIMARY, bold = true))
        }
        return col.build()
    }

    /** 라이브: 구장 / 매치업(큰 스코어 가운데) / LIVE 라인(잔루는 하단 상세 행으로 이동) / 지연 배지 */
    private fun liveInner(snap: WearSnapshot): LayoutElement {
        val col = Column.Builder()
            .setHorizontalAlignment(LayoutElementBuilders.HORIZONTAL_ALIGN_CENTER)
        venuePrefix(col, snap)
        col.addContent(matchupRow(snap, scoreText(snap)))
            .addContent(vspace(3f))

        // 목업 v2: LIVE 카드줄은 "LIVE 7회말"만 — 아웃은 하단 도트 행과 중복이라 제거
        val liveLine = snap.line.replace(Regex(" · \\d+사$"), "")
        val liveRow = Row.Builder()
            .setVerticalAlignment(LayoutElementBuilders.VERTICAL_ALIGN_CENTER)
            .addContent(text(liveLine, 12f, WearTeam.COLOR_LIVE, bold = true))
        col.addContent(liveRow.build())

        if (System.currentTimeMillis() - snap.updatedAt > WearTilePolicy.LIVE_DELAY_BADGE_MS) {
            col.addContent(vspace(2f))
            col.addContent(text("업데이트 지연", 11f, WearTeam.COLOR_TEXT_TERTIARY))
        }
        return col.build()
    }

    /** 종료: 구장 / 매치업(최종 스코어 가운데) / "경기 종료 · 승" */
    private fun finalInner(snap: WearSnapshot): LayoutElement {
        val col = Column.Builder()
            .setHorizontalAlignment(LayoutElementBuilders.HORIZONTAL_ALIGN_CENTER)
        venuePrefix(col, snap)
        return col.addContent(matchupRow(snap, scoreText(snap)))
            .addContent(vspace(3f))
            .addContent(text(snap.line, 12f, WearTeam.COLOR_TEXT_SECONDARY, bold = true))
            .build()
    }

    private fun matchupMessageInner(snap: WearSnapshot, message: String): LayoutElement {
        return Column.Builder()
            .setHorizontalAlignment(LayoutElementBuilders.HORIZONTAL_ALIGN_CENTER)
            .addContent(matchupRow(snap, text("vs", 14f, WearTeam.COLOR_TEXT_SECONDARY, bold = true)))
            .addContent(vspace(5f))
            .addContent(text(message, 13f, WearTeam.COLOR_TEXT_SECONDARY, bold = true))
            .build()
    }

    private fun messageInner(line1: String, line2: String): LayoutElement {
        val col = Column.Builder()
            .setHorizontalAlignment(LayoutElementBuilders.HORIZONTAL_ALIGN_CENTER)
            .addContent(text(line1, 15f, WearTeam.COLOR_TEXT_PRIMARY, bold = true))
        if (line2.isNotEmpty()) {
            col.addContent(vspace(3f))
            col.addContent(text(line2, 13f, WearTeam.COLOR_TEXT_SECONDARY))
        }
        return col.build()
    }

    /**
     * 매치업 한 줄 — 애플워치 WatchGameCard 패리티 + 팀로고(하린아빠 7/16 요청):
     * `[로고]LG   3 : 2   KT[로고]` (원정 왼쪽 · 홈 오른쪽, 가운데 스코어 또는 "vs").
     */
    private fun matchupRow(snap: WearSnapshot, center: LayoutElement): LayoutElement {
        val row = Row.Builder()
            .setVerticalAlignment(LayoutElementBuilders.VERTICAL_ALIGN_CENTER)
        teamLogo(snap.awayCode)?.let { row.addContent(it); row.addContent(hspace(4f)) }
        row.addContent(text(WearTeam.short(snap.awayCode), 14f, WearTeam.COLOR_TEXT_PRIMARY, bold = true))
            .addContent(hspace(8f))
            .addContent(center)
            .addContent(hspace(8f))
            .addContent(text(WearTeam.short(snap.homeCode), 14f, WearTeam.COLOR_TEXT_PRIMARY, bold = true))
        teamLogo(snap.homeCode)?.let { row.addContent(hspace(4f)); row.addContent(it) }
        return row.build()
    }

    /** 팀로고 이미지(24dp) — 미지의 코드(올스타 등)는 null로 텍스트만 렌더 */
    private fun teamLogo(code: String): LayoutElement? {
        if (WearTeam.logoRes(code) == 0) return null
        return LayoutElementBuilders.Image.Builder()
            .setResourceId(WearTeam.logoResourceId(code))
            .setWidth(dp(24f))
            .setHeight(dp(24f))
            .build()
    }

    /** "3 : 2" — 애플워치 18pt black 대응(타일 캔버스에 맞춰 확대) */
    private fun scoreText(snap: WearSnapshot): LayoutElement =
        text("${snap.awayScore} : ${snap.homeScore}", 24f, WearTeam.COLOR_TEXT_PRIMARY, bold = true)

    /**
     * 잔루 다이아몬드 — 2루(위) / 3루(왼쪽 아래) / 1루(오른쪽 아래).
     * ProtoLayout엔 회전이 없어 사각 픽 삼각 배치로 표현(점유=라이브색, 빈루=옅은 흰색).
     */
    private fun baseDiamond(bases: WearBases): LayoutElement {
        fun pip(on: Boolean): LayoutElement = Box.Builder()
            .setWidth(dp(6f))
            .setHeight(dp(6f))
            .setModifiers(
                ModifiersBuilders.Modifiers.Builder()
                    .setBackground(
                        ModifiersBuilders.Background.Builder()
                            .setColor(argb(if (on) WearTeam.COLOR_LIVE else 0x38FFFFFF))
                            .setCorner(
                                ModifiersBuilders.Corner.Builder().setRadius(dp(1.5f)).build(),
                            )
                            .build(),
                    )
                    .build(),
            )
            .build()

        return Column.Builder()
            .setHorizontalAlignment(LayoutElementBuilders.HORIZONTAL_ALIGN_CENTER)
            .addContent(pip(bases.second))
            .addContent(vspace(1f))
            .addContent(
                Row.Builder()
                    .addContent(pip(bases.third))
                    .addContent(hspace(3f))
                    .addContent(pip(bases.first))
                    .build(),
            )
            .build()
    }

    /**
     * 카운트다운 텍스트 — Dynamic Expressions(플랫폼 시계 기반, 타일 재요청 없이 자동 갱신).
     * 라벨 규칙(하린아빠 7/16 실기기 피드백 — 큰 숫자 대신 읽히는 문장 + 폰트 축소):
     * 시작 전 1h 이상 "5시간 27분 후 시작" / 1h 미만 "27분 후 시작"(0분은 "1분 후 시작") / 시작 후 "곧 시작".
     */
    private fun countdownText(startAtMs: Long, colorArgb: Int): LayoutElement {
        val startInstant = DynamicInstant.withSecondsPrecision(Instant.ofEpochMilli(startAtMs))
        val duration = DynamicInstant.platformTimeWithSecondsPrecision().durationUntil(startInstant)
        val totalSecs = duration.toIntSeconds()
        val totalMins = duration.toIntMinutes()
        val hours = totalMins.div(60)
        val mins = totalMins.rem(60)

        val plain = DynamicInt32.IntFormatter.Builder()
            .setMinIntegerDigits(1).setGroupingUsed(false).build()

        // "H시간 M분 후 시작"
        val hourMin = hours.format(plain)
            .concat(DynamicString.constant("시간 "))
            .concat(mins.format(plain))
            .concat(DynamicString.constant("분 후 시작"))
        // "M분 후 시작"
        val minOnly = totalMins.format(plain).concat(DynamicString.constant("분 후 시작"))

        val label = DynamicString.onCondition(totalSecs.lte(0))
            .use(DynamicString.constant("곧 시작"))
            .elseUse(
                DynamicString.onCondition(totalMins.lte(0))
                    .use(DynamicString.constant("1분 후 시작")) // 0 < 남은 시간 < 1분
                    .elseUse(
                        DynamicString.onCondition(hours.lte(0))
                            .use(minOnly)
                            .elseUse(hourMin),
                    ),
            )

        // 정적 폴백(Dynamic 미지원 렌더러) = 렌더 시점 계산값
        val staticLabel = WearTilePolicy.staticCountdownLabel(startAtMs, System.currentTimeMillis())

        return Text.Builder()
            .setText(
                TypeBuilders.StringProp.Builder(staticLabel)
                    .setDynamicValue(label)
                    .build(),
            )
            .setLayoutConstraintsForDynamicText(
                TypeBuilders.StringLayoutConstraint.Builder("88시간 88분 후 시작").build(),
            )
            .setFontStyle(
                FontStyle.Builder()
                    .setSize(sp(16f)) // 문장형 라벨 — 큰 숫자 대신 축소(하린아빠 7/16)
                    .setWeight(
                        LayoutElementBuilders.FontWeightProp.Builder()
                            .setValue(LayoutElementBuilders.FONT_WEIGHT_BOLD)
                            .build(),
                    )
                    .setColor(argb(colorArgb))
                    .build(),
            )
            .build()
    }

    // ── 공용 빌더 ──

    private fun text(value: String, size: Float, color: Int, bold: Boolean = false): LayoutElement {
        val style = FontStyle.Builder()
            .setSize(sp(size))
            .setColor(argb(color))
        if (bold) {
            style.setWeight(
                LayoutElementBuilders.FontWeightProp.Builder()
                    .setValue(LayoutElementBuilders.FONT_WEIGHT_BOLD)
                    .build(),
            )
        }
        return Text.Builder()
            .setText(TypeBuilders.StringProp.Builder(value).build())
            .setFontStyle(style.build())
            .build()
    }

    /**
     * 1줄 marquee 텍스트 — 부모 폭 초과 시 자동 드리프트(하린아빠 7/17).
     * ProtoLayout 네이티브 marquee(애플워치 WatchDriftRow 대응물). 미지원 렌더러는 말줄임 폴백.
     * reduceMotion(시스템 "애니메이션 제거" 설정, 삼순 블로커 1 #661) 시엔 무한 반복 대신 말줄임.
     */
    @androidx.annotation.OptIn(markerClass = [androidx.wear.protolayout.expression.ProtoLayoutExperimental::class])
    private fun marqueeText(
        value: String,
        size: Float,
        color: Int,
        bold: Boolean = false,
        reduceMotion: Boolean = false,
    ): LayoutElement {
        val style = FontStyle.Builder()
            .setSize(sp(size))
            .setColor(argb(color))
        if (bold) {
            style.setWeight(
                LayoutElementBuilders.FontWeightProp.Builder()
                    .setValue(LayoutElementBuilders.FONT_WEIGHT_BOLD)
                    .build(),
            )
        }
        val builder = Text.Builder()
            .setText(TypeBuilders.StringProp.Builder(value).build())
            .setFontStyle(style.build())
            .setMaxLines(1)
        return if (reduceMotion) {
            builder.setOverflow(LayoutElementBuilders.TEXT_OVERFLOW_ELLIPSIZE_END).build()
        } else {
            builder.setOverflow(LayoutElementBuilders.TEXT_OVERFLOW_MARQUEE)
                .setMarqueeIterations(-1) // 무한 반복
                .build()
        }
    }

    /** 스타일 있는 marquee 세그먼트 하나(라벨/이름/구분자 등) — [styledMarqueeText]의 입력. */
    private data class SpanChunk(val text: String, val size: Float, val color: Int, val bold: Boolean = false)

    /** `투수 손아섭` 같은 (라벨, 이름) 쌍들을 공백으로 이어붙인 청크 목록 — 승/패/세이브/투타 공용. */
    private fun labelNameChunks(pairs: List<Pair<String, String>>): List<SpanChunk> {
        val chunks = ArrayList<SpanChunk>()
        pairs.forEachIndexed { idx, (label, name) ->
            if (idx > 0) chunks.add(SpanChunk("   ", 10f, WearTeam.COLOR_TEXT_SECONDARY))
            chunks.add(SpanChunk("$label ", 10f, WearTeam.COLOR_TEXT_SECONDARY))
            chunks.add(SpanChunk(name, 12f, WearTeam.COLOR_TEXT_PRIMARY, bold = true))
        }
        return chunks
    }

    /**
     * 라벨(secondary 10sp)+이름(bold 12sp)+구분자 위계를 유지한 1줄 marquee 텍스트
     * (삼순 재NO-GO #661 — 단일 `Text`로 통일하면 marquee는 되나 v4 SSOT 정보 위계가 사라짐).
     * `Spannable`은 여러 `SpanText`(각자 다른 FontStyle)를 조합하고도 전체에 하나의
     * overflow/marquee를 걸 수 있어(단일 Text의 한계 없이) 스타일 유지 + 드리프트 양립 가능.
     * reduceMotion(시스템 "애니메이션 제거" 설정) 시엔 marquee 대신 말줄임.
     */
    @androidx.annotation.OptIn(markerClass = [androidx.wear.protolayout.expression.ProtoLayoutExperimental::class])
    private fun styledMarqueeText(chunks: List<SpanChunk>, reduceMotion: Boolean): LayoutElement {
        val builder = Spannable.Builder().setMaxLines(1)
        chunks.forEach { c ->
            val style = FontStyle.Builder().setSize(sp(c.size)).setColor(argb(c.color))
            if (c.bold) {
                style.setWeight(
                    LayoutElementBuilders.FontWeightProp.Builder()
                        .setValue(LayoutElementBuilders.FONT_WEIGHT_BOLD)
                        .build(),
                )
            }
            builder.addSpan(SpanText.Builder().setText(c.text).setFontStyle(style.build()).build())
        }
        return if (reduceMotion) {
            builder.setOverflow(LayoutElementBuilders.TEXT_OVERFLOW_ELLIPSIZE_END).build()
        } else {
            builder.setOverflow(LayoutElementBuilders.TEXT_OVERFLOW_MARQUEE)
                .setMarqueeIterations(-1) // 무한 반복
                .build()
        }
    }

    /** 시스템 "애니메이션 제거"(동작 줄이기) 여부 — ValueAnimator.areAnimatorsEnabled()와 동일 신호. */
    private fun isReduceMotionEnabled(ctx: android.content.Context): Boolean = try {
        android.provider.Settings.Global.getFloat(
            ctx.contentResolver,
            android.provider.Settings.Global.ANIMATOR_DURATION_SCALE,
            1f,
        ) == 0f
    } catch (e: Exception) {
        false
    }

    private fun vspace(dpVal: Float): LayoutElement =
        Spacer.Builder().setHeight(dp(dpVal)).build()

    private fun hspace(dpVal: Float): LayoutElement =
        Spacer.Builder().setWidth(dp(dpVal)).build()
}
