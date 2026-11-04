'use strict';
// 登记、实现和执行分开；仅有文件或部分断言不能证明整条需求通过。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ROOT = path.resolve(__dirname, '..');
const kinds = ['behavior', 'artifact', 'manual', 'external', 'structure', 'unit', 'controller'];
const external = ['I2', 'I3', 'I4', 'AC8', 'NFR-SECURITY', 'D1'];
function validate(requirements, cases, root = ROOT) {
  const errors = [];
  if (!Array.isArray(requirements) || !requirements.length || !Array.isArray(cases) || !cases.length) {
    return ['需求与用例必须为非空数组，禁止空清单绕过验收'];
  }
  const baseline = JSON.parse(fs.readFileSync(path.join(root, 'docs/rc01-baseline.json'), 'utf8'));
  const expected = new Map(baseline.requirements.map((r) => [r.id, r.requirement]));
  if (requirements.length !== expected.size || requirements.some((r) => !r || expected.get(r.id) !== r.desc)
      || new Set(requirements.map((r) => r && r.id)).size !== expected.size) {
    errors.push('需求编号与描述必须完整匹配RC-01基线，禁止删项或缩减需求');
  }
  const reqs = new Map();
  const registry = new Map();
  for (const r of requirements) {
    if (!r.id || reqs.has(r.id)) errors.push('需求编号缺失/重复');
    reqs.set(r.id, r);
    if (!kinds.includes(r.verify)) errors.push(`${r.id}:未知验证类型`);
    if (!r.desc || !r.acceptance || !Array.isArray(r.cases) || !r.cases.length) errors.push(`${r.id}:需求字段缺失`);
  }
  for (const c of cases) {
    if (!c.id || registry.has(c.id)) errors.push('用例编号缺失/重复');
    registry.set(c.id, c);
    for (const key of ['input', 'action', 'expected', 'negative', 'environment', 'limitations', 'evidence_policy']) {
      if (typeof c[key] !== 'string' || !c[key].trim()) errors.push(`${c.id}:${key}缺失`);
    }
    if (!['primary', 'partial'].includes(c.role) || !kinds.includes(c.kind) || !['planned', 'protocol', 'implemented'].includes(c.implementation)) errors.push(`${c.id}:分类无效`);
    if (!Array.isArray(c.requirements) || !c.requirements.length) errors.push(`${c.id}:需求映射缺失`);
    for (const id of c.requirements || []) {
      const r = reqs.get(id);
      if (!r || !r.cases.includes(c.id)) errors.push(`${c.id}:未知/非双向需求${id}`);
      if (c.role === 'primary' && external.includes(id) && c.kind !== 'external') errors.push(`${id}:须独立外部证据`);
      if (c.role === 'primary' && (id.startsWith('FLOW-') || id === 'AC12') && c.kind !== 'behavior') errors.push(`${id}:结构不能代替行为`);
    }
    if (['manual', 'external'].includes(c.kind) && c.implementation !== 'protocol') errors.push(`${c.id}:须提供人工/部署证据协议`);
    if (c.implementation === 'implemented') {
      const runner = c.runner || {};
      for (const key of ['script', 'selector_file']) {
        const value = runner[key] || (key === 'selector_file' ? runner.script : '');
        const file = typeof value === 'string' ? path.resolve(root, value) : root;
        if (!value || !file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) errors.push(`${c.id}:执行文件无效`);
        else if (key === 'selector_file' && (!runner.selector || !fs.readFileSync(file, 'utf8').includes(runner.selector))) errors.push(`${c.id}:断言定位不存在`);
      }
      if (!runner.command || !runner.selector) errors.push(`${c.id}:执行命令/定位缺失`);
    } else if (c.runner) errors.push(`${c.id}:未实现用例不得登记执行器`);
  }
  for (const r of requirements) {
    const owned = (r.cases || []).map((id) => registry.get(id));
    if (owned.some((c) => !c || !c.requirements.includes(r.id))) errors.push(`${r.id}:用例引用无效`);
    if (owned.filter((c) => c && c.role === 'primary').length !== 1) errors.push(`${r.id}:须有唯一主验收协议`);
  }
  return errors;
}
function buildMatrix(requirements, cases) {
  const registry = new Map(cases.map((c) => [c.id, c]));
  const rows = requirements.map((r) => {
    const owned = r.cases.map((id) => registry.get(id));
    const primary = owned.find((c) => c.role === 'primary');
    const partial = owned.filter((c) => c.role === 'partial' && c.implementation === 'implemented');
    const status = ['manual', 'external'].includes(primary.kind) ? '待人工/部署证据'
      : primary.implementation === 'implemented' ? '已实现主断言，待执行'
        : partial.length ? '部分断言，主验收缺口' : '缺少可执行主断言';
    return { ...r, status, execution: 'NOT_RUN', complete: false, case_details: owned };
  });
  return { version: 'RC-03-v1', scope: '需求级登记；不是业务验收结果', total: rows.length,
    implementedCases: cases.filter((c) => c.implementation === 'implemented').length,
    gaps: rows.filter((r) => !r.complete).map((r) => r.id), rows };
}
function markdown(matrix) {
  const lines = ['# 需求覆盖矩阵（RC-03）', '', '登记不等于执行通过。部分断言、结构检查、mock、估算、人工/部署证据分别记录；本表执行状态均为 NOT_RUN。', '',
    `需求 ${matrix.total} 条，可执行部分用例 ${matrix.implementedCases} 条，完整验收待补 ${matrix.gaps.length} 条。`, '', '| 需求 | 状态 | 后续任务 |', '| --- | --- | --- |'];
  for (const r of matrix.rows) lines.push(`| ${r.id} | ${r.status} | ${r.followup.join('、')} |`);
  for (const r of matrix.rows) {
    lines.push('', `## ${r.id} ${r.desc}`, '', `依据：${r.source.file} ${r.source.section}（${r.source.version}）`);
    for (const c of r.case_details) {
      lines.push('', `### ${c.id}（${c.role}/${c.kind}/${c.implementation}）`, '',
        ...['input', 'action', 'expected', 'negative', 'environment', 'limitations', 'evidence_policy'].map((key) => `- ${key}：${c[key]}`),
        `- 执行：${c.runner ? `${c.runner.command}；定位 ${c.runner.selector_file || c.runner.script}#${c.runner.selector}` : '协议已登记，尚无可执行主断言/本轮证据'}`);
    }
  }
  return lines.join('\n') + '\n';
}
function main(args = process.argv.slice(2)) {
  let mode = 'write';
  let output;
  let reqFile = path.join(__dirname, 'prd_requirements.json');
  let caseFile = path.join(__dirname, 'coverage_cases.json');
  for (let i = 0; i < args.length; i++) {
    if (['--json', '--print', '--check', '--validate'].includes(args[i])) mode = args[i].slice(2);
    else if (['--out', '--req', '--cases'].includes(args[i]) && args[i + 1]) {
      const flag = args[i]; const value = path.resolve(args[++i]);
      if (flag === '--out') output = value;
      else if (flag === '--req') reqFile = value;
      else caseFile = value;
    } else throw new Error('参数无效');
  }
  const requirements = JSON.parse(fs.readFileSync(reqFile, 'utf8')).requirements;
  const cases = JSON.parse(fs.readFileSync(caseFile, 'utf8')).cases;
  const errors = validate(requirements, cases);
  if (errors.length) throw new Error(errors.join('；'));
  const matrix = buildMatrix(requirements, cases);
  if (mode === 'json') console.log(JSON.stringify(matrix));
  else if (mode === 'print') console.log(markdown(matrix));
  else if (mode === 'validate') console.log(`登记校验通过：${matrix.total}条需求；不代表业务通过`);
  else if (mode === 'check') { console.log(`完整验收缺口：${matrix.gaps.join(', ')}`); return matrix.gaps.length ? 1 : 0; }
  else {
    const out = output || path.join(ROOT, 'docs/验证记录/coverage', crypto.randomUUID(), '覆盖矩阵.md');
    if (fs.existsSync(out)) throw new Error('输出已存在，禁止覆盖');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, markdown(matrix), { flag: 'wx' });
    console.log(out);
  }
  return 0;
}
module.exports = { validate, buildMatrix, markdown, main };
if (require.main === module) {
  try { process.exitCode = main(); }
  catch (error) { console.error(JSON.stringify({ code: 'COVERAGE_INVALID', message: error.message, traceId: crypto.randomUUID() })); process.exitCode = 2; }
}
