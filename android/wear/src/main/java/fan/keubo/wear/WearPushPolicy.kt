package fan.keubo.wear

/**
 * 폰 → 워치 push bridge(/kbo/game_state) 게이트·스냅샷 합성 — 순수 함수(androidx/GMS 의존 없음).
 *
 * 삼순 NO-GO 주경로 전환: 라이브 20~40초 실시간 갱신은 freshness pull이 아니라
 * 폰 KboMessagingService(game_live/cancel/end FCM) → Data Layer urgent push →
 * GameStateListenerService가 이 정책으로 게이트 후 캐시 저장 + Tile/Complication requestUpdate.
 * freshness(60초)는 폰 단절 시 fallback 전용.
 *
 * 게이트(모두 여기서 순수 판정, 서비스는 DataMap→PushState 추출과 저장/requestUpdate만):
 *  - wrong-team drop     : away/home 어느 쪽도 워치 최애팀이 아니면 drop(팀 변경 레이스 방어)
 *  - stale/out-of-order  : 같은 gameId에서 ts가 마지막 수락분보다 과거면 drop(상태 역전 차단)
 *  - terminal 수렴/고착   : final/cancelled 캐시에 같은 경기 late-live가 오면 drop(경기 종료 후 역전 방지)
 *  - duplicate no-op      : content signature(updatedAt 제외) 동일이면 재렌더 생략(ts만 전진)
 *
 * #718(안드 위젯 fast-refresh)의 game_live FCM을 그대로 워치가 재사용하므로,
 * #718의 payload.data 시그니처 dedupe와 여기 duplicate no-op이 같은 신호로 맞물린다
 * (변한 경기만 워치도 재렌더 — 배터리/쿼터 부담 없음).
 */
object WearPushPolicy {

    /** DataMap에서 추출한 push 원본(서비스가 채움). team 코드는 KBO 2자리 대문자. */
    data class PushState(
        val gid: String,
        val ts: Long,
        val kind: String,       // "live" | "cancelled" | "final"
        val away: String,
        val home: String,
        val awayScore: Int,
        val homeScore: Int,
        val statusRaw: String,  // w_status ("LIVE 7회말" 등) — live 라인 합성용
        val outs: Int?,
        val diamond: String?,   // "101" = 1·3루 (char0=1루,1=2루,2=3루)
        val stadium: String?,
        val pitcher: String?,
        val batter: String?,
        val lastPlay: String?,
    )

    sealed class Decision {
        /** 캐시 저장 + Tile/Complication requestUpdate. */
        data class Render(val snapshot: WearSnapshot) : Decision()

        /** ts만 전진(중복 콘텐츠) — 재렌더 없음, fallback pull 억제 위해 last_sync 갱신은 서비스가 수행. */
        object NoOp : Decision()

        /** 무시(사유 기록용). */
        data class Drop(val reason: String) : Decision()
    }

    /**
     * @param myTeam       워치 로컬 최애팀 코드(대문자, 빈 문자열이면 미설정)
     * @param cached       현재 캐시 스냅샷(팀 일치 방어는 호출 전 처리 불요 — 여기서 판정)
     * @param lastPushTs   마지막 수락 push의 ts
     * @param lastPushGid  마지막 수락 push의 gameId
     */
    fun evaluate(
        myTeam: String,
        push: PushState,
        cached: WearSnapshot?,
        lastPushTs: Long,
        lastPushGid: String,
        nowMs: Long,
    ): Decision {
        val team = myTeam.trim().uppercase()
        if (team.isEmpty()) return Decision.Drop("no-team")

        val away = push.away.uppercase()
        val home = push.home.uppercase()
        // wrong-team: final은 team 필드가 비어올 수 있어(게임엔드 payload 최소화) cached로 팀 검증.
        if (push.kind != "final") {
            if (team != away && team != home) return Decision.Drop("wrong-team")
        }

        val sameGame = push.gid.isNotEmpty() && push.gid == lastPushGid

        // out-of-order: 같은 경기에서 ts 역전이면 drop(더 오래된/재전송 push가 최신 상태를 덮어쓰지 못하게).
        if (sameGame && push.ts < lastPushTs) return Decision.Drop("stale-ts")

        // terminal 고착: 같은 경기가 이미 종료/취소로 캐시됐는데 live가 오면 drop(역전 방지).
        if (sameGame && cached != null && (cached.kind == "final" || cached.kind == "cancelled") &&
            push.kind == "live"
        ) {
            return Decision.Drop("after-terminal")
        }

        val candidate = buildSnapshot(team, push, cached, nowMs)
            ?: return Decision.Drop("unbuildable")

        // duplicate no-op: 렌더 영향 필드가 캐시와 동일하면 재렌더 생략(ts만 전진).
        if (cached != null && candidate.contentSignature() == cached.contentSignature()) {
            return Decision.NoOp
        }
        return Decision.Render(candidate)
    }

