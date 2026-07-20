package fan.keubo.wear

import android.content.Context
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.YearMonth
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/**
 * keubo.fan 공개 API → WearSnapshot 합성 — 애플워치 WatchFetcher(WatchData.swift) 포트.
 * 서버 무변경 원칙: /api/games · /api/standings · /api/team-schedule 직접 fetch.
 * 모든 함수는 동기(블로킹) — 반드시 백그라운드 스레드에서 호출한다(타일은 cache-first라 UI 비블로킹).
 */
object WearFetcher {
    private const val BASE = "https://keubo.fan"
    private const val UA = "kbo-everyday-wear/1.0"
    private const val TIMEOUT_MS = 8000

    private val KST: ZoneId = ZoneId.of("Asia/Seoul")
    private val YMD: DateTimeFormatter = DateTimeFormatter.ofPattern("yyyyMMdd")

    /** 홈 팀카드/홈위젯/애플워치와 동일한 06시 롤오버: 06:00 KST 전엔 전날 경기. */
    fun effectiveDateString(nowMs: Long = System.currentTimeMillis()): String {
        val now = java.time.Instant.ofEpochMilli(nowMs).atZone(KST)
        val target = if (now.hour < 6) now.minusDays(1) else now
        return target.format(YMD)
    }

    private fun get(path: String): String? {
        return try {
            val conn = URL(BASE + path).openConnection() as HttpURLConnection
            conn.connectTimeout = TIMEOUT_MS
            conn.readTimeout = TIMEOUT_MS
            conn.setRequestProperty("User-Agent", UA)
            try {
                if (conn.responseCode != 200) return null
                conn.inputStream.bufferedReader().use { it.readText() }
            } finally {
                conn.disconnect()
            }
        } catch (_: Exception) {
            null
        }
    }

    /**
     * 최애팀 기준 스냅샷 합성(동기). 실패 시 캐시 폴백, 캐시도 없으면 최소 스냅샷.
     * 성공 시 캐시 저장 + last_sync 마킹.
     */
    fun fetch(ctx: Context): WearSnapshot {
        val myCode = WearStore.loadMyTeam(ctx)
        if (myCode.isEmpty()) return WearSnapshot.noTeam()
        val myId = WearTeam.id(myCode)

        // 삼순 #723 pull CAS — 네트워크 시작 전 push watermark 측정. 커밋 시 이 값이 바뀌었으면
        // (= pull 진행 중 push가 커밋됨) pull 결과를 버린다(늦은 pull이 terminal을 live로 덮는 것 방지).
        val pushTsBefore = WearStore.lastPushTs(ctx)

        val gamesRaw = get("/api/games?date=${effectiveDateString()}")
        val standingsRaw = get("/api/standings")

        val rankLine = parseRankLine(standingsRaw, myId)

        if (gamesRaw == null) {
            // 경기 fetch 실패 → 같은 팀 캐시 폴백 (stale이어도 빈 화면보단 낫다)
            val cached = WearStore.loadCachedSnapshot(ctx)
            if (cached != null && cached.myTeamCode == myCode) return cached
            return WearSnapshot(
                kind = "noGame", myTeamCode = myCode, awayCode = "", homeCode = "",
                awayScore = 0, homeScore = 0, line = "불러오기 실패", rankLine = rankLine,
                updatedAt = System.currentTimeMillis(), startAt = null, bases = null,
            )
        }

        var snap = compose(myCode, myId, gamesRaw, rankLine)

        // 오늘 최애팀 경기 없음 → 다음 예정 경기 폴백 (올스타 브레이크·휴식일 대응)
        if (snap.kind == "noGame") {
            fetchNextGame(myCode, myId, rankLine)?.let { snap = it }
        }

        // 라이브: 문자중계 최근 플레이 한 줄(실패 시 null — 카드 무영향)
        if (snap.kind == "live") {
            pickGame(gamesRaw, myId)?.optString("gameId", "")?.takeIf { it.isNotEmpty() }?.let { gid ->
                snap = snap.copy(lastPlay = fetchLastPlay(gid))
            }
        }

        // CAS 커밋: pull 진행 중 push가 없었을 때만 저장(push가 끊어들었으면 그게 더 fresh라 pull 폐기).
        WearStore.commitPullSnapshot(ctx, snap, pushTsBefore)
        return snap
    }

    /** 마지막 non-empty 이닝의 마지막 play → "타자 결과"(40자 캡) — 서버 warmup latestRelayLine 동일 규칙. */
    private fun fetchLastPlay(gameId: String): String? {
        val raw = get("/api/game-relay?gameId=$gameId") ?: return null
        return try {
            val innings = JSONObject(raw).optJSONArray("innings") ?: return null
            var name = ""
            var result = ""
            for (i in 0 until innings.length()) {
                val plays = innings.optJSONObject(i)?.optJSONArray("plays") ?: continue
                if (plays.length() == 0) continue
                val last = plays.optJSONObject(plays.length() - 1) ?: continue
                name = last.optString("batterName", "")
                result = last.optString("result", "")
            }
            if (name.isEmpty() || result.isEmpty()) return null
            val line = "$name $result"
            if (line.length > 40) line.substring(0, 39) + "…" else line
        } catch (_: Exception) {
            null
        }
    }

