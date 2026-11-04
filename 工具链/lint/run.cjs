'use strict';
const path = require('path');

async function main() {
  let ESLint;
  let parser;
  try {
    ({ ESLint } = require('eslint'));
    parser = require.resolve('@typescript-eslint/parser');
    require.resolve('eslint-plugin-react-hooks');
  } catch {
    console.error('ESLINT_SETUP_MISSING：请在工具链/lint执行 npm ci --ignore-scripts；不在小程序目录安装。');
    return 3;
  }
  const root = path.resolve(__dirname, '../..');
  const eslint = new ESLint({
    cwd: root,
    useEslintrc: false,
    resolvePluginsRelativeTo: __dirname,
    fix: false,
    overrideConfig: {
      root: true,
      parser,
      parserOptions: { ecmaVersion: 2022, sourceType: 'module', ecmaFeatures: { jsx: true } },
      env: { browser: true, node: true, es2022: true },
      plugins: ['react-hooks'],
      ignorePatterns: ['**/node_modules/**', '**/dist/**', '工具链/_tmp/**', 'docs/验证记录/**'],
      rules: {
        'no-debugger': 'error',
        'no-dupe-args': 'error',
        'no-dupe-keys': 'error',
        'no-unreachable': 'error',
        'valid-typeof': 'error',
        'no-unsafe-finally': 'error',
        'react-hooks/rules-of-hooks': 'error',
      },
    },
  });
  if (process.argv.includes('--selftest')) {
    const examples = [
      ['合法JS', 'const value = 1;', 'src/example.js', false],
      ['合法TS', 'const value: number = 1;', 'src/example.ts', false],
      ['合法TSX', 'const view = <View value={1} />;', 'src/example.tsx', false],
      ['拦截debugger', 'debugger;', 'src/example.ts', true],
      ['拦截重复键', 'const value = { a: 1, a: 2 };', 'src/example.js', true],
      ['拦截语法错误', 'const value: = ;', 'src/example.ts', true],
    ];
    let failures = 0;
    for (const [label, code, filePath, expectedFailure] of examples) {
      const results = await eslint.lintText(code, { filePath });
      const failed = results.some((result) => result.errorCount > 0);
      const ok = failed === expectedFailure;
      if (!ok) failures++;
      console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`);
    }
    return failures ? 1 : 0;
  }
  const results = await eslint.lintFiles([
    'idphoto-miniprogram/src/**/*.{js,ts,tsx}',
    'idphoto-miniprogram/config/**/*.ts',
    'idphoto-miniprogram/types/**/*.ts',
    'idphoto-miniprogram/cloudfunctions/**/*.js',
    '工具链/*.js', '工具链/tests/**/*.js', '工具链/lint/*.cjs',
  ]);
  const formatter = await eslint.loadFormatter('stylish');
  const output = formatter.format(results);
  if (output) console.log(output);
  const errors = results.reduce((sum, result) => sum + result.errorCount, 0);
  console.log(`ESLint检查 ${results.length} 个文件，错误 ${errors}；未自动修改文件。`);
  return errors ? 1 : 0;
}

main().then((code) => { process.exitCode = code; }).catch(() => {
  console.error('ESLINT_INTERNAL_ERROR：检查器执行异常，请核对隔离工具依赖及配置。');
  process.exitCode = 2;
});
