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
 */
@CapacitorPlugin(name = "SecureSessionStore")
class SecureSessionStorePlugin : Plugin() {

    private val prefs by lazy {
        val masterKey = MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        EncryptedSharedPreferences.create(
            context,
            "fan.keubo.secure-session-store",
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
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