    /**
     * push → WearSnapshot 합성(WearFetcher.compose의 push 판). 실패 시 null(서비스가 drop).
     * final은 w_* 없이 gameId만 오므로(게임엔드) 같은 경기 캐시를 종료 상태로 flip.
     */
    fun buildSnapshot(myTeam: String, push: PushState, cached: WearSnapshot?, nowMs: Long): WearSnapshot? {
        return when (push.kind) {
            "live" -> {
                val outsTxt = push.outs?.let { " · ${it}사" } ?: ""
                val line = push.statusRaw.trim()
                    .replace(Regex(" · \\d+사$"), "") // w_status에 이미 있으면 정규화
                    .ifEmpty { "LIVE" } + outsTxt
                WearSnapshot(
                    kind = "live", myTeamCode = myTeam,
                    awayCode = push.away.uppercase(), homeCode = push.home.uppercase(),
                    awayScore = push.awayScore, homeScore = push.homeScore,
                    line = line, rankLine = cached?.rankLine ?: "",
                    updatedAt = nowMs, startAt = null,
                    bases = basesFromDiamond(push.diamond),
                    venue = push.stadium?.ifEmpty { null },
                    outs = push.outs,
                    pitcher = push.pitcher?.ifEmpty { null },
                    batter = push.batter?.ifEmpty { null },
                    lastPlay = push.lastPlay?.ifEmpty { null },
                )
            }
            "cancelled" -> WearSnapshot(
                kind = "cancelled", myTeamCode = myTeam,
                awayCode = push.away.uppercase(), homeCode = push.home.uppercase(),
                awayScore = push.awayScore, homeScore = push.homeScore,
                line = "경기 취소", rankLine = cached?.rankLine ?: "",
                updatedAt = nowMs, startAt = null, bases = null,
                venue = push.stadium?.ifEmpty { null },
            )
            "final" -> {
                val aw = push.away.uppercase()
                val hm = push.home.uppercase()
                if (aw.isNotEmpty() && hm.isNotEmpty()) {
                    // 폰이 game_end 시 위젯 prefs에서 팀/점수를 실어보냄 → 직접 종료 스냅샷 합성
                    // (워치가 라이브 push를 못 받은 경우에도 종료로 수렴).
                    WearSnapshot(
                        kind = "final", myTeamCode = myTeam,
                        awayCode = aw, homeCode = hm,
                        awayScore = push.awayScore, homeScore = push.homeScore,
                        line = "경기 종료 · ${finalResult(myTeam, aw, push.awayScore, push.homeScore)}",
                        rankLine = cached?.rankLine ?: "",
                        updatedAt = nowMs, startAt = null, bases = null,
                        venue = push.stadium?.ifEmpty { null },
                    )
                } else {
                    // 최소 payload → 같은 경기 캐시를 종료로 flip. 단 live/final 캐시만(예정/다음경기
                    // 카드를 0:0 종료로 오변환하지 않게 — wrong-team보다 우선하는 안전가드).
                    val base = cached ?: return null
                    if (base.kind != "live" && base.kind != "final") return null
                    if (base.awayCode.isEmpty() || base.homeCode.isEmpty()) return null
                    base.copy(
                        kind = "final",
                        line = "경기 종료 · ${finalResult(myTeam, base.awayCode, base.awayScore, base.homeScore)}",
                        updatedAt = nowMs, bases = null,
                        outs = null, pitcher = null, batter = null, lastPlay = null,
                    )
                }
            }
            else -> null
        }
    }

    /** 최애팀 관점 승/패/무 라벨. */
    private fun finalResult(myTeam: String, awayCode: String, awayScore: Int, homeScore: Int): String {
        val myIsAway = awayCode.equals(myTeam, ignoreCase = true)
        val myScore = if (myIsAway) awayScore else homeScore
        val oppScore = if (myIsAway) homeScore else awayScore
        return when {
            myScore > oppScore -> "승"
            myScore < oppScore -> "패"
            else -> "무"
        }
    }

    /** "101" 3비트 → WearBases(1루·2루·3루). null/부적격이면 null(주자 없음/미제공). */
    fun basesFromDiamond(d: String?): WearBases? {
        if (d == null || d.length < 3) return null
        val b = WearBases(d[0] == '1', d[1] == '1', d[2] == '1')
        return if (b.any) b else null
    }
}
