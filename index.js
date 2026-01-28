#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const stripComments = require('strip-comments');
const prettier = require('@prettier/sync');
const removeBlankLines = require('remove-blank-lines');

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
    objectWrap: 'preserve',
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
    let minify = false;

    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--entrypoint' && i + 1 < args.length) {
            entrypoint = args[++i];
        } else if (args[i] === '--outDir' && i + 1 < args.length) {
            outDir = args[++i];
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

    // Base directory for resolving node_modules (user's project root, typically where package.json is)
    // We'll use the directory containing the entrypoint as a fallback, but prefer cwd
    const PROJECT_ROOT = cwd;
    const MINIFY_OUTPUT = minify;

    return { ENTRY_FILE, OUTPUT_FILE, OUTPUT_STRINGS_FILE, PROJECT_ROOT, MINIFY_OUTPUT };
}

const { ENTRY_FILE, OUTPUT_FILE, OUTPUT_STRINGS_FILE, PROJECT_ROOT, MINIFY_OUTPUT } = parseArgs();

// Track processed files to avoid cycles and duplication
const visited = new Set();

// The final ordered list of files to concatenate
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
        const appended = targetPath + ext;

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

    // Regex to find imports:
    // We need to capture the path from 3 different styles of dependency declarations.
    const patterns = [
        // 1. Standard Imports/Exports (e.g., import { X } from "y"; export { X } from "y"; export * from "y")
        //    Note: We enforce 'from' here to avoid matching "export class X..."
        /(?:import|export)\s+[\s\S]*?from\s*['"](.*?)['"]/g,

        // 2. Side-effect Imports (e.g., import "polyfills";)
        //    Note: Must start with import, no 'from'
        /import\s+['"](.*?)['"]/g,

        // 3. Import Require (e.g., import X = require("y"))
        /import\s+[\s\S]*?=\s*require\(['"](.*?)['"]\)/g,
    ];

    for (const regex of patterns) {
        let match;

        regex.lastIndex = 0; // Reset regex state just in case

        while ((match = regex.exec(cleanContent)) !== null) {
            const importPath = match[1]; // The path is always in the first capture group now

            if (!importPath) continue;

            const absolutePath = resolveImport(importPath, path.dirname(filePath));

            if (!absolutePath || absolutePath.endsWith('.d.ts')) continue;

            // If it's a valid local/node file (not external), walk it FIRST
            walk(absolutePath);
        }
    }

    // Post-order traversal: Add to list AFTER processing children.
    // This ensures dependencies are listed before the files that import them.
    buildOrder.push(filePath);
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

                // 3. Merge and Check for Conflicts
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
function build() {
    console.log('🚀 Starting Dependency Graph Build...');

    if (!fs.existsSync(ENTRY_FILE)) {
        console.error(`Error: Entry file not found at ${ENTRY_FILE}`);
        process.exit(1);
    }

    walk(ENTRY_FILE); // Walk the graph

    console.log(`🔍 Found ${buildOrder.length} files in dependency tree.`);

    // Process Strings
    const finalStrings = processStrings();
    fs.mkdirSync(path.dirname(OUTPUT_STRINGS_FILE), { recursive: true });
    fs.writeFileSync(OUTPUT_STRINGS_FILE, JSON.stringify(finalStrings, null, 4));

    // Concatenate Content
    let finalOutput = ['// --- BUNDLED TYPESCRIPT OUTPUT ---', '// @ts-nocheck', ''];

    for (const filePath of buildOrder) {
        let content = fs.readFileSync(filePath, 'utf8');

        if (MINIFY_OUTPUT) {
            content = stripComments(content, { language: 'ts' });
        }

        // --- CLEANUP REGEXES (The Fix) ---

        // 1. Remove standard imports (Single & Multi-line)
        // matches: import { ... } from "..."
        content = content.replace(/import\s[\s\S]*?from\s*['"].*?['"];?/g, '');

        // 2. Remove side-effect imports
        // matches: import "polyfills";
        content = content.replace(/import\s*['"].*?['"];?/g, '');

        // 3. Remove TS require imports (Single & Multi-line)
        // matches: import X = require("...");
        content = content.replace(/import\s[\s\S]*?=\s*require\([\s\S]*?\);?/g, '');

        // 4. Remove re-exports (Single & Multi-line)
        // matches: export * from "..."
        content = content.replace(/export\s[\s\S]*?from\s*['"].*?['"];?/g, '');

        finalOutput.push(`// --- SOURCE: ${path.relative(PROJECT_ROOT, filePath)} ---`);
        finalOutput.push(content);
        finalOutput.push('');
    }

    finalOutput = finalOutput.join('\n');

    if (MINIFY_OUTPUT) {
        finalOutput = removeBlankLines(prettier.format(finalOutput, PRETTIER_CONFIG));
    }

    fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
    fs.writeFileSync(OUTPUT_FILE, finalOutput);

    console.log(`\n✅ Build Complete!`);
    console.log(`   Code:    ${path.relative(PROJECT_ROOT, OUTPUT_FILE)}`);
    console.log(
        `   Strings: ${path.relative(PROJECT_ROOT, OUTPUT_STRINGS_FILE)} (${Object.keys(finalStrings).length} keys merged)`
    );
}

build();
