package fan.keubo.app;

import android.content.Intent;
import android.os.Bundle;
import android.webkit.WebView;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    // 웹뷰가 로드하는 원격 서버(capacitor.config server.url과 동일).
    private static final String BASE_URL = "https://keubo.fan";

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // 앱 타깃 커스텀 플러그인은 super.onCreate() 전에 등록해야 브리지가 인식.
        registerPlugin(GameNotificationPlugin.class);
        super.onCreate(savedInstanceState);
        // 잠금화면 카드 탭으로 (콜드 스타트) 진입 시 해당 경기룸으로 바로 이동(②).
        handleCardDeepLink(getIntent());
    }

    @Override
    public void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        // 앱이 이미 떠 있는 상태에서 카드 탭(FLAG_ACTIVITY_SINGLE_TOP) → 경기룸으로 이동.
        handleCardDeepLink(intent);
    }

    /** GameNotification 카드의 contentIntent extra(kbo_path)가 있으면 웹뷰를 그 경로로 이동. */
    private void handleCardDeepLink(Intent intent) {
        if (intent == null) return;
        String path = intent.getStringExtra(GameNotificationPlugin.EXTRA_PATH);
        if (path == null || path.isEmpty()) return;
        final String target = path.startsWith("http") ? path : BASE_URL + path;
        // 재진입 방지 — 같은 카드가 다시 deliver되지 않게 extra 소비.
        intent.removeExtra(GameNotificationPlugin.EXTRA_PATH);
        Bridge bridge = getBridge();
        if (bridge == null) return;
        final WebView webView = bridge.getWebView();
        if (webView == null) return;
        // 웹뷰는 UI 스레드에서만 조작. v1은 풀 로드로 해당 경기룸을 연다.
        webView.post(() -> webView.loadUrl(target));
    }
}
