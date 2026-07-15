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
                if (after != null && after != before) {
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
        val content = when (snap.kind) {
            "live" -> headerAndCard(snap, liveInner(snap))
            "final" -> headerAndCard(snap, finalInner(snap))
            "scheduled" -> headerAndCard(snap, scheduledInner(snap))
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
                    .setPadding(ModifiersBuilders.Padding.Builder().setAll(dp(8f)).build())
                    .build(),
            )
            .addContent(content)
            .build()
    }

    /** 상단 헤더: "LG · 2위 · 1.5G" (팀 하이라이트 컬러 + 순위) */
    private fun header(snap: WearSnapshot): LayoutElement {
        val myId = WearTeam.id(snap.myTeamCode)
        val name = WearTeam.short(snap.myTeamCode)
        val text = if (snap.rankLine.isEmpty()) name else "$name · ${snap.rankLine}"
        return text(text, 13f, WearTeam.highlightColor(myId), bold = true)
    }

    /** 헤더 + 라운드 카드 — 애플워치 WatchRootView(타이틀/카드/순위) 구조의 타일 판 */
    private fun headerAndCard(snap: WearSnapshot, inner: LayoutElement): LayoutElement =
        Column.Builder()
            .setHorizontalAlignment(LayoutElementBuilders.HORIZONTAL_ALIGN_CENTER)
            .addContent(header(snap))
            .addContent(vspace(6f))
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
                        .setStart(dp(16f)).setEnd(dp(16f))
                        .setTop(dp(10f)).setBottom(dp(10f))
                        .build(),
                )
                .build(),
        )
        .addContent(inner)
        .build()

    /** 예정: 매치업(vs) / 카운트다운(오늘, Dynamic) 또는 일시 라인 */
    private fun scheduledInner(snap: WearSnapshot): LayoutElement {
        val col = Column.Builder()
            .setHorizontalAlignment(LayoutElementBuilders.HORIZONTAL_ALIGN_CENTER)
            .addContent(matchupRow(snap, text("vs", 14f, WearTeam.COLOR_TEXT_SECONDARY, bold = true)))
            .addContent(vspace(5f))

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

    /** 라이브: 매치업(큰 스코어 가운데) / LIVE 라인 + 잔루 다이아몬드 / 지연 배지 */
    private fun liveInner(snap: WearSnapshot): LayoutElement {
        val col = Column.Builder()
            .setHorizontalAlignment(LayoutElementBuilders.HORIZONTAL_ALIGN_CENTER)
            .addContent(matchupRow(snap, scoreText(snap)))
            .addContent(vspace(5f))

        val liveRow = Row.Builder()
            .setVerticalAlignment(LayoutElementBuilders.VERTICAL_ALIGN_CENTER)
            .addContent(text(snap.line, 13f, WearTeam.COLOR_LIVE, bold = true))
        // 주자 1명 이상일 때만 다이아몬드 — 애플워치 #635(`b.any`) 패리티
        snap.bases?.takeIf { it.any }?.let {
            liveRow.addContent(hspace(6f))
            liveRow.addContent(baseDiamond(it))
        }
        col.addContent(liveRow.build())

        if (System.currentTimeMillis() - snap.updatedAt > WearTilePolicy.LIVE_DELAY_BADGE_MS) {
            col.addContent(vspace(2f))
            col.addContent(text("업데이트 지연", 11f, WearTeam.COLOR_TEXT_TERTIARY))
        }
        return col.build()
    }

    /** 종료: 매치업(최종 스코어 가운데) / "경기 종료 · 승" */
    private fun finalInner(snap: WearSnapshot): LayoutElement {
        return Column.Builder()
            .setHorizontalAlignment(LayoutElementBuilders.HORIZONTAL_ALIGN_CENTER)
            .addContent(matchupRow(snap, scoreText(snap)))
            .addContent(vspace(5f))
            .addContent(text(snap.line, 13f, WearTeam.COLOR_TEXT_SECONDARY, bold = true))
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
        row.addContent(text(WearTeam.short(snap.awayCode), 16f, WearTeam.COLOR_TEXT_PRIMARY, bold = true))
            .addContent(hspace(10f))
            .addContent(center)
            .addContent(hspace(10f))
            .addContent(text(WearTeam.short(snap.homeCode), 16f, WearTeam.COLOR_TEXT_PRIMARY, bold = true))
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
     * 라벨 규칙은 애플워치 circularScheduleLabel(#635) 동일:
     * 시작 전 1h 이상 "5:41 후" / 1h 미만 "41분 후"(0분은 "1분 후") / 시작 후 "곧 시작".
     */
    private fun countdownText(startAtMs: Long, colorArgb: Int): LayoutElement {
        val startInstant = DynamicInstant.withSecondsPrecision(Instant.ofEpochMilli(startAtMs))
        val duration = DynamicInstant.platformTimeWithSecondsPrecision().durationUntil(startInstant)
        val totalSecs = duration.toIntSeconds()
        val totalMins = duration.toIntMinutes()
        val hours = totalMins.div(60)
        val mins = totalMins.rem(60)

        val two = DynamicInt32.IntFormatter.Builder()
            .setMinIntegerDigits(2).setGroupingUsed(false).build()
        val plain = DynamicInt32.IntFormatter.Builder()
            .setMinIntegerDigits(1).setGroupingUsed(false).build()

        // "H:MM 후"
        val hmm = hours.format(plain)
            .concat(DynamicString.constant(":"))
            .concat(mins.format(two))
            .concat(DynamicString.constant(" 후"))
        // "M분 후"
        val minOnly = totalMins.format(plain).concat(DynamicString.constant("분 후"))

        val label = DynamicString.onCondition(totalSecs.lte(0))
            .use(DynamicString.constant("곧 시작"))
            .elseUse(
                DynamicString.onCondition(totalMins.lte(0))
                    .use(DynamicString.constant("1분 후")) // 0 < 남은 시간 < 1분
                    .elseUse(
                        DynamicString.onCondition(hours.lte(0))
                            .use(minOnly)
                            .elseUse(hmm),
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
                TypeBuilders.StringLayoutConstraint.Builder("88:88 후").build(),
            )
            .setFontStyle(
                FontStyle.Builder()
                    .setSize(sp(24f))
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

    private fun vspace(dpVal: Float): LayoutElement =
        Spacer.Builder().setHeight(dp(dpVal)).build()

    private fun hspace(dpVal: Float): LayoutElement =
        Spacer.Builder().setWidth(dp(dpVal)).build()
}
