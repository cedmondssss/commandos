import AppKit
import Foundation
import HelperCore

// CommandOSHelper: JSON-lines RPC over stdin/stdout. One request per line; responses may arrive out of order.
// The main thread runs the run loop (needed by NSMetadataQuery, NSAppleScript and AppKit); stdin is read on a
// background thread and each request is handled in its own task.

setvbuf(stdout, nil, _IOLBF, 0)
let app = NSApplication.shared
app.setActivationPolicy(.prohibited)

let writer = LineWriter()
let dispatcher = Dispatcher()
registerAllMethods(dispatcher)

writer.writeObject(["event": "ready", "version": helperVersion, "pid": Int(getpid()), "methods": dispatcher.methods])

let reader = Thread {
    while let line = readLine(strippingNewline: true) {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        if trimmed.isEmpty { continue }
        Task.detached {
            let response = await dispatcher.handle(line: trimmed)
            writer.write(response)
        }
    }
    // stdin closed: the parent process is gone.
    exit(0)
}
reader.name = "stdin-reader"
reader.start()
RunLoop.main.run()
