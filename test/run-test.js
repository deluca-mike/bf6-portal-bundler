#!/usr/bin/env node

/**
 * Portal uploads `bundle.ts` as TypeScript (with strict typings); it is never compiled to JS here.
 *
 * Type-check options come from `tsconfig.bundle.json` (extends `tsconfig.json`): **ES2020** + `lib: ES2020` only,
 * `moduleResolution: bundler` (not Node), and **`types: []`** so `@types/node` is never pulled in — matching a
 * stripped QuickJS Portal environment (no Node stdlib / no Node globals).
 *
 * This script (1) runs the bundler, (2) validates the bundle with TypeScript in **noEmit** mode — the same
 * `tsc --noEmit` idea: type-check only, no JavaScript output — (3) runs ESLint on the bundle, and (4) transpiles
 * the bundle with `transpileModule` + `Module._compile` (Node, ES2020) to run `runBundlerFixture()` and assert
 * its output against `expected-bundler-fixture-joined.js` (Portal uses QuickJS; this is a best-effort runtime check).
 */

const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const Module = require('module');
const path = require('path');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
const bundlePath = path.normalize(path.join(__dirname, 'dist', 'bundle.ts'));
const eslintCli = path.join(root, 'node_modules', 'eslint', 'bin', 'eslint.js');
const EXPECTED_JOINED = require('./expected-bundler-fixture-joined.js');

const bundleResult = spawnSync(
    process.execPath,
    [path.join(root, 'index.js'), '--entrypoint', './test/src/index.ts', '--outDir', './test/dist'],
    { cwd: root, stdio: 'inherit' }
);

if (bundleResult.status !== 0) {
    process.exit(bundleResult.status ?? 1);
}

if (!fs.existsSync(bundlePath)) {
    console.error(`Expected bundle at ${bundlePath}`);
    process.exit(1);
}

const testDir = __dirname;
const bundleConfigPath = path.join(testDir, 'tsconfig.bundle.json');
const readConfig = ts.readConfigFile(bundleConfigPath, ts.sys.readFile);

if (readConfig.error) {
    const msg = readConfig.error.messageText;
    console.error(typeof msg === 'string' ? msg : ts.flattenDiagnosticMessageText(msg, '\n'));
    process.exit(1);
}

const parsed = ts.parseJsonConfigFileContent(readConfig.config, ts.sys, testDir, undefined, bundleConfigPath);

if (parsed.errors.length > 0) {
    console.error('Failed to parse tsconfig.bundle.json:\n');
    for (const e of parsed.errors) {
        console.error(ts.flattenDiagnosticMessageText(e.messageText, '\n'));
    }
    process.exit(1);
}

const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
const diags = ts.getPreEmitDiagnostics(program).filter((d) => d.category === ts.DiagnosticCategory.Error);

if (diags.length > 0) {
    console.error('TypeScript (noEmit) errors in bundled output:\n');
    for (const d of diags) {
        const msg = ts.flattenDiagnosticMessageText(d.messageText, '\n');
        const pos =
            d.file && d.start !== undefined
                ? `${d.file.fileName}:${d.file.getLineAndCharacterOfPosition(d.start).line + 1}`
                : '';
        console.error(`  ${pos} ${msg}`);
    }
    process.exit(1);
}

console.log(`OK: ${path.relative(root, bundlePath)} — TypeScript check passed (noEmit, no JS written).`);

const eslintResult = spawnSync(process.execPath, [eslintCli, bundlePath], { cwd: root, stdio: 'inherit' });

if (eslintResult.status !== 0) {
    process.exit(eslintResult.status ?? 1);
}

console.log(`OK: ${path.relative(root, bundlePath)} — ESLint passed.`);

const bundleSrc = fs.readFileSync(bundlePath, 'utf8');
const { outputText: bundleJs } = ts.transpileModule(bundleSrc, {
    compilerOptions: {
        target: ts.ScriptTarget.ES2020,
        module: ts.ModuleKind.CommonJS,
        esModuleInterop: true,
    },
    fileName: 'bundle.ts',
});

const runtimeModule = new Module(bundlePath);
runtimeModule.filename = bundlePath;
runtimeModule.paths = Module._nodeModulePaths(testDir);

try {
    runtimeModule._compile(bundleJs, bundlePath);
} catch (err) {
    console.error('Failed to execute transpiled bundle (runtime smoke test):\n', err);
    process.exit(1);
}

const runBundlerFixture = runtimeModule.exports.runBundlerFixture;
assert.equal(typeof runBundlerFixture, 'function', 'bundle must export runBundlerFixture');
const actualJoined = runBundlerFixture();
assert.equal(
    actualJoined,
    EXPECTED_JOINED,
    'runBundlerFixture() joined output must match expected tags, tokens, enums, and metrics'
);

console.log('OK: runBundlerFixture() runtime output matches expected-bundler-fixture-joined.js.');
