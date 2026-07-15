package fan.keubo.wear

import org.json.JSONObject

/**
 * 렌더 스냅샷 — 애플워치 WatchSnapshot(WatchData.swift)의 Kotlin 포트.
 * 타일이 그리는 최종 형태. SharedPreferences에 JSON으로 캐시(cache-first 렌더의 원천).
 */
data class WearBases(val first: Boolean, val second: Boolean, val third: Boolean) {
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
    val rankLine: String,    // "2위 · 1.5G" (미확보 시 "")
    val updatedAt: Long,     // epoch millis — live 캐시 5분 초과 시 "업데이트 지연" 판정
    val startAt: Long?,      // 예정 경기 시작 시각(epoch millis, KST 기준 파싱) — 카운트다운용
    val bases: WearBases?,   // 잔루 — live 외엔 null
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
        return o.toString()
    }

    companion object {
        fun noTeam(): WearSnapshot = WearSnapshot(
            kind = "noTeam", myTeamCode = "", awayCode = "", homeCode = "",
            awayScore = 0, homeScore = 0,
            line = "크보팬 앱에서 최애팀을 선택하세요", rankLine = "",
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
                )
            } catch (_: Exception) {
                null
            }
        }
    }
}
