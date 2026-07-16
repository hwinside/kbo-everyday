package fan.keubo.wear

import org.json.JSONObject

/**
 * 렌더 스냅샷 — 애플워치 WatchSnapshot(WatchData.swift)의 Kotlin 포트.
 * 타일이 그리는 최종 형태. SharedPreferences에 JSON으로 캐시(cache-first 렌더의 원천).
 */
data class WearBases(val first: Boolean, val second: Boolean, val third: Boolean) {
    /** 주자 1명 이상 — 다이아몬드는 이때만 렌더(애플워치 #635 `b.any` 패리티) */
    val any: Boolean get() = first || second || third

    fun toJson(): JSONObject = JSONObject()
        .put("first", first).put("second", second).put("third", third)

    companion object {
        fun fromJson(o: JSONObject?): WearBases? {
            if (o == null) return null
            return WearBases(
                o.optBoolean("first", false),
                o.optBoolean("second", false),
                o.optBoolean("third", false),
            )
        }
    }
}

data class WearSnapshot(
    val kind: String,        // "live" | "scheduled" | "final" | "cancelled" | "noGame" | "noTeam"
    val myTeamCode: String,
    val awayCode: String,
    val homeCode: String,
    val awayScore: Int,
    val homeScore: Int,
    val line: String,        // 상태 한 줄 ("LIVE 6회말 · 2사" / "오늘 18:30" / "경기 종료 · 승")
    val rankLine: String,    // "2위 · 1위와 1.5경기차" (미확보 시 "")
    val updatedAt: Long,     // epoch millis — live 캐시 5분 초과 시 "업데이트 지연" 판정
    val startAt: Long?,      // 예정 경기 시작 시각(epoch millis, KST 기준 파싱) — 카운트다운용
    val bases: WearBases?,   // 잔루 — live 외엔 null
    // 리치 필드(하린아빠 승인 목업) — 전부 nullable 기본값: 구버전 캐시 JSON 호환
    val venue: String? = null,     // 구장("잠실") — 카드 상단
    val outs: Int? = null,         // 아웃카운트 — live 하단 도트 행
    val pitcher: String? = null,   // 현재 투수 — live
    val batter: String? = null,    // 현재 타자 — live
    val lastPlay: String? = null,  // 최근 플레이 한 줄 — live
    val starters: String? = null,  // "선발 곡빈 vs 원태인" — scheduled
    val winPitcher: String? = null,  // 승리투수 — final (하린아빠 7/17)
    val losePitcher: String? = null, // 패전투수 — final
    val savePitcher: String? = null, // 세이브투수 — final(없으면 null)
) {
    val isLive: Boolean get() = kind == "live"
    val hasScore: Boolean get() = kind == "live" || kind == "final"

    fun toJson(): String {
        val o = JSONObject()
            .put("kind", kind)
            .put("myTeamCode", myTeamCode)
            .put("awayCode", awayCode)
            .put("homeCode", homeCode)
            .put("awayScore", awayScore)
            .put("homeScore", homeScore)
            .put("line", line)
            .put("rankLine", rankLine)
            .put("updatedAt", updatedAt)
        if (startAt != null) o.put("startAt", startAt)
        if (bases != null) o.put("bases", bases.toJson())
        if (venue != null) o.put("venue", venue)
        if (outs != null) o.put("outs", outs)
        if (pitcher != null) o.put("pitcher", pitcher)
        if (batter != null) o.put("batter", batter)
        if (lastPlay != null) o.put("lastPlay", lastPlay)
        if (starters != null) o.put("starters", starters)
        if (winPitcher != null) o.put("winPitcher", winPitcher)
        if (losePitcher != null) o.put("losePitcher", losePitcher)
        if (savePitcher != null) o.put("savePitcher", savePitcher)
        return o.toString()
    }

    companion object {
        fun noTeam(): WearSnapshot = WearSnapshot(
            kind = "noTeam", myTeamCode = "", awayCode = "", homeCode = "",
            awayScore = 0, homeScore = 0,
            line = "크보팬 앱에서 최애팀을 선택하세요", rankLine = "",
            updatedAt = System.currentTimeMillis(), startAt = null, bases = null,
        )

        /** 첫 실행(캐시 없음) placeholder — 네트워크를 기다리지 않고 즉시 렌더 */
        fun loading(myTeamCode: String): WearSnapshot = WearSnapshot(
            kind = "loading", myTeamCode = myTeamCode, awayCode = "", homeCode = "",
            awayScore = 0, homeScore = 0,
            line = "불러오는 중…", rankLine = "",
            updatedAt = System.currentTimeMillis(), startAt = null, bases = null,
        )

        fun fromJson(raw: String?): WearSnapshot? {
            if (raw.isNullOrEmpty()) return null
            return try {
                val o = JSONObject(raw)
                WearSnapshot(
                    kind = o.optString("kind", "noGame"),
                    myTeamCode = o.optString("myTeamCode", ""),
                    awayCode = o.optString("awayCode", ""),
                    homeCode = o.optString("homeCode", ""),
                    awayScore = o.optInt("awayScore", 0),
                    homeScore = o.optInt("homeScore", 0),
                    line = o.optString("line", ""),
                    rankLine = o.optString("rankLine", ""),
                    updatedAt = o.optLong("updatedAt", 0L),
                    startAt = if (o.has("startAt")) o.optLong("startAt") else null,
                    bases = WearBases.fromJson(o.optJSONObject("bases")),
                    venue = if (o.has("venue")) o.optString("venue") else null,
                    outs = if (o.has("outs")) o.optInt("outs") else null,
                    pitcher = if (o.has("pitcher")) o.optString("pitcher") else null,
                    batter = if (o.has("batter")) o.optString("batter") else null,
                    lastPlay = if (o.has("lastPlay")) o.optString("lastPlay") else null,
                    starters = if (o.has("starters")) o.optString("starters") else null,
                    winPitcher = if (o.has("winPitcher")) o.optString("winPitcher") else null,
                    losePitcher = if (o.has("losePitcher")) o.optString("losePitcher") else null,
                    savePitcher = if (o.has("savePitcher")) o.optString("savePitcher") else null,
                )
            } catch (_: Exception) {
                null
            }
        }
    }
}
