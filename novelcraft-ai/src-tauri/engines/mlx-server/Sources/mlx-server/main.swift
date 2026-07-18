// main.swift
//
// Entry point for the slim macOS MLX OpenAI-compatible server.
//
// CLI contract (driven by src-tauri/src/engine.rs):
//   mlx-server --host 127.0.0.1 --port <P> --model <MODEL_DIR>
//
// HTTP contract (driven by the Rust readiness poll + OpenAI clients):
//   GET  /v1/models            -> 503 while the model is still loading;
//                                 200 + {"object":"list","data":[...]} once ready.
//   POST /v1/chat/completions  -> OpenAI chat completion (buffered JSON), or
//                                 text/event-stream SSE when {"stream":true}.

import Foundation
import Darwin
import MLXLMCommon

signal(SIGPIPE, SIG_IGN)

// MARK: - Argument parsing

func parseArgs() -> (host: String, port: UInt16, model: String) {
    var host = "127.0.0.1"
    var port: UInt16 = 8080
    var model: String?

    let args = Array(CommandLine.arguments.dropFirst())
    var i = 0
    while i < args.count {
        let a = args[i]
        func next() -> String? { i + 1 < args.count ? args[i + 1] : nil }
        switch a {
        case "--host":
            if let v = next() { host = v; i += 1 }
        case "--port":
            if let v = next() {
                guard let p = UInt16(v) else {
                    FileHandle.standardError.write(Data(
                        "[mlx-server] invalid --port value: \(v)\n".utf8))
                    exit(2)
                }
                port = p; i += 1
            }
        case "--model":
            if let v = next() { model = v; i += 1 }
        default:
            break
        }
        i += 1
    }

    guard let model else {
        FileHandle.standardError.write(Data(
            "usage: mlx-server --host <H> --port <P> --model <MODEL_DIR>\n".utf8))
        exit(2)
    }
    return (host, port, model)
}

let (host, port, modelPath) = parseArgs()

let modelURL = URL(fileURLWithPath: modelPath, isDirectory: true)
guard FileManager.default.fileExists(atPath: modelURL.path) else {
    FileHandle.standardError.write(Data(
        "[mlx-server] model directory does not exist: \(modelURL.path)\n".utf8))
    exit(2)
}

let engine = MLXEngine(modelDirectory: modelURL)

// Kick off model loading in the background. The HTTP server comes up
// immediately so the Rust readiness poll observes 503 → 200 transition
// rather than connection-refused.
Task.detached(priority: .userInitiated) {
    await engine.load()
}

// MARK: - Routing

