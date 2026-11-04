'use strict';
/**
 * 需求 → 测试 覆盖矩阵生成器
 * ============================================================================
 * 【为什么有这个文件】
 * owner 批评：「改动不知道自己哪些要回归」。根因：仓库里有大量测试脚本与
 * PRD 需求，但**两者之间没有映射** —— 没人能回答「这条需求到底测没测」。
 * 本工具把 PRD 需求清单（工具链/prd_requirements.json）与仓库里**实际存在的**
 * 测试脚本 / 断言做映射，输出 docs/覆盖矩阵.md，并把「没有对应测试」的条���
 * 单列成「缺口」一节 —— 让「还有什么没测到」变成**可见的清单**。
 *
 * 【映射规则（可审计）】
 *   映射不是拍脑袋写的，而是从**仓库里真实存在的脚本**推导：
 *   · 每个测试脚本在 TOOLCHAIN_SCRIPTS 里登记：它覆盖哪些需求 ID、跑哪个断言；
 *   · 每条需求按 verify 字段（unit/smoke/batch/pixel/manual）归类：
 *       - unit   → core 单测（idphoto-miniprogram/src/core/__tests__）
 *       - smoke  → 工具链/smoke_*.js（模拟器冒烟）
 *       - batch  → 工具链/batch_real.js（真实素材批量业务验收）
 *       - pixel  → 工具链/batch_real.js + 工具链/assert_business.js 的业务断言
 *       - manual → 只能人工看 → 状态「人工」
 *   · 若某需求在 TOOLCHAIN_SCRIPTS 里找不到任何脚本认领 → 状态「缺口」。
 *
 * 【状态口径】
 *   自动  = 有脚本 + 有断言能判定该需求的业务产出（可自动判定 PASS/FAIL）
 *   人工  = 该需求本质需要人眼/真机确认（如相机引导框、真机性能）
 *   缺口  = 需求声称可自动验证（verify != manual），但仓库里没有任何脚本覆盖
 *
 * 用法：
 *   NODE_OPTIONS= node 工具链/coverage_matrix.js            # 生成 docs/覆盖矩阵.md
 *   NODE_OPTIONS= node 工具链/coverage_matrix.js --print    # 只打印，不写文件
 *   NODE_OPTIONS= node 工具链/coverage_matrix.js --json     # 输出 JSON 统计
 *   NODE_OPTIONS= node 工具链/coverage_matrix.js --check    # 只检查缺口（有缺口则退出码 1）
 *   NODE_OPTIONS= node 工具链/coverage_matrix.js --req 工具链/我的需求.json
 *
 * 退出码：0 = 正常（--check 模式下表示无缺口）；1 = --check 模式发现缺口 / 用法错误
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DOCS_DIR = path.join(ROOT, 'docs');
const OUT_MD = path.join(DOCS_DIR, '覆盖矩阵.md');
const DEFAULT_REQ = path.join(__dirname, 'prd_requirements.json');

/**
 * 测试脚本登记表（SSOT of tests）。
 * 每条：{ script, kind, covers:[需求ID], asserts:[断言名], note }
 * kind: unit | smoke | batch | pixel
 */
