import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import LocalAuthentication
import Security

public enum Permissions {
    public static func status() -> [String: Any] {
        ["accessibility": AXIsProcessTrusted(), "screenRecording": CGPreflightScreenCaptureAccess()]
    }

    public static func request(kind: String) throws -> [String: Any] {
        switch kind {
        case "accessibility":
            let key = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
            _ = AXIsProcessTrustedWithOptions([key: true] as CFDictionary)
        case "screenRecording":
            _ = CGRequestScreenCaptureAccess()
        default:
            throw HelperError("bad_params", "unknown permission kind '\(kind)'")
        }
        return status()
    }
}

public enum Apps {
    /// Prefer the actual foreground process during native-sheet transitions; Launch
    /// Services' bundle-ID list can briefly lag behind NSWorkspace's active app.
    @MainActor
    static func runningApplication(bundleId: String) -> NSRunningApplication? {
        if let front = NSWorkspace.shared.frontmostApplication,
           front.bundleIdentifier == bundleId, !front.isTerminated { return front }
        return NSWorkspace.shared.runningApplications.first { $0.bundleIdentifier == bundleId && !$0.isTerminated }
            ?? NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).first { !$0.isTerminated }
    }

    @MainActor
    static func describe(_ app: NSRunningApplication) -> [String: Any] {
        [
            "name": app.localizedName ?? "",
            "bundleId": app.bundleIdentifier ?? "",
            "pid": Int(app.processIdentifier),
            "active": app.isActive,
            "hidden": app.isHidden,
        ]
    }

    @MainActor
    public static func list() -> [String: Any] {
        let apps = NSWorkspace.shared.runningApplications
            .filter { $0.activationPolicy == .regular }
            .map { describe($0) }
        return ["apps": apps]
    }

    @MainActor
    public static func frontmost() -> [String: Any] {
        guard let app = NSWorkspace.shared.frontmostApplication else { return ["app": NSNull()] }
        return ["app": describe(app)]
    }

    @MainActor
    public static func info(bundleId: String) throws -> [String: Any] {
        guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleId) else {
            throw HelperError("app_not_found", "no application with bundle id \(bundleId)")
        }
        let bundle = Bundle(url: url)
        let running = NSRunningApplication.runningApplications(withBundleIdentifier: bundleId)
        let name = (bundle?.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String)
            ?? (bundle?.object(forInfoDictionaryKey: "CFBundleName") as? String)
            ?? url.deletingPathExtension().lastPathComponent
        return [
            "bundleId": bundleId,
            "name": name,
            "version": (bundle?.object(forInfoDictionaryKey: "CFBundleVersion") as? String) ?? "",
            "shortVersion": (bundle?.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String) ?? "",
            "path": url.path,
            "running": !running.isEmpty,
            "pids": running.map { Int($0.processIdentifier) },
        ]
    }

    public static func launch(bundleId: String, activate: Bool) async throws -> [String: Any] {
        let url: URL? = await MainActor.run { NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleId) }
        guard let url else { throw HelperError("app_not_found", "no application with bundle id \(bundleId)") }
        let config = NSWorkspace.OpenConfiguration()
        config.activates = activate
        let app = try await NSWorkspace.shared.openApplication(at: url, configuration: config)
        let pid = await MainActor.run { Int(app.processIdentifier) }
        return ["pid": pid, "bundleId": bundleId]
    }

    @MainActor
    public static func activate(bundleId: String) throws -> [String: Any] {
        guard let app = runningApplication(bundleId: bundleId) else {
            throw HelperError("not_running", "app \(bundleId) is not running")
        }
        _ = app.unhide()
        let ok = app.activate(options: [.activateAllWindows])
        // Activating an app does not restore a minimized window. Hidden browser
        // controls still expose AX bounds, so clicks can otherwise hit another app.
        if AXIsProcessTrusted() {
            let element = Accessibility.appElement(app.processIdentifier)
            let windows = Accessibility.attr(element, kAXWindowsAttribute as String) as? [AXUIElement]
            if let window = Accessibility.elementAttr(element, kAXFocusedWindowAttribute as String)
                ?? Accessibility.elementAttr(element, kAXMainWindowAttribute as String) ?? windows?.first {
                if Accessibility.boolAttr(window, kAXMinimizedAttribute as String) == true {
                    _ = AXUIElementSetAttributeValue(window, kAXMinimizedAttribute as CFString, kCFBooleanFalse)
                }
                _ = AXUIElementPerformAction(window, kAXRaiseAction as CFString)
            }
        }
        return ["activated": ok]
    }

    @MainActor
    public static func quit(bundleId: String, force: Bool) -> [String: Any] {
        let apps = NSRunningApplication.runningApplications(withBundleIdentifier: bundleId)
        var requested = false
        for app in apps {
            requested = (force ? app.forceTerminate() : app.terminate()) || requested
        }
        return ["requested": requested, "count": apps.count]
    }
}

