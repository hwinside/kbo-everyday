package fan.keubo.wear

import android.content.Context
import android.content.SharedPreferences
import java.util.Locale

/**
 * 워치 사이드 로컬 스토어 — 애플워치 WatchStore(App Group)의 SharedPreferences 판.
 * my_team은 폰이 Wearable Data Layer로 push한 값(MyTeamListenerService가 기록).
 * SharedPreferences 오버로드가 실제 로직 — Context 버전은 위임(유닛테스트는 fake prefs 주입).
 */
object WearStore {
    private const val PREFS = "kbo_wear"
    private const val K_MY_TEAM = "my_team"
    private const val K_SNAPSHOT = "snapshot_cache"
    private const val K_LAST_SYNC = "last_sync_at"
    private const val K_LAST_ATTEMPT = "last_sync_attempt_at"
    // push bridge(/kbo/game_state) 순서/중복 게이트용 — 마지막 수락 push의 ts·gameId
    private const val K_LAST_PUSH_TS = "last_push_ts"
    private const val K_LAST_PUSH_GID = "last_push_gid"
    // pull CAS generation(삼순 #723 2차) — 매 push 커밋마다 +1. ts로는 동일-ts terminal(live100→final100)
    // 변화를 감지 못해서, push 발생 자체를 감지하는 단조 증가 카운터.
    private const val K_PUSH_REV = "push_rev"

    // push 커밋과 pull 커밋의 read-modify-write를 직렬화(삼순 #723 pull CAS).
    // GameStateListenerService(push)와 WearFetcher(pull background thread)가 동시 접근.
    private val pushLock = Any()

    private fun prefs(ctx: Context): SharedPreferences =
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun loadMyTeam(ctx: Context): String = loadMyTeam(prefs(ctx))

    fun loadMyTeam(p: SharedPreferences): String = p.getString(K_MY_TEAM, "") ?: ""

    /**
     * 최애팀 저장 — 팀이 실제로 바뀌면(해제=빈 코드 포함) 이전 팀의 스냅샷·sync 마커를
     * 같은 커밋으로 무효화한다(atomic — 이전 팀 캐시가 새 팀 이름으로 렌더될 틈이 없다).
     * @return 변경 여부. 동일 팀 재선택이면 false(캐시 유지).
     */
    fun saveMyTeam(ctx: Context, code: String): Boolean = saveMyTeam(prefs(ctx), code)

    fun saveMyTeam(p: SharedPreferences, code: String): Boolean {
        val normalized = code.trim().uppercase(Locale.ROOT)
        if (normalized == loadMyTeam(p)) return false
        p.edit()
            .putString(K_MY_TEAM, normalized)
            .remove(K_SNAPSHOT)
            .remove(K_LAST_SYNC)
            .remove(K_LAST_ATTEMPT)
            .remove(K_LAST_PUSH_TS)
            .remove(K_LAST_PUSH_GID)
            .apply()
        return true
    }

    fun loadCachedSnapshot(ctx: Context): WearSnapshot? = loadCachedSnapshot(prefs(ctx))

    fun loadCachedSnapshot(p: SharedPreferences): WearSnapshot? =
        WearSnapshot.fromJson(p.getString(K_SNAPSHOT, null))

    fun saveCachedSnapshot(ctx: Context, snap: WearSnapshot) = saveCachedSnapshot(prefs(ctx), snap)

    fun saveCachedSnapshot(p: SharedPreferences, snap: WearSnapshot) {
        p.edit().putString(K_SNAPSHOT, snap.toJson()).apply()
    }

    /** 마지막 네트워크 sync 성공 시각 — 캐시 신선도(isStale) 판정용 */
    fun lastSyncAt(ctx: Context): Long = lastSyncAt(prefs(ctx))

    fun lastSyncAt(p: SharedPreferences): Long = p.getLong(K_LAST_SYNC, 0L)

    fun markSyncedNow(ctx: Context) {
        prefs(ctx).edit().putLong(K_LAST_SYNC, System.currentTimeMillis()).apply()
    }

    /** 마지막 sync 시도 시각(성공 여부 무관) — 실패 재시도 스로틀용 */
    fun lastSyncAttemptAt(ctx: Context): Long = lastSyncAttemptAt(prefs(ctx))

    fun lastSyncAttemptAt(p: SharedPreferences): Long = p.getLong(K_LAST_ATTEMPT, 0L)

    fun markSyncAttemptNow(ctx: Context) {
        prefs(ctx).edit().putLong(K_LAST_ATTEMPT, System.currentTimeMillis()).apply()
    }

    // ── push bridge 상태(GameStateListenerService) ──

    /** 마지막으로 수락한 push의 서버/수신 타임스탬프(같은 경기 out-of-order 역전 차단용). */
    fun lastPushTs(ctx: Context): Long = lastPushTs(prefs(ctx))

