import Foundation
import WebKit

enum NewsArticleBrowserURLPolicy {
    private static let commentsHost = "keubo.fan"
    private static let commentsPath = "/native/news-comments"

    static func httpURL(_ rawValue: String) -> URL? {
        guard let url = URL(string: rawValue),
              let scheme = url.scheme?.lowercased(),
              url.host != nil,
              scheme == "http" || scheme == "https" else { return nil }
        return url
    }

    static func commentsURL(_ rawValue: String) -> URL? {
        guard let url = URL(string: rawValue),
              url.scheme?.lowercased() == "https",
              url.host?.lowercased() == commentsHost,
              url.path == commentsPath,
              url.user == nil,
              url.password == nil,
              url.port == nil || url.port == 443 else { return nil }
        return url
    }
}

final class WeakNewsCommentsMessageHandler: NSObject, WKScriptMessageHandler {
    weak var delegate: WKScriptMessageHandler?

    init(_ delegate: WKScriptMessageHandler) {
        self.delegate = delegate
    }

    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage
    ) {
        delegate?.userContentController(userContentController, didReceive: message)
    }
}
