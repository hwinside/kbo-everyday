import Capacitor
import SafariServices
import UIKit
import WebKit

@objc(NewsArticleBrowserPlugin)
public final class NewsArticleBrowserPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NewsArticleBrowserPlugin"
    public let jsName = "NewsArticleBrowser"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "open", returnType: CAPPluginReturnPromise),
    ]

    @objc func open(_ call: CAPPluginCall) {
        guard let rawURL = call.getString("url"),
              let articleURL = NewsArticleBrowserViewController.httpURL(rawURL) else {
            call.reject("A valid http(s) article URL is required")
            return
        }

        let commentsURL = call.getString("commentsUrl")
            .flatMap(NewsArticleBrowserViewController.commentsURL)

        DispatchQueue.main.async { [weak self] in
            guard let presenter = self?.bridge?.viewController else {
                call.reject("No presenting view controller")
                return
            }
            let controller = NewsArticleBrowserViewController(
                articleURL: articleURL,
                commentsURL: commentsURL
            )
            controller.modalPresentationStyle = .fullScreen
            presenter.present(controller, animated: true) {
                call.resolve()
            }
        }
    }
}

final class NewsArticleBrowserViewController: UIViewController {
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
              url.path == commentsPath else { return nil }
        return url
    }

    private let articleURL: URL
    private let commentsURL: URL?
    private let articleWebView: WKWebView
    private var commentsWebView: WKWebView?
    private let commentButton = UIButton(type: .system)
    private let backButton = UIButton(type: .system)
    private let forwardButton = UIButton(type: .system)
    private var loadErrorPresented = false

    init(articleURL: URL, commentsURL: URL?) {
        self.articleURL = articleURL
        self.commentsURL = commentsURL

        let articleConfiguration = WKWebViewConfiguration()
        articleConfiguration.websiteDataStore = .default()
        articleConfiguration.defaultWebpagePreferences.allowsContentJavaScript = true
        self.articleWebView = WKWebView(frame: .zero, configuration: articleConfiguration)
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        configureToolbar()
        configureArticleWebView()
        configureCommentBarIfNeeded()
        configureCommentsOverlayIfNeeded()
        articleWebView.load(URLRequest(url: articleURL))
    }

    deinit {
        commentsWebView?.configuration.userContentController
            .removeScriptMessageHandler(forName: "NewsCommentsBridge")
    }

    private func configureToolbar() {
        let toolbar = UIView()
        toolbar.translatesAutoresizingMaskIntoConstraints = false
        toolbar.backgroundColor = .secondarySystemBackground
        view.addSubview(toolbar)

        backButton.setImage(UIImage(systemName: "chevron.left"), for: .normal)
        backButton.accessibilityLabel = "뒤로"
        backButton.addTarget(self, action: #selector(goBack), for: .touchUpInside)
        forwardButton.setImage(UIImage(systemName: "chevron.right"), for: .normal)
        forwardButton.accessibilityLabel = "앞으로"
        forwardButton.addTarget(self, action: #selector(goForward), for: .touchUpInside)

        let title = UILabel()
        title.text = "뉴스 원문"
        title.font = .preferredFont(forTextStyle: .headline)
        title.textAlignment = .center

        let compatibilityButton = UIButton(type: .system)
        compatibilityButton.setTitle("호환 모드", for: .normal)
        compatibilityButton.titleLabel?.font = .preferredFont(forTextStyle: .footnote)
        compatibilityButton.addTarget(self, action: #selector(openCompatibilityMode), for: .touchUpInside)

        let closeButton = UIButton(type: .system)
        closeButton.setImage(UIImage(systemName: "xmark"), for: .normal)
        closeButton.accessibilityLabel = "닫기"
        closeButton.addTarget(self, action: #selector(closeBrowser), for: .touchUpInside)

        let stack = UIStackView(arrangedSubviews: [backButton, forwardButton, title, compatibilityButton, closeButton])
        stack.translatesAutoresizingMaskIntoConstraints = false
        stack.alignment = .center
        stack.spacing = 12
        toolbar.addSubview(stack)
        title.setContentHuggingPriority(.defaultLow, for: .horizontal)
        title.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        NSLayoutConstraint.activate([
            toolbar.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            toolbar.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            toolbar.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            toolbar.heightAnchor.constraint(equalToConstant: 50),
            stack.leadingAnchor.constraint(equalTo: toolbar.leadingAnchor, constant: 14),
            stack.trailingAnchor.constraint(equalTo: toolbar.trailingAnchor, constant: -14),
            stack.topAnchor.constraint(equalTo: toolbar.topAnchor),
            stack.bottomAnchor.constraint(equalTo: toolbar.bottomAnchor),
            backButton.widthAnchor.constraint(equalToConstant: 30),
            forwardButton.widthAnchor.constraint(equalToConstant: 30),
            closeButton.widthAnchor.constraint(equalToConstant: 30),
        ])
    }

    private func configureArticleWebView() {
        articleWebView.translatesAutoresizingMaskIntoConstraints = false
        articleWebView.navigationDelegate = self
        articleWebView.uiDelegate = self
        articleWebView.allowsBackForwardNavigationGestures = true
        view.insertSubview(articleWebView, at: 0)

        let top = view.safeAreaLayoutGuide.topAnchor
        let bottomConstant: CGFloat = commentsURL == nil ? 0 : -54
        NSLayoutConstraint.activate([
            articleWebView.topAnchor.constraint(equalTo: top, constant: 50),
            articleWebView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            articleWebView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            articleWebView.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: bottomConstant),
        ])
    }

    private func configureCommentBarIfNeeded() {
        guard commentsURL != nil else { return }
        commentButton.translatesAutoresizingMaskIntoConstraints = false
        commentButton.setTitle("  댓글", for: .normal)
        commentButton.setImage(UIImage(systemName: "bubble.left"), for: .normal)
        commentButton.titleLabel?.font = .preferredFont(forTextStyle: .headline)
        commentButton.backgroundColor = .secondarySystemBackground
        commentButton.layer.borderColor = UIColor.separator.cgColor
        commentButton.layer.borderWidth = 0.5
        commentButton.addTarget(self, action: #selector(showComments), for: .touchUpInside)
        view.addSubview(commentButton)

        NSLayoutConstraint.activate([
            commentButton.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            commentButton.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            commentButton.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
            commentButton.heightAnchor.constraint(equalToConstant: 54),
        ])
    }

    private func configureCommentsOverlayIfNeeded() {
        guard commentsURL != nil else { return }
        let controller = WKUserContentController()
        controller.add(self, name: "NewsCommentsBridge")
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.userContentController = controller
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.translatesAutoresizingMaskIntoConstraints = false
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.backgroundColor = .clear
        webView.isHidden = true
        view.addSubview(webView)
        NSLayoutConstraint.activate([
            webView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 50),
            webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            webView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])
        commentsWebView = webView
    }

    private func updateNavigationButtons() {
        backButton.isEnabled = articleWebView.canGoBack
        forwardButton.isEnabled = articleWebView.canGoForward
    }

    @objc private func closeBrowser() {
        dismiss(animated: true)
    }

    @objc private func goBack() {
        if articleWebView.canGoBack { articleWebView.goBack() }
    }

    @objc private func goForward() {
        if articleWebView.canGoForward { articleWebView.goForward() }
    }

    @objc private func showComments() {
        guard let commentsWebView, let commentsURL else { return }
        commentsWebView.isHidden = false
        if commentsWebView.url == nil {
            commentsWebView.load(URLRequest(url: commentsURL))
        }
    }

    @objc private func openCompatibilityMode() {
        present(SFSafariViewController(url: articleURL), animated: true)
    }

    private func showLoadError() {
        guard !loadErrorPresented, presentedViewController == nil else { return }
        loadErrorPresented = true
        let alert = UIAlertController(
            title: "원문을 열지 못했어요",
            message: "호환 모드로 다시 열 수 있어요.",
            preferredStyle: .alert
        )
        alert.addAction(UIAlertAction(title: "닫기", style: .cancel))
        alert.addAction(UIAlertAction(title: "호환 모드", style: .default) { [weak self] _ in
            self?.openCompatibilityMode()
        })
        present(alert, animated: true)
    }
}

extension NewsArticleBrowserViewController: WKNavigationDelegate {
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        updateNavigationButtons()
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        showLoadError()
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        guard let url = navigationAction.request.url,
              let scheme = url.scheme?.lowercased() else {
            decisionHandler(.cancel)
            return
        }
        if webView === commentsWebView {
            decisionHandler(Self.commentsURL(url.absoluteString) == nil ? .cancel : .allow)
            return
        }
        if scheme == "http" || scheme == "https" {
            decisionHandler(.allow)
        } else {
            if UIApplication.shared.canOpenURL(url) { UIApplication.shared.open(url) }
            decisionHandler(.cancel)
        }
    }
}

extension NewsArticleBrowserViewController: WKUIDelegate {
    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        guard webView === articleWebView else { return nil }
        if navigationAction.targetFrame == nil,
           let url = navigationAction.request.url,
           Self.httpURL(url.absoluteString) != nil {
            webView.load(URLRequest(url: url))
        }
        return nil
    }
}

extension NewsArticleBrowserViewController: WKScriptMessageHandler {
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "NewsCommentsBridge",
              let body = message.body as? [String: Any],
              let type = body["type"] as? String else { return }
        switch type {
        case "close":
            commentsWebView?.isHidden = true
        case "ready", "count":
            let count = (body["count"] as? NSNumber)?.intValue ?? 0
            commentButton.setTitle("  댓글 \(max(0, count))", for: .normal)
        default:
            break
        }
    }
}
