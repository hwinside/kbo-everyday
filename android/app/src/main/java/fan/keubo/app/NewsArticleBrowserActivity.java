package fan.keubo.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;

import androidx.browser.customtabs.CustomTabsIntent;

import org.json.JSONObject;

public class NewsArticleBrowserActivity extends Activity {
    public static final String EXTRA_URL = "news_article_url";
    public static final String EXTRA_COMMENTS_URL = "news_comments_url";
    public static final String EXTRA_TEAM_ID = "news_article_team_id";

    private WebView articleWebView;
    private WebView commentsWebView;
    private TextView commentCountLabel;
    private Uri articleUri;
    private String commentsUrl;
    private int teamId;
    private boolean loadErrorPresented;

    public static boolean isHttpUrl(String rawValue) {
        if (rawValue == null || rawValue.isEmpty()) return false;
        Uri uri = Uri.parse(rawValue);
        String scheme = uri.getScheme();
        return uri.getHost() != null
            && ("http".equalsIgnoreCase(scheme) || "https".equalsIgnoreCase(scheme));
    }

    public static String validCommentsUrl(String rawValue) {
        return NewsArticleBrowserUrlPolicy.isAllowedCommentsUrl(rawValue) ? rawValue : null;
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        String rawArticleUrl = getIntent().getStringExtra(EXTRA_URL);
        if (!isHttpUrl(rawArticleUrl)) {
            finish();
            return;
        }
        articleUri = Uri.parse(rawArticleUrl);
        commentsUrl = validCommentsUrl(
            getIntent().getStringExtra(EXTRA_COMMENTS_URL)
        );
        teamId = getIntent().getIntExtra(EXTRA_TEAM_ID, 0);
        setContentView(createLayout(rawArticleUrl, commentsUrl));
    }

    private View createLayout(String articleUrl, String commentsUrl) {
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.rgb(10, 10, 11));

