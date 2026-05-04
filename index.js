#!/usr/bin/env node

/**
 * Portal bundler: walk the dependency graph, resolve duplicate top-level export names and import aliases in memory,
 * strip module syntax, concatenate sources, merge strings JSON, optionally minify. Non-trivial pieces are
 * documented inline below (especially TypeScript symbol-based renames and virtual program host).
 */

const fs = require('fs');
const path = require('path');
const ts = require('typescript');
const stripComments = require('strip-comments');
const removeBlankLines = require('remove-blank-lines');

/** Shipped next to `index.js`; used for startup banner only. */
const BUNDLER_VERSION = (() => {
    try {
        const pkgPath = path.join(__dirname, 'package.json');
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
    } catch {
        return '0.0.0';
    }
})();

/** Used only for `--minify`. Prettier 3 `format()` is async, which is why `build()` is async. */
const PRETTIER_CONFIG = {
    parser: 'typescript',
    printWidth: 1000,
    tabWidth: 0,
    useTabs: false,
    semi: false,
    singleQuote: true,
    quoteProps: 'as-needed',
    trailingComma: 'none',
    bracketSpacing: false,
    objectWrap: 'collapse',
    arrowParens: 'avoid',
    proseWrap: 'never',
    endOfLine: 'lf',
};

// --- CONFIGURATION ---
const EXTERNAL_MODULES = ['mod']; // Modules to IGNORE (remote env provides them)

// Parse command-line arguments
function parseArgs() {
    const args = process.argv.slice(2);
    let entrypoint = null;
    let outDir = null;
    let removeComments = false;
    let minify = false;

    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--entrypoint' && i + 1 < args.length) {
            entrypoint = args[++i];
        } else if (args[i] === '--outDir' && i + 1 < args.length) {
            outDir = args[++i];
        } else if (args[i] === '--removeComments') {
            // Support both `--removeComments` (flag) and `--removeComments true/false`
            if (i + 1 < args.length && !args[i + 1].startsWith('--')) {
                const val = String(args[++i]).toLowerCase();
                removeComments = val === 'true' || val === '1' || val === 'yes';
            } else {
                removeComments = true;
            }
        } else if (args[i] === '--minify') {
            // Support both `--minify` (flag) and `--minify true/false`
            if (i + 1 < args.length && !args[i + 1].startsWith('--')) {
                const val = String(args[++i]).toLowerCase();
                minify = val === 'true' || val === '1' || val === 'yes';
            } else {
                minify = true;
            }
        }
    }

    if (!entrypoint || !outDir) {
        console.error('Usage: bf6-portal-bundler --entrypoint <path> --outDir <path>');
        console.error('Example: bf6-portal-bundler --entrypoint ./src/index.ts --outDir ./dist');
        process.exit(1);
    }

    // Resolve paths relative to current working directory
    const cwd = process.cwd();
    const ENTRY_FILE = path.resolve(cwd, entrypoint);
    const OUTPUT_FILE = path.resolve(cwd, outDir, 'bundle.ts');
    const OUTPUT_STRINGS_FILE = path.resolve(cwd, outDir, 'bundle.strings.json');

    // `node_modules` resolution is always from cwd (where the CLI is invoked), not the bundler package install dir.
    const PROJECT_ROOT = cwd;
    const REMOVE_COMMENTS_OUTPUT = removeComments;
    const MINIFY_OUTPUT = minify;

    return { ENTRY_FILE, OUTPUT_FILE, OUTPUT_STRINGS_FILE, PROJECT_ROOT, REMOVE_COMMENTS_OUTPUT, MINIFY_OUTPUT };
}

const { ENTRY_FILE, OUTPUT_FILE, OUTPUT_STRINGS_FILE, PROJECT_ROOT, REMOVE_COMMENTS_OUTPUT, MINIFY_OUTPUT } =
    parseArgs();

/** Prevents infinite recursion on circular imports; keys are absolute paths as returned by `resolveImport`. */
const visited = new Set();

/**
 * Post-order list from `walk`: each file appears after every file it imports (directly or transitively).
 * Duplicate-export naming uses this order so “first in list” keeps the bare export name (`Foo`), later files get
 * `Foo_2`, `Foo_3`, … — aligned with concatenation order in the final bundle.
 */
const buildOrder = [];