    private fun parseRankLine(raw: String?, myId: Int): String {
        if (raw == null) return ""
        return try {
            val arr = JSONObject(raw).optJSONArray("standings") ?: return ""
            for (i in 0 until arr.length()) {
                val row = arr.optJSONObject(i) ?: continue
                if (row.optInt("teamId", 0) != myId) continue
                // ranking 0(미제공)이면 배열 순서 폴백 — 폰 resolveRows/애플워치 동일
                var ranking = row.optInt("ranking", 0)
                if (ranking <= 0) ranking = i + 1
                val gb = row.optDouble("gamesBehind", 0.0)
                if (gb <= 0) return "${ranking}위"
                val gbText = if (gb == Math.floor(gb)) {
                    gb.toInt().toString()
                } else {
                    String.format(java.util.Locale.US, "%.1f", gb)
                }
                return "${ranking}위 · 1위와 ${gbText}경기차"
            }
            ""
        } catch (_: Exception) {
            ""
        }
    }

    /** 더블헤더 대비 선택 우선순위: live > scheduled(첫) > final(마지막) > 마지막(cancelled). */
    private fun pickGame(gamesRaw: String, myId: Int): JSONObject? {
        val arr = try {
            JSONObject(gamesRaw).optJSONArray("games")
        } catch (_: Exception) {
            null
        } ?: return null

        val mine = ArrayList<JSONObject>()
        for (i in 0 until arr.length()) {
            val g = arr.optJSONObject(i) ?: continue
            if (g.optInt("awayTeamId", 0) == myId || g.optInt("homeTeamId", 0) == myId) mine.add(g)
        }
        if (mine.isEmpty()) return null
        mine.firstOrNull { it.optString("status") == "live" }?.let { return it }
        mine.firstOrNull { it.optString("status") == "scheduled" }?.let { return it }
        mine.lastOrNull { it.optString("status") == "final" }?.let { return it }
        return mine.last()
    }

    private fun compose(myCode: String, myId: Int, gamesRaw: String, rankLine: String): WearSnapshot {
        val g = pickGame(gamesRaw, myId) ?: return WearSnapshot(
            kind = "noGame", myTeamCode = myCode, awayCode = "", homeCode = "",
            awayScore = 0, homeScore = 0, line = "오늘 경기 없음", rankLine = rankLine,
            updatedAt = System.currentTimeMillis(), startAt = null, bases = null,
        )

        val status = g.optString("status", "scheduled")
        val awayId = g.optInt("awayTeamId", 0)
        val homeId = g.optInt("homeTeamId", 0)
        val myIsAway = awayId == myId
        val aScore = g.optInt("awayScore", 0)
        val hScore = g.optInt("homeScore", 0)
        val time = g.optString("time", "")

        val stadium = g.optString("stadium", "")
        val line = when (status) {
            "live" -> {
                val half = if (g.optBoolean("isTop", true)) "초" else "말"
                "LIVE ${g.optInt("inning", 0)}회$half · ${g.optInt("outs", 0)}사"
            }
            "final" -> {
                val myScore = if (myIsAway) aScore else hScore
                val oppScore = if (myIsAway) hScore else aScore
                val result = if (myScore > oppScore) "승" else if (myScore < oppScore) "패" else "무"
                "경기 종료 · $result"
            }
            "cancelled" -> "경기 취소"
            else -> "오늘 $time"   // 구장은 venue 필드로 카드 상단 표기(목업)
        }

        val startAt = if (status == "scheduled") startMillis(effectiveDateString(), time) else null
        val bases = if (status == "live") {
            WearBases.fromJson(g.optJSONObject("runnersOn"))
        } else null

        // 리치 필드(목업): live=아웃·투타 / scheduled=선발 매치업
        val outs = if (status == "live") g.optInt("outs", 0) else null
        val pitcher = if (status == "live") g.optString("currentPitcher", "").ifEmpty { null } else null
        val batter = if (status == "live") g.optString("currentBatter", "").ifEmpty { null } else null
        val awayStarter = g.optString("awayStarterName", "")
        val homeStarter = g.optString("homeStarterName", "")
        val starters = if (status == "scheduled" && awayStarter.isNotEmpty() && homeStarter.isNotEmpty()) {
            "$awayStarter · $homeStarter"   // 이름만 — 타일이 '선발' 라벨+핑크 도트 렌더(목업 v2)
        } else null
        // 종료: 승/패/세이브 투수(목업 7/17) — 빈 문자열은 null로 행 생략
        val winPitcher = if (status == "final") g.optString("winPitcher", "").ifEmpty { null } else null
        val losePitcher = if (status == "final") g.optString("losePitcher", "").ifEmpty { null } else null
        val savePitcher = if (status == "final") g.optString("savePitcher", "").ifEmpty { null } else null

        return WearSnapshot(
            kind = status, myTeamCode = myCode,
            awayCode = WearTeam.code(awayId), homeCode = WearTeam.code(homeId),
            awayScore = aScore, homeScore = hScore,
            line = line, rankLine = rankLine,
            updatedAt = System.currentTimeMillis(), startAt = startAt, bases = bases,
            venue = stadium.ifEmpty { null }, outs = outs, pitcher = pitcher, batter = batter,
            starters = starters,
            winPitcher = winPitcher, losePitcher = losePitcher, savePitcher = savePitcher,
            // pull 캐시에도 gameId 저장(삼순) → push bridge terminal이 gid 일치할 때만 수립하도록.
            gameId = g.optString("gameId", "").ifEmpty { null },
        )
    }

