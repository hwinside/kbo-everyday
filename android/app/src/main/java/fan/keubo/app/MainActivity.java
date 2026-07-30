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
        registerPlugin(MetaAppEventsPlugin.class);
        registerPlugin(OAuthBrowserPlugin.class);
        registerPlugin(AppReviewPlugin.class);
        registerPlugin(NewsArticleBrowserPlugin.class);
        registerPlugin(VenueMediaLibraryPlugin.class);
        super.onCreate(savedInstanceState);
        lockWebViewTextZoom();
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

    /**
     * 웹뷰 textZoom을 100으로 고정.
     * 안드 WebView는 시스템 글꼴 크기 배율을 textZoom으로 그대로 적용하는데,
     * 고정폭 레이아웃(순위표 등)에서 텍스트만 커져 숫자가 겹치는 깨짐이 발생한다.
     * iOS WKWebView는 원격 웹 콘텐츠에 Dynamic Type을 적용하지 않으므로 100 고정이 플랫폼 패리티.
     */
    private void lockWebViewTextZoom() {
        Bridge bridge = getBridge();
        if (bridge == null) return;
        WebView webView = bridge.getWebView();
        if (webView == null) return;
        webView.getSettings().setTextZoom(100);
    }

    /** GameNotification 카드의 contentIntent extra(kbo_path)가 있으면 웹뷰를 그 경로로 이동. */
    private void handleCardDeepLink(Intent intent) {
        if (intent == null) return;
        String path = intent.getStringExtra(GameNotificationPlugin.EXTRA_PATH);
        // 재진입 방지 — 무효 path여도 extra는 먼저 소비.
        intent.removeExtra(GameNotificationPlugin.EXTRA_PATH);
        // 경기룸 내부 경로(/games/...)만 허용 — 절대 URL/오픈 리다이렉트로 외부 페이지가
        // 웹뷰에 열리는 걸 차단(삼순 리뷰). 이 기능 스코프는 경기룸 딥링크뿐.
        if (path == null || !path.startsWith("/games/")) return;
        final String target = BASE_URL + path;
        Bridge bridge = getBridge();
        if (bridge == null) return;
        final WebView webView = bridge.getWebView();
        if (webView == null) return;
        // 웹뷰는 UI 스레드에서만 조작. v1은 풀 로드로 해당 경기룸을 연다.
        webView.post(() -> webView.loadUrl(target));
    }
}
