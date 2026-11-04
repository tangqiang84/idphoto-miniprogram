'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { validate, buildMatrix } = require('../coverage_matrix');
const ROOT = path.resolve(__dirname, '../..');
const reqs = require('../prd_requirements.json').requirements;
const cases = require('../coverage_cases.json').cases;
const clone = (value) => JSON.parse(JSON.stringify(value));
const cli = (...args) => spawnSync(process.execPath, [path.join(ROOT, '工具链/coverage_matrix.js'), ...args], { encoding: 'utf8' });
test('76 requirements match baseline and registry has no execution PASS', () => {
  assert.deepEqual(validate(reqs, cases), []);
  assert.deepEqual(reqs.map((r) => r.id).sort(), require('../../docs/rc01-baseline.json').requirements.map((r) => r.id).sort());
  const matrix = buildMatrix(reqs, cases);
  assert.equal(matrix.total, 76);
  assert.equal(matrix.implementedCases, 21);
  assert.equal(matrix.gaps.length, 76);
  assert.ok(matrix.rows.every((r) => r.execution === 'NOT_RUN' && !r.complete));
});
test('missing fields, duplicates, unknown references and unknown modes fail', () => {
  for (const mutate of [
    (r, c) => { c[0].expected = ''; },
    (r, c) => c.push(c[0]),
    (r) => r.push(r[0]),
    (r, c) => c[0].requirements.push('UNKNOWN'),
    (r) => { r[0].cases.push('UNKNOWN'); },
    (r) => { r[0].verify = 'guess'; },
  ]) {
    const r = clone(reqs); const c = clone(cases); mutate(r, c);
    assert.ok(validate(r, c).length);
  }
});
test('directories, escaping paths and absent assertion selectors fail', () => {
  for (const script of ['工具链/tests', '../outside.js', '工具链/not-present.js']) {
    const c = clone(cases); c.find((x) => x.runner).runner.script = script;
    assert.ok(validate(reqs, c).length);
  }
  const c = clone(cases); c.find((x) => x.runner).runner.selector = 'NON_EXISTENT_ASSERTION';
  assert.ok(validate(reqs, c).length);
});
test('structural flow and pixel privacy evidence cannot claim primary acceptance', () => {
  for (const [id, kind] of [['ACCEPT-AC12', 'structure'], ['ACCEPT-I3', 'artifact'], ['ACCEPT-AC8', 'unit']]) {
    const c = clone(cases); c.find((x) => x.id === id).kind = kind;
    assert.ok(validate(reqs, c).length);
  }
  const c = clone(cases); c.find((x) => x.kind === 'manual').implementation = 'planned';
  assert.ok(validate(reqs, c).length);
});
test('existing scripts and partial assertions never imply complete requirement', () => {
  const row = buildMatrix(reqs, cases).rows.find((r) => r.id === 'B2');
  assert.equal(row.status, '部分断言，主验收缺口');
  assert.equal(row.complete, false);
});
test('empty, omitted and reduced registries cannot bypass the coverage gate', () => {
  for (const [r, c] of [[[], []], [reqs, []], [undefined, cases], [reqs, {}]]) {
    assert.ok(validate(r, c).length);
  }
  const r = clone(reqs).filter((item) => item.id !== 'A0');
  const c = clone(cases).filter((item) => item.id !== 'ACCEPT-A0');
  assert.ok(validate(r, c).some((error) => error.includes('完整匹配RC-01')));
  const changed = clone(reqs); changed[0].desc = '缩减后的需求';
  assert.ok(validate(changed, cases).some((error) => error.includes('完整匹配RC-01')));
});
test('CLI rejects an empty manifest rather than declaring zero gaps', () => {
  const dir = fs.mkdtempSync(path.join(ROOT, '工具链/_tmp/rc03-empty-'));
  const req = path.join(dir, 'requirements.json');
  const registry = path.join(dir, 'cases.json');
  fs.writeFileSync(req, JSON.stringify({ requirements: [] }), { flag: 'wx' });
  fs.writeFileSync(registry, JSON.stringify({ cases: [] }), { flag: 'wx' });
  const result = cli('--req', req, '--cases', registry, '--check');
  assert.equal(result.status, 2);
  assert.equal(JSON.parse(result.stderr).code, 'COVERAGE_INVALID');
});
test('CLI emits parseable JSON and honest gate exit codes', () => {
  assert.equal(JSON.parse(cli('--json').stdout).total, 76);
  assert.equal(cli('--validate').status, 0);
  assert.equal(cli('--check').status, 1);
  assert.equal(cli('--unknown').status, 2);
});
test('report output is exclusive and preserves old content', () => {
  const dir = fs.mkdtempSync(path.join(ROOT, '工具链/_tmp/rc03-coverage-'));
  const out = path.join(dir, 'report.md');
  assert.equal(cli('--out', out).status, 0);
  const before = fs.readFileSync(out, 'utf8');
  assert.equal(cli('--out', out).status, 2);
  assert.equal(fs.readFileSync(out, 'utf8'), before);
});