    // ── 다음 예정 경기 폴백 (오늘 경기 없을 때만) — 이달 → 다음달 ──

    private fun monthStrings(): List<String> {
        val cur = YearMonth.now(KST)
        val f = DateTimeFormatter.ofPattern("yyyy-MM")
        return listOf(cur.format(f), cur.plusMonths(1).format(f))
    }

    private fun fetchNextGame(myCode: String, myId: Int, rankLine: String): WearSnapshot? {
        val slug = WearTeam.slug(myId)
        if (slug.isEmpty()) return null
        val fromDate = effectiveDateString()

        for (month in monthStrings()) {
            val raw = get("/api/team-schedule?team=$slug&month=$month") ?: continue
            val days = try {
                JSONObject(raw).optJSONArray("days")
            } catch (_: Exception) {
                null
            } ?: continue

            for (i in 0 until days.length()) {
                val day = days.optJSONObject(i) ?: continue
                val date = day.optString("date", "")
                if (day.optString("status") != "scheduled" || date < fromDate) continue

                val oppId = day.optJSONObject("opponent")?.optInt("id", 0) ?: 0
                val oppCode = WearTeam.code(oppId)
                val home = day.optBoolean("home", false)
                val time = day.optString("time", "")
                val stadium = day.optString("stadium", "")
                return WearSnapshot(
                    kind = "scheduled", myTeamCode = myCode,
                    awayCode = if (home) oppCode else myCode,
                    homeCode = if (home) myCode else oppCode,
                    awayScore = 0, homeScore = 0,
                    line = scheduleLine(date, time), rankLine = rankLine,
                    updatedAt = System.currentTimeMillis(),
                    startAt = startMillis(date, time), bases = null,
                    venue = stadium.ifEmpty { null },
                )
            }
        }
        return null
    }

    /** "YYYYMMDD" + "18:30" → epoch millis(KST). 시간 없으면 null(카운트다운 불가). */
    fun startMillis(dateYMD: String, time: String): Long? {
        if (time.isEmpty() || dateYMD.length != 8) return null
        return try {
            val dt = LocalDateTime.parse(
                "$dateYMD $time",
                DateTimeFormatter.ofPattern("yyyyMMdd HH:mm"),
            )
            dt.atZone(KST).toInstant().toEpochMilli()
        } catch (_: Exception) {
            null
        }
    }

    /** "YYYYMMDD" + "18:30" → "7/15(수) 18:30" — 애플워치 scheduleLine 동일 포맷. */
    private fun scheduleLine(dateYMD: String, time: String): String {
        val d = try {
            LocalDate.parse(dateYMD, YMD)
        } catch (_: Exception) {
            return if (time.isEmpty()) "다음 경기 예정" else time
        }
        val dow = arrayOf("월", "화", "수", "목", "금", "토", "일")[d.dayOfWeek.value - 1]
        val datePart = "${d.monthValue}/${d.dayOfMonth}($dow)"
        return if (time.isEmpty()) datePart else "$datePart $time"
    }

    /** 예정 경기 시작이 (06시 롤오버 기준) 오늘인지 — 오늘이면 카운트다운, 아니면 날짜 표기. */
    fun isCountdownToday(startAtMs: Long, refMs: Long = System.currentTimeMillis()): Boolean {
        val startYmd = java.time.Instant.ofEpochMilli(startAtMs).atZone(KST).format(YMD)
        return startYmd == effectiveDateString(refMs)
    }

    /** 시작 1시간 이내 임박(오늘 한정) — 앰버 강조. 애플워치 isCountdownImminent 동일. */
    fun isImminent(startAtMs: Long?, refMs: Long = System.currentTimeMillis()): Boolean {
        if (startAtMs == null || !isCountdownToday(startAtMs, refMs)) return false
        val secs = (startAtMs - refMs) / 1000
        return secs in 1..3600
    }

    /** 미래(오늘 아님) 경기 날짜 라벨 "7/16" — 카운트다운 대신 표기. */
    fun futureDateLabel(startAtMs: Long): String {
        val d = java.time.Instant.ofEpochMilli(startAtMs).atZone(KST)
        return "${d.monthValue}/${d.dayOfMonth}"
    }
}
