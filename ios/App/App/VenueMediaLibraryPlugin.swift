import AVFoundation
import Capacitor
import Photos
import PhotosUI
import UIKit

/// 직관 라이브 커스텀 그리드 픽커용 사진첩 브릿지 — PhotoKit(PHPhotoLibrary/PHAsset).
/// 원격 로드 WebView(server.url=keubo.fan)는 file:// / _capacitor_file_ 을 읽지 못하므로
/// 썸네일은 data URL, 원본은 cache export + base64 청크(readExport)로 내려준다.
/// export cache 는 releaseExport / 플러그인 해제 시 정리한다.
@objc(VenueMediaLibraryPlugin)
public class VenueMediaLibraryPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "VenueMediaLibraryPlugin"
    public let jsName = "VenueMediaLibrary"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getPermission", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestPermission", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "listMedia", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "exportMedia", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "readExport", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "releaseExport", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "presentLimitedPicker", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openSettings", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "selectionChanged", returnType: CAPPluginReturnPromise),
    ]

    private let workQueue = DispatchQueue(label: "fan.keubo.venue-media-library", qos: .userInitiated)
    /// export token → cache 파일 URL. releaseExport / deinit 에서 삭제.
    private var exports: [String: URL] = [:]
    private let exportsLock = NSLock()

    deinit {
        exportsLock.lock()
        let urls = exports.values
        exports.removeAll()
        exportsLock.unlock()
        for url in urls { try? FileManager.default.removeItem(at: url) }
    }

    private func permissionString(_ status: PHAuthorizationStatus) -> String {
        switch status {
        case .authorized: return "authorized"
        case .limited: return "limited"
        case .denied, .restricted: return "denied"
        case .notDetermined: return "prompt"
        @unknown default: return "denied"
        }
    }

    private func currentPermission() -> String {
        permissionString(PHPhotoLibrary.authorizationStatus(for: .readWrite))
    }

    @objc func getPermission(_ call: CAPPluginCall) {
        call.resolve(["permission": currentPermission()])
    }

    @objc func requestPermission(_ call: CAPPluginCall) {
        PHPhotoLibrary.requestAuthorization(for: .readWrite) { [weak self] status in
            guard let self else { return }
            call.resolve(["permission": self.permissionString(status)])
        }
    }

    /// JS `mediaTypes`("image" | "video" 배열) → PHFetch predicate.
    /// 미전달/빈 배열/미지 값은 기존 계약인 사진+영상 전체로 폴백한다(구웹 호환).
    private func mediaTypePredicate(_ raw: [String]?) -> NSPredicate {
        let requested = Set(raw ?? [])
        let wantsImage = requested.contains("image")
        let wantsVideo = requested.contains("video")
        if wantsImage && !wantsVideo {
            return NSPredicate(format: "mediaType == %d", PHAssetMediaType.image.rawValue)
        }
        if wantsVideo && !wantsImage {
            return NSPredicate(format: "mediaType == %d", PHAssetMediaType.video.rawValue)
        }
        return NSPredicate(
            format: "mediaType == %d OR mediaType == %d",
            PHAssetMediaType.image.rawValue,
            PHAssetMediaType.video.rawValue
        )
    }

    @objc func listMedia(_ call: CAPPluginCall) {
        let limit = call.getInt("limit") ?? 60
        let offset = Int(call.getString("cursor") ?? "0") ?? 0
        // 미디어 타입 필터 — 영상만/사진만 보기. cursor(offset)도 같은 필터된 fetch 기준이라
        // 페이징이 그 타입 안에서만 진행한다(혼합 목록을 받아 화면에서 걸러내던 구방식과 다름).
        let requestedTypes = call.getArray("mediaTypes", String.self)
        workQueue.async { [weak self] in
            guard let self else { return }
            let options = PHFetchOptions()
            options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
            options.predicate = self.mediaTypePredicate(requestedTypes)
            let fetch = PHAsset.fetchAssets(with: options)
            let total = fetch.count
            var assets: [[String: Any]] = []
            guard offset < total else {
                call.resolve([
                    "assets": assets,
                    "nextCursor": NSNull(),
                    "permission": self.currentPermission(),
                ])
                return
            }
            let end = min(offset + max(1, limit), total)
            let manager = PHImageManager.default()
            let thumbOptions = PHImageRequestOptions()
            thumbOptions.isSynchronous = true
            thumbOptions.deliveryMode = .opportunistic
            thumbOptions.resizeMode = .fast
            thumbOptions.isNetworkAccessAllowed = false
            let targetSize = CGSize(width: 240, height: 240)
            for index in offset..<end {
                let asset = fetch.object(at: index)
                var thumbnailUrl = ""
                manager.requestImage(
                    for: asset,
                    targetSize: targetSize,
                    contentMode: .aspectFill,
                    options: thumbOptions
                ) { image, _ in
                    if let data = image?.jpegData(compressionQuality: 0.7) {
                        thumbnailUrl = "data:image/jpeg;base64,\(data.base64EncodedString())"
                    }
                }
                let isVideo = asset.mediaType == .video
                assets.append([
                    "id": asset.localIdentifier,
                    "kind": isVideo ? "video" : "image",
                    "thumbnailUrl": thumbnailUrl,
                    "durationMs": isVideo ? Int(asset.duration * 1000) : NSNull(),
                    "createdAt": Int((asset.creationDate ?? Date()).timeIntervalSince1970 * 1000),
                ])
            }
            call.resolve([
                "assets": assets,
                "nextCursor": end < total ? String(end) : NSNull(),
                "permission": self.currentPermission(),
            ])
        }
    }

    @objc func exportMedia(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else {
            call.reject("id is required")
            return
        }
        workQueue.async { [weak self] in
            guard let self else { return }
            guard let asset = PHAsset.fetchAssets(withLocalIdentifiers: [id], options: nil).firstObject else {
                call.reject("asset not found")
                return
            }
            let resources = PHAssetResource.assetResources(for: asset)
            let primary = resources.first {
                $0.type == .photo || $0.type == .video || $0.type == .fullSizePhoto || $0.type == .fullSizeVideo
            } ?? resources.first
            let fileName = primary?.originalFilename ?? (asset.mediaType == .video ? "video.mov" : "photo.jpg")
            if asset.mediaType == .video {
                let videoOptions = PHVideoRequestOptions()
                videoOptions.isNetworkAccessAllowed = true // iCloud 원본도 내려받는다
                videoOptions.deliveryMode = .highQualityFormat
                PHImageManager.default().requestAVAsset(forVideo: asset, options: videoOptions) { avAsset, _, _ in
                    guard let urlAsset = avAsset as? AVURLAsset else {
                        call.reject("video export failed")
                        return
                    }
                    self.finishExport(call: call, sourceURL: urlAsset.url, fileName: fileName,
                                      mimeType: Self.mimeType(for: fileName, isVideo: true), asset: asset)
                }
            } else {
                let imageOptions = PHImageRequestOptions()
                imageOptions.isNetworkAccessAllowed = true
                imageOptions.deliveryMode = .highQualityFormat
                imageOptions.isSynchronous = false
                PHImageManager.default().requestImageDataAndOrientation(for: asset, options: imageOptions) { data, uti, _, _ in
                    guard let data else {
                        call.reject("image export failed")
                        return
                    }
                    self.finishExport(call: call, data: data, fileName: fileName,
                                      mimeType: uti.flatMap(Self.mimeType(forUTI:)) ?? Self.mimeType(for: fileName, isVideo: false),
                                      asset: asset)
                }
            }
        }
    }

    private func exportCacheURL(fileName: String, token: String) -> URL {
        let dir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("venue-media-exports", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("\(token)-\(fileName)")
    }

    private func finishExport(call: CAPPluginCall, sourceURL: URL? = nil, data: Data? = nil,
                              fileName: String, mimeType: String, asset: PHAsset) {
        let token = UUID().uuidString
        let dest = exportCacheURL(fileName: fileName, token: token)
        do {
            if let sourceURL {
                try? FileManager.default.removeItem(at: dest)
                try FileManager.default.copyItem(at: sourceURL, to: dest)
            } else if let data {
                try data.write(to: dest)
            } else {
                call.reject("export failed")
                return
            }
            let size = (try FileManager.default.attributesOfItem(atPath: dest.path)[.size] as? NSNumber)?.intValue ?? 0
            exportsLock.lock()
            exports[token] = dest
            exportsLock.unlock()
            call.resolve([
                "token": token,
                "fileName": fileName,
                "mimeType": mimeType,
                "size": size,
                "lastModified": Int((asset.creationDate ?? Date()).timeIntervalSince1970 * 1000),
            ])
        } catch {
            try? FileManager.default.removeItem(at: dest)
            call.reject("export failed: \(error.localizedDescription)")
        }
    }

    @objc func readExport(_ call: CAPPluginCall) {
        guard let token = call.getString("token") else {
            call.reject("token is required")
            return
        }
        let offset = call.getInt("offset") ?? 0
        let length = call.getInt("length") ?? 0
        exportsLock.lock()
        let url = exports[token]
        exportsLock.unlock()
        guard let url else {
            call.reject("export not found")
            return
        }
        workQueue.async {
            do {
                let handle = try FileHandle(forReadingFrom: url)
                defer { try? handle.close() }
                try handle.seek(toOffset: UInt64(max(0, offset)))
                let data = try handle.read(upToCount: max(0, length)) ?? Data()
                call.resolve(["data": data.base64EncodedString()])
            } catch {
                call.reject("read failed: \(error.localizedDescription)")
            }
        }
    }

    @objc func releaseExport(_ call: CAPPluginCall) {
        guard let token = call.getString("token") else {
            call.reject("token is required")
            return
        }
        exportsLock.lock()
        let url = exports.removeValue(forKey: token)
        exportsLock.unlock()
        if let url { try? FileManager.default.removeItem(at: url) }
        call.resolve()
    }

    /// Limited '더 보기' 재선택 시트 — 사용자가 선택을 **마친 뒤** resolve 한다(iOS 15+ completion).
    /// 시트를 띄우자마자 resolve 하면 호출부가 기존 목록을 재조회해 stale 화면이 남는다(삼순 라운드2 #1).
    @objc func presentLimitedPicker(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self, let vc = self.bridge?.viewController else {
                call.reject("no view controller")
                return
            }
            PHPhotoLibrary.shared().presentLimitedLibraryPicker(from: vc) { _ in
                DispatchQueue.main.async {
                    call.resolve(["permission": self.currentPermission()])
                }
            }
        }
    }

    @objc func openSettings(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let url = URL(string: UIApplication.openSettingsURLString) else {
                call.reject("settings url unavailable")
                return
            }
            UIApplication.shared.open(url)
            call.resolve()
        }
    }

    @objc func selectionChanged(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            UISelectionFeedbackGenerator().selectionChanged()
            call.resolve()
        }
    }

    private static func mimeType(for fileName: String, isVideo: Bool) -> String {
        switch (fileName as NSString).pathExtension.lowercased() {
        case "png": return "image/png"
        case "gif": return "image/gif"
        case "webp": return "image/webp"
        case "heic", "heif": return "image/heic"
        case "jpg", "jpeg": return "image/jpeg"
        case "mp4", "m4v": return "video/mp4"
        case "mov": return "video/quicktime"
        default: return isVideo ? "video/quicktime" : "image/jpeg"
        }
    }

    private static func mimeType(forUTI uti: String) -> String? {
        switch uti {
        case "public.jpeg": return "image/jpeg"
        case "public.png": return "image/png"
        case "public.heic", "public.heif": return "image/heic"
        case "com.compuserve.gif": return "image/gif"
        case "org.webmproject.webp", "public.webp": return "image/webp"
        default: return nil
        }
    }
}
