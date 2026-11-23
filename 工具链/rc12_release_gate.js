'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const required = [
  ['automated', 'local'],
  ['coverage', 'local'],
  ['prototype', 'ide'],
  ['exports', 'ide'],
  ['ios', 'device'],
  ['android', 'device'],
  ['cloud', 'cloud'],
  ['release-materials', 'review'],
];
const states = ['PASS', 'FAIL', 'BLOCKED', 'SKIPPED', 'N/A'];
const digest = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function assess(candidate, manifest, evidenceRoot) {
  if (!/^[0-9a-f]{40}$/.test(candidate.commit || '') ||
      !/^[0-9a-f]{64}$/.test(candidate.buildId || '') ||
      typeof candidate.version !== 'string' || !candidate.version) throw Error('RC12_CANDIDATE_INVALID');
  if (!Array.isArray(manifest) || manifest.some(row => !row || !required.some(([id]) => id === row.id)) ||
      new Set(manifest.map(row => row.id)).size !== manifest.length) throw Error('RC12_MANIFEST_INVALID');
  const rows = required.map(([id, scope]) => {
    const row = manifest.find(entry => entry.id === id);
    const blocked = (reason) => ({id, scope, status:'BLOCKED', reason});
    if (!row) return blocked('EVIDENCE_MISSING');
    if (!states.includes(row.status) || row.scope !== scope) return blocked('EVIDENCE_SCOPE_INVALID');
    if (row.commit !== candidate.commit || row.buildId !== candidate.buildId || row.version !== candidate.version) return blocked('CANDIDATE_MISMATCH');
    if (row.status !== 'PASS') return {id, scope, status:row.status, reason:row.reason || 'NOT_PASSED'};
    if (scope === 'device' && (!row.device || row.device.platform !== id ||
        !['model','wechat','sdk'].every(key => typeof row.device[key] === 'string' && row.device[key].trim()) ||
        !Number.isFinite(row.elapsedMs) || row.elapsedMs <= 0)) return blocked('DEVICE_METADATA_MISSING');
    if (!row.artifact || typeof row.artifact.path !== 'string' || !/^[a-f0-9]{64}$/.test(row.artifact.sha256 || '')) return blocked('ARTIFACT_MISSING');
    try {
      const root = fs.realpathSync(evidenceRoot);
      const file = fs.realpathSync(path.resolve(root,row.artifact.path));
      if (!file.startsWith(root + path.sep) || !fs.statSync(file).isFile() || digest(file) !== row.artifact.sha256) return blocked('ARTIFACT_MISMATCH');
    } catch { return blocked('ARTIFACT_MISMATCH'); }
    return {id,scope,status:'PASS',artifact:row.artifact};
  });
  const counts = Object.fromEntries(states.map(state => [state, rows.filter(row => row.status === state).length]));
  return {candidate,status:counts.FAIL ? 'FAIL' : counts.PASS === required.length ? 'PASS' : 'BLOCKED',counts,rows};
}

if (require.main === module) {
  try {
    const [manifestPath, out] = process.argv.slice(2);
    if (!manifestPath || !out || process.argv.length !== 4) throw Error('RC12_USAGE');
    const input = JSON.parse(fs.readFileSync(manifestPath,'utf8'));
    const result = assess(input.candidate,input.rows,path.dirname(manifestPath));
    fs.writeFileSync(out,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
    console.log(JSON.stringify({status:result.status,counts:result.counts}));
    process.exitCode = result.status === 'PASS' ? 0 : result.status === 'FAIL' ? 1 : 3;
  } catch (e) {
    console.error(/^RC12_/.test(e.code || e.message) ? e.code || e.message : 'RC12_INPUT_OR_OUTPUT_INVALID');
    process.exitCode = 2;
  }
}

module.exports = {assess, required};
