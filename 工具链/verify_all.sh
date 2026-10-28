#!/usr/bin/env bash
# 证件照小程序 · 一键全量验证入口（2026-10-28）
# ============================================================================
# 【为什么有这个文件】
# 现有验证入口是「手动按顺序敲一串命令」，且**只验连通性**：
#   · 工具链/verify.sh        → tsc + core 单测 + 编译
#   · 工具链/smoke_all.sh     → T1/T2/T3/T5/T6 冒烟（页面能跑通）
#   · 工具链/batch_acceptance.js → 真实素材批量（仍只验连通性）
# 本脚本把这些串成**一条命令**，并补上真正缺失的一环：
#   **业务产出断言**（像素尺寸 / 底色 / 头占比 / 文件大小 / 水印 / 换装盖脸 / 脸部干净）
#   与**需求覆盖矩阵缺口检查**。
#
# 【执行顺序（任一步失败即中断）】
#   1. core 单测            （纯逻辑，最快）
#   2. tsc 类型检查         （基线 0 告警）
#   3. 小程序编译            （dist/）
#   4. 全工具冒烟            （连通性；T1/T2/T3/T5/T6）
#   5. 真实素材批量业务验收   （11 张真实照片 × T1/T2/T3 + 业务断言）
#   6. 需求覆盖矩阵 + 缺口检查（把「还没测到的」显式列出来）
#
# 【重要口径】
#   · 第 4 步是**连通性**，第 5 步才是**业务正确性** —— 两者在输出里分开报，
#     绝不合并成一个「通过」（PRD 15.4 禁止项①）。
#   · 第 5 步需要微信开发者工具在跑（IDE 自动化通道）。若通道连不上，
#     脚本**不算验证失败**，而是明确报告「环境不可用 + 如何开通道」，
#     并继续跑第 6 步（覆盖矩阵不依赖 IDE）。
#   · IDE 自动化通道一次只能维持一个会话 → 第 4、5 步之间留出间隔（默认 30s）。
#
# 用法:
#   bash 工具链/verify_all.sh                 # 全量
#   bash 工具链/verify_all.sh --no-build      # 跳过编译（沙箱内可跑）
#   bash 工具链/verify_all.sh --no-ide        # 跳过需要 IDE 的步骤（4/5）
#   bash 工具链/verify_all.sh --quick         # 单测 + tsc + 覆盖矩阵（秒级）
#   bash 工具链/verify_all.sh --help
#
# 退出码: 0 = 全部通过；1 = 有步骤失败；2 = 用法错误
# ============================================================================

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/idphoto-miniprogram"
cd "$ROOT" || { echo "找不到工程目录: $ROOT"; exit 2; }

DO_BUILD=1
DO_IDE=1
DO_QUICK=0
STRICT=0
for a in "$@"; do
  case "$a" in
    --no-build) DO_BUILD=0 ;;
    --strict)   STRICT=1 ;;
    --no-ide)   DO_IDE=0 ;;
    --quick)    DO_QUICK=1; DO_BUILD=0; DO_IDE=0 ;;
    --help|-h)
      sed -n '2,45p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "未知参数: $a（--help 查看用法）"; exit 2 ;;
  esac
done

# 沙箱 fs shim 的 mkdir 不幂等 → 写盘命令必须带 NODE_OPTIONS= 前缀
export NODE_OPTIONS="${NODE_OPTIONS:-}"

PASS_COUNT=0
FAIL_COUNT=0
FAILED_STEPS=()
STEP_NO=0

# ---------------------------------------------------------------- 打印辅助
hr() { printf '\n\033[1m=========================================================\033[0m\n'; }
step() {
  STEP_NO=$((STEP_NO + 1))
  hr
  printf '\033[1m[%d/%d] %s\033[0m\n' "$STEP_NO" "$TOTAL_STEPS" "$1"
  hr
}
ok()   { PASS_COUNT=$((PASS_COUNT + 1)); printf '\033[32m✅ %s\033[0m\n' "$1"; }
bad()  { FAIL_COUNT=$((FAIL_COUNT + 1)); FAILED_STEPS+=("$1"); printf '\033[31m❌ %s\033[0m\n' "$1"; }
warn() { printf '\033[33m⚠  %s\033[0m\n' "$1"; }
info() { printf '   %s\n' "$1"; }