    fun lastPushTs(p: SharedPreferences): Long = p.getLong(K_LAST_PUSH_TS, 0L)

    /** 마지막으로 수락한 push의 gameId(경기 전환 감지·terminal stickiness 키). */
    fun lastPushGid(ctx: Context): String = lastPushGid(prefs(ctx))

    fun lastPushGid(p: SharedPreferences): String = p.getString(K_LAST_PUSH_GID, "") ?: ""

    /**
     * push 수락(Render) — 스냅샷 저장 + ts/gid 전진 + last_sync_at=now(폴백 pull 억제).
     * 한 커밋에 원자 기록: push가 반영된 순간 pull 경로는 이 캐시를 fresh로 본다.
     */
    fun savePushSnapshot(ctx: Context, snap: WearSnapshot, ts: Long, gid: String) =
        savePushSnapshot(prefs(ctx), snap, ts, gid)

    fun savePushSnapshot(p: SharedPreferences, snap: WearSnapshot, ts: Long, gid: String) {
        synchronized(pushLock) {
            p.edit()
                .putString(K_SNAPSHOT, snap.toJson())
                .putLong(K_LAST_PUSH_TS, ts)
                .putString(K_LAST_PUSH_GID, gid)
                .putLong(K_PUSH_REV, p.getLong(K_PUSH_REV, 0L) + 1L)
                .putLong(K_LAST_SYNC, System.currentTimeMillis())
                .apply()
        }
    }

    /** pull CAS generation — 매 push 커밋마다 증가(동일-ts terminal도 감지). */
    fun pushRevision(ctx: Context): Long = pushRevision(prefs(ctx))

    fun pushRevision(p: SharedPreferences): Long = p.getLong(K_PUSH_REV, 0L)

    /**
     * push NoOp(중복 콘텐츠) — 스냅샷은 그대로, ts/gid만 전진 + last_sync_at=now.
     * 내용이 같아 재렌더는 생략하되, 데이터가 현행임이 확인됐으니 폴백 pull은 억제한다.
     */
    fun savePushMeta(ctx: Context, ts: Long, gid: String) = savePushMeta(prefs(ctx), ts, gid)

    fun savePushMeta(p: SharedPreferences, ts: Long, gid: String) {
        synchronized(pushLock) {
            val now = System.currentTimeMillis()
            val e = p.edit()
                .putLong(K_LAST_PUSH_TS, ts)
                .putString(K_LAST_PUSH_GID, gid)
                .putLong(K_PUSH_REV, p.getLong(K_PUSH_REV, 0L) + 1L)
                .putLong(K_LAST_SYNC, now)
            // 삼순 #723 — NoOp lastSeenAt: 내용 동일(재렌더 생략)이지만 상태가 현행임을 확인했으니
            // 캐시 스냅샷의 updatedAt도 갱신한다 → 5분 뒤 가짜 '업데이트 지연' 배지 방지(updatedAt은
            // contentSignature 제외라 재렌더 트리거 안 됨).
            val cached = WearSnapshot.fromJson(p.getString(K_SNAPSHOT, null))
            if (cached != null) {
                e.putString(K_SNAPSHOT, cached.copy(updatedAt = now).toJson())
            }
            e.apply()
        }
    }

    /**
     * pull(fallback fetch) 커밋 — CAS(삼순 #723): pull 시작 시점에 측정한 expectedPushTs와
     * 현재 lastPushTs가 다르면(= pull 진행 중 push가 커밋됨) push가 더 fresh/권위 → pull 폐기.
     * `pull-start → final push → 늦은 pull 완료`가 terminal을 stale live로 덮는 것을 차단.
     * push가 없었으면(폰 미연결 등) expectedPushTs 일치 → 정상 커밋. 커밋 여부 반환.
     */
    fun commitPullSnapshot(ctx: Context, snap: WearSnapshot, expectedRev: Long): Boolean =
        commitPullSnapshot(prefs(ctx), snap, expectedRev)

    fun commitPullSnapshot(p: SharedPreferences, snap: WearSnapshot, expectedRev: Long): Boolean {
        synchronized(pushLock) {
            // CAS 기준을 ts → pushRevision으로(삼순 #723 2차): 동일-ts terminal push(live100→final100)이
            // pull 중 와도 rev가 +1 되므로 감지된다. rev 불일치 = pull 중 push 발생 → pull 폐기.
            if (p.getLong(K_PUSH_REV, 0L) != expectedRev) return false
            p.edit()
                .putString(K_SNAPSHOT, snap.toJson())
                .putLong(K_LAST_SYNC, System.currentTimeMillis())
                .apply()
            return true
        }
    }
}