const TOOLCHAIN_SCRIPTS = [
  {
    script: '工具链/batch_real.js',
    kind: 'batch',
    covers: ['B1', 'B2', 'B3', 'C1', 'C3', 'D2', 'D4', 'G1', 'H1', 'H2', 'I3', 'AC3', 'AC4', 'AC6', 'AC7', 'AC8', 'AC12', 'AC13', 'NFR-2', 'NFR-3'],
    asserts: ['assertPixelSize', 'assertBackgroundColor', 'assertHeadRatio', 'assertFileSize', 'assertNoWatermark', 'assertSuitKeepsFacePixels', 'assertFaceRegionClean'],
    note: '真实素材（素材/真实头像/ 11 张）× T1/T2/T3 全链路，成品落盘 + 业务断言（连通性与业务断言分列）',
  },
  {
    script: '工具链/assert_business.js',
    kind: 'pixel',
    covers: ['B3', 'C1', 'C3', 'D2', 'G1', 'H1', 'H2', 'AC4', 'AC6', 'AC7', 'NFR-2', 'NFR-3'],
    asserts: ['assertPixelSize', 'assertBackgroundColor', 'assertHeadRatio', 'assertFileSize', 'assertNoWatermark', 'assertSuitNotCoverFace', 'assertSuitKeepsFacePixels', 'assertFaceRegionClean'],
    note: '业务断言库（纯 Node，不依赖 IDE）；像素/底色/头占比/文件大小/水印/换装盖脸/五官不变/脸部干净',
  },
  {
    script: '工具链/smoke_auto.js',
    kind: 'smoke',
    covers: ['A0', 'A1', 'A3', 'E1', 'I1', 'AC1', 'AC5', 'J1'],
    asserts: ['首页卡片数≥6 且第6张为「冲印排版」', '状态行出现「完成」', 'AC5 反向：未授权时不进入处理链路'],
    note: 'T1 主链路冒烟（模拟器）',
  },
  {
    script: '工具链/smoke_t2.js',
    kind: 'smoke',
    covers: ['C1', 'C2', 'AC12'],
    asserts: ['换底色后重新合成（底色已更新为 #438EDB）', '状态行出现「完成」'],
    note: 'T2 换底色冒烟（含换底色回归护栏）',
  },
  {
    script: '工具链/smoke_t3.js',
    kind: 'smoke',
    covers: ['D1', 'D3', 'J3'],
    asserts: ['自检区块渲染（五官自检/PRD D3）', 'AC6 反向：未勾自检导出被拦截', 'AC5 反向：未勾授权不启动'],
    note: 'T3 换装冒烟',
  },
  {
    script: '工具链/smoke_t5.js',
    kind: 'smoke',
    covers: ['F2'],
    asserts: ['规格转换后状态行出现「完成」'],
    note: 'T5 规格转换冒烟',
  },
  {
    script: '工具链/smoke_print.js',
    kind: 'smoke',
    covers: ['K1', 'AC9', 'J2'],
    asserts: ['首页 6 张卡片且第 6 张是「冲印排版」', '点卡片真实进入 T6 页面', 'T1 导出页含「另存为冲印排版」入口'],
    note: 'T6 冲印排版入口可达性',
  },
  {
    script: '工具链/smoke_face.js',
    kind: 'smoke',
    covers: ['G2', 'AC10'],
    asserts: ['T4 报告出现「未检测」降级提示', 'T4 页面仍无「保存到相册」入口（AC10 只读）'],
    note: 'T4 合规检测冒烟（含 AC10 只读保证）',
  },
  {
    script: '工具链/smoke_privacy.js',
    kind: 'smoke',
    covers: ['I1'],
    asserts: ['授权弹窗/协议要素渲染'],
    note: '隐私合规冒烟',
  },
  {
    script: '工具链/smoke_beauty.js',
    kind: 'smoke',
    covers: ['E1', 'E2', 'AC2'],
    asserts: ['合规模式下禁用项置灰', '尝试开启被禁美颜项被拦截并提示'],
    note: '美颜受限冒烟（AC2 硬拦截）',
  },
  {
    script: '工具链/smoke_mirror.js',
    kind: 'smoke',
    covers: ['AC1'],
    asserts: ['镜像自查勾选前禁用保存'],
    note: '镜像自查（AC1）',
  },
  {
    script: '工具链/smoke_headcrop.js',
    kind: 'smoke',
    covers: ['B2', 'AC12'],
    asserts: ['智能裁切状态行/构图信息上屏'],
    note: '智能裁切（B2）冒烟',
  },
  {
    script: '工具链/smoke_spec.js',
    kind: 'smoke',
    covers: ['F1'],
    asserts: ['规格切换后目标像素正确'],
    note: '规格库（F1）冒烟',
  },
  {
    script: '工具链/smoke_dpi.js',
    kind: 'smoke',
    covers: ['H2', 'H2.1'],
    asserts: ['600dpi 输出像素翻倍', '600dpi 文件大小项为提示级'],
    note: '输出档位（300/600dpi）冒烟',
  },
  {
    script: '工具链/smoke_steps.js',
    kind: 'smoke',
    covers: ['B2', 'A0'],
    asserts: ['管线步骤屏顺序：裁剪→美颜→抠图换底→(换装)→预审→dpi→导出'],
    note: '管线步骤屏（RC-9）顺序冒烟',
  },
  {
    script: 'idphoto-miniprogram/src/core/__tests__',
    kind: 'unit',
    covers: ['A2', 'E2', 'F2', 'H2.1', 'J3', 'K3', 'K4', 'K5', 'AC2', 'AC11'],
    asserts: [
      'core 单测（node --test src/core/__tests__/*.test.js）：规格库/隐私契约/合规引擎/美颜/相纸库/裁剪/换装几何',
      'planLayout 合成几何：常规平铺不越界且绘制数==count',
      'planLayout：不可拼版（instax/方形贴纸）每版仅 1 张并带白边提示',
      'sheetPixelSize：输出像素 = 相纸 mm × dpi',
    ],
    note: 'core 纯逻辑单测（含相纸库 tiling 与不可拼版机型）',
  },
  {
    script: '工具链/verify_shoulder_metric.js',
    kind: 'unit',
    covers: ['D4'],
    asserts: ['肩线贴合度指标（模板旋转角 vs 8° 达标线）'],
    note: '换装肩线几何指标（#78）',
  },
  {
    script: '工具链/verify_suitfit_v2.js',
    kind: 'unit',
    covers: ['D4', 'AC13'],
    asserts: ['9 规格逐一回归：换装框不出画布/不盖脸'],
    note: '换装几何引擎 v2 回归',
  },
  {
    script: '工具链/verify_t1_suit.js',
    kind: 'unit',
    covers: ['D1', 'D2'],
    asserts: ['T1 换装流程：应用/取消换装后颈部线以上像素不变'],
    note: 'T1 内嵌换装（D2 五官不变）仿真',
  },
];

