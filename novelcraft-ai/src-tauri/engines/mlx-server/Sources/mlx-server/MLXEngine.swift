// MLXEngine.swift
//
// Wraps MLXLMCommon model loading + token generation behind a small async
// API the HTTP layer can call. Loading happens once, lazily, in the
// background; `isReady` gates the `/v1/models` readiness contract.
//
// Generation mirrors the reference flow in mlx-swift-lm's
// `Streamlined.swift` (ChatSession/Generator): build `[Chat.Message]` from
// the OpenAI request, run it through `context.processor.prepare`, then drive
// `MLXLMCommon.generate(...)` for either a full string or an SSE stream.

import Foundation
import MLX
import MLXHuggingFace
import MLXLMCommon
import MLXLLM
import Tokenizers

/// A minimal async gate that admits exactly one holder at a time. Used to
/// serialize generation (single-flight) so two concurrent requests never drive
/// the shared `ModelContext`/KV-cache simultaneously — actor isolation alone
/// does NOT hold across `await`, so we need an explicit lock. This mirrors the
/// single-flight model of Apple's `mlx_lm.server`.
actor AsyncSemaphore {
    private var available: Int
    private var waiters: [CheckedContinuation<Void, Never>] = []

    init(value: Int) {
        self.available = value
    }

    func wait() async {
        if available > 0 {
            available -= 1
            return
        }
        await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
            waiters.append(cont)
        }
    }

    func signal() {
        if let next = waiters.first {
            waiters.removeFirst()
            next.resume()
        } else {
            available += 1
        }
    }
}

/// One streaming generation event: either an incremental text delta or the
/// final token-usage summary captured from the MLX `.info` item.
enum GenerationEvent: Sendable {
    case delta(String)
    case toolCall(ToolCall)
    case completed(Usage, String)
}

