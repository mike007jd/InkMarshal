// swift-tools-version: 6.1
//
// mlx-server — slim macOS (Apple Silicon) OpenAI-compatible HTTP server
// backed by Apple's MLX via the mlx-swift / mlx-swift-lm libraries.
//
// This is an ADDITIVE accelerated inference path for the desktop app.
// GGUF via the bundled llama.cpp `llama-server` remains the always-available
// fallback on macOS, so this server must never block the product.
//
// ── Pinned dependency tags (known-good released tags) ───────────────────────
//   mlx-swift-lm      : 3.31.4   (checked 2026-07-13)
//       https://github.com/ml-explore/mlx-swift-lm/releases/tag/3.31.4
//       — provides MLXLLM / MLXLMCommon and registers the qwen3_5 /
//         qwen3_5_text model types used by current Qwen3.5/Qwen3.6 MLX
//         artifacts.
//   mlx-swift         : 0.31.6   (checked 2026-07-03)
//       https://github.com/ml-explore/mlx-swift/releases
//   swift-transformers: 1.3.3    (checked 2026-07-03)
//       https://github.com/huggingface/swift-transformers
//       — provides Tokenizers.AutoTokenizer for local model directories.
// ────────────────────────────────────────────────────────────────────────────

import PackageDescription

let package = Package(
    name: "mlx-server",
    platforms: [
        // Apple Silicon only; MLX requires macOS 14+ on arm64.
        .macOS(.v14)
    ],
    dependencies: [
        .package(
            url: "https://github.com/ml-explore/mlx-swift-lm",
            exact: "3.31.4"
        ),
        .package(
            url: "https://github.com/ml-explore/mlx-swift",
            exact: "0.31.6"
        ),
        .package(
            url: "https://github.com/huggingface/swift-transformers",
            exact: "1.3.3"
        ),
    ],
    targets: [
        .executableTarget(
            name: "mlx-server",
            dependencies: [
                .product(name: "MLXLLM", package: "mlx-swift-lm"),
                .product(name: "MLXLMCommon", package: "mlx-swift-lm"),
                .product(name: "MLXHuggingFace", package: "mlx-swift-lm"),
                .product(name: "MLX", package: "mlx-swift"),
                .product(name: "Tokenizers", package: "swift-transformers"),
            ],
            path: "Sources/mlx-server",
            swiftSettings: [
                .swiftLanguageMode(.v5)
            ]
        )
    ]
)
