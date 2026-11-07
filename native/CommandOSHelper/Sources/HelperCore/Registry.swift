import Foundation

/// Registers every RPC method. Method names and shapes mirror packages/contracts/src/helper.ts.
public func registerAllMethods(_ d: Dispatcher) {
    d.register("ping") { _ in
        ["pong": true, "version": helperVersion, "pid": Int(getpid())]
    }

    // Permissions
    d.register("permissions.status") { _ in Permissions.status() }
    d.register("permissions.request") { p in
        let kind = try p.string("kind")
        return try await MainActor.run { try Permissions.request(kind: kind) }
    }

    // Applications
    d.register("apps.list") { _ in await MainActor.run { Apps.list() } }
    d.register("apps.frontmost") { _ in await MainActor.run { Apps.frontmost() } }
    d.register("apps.info") { p in
        let bundleId = try p.string("bundleId")
        return try await MainActor.run { try Apps.info(bundleId: bundleId) }
    }
    d.register("apps.launch") { p in
        try await Apps.launch(bundleId: try p.string("bundleId"), activate: p.optBool("activate") ?? true)
    }
    d.register("apps.activate") { p in
        let bundleId = try p.string("bundleId")
        return try await MainActor.run { try Apps.activate(bundleId: bundleId) }
    }
    d.register("apps.quit") { p in
        let bundleId = try p.string("bundleId")
        let force = p.optBool("force") ?? false
        return await MainActor.run { Apps.quit(bundleId: bundleId, force: force) }
    }

    // Workspace
    d.register("workspace.open") { p in
        let path = try p.optString("path")
        let url = try p.optString("url")
        let bundleId = try p.optString("bundleId")
        return try await MainActor.run { try Workspace.open(path: path, url: url, bundleId: bundleId) }
    }
    d.register("workspace.reveal") { p in
        let paths = try p.stringArray("paths")
        return await MainActor.run { Workspace.reveal(paths: paths) }
    }

    // Spotlight, images, OCR, capture
    d.register("spotlight.query") { p in
        try await Spotlight.query(
            try p.string("query"),
            scopes: try p.stringArray("scopes"),
            limit: try p.optInt("limit") ?? 200,
            timeoutMs: try p.optInt("timeoutMs") ?? 5_000
        )
    }
    d.register("image.info") { p in try ImageTools.info(path: try p.string("path")) }
    d.register("vision.ocr") { p in
        try ImageTools.ocr(
            path: try p.string("path"),
            fast: (try p.optString("level") ?? "accurate") == "fast",
            languages: try p.stringArray("languages")
        )
    }
    d.register("screen.capture") { p in
        try await ScreenCapture.capture(
            target: try p.string("target"),
            bundleId: try p.optString("bundleId"),
            windowId: try p.optInt("windowId"),
            titleContains: try p.optString("titleContains"),
            outPath: try p.string("outPath")
        )
    }

    // Accessibility
    d.register("ax.tree") { p in
        try await Accessibility.tree(
            bundleId: try p.string("bundleId"),
            maxDepth: try p.optInt("maxDepth") ?? 12,
            maxNodes: try p.optInt("maxNodes") ?? 800,
            scope: try p.optString("scope") ?? "application"
        )
    }
    d.register("ax.find") { p in
        let q = try p.object("query")
        let query = AxQuery(
            role: try q.optString("role"),
            text: try q.optString("text"),
            identifier: try q.optString("identifier"),
            enabledOnly: q.optBool("enabledOnly") ?? false
        )
        return try await Accessibility.find(
            bundleId: try p.string("bundleId"),
            query: query,
            maxResults: try p.optInt("maxResults") ?? 20,
            maxDepth: try p.optInt("maxDepth") ?? 20
        )
    }
    d.register("ax.press") { p in try Accessibility.press(ref: try AxRef.parse(try p.string("ref"))) }
    d.register("ax.setValue") { p in
        try Accessibility.setValue(ref: try AxRef.parse(try p.string("ref")), value: try p.string("value"))
    }
    d.register("ax.getValue") { p in try Accessibility.getValue(ref: try AxRef.parse(try p.string("ref"))) }
    d.register("ax.focus") { p in try Accessibility.focus(ref: try AxRef.parse(try p.string("ref"))) }
    d.register("ax.focused") { _ in try await Accessibility.focused() }
    d.register("ax.fill") { p in
        let query = AxQuery(role: try p.string("role"), text: try p.optString("text"), identifier: try p.optString("identifier"), enabledOnly: true)
        return try await Accessibility.fill(bundleId: try p.string("bundleId"), query: query, value: try p.string("value"))
    }
    d.register("ax.click") { p in
        let query = AxQuery(role: try p.string("role"), text: try p.optString("text"), identifier: try p.optString("identifier"), enabledOnly: true)
        return try await Accessibility.click(bundleId: try p.string("bundleId"), query: query, expectLabel: try p.string("expectLabel"))
    }
    d.register("ax.enableWeb") { p in try await Accessibility.enableWeb(bundleId: try p.string("bundleId"), on: p.optBool("on") ?? true) }
    d.register("ax.webText") { p in try await Accessibility.webText(bundleId: try p.string("bundleId"), maxChars: try p.optInt("maxChars") ?? 20_000) }
    d.register("keyboard.type") { p in
        try Keyboard.type(try p.string("text"), perCharacter: p.optBool("perCharacter") ?? false, expectedRef: try p.optString("expectedRef").map(AxRef.parse))
    }
    d.register("keyboard.press") { p in
        try KeyPress.press(key: try p.string("key"), modifiers: try p.stringArray("modifiers"), expectedRef: try p.optString("expectedRef").map(AxRef.parse))
    }
    d.register("mouse.click") { p in
        guard let x = p["x"] as? NSNumber, let y = p["y"] as? NSNumber else { throw HelperError("bad_params", "x and y are required") }
        return try Mouse.click(x: x.doubleValue, y: y.doubleValue, button: try p.optString("button") ?? "left", clicks: try p.optInt("clicks") ?? 1)
    }

    // Apple Events (templates are authored by CommandOS, never by the model)
    d.register("osa.run") { p in
        let source = try p.string("source")
        return try await MainActor.run { try AppleScriptRunner.run(source: source) }
    }

    // Files
    d.register("fs.trash") { p in try FileOps.trash(path: try p.string("path")) }

    // Keychain (generic passwords; secrets never logged)
    d.register("keychain.get") { p in try Keychain.get(service: try p.string("service"), account: try p.string("account")) }
    d.register("keychain.set") { p in
        try Keychain.set(service: try p.string("service"), account: try p.string("account"), value: try p.string("value"))
    }
    d.register("keychain.delete") { p in
        try Keychain.delete(service: try p.string("service"), account: try p.string("account"))
    }
    d.register("keychain.list") { p in try Keychain.list(service: try p.string("service")) }
}
