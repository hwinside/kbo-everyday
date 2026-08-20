package fan.keubo.app;

import android.content.Intent;
import android.os.Bundle;
import android.view.View;
import android.webkit.WebView;

import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    // 웹뷰가 로드하는 원격 서버(capacitor.config server.url과 동일).
    private static final String BASE_URL = "https://keubo.fan";
    // 앱 전역 다크 배경(#0A0A0B) — 시스템 바 뒤 패딩 영역을 웹 배경과 일체화.
    private static final int APP_BACKGROUND_COLOR = 0xFF0A0A0B;

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
        applySystemBarInsets();
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

    /**
     * 시스템 바 인셋을 네이티브에서 결정론적으로 적용 (targetSdk 35+ 강제 엣지투엣지 대응).
     *
     * 배경: Capacitor 8 내장 SystemBars 플러그인은 WebView 메이저 버전(>=140)과
     * viewport-fit=cover 여부에 따라 "패스스루" 경로(웹 CSS env(safe-area-inset-*)에
     * 위임)를 타는데, 실기기(갤럭시 S25 · 3버튼 내비 등)에서 env() 값이 0으로 떨어져
     * 상·하단 UI가 상태바/내비바와 겹치는 제보가 반복됐다.
     *
     * 해법: 같은 뷰(웹뷰 부모)에 리스너를 다시 걸어 SystemBars의 버전 분기 리스너를
     * 대체하고, WebView 버전과 무관하게 항상 네이티브 패딩 경로를 강제한다.
     * 의미는 Capacitor SystemBars의 폴백(WebView<140) 경로와 동일하다:
     *  - 패딩: 시스템 바 + 디스플레이 컷아웃, 키보드 표시 중엔 하단을 IME 인셋으로 교체
     *    (targetSdk 35+에선 adjustResize가 무시되므로 IME 보정이 필수)
     *  - 웹뷰로 내려가는 인셋은 0으로 재설정 → 웹 env(safe-area-inset-*)이 이중
     *    적용되는 것을 구조적으로 차단 (fallback 0px과 합산돼도 변화 없음)
     *  - 패딩 영역 배경은 앱 다크 배경(#0A0A0B)으로 일체화
     */
    private void applySystemBarInsets() {
        Bridge bridge = getBridge();
        if (bridge == null) return;
        WebView webView = bridge.getWebView();
        if (webView == null) return;
        View insetHost = (webView.getParent() instanceof View) ? (View) webView.getParent() : webView;
        insetHost.setBackgroundColor(APP_BACKGROUND_COLOR);
        ViewCompat.setOnApplyWindowInsetsListener(insetHost, (view, insets) -> {
            Insets bars = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout()
            );
            Insets ime = insets.getInsets(WindowInsetsCompat.Type.ime());
            boolean keyboardVisible = insets.isVisible(WindowInsetsCompat.Type.ime());
            view.setPadding(
                bars.left,
                bars.top,
                bars.right,
                keyboardVisible ? ime.bottom : bars.bottom
            );
            // CONSUMED 반환은 Chromium safe-area 재계산을 깨뜨리므로(crbug 461332423)
            // SystemBars 폴백 경로와 동일하게 인셋을 명시적으로 0으로 재설정해 전달한다.
            return new WindowInsetsCompat.Builder(insets)
                .setInsets(
                    WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout(),
                    Insets.of(0, 0, 0, 0)
                )
                .build();
        });
        ViewCompat.requestApplyInsets(insetHost);
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
