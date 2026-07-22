import Foundation
import WebKit

private final class MessageHandlerProbe: NSObject, WKScriptMessageHandler {
    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage
    ) {}
}

@main
private struct NewsArticleBrowserSupportTests {
    static func main() {
        precondition(NewsArticleBrowserURLPolicy.httpURL("https://news.example/article") != nil)
        precondition(NewsArticleBrowserURLPolicy.httpURL("javascript:alert(1)") == nil)

        let allowed = "https://keubo.fan/native/news-comments?url=https%3A%2F%2Fnews.example"
        precondition(NewsArticleBrowserURLPolicy.commentsURL(allowed) != nil)
        for blocked in [
            "https://evil.example/native/news-comments",
            "https://keubo.fan.evil.example/native/news-comments",
            "https://keubo.fan:444/native/news-comments",
            "https://user@keubo.fan/native/news-comments",
            "https://keubo.fan/native/other",
            "http://keubo.fan/native/news-comments",
        ] {
            precondition(
                NewsArticleBrowserURLPolicy.commentsURL(blocked) == nil,
                "unexpectedly allowed comments URL: \(blocked)"
            )
        }

        var retainedWrapper: WeakNewsCommentsMessageHandler?
        weak var releasedDelegate: MessageHandlerProbe?
        autoreleasepool {
            let delegate = MessageHandlerProbe()
            releasedDelegate = delegate
            retainedWrapper = WeakNewsCommentsMessageHandler(delegate)
        }
        precondition(releasedDelegate == nil)
        precondition(retainedWrapper?.delegate == nil)

        let reopenedDelegate = MessageHandlerProbe()
        let reopenedWrapper = WeakNewsCommentsMessageHandler(reopenedDelegate)
        precondition(reopenedWrapper.delegate === reopenedDelegate)

        print("iOS news WebView URL policy + weak bridge lifecycle: PASS")
    }
}
