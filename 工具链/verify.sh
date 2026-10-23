#!/usr/bin/env bash
# 证件照小程序 · 一键验证（类型检查 + core 单测 + 小程序编译）
#
# 用途：任何代码改动后的收尾硬闸门（项目约束：改完必验证，禁止只靠静态阅读）
# 用法：
#   bash 工具链/verify.sh              # 全量（含编译，约 2–5 分钟）
#   bash 工具链/verify.sh --no-build   # 跳过编译，只做类型+单测（约 30 秒）
# 退出码：0 = 全绿；非 0 = 有硬失败（单测或编译）
#
# 注意：
#   1. 编译在「沙箱内」会失败（fs shim 拦截 mkdir，CODEBUDDY_BROKER_DENY），
#      需在本机终端或沙箱外执行；类型+单测沙箱内可跑。
#   2. tsc 结果记为 WARN 不阻断：Taro 用 babel 转译 TS 不做类型检查。
#      2026-10-24 起基线为 **0 告警**（台账 #12 已关闭）——若 tsc 有输出，一律视为新增错误，须处理或登记台账。

set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/idphoto-miniprogram"
DO_BUILD=1
[ "${1:-}" = "--no-build" ] && DO_BUILD=0

cd "$APP" || { echo "找不到工程目录: $APP"; exit 1; }

FAIL=0
say() { printf '\n===== %s =====\n' "$1"; }

say "1/3 类型检查 tsc --noEmit"
if npx tsc --noEmit 2>&1 | tail -15; then :; fi
TSC_CODE=${PIPESTATUS[0]}
if [ "$TSC_CODE" -ne 0 ]; then
  # 2026-10-24 起基线为 0 告警（台账 #12 已关闭）→ 升级为**硬闸门**，不许再当 WARN 放过
  echo "FAIL: tsc 有类型错误（基线已为 0，见台账 #12；须修复或登记台账后重跑）"
  FAIL=1
else
  echo "OK: tsc 无错误（基线 0 告警）"
fi

say "2/3 core 单测 test:core"
npm run test:core 2>&1 | tail -10
TEST_CODE=${PIPESTATUS[0]}
if [ "$TEST_CODE" -ne 0 ]; then
  echo "FAIL: core 单测未通过"; FAIL=1
else
  # 计数从测试输出里实取，不写死（写死会随新增用例失真，掩盖真实通过数）
  COUNT=$(npm run test:core 2>&1 | grep -E '^# pass ' | awk '{print $3}')
  echo "OK: core 单测通过（${COUNT:-?} 条）"
fi

if [ "$DO_BUILD" -eq 1 ]; then
  say "3/3 编译 build:weapp"
  npm run build:weapp 2>&1 | tail -12
  BUILD_CODE=${PIPESTATUS[0]}
  if [ "$BUILD_CODE" -ne 0 ]; then
    echo "FAIL: 编译失败（若在沙箱内，属环境限制，需本机执行）"; FAIL=1
  else
    echo "OK: 编译成功 → dist/"
  fi
else
  say "3/3 编译（--no-build 已跳过）"
fi

say "结果"
if [ "$FAIL" -eq 0 ]; then
  echo "✅ 全部通过"
else
  echo "❌ 存在硬失败，修复后重跑；并把问题登记到《问题台账.md》"
fi
exit "$FAIL"
