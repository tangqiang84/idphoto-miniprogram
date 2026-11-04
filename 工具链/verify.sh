#!/usr/bin/env bash
# RC-02：保留兼容入口，真实退出码与结果汇总由同一调度器负责。
set -uo pipefail
VERIFY_DIR="$(cd "$(dirname "$0")" && pwd)"
exec python3 "$VERIFY_DIR/verify_runner.py" "$@" --profile development
