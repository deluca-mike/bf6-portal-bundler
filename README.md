# bf6-portal-bundler

A specialized bundler for Battlefield 6 Portal mods that combines TypeScript files and string resources into a single bundle compatible with the Portal runtime environment.

## Overview

Battlefield 6 Portal requires mods to be uploaded as:

- **A single TypeScript file** (i.e. `bundle.ts`)
- **A single strings JSON file** (i.e. `bundle.strings.json`)

The Portal runtime does **not** support:

- External npm dependencies (except the `mod` namespace injected at runtime)
- Multiple file imports
- Module resolution at runtime

This tool solves this limitation by:

1. Walking the entire dependency graph from your entrypoint
2. Resolving both local imports and `node_modules` dependencies
3. Flattening everything into a single TypeScript file
4. Merging all `strings.json` files into one
5. Removing all import statements (since everything is inlined)

## Installation

### Local Installation (Recommended)

Install as a dev dependency in your project:

```bash
npm install -D bf6-portal-bundler
```

This allows you to use it in npm scripts and ensures all team members have the same version.

### Global Installation

Install globally to use the `bf6-portal-bundler` command from any directory:

```bash
npm install -g bf6-portal-bundler
```

After global installation, you can run the bundler from any project without adding it as a dependency.

## Usage

### Command Line

```bash
bf6-portal-bundler --entrypoint <path> --outDir <path>
```

**Arguments:**

- `--entrypoint`: Path to your main TypeScript entry file (e.g., `./src/index.ts`)
- `--outDir`: Output directory where `bundle.ts` and `bundle.strings.json` will be written

**Example:**

```bash
bf6-portal-bundler --entrypoint ./src/index.ts --outDir ./dist
```

This will generate:

- `./dist/bundle.ts` - The flattened TypeScript bundle
- `./dist/bundle.strings.json` - The merged strings file

### NPM Scripts

Add to your `package.json`:

```json
{
    "scripts": {
        "build": "bf6-portal-bundler --entrypoint ./src/index.ts --outDir ./dist"
    }
}
```

Then run:

```bash
npm run build
```

## How It Works

### 1. Dependency Graph Traversal

The bundler performs a **post-order depth-first traversal** of your dependency graph:

1. Starts from your entrypoint file
2. Recursively follows all `import` statements
3. Resolves both relative imports (`./file`) and node module imports (`@community/pathfinder`)
4. Visits each dependency **before** the file that imports it
5. Builds an ordered list ensuring dependencies come first

**Example:**

```
src/index.ts
  └─ imports → src/utils/helper.ts
      └─ imports → node_modules/@community/pathfinder/index.ts
```

**Output order:**

1. `node_modules/@community/pathfinder/index.ts` (dependency)
2. `src/utils/helper.ts` (depends on pathfinder)
3. `src/index.ts` (depends on helper)

### 2. Import Resolution

The bundler resolves imports in this order:

**Relative Imports** (`.`, `..`):

- Resolved relative to the current file's directory
- Supports extensions: `.ts`, `/index.ts`, `.d.ts`

**Node Module Imports**:

- Resolved from `node_modules/<package-name>`
- Looks for: `<package-name>.ts`, `<package-name>/index.ts`, `<package-name>.d.ts`
- Uses your project's `node_modules` directory (not the bundler's)

**External Modules**:

- The `mod` namespace is **ignored** (provided by Portal runtime)
- These imports are left as-is in the final bundle

### 3. Code Transformation

For each file in the dependency graph:

1. **Removes all import statements:**
    - `import { ... } from "..."`
    - `import "side-effect"`
    - `import X = require("...")`
    - `export * from "..."`

2. **Preserves all other code:**
    - Type definitions
    - Classes, functions, variables
    - Exports
    - Comments

3. **Adds source comments:**
    - Each file section is marked with `// --- SOURCE: <relative-path> ---`

### 4. Strings Merging

The bundler automatically finds and merges all `strings.json` files:

1. **Discovery**: Scans all directories containing TypeScript files in the bundle
2. **Collection**: Finds all files ending with `strings.json` in those directories
3. **Validation**: Checks for duplicate keys (build fails if found)
4. **Merging**: Combines all strings into a single JSON object

**Example:**

```
src/
  ├─ index.ts
  └─ strings.json          → { "someKey": "someValue" }
src/utils/
  ├─ helper.ts
  └─ strings.json          → { "helper": { "key1": "value1", "key2": "value2" } }
node_modules/@community/pathfinder/
  ├─ index.ts
  └─ strings.json          → { "pathfinder": { "alpha": "This is Alpha", "beta": "This is Beta" } }
```

**Output:**

```json
{
    "someKey": "someValue",
    "helper": {
        "key1": "value1",
        "key2": "value2"
    },
    "pathfinder": {
        "alpha": "This is Alpha",
        "beta": "This is Beta"
    }
}
```

## Features

### ✅ Supported Import Types

- Standard ES6 imports: `import { foo } from './bar'`
- Default imports: `import foo from './bar'`
- Namespace imports: `import * as foo from './bar'`
- Side-effect imports: `import './polyfills'`
- TypeScript require: `import foo = require('./bar')`
- Re-exports: `export * from './bar'`

### ✅ Node Modules Support

You can use npm packages in your mod! The bundler will:

- Resolve packages from `node_modules`
- Bundle their TypeScript source files
- Include their `strings.json` files

**Note**: Only packages with TypeScript source files (`.ts`) can be bundled. Compiled JavaScript packages won't work.

### ✅ Duplicate Detection

- **Strings**: Build fails if duplicate keys are found in `strings.json` files
- **Files**: Circular dependencies are handled (files are only processed once)

### ✅ Error Handling

- Clear error messages for missing files
- Warnings for unresolved imports
- Validation of JSON files

## Output Format

### bundle.ts

```typescript
// --- BUNDLED TYPESCRIPT OUTPUT ---
// @ts-nocheck

// --- SOURCE: node_modules/@community/pathfinder/index.ts ---
// [pathfinder code here]

// --- SOURCE: src/utils/helper.ts ---
// [helper code here]

// --- SOURCE: src/index.ts ---
// [main code here]
```

### bundle.strings.json

```json
{
    "someKey": "someValue",
    "helper": {
        "key1": "value1",
        "key2": "value2"
    },
    "pathfinder": {
        "alpha": "This is Alpha",
        "beta": "This is Beta"
    }
}
```

## Project Structure Example

```
my-mod/
├── package.json
├── src/
│   ├── index.ts              # Entrypoint
│   ├── strings.json
│   ├── utils/
│   │   ├── helper.ts
│   │   └── strings.json
│   └── components/
│       └── widget.ts
├── node_modules/
│   └── @community/
│       └── pathfinder/
│           ├── index.ts
│           └── strings.json
└── dist/                      # Generated by bundler
    ├── bundle.ts
    └── bundle.strings.json
```

## Limitations

1. **TypeScript Only**: The bundler only processes `.ts` files. JavaScript files in `node_modules` won't be included.

2. **No Dynamic Imports**: Dynamic imports (`import()`) are not supported.

3. **External Modules**: Only the `mod` namespace is recognized as external. All other imports must be resolvable.

4. **Circular Dependencies**: While handled gracefully, complex circular dependencies may cause unexpected ordering.

## Troubleshooting

### "Could not resolve import"

- Check that the import path is correct
- For node modules, ensure the package has TypeScript source files
- Verify the package is installed in `node_modules`

### "Duplicate JSON Key Detected"

Two `strings.json` files contain the same key (at the same level). Rename one of the keys to resolve the conflict.

## License

MIT
