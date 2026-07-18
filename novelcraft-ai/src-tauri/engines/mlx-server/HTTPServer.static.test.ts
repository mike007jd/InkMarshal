import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8');
}

describe('MLX HTTP sidecar guardrails', () => {
  it('pins the sidecar to the MLX language-model package that supports current Qwen3.5 artifacts', () => {
    const manifest = source('src-tauri/engines/mlx-server/Package.swift');
    const engine = source('src-tauri/engines/mlx-server/Sources/mlx-server/MLXEngine.swift');

    expect(manifest).not.toContain('mlx-swift-examples');
    expect(manifest).toContain('url: "https://github.com/ml-explore/mlx-swift-lm"');
    expect(manifest).toContain('exact: "3.31.4"');
    expect(manifest).toContain('url: "https://github.com/ml-explore/mlx-swift"');
    expect(manifest).toContain('exact: "0.31.6"');
    expect(manifest).toContain('url: "https://github.com/huggingface/swift-transformers"');
    expect(manifest).toContain('exact: "1.3.3"');
    expect(engine).toContain('loadModelContainer(');
    expect(engine).toContain('from: modelDirectory');
    expect(engine).toContain('using: #huggingFaceTokenizerLoader()');
  });

  it('binds only to loopback and bounds inbound request bodies', () => {
    const server = source('src-tauri/engines/mlx-server/Sources/mlx-server/HTTPServer.swift');

    expect(server).toContain('private let LOOPBACK_HOST = "127.0.0.1"');
    expect(server).toContain('let bindHost = host == LOOPBACK_HOST ? host : LOOPBACK_HOST');
    expect(server).toContain('inet_pton(AF_INET, bindHost, &addr.sin_addr)');
    expect(server).toContain('private let MAX_BODY_BYTES = 16 << 20');
    expect(server).toContain('contentLength <= MAX_BODY_BYTES');
    expect(server).toContain('if body.count > MAX_BODY_BYTES { return nil }');
  });

  it('does not report health ready until the model is loaded', () => {
    const main = source('src-tauri/engines/mlx-server/Sources/mlx-server/main.swift');
    const healthCase = main.slice(
      main.indexOf('case ("GET", "/health"), ("GET", "/"):'),
      main.indexOf('default:', main.indexOf('case ("GET", "/health"), ("GET", "/"):')),
    );

    expect(healthCase).toContain('ready = await engine.isReady');
    expect(healthCase).toContain('failure = await engine.failureMessage');
    expect(healthCase).toContain('return .json(503');
    expect(healthCase).toContain('type": "model_loading"');
    expect(healthCase.indexOf('return .buffered(status: 200')).toBeGreaterThan(
      healthCase.indexOf('if !ready {'),
    );
  });

  it('passes OpenAI tool schemas through MLX and returns tool-call deltas', () => {
    const openAI = source('src-tauri/engines/mlx-server/Sources/mlx-server/OpenAI.swift');
    const engine = source('src-tauri/engines/mlx-server/Sources/mlx-server/MLXEngine.swift');
    const main = source('src-tauri/engines/mlx-server/Sources/mlx-server/main.swift');

    expect(openAI).toContain('let tools: [[String: JSONValue]]?');
    expect(openAI).toContain('var toolSpecs: [ToolSpec]?');
    expect(openAI).toContain('case toolCalls = "tool_calls"');
    expect(openAI).toContain('case toolCallID = "tool_call_id"');
    expect(engine).toContain('UserInput(chat: messages, tools: tools)');
    expect(engine).toContain('.assistant(m.content, toolCalls: m.toolCalls)');
    expect(engine).toContain('.tool(m.content, id: m.toolCallID)');
    expect(engine).toContain('tools: tools');
    expect(engine).toContain('case toolCall(ToolCall)');
    expect(main).toContain('delta: delta, finishReason: nil');
    expect(main).toContain('emittedToolCall ? "tool_calls" : finishReason');
  });

  it('reports MLX max-token termination as finish_reason length', () => {
    const engine = source('src-tauri/engines/mlx-server/Sources/mlx-server/MLXEngine.swift');
    const main = source('src-tauri/engines/mlx-server/Sources/mlx-server/main.swift');

    expect(engine.match(/case \.length: finishReason = "length"/g)).toHaveLength(2);
    expect(main).toContain('finishReason = result.finishReason');
    expect(main).toContain('finishReason: emittedToolCall ? "tool_calls" : finishReason');
  });
});