        LinearLayout page = new LinearLayout(this);
        page.setOrientation(LinearLayout.VERTICAL);
        root.addView(page, new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT
        ));
        page.addView(createToolbar(), new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            dp(52)
        ));

        articleWebView = createArticleWebView();
        page.addView(articleWebView, new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            0,
            1
        ));

        if (commentsUrl != null) {
            page.addView(createCommentBar(), new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ));

            commentsWebView = createCommentsWebView();
            commentsWebView.setVisibility(View.GONE);
            FrameLayout.LayoutParams commentsLayout = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            );
            commentsLayout.topMargin = dp(52);
            root.addView(commentsWebView, commentsLayout);
        }

        articleWebView.loadUrl(articleUrl);
        return root;
    }

    private View createToolbar() {
        LinearLayout toolbar = new LinearLayout(this);
        toolbar.setGravity(Gravity.CENTER_VERTICAL);
        toolbar.setPadding(dp(8), 0, dp(8), 0);
        toolbar.setBackgroundColor(Color.rgb(0x14, 0x14, 0x16));

        Button back = toolbarButton("‹");
        back.setContentDescription("뒤로");
        back.setOnClickListener(view -> {
            if (articleWebView != null && articleWebView.canGoBack()) articleWebView.goBack();
        });
        toolbar.addView(back);

        Button forward = toolbarButton("›");
        forward.setContentDescription("앞으로");
        forward.setOnClickListener(view -> {
            if (articleWebView != null && articleWebView.canGoForward()) articleWebView.goForward();
        });
        toolbar.addView(forward);

        LinearLayout center = new LinearLayout(this);
        center.setOrientation(LinearLayout.HORIZONTAL);
        center.setGravity(Gravity.CENTER);

        ImageView badge = new ImageView(this);
        GradientDrawable badgeBg = new GradientDrawable();
        badgeBg.setShape(GradientDrawable.OVAL);
        badgeBg.setColor(Color.WHITE);
        badge.setBackground(badgeBg);
        badge.setScaleType(ImageView.ScaleType.FIT_CENTER);
        badge.setPadding(dp(3), dp(3), dp(3), dp(3));
        badge.setImageResource(brandBadgeRes());
        LinearLayout.LayoutParams badgeLp = new LinearLayout.LayoutParams(dp(24), dp(24));
        badgeLp.rightMargin = dp(8);
        center.addView(badge, badgeLp);

        TextView title = new TextView(this);
        title.setText("뉴스 원문");
        title.setTextColor(Color.WHITE);
        title.setTextSize(16);
        title.setTypeface(title.getTypeface(), android.graphics.Typeface.BOLD);
        center.addView(title);

        toolbar.addView(center, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, 1));

        Button close = toolbarButton("×");
        close.setContentDescription("닫기");
        close.setOnClickListener(view -> finish());
        toolbar.addView(close);
        return toolbar;
    }

    private int brandBadgeRes() {
        if (teamId > 0) {
            int id = getResources().getIdentifier(
                "team_logo_" + teamId, "drawable", getPackageName());
            if (id != 0) return id;
        }
        return getResources().getIdentifier(
            "news_brand_mark", "drawable", getPackageName());
    }

    private View createCommentBar() {
        LinearLayout container = new LinearLayout(this);
        container.setOrientation(LinearLayout.VERTICAL);

        View border = new View(this);
        border.setBackgroundColor(Color.argb(31, 255, 255, 255));
        container.addView(border, new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            Math.max(1, Math.round(0.5f * getResources().getDisplayMetrics().density))
        ));

        LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        bar.setBackgroundColor(Color.rgb(0x14, 0x14, 0x16));
        bar.setPadding(dp(16), 0, dp(16), 0);
        bar.setOnClickListener(view -> showComments());

        TextView icon = new TextView(this);
        GradientDrawable iconBg = new GradientDrawable();
        iconBg.setShape(GradientDrawable.RECTANGLE);
        iconBg.setCornerRadius(dp(8));
        iconBg.setColor(Color.rgb(0xFF, 0x45, 0x3A));
        icon.setBackground(iconBg);
        icon.setText("💬");
        icon.setTextSize(14);
        icon.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams iconLp = new LinearLayout.LayoutParams(dp(30), dp(30));
        iconLp.rightMargin = dp(10);
        bar.addView(icon, iconLp);

        TextView title = new TextView(this);
        title.setText("크보팬 댓글");
        title.setTextColor(Color.WHITE);
        title.setTextSize(15);
        title.setTypeface(title.getTypeface(), android.graphics.Typeface.BOLD);
        bar.addView(title);

        commentCountLabel = new TextView(this);
        commentCountLabel.setText("");
        commentCountLabel.setVisibility(View.GONE);
        commentCountLabel.setTextColor(Color.rgb(0xFF, 0x45, 0x3A));
        commentCountLabel.setTextSize(15);
        commentCountLabel.setTypeface(commentCountLabel.getTypeface(), android.graphics.Typeface.BOLD);
        LinearLayout.LayoutParams countLp = new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        countLp.leftMargin = dp(6);
        bar.addView(commentCountLabel, countLp);

        View spacer = new View(this);
        bar.addView(spacer, new LinearLayout.LayoutParams(0, 1, 1));

        TextView chevron = new TextView(this);
        chevron.setText("›");
        chevron.setTextColor(Color.argb(102, 255, 255, 255));
        chevron.setTextSize(22);
        bar.addView(chevron);

        container.addView(bar, new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, dp(56)));
        return container;
    }

    private Button toolbarButton(String label) {
        Button button = new Button(this);
        button.setAllCaps(false);
        button.setText(label);
        button.setTextColor(Color.WHITE);
        button.setTextSize(22);
        button.setBackgroundColor(Color.TRANSPARENT);
        button.setPadding(0, 0, 0, 0);
        button.setMinWidth(0);
        button.setMinimumWidth(0);
        return button;
    }

    @SuppressLint("SetJavaScriptEnabled")
    private WebView createArticleWebView() {
        WebView webView = new WebView(this);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setSupportMultipleWindows(false);
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true);
        webView.setWebChromeClient(new WebChromeClient());
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return handleNonHttpNavigation(request.getUrl());
            }

            @Override
            public void onReceivedError(
                WebView view,
                WebResourceRequest request,
                android.webkit.WebResourceError error
            ) {
                if (request.isForMainFrame()) showLoadError();
            }
        });
        return webView;
    }

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    private WebView createCommentsWebView() {
        WebView webView = new WebView(this);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        webView.setBackgroundColor(Color.TRANSPARENT);
        CookieManager.getInstance().setAcceptCookie(true);
        webView.addJavascriptInterface(new CommentsBridge(), "NewsCommentsBridge");
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return !NewsArticleBrowserUrlPolicy.isAllowedCommentsUrl(
                    request.getUrl().toString()
                );
            }
        });
        return webView;
    }

    private boolean handleNonHttpNavigation(Uri uri) {
        String scheme = uri.getScheme();
        if ("http".equalsIgnoreCase(scheme) || "https".equalsIgnoreCase(scheme)) {
            return false;
        }
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri));
        } catch (Exception ignored) {
            // The article remains open when no native handler exists.
        }
        return true;
    }

    private void showLoadError() {
        if (loadErrorPresented || isFinishing()) return;
        loadErrorPresented = true;
        runOnUiThread(() -> new AlertDialog.Builder(this)
            .setTitle("원문을 열지 못했어요")
            .setMessage("호환 모드로 다시 열 수 있어요.")
            .setNegativeButton("닫기", null)
            .setPositiveButton("호환 모드", (dialog, which) -> openCompatibilityMode())
            .show());
    }

    private void openCompatibilityMode() {
        new CustomTabsIntent.Builder().build().launchUrl(this, articleUri);
    }

    private void showComments() {
        if (commentsWebView == null || commentsUrl == null) return;
        commentsWebView.setVisibility(View.VISIBLE);
        if (commentsWebView.getUrl() == null) commentsWebView.loadUrl(commentsUrl);
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        if (commentsWebView != null && commentsWebView.getVisibility() == View.VISIBLE) {
            commentsWebView.setVisibility(View.GONE);
        } else if (articleWebView != null && articleWebView.canGoBack()) {
            articleWebView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onDestroy() {
        if (commentsWebView != null) {
            commentsWebView.removeJavascriptInterface("NewsCommentsBridge");
            commentsWebView.destroy();
        }
        if (articleWebView != null) articleWebView.destroy();
        super.onDestroy();
    }

    private final class CommentsBridge {
        @JavascriptInterface
        public void postMessage(String rawMessage) {
            runOnUiThread(() -> {
                try {
                    JSONObject message = new JSONObject(rawMessage);
                    String type = message.optString("type");
                    if ("close".equals(type)) {
                        commentsWebView.setVisibility(View.GONE);
                    } else if ("ready".equals(type) || "count".equals(type)) {
                        int count = Math.max(0, message.optInt("count", 0));
                        commentCountLabel.setText(String.valueOf(count));
                        commentCountLabel.setVisibility(View.VISIBLE);
                    }
                } catch (Exception ignored) {
                    // Ignore malformed messages from the internal comments page.
                }
            });
        }
    }
}
