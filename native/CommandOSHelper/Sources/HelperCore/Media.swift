import AppKit
import CoreGraphics
import Foundation
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers
import Vision

public enum ImageTools {
    static func loadImage(_ path: String) throws -> (CGImage, String?) {
        let url = URL(fileURLWithPath: path)
        guard FileManager.default.fileExists(atPath: path) else { throw HelperError("not_found", "no such file: \(path)") }
        guard let src = CGImageSourceCreateWithURL(url as CFURL, nil),
              let image = CGImageSourceCreateImageAtIndex(src, 0, nil) else {
            throw HelperError("bad_image", "could not decode image: \(path)")
        }
        return (image, CGImageSourceGetType(src) as String?)
    }

    public static func info(path: String) throws -> [String: Any] {
        let (image, type) = try loadImage(path)
        return ["width": image.width, "height": image.height, "type": orNull(type)]
    }

    /// On-device text recognition with the Vision framework. Nothing leaves the machine.
    public static func ocr(path: String, fast: Bool, languages: [String]) throws -> [String: Any] {
        let (image, _) = try loadImage(path)
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = fast ? .fast : .accurate
        request.usesLanguageCorrection = !fast
        if !languages.isEmpty { request.recognitionLanguages = languages }
        let handler = VNImageRequestHandler(cgImage: image, options: [:])
        try handler.perform([request])
        var lines: [[String: Any]] = []
        var texts: [String] = []
        for obs in request.results ?? [] {
            guard let top = obs.topCandidates(1).first else { continue }
            let b = obs.boundingBox
            texts.append(top.string)
            lines.append([
                "text": top.string,
                "confidence": Double(top.confidence),
                "box": [Double(b.origin.x), Double(b.origin.y), Double(b.size.width), Double(b.size.height)],
            ])
        }
        return ["text": texts.joined(separator: "\n"), "lines": lines, "width": image.width, "height": image.height]
    }

    static func writePNG(_ image: CGImage, to path: String) throws {
        let url = URL(fileURLWithPath: path)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        guard let dest = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil) else {
            throw HelperError("write_failed", "could not create PNG at \(path)")
        }
        CGImageDestinationAddImage(dest, image, nil)
        guard CGImageDestinationFinalize(dest) else { throw HelperError("write_failed", "could not write PNG at \(path)") }
    }
}

public enum ScreenCapture {
    public static func capture(target: String, bundleId: String?, windowId: Int?, titleContains: String? = nil, outPath: String) async throws -> [String: Any] {
        guard CGPreflightScreenCaptureAccess() else {
            throw HelperError(
                "permission_denied",
                "Screen Recording permission is not granted. Enable it for the app running CommandOS in System Settings → Privacy & Security → Screen Recording."
            )
        }
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        let filter: SCContentFilter
        var title: String?
        var frame = CGRect.zero
        switch target {
        case "display":
            let mainID = CGMainDisplayID()
            guard let display = content.displays.first(where: { $0.displayID == mainID }) ?? content.displays.first else {
                throw HelperError("not_found", "no display available")
            }
            filter = SCContentFilter(display: display, excludingWindows: [])
            frame = display.frame
        case "window":
            var window: SCWindow?
            if let windowId {
                window = content.windows.first { Int($0.windowID) == windowId }
            } else if let bundleId {
                // apps like Chrome keep untitled helper windows on screen: prefer titled windows,
                // frontmost first (the window server lists windows front to back)
                let candidates = content.windows.filter {
                    $0.owningApplication?.bundleIdentifier == bundleId && $0.windowLayer == 0 && $0.isOnScreen && $0.frame.width > 40 && $0.frame.height > 40
                }
                let info = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
                let order = info.compactMap { $0[kCGWindowNumber as String] as? Int }
                func rank(_ w: SCWindow) -> Int { order.firstIndex(of: Int(w.windowID)) ?? Int.max }
                let sorted = candidates.sorted { a, b in
                    let aUntitled = (a.title ?? "").isEmpty, bUntitled = (b.title ?? "").isEmpty
                    return aUntitled != bUntitled ? !aUntitled : rank(a) < rank(b)
                }
                if let titleContains, !titleContains.isEmpty {
                    window = sorted.first { ($0.title ?? "").localizedCaseInsensitiveContains(titleContains) } ?? sorted.first
                } else {
                    window = sorted.first
                }
            } else {
                throw HelperError("bad_params", "window capture requires bundleId or windowId")
            }
            guard let window else { throw HelperError("not_found", "no on-screen window for the requested app") }
            title = window.title
            frame = window.frame
            filter = SCContentFilter(desktopIndependentWindow: window)
        default:
            throw HelperError("bad_params", "unknown capture target '\(target)'")
        }
        let config = SCStreamConfiguration()
        let scale = CGFloat(filter.pointPixelScale)
        config.width = max(1, Int(filter.contentRect.width * scale))
        config.height = max(1, Int(filter.contentRect.height * scale))
        config.showsCursor = false
        let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
        try ImageTools.writePNG(image, to: outPath)
        return [
            "path": outPath, "width": image.width, "height": image.height, "windowTitle": orNull(title),
            "frame": ["x": Double(frame.origin.x), "y": Double(frame.origin.y), "width": Double(frame.size.width), "height": Double(frame.size.height)],
        ]
    }
}

