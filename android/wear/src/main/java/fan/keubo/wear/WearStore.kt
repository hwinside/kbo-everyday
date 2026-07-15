package fan.keubo.wear

import android.content.Context
import android.content.SharedPreferences

/**
 * 워치 사이드 로컬 스토어 — 애플워치 WatchStore(App Group)의 SharedPreferences 판.
 * my_team은 폰이 Wearable Data Layer로 push한 값(MyTeamListenerService가 기록).
 */
object WearStore {
    private const val PREFS = "kbo_wear"
    private const val K_MY_TEAM = "my_team"
    private const val K_SNAPSHOT = "snapshot_cache"
    private const val K_LAST_SYNC = "last_sync_at"

    private fun prefs(ctx: Context): SharedPreferences =
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun loadMyTeam(ctx: Context): String = prefs(ctx).getString(K_MY_TEAM, "") ?: ""

    fun saveMyTeam(ctx: Context, code: String) {
        prefs(ctx).edit().putString(K_MY_TEAM, code.uppercase()).apply()
    }

    fun loadCachedSnapshot(ctx: Context): WearSnapshot? =
        WearSnapshot.fromJson(prefs(ctx).getString(K_SNAPSHOT, null))

    fun saveCachedSnapshot(ctx: Context, snap: WearSnapshot) {
        prefs(ctx).edit().putString(K_SNAPSHOT, snap.toJson()).apply()
    }

    /** 마지막 네트워크 sync 시각 — 타일 refresh 폭주 방지 스로틀용 */
    fun lastSyncAt(ctx: Context): Long = prefs(ctx).getLong(K_LAST_SYNC, 0L)

    fun markSyncedNow(ctx: Context) {
        prefs(ctx).edit().putLong(K_LAST_SYNC, System.currentTimeMillis()).apply()
    }
}
