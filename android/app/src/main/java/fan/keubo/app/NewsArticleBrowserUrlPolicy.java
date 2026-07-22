package fan.keubo.app;

import java.net.URI;
import java.net.URISyntaxException;

final class NewsArticleBrowserUrlPolicy {
    private static final String COMMENTS_HOST = "keubo.fan";
    private static final String COMMENTS_PATH = "/native/news-comments";

    private NewsArticleBrowserUrlPolicy() {}

    static boolean isAllowedCommentsUrl(String rawValue) {
        if (rawValue == null || rawValue.isEmpty()) return false;
        try {
            URI uri = new URI(rawValue);
            int port = uri.getPort();
            return "https".equalsIgnoreCase(uri.getScheme())
                && COMMENTS_HOST.equalsIgnoreCase(uri.getHost())
                && COMMENTS_PATH.equals(uri.getPath())
                && uri.getRawUserInfo() == null
                && (port == -1 || port == 443);
        } catch (URISyntaxException ignored) {
            return false;
        }
    }
}
