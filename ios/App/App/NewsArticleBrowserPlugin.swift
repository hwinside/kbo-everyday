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
        let teamId = call.getInt("teamId")

        DispatchQueue.main.async { [weak self] in
            guard let presenter = self?.bridge?.viewController else {
                call.reject("No presenting view controller")
                return
            }
            let controller = NewsArticleBrowserViewController(
                articleURL: articleURL,
                commentsURL: commentsURL,
                teamId: teamId
            )
            controller.modalPresentationStyle = .fullScreen
            presenter.present(controller, animated: true) {
                call.resolve()
            }
        }
    }
}

final class NewsArticleBrowserViewController: UIViewController {
    static func httpURL(_ rawValue: String) -> URL? {
        NewsArticleBrowserURLPolicy.httpURL(rawValue)
    }

    static func commentsURL(_ rawValue: String) -> URL? {
        NewsArticleBrowserURLPolicy.commentsURL(rawValue)
    }

    private let articleURL: URL
    private let commentsURL: URL?
    private let teamId: Int?
    private let articleWebView: WKWebView
    private var commentsWebView: WKWebView?
    private let commentButton = UIButton(type: .system)
    private let commentCountLabel = UILabel()
    private let backButton = UIButton(type: .system)
    private let forwardButton = UIButton(type: .system)
    private var loadErrorPresented = false

    init(articleURL: URL, commentsURL: URL?, teamId: Int?) {
        self.articleURL = articleURL
        self.commentsURL = commentsURL
        self.teamId = teamId

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

    override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }

    override func viewDidLoad() {
        super.viewDidLoad()
        overrideUserInterfaceStyle = .dark
        view.backgroundColor = UIColor(red: 0x0A / 255, green: 0x0A / 255, blue: 0x0B / 255, alpha: 1)
        configureSafeAreaBackground()
        configureToolbar()
        configureArticleWebView()
        configureCommentBarIfNeeded()
        configureCommentsOverlayIfNeeded()
        articleWebView.load(URLRequest(url: articleURL))
    }

    private func configureSafeAreaBackground() {
        let chrome = UIColor(red: 0x14 / 255, green: 0x14 / 255, blue: 0x16 / 255, alpha: 1)
        let topFill = UIView()
        topFill.translatesAutoresizingMaskIntoConstraints = false
        topFill.backgroundColor = chrome
        topFill.isUserInteractionEnabled = false
        view.addSubview(topFill)
        let bottomFill = UIView()
        bottomFill.translatesAutoresizingMaskIntoConstraints = false
        bottomFill.backgroundColor = chrome
        bottomFill.isUserInteractionEnabled = false
        view.addSubview(bottomFill)
        NSLayoutConstraint.activate([
            topFill.topAnchor.constraint(equalTo: view.topAnchor),
            topFill.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            topFill.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            topFill.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            bottomFill.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
            bottomFill.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            bottomFill.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            bottomFill.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])
    }

    deinit {
        commentsWebView?.configuration.userContentController
            .removeScriptMessageHandler(forName: "NewsCommentsBridge")
    }

