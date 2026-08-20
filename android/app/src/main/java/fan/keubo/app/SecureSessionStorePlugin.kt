package fan.keubo.app

import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/**
 * 세션 토큰 백업 전용 secure storage 브릿지 — WebView 웹 저장소 퍼지 대응 (PR #1265).
 *
 * 저장소: EncryptedSharedPreferences(AndroidX Security) — Android Keystore 마스터키로
 * 키·값 모두 암호화된다. SharedPreferences 평문 저장(P0 보안 NO-GO 축)을 피하면서
 * WebView 저장소 소실과 무관하게 유지된다.
 *
 * 설치 생명주기 계약(삼순 2차 NO-GO ②): 업데이트=유지 / 재설치=삭제 / WebView 퍼지=복원.
 * - 백업/기기이전 제외: AndroidManifest dataExtractionRules·fullBackupContent 에서
 *   fan.keubo.secure-session-store.xml 을 exclude — Keystore 마스터키는 기기 밖으로
 *   안 나가므로 복원된 파일은 어차피 복호화 불가(이전 계정 부활 원천 차단).
 * - self-heal: 그래도 남은 복호화 불가 파일(구버전 백업 복원 등)은 생성 실패 시
 *   해당 prefs 파일을 지우고 1회 재생성 — 영구 크래시/영구 reject 루프 방지.
 */
@CapacitorPlugin(name = "SecureSessionStore")
class SecureSessionStorePlugin : Plugin() {

    companion object {
        private const val PREFS_NAME = "fan.keubo.secure-session-store"
    }

    private fun createPrefs(): android.content.SharedPreferences {
        val masterKey = MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        return EncryptedSharedPreferences.create(
            context,
            PREFS_NAME,
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    }

    private val prefs by lazy {
        try {
            createPrefs()
        } catch (e: Exception) {
            // 복호화 불가 파일(백업 복원 잔재 등) → 세션 백업은 재로그인으로 재생성
            // 가능한 데이터뿐이므로 파일 폐기 후 재생성 (fail-open 이 아니라 카테고리상 캐시)
            context.deleteSharedPreferences(PREFS_NAME)
            createPrefs()
        }
    }

    @PluginMethod
    fun get(call: PluginCall) {
        val key = call.getString("key")
        if (key.isNullOrEmpty()) {
            call.reject("key is required")
            return
        }
        try {
            val value = prefs.getString(key, null)
            val result = JSObject()
            if (value == null) result.put("value", JSObject.NULL) else result.put("value", value)
            call.resolve(result)
        } catch (e: Exception) {
            call.reject("secure get failed: ${e.message}")
        }
    }

    @PluginMethod
    fun set(call: PluginCall) {
        val key = call.getString("key")
        val value = call.getString("value")
        if (key.isNullOrEmpty() || value == null) {
            call.reject("key and value are required")
            return
        }
        try {
            prefs.edit().putString(key, value).apply()
            call.resolve()
        } catch (e: Exception) {
            call.reject("secure set failed: ${e.message}")
        }
    }

    @PluginMethod
    fun remove(call: PluginCall) {
        val key = call.getString("key")
        if (key.isNullOrEmpty()) {
            call.reject("key is required")
            return
        }
        try {
            prefs.edit().remove(key).apply()
            call.resolve()
        } catch (e: Exception) {
            call.reject("secure remove failed: ${e.message}")
        }
    }
}