// Resolve a specialized import string to an absolute file path
function resolveImport(importPath, currentFileDir) {
    if (EXTERNAL_MODULES.includes(importPath)) return null;

    let targetPath;

    if (importPath.startsWith('.')) {
        targetPath = path.resolve(currentFileDir, importPath);
    } else {
        // Node Module Import (e.g., '@community/pathfinder')
        // We assume the source is at node_modules/<package_name>/index.ts or just node_modules/<package_name>.ts
        // Use PROJECT_ROOT (user's project) instead of __dirname (bundler's location)
        targetPath = path.resolve(PROJECT_ROOT, 'node_modules', importPath);
    }

    // Try to find the file on disk with various extensions
    const extensions = ['.ts', '/index.ts', '.d.ts']; // We prioritize .ts

    // Check exact match
    if (fs.existsSync(targetPath) && fs.statSync(targetPath).isFile()) return targetPath;

    // Check extensions
    for (const ext of extensions) {
        const appended = path.normalize(targetPath + ext);

        if (fs.existsSync(appended) && fs.statSync(appended).isFile()) return appended;
    }

    console.warn(`⚠️  Warning: Could not resolve import "${importPath}" from ${currentFileDir}`);

    return null;
}

// Core Recursive Walker
function walk(filePath) {
    if (visited.has(filePath)) return; // Already processed

    visited.add(filePath);

    const rawContent = fs.readFileSync(filePath, 'utf8');
    const cleanContent = stripComments(rawContent, { language: 'ts' });

    // Dependency discovery is regex-based (not a full TS parser): fast and good enough for typical mod imports.
    // We scan comment-stripped source so strings in comments do not create false edges.
    const patterns = [
        // 1. import/export … from "path" (including `export * from` / `export { x } from`). The `from` requirement
        //    avoids matching `export class Foo` / `export const x = …` which are not module boundaries.
        /(?:import|export)\s+[\s\S]*?from\s*['"](.*?)['"]/g,

        // 2. Side-effect only: import "path" (no `from` — must be a separate pattern from (1)).
        /import\s+['"](.*?)['"]/g,

        // 3. `import x = require("path")` (legacy TS style still seen in some codebases).
        /import\s+[\s\S]*?=\s*require\(['"](.*?)['"]\)/g,
    ];

    for (const regex of patterns) {
        let match;

        // `g` regex retains `lastIndex`; reset so each pattern pass starts from the beginning of the file.
        regex.lastIndex = 0;

        while ((match = regex.exec(cleanContent)) !== null) {
            const importPath = match[1]; // The path is always in the first capture group now

            if (!importPath) continue;

            const absolutePath = resolveImport(importPath, path.dirname(filePath));

            // Skip .d.ts: type-only packages should not pull implementation into the Portal bundle.
            if (!absolutePath || absolutePath.endsWith('.d.ts')) continue;

            // Depth-first: resolve this dependency’s graph before appending the current file (post-order push below).
            walk(absolutePath);
        }
    }

    // Post-order traversal: Add to list AFTER processing children.
    // This ensures dependencies are listed before the files that import them.
    buildOrder.push(filePath);
}

/**
 * Single canonical key for `fileContents` / `declarations` / edit paths: resolves symlinks/cwd variants so Map lookups
 * stay consistent with `program.getSourceFile().fileName` across passes.
 */
function normalizeBuildPath(filePath) {
    return path.normalize(path.resolve(filePath));
}

/**
 * Checker options for graph analysis only (no emit). ES2020 + `moduleResolution: "bundler"` matches typical flat
 * mod + relative imports; `strict` improves symbol fidelity for rename operations.
 */
const BUNDLING_COMPILER_OPTIONS = {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ES2020,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowImportingTsExtensions: true,
    allowSyntheticDefaultImports: true,
    esModuleInterop: true,
    skipLibCheck: true,
    noEmit: true,
    strict: true,
};

/**
 * Builds a `Program` whose sources come from the in-memory `fileContents` map when possible.
 *
 * Rationale: after `handleDuplicateDeclarations` mutates strings, disk files are stale. A custom `CompilerHost`
 * ensures the checker sees the same text we will later concatenate — otherwise renames and import resolution drift.
 */
function createProgramWithFileContents(rootNames, fileContents) {
    const normalizedRootNames = rootNames.map(normalizeBuildPath);
    const host = ts.createCompilerHost(BUNDLING_COMPILER_OPTIONS, true);
    const originalReadFile = host.readFile.bind(host);

    host.readFile = (fileName) => {
        const key = normalizeBuildPath(fileName);
        return fileContents.has(key) ? fileContents.get(key) : originalReadFile(fileName);
    };

    const originalGetSourceFile = host.getSourceFile.bind(host);

    host.getSourceFile = (fileName, languageVersion, ...rest) => {
        const key = normalizeBuildPath(fileName);

        return fileContents.has(key)
            ? ts.createSourceFile(fileName, fileContents.get(key), languageVersion, true, ts.ScriptKind.TS)
            : originalGetSourceFile(fileName, languageVersion, ...rest);
    };

    return ts.createProgram({
        rootNames: normalizedRootNames,
        options: BUNDLING_COMPILER_OPTIONS,
        host,
    });
}

/**
 * Lists **exported** symbols for duplicate counting. `default` is skipped: two `export default` values cannot be
 * disambiguated by a simple name suffix in this bundler, and Portal mods rarely rely on that pattern here.
 *
 * @param checker Unused today; kept so call sites can pass the program checker if this ever needs type-only filtering.
 */
function getExportedBindingNames(sourceFile, checker) {
    const mod = sourceFile.symbol;

    if (!mod?.exports) return [];

    const names = [];

    mod.exports.forEach((_sym, esc) => {
        const n = ts.unescapeLeadingUnderscores(esc);

        if (n === 'default') return;

        names.push(n);
    });

    return names;
}

/**
 * Finds every identifier that refers to the same **merged** export symbol as `exportSymbol` and renames it to
 * `newName`. Walks the whole program so importers (and merged class/namespace bodies) stay in sync.
 *
 * `getAliasedSymbol` is only used when `sym` is an Alias — calling it on non-aliases throws inside TypeScript.
 */
function collectIdentifierRenameEdits(program, checker, exportSymbol, newName) {
    const target = checker.getMergedSymbol(exportSymbol);
    const edits = [];

    for (const sf of program.getSourceFiles()) {
        if (sf.isDeclarationFile) continue;

        function addEdit(node) {
            if (!ts.isIdentifier(node)) return;

            const sym = checker.getSymbolAtLocation(node);

            if (!sym) return;

            const base = sym.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(sym) : sym;
            const merged = checker.getMergedSymbol(base);

            if (merged !== target || node.text === newName) return;

            edits.push({
                file: normalizeBuildPath(sf.fileName),
                start: node.getStart(sf, false),
                end: node.getEnd(),
                newText: newName,
            });
        }

        function visit(node) {
            addEdit(node);
            ts.forEachChild(node, visit);
        }

        visit(sf);
    }

    return edits;
}

/**
 * Renames all references that share the **exact** import-alias symbol (e.g. `FooAlpha` in `import { Foo as FooAlpha }`).
 * Unlike `collectIdentifierRenameEdits`, we compare `sym === bindingSymbol` so we do not rewrite unrelated
 * identifiers that happen to share a merged export target but use different local names in the same file.
 */
function collectIdentifierRenameEditsForBindingSymbol(program, checker, bindingSymbol, newName) {
    const edits = [];

    for (const sf of program.getSourceFiles()) {
        if (sf.isDeclarationFile) continue;

        function addEdit(node) {
            if (!ts.isIdentifier(node)) return;

            const sym = checker.getSymbolAtLocation(node);

            if (!sym || sym !== bindingSymbol || node.text === newName) return;

            edits.push({
                file: normalizeBuildPath(sf.fileName),
                start: node.getStart(sf, false),
                end: node.getEnd(),
                newText: newName,
            });
        }

        function visit(node) {
            addEdit(node);
            ts.forEachChild(node, visit);
        }

        visit(sf);
    }

    return edits;
}

/**
 * After duplicate export renames: imports are still present in `fileContents`, but the final bundle will delete
 * import lines. Every `import { Remote as Local }` must become usages of the **bundle** name (`Remote` or `Remote_2`)
 * so `Local` is not left as an undefined identifier. The duplicate pass only rewrites when `bundleName !== origName`;
 * this pass also covers `Local !== bundleName` when the bundle name equals the original export (e.g. first `Foo`).
 * Only named specifiers are handled (`import * as` / default imports are out of scope for this pass).
 */
function resolveImportAliasesToBundleNames(buildOrder, fileContents, declarations) {
    const paths = buildOrder.map(normalizeBuildPath);
    const program = createProgramWithFileContents(paths, fileContents);
    const checker = program.getTypeChecker();
    const allEdits = [];

    for (const fp of paths) {
        const sf = program.getSourceFile(fp);

        if (!sf || sf.isDeclarationFile) continue;

        function addEdits(node) {
            if (!ts.isImportDeclaration(node) || !node.importClause || !ts.isStringLiteralLike(node.moduleSpecifier)) {
                return;
            }

            const resolved = resolveImport(node.moduleSpecifier.text, path.dirname(sf.fileName));

            if (!resolved) return;

            const exportToBundle = declarations.get(normalizeBuildPath(resolved));

            if (!exportToBundle) return;

            const clause = node.importClause;

            if (!clause.namedBindings || !ts.isNamedImports(clause.namedBindings)) return;

            for (const spec of clause.namedBindings.elements) {
                const exportName = (spec.propertyName ?? spec.name).text;
                const bundleName = exportToBundle.get(exportName);

                if (bundleName === undefined) continue;

                if (spec.name.text === bundleName) continue;

                const bindingSym = checker.getSymbolAtLocation(spec.name);

                if (!bindingSym) continue;

                allEdits.push(
                    ...collectIdentifierRenameEditsForBindingSymbol(program, checker, bindingSym, bundleName)
                );
            }
        }

        function visit(node) {
            addEdits(node);
            ts.forEachChild(node, visit);
        }

        visit(sf);
    }

    const editsByFile = new Map();

    for (const ed of allEdits) {
        const list = editsByFile.get(ed.file) ?? [];
        list.push(ed);
        editsByFile.set(ed.file, list);
    }

    for (const [fileKey, fileEdits] of editsByFile) {
        const original = fileContents.get(fileKey);

        if (original === undefined) continue;

        fileContents.set(fileKey, applyTextEdits(original, fileEdits));
    }
}

/**
 * One span should not receive two different replacement strings (would indicate overlapping rename logic).
 * Identical duplicate edits for the same range are collapsed via `if (prev) continue` after the conflict check.
 */
function dedupeEdits(edits) {
    const byKey = new Map();

    for (const e of edits) {
        const key = `${e.file}\0${e.start}\0${e.end}`;
        const prev = byKey.get(key);

        if (prev && prev.newText !== e.newText) {
            console.warn(
                `⚠️  Conflicting rename edits at ${e.file}:${e.start} (${prev.newText} vs ${e.newText}); keeping first.`
            );
            continue;
        }

        if (prev) continue;

        byKey.set(key, e);
    }

    return [...byKey.values()];
}

/** Apply from highest offset to lowest so earlier edits do not shift later `start`/`end` positions (UTF-16 offsets). */
function applyTextEdits(content, edits) {
    const sorted = dedupeEdits(edits).sort((a, b) => b.start - a.start);

    let out = content;

    for (const e of sorted) {
        out = out.slice(0, e.start) + e.newText + out.slice(e.end);
    }

    return out;
}

/**
 * `mod` is injected by the Portal / QuickJS runtime; this bundler's temporary `Program` does not include
 * `bf6-portal-mod-types` (or any other ambient `mod`). The checker then emits predictable false positives. We drop
 * those so real graph issues are still visible in the warning block below.
 *
 * Uses numeric `code` where stable (TS 5.x) plus message checks so we do not match unrelated text like "module".
 */
function isSuppressedModRuntimeGlobalDiagnostic(diagnostic) {
    const text = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
    const { code } = diagnostic;

    // TS2503: Cannot find namespace 'mod'.
    if (code === 2503 && /Cannot find namespace ['"]mod['"]/.test(text)) return true;

    // TS2694: Namespace 'mod' has no exported member '…'. (empty / stub `declare namespace mod` would do the same.)
    if (code === 2694 && /Namespace ['"]mod['"] has no exported member/.test(text)) return true;

    // TS2304: Cannot find name 'mod'. (value uses where no global `mod` value exists in this Program.)
    if (code === 2304 && /Cannot find name ['"]mod['"]/.test(text)) return true;

    return false;
}

/**
 * Assigns unique bundle names for duplicate exported identifiers across the graph (first occurrence keeps the
 * original name; later ones get `${name}_${k}` for the k-th occurrence). Updates `fileContents` in place using
 * the TypeScript checker so references (including imports) rename correctly without naive substring replacement.
 *
 * @returns {{ declarationCounts: Map<string, number>, declarations: Map<string, Map<string, string>> }}
 */
function handleDuplicateDeclarations(buildOrder, fileContents) {
    const declarationCounts = new Map();
    const declarations = new Map();

    const paths = buildOrder.map(normalizeBuildPath);
    const program = createProgramWithFileContents(paths, fileContents);
    const checker = program.getTypeChecker();
    const diags = ts.getPreEmitDiagnostics(program);
    const errors = diags
        .filter((d) => d.category === ts.DiagnosticCategory.Error)
        .filter((d) => !isSuppressedModRuntimeGlobalDiagnostic(d));

    // Remaining errors (e.g. syntax, broken imports) may still affect rename fidelity — warn with a short sample.
    if (errors.length > 0) {
        console.warn(
            '⚠️  TypeScript reported errors while analyzing modules for duplicate exports; rename accuracy may suffer.'
        );

        for (const d of errors.slice(0, 8)) {
            const msg = ts.flattenDiagnosticMessageText(d.messageText, '\n');
            const where = d.file && d.start !== undefined ? `${d.file.fileName}:${d.start}` : '';
            console.warn(`   ${where} ${msg}`);
        }
    }

    // Assign bundle names in `buildOrder`: first time an export name appears it keeps `name`; k-th file adds `name_k`.
    for (const fp of paths) {
        const sf = program.getSourceFile(fp);

        if (!sf || sf.isDeclarationFile) continue;

        const names = getExportedBindingNames(sf, checker);
        const inner = new Map();

        for (const name of names) {
            const count = (declarationCounts.get(name) ?? 0) + 1;
            declarationCounts.set(name, count);
            const bundleName = count === 1 ? name : `${name}_${count}`;
            inner.set(name, bundleName);
        }

        declarations.set(fp, inner);
    }

    const allEdits = [];

    // Only files that actually renamed an export need AST edits; identity mappings skip (no checker work).
    for (const fp of paths) {
        const sf = program.getSourceFile(fp);

        if (!sf?.symbol?.exports) continue;

        const inner = declarations.get(fp);

        if (!inner) continue;

        for (const [origName, bundleName] of inner) {
            if (origName === bundleName) continue;

            const escaped = ts.escapeLeadingUnderscores(origName);
            const exportSym = sf.symbol.exports.get(escaped);

            if (!exportSym) continue;

            allEdits.push(...collectIdentifierRenameEdits(program, checker, exportSym, bundleName));
        }
    }

    const editsByFile = new Map();

    for (const ed of allEdits) {
        const list = editsByFile.get(ed.file) ?? [];
        list.push(ed);
        editsByFile.set(ed.file, list);
    }

    for (const [fileKey, fileEdits] of editsByFile) {
        const original = fileContents.get(fileKey);

        if (original === undefined) continue;

        fileContents.set(fileKey, applyTextEdits(original, fileEdits));
    }

    return { declarationCounts, declarations };
}

// Process strings.json files
function processStrings() {
    console.log('📝 Processing strings.json files...');

    const mergedStrings = {};

    // We only want to process each strings.json file once, even if multiple TS files share a folder
    const processedJsonFiles = new Set();

    // 1. Identify all directories involved in the build
    const directories = new Set(buildOrder.map((f) => path.dirname(f)));

    for (const dir of directories) {
        // 2. Find any sibling files ending in "strings.json"
        const files = fs.readdirSync(dir).filter((f) => f.endsWith('strings.json'));

        for (const jsonFilename of files) {
            const jsonPath = path.join(dir, jsonFilename);

            if (processedJsonFiles.has(jsonPath)) continue;

            processedJsonFiles.add(jsonPath);

            console.log(`   Found: ${path.relative(PROJECT_ROOT, jsonPath)}`);

            try {
                const fileContent = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));

                // 3. Merge and check conflicts (`hasOwnProperty` ignores inherited keys on the plain object map).
                for (const key of Object.keys(fileContent)) {
                    if (Object.prototype.hasOwnProperty.call(mergedStrings, key)) {
                        console.error(`\n❌ ERROR: Duplicate JSON Key Detected!`);
                        console.error(`   Key: "${key}"`);
                        console.error(`   Conflict source: ${path.relative(PROJECT_ROOT, jsonPath)}`);
                        console.error(`   (This key was already defined in a previous file)`);
                        process.exit(1); // Stop the build
                    }

                    mergedStrings[key] = fileContent[key];
                }
            } catch (err) {
                console.error(`❌ ERROR: Failed to parse JSON: ${jsonPath}`);
                throw err;
            }
        }
    }

    return mergedStrings;
}

// Main Build Function
async function build() {
    console.log(`BF Portal Bundler v${BUNDLER_VERSION}`);
    console.log('🚀 Starting Dependency Graph Build...');

    if (!fs.existsSync(ENTRY_FILE)) {
        console.error(`Error: Entry file not found at ${ENTRY_FILE}`);
        process.exit(1);
    }

    visited.clear();
    buildOrder.length = 0;

    walk(ENTRY_FILE); // Walk the graph

    console.log(`🔍 Found ${buildOrder.length} files in dependency tree.`);

    const fileContents = new Map();

    for (const fp of buildOrder) {
        const key = normalizeBuildPath(fp);
        fileContents.set(key, fs.readFileSync(fp, 'utf8'));
    }

    const { declarationCounts, declarations } = handleDuplicateDeclarations(buildOrder, fileContents);

    // Must run after duplicate renames so `declarations` maps export keys to final bundle identifiers (`Foo_2`, …).
    resolveImportAliasesToBundleNames(buildOrder, fileContents, declarations);

    const duplicateExportNames = [...declarationCounts.entries()].filter(([, c]) => c > 1);

    if (duplicateExportNames.length > 0) {
        console.log('🔀 Resolved duplicate top-level export names (2nd+ occurrences suffixed as name_2, name_3, …):');

        for (const [name, c] of duplicateExportNames) {
            console.log(`   "${name}" in ${c} file(s)`);
        }
    }

    // Process Strings
    const finalStrings = processStrings();

    fs.mkdirSync(path.dirname(OUTPUT_STRINGS_FILE), { recursive: true });
    fs.writeFileSync(OUTPUT_STRINGS_FILE, JSON.stringify(finalStrings, null, 4));

    // Concatenate in `buildOrder` so definitions appear before dependents (already guaranteed by `walk`).
    let finalOutput = ['// --- BUNDLED TYPESCRIPT OUTPUT ---', '// @ts-nocheck', ''];

    for (const filePath of buildOrder) {
        const contentKey = normalizeBuildPath(filePath);
        // Prefer in-memory transforms; fallback to disk only if a key were missing (should not happen).
        let content = fileContents.get(contentKey) ?? fs.readFileSync(filePath, 'utf8');

        // Output-stage strip (can differ from walk-time strip): keeps comments in source files for TS rename passes.
        if (REMOVE_COMMENTS_OUTPUT || MINIFY_OUTPUT) {
            content = stripComments(content, { language: 'ts' });
        }

        // Strip module wiring — order matters: (1) must run before (2) so `import { x } from "y"` is not half-removed.
        // Non-`from` exports (`export class`, `export const`, …) stay; only re-exports with `from` match (4).

        // 1. import … / export … from "path"
        content = content.replace(/import\s[\s\S]*?from\s*['"].*?['"];?/g, '');

        // 2. import "path" side effects (no `from` — not matched by (1)).
        content = content.replace(/import\s*['"].*?['"];?/g, '');

        // 3. import x = require("…")
        content = content.replace(/import\s[\s\S]*?=\s*require\([\s\S]*?\);?/g, '');

        // 4. export … from "path" (re-exports only)
        content = content.replace(/export\s[\s\S]*?from\s*['"].*?['"];?/g, '');

        finalOutput.push(`// --- SOURCE: ${path.relative(PROJECT_ROOT, filePath)} ---`);
        finalOutput.push(content);
        finalOutput.push('');
    }

    finalOutput = finalOutput.join('\n');

    if (MINIFY_OUTPUT) {
        const prettier = require('prettier');
        finalOutput = removeBlankLines(await prettier.format(finalOutput, PRETTIER_CONFIG));
    }

    fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
    fs.writeFileSync(OUTPUT_FILE, finalOutput);

    console.log(`\n✅ Build Complete!`);
    console.log(`   Code:    ${path.relative(PROJECT_ROOT, OUTPUT_FILE)}`);
    console.log(
        `   Strings: ${path.relative(PROJECT_ROOT, OUTPUT_STRINGS_FILE)} (${Object.keys(finalStrings).length} keys merged)`
    );
}

// `build` is async only for Prettier 3; the shell still waits for this process to exit before chaining (`&&`).
build().catch((err) => {
    console.error(err);
    process.exit(1);
});