/// Loads an MLX model directory and serves chat completions.
actor MLXEngine {
    enum State {
        case loading
        case ready
        case failed(String)
    }

    private let modelDirectory: URL
    /// Public model id we report on `/v1/models` — the directory's name,
    /// matching how the rest of the app keys models.
    let modelID: String

    private(set) var state: State = .loading
    private var container: ModelContainer?

    /// Single-flight gate: only one generation (`complete`/`stream`) runs at a
    /// time. The same `ModelContext`/KV-cache cannot be driven concurrently.
    private let generationGate = AsyncSemaphore(value: 1)

    /// Set on SIGTERM so in-flight generation loops bail out cooperatively.
    private var shuttingDown = false
    /// Producer tasks for active streams, so shutdown can cancel them.
    private var activeStreamTasks: [UUID: Task<Void, Never>] = [:]

    private func registerStreamTask(_ id: UUID, _ task: Task<Void, Never>) {
        if shuttingDown { task.cancel() }
        activeStreamTasks[id] = task
    }

    private func unregisterStreamTask(_ id: UUID) {
        activeStreamTasks[id] = nil
    }

    /// Stop all in-flight generations (called from the SIGTERM handler).
    func cancelActiveGenerations() {
        shuttingDown = true
        for task in activeStreamTasks.values { task.cancel() }
        activeStreamTasks.removeAll()
    }

    init(modelDirectory: URL) {
        self.modelDirectory = modelDirectory
        self.modelID = modelDirectory.lastPathComponent
    }

    var isReady: Bool {
        if case .ready = state { return true }
        return false
    }

    var failureMessage: String? {
        if case let .failed(msg) = state { return msg }
        return nil
    }

    /// Load the model from the local directory. Safe to call once at startup.
    func load() async {
        do {
            // Local directory → no network. mlx-swift-lm picks the right
            // architecture from config.json, including the qwen3_5 family
            // model types used by current Qwen3.5/Qwen3.6 MLX artifacts.
            let c = try await loadModelContainer(
                from: modelDirectory,
                using: #huggingFaceTokenizerLoader()
            )
            self.container = c
            self.state = .ready
            FileHandle.standardError.write(
                Data("[mlx-server] model ready: \(modelID)\n".utf8))
        } catch {
            let msg = "model load failed: \(error)"
            self.state = .failed(msg)
            FileHandle.standardError.write(Data("[mlx-server] \(msg)\n".utf8))
        }
    }

    // MARK: - Generation

    private func parameters(_ req: ChatCompletionRequest) -> GenerateParameters {
        GenerateParameters(
            maxTokens: req.maxTokens ?? 2048,
            temperature: req.temperature ?? 0.7,
            topP: req.topP ?? 1.0
        )
    }

    private func chatMessages(_ req: ChatCompletionRequest) -> [Chat.Message] {
        req.messages.map { m in
            switch m.role {
            case "system":    return .system(m.content)
            case "assistant": return .assistant(m.content, toolCalls: m.toolCalls)
            case "tool":      return .tool(m.content, id: m.toolCallID)
            default:          return .user(m.content)
            }
        }
    }

    /// Non-streaming: returns the full generated text plus token usage.
    func complete(_ req: ChatCompletionRequest) async throws -> (
        text: String, toolCalls: [ToolCall], usage: Usage, finishReason: String
    ) {
        guard let container else {
            throw NSError(domain: "mlx-server", code: 503,
                          userInfo: [NSLocalizedDescriptionKey: "model not ready"])
        }
        let messages = chatMessages(req)
        let params = parameters(req)

        // Single-flight: serialize the entire generation body.
        await generationGate.wait()
        // Capture the gate locally and release via a detached Task so the
        // signal isn't subject to the cancellation context of the current
        // Task — under SIGTERM we still need the gate to be signalled or all
        // queued requests would deadlock. `Task.detached` does NOT inherit
        // cancellation from the enclosing context.
        let gate = generationGate
        defer { Task.detached { await gate.signal() } }

        let tools = req.toolSpecs
        return try await container.perform(nonSendable: messages) { (context: ModelContext, messages: [Chat.Message]) async throws -> (String, [ToolCall], Usage, String) in
            let userInput = UserInput(chat: messages, tools: tools)
            let input = try await context.processor.prepare(input: userInput)
            // OpenAI-compatible servers are stateless per request — each call
            // carries the full chat history in `messages`. Build a fresh
            // KVCache here and pass it explicitly so we never accidentally
            // accumulate state across requests. (TokenIterator already
            // defaults to a new cache when nil is passed, but making the
            // contract explicit guards against future upstream changes.)
            let kvCache = context.model.newCache(parameters: params)
            var output = ""
            var toolCalls: [ToolCall] = []
            var usage = Usage.zero
            var finishReason = "stop"
            for await item in try MLXLMCommon.generate(
                input: input, cache: kvCache, parameters: params, context: context,
                tools: tools
            ) {
                if Task.isCancelled { break }
                if let chunk = item.chunk { output += chunk }
                if let toolCall = item.toolCall { toolCalls.append(toolCall) }
                if let info = item.info {
                    usage = Usage(promptTokens: info.promptTokenCount,
                                  completionTokens: info.generationTokenCount)
                    switch info.stopReason {
                    case .length: finishReason = "length"
                    case .stop, .cancelled: finishReason = "stop"
                    }
                }
            }
            MLX.Stream.gpu.synchronize()
            return (output, toolCalls, usage, finishReason)
        }
    }

    /// Streaming: yields incremental text deltas, then a final `.usage` event
    /// once the MLX `.info` summary arrives.
    func stream(_ req: ChatCompletionRequest) -> AsyncThrowingStream<GenerationEvent, Error> {
        let messages = chatMessages(req)
        let params = parameters(req)
        let tools = req.toolSpecs
        let container = self.container
        let gate = self.generationGate
        let taskID = UUID()
        return AsyncThrowingStream { continuation in
            let task = Task {
                defer { self.unregisterStreamTask(taskID) }

                guard let container else {
                    continuation.finish(throwing: NSError(
                        domain: "mlx-server", code: 503,
                        userInfo: [NSLocalizedDescriptionKey: "model not ready"]))
                    return
                }
                // Single-flight: hold the gate for the whole generation.
                await gate.wait()
                // Detached so SIGTERM-induced cancellation on this Task does
                // not also cancel the signal — see `complete` above.
                defer { Task.detached { await gate.signal() } }
                do {
                    try await container.perform(nonSendable: messages) { (context: ModelContext, messages: [Chat.Message]) async throws -> Void in
                        let userInput = UserInput(chat: messages, tools: tools)
                        let input = try await context.processor.prepare(input: userInput)
                        // Fresh KVCache per request — OpenAI-compatible
                        // endpoints are stateless. See `complete` for details.
                        let kvCache = context.model.newCache(parameters: params)
                        for await item in try MLXLMCommon.generate(
                            input: input, cache: kvCache, parameters: params, context: context,
                            tools: tools
                        ) {
                            // Cooperatively bail out if the consumer (a
                            // disconnected SSE client) cancelled us.
                            if Task.isCancelled { break }
                            if let chunk = item.chunk {
                                continuation.yield(.delta(chunk))
                            }
                            if let toolCall = item.toolCall {
                                continuation.yield(.toolCall(toolCall))
                            }
                            if let info = item.info {
                                let finishReason: String
                                switch info.stopReason {
                                case .length: finishReason = "length"
                                case .stop, .cancelled: finishReason = "stop"
                                }
                                continuation.yield(.completed(Usage(
                                    promptTokens: info.promptTokenCount,
                                    completionTokens: info.generationTokenCount), finishReason))
                            }
                        }
                        MLX.Stream.gpu.synchronize()
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            // Track this producer so SIGTERM can cancel it.
            self.registerStreamTask(taskID, task)
            // When the consuming `for await` is cancelled (client disconnect),
            // cancel the producer Task so the upstream `TokenIterator` stops.
            continuation.onTermination = { _ in
                task.cancel()
            }
        }
    }
}