/** verify 字段 → 人类可读的验证方式名 */
const VERIFY_LABEL = {
  unit: '单测',
  smoke: '冒烟',
  batch: '批量业务验收',
  pixel: '像素级断言',
  manual: '人工',
};

const TOOL_LABEL = {
  T1: 'T1 一键证件照',
  T2: 'T2 换底色',
  T3: 'T3 AI 换装',
  T4: 'T4 合规检测',
  T5: 'T5 规格转换',
  T6: 'T6 冲印排版',
  '-': '（不限）',
};

function loadRequirements(reqPath) {
  const abs = path.resolve(reqPath);
  if (!fs.existsSync(abs)) {
    throw new Error(`需求清单不存在: ${abs}\n请创建该文件，格式：{"requirements":[{"id","module","desc","verify","tool"}]}`);
  }
  const raw = JSON.parse(fs.readFileSync(abs, 'utf8'));
  const list = Array.isArray(raw) ? raw : raw.requirements;
  if (!Array.isArray(list)) {
    throw new Error('需求清单格式错误：应为数组，或含 requirements 数组的对象');
  }
  return list.map((r, i) => ({
    id: String(r.id || `REQ-${i + 1}`),
    module: String(r.module || '-'),
    desc: String(r.desc || ''),
    verify: String(r.verify || 'manual').toLowerCase(),
    tool: String(r.tool || '-'),
  }));
}

/** 为一条需求找出覆盖它的脚本 */
function findCoveringScripts(req) {
  return TOOLCHAIN_SCRIPTS.filter((s) => s.covers.includes(req.id));
}

/** 脚本文件是否真实存在（core 单测按目录判定） */
function scriptExists(script) {
  const abs = path.join(ROOT, script);
  if (script.includes('__tests__')) {
    return fs.existsSync(abs) && fs.readdirSync(abs).some((f) => f.endsWith('.test.js'));
  }
  return fs.existsSync(abs);
}