public enum Workspace {
    @MainActor
    public static func open(path: String?, url: String?, bundleId: String?) throws -> [String: Any] {
        let ws = NSWorkspace.shared
        if let path {
            let fileURL = URL(fileURLWithPath: path)
            guard FileManager.default.fileExists(atPath: path) else { throw HelperError("not_found", "no such file: \(path)") }
            if let bundleId, let appURL = ws.urlForApplication(withBundleIdentifier: bundleId) {
                ws.open([fileURL], withApplicationAt: appURL, configuration: NSWorkspace.OpenConfiguration())
                return ["opened": true]
            }
            return ["opened": ws.open(fileURL)]
        }
        if let url {
            guard let u = URL(string: url), let scheme = u.scheme?.lowercased(), ["http", "https", "mailto", "file"].contains(scheme) else {
                throw HelperError("bad_params", "unsupported URL: \(url)")
            }
            return ["opened": ws.open(u)]
        }
        throw HelperError("bad_params", "workspace.open requires path or url")
    }

    @MainActor
    public static func reveal(paths: [String]) -> [String: Any] {
        NSWorkspace.shared.activateFileViewerSelecting(paths.map { URL(fileURLWithPath: $0) })
        return ["ok": true]
    }
}

public enum FileOps {
    public static func trash(path: String) throws -> [String: Any] {
        let url = URL(fileURLWithPath: path)
        guard FileManager.default.fileExists(atPath: path) else { throw HelperError("not_found", "no such file: \(path)") }
        var resulting: NSURL?
        try FileManager.default.trashItem(at: url, resultingItemURL: &resulting)
        guard let trashed = resulting?.path else { throw HelperError("trash_failed", "trash did not report a location") }
        return ["trashedPath": trashed]
    }
}

public enum Keyboard {
    /// Types Unicode text into the focused element using synthesized keyboard events.
    public static func type(_ text: String, perCharacter: Bool = false, expectedRef: AxRef? = nil, expectedElement: AXUIElement? = nil, expectedPid: pid_t? = nil) throws -> [String: Any] {
        try Accessibility.requireTrusted()
        guard let source = CGEventSource(stateID: .hidSystemState) else { throw HelperError("event_error", "no event source") }
        let units = Array(text.utf16)
        let chunks: [[UInt16]] = perCharacter
            ? text.unicodeScalars.map { Array(String($0).utf16) }
            : stride(from: 0, to: units.count, by: 16).map { Array(units[$0..<min($0 + 16, units.count)]) }
        for chunk in chunks {
            if let expectedRef { try Accessibility.requireFocused(ref: expectedRef) }
            if let expectedElement, let expectedPid { try Accessibility.requireFocused(element: expectedElement, pid: expectedPid) }
            for keyDown in [true, false] {
                guard let ev = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: keyDown) else {
                    throw HelperError("event_error", "could not create keyboard event")
                }
                chunk.withUnsafeBufferPointer { buf in
                    ev.keyboardSetUnicodeString(stringLength: buf.count, unicodeString: buf.baseAddress)
                }
                ev.flags = []
                ev.post(tap: .cghidEventTap)
            }
            usleep(6_000)
        }
        if let expectedRef { try Accessibility.requireFocused(ref: expectedRef) }
        if let expectedElement, let expectedPid { try Accessibility.requireFocused(element: expectedElement, pid: expectedPid) }
        return ["ok": true]
    }
}

public enum Mouse {
    /// Synthesized mouse click at global screen coordinates (points, origin top-left).
    public static func click(x: Double, y: Double, button: String, clicks: Int) throws -> [String: Any] {
        try Accessibility.requireTrusted()
        guard let source = CGEventSource(stateID: .hidSystemState) else { throw HelperError("event_error", "no event source") }
        let point = CGPoint(x: x, y: y)
        let right = button == "right"
        let downType: CGEventType = right ? .rightMouseDown : .leftMouseDown
        let upType: CGEventType = right ? .rightMouseUp : .leftMouseUp
        let mouseButton: CGMouseButton = right ? .right : .left
        CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: mouseButton)?.post(tap: .cghidEventTap)
        usleep(30_000)
        for i in 1...max(1, min(clicks, 3)) {
            guard let down = CGEvent(mouseEventSource: source, mouseType: downType, mouseCursorPosition: point, mouseButton: mouseButton),
                  let up = CGEvent(mouseEventSource: source, mouseType: upType, mouseCursorPosition: point, mouseButton: mouseButton) else {
                throw HelperError("event_error", "could not create mouse event")
            }
            down.setIntegerValueField(.mouseEventClickState, value: Int64(i))
            up.setIntegerValueField(.mouseEventClickState, value: Int64(i))
            down.post(tap: .cghidEventTap)
            usleep(12_000)
            up.post(tap: .cghidEventTap)
            usleep(40_000)
        }
        return ["ok": true]
    }
}

