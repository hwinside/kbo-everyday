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
}
