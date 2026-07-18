// HTTPServer.swift
//
// Minimal blocking HTTP/1.1 server on raw POSIX sockets, one thread per
// connection. No third-party HTTP dependency and — deliberately — NOT built
// on Apple's `Network` framework.
//
// Why POSIX sockets instead of NWListener:
//   Linking the MLX / Metal libraries into this executable was observed to
//   wedge Network.framework's NWConnection callback delivery — accepted
//   connections never progress past `.setup` and `receive` callbacks never
//   fire (a libdispatch/Metal init interaction). A standalone NWListener
//   test WITHOUT MLX worked fine; the same code linked against MLX hangs.
//   Raw sockets on their own threads are immune to that interaction and give
//   us full, predictable control for this tiny localhost sidecar.
//
// Scope is intentionally narrow — exactly what the Rust readiness poll and
// the OpenAI client need:
//   * GET  /v1/models            (buffered JSON)
//   * POST /v1/chat/completions  (buffered JSON, or streamed SSE)
//
// It parses the request line, headers and a Content-Length body. No
// keep-alive (every response is `Connection: close`), no chunked request
// bodies, no TLS — none are needed for a 127.0.0.1 sidecar.

import Foundation

#if canImport(Glibc)
import Glibc
#else
import Darwin
#endif

private let LOOPBACK_HOST = "127.0.0.1"
private let MAX_HEADER_BYTES = 1 << 20
private let MAX_BODY_BYTES = 16 << 20
// Cap simultaneous in-flight connections so a local retry storm cannot spawn
// unbounded per-connection threads (each carries a 2 MB stack).
private let MAX_INFLIGHT_CONNECTIONS = 8
// Read timeout (seconds) on accepted client sockets so a slow/partial body
// cannot block a connection thread on `recv` forever.
private let CLIENT_READ_TIMEOUT_SECONDS = 30

/// A parsed inbound HTTP request.
struct HTTPRequest {
    let method: String
    let path: String
    let headers: [String: String]
    let body: Data
}

/// What a handler returns. Either a single buffered response, or a streaming
/// (Server-Sent Events) response driven by a closure that pushes chunks.
enum HTTPResponse {
    case buffered(status: Int, contentType: String, body: Data)
    /// `producer` is handed three closures and runs on the connection's thread:
    ///   * `send`     — write a raw UTF-8 SSE frame; returns `false` when the
    ///                  socket write failed (client disconnected). The producer
    ///                  must stop generating and signal `done` on `false`.
    ///   * `done`     — finish the response (unblocks the connection thread).
    ///   * `onCancel` — register a closure the server invokes if it detects the
    ///                  client went away mid-stream, so the producer can cancel
    ///                  its in-flight generation `Task`.
    case sse(producer: @Sendable (_ send: @escaping (String) -> Bool,
                                  _ done: @escaping () -> Void,
                                  _ onCancel: @escaping (@escaping @Sendable () -> Void) -> Void) -> Void)

    static func json(_ status: Int, _ object: Any) -> HTTPResponse {
        let data = (try? JSONSerialization.data(withJSONObject: object, options: []))
            ?? Data("{}".utf8)
        return .buffered(status: status, contentType: "application/json", body: data)
    }
}

private func reasonPhrase(_ status: Int) -> String {
    switch status {
    case 200: return "OK"
    case 400: return "Bad Request"
    case 404: return "Not Found"
    case 405: return "Method Not Allowed"
    case 500: return "Internal Server Error"
    case 503: return "Service Unavailable"
    default: return "OK"
    }
}

/// Thread-safe one-shot box holding the producer's cancellation closure.
/// The connection thread fires it when a write to a dead socket is detected;
/// firing before the closure is registered still cancels (deferred fire).
private final class CancelBox: @unchecked Sendable {
    private let lock = NSLock()
    private var handler: (@Sendable () -> Void)?
    private var fired = false

    func set(_ h: @escaping @Sendable () -> Void) {
        lock.lock()
        if fired {
            lock.unlock()
            h() // a disconnect was already detected; cancel immediately
            return
        }
        handler = h
        lock.unlock()
    }

    func fire() {
        lock.lock()
        if fired { lock.unlock(); return }
        fired = true
        let h = handler
        handler = nil
        lock.unlock()
        h?()
    }
}

final class HTTPServer: @unchecked Sendable {
    private let host: String
    private let port: UInt16
    private let handler: @Sendable (HTTPRequest) -> HTTPResponse
    private var listenFD: Int32 = -1
    /// Bounds the number of in-flight connection threads (L7).
    private let connectionSlots = DispatchSemaphore(value: MAX_INFLIGHT_CONNECTIONS)
    /// Set when `stop()` is called so the accept loop exits cleanly.
    /// `stop()` runs on the main thread (SIGTERM handler) while the accept
    /// loop reads it on a dedicated POSIX worker — Swift considers a plain
    /// `Bool` read/write across threads a data race. A single lock around
    /// every read/write is the smallest possible primitive: there is no
    /// performance-sensitive code path here (the value is checked at most
    /// twice per accepted connection), and `NSLock` is `Sendable` so it
    /// plays cleanly with the `@unchecked Sendable` envelope on the class.
    private let stoppingLock = NSLock()
    private var _stopping = false
    private var stopping: Bool {
        stoppingLock.lock()
        defer { stoppingLock.unlock() }
        return _stopping
    }
    private func setStopping() {
        stoppingLock.lock()
        defer { stoppingLock.unlock() }
        _stopping = true
    }

