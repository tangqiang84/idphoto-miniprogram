#!/usr/bin/env bash
# =============================================================
# 每日开发日志骨架生成器（证件照小程序项目）
# -------------------------------------------------------------
# 用途：自动生成当天《每日开发日志/YYYY-MM-DD.md》骨架，并自动采集
#       ① 当天改过的文件清单  ② 台账未完成项  ③ 待决策/阻塞项
#       让"每日总结"从"想起才写"变成"一条命令就有一半内容"。
#
# 用法：
#   NODE_OPTIONS= bash 工具链/daily_summary.sh            # 今天
#   NODE_OPTIONS= bash 工具链/daily_summary.sh 2026-10-23 # 指定某天
#
# 依赖：无（纯 shell + grep）；项目无 git，故改动靠文件 mtime 采集
# 注意：已存在的日志文件不会覆盖（防止冲掉当天已写内容）
# 产物：每日开发日志/YYYY-MM-DD.md
# =============================================================
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DATE="${1:-$(date +%Y-%m-%d)}"
LOGDIR="$ROOT/每日开发日志"
OUT="$LOGDIR/$DATE.md"

mkdir -p "$LOGDIR"

if [ -f "$OUT" ]; then
  echo "⚠️  已存在，不覆盖（防止冲掉已写内容）: $OUT"
  echo "   如需重生成，先手动删除该文件。"
  exit 0
fi

# ---------- 1. 当天改动文件（24h 内 / 或指定日期当天） ----------
CHANGED=$(find "$ROOT" -type f -newermt "$DATE 00:00:00" \
  -not -path "*/node_modules/*" \
  -not -path "*/dist/*" \
  -not -path "*/.git/*" \
  -not -path "*/素材/测试截图/*" \
  -not -name ".DS_Store" 2>/dev/null | sed "s|$ROOT/||" | sort)

# ---------- 2. 台账未完成项 ----------
TODO=$([ -f "$ROOT/开发任务台账.md" ] && grep -E '^\| [0-9]+[a-z]? \|' "$ROOT/开发任务台账.md" \
  | grep -E '⬜|⏳|🔵|⛔' | sed 's/^| //' || echo "（台账文件不存在）")

# ---------- 3. 待决策 / 阻塞（重点提取负责人为"唐强"的项）----------
DECIDE=$([ -f "$ROOT/开发任务台账.md" ] && grep -E '^\| [0-9]+[a-z]? \|' "$ROOT/开发任务台账.md" \
  | grep -E '唐强' | grep -E '⬜|⏳|⛔' | awk -F'|' '{print "- "$3"  (任务#"$2")"}' || echo "")

# ---------- 4. 问题台账今天新增 ----------
ISSUES=$([ -f "$ROOT/问题台账.md" ] && grep -c '^|' "$ROOT/问题台账.md" || echo 0)

# ---------- 写文件 ----------
cat > "$OUT" <<EOF
# 开发日志 · $DATE

> 由 \`工具链/daily_summary.sh\` 自动生成骨架，内容需人工补完。
> 项目：标准照裁剪（AppID wxd7ff2aaa541a62e4）· 昨日/当日状态见《开发任务台账.md》

## 一、今天做了什么

<!-- 一句话一件事，写清「动作 + 结果证据」，禁止写「继续开发」这种无效条目 -->

- 

## 二、今天改了哪些文件（脚本自动采集）

$(if [ -n "$CHANGED" ]; then echo "$CHANGED" | sed 's/^/- `/;s/$/`/'; else echo "- （当天无文件改动，或日志生成于次日凌晨）"; fi)

## 三、遇到的问题与解决

<!-- 当场登记到《问题台账.md》，此处只做摘要。格式：现象 → 根因 → 解决 -->

| 现象 | 根因 | 解决 | 台账# |
|---|---|---|---|
|  |  |  |  |

## 四、验证结果

<!-- 收尾必须实跑；写命令 + 结论，不能只写"通过" -->

| 验证项 | 命令 | 结果 |
|---|---|---|
| 编译 + 单测 + 类型 | \`NODE_OPTIONS= bash 工具链/verify.sh\` |  |
| 模拟器冒烟 | \`NODE_OPTIONS= node 工具链/smoke_auto.js\` |  |

## 五、明天要做的（≤3 条，写清验收标准）

1. 
2. 
3. 

## 六、需要你决策/操作的（自动提取自台账）

$(if [ -n "$DECIDE" ]; then echo "$DECIDE"; else echo "- （暂无）"; fi)

## 七、今日经验沉淀

<!-- 值得下次复用的教训或做法；通用的写进《微信小程序开发实战避坑指南》 -->

- 
EOF

echo "✅ 已生成：$OUT"
echo "   自动填入：改动文件 $(echo "$CHANGED" | grep -c . 2>/dev/null || echo 0) 个 / 待决策略 $(echo "$DECIDE" | grep -c . 2>/dev/null || echo 0) 条 / 台账现存条目 $(echo "$ISSUES" | xargs)"
echo "👉 下一步：用编辑器补完「今天做了什么 / 验证结果 / 明天要做」三段，如有 scrub 经验同步写进《微信小程序开发实战避坑指南.md》。"
