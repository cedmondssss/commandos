import Foundation
import LocalAuthentication
import Security
@testable import HelperCore
import XCTest

final class DispatcherTests: XCTestCase {
    func decode(_ line: String) throws -> [String: Any] {
        let obj = try JSONSerialization.jsonObject(with: Data(line.utf8))
        return try XCTUnwrap(obj as? [String: Any])
    }

    func testSuccessResponseEchoesId() async throws {
        let d = Dispatcher()
        d.register("echo") { p in ["got": try p.string("x")] }
        let out = try decode(await d.handle(line: #"{"id":"r1","method":"echo","params":{"x":"hi"}}"#))
        XCTAssertEqual(out["id"] as? String, "r1")
        XCTAssertEqual(out["ok"] as? Bool, true)
        XCTAssertEqual((out["result"] as? [String: Any])?["got"] as? String, "hi")
    }

    func testUnknownMethod() async throws {
        let d = Dispatcher()
        let out = try decode(await d.handle(line: #"{"id":"r2","method":"nope","params":{}}"#))
        XCTAssertEqual(out["ok"] as? Bool, false)
        XCTAssertEqual((out["error"] as? [String: Any])?["code"] as? String, "unknown_method")
    }

    func testMalformedJson() async throws {
        let d = Dispatcher()
        let out = try decode(await d.handle(line: "not json"))
        XCTAssertEqual((out["error"] as? [String: Any])?["code"] as? String, "bad_request")
    }

    func testBadParamsSurfaceAsHelperError() async throws {
        let d = Dispatcher()
        d.register("needs") { p in ["v": try p.int("n")] }
        let out = try decode(await d.handle(line: #"{"id":"r3","method":"needs","params":{"n":"x"}}"#))
        XCTAssertEqual((out["error"] as? [String: Any])?["code"] as? String, "bad_params")
    }

    func testOptionalAndNonFiniteValuesEncodeAsNull() throws {
        let missing: String? = nil
        let line = encodeLine(["a": orNull(missing), "b": Double.nan, "c": ["x": Optional<Int>.none as Any]])
        let out = try decode(line)
        XCTAssertTrue(out["a"] is NSNull)
        XCTAssertTrue(out["b"] is NSNull)
        XCTAssertTrue((out["c"] as? [String: Any])?["x"] is NSNull)
    }

    func testAllContractMethodsRegistered() {
        let d = Dispatcher()
        registerAllMethods(d)
        let expected = [
            "ping", "permissions.status", "permissions.request", "apps.list", "apps.frontmost", "apps.info",
            "apps.launch", "apps.activate", "apps.quit", "workspace.open", "workspace.reveal", "spotlight.query",
            "vision.ocr", "image.info", "screen.capture", "ax.tree", "ax.find", "ax.press", "ax.setValue",
            "ax.getValue", "ax.focus", "ax.focused", "ax.fill", "ax.click", "ax.enableWeb", "ax.webText", "keyboard.type", "keyboard.press", "mouse.click", "osa.run", "fs.trash", "keychain.get",
            "keychain.set", "keychain.delete", "keychain.list",
        ]
        XCTAssertEqual(Set(d.methods), Set(expected))
    }
}

final class AxRefTests: XCTestCase {
    func testRoundTrip() throws {
        let ref = try AxRef.parse("123:0.4.2")
        XCTAssertEqual(ref.pid, 123)
        XCTAssertEqual(ref.path, [0, 4, 2])
        XCTAssertEqual(ref.string, "123:0.4.2")
        XCTAssertEqual(try AxRef.parse("55:").path, [])
    }

    func testRejectsInvalid() {
        XCTAssertThrowsError(try AxRef.parse("abc:1"))
        XCTAssertThrowsError(try AxRef.parse("12:1.-3"))
        XCTAssertThrowsError(try AxRef.parse("12"))
    }

    func testQueryMatching() {
        let q = AxQuery(role: "AXButton", text: "save", identifier: nil, enabledOnly: true)
        XCTAssertTrue(q.matches(role: "AXButton", texts: ["Save Draft", nil], identifier: nil, enabled: true))
        XCTAssertFalse(q.matches(role: "AXTextField", texts: ["Save"], identifier: nil, enabled: true))
        XCTAssertFalse(q.matches(role: "AXButton", texts: ["Cancel"], identifier: nil, enabled: true))
        XCTAssertFalse(q.matches(role: "AXButton", texts: ["Save"], identifier: nil, enabled: false))
    }
}

final class KeyPressTests: XCTestCase {
    func testKeyCodes() throws {
        XCTAssertEqual(try KeyPress.keyCode("return"), 36)
        XCTAssertEqual(try KeyPress.keyCode("ArrowDown"), 125)
        XCTAssertEqual(try KeyPress.keyCode("ArrowUp"), 126)
        XCTAssertEqual(try KeyPress.keyCode("ArrowLeft"), 123)
        XCTAssertEqual(try KeyPress.keyCode("ArrowRight"), 124)
        XCTAssertEqual(try KeyPress.keyCode("S"), 1)
        XCTAssertEqual(try KeyPress.keyCode("n"), 45)
        XCTAssertThrowsError(try KeyPress.keyCode("hyper"))
    }
}

final class KeychainTests: XCTestCase {
    func testQueriesDisallowInteractiveAuthentication() throws {
        let query = Keychain.nonInteractiveQuery(service: "com.commandos.tests", account: "k")
        let context = try XCTUnwrap(query[kSecUseAuthenticationContext as String] as? LAContext)
        XCTAssertTrue(context.interactionNotAllowed)
    }

    func testScopedUISettingIsRestoredAfterFailure() throws {
        var before = DarwinBoolean(false)
        XCTAssertEqual(SecKeychainGetUserInteractionAllowed(&before), errSecSuccess)
        XCTAssertThrowsError(try Keychain.withoutPrompts {
            var during = DarwinBoolean(true)
            XCTAssertEqual(SecKeychainGetUserInteractionAllowed(&during), errSecSuccess)
            XCTAssertFalse(during.boolValue)
            throw HelperError("fixture", "expected fixture error")
        })
        var after = DarwinBoolean(false)
        XCTAssertEqual(SecKeychainGetUserInteractionAllowed(&after), errSecSuccess)
        XCTAssertEqual(before.boolValue, after.boolValue)
    }

    func testRoundTrip() throws {
        let service = "com.commandos.tests.\(UUID().uuidString)"
        defer { _ = try? Keychain.delete(service: service, account: "k") }
        _ = try Keychain.set(service: service, account: "k", value: "v1")
        XCTAssertEqual(try Keychain.get(service: service, account: "k")["value"] as? String, "v1")
        _ = try Keychain.set(service: service, account: "k", value: "v2")
        XCTAssertEqual(try Keychain.get(service: service, account: "k")["value"] as? String, "v2")
        XCTAssertEqual(try Keychain.list(service: service)["accounts"] as? [String], ["k"])
        XCTAssertEqual(try Keychain.delete(service: service, account: "k")["deleted"] as? Bool, true)
        XCTAssertTrue(try Keychain.get(service: service, account: "k")["value"] is NSNull)
    }
}
