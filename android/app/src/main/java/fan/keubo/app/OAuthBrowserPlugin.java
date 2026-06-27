package fan.keubo.app;

import android.content.Intent;
import android.net.Uri;

import androidx.browser.customtabs.CustomTabsClient;
import androidx.browser.customtabs.CustomTabsIntent;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.Arrays;
import java.util.List;

/**
 * 소셜로그인 OAuth 전용 Custom Tab 런처.
 *
 * 기본 @capacitor/browser는 *사용자 기본 브라우저*로 Custom Tab을 연다. 삼성 기기에서 기본이
 * 삼성 인터넷이면, 구글 계정 선택 화면의 이메일 텍스트를 자동 mailto 링크화해서 탭 시 Gmail
 * 작성으로 튀는 버그가 있다(#cs 2026-06-23). OAuth만큼은 Chrome Custom Tab으로 강제해 회피한다.
 *
 * Chrome 미설치 시 setPackage를 생략해 기본 Custom Tab으로 폴백(최소한 로그인은 동작).
 * MainActivity가 launchMode=singleTask라 App Link 콜백 복귀 시 위에 떠 있던 Custom Tab은
 * 자동 정리되고, close()는 명시적으로 앱을 전면화한다.
 */
@CapacitorPlugin(name = "OAuthBrowser")
public class OAuthBrowserPlugin extends Plugin {

    // Custom Tab 강제 대상 = Chrome 계열만(기본 브라우저는 무시). ignoreDefault=true와 함께 사용.
    private static final List<String> CHROME_PACKAGES = Arrays.asList(
        "com.android.chrome",
        "com.chrome.beta",
        "com.chrome.dev",
        "com.google.android.apps.chrome"
    );

    @PluginMethod
    public void open(PluginCall call) {
        final String url = call.getString("url");
        if (url == null || url.isEmpty()) {
            call.reject("url is required");
            return;
        }
        getActivity().runOnUiThread(() -> {
            try {
                CustomTabsIntent customTabs = new CustomTabsIntent.Builder().build();
                // ignoreDefault=true: 사용자 기본(삼성 인터넷)을 무시하고 Chrome 계열에서만 선택.
                // 설치된 Chrome이 없으면 null → setPackage 생략(기본 Custom Tab 폴백).
                String pkg = CustomTabsClient.getPackageName(getContext(), CHROME_PACKAGES, true);
                if (pkg != null) {
                    customTabs.intent.setPackage(pkg);
                }
                customTabs.launchUrl(getActivity(), Uri.parse(url));
                call.resolve();
            } catch (Exception e) {
                call.reject("failed to open OAuth browser: " + e.getMessage());
            }
        });
    }

    @PluginMethod
    public void close(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            // singleTask MainActivity를 전면화 → 위에 떠 있는 Custom Tab 정리(재로드 없음).
            Intent intent = new Intent(getActivity(), MainActivity.class);
            intent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            getActivity().startActivity(intent);
            call.resolve();
        });
    }
}