@Sendable func handle(_ req: HTTPRequest) -> HTTPResponse {
    switch (req.method, req.path) {
    case ("GET", "/v1/models"), ("GET", "/v1/models/"):
        // Block-and-wait briefly is wrong here (handler is sync); instead
        // reflect engine state directly. 503 keeps the Rust poll waiting.
        let sem = DispatchSemaphore(value: 0)
        var ready = false
        var failure: String?
        Task {
            ready = await engine.isReady
            failure = await engine.failureMessage
            sem.signal()
        }
        sem.wait()

        if let failure {
            return .json(503, ["error": ["message": failure, "type": "model_load_error"]])
        }
        if !ready {
            return .json(503, ["error": ["message": "model is still loading",
                                         "type": "model_loading"]])
        }
        let id = modelURL.lastPathComponent
        return .json(200, [
            "object": "list",
            "data": [["id": id, "object": "model", "owned_by": "mlx"]],
        ])

    case ("POST", "/v1/chat/completions"):
        guard let parsed = try? JSONDecoder().decode(
            ChatCompletionRequest.self, from: req.body) else {
            return .json(400, ["error": ["message": "invalid JSON body",
                                         "type": "invalid_request_error"]])
        }

        // Gate on readiness so callers get a clean 503 rather than a crash.
        let sem = DispatchSemaphore(value: 0)
        var ready = false
        Task { ready = await engine.isReady; sem.signal() }
        sem.wait()
        guard ready else {
            return .json(503, ["error": ["message": "model not ready",
                                         "type": "model_loading"]])
        }

        let completionID = "chatcmpl-\(UUID().uuidString.prefix(24))"
        let modelName = parsed.model ?? modelURL.lastPathComponent

        let includeUsage = parsed.streamOptions?.includeUsage == true

        if parsed.stream == true {
            return .sse { send, done, onCancel in
                let task = Task {
                    // OpenAI streaming convention: first chunk announces the
                    // assistant role, subsequent chunks carry content deltas,
                    // a final chunk has finish_reason, then `[DONE]`.
                    if !send(OpenAIResponse.chunk(
                        id: completionID, model: modelName,
                        delta: ["role": "assistant"], finishReason: nil)) {
                        done(); return
                    }
                    var usage = Usage.zero
                    var finishReason = "stop"
                    var emittedToolCall = false
                    var toolCallIndex = 0
                    do {
                        for try await event in await engine.stream(parsed) {
                            if Task.isCancelled { break }
                            switch event {
                            case let .delta(piece):
                                // Stop generating if the client has gone away:
                                // a failed write cancels the producer Task via
                                // the registered onCancel handler.
                                if !send(OpenAIResponse.chunk(
                                    id: completionID, model: modelName,
                                    delta: ["content": piece], finishReason: nil)) {
                                    done(); return
                                }
                            case let .toolCall(call):
                                emittedToolCall = true
                                let delta = ["tool_calls": [
                                    OpenAIResponse.toolCallJSON(call, index: toolCallIndex)
                                ]]
                                toolCallIndex += 1
                                if !send(OpenAIResponse.chunk(
                                    id: completionID, model: modelName,
                                    delta: delta, finishReason: nil)) {
                                    done(); return
                                }
                            case let .completed(u, reason):
                                usage = u
                                finishReason = reason
                            }
                        }
                        // Normal completion: emit the terminal finish chunk,
                        // an optional usage chunk, then `[DONE]`.
                        _ = send(OpenAIResponse.chunk(
                            id: completionID, model: modelName,
                            delta: [:],
                            finishReason: emittedToolCall ? "tool_calls" : finishReason))
                        if includeUsage {
                            _ = send(OpenAIResponse.usageChunk(
                                id: completionID, model: modelName, usage: usage))
                        }
                        _ = send("data: [DONE]\n\n")
                    } catch {
                        // M3: never inject the error as assistant content — that
                        // would silently corrupt the user's output. Log it, and
                        // close the stream abruptly after the partial so the
                        // client detects truncation (no `finish_reason:"stop"`,
                        // no `[DONE]`).
                        FileHandle.standardError.write(Data(
                            "[mlx-server] streaming generation error: \(error)\n".utf8))
                    }
                    done()
                }
                // Let the connection thread cancel this Task on client
                // disconnect; cancellation propagates to the engine stream's
                // onTermination, which stops the upstream TokenIterator.
                onCancel { task.cancel() }
            }
        } else {
            let sem2 = DispatchSemaphore(value: 0)
            var text = ""
            var toolCalls: [ToolCall] = []
            var usage = Usage.zero
            var finishReason = "stop"
            var errMsg: String?
            Task {
                do {
                    let result = try await engine.complete(parsed)
                    text = result.text
                    toolCalls = result.toolCalls
                    usage = result.usage
                    finishReason = result.finishReason
                }
                catch { errMsg = "\(error)" }
                sem2.signal()
            }
            sem2.wait()
            if let errMsg {
                FileHandle.standardError.write(Data(
                    "[mlx-server] generation error: \(errMsg)\n".utf8))
                return .json(500, ["error": ["message": errMsg,
                                             "type": "inference_error"]])
            }
            return .json(200, OpenAIResponse.completion(
                id: completionID, model: modelName, content: text,
                toolCalls: toolCalls, finishReason: finishReason, usage: usage))
        }

    case ("GET", "/health"), ("GET", "/"):
        let sem = DispatchSemaphore(value: 0)
        var ready = false
        var failure: String?
        Task {
            ready = await engine.isReady
            failure = await engine.failureMessage
            sem.signal()
        }
        sem.wait()

        if let failure {
            return .json(503, ["error": ["message": failure, "type": "model_load_error"]])
        }
        if !ready {
            return .json(503, ["error": ["message": "model is still loading",
                                         "type": "model_loading"]])
        }
        return .buffered(status: 200, contentType: "text/plain",
                         body: Data("ok\n".utf8))

    default:
        return .json(404, ["error": ["message": "not found",
                                     "type": "invalid_request_error"]])
    }
}

// MARK: - Boot

let server: HTTPServer
do {
    server = try HTTPServer(host: host, port: port, handler: handle)
    server.start()
    FileHandle.standardError.write(Data(
        "[mlx-server] listening on http://\(host):\(port) (model: \(modelURL.path))\n".utf8))
} catch {
    FileHandle.standardError.write(Data(
        "[mlx-server] failed to bind \(host):\(port): \(error)\n".utf8))
    exit(1)
}

// MARK: - Graceful shutdown (SIGTERM)
//
// The Rust supervisor sends SIGTERM (to the process group) with a 2 s grace
// before SIGKILL. Default SIGTERM disposition kills us abruptly mid-GPU-eval.
// Install a DispatchSourceSignal so we can stop accepting connections, cancel
// active generations, and exit cleanly. Real work in a C signal handler is
// not async-signal-safe, hence the dispatch source.
signal(SIGTERM, SIG_IGN) // hand delivery to the dispatch source below
let sigtermSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
sigtermSource.setEventHandler {
    FileHandle.standardError.write(Data("[mlx-server] SIGTERM: shutting down\n".utf8))
    server.stop()
    // Cancelling all tasks asks any in-flight generation to stop; the engine
    // stream's onTermination then halts the upstream TokenIterator.
    Task {
        await engine.cancelActiveGenerations()
        exit(0)
    }
    // Fallback: never let shutdown hang past the supervisor's grace window.
    DispatchQueue.global().asyncAfter(deadline: .now() + 1.5) { exit(0) }
}
sigtermSource.resume()

// Keep the process alive; the accept loop runs on its own thread and the
// signal source is serviced on the main dispatch queue.
dispatchMain()