public enum Clipboard {
    /// Temporarily place text on the general pasteboard for a single paste action, then restore
    /// its prior items if nothing else has changed the pasteboard in the meantime.
    public static func withTemporaryString<T>(_ value: String, operation: () throws -> T) rethrows -> T {
        let pasteboard = NSPasteboard.general
        let previous = pasteboard.pasteboardItems?.map { item in
            item.types.compactMap { type -> (NSPasteboard.PasteboardType, Data)? in
                guard let data = item.data(forType: type) else { return nil }
                return (type, data)
            }
        } ?? []
        pasteboard.clearContents()
        pasteboard.setString(value, forType: .string)
        let temporaryChangeCount = pasteboard.changeCount
        defer {
            if pasteboard.changeCount == temporaryChangeCount {
                pasteboard.clearContents()
                let items = previous.compactMap { entries -> NSPasteboardItem? in
                    guard !entries.isEmpty else { return nil }
                    let item = NSPasteboardItem()
                    for (type, data) in entries { item.setData(data, forType: type) }
                    return item
                }
                if !items.isEmpty { pasteboard.writeObjects(items) }
            }
        }
        return try operation()
    }
}

public enum KeyPress {
    static let named: [String: CGKeyCode] = [
        "return": 36, "enter": 76, "tab": 48, "space": 49, "delete": 51, "forwarddelete": 117, "escape": 53,
        "left": 123, "right": 124, "down": 125, "up": 126, "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
        "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96,
    ]
    static let aliases: [String: String] = [
        "arrowleft": "left", "arrowright": "right", "arrowup": "up", "arrowdown": "down",
    ]
    static let letters: [Character: CGKeyCode] = [
        "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12, "w": 13, "e": 14,
        "r": 15, "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26, "-": 27,
        "8": 28, "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35, "l": 37, "j": 38, "'": 39, "k": 40, ";": 41,
        "\\": 42, ",": 43, "/": 44, "n": 45, "m": 46, ".": 47, "`": 50,
    ]

    public static func keyCode(_ key: String) throws -> CGKeyCode {
        let k = key.lowercased()
        if let code = named[k] { return code }
        if let alias = aliases[k], let code = named[alias] { return code }
        if k.count == 1, let c = k.first, let code = letters[c] { return code }
        throw HelperError("bad_params", "unsupported key '\(key)'")
    }

    /// Presses a key with modifiers (command, option, control, shift), e.g. command+s.
    public static func press(key: String, modifiers: [String], expectedRef: AxRef? = nil, expectedElement: AXUIElement? = nil, expectedPid: pid_t? = nil) throws -> [String: Any] {
        try Accessibility.requireTrusted()
        if let expectedRef { try Accessibility.requireFocused(ref: expectedRef) }
        if let expectedElement, let expectedPid { try Accessibility.requireFocused(element: expectedElement, pid: expectedPid) }
        let code = try keyCode(key)
        var flags: CGEventFlags = []
        for m in modifiers {
            switch m.lowercased() {
            case "command", "cmd": flags.insert(.maskCommand)
            case "option", "alt": flags.insert(.maskAlternate)
            case "control", "ctrl": flags.insert(.maskControl)
            case "shift": flags.insert(.maskShift)
            default: throw HelperError("bad_params", "unknown modifier '\(m)'")
            }
        }
        guard let source = CGEventSource(stateID: .hidSystemState),
              let down = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: true),
              let up = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: false) else {
            throw HelperError("event_error", "could not create keyboard event")
        }
        down.flags = flags
        up.flags = flags
        down.post(tap: .cghidEventTap)
        usleep(10_000)
        up.post(tap: .cghidEventTap)
        return ["ok": true]
    }
}