function buildMatrix(reqs) {
  const rows = [];
  for (const req of reqs) {
    const covering = findCoveringScripts(req);
    const existing = covering.filter((s) => scriptExists(s.script));
    const missing = covering.filter((s) => !scriptExists(s.script));

    let status;
    let scripts = [];
    let asserts = [];

    if (existing.length) {
      scripts = existing.map((s) => s.script);
      asserts = Array.from(new Set(existing.flatMap((s) => s.asserts)));
      // 「自动」= 有脚本 + 有可判定的断言
      // 「人工」= 需求本质需人眼确认（verify=manual）→ 即使有脚本也标人工
      status = req.verify === 'manual' ? '人工' : '自动';
      if (req.verify === 'manual') {
        // 人工项：脚本只作为辅助参考
        scripts = existing.map((s) => s.script);
      }
    } else if (req.verify === 'manual') {
      status = '人工';
      scripts = [];
      asserts = [];
    } else {
      status = '缺口';
      scripts = [];
      asserts = [];
    }

    rows.push({
      ...req,
      status,
      scripts,
      asserts,
      coveringCount: covering.length,
      missingScripts: missing.map((s) => s.script),
      note: existing.length ? existing.map((s) => s.note).filter(Boolean).join('；') : '',
    });
  }
  return rows;
}

function summarize(rows) {
  const s = { 自动: 0, 人工: 0, 缺口: 0 };
  for (const r of rows) s[r.status] = (s[r.status] || 0) + 1;
  const byVerify = {};
  for (const r of rows) {
    const k = VERIFY_LABEL[r.verify] || r.verify;
    byVerify[k] = byVerify[k] || { 自动: 0, 人工: 0, 缺口: 0 };
    byVerify[k][r.status]++;
  }
  return { total: rows.length, byStatus: s, byVerify };
}

