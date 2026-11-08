import AppKit
import ApplicationServices
import Foundation

/// Element reference: "<pid>:<i0>.<i1>…" — index path through AXChildren from the application element.
public struct AxRef: Equatable {
    public let pid: pid_t
    public let path: [Int]

    public init(pid: pid_t, path: [Int]) {
        self.pid = pid
        self.path = path
    }

    public var string: String {
        "\(pid):" + path.map(String.init).joined(separator: ".")
    }

    public func child(_ index: Int) -> AxRef {
        AxRef(pid: pid, path: path + [index])
    }

    public static func parse(_ s: String) throws -> AxRef {
        let parts = s.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false)
        guard parts.count == 2, let pid = Int32(parts[0]), pid > 0 else {
            throw HelperError("bad_ref", "invalid element ref '\(s)'")
        }
        if parts[1].isEmpty { return AxRef(pid: pid, path: []) }
        var path: [Int] = []
        for comp in parts[1].split(separator: ".", omittingEmptySubsequences: false) {
            guard let i = Int(comp), i >= 0 else { throw HelperError("bad_ref", "invalid element ref '\(s)'") }
            path.append(i)
        }
        return AxRef(pid: pid, path: path)
    }
}

public struct AxQuery {
    public var role: String?
    public var text: String?
    public var identifier: String?
    public var enabledOnly: Bool

    public init(role: String? = nil, text: String? = nil, identifier: String? = nil, enabledOnly: Bool = false) {
        self.role = role
        self.text = text
        self.identifier = identifier
        self.enabledOnly = enabledOnly
    }

    /// Pure matching over already-extracted attributes, so it can be unit tested.
    public func matches(role elRole: String, texts: [String?], identifier elId: String?, enabled: Bool?) -> Bool {
        if let role, role.caseInsensitiveCompare(elRole) != .orderedSame { return false }
        if let identifier, identifier != elId { return false }
        if enabledOnly, enabled == false { return false }
        if let text, !text.isEmpty {
            let needle = text.lowercased()
            let hit = texts.contains { candidate in
                guard let candidate else { return false }
                return candidate.lowercased().contains(needle)
            }
            if !hit { return false }
        }
        return true
    }
}

public enum Accessibility {
    static let messagingTimeout: Float = 3.0

    public static func requireTrusted() throws {
        guard AXIsProcessTrusted() else {
            throw HelperError(
                "permission_denied",
                "Accessibility permission is not granted. Enable it for the app running CommandOS in System Settings → Privacy & Security → Accessibility."
            )
        }
    }

    static func attr(_ el: AXUIElement, _ name: String) -> CFTypeRef? {
        var value: CFTypeRef?
        let err = AXUIElementCopyAttributeValue(el, name as CFString, &value)
        return err == .success ? value : nil
    }

    static func stringAttr(_ el: AXUIElement, _ name: String) -> String? {
        guard let v = attr(el, name) else { return nil }
        if let s = v as? String { return s }
        if let n = v as? NSNumber { return n.stringValue }
        if let u = v as? URL { return u.absoluteString }
        return nil
    }

    static func boolAttr(_ el: AXUIElement, _ name: String) -> Bool? {
        guard let v = attr(el, name) else { return nil }
        if let b = v as? Bool { return b }
        if let n = v as? NSNumber { return n.boolValue }
        return nil
    }

    static func elementAttr(_ el: AXUIElement, _ name: String) -> AXUIElement? {
        guard let v = attr(el, name), CFGetTypeID(v) == AXUIElementGetTypeID() else { return nil }
        return (v as! AXUIElement)
    }

    static func children(_ el: AXUIElement) -> [AXUIElement] {
        guard let v = attr(el, kAXChildrenAttribute as String) else { return [] }
        return (v as? [AXUIElement]) ?? []
    }

    static func childCount(_ el: AXUIElement) -> Int {
        var count: CFIndex = 0
        let err = AXUIElementGetAttributeValueCount(el, kAXChildrenAttribute as CFString, &count)
        return err == .success ? count : 0
    }

    static func frame(_ el: AXUIElement) -> Any {
        guard let posV = attr(el, kAXPositionAttribute as String), let sizeV = attr(el, kAXSizeAttribute as String),
              CFGetTypeID(posV) == AXValueGetTypeID(), CFGetTypeID(sizeV) == AXValueGetTypeID() else {
            return NSNull()
        }
        var p = CGPoint.zero
        var s = CGSize.zero
        AXValueGetValue(posV as! AXValue, .cgPoint, &p)
        AXValueGetValue(sizeV as! AXValue, .cgSize, &s)
        return ["x": Double(p.x), "y": Double(p.y), "width": Double(s.width), "height": Double(s.height)]
    }