/// Spotlight via NSMetadataQuery (must run on the main run loop).
public enum Spotlight {
    final class State: @unchecked Sendable {
        let lock = NSLock()
        var done = false
        var observer: NSObjectProtocol?

        func finishOnce() -> Bool {
            lock.lock(); defer { lock.unlock() }
            if done { return false }
            done = true
            return true
        }
    }

    static func item(_ md: NSMetadataItem) -> [String: Any]? {
        guard let path = md.value(forAttribute: NSMetadataItemPathKey) as? String else { return nil }
        let created = md.value(forAttribute: NSMetadataItemFSCreationDateKey) as? Date
        let modified = md.value(forAttribute: NSMetadataItemFSContentChangeDateKey) as? Date
        let size = md.value(forAttribute: NSMetadataItemFSSizeKey) as? NSNumber
        let w = md.value(forAttribute: "kMDItemPixelWidth") as? NSNumber
        let h = md.value(forAttribute: "kMDItemPixelHeight") as? NSNumber
        let isCapture = (md.value(forAttribute: "kMDItemIsScreenCapture") as? NSNumber)?.boolValue ?? false
        return [
            "path": path,
            "name": (md.value(forAttribute: NSMetadataItemFSNameKey) as? String) ?? (path as NSString).lastPathComponent,
            "created": orNull(created.map(isoString)),
            "modified": orNull(modified.map(isoString)),
            "size": orNull(size?.doubleValue),
            "pixelWidth": orNull(w?.doubleValue),
            "pixelHeight": orNull(h?.doubleValue),
            "isScreenCapture": isCapture,
        ]
    }

    public static func query(_ queryString: String, scopes: [String], limit: Int, timeoutMs: Int) async throws -> [String: Any] {
        guard let predicate = NSPredicate(fromMetadataQueryString: queryString) else {
            throw HelperError("bad_params", "invalid Spotlight query: \(queryString)")
        }
        let state = State()
        return try await withCheckedThrowingContinuation { (cont: CheckedContinuation<[String: Any], Error>) in
            DispatchQueue.main.async {
                let q = NSMetadataQuery()
                q.predicate = predicate
                q.searchScopes = scopes.isEmpty ? [NSMetadataQueryUserHomeScope] : scopes.map { URL(fileURLWithPath: $0) }
                q.sortDescriptors = [NSSortDescriptor(key: NSMetadataItemFSContentChangeDateKey, ascending: false)]
                state.observer = NotificationCenter.default.addObserver(
                    forName: .NSMetadataQueryDidFinishGathering, object: q, queue: .main
                ) { _ in
                    guard state.finishOnce() else { return }
                    q.disableUpdates()
                    q.stop()
                    if let obs = state.observer { NotificationCenter.default.removeObserver(obs) }
                    var items: [[String: Any]] = []
                    for i in 0..<min(q.resultCount, limit) {
                        if let md = q.result(at: i) as? NSMetadataItem, let it = item(md) { items.append(it) }
                    }
                    cont.resume(returning: ["items": items])
                }
                if !q.start() {
                    if state.finishOnce() {
                        if let obs = state.observer { NotificationCenter.default.removeObserver(obs) }
                        cont.resume(throwing: HelperError("spotlight_error", "could not start Spotlight query"))
                    }
                    return
                }
                DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(timeoutMs)) {
                    guard state.finishOnce() else { return }
                    q.stop()
                    if let obs = state.observer { NotificationCenter.default.removeObserver(obs) }
                    cont.resume(throwing: HelperError("timeout", "Spotlight query timed out after \(timeoutMs) ms"))
                }
            }
        }
    }
}
