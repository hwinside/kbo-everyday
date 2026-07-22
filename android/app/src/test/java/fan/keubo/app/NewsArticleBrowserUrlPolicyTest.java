package fan.keubo.app;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class NewsArticleBrowserUrlPolicyTest {
    @Test
    public void allowsOnlyTheExpectedCommentsOrigin() {
        assertTrue(NewsArticleBrowserUrlPolicy.isAllowedCommentsUrl(
            "https://keubo.fan/native/news-comments?url=https%3A%2F%2Fexample.com"
        ));
        assertTrue(NewsArticleBrowserUrlPolicy.isAllowedCommentsUrl(
            "https://keubo.fan:443/native/news-comments"
        ));

        assertFalse(NewsArticleBrowserUrlPolicy.isAllowedCommentsUrl(
            "https://keubo.fan:444/native/news-comments"
        ));
        assertFalse(NewsArticleBrowserUrlPolicy.isAllowedCommentsUrl(
            "https://user@keubo.fan/native/news-comments"
        ));
        assertFalse(NewsArticleBrowserUrlPolicy.isAllowedCommentsUrl(
            "https://keubo.fan.evil.example/native/news-comments"
        ));
        assertFalse(NewsArticleBrowserUrlPolicy.isAllowedCommentsUrl(
            "http://keubo.fan/native/news-comments"
        ));
        assertFalse(NewsArticleBrowserUrlPolicy.isAllowedCommentsUrl(
            "https://keubo.fan/native/news-comments/other"
        ));
    }
}