    /// Chromium reports clipped, zero-height bounds for controls outside the viewport.
    /// Ask the control itself to scroll into view before reading its current bounds again.
    static func clickableFrame(_ element: AXUIElement) throws -> [String: Double] {
        func current() -> [String: Double]? {
            guard let bounds = frame(element) as? [String: Double],
                  (bounds["width"] ?? 0) > 0, (bounds["height"] ?? 0) > 0 else { return nil }
            return bounds
        }
        if let bounds = current() { return bounds }
        let scroll = "AXScrollToVisible"
        guard actions(element).contains(scroll), AXUIElementPerformAction(element, scroll as CFString) == .success else {
            throw HelperError("not_visible", "the Chromium control could not be scrolled into view; no click was sent")
        }
        for _ in 0..<30 {
            if let bounds = current() { return bounds }
            usleep(50_000)
        }
        throw HelperError("not_visible", "the Chromium control still has no clickable bounds after scrolling; no click was sent")
    }

    static func actions(_ el: AXUIElement) -> [String] {
        var names: CFArray?
        guard AXUIElementCopyActionNames(el, &names) == .success, let names else { return [] }
        return (names as? [String]) ?? []
    }

    static func truncate(_ s: String?, _ limit: Int = 500) -> String? {
        guard let s else { return nil }
        return s.count > limit ? String(s.prefix(limit)) + "…" : s
    }

    static func label(_ el: AXUIElement) -> String? {
        guard let titleEl = elementAttr(el, kAXTitleUIElementAttribute as String) else { return nil }
        return stringAttr(titleEl, kAXValueAttribute as String) ?? stringAttr(titleEl, kAXTitleAttribute as String)
    }

    struct Snapshot {
        let role: String
        let subrole: String?
        let title: String?
        let label: String?
        let value: String?
        let identifier: String?
        let description: String?
        let placeholder: String?
        let enabled: Bool?
        let focused: Bool?
    }

    static func snapshot(_ el: AXUIElement) -> Snapshot {
        Snapshot(
            role: stringAttr(el, kAXRoleAttribute as String) ?? "AXUnknown",
            subrole: stringAttr(el, kAXSubroleAttribute as String),
            title: stringAttr(el, kAXTitleAttribute as String),
            label: label(el),
            value: truncate(stringAttr(el, kAXValueAttribute as String)),
            identifier: stringAttr(el, "AXIdentifier"),
            description: stringAttr(el, kAXDescriptionAttribute as String),
            placeholder: stringAttr(el, "AXPlaceholderValue"),
            enabled: boolAttr(el, kAXEnabledAttribute as String),
            focused: boolAttr(el, kAXFocusedAttribute as String)
        )
    }

    static func describe(_ el: AXUIElement, snap: Snapshot, ref: AxRef, depth: Int) -> [String: Any] {
        [
            "ref": ref.string,
            "role": snap.role,
            "subrole": orNull(snap.subrole),
            "title": orNull(snap.title),
            "label": orNull(snap.label),
            "value": orNull(snap.value),
            "identifier": orNull(snap.identifier),
            "description": orNull(snap.description),
            "placeholder": orNull(snap.placeholder),
            "enabled": orNull(snap.enabled),
            "focused": orNull(snap.focused),
            "frame": frame(el),
            "actions": actions(el),
            "depth": depth,
            "childCount": childCount(el),
        ]
    }

    @MainActor
    static func pid(forBundleId bundleId: String) throws -> pid_t {
        guard let app = Apps.runningApplication(bundleId: bundleId) else {
            throw HelperError("not_running", "app \(bundleId) is not running")
        }
        return app.processIdentifier
    }

    static func appElement(_ pid: pid_t) -> AXUIElement {
        let el = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(el, messagingTimeout)
        return el
    }

    public static func resolve(_ ref: AxRef) throws -> AXUIElement {
        var el = appElement(ref.pid)
        for (depth, index) in ref.path.enumerated() {
            let kids = children(el)
            guard index < kids.count else {
                throw HelperError("stale_ref", "element ref \(ref.string) is stale (no child \(index) at depth \(depth))")
            }
            el = kids[index]
        }
        return el
    }