    private func configureToolbar() {
        let toolbar = UIView()
        toolbar.translatesAutoresizingMaskIntoConstraints = false
        toolbar.backgroundColor = UIColor(red: 0x14 / 255, green: 0x14 / 255, blue: 0x16 / 255, alpha: 1)
        view.addSubview(toolbar)

        backButton.setImage(UIImage(systemName: "chevron.left"), for: .normal)
        backButton.tintColor = .white
        backButton.accessibilityLabel = "뒤로"
        backButton.translatesAutoresizingMaskIntoConstraints = false
        backButton.addTarget(self, action: #selector(goBack), for: .touchUpInside)
        forwardButton.setImage(UIImage(systemName: "chevron.right"), for: .normal)
        forwardButton.tintColor = .white
        forwardButton.accessibilityLabel = "앞으로"
        forwardButton.translatesAutoresizingMaskIntoConstraints = false
        forwardButton.addTarget(self, action: #selector(goForward), for: .touchUpInside)

        let closeButton = UIButton(type: .system)
        closeButton.setImage(UIImage(systemName: "xmark"), for: .normal)
        closeButton.tintColor = .white
        closeButton.accessibilityLabel = "닫기"
        closeButton.translatesAutoresizingMaskIntoConstraints = false
        closeButton.addTarget(self, action: #selector(closeBrowser), for: .touchUpInside)

        let badge = makeBrandBadge()
        let title = UILabel()
        title.text = "뉴스 원문"
        title.font = .systemFont(ofSize: 16, weight: .semibold)
        title.textColor = .white

        let center = UIStackView(arrangedSubviews: [badge, title])
        center.translatesAutoresizingMaskIntoConstraints = false
        center.axis = .horizontal
        center.alignment = .center
        center.spacing = 8

        toolbar.addSubview(backButton)
        toolbar.addSubview(forwardButton)
        toolbar.addSubview(center)
        toolbar.addSubview(closeButton)

        NSLayoutConstraint.activate([
            toolbar.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            toolbar.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            toolbar.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            toolbar.heightAnchor.constraint(equalToConstant: 50),

            backButton.leadingAnchor.constraint(equalTo: toolbar.leadingAnchor, constant: 12),
            backButton.centerYAnchor.constraint(equalTo: toolbar.centerYAnchor),
            backButton.widthAnchor.constraint(equalToConstant: 30),
            forwardButton.leadingAnchor.constraint(equalTo: backButton.trailingAnchor, constant: 8),
            forwardButton.centerYAnchor.constraint(equalTo: toolbar.centerYAnchor),
            forwardButton.widthAnchor.constraint(equalToConstant: 30),

            closeButton.trailingAnchor.constraint(equalTo: toolbar.trailingAnchor, constant: -14),
            closeButton.centerYAnchor.constraint(equalTo: toolbar.centerYAnchor),
            closeButton.widthAnchor.constraint(equalToConstant: 30),

            center.centerXAnchor.constraint(equalTo: toolbar.centerXAnchor),
            center.centerYAnchor.constraint(equalTo: toolbar.centerYAnchor),
        ])
    }

    private func makeBrandBadge() -> UIView {
        let badge = UIView()
        badge.translatesAutoresizingMaskIntoConstraints = false
        badge.backgroundColor = .white
        badge.layer.cornerRadius = 12
        badge.clipsToBounds = true

        let imageView = UIImageView()
        imageView.translatesAutoresizingMaskIntoConstraints = false
        imageView.contentMode = .scaleAspectFit
        imageView.image = brandBadgeImage()
        badge.addSubview(imageView)

        NSLayoutConstraint.activate([
            badge.widthAnchor.constraint(equalToConstant: 24),
            badge.heightAnchor.constraint(equalToConstant: 24),
            imageView.centerXAnchor.constraint(equalTo: badge.centerXAnchor),
            imageView.centerYAnchor.constraint(equalTo: badge.centerYAnchor),
            imageView.widthAnchor.constraint(equalTo: badge.widthAnchor, constant: -6),
            imageView.heightAnchor.constraint(equalTo: badge.heightAnchor, constant: -6),
        ])
        return badge
    }

    private func brandBadgeImage() -> UIImage? {
        if let teamId, let logo = UIImage(named: "TeamLogo_\(teamId)") {
            return logo
        }
        return UIImage(named: "NewsBrandMark")
    }

    private func configureArticleWebView() {
        articleWebView.translatesAutoresizingMaskIntoConstraints = false
        articleWebView.navigationDelegate = self
        articleWebView.uiDelegate = self
        articleWebView.allowsBackForwardNavigationGestures = true
        view.insertSubview(articleWebView, at: 0)

        let top = view.safeAreaLayoutGuide.topAnchor
        let bottomConstant: CGFloat = commentsURL == nil ? 0 : -56
        NSLayoutConstraint.activate([
            articleWebView.topAnchor.constraint(equalTo: top, constant: 50),
            articleWebView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            articleWebView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            articleWebView.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: bottomConstant),
        ])
    }

    private func configureCommentBarIfNeeded() {
        guard commentsURL != nil else { return }
        let accent = UIColor(red: 0xFF / 255, green: 0x45 / 255, blue: 0x3A / 255, alpha: 1)
        commentButton.translatesAutoresizingMaskIntoConstraints = false
        commentButton.backgroundColor = UIColor(red: 0x14 / 255, green: 0x14 / 255, blue: 0x16 / 255, alpha: 1)
        commentButton.accessibilityLabel = "크보팬 댓글"
        commentButton.addTarget(self, action: #selector(showComments), for: .touchUpInside)

        let border = UIView()
        border.translatesAutoresizingMaskIntoConstraints = false
        border.backgroundColor = UIColor.white.withAlphaComponent(0.12)
        border.isUserInteractionEnabled = false

        let iconBadge = UIView()
        iconBadge.translatesAutoresizingMaskIntoConstraints = false
        iconBadge.backgroundColor = accent
        iconBadge.layer.cornerRadius = 8
        iconBadge.isUserInteractionEnabled = false
        let icon = UIImageView(image: UIImage(systemName: "bubble.left.fill"))
        icon.translatesAutoresizingMaskIntoConstraints = false
        icon.tintColor = .white
        icon.contentMode = .scaleAspectFit
        iconBadge.addSubview(icon)

        let titleLabel = UILabel()
        titleLabel.text = "크보팬 댓글"
        titleLabel.textColor = .white
        titleLabel.font = .systemFont(ofSize: 15, weight: .semibold)
        titleLabel.isUserInteractionEnabled = false

        commentCountLabel.text = nil
        commentCountLabel.isHidden = true
        commentCountLabel.textColor = accent
        commentCountLabel.font = .systemFont(ofSize: 15, weight: .semibold)
        commentCountLabel.isUserInteractionEnabled = false

        let chevron = UIImageView(image: UIImage(systemName: "chevron.right"))
        chevron.translatesAutoresizingMaskIntoConstraints = false
        chevron.tintColor = UIColor.white.withAlphaComponent(0.4)
        chevron.contentMode = .scaleAspectFit
        chevron.isUserInteractionEnabled = false

        let labelStack = UIStackView(arrangedSubviews: [titleLabel, commentCountLabel])
        labelStack.axis = .horizontal
        labelStack.spacing = 6
        labelStack.alignment = .center
        labelStack.isUserInteractionEnabled = false

        let spacer = UIView()
        spacer.isUserInteractionEnabled = false
        let row = UIStackView(arrangedSubviews: [iconBadge, labelStack, spacer, chevron])
        row.translatesAutoresizingMaskIntoConstraints = false
        row.axis = .horizontal
        row.alignment = .center
        row.spacing = 10
        row.isUserInteractionEnabled = false

        commentButton.addSubview(row)
        commentButton.addSubview(border)
        view.addSubview(commentButton)

        NSLayoutConstraint.activate([
            commentButton.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            commentButton.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            commentButton.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
            commentButton.heightAnchor.constraint(equalToConstant: 56),

            border.topAnchor.constraint(equalTo: commentButton.topAnchor),
            border.leadingAnchor.constraint(equalTo: commentButton.leadingAnchor),
            border.trailingAnchor.constraint(equalTo: commentButton.trailingAnchor),
            border.heightAnchor.constraint(equalToConstant: 0.5),

            row.leadingAnchor.constraint(equalTo: commentButton.leadingAnchor, constant: 16),
            row.trailingAnchor.constraint(equalTo: commentButton.trailingAnchor, constant: -16),
            row.centerYAnchor.constraint(equalTo: commentButton.centerYAnchor),

            iconBadge.widthAnchor.constraint(equalToConstant: 30),
            iconBadge.heightAnchor.constraint(equalToConstant: 30),
            icon.centerXAnchor.constraint(equalTo: iconBadge.centerXAnchor),
            icon.centerYAnchor.constraint(equalTo: iconBadge.centerYAnchor),
            icon.widthAnchor.constraint(equalToConstant: 17),
            icon.heightAnchor.constraint(equalToConstant: 17),
            chevron.widthAnchor.constraint(equalToConstant: 12),
        ])
    }

    private func configureCommentsOverlayIfNeeded() {
        guard commentsURL != nil else { return }
        let controller = WKUserContentController()
        controller.add(WeakNewsCommentsMessageHandler(self), name: "NewsCommentsBridge")
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.userContentController = controller
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
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
            commentCountLabel.text = "\(max(0, count))"
            commentCountLabel.isHidden = false
        default:
            break
        }
    }
}