    init(host: String, port: UInt16,
         handler: @escaping @Sendable (HTTPRequest) -> HTTPResponse) throws {
        // This sidecar is for same-machine inference only. Rust launches it
        // with 127.0.0.1, but keep the binary safe if run by hand with a
        // broader host such as 0.0.0.0.
        let bindHost = host == LOOPBACK_HOST ? host : LOOPBACK_HOST
        self.host = bindHost
        self.port = port
        self.handler = handler

        let fd = socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else {
            throw HTTPServerError.posix("socket", errno)
        }

        var yes: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &yes, socklen_t(MemoryLayout<Int32>.size))

        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = port.bigEndian
        // Bind only to IPv4 loopback so the server is never reachable beyond
        // the local machine.
        if inet_pton(AF_INET, bindHost, &addr.sin_addr) != 1 {
            addr.sin_addr.s_addr = INADDR_LOOPBACK.bigEndian
        }

        let bindResult = withUnsafePointer(to: &addr) { ptr in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        guard bindResult == 0 else {
            let e = errno
            close(fd)
            throw HTTPServerError.posix("bind \(bindHost):\(port)", e)
        }
        guard listen(fd, 64) == 0 else {
            let e = errno
            close(fd)
            throw HTTPServerError.posix("listen", e)
        }
        self.listenFD = fd
    }

    enum HTTPServerError: Error, CustomStringConvertible {
        case posix(String, Int32)
        var description: String {
            switch self {
            case let .posix(op, e):
                return "\(op): \(String(cString: strerror(e))) (errno \(e))"
            }
        }
    }

    /// Spawn the accept loop on a dedicated background thread.
    func start() {
        let t = Thread { [weak self] in self?.acceptLoop() }
        t.name = "mlx-server.accept"
        t.stackSize = 1 << 20
        t.start()
    }

    /// Stop accepting new connections and tear down the listen socket. Used by
    /// the SIGTERM graceful-shutdown path. In-flight connections drain on their
    /// own threads; the process exits shortly after.
    func stop() {
        setStopping()
        let fd = listenFD
        listenFD = -1
        if fd >= 0 { close(fd) } // unblocks the blocking accept()
    }

    private func acceptLoop() {
        while !stopping {
            // Bound concurrency: wait for a free connection slot before
            // accepting, so a retry storm can't spawn unbounded threads (L7).
            connectionSlots.wait()
            if stopping { connectionSlots.signal(); break }

            var clientAddr = sockaddr()
            var len = socklen_t(MemoryLayout<sockaddr>.size)
            let clientFD = accept(listenFD, &clientAddr, &len)
            if clientFD < 0 {
                connectionSlots.signal()
                if errno == EINTR { continue }
                break
            }
            applyReadTimeout(clientFD)
            // One thread per connection. Connections are short-lived
            // (Connection: close) so this stays bounded for a local sidecar,
            // and the semaphore caps the worst case.
            let worker = Thread { [weak self] in
                defer { self?.connectionSlots.signal() }
                self?.serve(clientFD)
            }
            worker.stackSize = 1 << 21
            worker.start()
        }
    }

