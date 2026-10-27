#!/usr/bin/env bash
# 证件照小程序 · 全工具冒烟聚合（节点变更后的"关联流程回归"硬闸门）
#
# 对应：《测试用例与验收清单.md》第 10 章 验证要求与回归纪律
# 用法：bash 工具链/smoke_all.sh
# 依次跑：smoke_auto(T1) / smoke_t2 / smoke_t3 / smoke_t5 / smoke_print(T6)
# 任一非零即中断并报出失败项（不得只验连通性，见 10.3 禁止项）
#
# 注意：沙箱内写盘/网络受限，建议在本机终端执行；NODE_OPTIONS 透传沙箱 fs shim。

set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || { echo "找不到工程目录: $ROOT"; exit 1; }
export NODE_OPTIONS="${NODE_OPTIONS:-}"

PASS=0
FAILS=()

run() {
  local name="$1" script="$2"
  printf '\n===== %s =====\n' "$name"
  if node "$script"; then
    PASS=$((PASS + 1))
  else
    FAILS+=("$name")
  fi
}

run "T1 主链 smoke_auto"   "工具链/smoke_auto.js"
run "T2 换底色 smoke_t2"   "工具链/smoke_t2.js"
run "T3 换装 smoke_t3"     "工具链/smoke_t3.js"
run "T5 规格转换 smoke_t5" "工具链/smoke_t5.js"
run "T6 冲印 smoke_print"  "工具链/smoke_print.js"

printf '\n===== 汇总 =====\n'
printf '通过 %s / 总 %s\n' "$PASS" "$(($PASS + ${#FAILS[@]}))"
if [ "${#FAILS[@]}" -gt 0 ]; then
  printf '❌ 失败工具：%s\n' "${FAILS[*]}"
  exit 1
else
  printf '✅ 全工具冒烟通过\n'
  exit 0
fi
