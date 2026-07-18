// OpenAI.swift
//
// OpenAI-compatible request/response shapes for /v1/chat/completions.
// Only the fields the desktop app actually sends/consumes are modeled;
// unknown fields are ignored on decode.

import Foundation
import MLXLMCommon

struct ChatMessage: Decodable {
    let role: String
    let content: String
    let toolCalls: [ToolCall]?
    let toolCallID: String?

    private enum CodingKeys: String, CodingKey {
        case role, content
        case toolCalls = "tool_calls"
        case toolCallID = "tool_call_id"
    }

    private struct OpenAIToolCall: Decodable {
        let id: String?
        let function: Function

        struct Function: Decodable {
            let name: String
            let arguments: String
        }

        var mlx: ToolCall? {
            guard let data = function.arguments.data(using: .utf8),
                  let arguments = try? JSONDecoder().decode([String: JSONValue].self, from: data)
            else { return nil }
            return ToolCall(function: .init(name: function.name, arguments: arguments), id: id)
        }
    }

    /// One element of the OpenAI array-form content (`[{type:"text",text:"…"}]`).
    /// We only carry the `text` parts; non-text parts (images, etc.) decode but
    /// contribute no text.
    private struct ContentPart: Decodable {
        let type: String?
        let text: String?
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.role = (try? c.decode(String.self, forKey: .role)) ?? "user"
        self.toolCalls = (try? c.decode([OpenAIToolCall].self, forKey: .toolCalls))?
            .compactMap(\.mlx)
        self.toolCallID = try? c.decode(String.self, forKey: .toolCallID)
        // `content` is usually a plain string, but the canonical OpenAI shape
        // also allows an array of typed parts (`[{type:"text",text:"…"}]`).
        // Tolerate it being absent/null too.
        if let s = try? c.decode(String.self, forKey: .content) {
            self.content = s
        } else if let parts = try? c.decode([ContentPart].self, forKey: .content) {
            let joined = parts.compactMap { part -> String? in
                // Only "text" parts carry prompt text; default a missing type to
                // text for leniency, but skip explicitly non-text parts.
                if let type = part.type, type != "text" { return nil }
                return part.text
            }.joined()
            self.content = joined
            if joined.isEmpty {
                FileHandle.standardError.write(Data(
                    "[mlx-server] warning: array-form content for role '\(self.role)' coerced to empty\n".utf8))
            }
        } else {
            self.content = ""
        }
    }
}

struct ChatCompletionRequest: Decodable {
    let model: String?
    let messages: [ChatMessage]
    let stream: Bool?
    let temperature: Float?
    let topP: Float?
    let maxTokens: Int?
    let streamOptions: StreamOptions?
    let tools: [[String: JSONValue]]?
    let toolChoice: JSONValue?

    struct StreamOptions: Decodable {
        let includeUsage: Bool?
        private enum CodingKeys: String, CodingKey {
            case includeUsage = "include_usage"
        }
    }

    private enum CodingKeys: String, CodingKey {
        case model, messages, stream, temperature
        case topP = "top_p"
        case maxTokens = "max_tokens"
        case streamOptions = "stream_options"
        case tools
        case toolChoice = "tool_choice"
    }

    /// Convert OpenAI JSON tool schemas into mlx-swift-lm's sendable schema
    /// representation. `none` disables tools; a named function choice narrows
    /// the available schemas to that function.
    var toolSpecs: [ToolSpec]? {
        guard toolChoice != .string("none"), let tools, !tools.isEmpty else { return nil }
        let requestedName: String? = {
            guard case let .object(choice) = toolChoice,
                  case let .object(function)? = choice["function"],
                  case let .string(name)? = function["name"] else { return nil }
            return name
        }()
        let converted = tools.compactMap { schema -> ToolSpec? in
            if let requestedName,
               case let .object(function)? = schema["function"],
               function["name"] != .string(requestedName) {
                return nil
            }
            return schema.mapValues(\.sendableValue)
        }
        return converted.isEmpty ? nil : converted
    }
}

private extension JSONValue {
    var sendableValue: any Sendable {
        switch self {
        case .null: NSNull()
        case .bool(let value): value
        case .int(let value): value
        case .double(let value): value
        case .string(let value): value
        case .array(let values): values.map(\.sendableValue)
        case .object(let values): values.mapValues(\.sendableValue)
        }
    }
}

/// Real token counts surfaced from the MLX generation `.info` item.
struct Usage {
    let promptTokens: Int
    let completionTokens: Int

    var totalTokens: Int { promptTokens + completionTokens }

    /// OpenAI `usage` object shape.
    var json: [String: Any] {
        return [
            "prompt_tokens": promptTokens,
            "completion_tokens": completionTokens,
            "total_tokens": totalTokens,
        ]
    }

    static let zero = Usage(promptTokens: 0, completionTokens: 0)
}

enum OpenAIResponse {
    static func toolCallJSON(_ call: ToolCall, index: Int? = nil) -> [String: Any] {
        let argumentObject = call.function.arguments.mapValues(\.anyValue)
        let argumentData = try? JSONSerialization.data(withJSONObject: argumentObject)
        let arguments = argumentData.flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
        var result: [String: Any] = [
            "id": call.id ?? "call-\(UUID().uuidString.prefix(24))",
            "type": "function",
            "function": [
                "name": call.function.name,
                "arguments": arguments,
            ],
        ]
        if let index { result["index"] = index }
        return result
    }

    /// Non-streaming chat completion JSON object.
    static func completion(id: String, model: String, content: String,
                           toolCalls: [ToolCall] = [], finishReason: String = "stop",
                           usage: Usage = .zero) -> [String: Any] {
        var message: [String: Any] = ["role": "assistant"]
        if toolCalls.isEmpty {
            message["content"] = content
        } else {
            message["content"] = NSNull()
            message["tool_calls"] = toolCalls.enumerated().map {
                toolCallJSON($0.element, index: $0.offset)
            }
        }
        return [
            "id": id,
            "object": "chat.completion",
            "created": Int(Date().timeIntervalSince1970),
            "model": model,
            "choices": [
                [
                    "index": 0,
                    "message": message,
                    "finish_reason": toolCalls.isEmpty ? finishReason : "tool_calls",
                ]
            ],
            "usage": usage.json,
        ]
    }

    /// One streaming SSE delta chunk (`data: {...}`).
    static func chunk(id: String, model: String, delta: [String: Any],
                      finishReason: String?) -> String {
        let obj: [String: Any] = [
            "id": id,
            "object": "chat.completion.chunk",
            "created": Int(Date().timeIntervalSince1970),
            "model": model,
            "choices": [
                [
                    "index": 0,
                    "delta": delta,
                    "finish_reason": finishReason as Any,
                ]
            ],
        ]
        let data = (try? JSONSerialization.data(withJSONObject: obj)) ?? Data("{}".utf8)
        let json = String(data: data, encoding: .utf8) ?? "{}"
        return "data: \(json)\n\n"
    }

    /// Final streaming chunk carrying only `usage` and an empty `choices`
    /// array, per the OpenAI `stream_options.include_usage` convention.
    static func usageChunk(id: String, model: String, usage: Usage) -> String {
        let obj: [String: Any] = [
            "id": id,
            "object": "chat.completion.chunk",
            "created": Int(Date().timeIntervalSince1970),
            "model": model,
            "choices": [],
            "usage": usage.json,
        ]
        let data = (try? JSONSerialization.data(withJSONObject: obj)) ?? Data("{}".utf8)
        let json = String(data: data, encoding: .utf8) ?? "{}"
        return "data: \(json)\n\n"
    }
}
