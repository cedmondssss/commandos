import Foundation

public let helperVersion = "0.1.0"

/// Error surfaced to the TypeScript client as `{"ok":false,"error":{"code","message"}}`.
public struct HelperError: Error, Equatable {
    public let code: String
    public let message: String
    public init(_ code: String, _ message: String) {
        self.code = code
        self.message = message
    }
}

public typealias Params = [String: Any]
public typealias Handler = (Params) async throws -> Any

/// Typed accessors over decoded JSON params. Every accessor throws `bad_params` on a type mismatch.
public extension Dictionary where Key == String, Value == Any {
    func string(_ key: String) throws -> String {
        guard let v = self[key] as? String else { throw HelperError("bad_params", "missing or non-string param '\(key)'") }
        return v
    }
    func optString(_ key: String) throws -> String? {
        guard let raw = self[key], !(raw is NSNull) else { return nil }
        guard let v = raw as? String else { throw HelperError("bad_params", "param '\(key)' must be a string") }
        return v
    }
    func int(_ key: String) throws -> Int {
        guard let n = self[key] as? NSNumber else {
            throw HelperError("bad_params", "missing or non-numeric param '\(key)'")
        }
        return n.intValue
    }
    func optInt(_ key: String) throws -> Int? {
        guard let raw = self[key], !(raw is NSNull) else { return nil }
        guard let n = raw as? NSNumber else { throw HelperError("bad_params", "param '\(key)' must be a number") }
        return n.intValue
    }
    func bool(_ key: String) throws -> Bool {
        guard let b = self[key] as? Bool else { throw HelperError("bad_params", "missing or non-boolean param '\(key)'") }
        return b
    }
    func optBool(_ key: String) -> Bool? {
        self[key] as? Bool
    }
    func stringArray(_ key: String) throws -> [String] {
        guard let raw = self[key] else { return [] }
        if raw is NSNull { return [] }
        guard let arr = raw as? [Any] else { throw HelperError("bad_params", "param '\(key)' must be an array") }
        return try arr.map { item in
            guard let s = item as? String else { throw HelperError("bad_params", "param '\(key)' must contain strings") }
            return s
        }
    }
    func object(_ key: String) throws -> Params {
        guard let raw = self[key] else { return [:] }
        if raw is NSNull { return [:] }
        guard let o = raw as? Params else { throw HelperError("bad_params", "param '\(key)' must be an object") }
        return o
    }
}

/// Converts arbitrary values into JSON-safe values (NaN/Inf → null, Date → ISO string, nil → NSNull).
public func jsonSafe(_ value: Any?) -> Any {
    guard let value else { return NSNull() }
    let mirror = Mirror(reflecting: value)
    if mirror.displayStyle == .optional {
        if let child = mirror.children.first { return jsonSafe(child.value) }
        return NSNull()
    }
    switch value {
    case let d as Double:
        return d.isFinite ? d : NSNull()
    case let f as Float:
        return f.isFinite ? Double(f) : NSNull()
    case let c as CGFloat:
        return c.isFinite ? Double(c) : NSNull()
    case let date as Date:
        return isoString(date)
    case let arr as [Any]:
        return arr.map { jsonSafe($0) }
    case let dict as [String: Any]:
        return dict.mapValues { jsonSafe($0) }
    default:
        return value
    }
}

private let isoFormatter: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f
}()

/// Wraps an optional so it serializes as JSON null when absent.
public func orNull(_ value: Any?) -> Any {
    value ?? NSNull()
}

public func isoString(_ date: Date) -> String {
    isoFormatter.string(from: date)
}

public func encodeLine(_ object: [String: Any]) -> String {
    let safe = jsonSafe(object)
    if let data = try? JSONSerialization.data(withJSONObject: safe, options: [.withoutEscapingSlashes]),
       let s = String(data: data, encoding: .utf8) {
        return s
    }
    return #"{"ok":false,"error":{"code":"encode_failed","message":"could not encode response"}}"#
}

/// Routes JSON-lines requests to registered handlers.
public final class Dispatcher: @unchecked Sendable {
    private var handlers: [String: Handler] = [:]
    private let lock = NSLock()

    public init() {}

    public func register(_ method: String, _ handler: @escaping Handler) {
        lock.lock(); defer { lock.unlock() }
        handlers[method] = handler
    }

    public var methods: [String] {
        lock.lock(); defer { lock.unlock() }
        return handlers.keys.sorted()
    }

    public func handle(line: String) async -> String {
        guard let data = line.data(using: .utf8),
              let decoded = try? JSONSerialization.jsonObject(with: data),
              let obj = decoded as? [String: Any] else {
            return encodeLine(["id": NSNull(), "ok": false, "error": ["code": "bad_request", "message": "request is not a JSON object"]])
        }
        let id = (obj["id"] as? String) ?? ""
        guard let method = obj["method"] as? String else {
            return encodeLine(["id": id, "ok": false, "error": ["code": "bad_request", "message": "missing method"]])
        }
        let handler = lock.withLock { handlers[method] }
        guard let handler else {
            return encodeLine(["id": id, "ok": false, "error": ["code": "unknown_method", "message": "unknown method '\(method)'"]])
        }
        let params = (obj["params"] as? Params) ?? [:]
        do {
            let result = try await handler(params)
            return encodeLine(["id": id, "ok": true, "result": result])
        } catch let e as HelperError {
            return encodeLine(["id": id, "ok": false, "error": ["code": e.code, "message": e.message]])
        } catch {
            return encodeLine(["id": id, "ok": false, "error": ["code": "internal", "message": String(describing: error)]])
        }
    }
}

/// Serializes writes of whole lines to stdout.
public final class LineWriter: @unchecked Sendable {
    private let lock = NSLock()
    private let handle = FileHandle.standardOutput

    public init() {}

    public func write(_ line: String) {
        lock.lock(); defer { lock.unlock() }
        if let data = (line + "\n").data(using: .utf8) {
            handle.write(data)
        }
    }

    public func writeObject(_ object: [String: Any]) {
        write(encodeLine(object))
    }
}
