#!/usr/bin/env bash
set -euo pipefail

# ⚠️ DANGER — this harness runs the agent fully unattended with
# `--sandbox danger-full-access --ask-for-approval never` (codex) /
# `--dangerously-skip-permissions` (claude) in a loop against the repo
# worktree. It can mutate arbitrary files with no per-iteration diff gate.
# It is dev-only and MUST NEVER run in CI or any shared/automated pipeline.
if [[ -n "${CI:-}" ]]; then
  echo "Error: ralph.sh is a danger-full-access agent loop and must never run in CI." >&2
  exit 1
fi

TOOL="codex"
MAX_ITERATIONS=10

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tool)
      TOOL="${2:-}"
      shift 2
      ;;
    --tool=*)
      TOOL="${1#*=}"
      shift
      ;;
    *)
      if [[ "$1" =~ ^[0-9]+$ ]]; then
        MAX_ITERATIONS="$1"
      fi
      shift
      ;;
  esac
done

if [[ "$TOOL" != "codex" && "$TOOL" != "claude" ]]; then
  echo "Error: invalid tool '$TOOL'. Use codex or claude." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
LOOP_FILE="$SCRIPT_DIR/loop.json"
PROGRESS_FILE="$SCRIPT_DIR/progress.txt"
ARCHIVE_DIR="$SCRIPT_DIR/archive"
LAST_LOOP_FILE="$SCRIPT_DIR/.last-loop"
LAST_LOOP_SNAPSHOT_FILE="$SCRIPT_DIR/.last-loop.json"

command -v jq >/dev/null || {
  echo "Error: jq is required." >&2
  exit 1
}

if [[ ! -f "$LOOP_FILE" ]]; then
  echo "Error: missing $LOOP_FILE. Copy loop.json.example to loop.json and fill the novel writing loop target." >&2
  exit 1
fi

jq empty "$LOOP_FILE"

if [[ -f "$LAST_LOOP_FILE" ]]; then
  CURRENT_LOOP="$(jq -r '.loopId // .novelId // empty' "$LOOP_FILE")"
  LAST_LOOP="$(cat "$LAST_LOOP_FILE" 2>/dev/null || true)"
  if [[ -n "$CURRENT_LOOP" && -n "$LAST_LOOP" && "$CURRENT_LOOP" != "$LAST_LOOP" ]]; then
    DATE="$(date +%Y-%m-%d)"
    FOLDER_NAME="$(echo "$LAST_LOOP" | tr -c '[:alnum:]_.-' '-')"
    ARCHIVE_FOLDER="$ARCHIVE_DIR/$DATE-$FOLDER_NAME"
    mkdir -p "$ARCHIVE_FOLDER"
    if [[ -f "$LAST_LOOP_SNAPSHOT_FILE" ]]; then
      cp "$LAST_LOOP_SNAPSHOT_FILE" "$ARCHIVE_FOLDER/loop.json"
    else
      cp "$LOOP_FILE" "$ARCHIVE_FOLDER/loop.json"
    fi
    [[ -f "$PROGRESS_FILE" ]] && cp "$PROGRESS_FILE" "$ARCHIVE_FOLDER/progress.txt"
    {
      echo "# Ralph Progress Log"
      echo "Started: $(date)"
      echo "---"
    } > "$PROGRESS_FILE"
    echo "Archived previous Ralph run to $ARCHIVE_FOLDER"
  fi
fi

CURRENT_LOOP="$(jq -r '.loopId // .novelId // empty' "$LOOP_FILE")"
if [[ -n "$CURRENT_LOOP" ]]; then
  echo "$CURRENT_LOOP" > "$LAST_LOOP_FILE"
fi
cp "$LOOP_FILE" "$LAST_LOOP_SNAPSHOT_FILE"

if [[ ! -f "$PROGRESS_FILE" ]]; then
  {
    echo "# Ralph Progress Log"
    echo "Started: $(date)"
    echo "---"
  } > "$PROGRESS_FILE"
fi

run_codex() {
  local prompt
  prompt="$(cat "$SCRIPT_DIR/prompt.md")"
  CODEX_ARGS=(
    exec
    --cd "$REPO_ROOT"
    --sandbox danger-full-access
    --ask-for-approval never
    --search
  )
  if [[ -n "${CODEX_MODEL:-}" ]]; then
    CODEX_ARGS+=(--model "$CODEX_MODEL")
  fi
  codex "${CODEX_ARGS[@]}" "$prompt"
}

run_claude() {
  claude --dangerously-skip-permissions --print < "$SCRIPT_DIR/prompt.md"
}

echo "Starting InkMarshal writing Ralph loop: tool=$TOOL max_iterations=$MAX_ITERATIONS"

for iteration in $(seq 1 "$MAX_ITERATIONS"); do
  echo ""
  echo "==============================================================="
  echo "  Writing Ralph iteration $iteration of $MAX_ITERATIONS ($TOOL)"
  echo "==============================================================="

  set +e
  if [[ "$TOOL" == "codex" ]]; then
    OUTPUT="$(run_codex 2>&1 | tee /dev/stderr)"
  else
    OUTPUT="$(run_claude 2>&1 | tee /dev/stderr)"
  fi
  # ${PIPESTATUS[0]} is the agent's real exit code; plain $? would be `tee`'s
  # (always 0), masking a crashed agent and making the failure branch dead.
  STATUS="${PIPESTATUS[0]}"
  set -e

  # Anchor the completion token to its own line (optional surrounding
  # whitespace only) so a model that merely echoes the literal
  # "<promise>COMPLETE</promise>" inside normal prose can't falsely terminate
  # the loop.
  if echo "$OUTPUT" | grep -Eq '^[[:space:]]*<promise>COMPLETE</promise>[[:space:]]*$'; then
    echo "InkMarshal writing Ralph loop completed at iteration $iteration."
    exit 0
  fi

  if [[ "$STATUS" -ne 0 ]]; then
    echo "Writing Ralph iteration $iteration exited with status $STATUS; continuing so the next clean context can recover."
  else
    echo "Writing Ralph iteration $iteration complete; continuing."
  fi
  sleep 2
done

echo "Writing Ralph loop reached max iterations ($MAX_ITERATIONS). Check $PROGRESS_FILE."
exit 1