/** 生成 markdown */
function renderMarkdown(rows, reqPath, sum) {
  const L = [];
  L.push('# 需求 → 测试 覆盖矩阵');
  L.push('');
  L.push('> 本文件由 `工具链/coverage_matrix.js` **自动生成**，请勿手工编辑。');
  L.push('> 需求清单来源：`' + path.relative(ROOT, path.resolve(reqPath)) + '`（owner 可改写该 JSON 后重跑本脚本）');
  L.push('> 生成时间：' + new Date().toISOString().slice(0, 19).replace('T', ' '));
  L.push('');
  L.push('## 一、总览');
  L.push('');
  L.push('| 指标 | 数量 |');
  L.push('|---|---|');
  L.push(`| 需求总数 | ${sum.total} |`);
  L.push(`| 自动覆盖（有脚本+断言可判定） | ${sum.byStatus['自动']} |`);
  L.push(`| 人工（本质需人眼/真机确认） | ${sum.byStatus['人工']} |`);
  L.push(`| **缺口（声称可自动验证但无脚本覆盖）** | **${sum.byStatus['缺口']}** |`);
  L.push('');
  L.push('按验证方式分布：');
  L.push('');
  L.push('| 验证方式 | 自动 | 人工 | 缺口 |');
  L.push('|---|---|---|---|');
  for (const [k, v] of Object.entries(sum.byVerify)) {
    L.push(`| ${k} | ${v['自动']} | ${v['人工']} | ${v['缺口']} |`);
  }
  L.push('');
  L.push('状态口径：');
  L.push('');
  L.push('- **自动**：仓库里存在覆盖该需求的测试脚本，且该脚本带可判定的断言（像素/底色/占比/大小/水印/五官不变/流程状态），能给出明确 PASS/FAIL。');
  L.push('- **人工**：需求本质无法用脚本判定（相机引导框、真机性能、视觉确认），已明确标为人工验收项。');
  L.push('- **缺口**：需求声明了可自动验证（verify ≠ manual），但**没有任何脚本认领它** —— 这是需要补测试的地方。');
  L.push('');

  L.push('## 二、覆盖矩阵明细');
  L.push('');
  L.push('| 需求ID | 模块 | 需求 | 验证方式 | 对应测试脚本 | 对应断言 | 状态 |');
  L.push('|---|---|---|---|---|---|---|');
  for (const r of rows) {
    const s = r.scripts.length ? r.scripts.map((x) => '`' + x + '`').join('<br>') : '—';
    const a = r.asserts.length ? r.asserts.map((x) => '`' + x + '`').join('<br>') : '—';
    const v = (VERIFY_LABEL[r.verify] || r.verify) + (r.tool !== '-' ? ' / ' + (TOOL_LABEL[r.tool] || r.tool) : '');
    const badge = r.status === '自动' ? '✅ 自动' : (r.status === '人工' ? '👤 人工' : '❌ **缺口**');
    L.push(`| ${r.id} | ${r.module} | ${r.desc} | ${v} | ${s} | ${a} | ${badge} |`);
  }
  L.push('');

  const gaps = rows.filter((r) => r.status === '缺口');
  L.push('## 三、缺口清单（需要补测试）');
  L.push('');
  if (!gaps.length) {
    L.push('✅ 无缺口：所有非人工需求都有对应测试脚本与断言。');
  } else {
    L.push(`共 **${gaps.length}** 条缺口。这些需求在 PRD 中声明了可自动验证，但仓库里没有任何测试脚本覆盖 —— 改动相关代码时**不会被自动发现**。`);
    L.push('');
    L.push('| 需求ID | 模块 | 需求 | 验证方式 | 涉及工具 | 建议补测方式 |');
    L.push('|---|---|---|---|---|---|');
    for (const g of gaps) {
      L.push(`| ${g.id} | ${g.module} | ${g.desc} | ${VERIFY_LABEL[g.verify] || g.verify} | ${TOOL_LABEL[g.tool] || g.tool} | ${suggestFor(g)} |`);
    }
  }
  L.push('');

  const manual = rows.filter((r) => r.status === '人工');
  L.push('## 四、人工验收项（无法自动判定，需人眼/真机）');
  L.push('');
  if (!manual.length) {
    L.push('（无）');
  } else {
    L.push('| 需求ID | 需求 | 涉及工具 | 现有辅助脚本 |');
    L.push('|---|---|---|---|');
    for (const m of manual) {
      const s = m.scripts.length ? m.scripts.map((x) => '`' + x + '`').join('<br>') : '—';
      L.push(`| ${m.id} | ${m.desc} | ${TOOL_LABEL[m.tool] || m.tool} | ${s} |`);
    }
  }
  L.push('');

  L.push('## 五、测试脚本登记表（本矩阵的映射依据）');
  L.push('');
  L.push('| 脚本 | 类型 | 覆盖需求 | 断言 | 说明 | 脚本存在 |');
  L.push('|---|---|---|---|---|---|');
  for (const s of TOOLCHAIN_SCRIPTS) {
    const ex = scriptExists(s.script);
    L.push(`| \`${s.script}\` | ${VERIFY_LABEL[s.kind] || s.kind} | ${s.covers.join(', ')} | ${s.asserts.map((x) => '`' + x + '`').join('、')} | ${s.note} | ${ex ? '✅' : '❌ 缺失'} |`);
  }
  L.push('');
  L.push('---');
  L.push('');
  L.push('### 怎么用这份矩阵');
  L.push('');
  L.push('1. 改了某个模块的代码 → 查「对应测试脚本」列，把那些脚本跑一遍（`bash 工具链/verify_all.sh` 会全跑）。');
  L.push('2. 新增/修改 PRD 需求 → 改 `工具链/prd_requirements.json` 后重跑 `node 工具链/coverage_matrix.js`，矩阵会立即暴露新的缺口。');
  L.push('3. 缺口清单里的需求 → 要么补测试脚本，要么把 verify 改成 `manual`（明确承认只能人工验），**不要留空**。');
  L.push('');
  return L.join('\n');
}