    /// Depth-first walk. Skips the menu bar unless `includeMenus` is set (it is large and rarely the target).
    static func walk(
        pid: pid_t,
        maxDepth: Int,
        maxNodes: Int,
        includeMenus: Bool,
        root: AXUIElement? = nil,
        rootRef: AxRef? = nil,
        visit: (AXUIElement, AxRef, Int) -> Bool
    ) -> Bool {
        var visited = 0
        var truncated = false
        func recurse(_ el: AXUIElement, _ ref: AxRef, _ depth: Int) -> Bool {
            if visited >= maxNodes { truncated = true; return false }
            visited += 1
            if !visit(el, ref, depth) { return false }
            if depth >= maxDepth { return true }
            for (i, child) in children(el).enumerated() {
                if !includeMenus, depth == 0, stringAttr(child, kAXRoleAttribute as String) == (kAXMenuBarRole as String) {
                    continue
                }
                if !recurse(child, ref.child(i), depth + 1) { return false }
            }
            return true
        }
        _ = recurse(root ?? appElement(pid), rootRef ?? AxRef(pid: pid, path: []), 0)
        return truncated
    }

    /// Asks a Chromium browser (Chrome, Edge, Brave, Electron apps) to expose its web page contents to
    /// Accessibility, the switch screen readers use (AXManualAccessibility). Chrome keeps pages out of
    /// the Accessibility tree until an assistive app asks.
    public static func enableWeb(bundleId: String, on: Bool) async throws -> [String: Any] {
        try requireTrusted()
        let pid: pid_t = try await Accessibility.pid(forBundleId: bundleId)
        let app = appElement(pid)
        let value = (on ? kCFBooleanTrue : kCFBooleanFalse) as CFTypeRef
        // Electron apps honour AXManualAccessibility; Chrome rejects it (-25205) and instead builds
        // page trees for every tab at once when AXEnhancedUserInterface is set, as VoiceOver does.
        // Without either, a newly opened tab's page stayed empty to Accessibility for ~10 s (measured).
        let manual = AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, value)
        let enhanced = manual == .success ? AXError.success : AXUIElementSetAttributeValue(app, "AXEnhancedUserInterface" as CFString, value)
        let result = manual == .success ? manual : enhanced
        return ["ok": result == .success, "code": Int(result.rawValue), "via": manual == .success ? "AXManualAccessibility" : "AXEnhancedUserInterface"]
    }

    /// Text of the page in the app's front window: the first AXWebArea, walked in document order,
    /// collecting static text and image descriptions. Bounded by characters and nodes, not depth.
    public static func webText(bundleId: String, maxChars: Int) async throws -> [String: Any] {
        try requireTrusted()
        let pid: pid_t = try await Accessibility.pid(forBundleId: bundleId)
        let app = appElement(pid)
        var window = elementAttr(app, kAXFocusedWindowAttribute as String) ?? elementAttr(app, kAXMainWindowAttribute as String)
        if window == nil, let wins = attr(app, kAXWindowsAttribute as String) as? [AXUIElement] { window = wins.first }
        guard let window else { throw HelperError("not_found", "\(bundleId) has no open window") }
        let title = stringAttr(window, kAXTitleAttribute as String) ?? ""
        var stack: [AXUIElement] = [window]
        var web: AXUIElement?
        var searched = 0
        while let el = stack.popLast(), searched < 20_000 {
            searched += 1
            if stringAttr(el, kAXRoleAttribute as String) == "AXWebArea" { web = el; break }
            stack.append(contentsOf: children(el).reversed())
        }
        guard let web else { return ["title": title, "url": NSNull(), "text": "", "found": false, "truncated": false, "nodes": searched] }
        let url = stringAttr(web, "AXURL")
        var lines: [String] = []
        var chars = 0
        var nodes = 0
        var images = 0
        let busy = boolAttr(web, kAXElementBusyAttribute as String) ?? false
        var progressIndicators = 0
        var truncated = false
        func visit(_ el: AXUIElement) {
            if truncated { return }
            nodes += 1
            if nodes > 40_000 { truncated = true; return }
            let role = stringAttr(el, kAXRoleAttribute as String) ?? ""
            var text: String?
            if role == "AXStaticText" { text = stringAttr(el, kAXValueAttribute as String) }
            else if role == "AXImage" {
                images += 1
                text = stringAttr(el, kAXDescriptionAttribute as String)
            }
            else if ["AXTextField", "AXTextArea"].contains(role) { text = stringAttr(el, kAXValueAttribute as String) }
            else if ["AXButton", "AXLink", "AXHeading"].contains(role) {
                text = stringAttr(el, kAXTitleAttribute as String) ?? stringAttr(el, kAXDescriptionAttribute as String)
            }
            if role == "AXProgressIndicator" { progressIndicators += 1 }
            if let t = text?.trimmingCharacters(in: .whitespacesAndNewlines), !t.isEmpty, lines.last != t {
                lines.append(t)
                chars += t.count + 1
                if chars > maxChars { truncated = true; return }
            }
            for child in children(el) { visit(child) }
        }
        visit(web)
        return ["title": title, "url": url ?? NSNull(), "text": lines.joined(separator: "\n"), "found": true, "truncated": truncated, "nodes": nodes, "images": images, "busy": busy, "progressIndicators": progressIndicators]
    }

    public static func tree(bundleId: String, maxDepth: Int, maxNodes: Int, scope: String = "application") async throws -> [String: Any] {
        try requireTrusted()
        let pid: pid_t = try await Accessibility.pid(forBundleId: bundleId)
        var root: AXUIElement?
        var rootRef: AxRef?
        if scope == "window" {
            let app = appElement(pid)
            root = elementAttr(app, kAXFocusedWindowAttribute as String) ?? elementAttr(app, kAXMainWindowAttribute as String)
            if root == nil, let windows = attr(app, kAXWindowsAttribute as String) as? [AXUIElement] { root = windows.first }
            guard let window = root, let ref = refFor(window, pid: pid) else {
                throw HelperError("not_found", "\(bundleId) has no accessible front window")
            }
            rootRef = ref
        } else if scope != "application" {
            throw HelperError("bad_params", "unknown Accessibility tree scope '\(scope)'")
        }
        var out: [[String: Any]] = []
        let truncated = walk(pid: pid, maxDepth: maxDepth, maxNodes: maxNodes, includeMenus: false, root: root, rootRef: rootRef) { el, ref, depth in
            out.append(describe(el, snap: snapshot(el), ref: ref, depth: depth))
            return true
        }
        return ["elements": out, "truncated": truncated]
    }

    public static func find(bundleId: String, query: AxQuery, maxResults: Int, maxDepth: Int) async throws -> [String: Any] {
        try requireTrusted()
        let pid: pid_t = try await Accessibility.pid(forBundleId: bundleId)
        var out: [[String: Any]] = []
        _ = walk(pid: pid, maxDepth: maxDepth, maxNodes: 20_000, includeMenus: query.role?.contains("Menu") ?? false) { el, ref, depth in
            let snap = snapshot(el)
            let texts = [snap.title, snap.label, snap.value, snap.description, snap.placeholder, snap.identifier]
            if query.matches(role: snap.role, texts: texts, identifier: snap.identifier, enabled: snap.enabled) {
                out.append(describe(el, snap: snap, ref: ref, depth: depth))
            }
            return out.count < maxResults
        }
        return ["elements": out]
    }

    /// Find, focus, replace, and read a Chromium text field while retaining the live AX element.
    /// This avoids child-index refs becoming stale when a web page updates its accessibility tree.
    public static func fill(bundleId: String, query: AxQuery, value: String) async throws -> [String: Any] {
        try requireTrusted()
        guard ["com.google.Chrome", "com.microsoft.edgemac", "com.brave.Browser", "company.thebrowser.Browser"].contains(bundleId),
              ["AXTextField", "AXTextArea"].contains(query.role ?? ""), (query.text != nil || query.identifier != nil), !value.contains("\n"), !value.contains("\r") else {
            throw HelperError("bad_params", "ax.fill only accepts single-line Chromium text fields")
        }
        let pid: pid_t = try await Accessibility.pid(forBundleId: bundleId)
        var matches: [AXUIElement] = []
        _ = walk(pid: pid, maxDepth: 25, maxNodes: 20_000, includeMenus: false) { el, _, _ in
            let snap = snapshot(el)
            if query.matches(role: snap.role, texts: [snap.title, snap.label, snap.value, snap.description, snap.placeholder, snap.identifier], identifier: snap.identifier, enabled: snap.enabled), snap.role == query.role {
                matches.append(el)
            }
            return true
        }
        guard matches.count == 1, let field = matches.first, boolAttr(field, kAXEnabledAttribute as String) != false else {
            throw HelperError("not_found", "no unique enabled field matches the Chromium form target")
        }
        let fieldFrame = try clickableFrame(field)
        guard
              let x = fieldFrame["x"], let y = fieldFrame["y"], let width = fieldFrame["width"], let height = fieldFrame["height"],
              width > 0, height > 0 else { throw HelperError("not_found", "no unique, visible field matches the Chromium form target") }
        _ = try Mouse.click(x: x + width / 2, y: y + height / 2, button: "left", clicks: 1)
        let system = AXUIElementCreateSystemWide()
        guard let focusedApp = elementAttr(system, kAXFocusedApplicationAttribute as String) else {
            throw HelperError("focus_changed", "Chrome did not have keyboard focus after clicking the repository field")
        }
        var focusedPid: pid_t = 0
        AXUIElementGetPid(focusedApp, &focusedPid)
        guard focusedPid == pid, let focusedField = elementAttr(focusedApp, kAXFocusedUIElementAttribute as String) else {
            throw HelperError("focus_changed", "Chrome did not have keyboard focus after clicking the repository field")
        }
        let focusedSnapshot = snapshot(focusedField)
        guard query.matches(role: focusedSnapshot.role, texts: [focusedSnapshot.title, focusedSnapshot.label, focusedSnapshot.value, focusedSnapshot.description, focusedSnapshot.placeholder, focusedSnapshot.identifier], identifier: focusedSnapshot.identifier, enabled: focusedSnapshot.enabled) else {
            throw HelperError("focus_changed", "the repository name field did not receive keyboard focus")
        }
        let pasteResult = try Clipboard.withTemporaryString(value) {
            _ = try KeyPress.press(key: "a", modifiers: ["command"])
            _ = try KeyPress.press(key: "v", modifiers: ["command"])
            usleep(120_000)
            return true
        }
        guard pasteResult else { throw HelperError("input_unverified", "paste did not complete") }
        var readBack: String?
        for _ in 0..<20 {
            readBack = stringAttr(field, kAXValueAttribute as String)
            if readBack == value { break }
            usleep(50_000)
        }
        guard readBack == value else { throw HelperError("input_unverified", "the live Chromium field did not retain the requested value") }
        return ["value": orNull(readBack)]
    }

    /// Find a Chromium control by its current accessible label and click its live screen bounds.
    public static func click(bundleId: String, query: AxQuery, expectLabel: String) async throws -> [String: Any] {
        try requireTrusted()
        guard ["com.google.Chrome", "com.microsoft.edgemac", "com.brave.Browser", "company.thebrowser.Browser"].contains(bundleId),
              query.text != nil || query.identifier != nil else {
            throw HelperError("bad_params", "ax.click requires a Chromium target with a label or identifier")
        }
        let pid: pid_t = try await Accessibility.pid(forBundleId: bundleId)
        var matches: [(AXUIElement, Snapshot)] = []
        _ = walk(pid: pid, maxDepth: 25, maxNodes: 20_000, includeMenus: false) { el, _, _ in
            let snap = snapshot(el)
            if query.matches(role: snap.role, texts: [snap.title, snap.label, snap.value, snap.description, snap.placeholder, snap.identifier], identifier: snap.identifier, enabled: snap.enabled) {
                matches.append((el, snap))
            }
            return true
        }
        guard matches.count == 1, let (element, snap) = matches.first,
              snap.enabled != false,
              ["AXButton", "AXLink", "AXMenuItem", "AXPopUpButton", "AXCheckBox", "AXRadioButton"].contains(snap.role) else {
            throw HelperError("not_found", "no unique enabled Chromium control matches the requested label")
        }
        let labels = [snap.title, snap.label, snap.description, snap.identifier].compactMap { $0 }
        guard labels.contains(where: { $0.localizedCaseInsensitiveContains(expectLabel) }) else {
            throw HelperError("label_mismatch", "the Chromium control no longer matches the expected label")
        }
        let frame = try clickableFrame(element)
        guard let x = frame["x"], let y = frame["y"],
              let width = frame["width"], let height = frame["height"], width > 0, height > 0 else {
            throw HelperError("not_visible", "the Chromium control has no clickable screen bounds")
        }
        _ = try Mouse.click(x: x + width / 2, y: y + height / 2, button: "left", clicks: 1)
        return ["clicked": true]
    }

    public static func press(ref: AxRef) throws -> [String: Any] {
        try requireTrusted()
        let el = try resolve(ref)
        guard boolAttr(el, kAXEnabledAttribute as String) != false else {
            throw HelperError("disabled_element", "the target control is disabled; no press was sent")
        }
        let err = AXUIElementPerformAction(el, kAXPressAction as CFString)
        guard err == .success else { throw HelperError("ax_error", "press failed (AXError \(err.rawValue))") }
        return ["ok": true]
    }

    public static func setValue(ref: AxRef, value: String) throws -> [String: Any] {
        try requireTrusted()
        let el = try resolve(ref)
        var settable: DarwinBoolean = false
        AXUIElementIsAttributeSettable(el, kAXValueAttribute as CFString, &settable)
        guard settable.boolValue else { throw HelperError("not_settable", "element \(ref.string) value is not settable") }
        let err = AXUIElementSetAttributeValue(el, kAXValueAttribute as CFString, value as CFString)
        guard err == .success else { throw HelperError("ax_error", "setValue failed (AXError \(err.rawValue))") }
        return ["ok": true, "value": orNull(stringAttr(el, kAXValueAttribute as String))]
    }

    public static func getValue(ref: AxRef) throws -> [String: Any] {
        try requireTrusted()
        let el = try resolve(ref)
        return ["value": orNull(stringAttr(el, kAXValueAttribute as String))]
    }

    public static func focus(ref: AxRef) throws -> [String: Any] {
        try requireTrusted()
        let el = try resolve(ref)
        let err = AXUIElementSetAttributeValue(el, kAXFocusedAttribute as CFString, kCFBooleanTrue)
        guard err == .success else { throw HelperError("ax_error", "focus failed (AXError \(err.rawValue))") }
        return ["ok": true]
    }

    /// Stop target-bound keyboard input if the foreground field changes.
    public static func requireFocused(ref: AxRef) throws {
        try requireTrusted()
        let target = try resolve(ref)
        try requireFocused(element: target, pid: ref.pid)
    }

    static func requireFocused(element target: AXUIElement, pid expectedPid: pid_t) throws {
        try requireTrusted()
        let system = AXUIElementCreateSystemWide()
        guard let app = elementAttr(system, kAXFocusedApplicationAttribute as String),
              let focused = elementAttr(app, kAXFocusedUIElementAttribute as String) else {
            throw HelperError("focus_changed", "the expected field no longer has keyboard focus")
        }
        var pid: pid_t = 0
        AXUIElementGetPid(app, &pid)
        guard pid == expectedPid, CFEqual(focused, target), boolAttr(target, kAXEnabledAttribute as String) != false else {
            throw HelperError("focus_changed", "keyboard focus changed; input stopped")
        }
    }

    /// Reconstructs the index path of an element by walking AXParent up to the application element.
    static func refFor(_ element: AXUIElement, pid: pid_t) -> AxRef? {
        var path: [Int] = []
        var current = element
        for _ in 0..<64 {
            guard let parent = elementAttr(current, kAXParentAttribute as String) else { break }
            let siblings = children(parent)
            guard let idx = siblings.firstIndex(where: { CFEqual($0, current) }) else { return nil }
            path.insert(idx, at: 0)
            if stringAttr(parent, kAXRoleAttribute as String) == (kAXApplicationRole as String) {
                return AxRef(pid: pid, path: path)
            }
            current = parent
        }
        return nil
    }

    public static func focused() async throws -> [String: Any] {
        try requireTrusted()
        let system = AXUIElementCreateSystemWide()
        AXUIElementSetMessagingTimeout(system, messagingTimeout)
        guard let app = elementAttr(system, kAXFocusedApplicationAttribute as String) else {
            return ["element": NSNull(), "bundleId": NSNull()]
        }
        var rawPid: pid_t = 0
        AXUIElementGetPid(app, &rawPid)
        let pid = rawPid
        let bundleId = await MainActor.run { NSRunningApplication(processIdentifier: pid)?.bundleIdentifier }
        guard let el = elementAttr(app, kAXFocusedUIElementAttribute as String) else {
            return ["element": NSNull(), "bundleId": orNull(bundleId)]
        }
        let ref = refFor(el, pid: pid) ?? AxRef(pid: pid, path: [])
        return ["element": describe(el, snap: snapshot(el), ref: ref, depth: ref.path.count), "bundleId": orNull(bundleId)]
    }
}