    /// Apply a `SO_RCVTIMEO` read timeout so a slow/partial body cannot block a
    /// connection thread on `recv` indefinitely (L10).
    private func applyReadTimeout(_ fd: Int32) {
        var tv = timeval(tv_sec: CLIENT_READ_TIMEOUT_SECONDS, tv_usec: 0)
        setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv,
                   socklen_t(MemoryLayout<timeval>.size))
    }

    // MARK: - Per-connection handling

    private func serve(_ fd: Int32) {
        defer { close(fd) }

        guard let (request, _) = readRequest(fd) else {
            writeAll(fd, Data("HTTP/1.1 400 Bad Request\r\nContent-Length: 12\r\nConnection: close\r\n\r\nbad request\n".utf8))
            return
        }

        let response = handler(request)
        switch response {
        case let .buffered(status, contentType, body):
            var head = "HTTP/1.1 \(status) \(reasonPhrase(status))\r\n"
            head += "Content-Type: \(contentType)\r\n"
            head += "Content-Length: \(body.count)\r\n"
            head += "Connection: close\r\n\r\n"
            var out = Data(head.utf8)
            out.append(body)
            writeAll(fd, out)

        case let .sse(producer):
            var head = "HTTP/1.1 200 OK\r\n"
            head += "Content-Type: text/event-stream\r\n"
            head += "Cache-Control: no-cache\r\n"
            head += "Connection: close\r\n\r\n"
            writeAll(fd, Data(head.utf8))
            // Plain SSE over a Connection: close stream — no chunked framing
            // needed since the client reads until EOF.
            //
            // The producer typically generates tokens asynchronously and
            // signals completion via `done`. We MUST block this connection
            // thread until `done` fires, otherwise `defer { close(fd) }`
            // would close the socket before any token is written.
            let finished = DispatchSemaphore(value: 0)
            // Cancellation handle the producer registers (its generation Task).
            // Invoked once when a write to a dead socket is detected so the
            // upstream generation stops instead of running to max_tokens.
            let cancelBox = CancelBox()
            let send: (String) -> Bool = { [weak self] frame in
                guard let self else { return false }
                let ok = self.writeAll(fd, Data(frame.utf8))
                if !ok {
                    // Client disconnected mid-stream: stop generation.
                    cancelBox.fire()
                }
                return ok
            }
            let done: () -> Void = { finished.signal() }
            let onCancel: (@escaping @Sendable () -> Void) -> Void = { handler in
                cancelBox.set(handler)
            }
            producer(send, done, onCancel)
            finished.wait()
        }
    }

    /// Read the full header block, then the Content-Length body.
    private func readRequest(_ fd: Int32) -> (HTTPRequest, Data)? {
        var buffer = Data()
        var headerEnd: Range<Data.Index>?

        // Read until we have the header terminator.
        while headerEnd == nil {
            guard let chunk = readSome(fd), !chunk.isEmpty else { return nil }
            buffer.append(chunk)
            headerEnd = rangeOfHeaderTerminator(buffer)
            if buffer.count > MAX_HEADER_BYTES { return nil }
        }

        let he = headerEnd!
        guard let parsed = parseHeaders(buffer.subdata(in: 0..<he.lowerBound)) else {
            return nil
        }

        let bodyStart = he.upperBound
        guard let contentLength = Int(parsed.headers["content-length"] ?? "0"),
              contentLength >= 0,
              contentLength <= MAX_BODY_BYTES
        else {
            return nil
        }
        var body = bodyStart < buffer.count
            ? buffer.subdata(in: bodyStart..<buffer.count)
            : Data()

        if body.count > MAX_BODY_BYTES { return nil }

        while body.count < contentLength {
            guard let chunk = readSome(fd), !chunk.isEmpty else { break }
            body.append(chunk)
            if body.count > MAX_BODY_BYTES { return nil }
        }
        if body.count > contentLength { body = body.subdata(in: 0..<contentLength) }

        let req = HTTPRequest(method: parsed.method, path: parsed.path,
                              headers: parsed.headers, body: body)
        return (req, body)
    }

    private func readSome(_ fd: Int32) -> Data? {
        var tmp = [UInt8](repeating: 0, count: 64 * 1024)
        let n = tmp.withUnsafeMutableBytes { recv(fd, $0.baseAddress, $0.count, 0) }
        if n < 0 {
            if errno == EINTR { return Data() }
            return nil
        }
        if n == 0 { return Data() } // peer closed
        return Data(tmp[0..<n])
    }

    @discardableResult
    private func writeAll(_ fd: Int32, _ data: Data) -> Bool {
        var ok = true
        data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
            guard var p = raw.baseAddress else { return }
            var remaining = raw.count
            while remaining > 0 {
                let n = send(fd, p, remaining, 0)
                if n <= 0 {
                    if n < 0 && errno == EINTR { continue }
                    ok = false
                    return
                }
                p = p.advanced(by: n)
                remaining -= n
            }
        }
        return ok
    }

    // MARK: - Parsing helpers

    private func rangeOfHeaderTerminator(_ data: Data) -> Range<Data.Index>? {
        if let r = data.range(of: Data("\r\n\r\n".utf8)) { return r }
        if let r = data.range(of: Data("\n\n".utf8)) { return r }
        return nil
    }

    private func parseHeaders(_ data: Data)
        -> (method: String, path: String, headers: [String: String])? {
        guard let text = String(data: data, encoding: .utf8) else { return nil }
        let lines = text.replacingOccurrences(of: "\r\n", with: "\n")
            .split(separator: "\n", omittingEmptySubsequences: false)
            .map(String.init)
        guard let requestLine = lines.first else { return nil }
        let parts = requestLine.split(separator: " ")
        guard parts.count >= 2 else { return nil }
        let method = String(parts[0]).uppercased()
        let path = String(parts[1])

        var headers: [String: String] = [:]
        for line in lines.dropFirst() {
            if line.isEmpty { break }
            guard let colon = line.firstIndex(of: ":") else { continue }
            let key = line[..<colon].trimmingCharacters(in: .whitespaces).lowercased()
            let value = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
            headers[key] = value
        }
        return (method, path, headers)
    }
}