/** 给缺口一条补测建议（按 verify 类型分流） */
function suggestFor(g) {
  switch (g.verify) {
    case 'unit':
      return '补 core 单测（`idphoto-miniprogram/src/core/__tests__/*.test.js`），或确认该逻辑是否已在现有单测中被间接覆盖并登记进 TOOLCHAIN_SCRIPTS';
    case 'smoke':
      return `补/扩 工具链/smoke_*.js 冒烟脚本（涉及工具 ${g.tool}），在页面层断言该需求的可观测产出`;
    case 'batch':
      return `把该需求纳入 工具链/batch_real.js 的断言项（对 素材/真实头像/ 全部真实素材跑）`;
    case 'pixel':
      return '在 工具链/assert_business.js 增加/复用业务断言，并在 工具链/batch_real.js 中接线';
    default:
      return '补对应测试脚本，或将 verify 改为 manual 并说明人工验收方式';
  }
}

// ---------------------------------------------------------------- CLI

function run(argv) {
  const args = argv.slice(2);
  const getArg = (k, d) => {
    const i = args.indexOf(k);
    return i >= 0 ? args[i + 1] : d;
  };
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`需求 → 测试 覆盖矩阵生成器

用法:
  node 工具链/coverage_matrix.js              # 生成 docs/覆盖矩阵.md
  node 工具链/coverage_matrix.js --print      # 只打印不写文件
  node 工具链/coverage_matrix.js --json       # 输出 JSON 统计
  node 工具链/coverage_matrix.js --check      # 只检查缺口（有缺口退出码 1）
  node 工具链/coverage_matrix.js --req <路径> # 指定需求清单（默认 工具链/prd_requirements.json）

需求清单格式:
  { "requirements": [ { "id": "A1", "module": "A 拍摄/上传", "desc": "...", "verify": "unit|smoke|batch|pixel|manual", "tool": "T1" } ] }

退出码: 0 = 正常（--check 且无缺口）；1 = --check 发现缺口；2 = 用法/文件错误`);
    return 0;
  }

  const reqPath = getArg('--req', DEFAULT_REQ);
  let reqs;
  try {
    reqs = loadRequirements(reqPath);
  } catch (e) {
    console.error('❌ ' + e.message);
    return 2;
  }
  if (!reqs.length) {
    console.error('❌ 需求清单为空');
    return 2;
  }

  const rows = buildMatrix(reqs);
  const sum = summarize(rows);
  const gaps = rows.filter((r) => r.status === '缺口');

  if (args.includes('--json')) {
    console.log(JSON.stringify({ summary: sum, rows }, null, 2));
  } else if (args.includes('--check')) {
    console.log(`需求总数 ${sum.total}｜自动 ${sum.byStatus['自动']}｜人工 ${sum.byStatus['人工']}｜缺口 ${sum.byStatus['缺口']}`);
    if (gaps.length) {
      console.log('\n❌ 存在覆盖缺口（声称可自动验证但无脚本覆盖）：');
      for (const g of gaps) {
        console.log(`  · ${g.id} [${g.module}] ${g.desc}`);
        console.log(`      验证方式=${g.verify} 工具=${g.tool} → ${suggestFor(g)}`);
      }
      return 1;
    }
    console.log('✅ 无覆盖缺口');
    return 0;
  } else {
    if (!args.includes('--print')) {
      fs.mkdirSync(DOCS_DIR, { recursive: true });
      const md = renderMarkdown(rows, reqPath, sum);
      fs.writeFileSync(OUT_MD, md);
      console.log('✅ 已生成 ' + path.relative(ROOT, OUT_MD));
    } else {
      console.log(renderMarkdown(rows, reqPath, sum));
    }
  }

  console.log(`需求总数 ${sum.total}｜自动覆盖 ${sum.byStatus['自动']}｜人工 ${sum.byStatus['人工']}｜缺口 ${sum.byStatus['缺口']}`);
  if (gaps.length) {
    console.log('\n缺口明细：');
    for (const g of gaps) console.log(`  · ${g.id} [${g.module}] ${g.desc}（${g.verify}/${g.tool}）`);
  }
  return 0;
}

module.exports = { TOOLCHAIN_SCRIPTS, VERIFY_LABEL, buildMatrix, summarize, loadRequirements, scriptExists };

if (require.main === module) {
  process.exit(run(process.argv));
}