public enum AppleScriptRunner {
    @MainActor
    public static func run(source: String) throws -> [String: Any] {
        guard let script = NSAppleScript(source: source) else { throw HelperError("applescript_error", "could not compile script") }
        var errorInfo: NSDictionary?
        let result = script.executeAndReturnError(&errorInfo)
        if let errorInfo {
            let number = (errorInfo[NSAppleScript.errorNumber] as? Int) ?? 0
            let message = (errorInfo[NSAppleScript.errorMessage] as? String) ?? "AppleScript error"
            if number == -1743 {
                throw HelperError("permission_denied", "Automation permission denied: \(message). Allow it in System Settings → Privacy & Security → Automation.")
            }
            throw HelperError("applescript_error", "\(message) (\(number))")
        }
        var items: [String] = []
        if result.numberOfItems > 0 {
            for i in 1...result.numberOfItems {
                if let item = result.atIndex(i)?.stringValue { items.append(item) }
            }
        }
        return ["result": orNull(result.stringValue), "items": items]
    }
}

public enum Keychain {
    private static let accessLock = NSLock()

    // The login Keychain uses legacy ACLs. Scope its UI setting to this helper process;
    // never change the user's Keychain password, lock state, or access-control entries.
    static func withoutPrompts<T>(_ operation: () throws -> T) throws -> T {
        accessLock.lock()
        defer { accessLock.unlock() }
        var previous = DarwinBoolean(true)
        guard SecKeychainGetUserInteractionAllowed(&previous) == errSecSuccess,
              SecKeychainSetUserInteractionAllowed(false) == errSecSuccess else {
            throw HelperError("keychain_error", "could not disable interactive Keychain access")
        }
        defer { _ = SecKeychainSetUserInteractionAllowed(previous.boolValue) }
        return try operation()
    }

    static func nonInteractiveQuery(service: String, account: String) -> [String: Any] {
        var query = baseQuery(service: service, account: account)
        let context = LAContext()
        context.interactionNotAllowed = true
        query[kSecUseAuthenticationContext as String] = context
        return query
    }

    static func accessError(_ operation: String, _ status: OSStatus) -> HelperError {
        if status == errSecInteractionNotAllowed || status == errSecAuthFailed || status == errSecUserCanceled {
            return HelperError("keychain_locked", "Keychain access is unavailable for this helper. Use Keychain Access to authorize it, or configure development credentials. No password dialog was opened.")
        }
        return HelperError("keychain_error", "keychain \(operation) failed (OSStatus \(status))")
    }
    static func baseQuery(service: String, account: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }

    public static func set(service: String, account: String, value: String) throws -> [String: Any] {
        return try withoutPrompts {
            guard let data = value.data(using: .utf8) else { throw HelperError("bad_params", "value is not UTF-8") }
            let query = baseQuery(service: service, account: account)
            let update: [String: Any] = [kSecValueData as String: data]
            var status = SecItemUpdate(query as CFDictionary, update as CFDictionary)
            if status == errSecItemNotFound {
                var add = query
                add[kSecValueData as String] = data
                add[kSecAttrLabel as String] = "CommandOS: \(account)"
                add[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlocked
                status = SecItemAdd(add as CFDictionary, nil)
            }
            guard status == errSecSuccess else { throw accessError("write", status) }
            return ["ok": true]
        }
    }

    public static func get(service: String, account: String) throws -> [String: Any] {
        return try withoutPrompts {
            var query = nonInteractiveQuery(service: service, account: account)
            query[kSecReturnData as String] = true
            query[kSecMatchLimit as String] = kSecMatchLimitOne
            var item: CFTypeRef?
            let status = SecItemCopyMatching(query as CFDictionary, &item)
            if status == errSecItemNotFound { return ["value": NSNull()] }
            guard status == errSecSuccess, let data = item as? Data, let value = String(data: data, encoding: .utf8) else {
                throw accessError("read", status)
            }
            return ["value": value]
        }
    }

    public static func delete(service: String, account: String) throws -> [String: Any] {
        return try withoutPrompts {
            let status = SecItemDelete(baseQuery(service: service, account: account) as CFDictionary)
            if status == errSecItemNotFound { return ["deleted": false] }
            guard status == errSecSuccess else { throw accessError("delete", status) }
            return ["deleted": true]
        }
    }

    public static func list(service: String) throws -> [String: Any] {
        return try withoutPrompts {
            let context = LAContext()
            context.interactionNotAllowed = true
            let query: [String: Any] = [
                kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: service,
                kSecReturnAttributes as String: true,
                kSecMatchLimit as String: kSecMatchLimitAll,
                kSecUseAuthenticationContext as String: context,
            ]
            var items: CFTypeRef?
            let status = SecItemCopyMatching(query as CFDictionary, &items)
            if status == errSecItemNotFound { return ["accounts": [String]()] }
            guard status == errSecSuccess, let arr = items as? [[String: Any]] else {
                throw accessError("list", status)
            }
            let accounts = arr.compactMap { $0[kSecAttrAccount as String] as? String }.sorted()
            return ["accounts": accounts]
        }
    }
}