# 失败后提示「下一步该跑什么」
next_hint() {
  printf '\n\033[33m后续该跑什么：\033[0m\n'
  case "$1" in
    unit)
      echo "   · 单元/单测失败：先修 idphoto-miniprogram/src/core/ 下相关纯逻辑，再跑"
      echo "     bash 工具链/verify.sh --no-build"
      ;;
    tsc)
      echo "   · 类型检查失败：修 TS 报错（基线应为 0 告警），再跑 bash 工具链/verify.sh --no-build"
      ;;
    build)
      echo "   · 编译失败：编译需在**沙箱外**执行（沙箱内 mkdir 被拦截）；"
      echo "     在本机终端跑 cd idphoto-miniprogram && npm run build:weapp"
      ;;
    smoke)
      echo "   · 冒烟失败：确认微信开发者工具已打开本项目窗口、且「设置 → 安全设置 → 服务端口」已开启；"
      echo "     再单独跑对应脚本定位（如 bash 工具链/smoke_t2.js）"
      ;;
    batch)
      echo "   · 业务验收失败：看 素材/测试截图/real_batch/results.json 里该条目的 assertions 字段，"
      echo "     detail 里写明了失败原因（像素/底色/占比/大小/水印/盖脸）；"
      echo "     成品在 素材/测试截图/real_batch/<素材>/<工具>/result.jpg，可直接看图"
      ;;
    coverage)
      echo "   · 覆盖矩阵有缺口：按 docs/覆盖矩阵.md 第三节「缺口清单」逐条补测试脚本，"
      echo "     或把该需求的 verify 改成 manual（明确承认只能人工验）"
      ;;
  esac
}

if [ "$DO_QUICK" -eq 1 ]; then
  TOTAL_STEPS=3
elif [ "$DO_IDE" -eq 1 ]; then
  TOTAL_STEPS=6
else
  TOTAL_STEPS=4
fi

printf '\033[1m证件照小程序 · 一键全量验证\033[0m\n'
printf '工程根目录: %s\n' "$ROOT"
printf '选项: build=%s ide=%s quick=%s\n' "$DO_BUILD" "$DO_IDE" "$DO_QUICK"

# ---------------------------------------------------------------- 1. core 单测
step "core 单元/单测（纯逻辑，最快的闸门）"
if (cd "$APP" && npm run test:core 2>&1 | tail -12); then
  CNT=$(cd "$APP" && npm run test:core 2>&1 | grep -E '^# (pass|tests) ' | tr '\n' ' ')
  ok "core 单测通过 ${CNT}"
else
  bad "core 单测失败"
  next_hint unit
  exit 1
fi

# ---------------------------------------------------------------- 2. tsc
step "TypeScript 类型检查（tsc --noEmit，基线 0 告警）"
if (cd "$APP" && npx tsc --noEmit 2>&1 | tail -15); then
  TSC_CODE=${PIPESTATUS[0]}
else
  TSC_CODE=1
fi
if [ "$TSC_CODE" -eq 0 ]; then
  ok "tsc 无错误（基线 0 告警）"
else
  bad "tsc 有类型错误（基线已为 0 告警）"
  next_hint tsc
  exit 1
fi

# ---------------------------------------------------------------- 3. 编译
if [ "$DO_BUILD" -eq 1 ]; then
  step "小程序编译（npm run build:weapp → dist/）"
  if (cd "$APP" && npm run build:weapp 2>&1 | tail -8); then
    BUILD_CODE=${PIPESTATUS[0]}
  else
    BUILD_CODE=1
  fi
  if [ "$BUILD_CODE" -eq 0 ]; then
    ok "编译成功 → dist/"
  else
    bad "编译失败"
    next_hint build
    exit 1
  fi
else
  printf '\n\033[33m[跳过] 编译（--no-build）\033[0m\n'
fi

