#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
每日开发日志骨架生成器（证件照小程序项目 · 跨平台 Python 版）

用途
----
自动生成当天《每日开发日志/YYYY-MM-DD.md》骨架，并自动采集：
  ① 当天改动过的文件清单（按 mtime）
  ② 台账未完成项（⬜ ⏳ 🔵 ⛔）
  ③ 需要「唐强」决策/操作的阻塞项
让"每日总结"从"想起才写"变成"一条命令就有一半内容"。

用法
----
  # 今天
  /Users/tq/.workbuddy/binaries/python/envs/default/bin/python 工具链/daily_summary.py
  # 指定某天
  .../python 工具链/daily_summary.py 2026-10-23
  # 只打印当前台账待办，不生成文件
  .../python 工具链/daily_summary.py --peek

依赖
----
Python 3 标准库（无第三方依赖）。

产物
----
每日开发日志/YYYY-MM-DD.md （已存在则不覆盖，防止冲掉当天已写内容）

注意
----
1. 本项目无 git（台账 #20），改动靠「文件 mtime」采集；跨零点开工时请用
   `--date` 明确指定归属日，否则凌晨的改动会被算到第二天。
2. 建议每天收工时跑一次；或用 macOS launchd / 提醒事项做定时提醒。
"""
import os
import sys
from datetime import datetime, timedelta

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOGDIR = os.path.join(ROOT, "每日开发日志")

SKIP_DIRS = {"node_modules", "dist", ".git", ".workbuddy", "测试截图"}
SKIP_FILES = {".DS_Store"}
TODO_FILE = os.path.join(ROOT, "开发任务台账.md")
ISSUE_FILE = os.path.join(ROOT, "问题台账.md")


def collect_changed(day: datetime.date):
    """按 mtime 采集当天改动的文件"""
    start = datetime.combine(day, datetime.min.time())
    end = start + timedelta(days=1)
    out = []
    for dirpath, dirnames, filenames in os.walk(ROOT):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for fn in filenames:
            if fn in SKIP_FILES:
                continue
            full = os.path.join(dirpath, fn)
            try:
                mt = datetime.fromtimestamp(os.path.getmtime(full))
            except OSError:
                continue
            if start <= mt < end:
                out.append((mt, os.path.relpath(full, ROOT)))
    out.sort()
    return [(mt.strftime("%H:%M"), rel) for mt, rel in out]


def parse_todo():
    """从《开发任务台账》抽取未完成条目"""
    rows, decide = [], []
    if not os.path.exists(TODO_FILE):
        return rows, decide
    with open(TODO_FILE, encoding="utf-8") as f:
        for line in f:
            line = line.rstrip("\n")
            if not line.startswith("| "):
                continue
            cells = [c.strip() for c in line.strip().strip("|").split("|")]
            if len(cells) < 4 or not cells[0].rstrip("abcdefghijklmnopqrstuvwxyz").isdigit():
                continue
            tid, task, status, owner = cells[0], cells[1], cells[2], cells[3]
            if any(s in status for s in ("⬜", "⏳", "🔵", "⛔")):
                rows.append((tid, task, status, owner))
                if "唐强" in owner:
                    decide.append(f"- {task}（任务 #{tid}）")
    return rows, decide


def count_issues():
    if not os.path.exists(ISSUE_FILE):
        return 0
    n = 0
    with open(ISSUE_FILE, encoding="utf-8") as f:
        for line in f:
            if line.startswith("| ") and line.count("|") >= 6:
                first = line.strip().strip("|").split("|")[0].strip()
                if first.isdigit():
                    n += 1
    return n


def peek():
    rows, decide = parse_todo()
    print(f"台账未完成项 {len(rows)} 条，问题台账累计 {count_issues()} 条\n")
    print("| # | 任务 | 状态 | 负责人 |")
    print("|---|---|---|---|")
    for tid, task, status, owner in rows:
        print(f"| {tid} | {task} | {status} | {owner} |")
    if decide:
        print("\n需要你决策/操作：")
        for d in decide:
            print(d)


def main():
    args = sys.argv[1:]
    if "--peek" in args:
        peek()
        return
    day_str = args[0] if args else None
    day = datetime.strptime(day_str, "%Y-%m-%d").date() if day_str else datetime.now().date()

    os.makedirs(LOGDIR, exist_ok=True)
    out = os.path.join(LOGDIR, f"{day}.md")
    if os.path.exists(out):
        print(f"⚠️  已存在，不覆盖（防冲掉已写内容）: {out}")
        print("   如需重生成，先手动删除该文件。")
        return

    changed = collect_changed(day)
    rows, decide = parse_todo()
    issues = count_issues()

    def md_ul(items, empty="（无）"):
        return "\n".join(items) if items else f"- {empty}"

    changed_md = md_ul([f"- `{t}`  {rel}" for t, rel in changed], "（当天无文件改动）")
    if decide:
        decide_md = md_ul(decide)
    else:
        decide_md = "- （暂无）"
    todo_md = md_ul(
        [f"- #{tid} {task} —— {status} · {owner}" for tid, task, status, owner in rows],
        "（台账无未完成项）",
    )

    content = f"""# 开发日志 · {day}

> 由 `工具链/daily_summary.py` 自动生成骨架，内容需人工补完。
> 项目：标准照裁剪（AppID `wxd7ff2aaa541a62e4`）· 当前任务见《开发任务台账.md》

## 一、今天做了什么

<!-- 一句话一件事，写清「动作 + 结果证据」，禁止写「继续开发」这类无效条目 -->

-

## 二、今天改了哪些文件（脚本自动采集，按修改时间）

{changed_md}

## 三、遇到的问题与解决

<!-- 当场登记到《问题台账.md》，此处只做摘要 -->

| 现象 | 根因 | 解决 | 台账# |
|---|---|---|---|
|  |  |  |  |

## 四、验证结果

<!-- 收尾必须实跑；写命令 + 结论，不能只写「通过」 -->

| 验证项 | 命令 | 结果 |
|---|---|---|
| 编译 + 单测 + 类型 | `NODE_OPTIONS= bash 工具链/verify.sh` |  |
| 模拟器冒烟 | `NODE_OPTIONS= node 工具链/smoke_auto.js` |  |

## 五、明天要做的（≤3 条，写清验收标准）

1.
2.
3.

## 六、需要你决策 / 操作的（自动提取自台账）

{decide_md}

## 七、今日经验沉淀

<!-- 值得下次复用的教训或做法；通用的一条记得同步写进《微信小程序开发实战避坑指南.md》 -->

-

---

## 附：当前未完成项全表（生成时快照）

{todo_md}
"""

    with open(out, "w", encoding="utf-8") as f:
        f.write(content)

    print(f"✅ 已生成：{out}")
    print(f"   改动文件 {len(changed)} 个 / 待决策 {len(decide)} 条 / 台账未完成 {len(rows)} 条 / 问题台账累计 {issues} 条")
    print("👉 下一步：补完「今天做了什么 / 验证结果 / 明天要做」三段；")
    print("   通用经验同步写进《微信小程序开发实战避坑指南.md》。")


if __name__ == "__main__":
    main()