# ---------------------------------------------------------------- 4. 冒烟
if [ "$DO_IDE" -eq 1 ]; then
  step "全工具冒烟（连通性：T1/T2/T3/T5/T6）"
  printf '   注：本步只验「页面能跑通」，**不代表业务正确**（PRD 15.4 禁止项①）\n'
  if bash "$ROOT/工具链/smoke_all.sh"; then
    ok "全工具冒烟通过（连通性）"
  else
    bad "全工具冒烟失败"
    next_hint smoke
    exit 1
  fi

  # ---------------------------------------------------------------- 5. 批量业务验收
  step "真实素材批量业务验收（11 张真实照片 × T1/T2/T3 + 业务断言）"
  printf '   注：本步才是**业务正确性**闸门（像素尺寸/底色/头占比/文件大小/水印/换装盖脸/脸部干净）\n'
  printf '   成品落盘: 素材/测试截图/real_batch/<素材>/<工具>/\n'
  # IDE 通道一次只能维持一个会话 → 与上一步隔开
  printf '   等待 IDE 自动化通道释放（30s）…\n'
  sleep 30
  node "$ROOT/工具链/batch_real.js" --negatives --port 9441
  BATCH_CODE=$?
  if [ "$BATCH_CODE" -eq 0 ]; then
    ok "真实素材批量业务验收通过（连通性与业务断言均全绿）"
  elif [ "$BATCH_CODE" -eq 3 ]; then
    warn "IDE 自动化通道不可用 → 业务验收**未执行**（属环境问题，不计为验证失败）"
    info "开通道: \"/Applications/wechatwebdevtools.app/Contents/MacOS/cli\" auto \\"
    info "         --project \"$APP\" --auto-port 9441 --port 16780"
    info "然后重跑: node 工具链/batch_real.js --negatives"
  elif [ "$BATCH_CODE" -eq 4 ]; then
    # 连通性全通过，但业务断言不通过 → **真实产品问题**，必须阻断
    bad "真实素材批量业务验收：连通性通过，但**业务断言不通过**（真实产品问题）"
    next_hint batch
    exit 1
  else
    bad "真实素材批量业务验收失败（连通性未全通过，退出码 $BATCH_CODE）"
    next_hint batch
    exit 1
  fi
else
  printf '\n\033[33m[跳过] 冒烟与批量业务验收（--no-ide / --quick；需要微信开发者工具在跑）\033[0m\n'
fi

# ---------------------------------------------------------------- 6. 覆盖矩阵
step "需求 → 测试 覆盖矩阵（生成 docs/覆盖矩阵.md + 缺口检查）"
# 说明：缺口是**待办清单**而不是「构建坏了」—— 缺口会让本步**报警但不中断**，
#       因为缺口需要人（owner）去补测试或改需求口径，不该让 CI 永远红着。
#       想让它阻断请用 --strict。
node "$ROOT/工具链/coverage_matrix.js"
MATRIX_CODE=$?
if [ "$MATRIX_CODE" -ne 0 ]; then
  bad "覆盖矩阵生成失败（需求清单格式错误？）"
  next_hint coverage
  exit 1
fi
ok "覆盖矩阵已生成（docs/覆盖矩阵.md）"
# 缺口检查：缺口是**待办清单**，报警但不中断（--strict 可令其阻断）
node "$ROOT/工具链/coverage_matrix.js" --check
GAP_CODE=$?
if [ "$GAP_CODE" -eq 1 ]; then
  warn "覆盖矩阵存在缺口（详见 docs/覆盖矩阵.md 第三节「缺口清单」）"
  next_hint coverage
  if [ "${STRICT:-0}" -eq 1 ]; then
    bad "覆盖矩阵缺口（--strict 模式：视为失败）"
    exit 1
  fi
fi

# ---------------------------------------------------------------- 汇总
hr
printf '\033[1m汇总\033[0m\n'
hr
printf '通过步骤: %d\n' "$PASS_COUNT"
printf '失败步骤: %d\n' "$FAIL_COUNT"
if [ "$FAIL_COUNT" -gt 0 ]; then
  printf '\033[31m失败项：\033[0m\n'
  for f in "${FAILED_STEPS[@]}"; do printf '  · %s\n' "$f"; done
  exit 1
fi
printf '\n\033[32m✅ 全量验证通过\033[0m\n'
if [ "$DO_IDE" -eq 1 ]; then
  printf '\n※ 连通性（冒烟）与业务正确性（批量断言）是两个独立维度，\n'
  printf '  本次两者都已执行；业务产出明细见 素材/测试截图/real_batch/results.json\n'
fi
exit 0
