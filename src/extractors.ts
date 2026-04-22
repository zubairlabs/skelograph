import { extname, posix } from "node:path";
import type {
  EntryPoint,
  EntryPointKind,
  FileRecord,
  SkelImport,
  SkelSymbol,
  SymbolKind,
  Visibility,
  WorkspaceInfo,
} from "./types.js";
import { toPosixPath } from "./ignore.js";
import {
  detectRustEntryPoints,
  extractRustFileDoc,
  extractRustImports,
  extractRustSymbols,
  isRust,
} from "./rust_extractors.js";

const JS_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);

interface SymbolPattern {
  regex: RegExp;
  kind: SymbolKind;
  nameGroup: number;
  visibilityHint?: Visibility;
}

const SYMBOL_PATTERNS: SymbolPattern[] = [
  {
    regex: /^\s*(export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*[(<]/,
    kind: "function",
    nameGroup: 2,
  },
  {
    regex: /^\s*(export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)\b/,
    kind: "class",
    nameGroup: 2,
  },
  {
    regex: /^\s*(export\s+)?interface\s+([A-Za-z_$][\w$]*)\b/,
    kind: "interface",
    nameGroup: 2,
  },
  {
    regex: /^\s*(export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/,
    kind: "type",
    nameGroup: 2,
  },
  {
    regex: /^\s*(export\s+)?enum\s+([A-Za-z_$][\w$]*)\b/,
    kind: "enum",
    nameGroup: 2,
  },
  {
    regex: /^\s*(export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/,
    kind: "function",
    nameGroup: 2,
  },
  {
    regex: /^\s*(export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\b/,
    kind: "const",
    nameGroup: 2,
  },
];

const DEFAULT_EXPORT_PATTERNS: Array<{ regex: RegExp; kind: SymbolKind }> = [
  { regex: /^\s*export\s+default\s+function\s+([A-Za-z_$][\w$]*)?/, kind: "function" },
  { regex: /^\s*export\s+default\s+class\s+([A-Za-z_$][\w$]*)?/, kind: "class" },
  { regex: /^\s*export\s+default\s+\{/, kind: "default" },
];

export function isJavaScriptLike(file: FileRecord): boolean {
  return JS_EXTENSIONS.has(file.extension);
}

export function extractFileDoc(file: FileRecord): string | undefined {
  if (isRust(file)) return extractRustFileDoc(file);
  if (!isJavaScriptLike(file) && file.extension !== ".svelte") return undefined;
  const content = file.content.trimStart();

  const jsdoc = /^\/\*\*([\s\S]*?)\*\//.exec(content);
  if (jsdoc) {
    return extractFirstSentence(cleanJsDocBody(jsdoc[1]));
  }

  const lineComments = content.split(/\r?\n/).slice(0, 10);
  const acc: string[] = [];
  for (const line of lineComments) {
    const match = /^\s*\/\/\s?(.*)$/.exec(line);
    if (!match) break;
    acc.push(match[1]);
  }
  if (acc.length > 0) return extractFirstSentence(acc.join(" "));
  return undefined;
}

export function extractSymbols(file: FileRecord): SkelSymbol[] {
  if (isRust(file)) return extractRustSymbols(file);
  if (!isJavaScriptLike(file) && file.extension !== ".svelte") return [];

  const content = file.extension === ".svelte" ? extractSvelteScript(file.content) : file.content;
  const lines = content.split(/\r?\n/);
  const symbols: SkelSymbol[] = [];
  const seen = new Set<string>();

  // Track enclosing class via brace-depth.
  const classStack: Array<{ name: string; depth: number; exported: boolean }> = [];
  let braceDepth = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    let matched = false;

    const classMatch = /^\s*(export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)\b/.exec(line);

    for (const pattern of SYMBOL_PATTERNS) {
      const match = pattern.regex.exec(line);
      if (!match) continue;
      const rawName = match[pattern.nameGroup];
      if (!rawName) continue;
      const isExported = Boolean(match[1]);
      const enclosingClass = classStack[classStack.length - 1];
      const qualifiedName = enclosingClass && pattern.kind === "function"
        ? `${enclosingClass.name}.${rawName}`
        : rawName;
      const visibility = enclosingClass
        ? (enclosingClass.exported ? "public" : "private")
        : (isExported ? "public" : "private");
      const key = `${pattern.kind}:${qualifiedName}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const doc = findDocCommentAbove(lines, index);
      symbols.push({
        name: qualifiedName,
        kind: pattern.kind,
        line: index + 1,
        visibility,
        doc,
      });
      matched = true;
      break;
    }

    // Class method without the pattern-matched shape above (e.g., `async name(args) { ... }` inside a class body).
    if (!matched && classStack.length > 0) {
      const methodMatch = /^\s*(?:public\s+|private\s+|protected\s+|static\s+|readonly\s+|async\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(/.exec(line);
      if (methodMatch && !/^(if|for|while|switch|return|throw|new|typeof|await|yield)$/.test(methodMatch[1]) && !line.includes("=>")) {
        const enclosingClass = classStack[classStack.length - 1];
        const name = methodMatch[1];
        if (name !== "constructor" || enclosingClass.exported) {
          const qualifiedName = `${enclosingClass.name}.${name}`;
          const key = `function:${qualifiedName}`;
          const visibility = /^\s*private\b/.test(line) ? "private" : (enclosingClass.exported ? "public" : "private");
          if (!seen.has(key)) {
            seen.add(key);
            const doc = findDocCommentAbove(lines, index);
            symbols.push({
              name: qualifiedName,
              kind: "function",
              line: index + 1,
              visibility,
              doc,
            });
          }
        }
      }
    }

    if (!matched) {
      for (const pattern of DEFAULT_EXPORT_PATTERNS) {
        const match = pattern.regex.exec(line);
        if (!match) continue;
        const name = match[1] ?? "default";
        const key = `${pattern.kind}:${name}:default`;
        if (seen.has(key)) continue;
        seen.add(key);
        const doc = findDocCommentAbove(lines, index);
        symbols.push({
          name,
          kind: pattern.kind,
          line: index + 1,
          visibility: "public",
          doc,
          isDefault: true,
        });
        break;
      }
    }

    if (classMatch && line.includes("{")) {
      classStack.push({
        name: classMatch[2],
        depth: braceDepth,
        exported: Boolean(classMatch[1]),
      });
    }

    // Track braces for scope tracking.
    let inString: '"' | "'" | "`" | undefined;
    for (let k = 0; k < line.length; k += 1) {
      const ch = line[k];
      if (inString) {
        if (ch === "\\") {
          k += 1;
          continue;
        }
        if (ch === inString) inString = undefined;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") {
        inString = ch as '"' | "'" | "`";
        continue;
      }
      if (ch === "{") braceDepth += 1;
      else if (ch === "}") {
        braceDepth -= 1;
        while (classStack.length > 0 && classStack[classStack.length - 1].depth >= braceDepth) {
          classStack.pop();
        }
      }
    }
  }

  return symbols;
}

export function extractImports(file: FileRecord, allFiles: FileRecord[], workspace?: WorkspaceInfo): SkelImport[] {
  if (isRust(file)) {
    if (!workspace) return [];
    const allRelative = new Set(allFiles.map((f) => f.relativePath));
    return extractRustImports(file, workspace, allRelative);
  }
  if (!isJavaScriptLike(file) && file.extension !== ".svelte") return [];

  const content = file.extension === ".svelte" ? extractSvelteScript(file.content) : file.content;
  const lines = content.split(/\r?\n/);
  const imports: SkelImport[] = [];
  const allRelatives = new Set(allFiles.map((candidate) => candidate.relativePath));

  const patterns = [
    /\bimport\s+(?:[^'"]+?\s+from\s+)?["']([^"']+)["']/,
    /\bexport\s+[^'"]+?\s+from\s+["']([^"']+)["']/,
    /\brequire\(\s*["']([^"']+)["']\s*\)/,
  ];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    for (const pattern of patterns) {
      const match = pattern.exec(line);
      if (match?.[1]) {
        imports.push({
          specifier: match[1],
          line: index + 1,
          resolvedRelativePath: resolveRelativeImport(file, match[1], allRelatives),
        });
      }
    }
  }

  return imports;
}

export function detectEntryPoints(
  files: FileRecord[],
  packageBins: Map<string, Record<string, string>>,
  workspace?: WorkspaceInfo,
): EntryPoint[] {
  const entries: EntryPoint[] = [];

  for (const file of files) {
    if (isRust(file)) continue; // handled below

    entries.push(...detectSvelteKitEntries(file));
    entries.push(...detectNextEntries(file));

    const express = detectExpressEntry(file);
    if (express) entries.push(express);

    const fastify = detectFastifyEntry(file);
    if (fastify) entries.push(fastify);

    const ws = detectWebSocketEntry(file);
    if (ws) entries.push(ws);

    const queue = detectQueueEntry(file);
    if (queue) entries.push(queue);
  }

  if (workspace) {
    entries.push(...detectRustEntryPoints(files, workspace));
  }

  const hasRustBins = entries.some((e) => e.kind === "rust-bin");
  for (const [pkgName, bins] of packageBins) {
    for (const [binName, binPath] of Object.entries(bins)) {
      if (hasRustBins) continue; // Rust bins already emitted
      entries.push({
        id: `bin:${pkgName}:${binName}`,
        kind: "cli-bin",
        filePath: toPosixPath(binPath),
        packageName: pkgName,
        label: `${binName} (bin)`,
      });
    }
  }

  return entries;
}

const JS_METHOD_NOISE = new Set([
  "push",
  "pop",
  "shift",
  "unshift",
  "map",
  "filter",
  "reduce",
  "forEach",
  "find",
  "some",
  "every",
  "includes",
  "indexOf",
  "slice",
  "splice",
  "join",
  "split",
  "trim",
  "toLowerCase",
  "toUpperCase",
  "toString",
  "valueOf",
  "then",
  "catch",
  "finally",
  "json",
  "text",
  "status",
  "log",
  "warn",
  "error",
  "debug",
  "info",
]);

export function extractJsCalls(body: string): string[] {
  const calls = new Set<string>();
  // Bare calls: `foo(`
  const bare = /(?:^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = bare.exec(body)) !== null) {
    const name = match[1];
    if (JS_KEYWORDS.has(name)) continue;
    calls.add(name);
  }
  // Method calls: `.method(`
  const method = /\.([A-Za-z_$][\w$]*)\s*\(/g;
  while ((match = method.exec(body)) !== null) {
    if (JS_METHOD_NOISE.has(match[1])) continue;
    if (match[1].length < 4) continue;
    calls.add(match[1]);
  }
  return [...calls].filter((n) => !JS_METHOD_NOISE.has(n) && n.length >= 4);
}

const JS_KEYWORDS = new Set([
  "if",
  "else",
  "for",
  "while",
  "do",
  "switch",
  "case",
  "return",
  "throw",
  "new",
  "typeof",
  "instanceof",
  "in",
  "of",
  "const",
  "let",
  "var",
  "function",
  "class",
  "async",
  "await",
  "try",
  "catch",
  "finally",
  "export",
  "import",
  "from",
  "as",
  "default",
  "void",
  "yield",
  "this",
  "super",
  "true",
  "false",
  "null",
  "undefined",
  "Response",
  "Request",
  "Error",
  "Promise",
  "Array",
  "Object",
  "String",
  "Number",
  "Boolean",
  "Date",
  "JSON",
  "Set",
  "Map",
]);

export interface FetchCall {
  urlPattern: string;
  method?: string;
  line: number;
  filePath: string;
}

export function extractFetchCalls(file: FileRecord): FetchCall[] {
  if (!isJavaScriptLike(file) && file.extension !== ".svelte") return [];
  const source = file.extension === ".svelte" ? extractSvelteScript(file.content) : file.content;
  const lines = source.split(/\r?\n/);
  const calls: FetchCall[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    // Matches: fetch('/api/...'), await fetch(`/api/...`), fetch("/api/...")
    const fetchRegex = /\bfetch\s*\(\s*(?:(['"])(\/api\/[^'"]*)\1|`(\/api\/[^`${}]*)`)/g;
    let match: RegExpExecArray | null;
    while ((match = fetchRegex.exec(line)) !== null) {
      const url = match[2] ?? match[3];
      if (!url) continue;
      const method = findFetchMethod(lines, i);
      calls.push({ urlPattern: url, method, line: i + 1, filePath: file.relativePath });
    }
  }

  return calls;
}

function findFetchMethod(lines: string[], fetchLineIndex: number): string | undefined {
  // Look ahead up to 10 lines for `method: 'POST'`, `method: "DELETE"`, etc.
  const span = lines.slice(fetchLineIndex, Math.min(fetchLineIndex + 10, lines.length)).join(" ");
  const match = /method\s*:\s*['"`](GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)['"`]/.exec(span);
  return match?.[1];
}

export function findJsSymbolDefinition(
  symbol: string,
  hintPackage: string | undefined,
  allFiles: FileRecord[],
  options: { skipFile?: string } = {},
): { filePath: string; line: number; qualified?: string } | undefined {
  const skipFile = options.skipFile;
  const passes: Array<(f: FileRecord) => boolean> = [
    (f) => Boolean(hintPackage) && f.packageName === hintPackage,
    () => true,
  ];
  const patterns = [
    new RegExp(`^\\s*export\\s+(?:async\\s+)?function\\s+${symbol}\\b`),
    new RegExp(`^\\s*export\\s+(?:async\\s+)?const\\s+${symbol}\\b`),
    new RegExp(`^\\s*export\\s+class\\s+${symbol}\\b`),
    new RegExp(`^\\s*(?:async\\s+)?function\\s+${symbol}\\b`),
    new RegExp(`^\\s*class\\s+${symbol}\\b`),
  ];
  for (const accept of passes) {
    for (const file of allFiles) {
      if (!isJavaScriptLike(file) && file.extension !== ".svelte") continue;
      if (!accept(file)) continue;
      if (skipFile && file.relativePath === skipFile) continue;
      const content = file.extension === ".svelte" ? extractSvelteScript(file.content) : file.content;
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i += 1) {
        if (patterns.some((p) => p.test(lines[i] ?? ""))) {
          return { filePath: file.relativePath, line: i + 1 };
        }
      }
    }
  }
  return undefined;
}

function detectSvelteKitEntries(file: FileRecord): EntryPoint[] {
  const rel = file.relativePath;
  if (/(^|\/)hooks\.server\.(ts|js)$/.test(rel)) {
    return [{
      id: `ep:${rel}`,
      kind: "sveltekit-hooks",
      filePath: rel,
      packageName: file.packageName,
      label: "SvelteKit server hooks",
    }];
  }
  if (/(^|\/)\+server\.(ts|js)$/.test(rel)) {
    const route = sveltekitRoute(rel);
    const methods = allHttpMethodExports(file.content);
    if (methods.length === 0) {
      return [{
        id: `ep:${rel}`,
        kind: "sveltekit-server",
        filePath: rel,
        packageName: file.packageName,
        label: `SvelteKit +server ${route}`,
        routePath: route,
      }];
    }
    return methods.map((method) => ({
      id: `ep:${rel}:${method}`,
      kind: "sveltekit-server" as const,
      filePath: rel,
      packageName: file.packageName,
      label: `SvelteKit +server ${method} ${route}`,
      routePath: route,
      httpMethod: method,
    }));
  }
  if (/(^|\/)\+page\.server\.(ts|js)$/.test(rel)) {
    const route = sveltekitRoute(rel);
    const entries: EntryPoint[] = [{
      id: `ep:${rel}`,
      kind: "sveltekit-page-server",
      filePath: rel,
      packageName: file.packageName,
      label: `SvelteKit +page.server ${route}`,
      routePath: route,
    }];
    for (const action of extractFormActionNames(file.content)) {
      entries.push({
        id: `ep:${rel}:action:${action}`,
        kind: "sveltekit-form-action",
        filePath: rel,
        packageName: file.packageName,
        label: `Form action ${action === "default" ? "(default)" : action} ${route}`,
        routePath: route,
        httpMethod: "POST",
      });
    }
    return entries;
  }
  if (/(^|\/)\+layout\.server\.(ts|js)$/.test(rel)) {
    const route = sveltekitRoute(rel) || "/";
    return [{
      id: `ep:${rel}`,
      kind: "sveltekit-page-server",
      filePath: rel,
      packageName: file.packageName,
      label: `SvelteKit +layout.server ${route}`,
      routePath: route,
    }];
  }
  if (/(^|\/)\+page\.svelte$/.test(rel)) {
    const route = sveltekitPageRoute(rel);
    return [{
      id: `ep:${rel}`,
      kind: "sveltekit-page",
      filePath: rel,
      packageName: file.packageName,
      label: `SvelteKit page ${route}`,
      routePath: route,
    }];
  }
  return [];
}

function extractFormActionNames(content: string): string[] {
  const names = new Set<string>();
  // Look for: export const actions: Actions = { default: ..., foo: ..., bar: async () => ... }
  const blockMatch = /export\s+const\s+actions\s*(?::\s*[A-Za-z_$][\w$]*\s*)?=\s*(\{[\s\S]*?\n\}\s*;?)/.exec(content);
  if (!blockMatch) return [];
  const body = blockMatch[1];
  const keyRegex = /(?:^|,|\{)\s*([A-Za-z_$][\w$-]*)\s*:\s*(?:async\s*)?(?:function|\()/g;
  let match: RegExpExecArray | null;
  while ((match = keyRegex.exec(body)) !== null) {
    names.add(match[1]);
  }
  return [...names];
}

function detectNextEntries(file: FileRecord): EntryPoint[] {
  const rel = file.relativePath;
  if (/(^|\/)app\/.+\/route\.(ts|js)$/.test(rel)) {
    const route = nextRoute(rel);
    const methods = allHttpMethodExports(file.content);
    if (methods.length === 0) {
      return [{
        id: `ep:${rel}`,
        kind: "next-route",
        filePath: rel,
        packageName: file.packageName,
        label: `Next route ${route}`,
        routePath: route,
      }];
    }
    return methods.map((method) => ({
      id: `ep:${rel}:${method}`,
      kind: "next-route" as const,
      filePath: rel,
      packageName: file.packageName,
      label: `Next route ${method} ${route}`,
      routePath: route,
      httpMethod: method,
    }));
  }
  if (/(^|\/)pages\/api\/.+\.(ts|js)$/.test(rel)) {
    return [{
      id: `ep:${rel}`,
      kind: "next-route",
      filePath: rel,
      packageName: file.packageName,
      label: `Next API ${rel}`,
    }];
  }
  if (/(^|\/)middleware\.(ts|js)$/.test(rel) && /\bNextRequest\b/.test(file.content)) {
    return [{
      id: `ep:${rel}`,
      kind: "next-middleware",
      filePath: rel,
      packageName: file.packageName,
      label: "Next middleware",
    }];
  }
  return [];
}

function detectExpressEntry(file: FileRecord): EntryPoint | undefined {
  if (!isJavaScriptLike(file)) return undefined;
  if (/\b(?:express|createServer)\s*\(\s*\)/.test(file.content) && /\b(?:app|server)\.listen\s*\(/.test(file.content)) {
    return {
      id: `ep:${file.relativePath}`,
      kind: "express-app",
      filePath: file.relativePath,
      packageName: file.packageName,
      label: `Express app ${file.relativePath}`,
    };
  }
  return undefined;
}

function detectFastifyEntry(file: FileRecord): EntryPoint | undefined {
  if (!isJavaScriptLike(file)) return undefined;
  if (/\bFastify\s*\(|\bfastify\s*\(\s*\)/.test(file.content) && /\.listen\s*\(/.test(file.content)) {
    return {
      id: `ep:${file.relativePath}`,
      kind: "fastify-app",
      filePath: file.relativePath,
      packageName: file.packageName,
      label: `Fastify app ${file.relativePath}`,
    };
  }
  return undefined;
}

function detectWebSocketEntry(file: FileRecord): EntryPoint | undefined {
  if (!isJavaScriptLike(file)) return undefined;
  if (/\bnew\s+WebSocketServer\s*\(|\bio\.on\s*\(\s*['"]connection['"]/.test(file.content)) {
    return {
      id: `ep:ws:${file.relativePath}`,
      kind: "websocket",
      filePath: file.relativePath,
      packageName: file.packageName,
      label: `WebSocket ${file.relativePath}`,
    };
  }
  return undefined;
}

function detectQueueEntry(file: FileRecord): EntryPoint | undefined {
  if (!isJavaScriptLike(file)) return undefined;
  if (/\bnew\s+Worker\s*\(|\bQueue\s*\.\s*process\s*\(|\bconsumer\.run\s*\(/.test(file.content)) {
    return {
      id: `ep:queue:${file.relativePath}`,
      kind: "queue-worker",
      filePath: file.relativePath,
      packageName: file.packageName,
      label: `Queue worker ${file.relativePath}`,
    };
  }
  return undefined;
}

function sveltekitRoute(rel: string): string {
  const match = /\/routes\/(.*?)\/\+(?:server|page\.server|layout\.server)\.(ts|js)$/.exec(`/${rel}`);
  if (!match) return "/";
  const path = normalizeRoutePath(match[1]);
  return path ? `/${path}` : "/";
}

function sveltekitPageRoute(rel: string): string {
  const match = /\/routes\/(.*?)\/\+page\.svelte$/.exec(`/${rel}`);
  if (!match) return "/";
  const path = normalizeRoutePath(match[1]);
  return path ? `/${path}` : "/";
}

function nextRoute(rel: string): string {
  const match = /\/app\/(.*)\/route\.(ts|js)$/.exec(`/${rel}`);
  if (!match) return "/";
  const path = normalizeRoutePath(match[1]);
  return path ? `/${path}` : "/";
}

function normalizeRoutePath(raw: string): string {
  return raw
    .replace(/\([^)]+\)/g, "")
    .replace(/\/+/g, "/")
    .replace(/^\/+|\/+$/g, "");
}

function allHttpMethodExports(content: string): string[] {
  const methods = new Set<string>();
  const re = /export\s+(?:async\s+)?(?:function|const)\s+(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\b/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    methods.add(match[1]);
  }
  return [...methods];
}

function extractFirstSentence(text: string): string | undefined {
  const cleaned = text.trim().replace(/\s+/g, " ");
  if (!cleaned) return undefined;
  const match = /^(.+?[.!?])(\s|$)/.exec(cleaned);
  return match ? match[1] : cleaned.slice(0, 160);
}

function cleanJsDocBody(raw: string): string {
  return raw
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*\*\s?/, "").trim())
    .filter((line) => !line.startsWith("@"))
    .join(" ")
    .trim();
}

function findDocCommentAbove(lines: string[], index: number): string | undefined {
  let cursor = index - 1;
  while (cursor >= 0 && /^\s*$/.test(lines[cursor] ?? "")) cursor -= 1;
  if (cursor < 0) return undefined;

  const currentLine = lines[cursor] ?? "";
  if (!/\*\//.test(currentLine)) return undefined;

  let start = cursor;
  while (start >= 0 && !/\/\*\*/.test(lines[start] ?? "")) start -= 1;
  if (start < 0) return undefined;

  const body = lines.slice(start, cursor + 1).join("\n");
  const match = /\/\*\*([\s\S]*?)\*\//.exec(body);
  if (!match) return undefined;
  return extractFirstSentence(cleanJsDocBody(match[1]));
}

function extractSvelteScript(content: string): string {
  const match = /<script[^>]*>([\s\S]*?)<\/script>/i.exec(content);
  return match ? match[1] : "";
}

function resolveRelativeImport(file: FileRecord, specifier: string, allRelatives: Set<string>): string | undefined {
  if (!specifier.startsWith(".") && !specifier.startsWith("$")) return undefined;

  if (specifier.startsWith("$")) {
    return resolveSvelteAlias(file, specifier, allRelatives);
  }

  const currentDir = posix.dirname(file.relativePath);
  const base = toPosixPath(posix.normalize(posix.join("/", currentDir, specifier))).replace(/^\//, "");
  const candidates = candidatePaths(base);
  return candidates.find((candidate) => allRelatives.has(candidate));
}

function resolveSvelteAlias(file: FileRecord, specifier: string, allRelatives: Set<string>): string | undefined {
  const aliasMatch = /^\$([^/]+)\/(.*)$/.exec(specifier);
  if (!aliasMatch) return undefined;
  const [, aliasName, remainder] = aliasMatch;

  const srcPrefixes = findPackageSrcPrefixes(file.relativePath);
  for (const prefix of srcPrefixes) {
    const aliasSubdir = aliasName === "lib" ? "lib" : aliasName === "app" ? "app" : aliasName;
    const basePath = `${prefix}/${aliasSubdir}/${remainder}`;
    const candidates = candidatePaths(basePath);
    const hit = candidates.find((candidate) => allRelatives.has(candidate));
    if (hit) return hit;
  }

  // Fallback: workspace root $lib
  const fallback = specifier.replace(/^\$[^/]+\//, "src/");
  const candidates = candidatePaths(fallback);
  return candidates.find((candidate) => allRelatives.has(candidate));
}

function findPackageSrcPrefixes(relativePath: string): string[] {
  const parts = relativePath.split("/");
  const prefixes: string[] = [];
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    if (parts[i] === "src") {
      prefixes.push(parts.slice(0, i + 1).join("/"));
    }
  }
  return prefixes;
}

function candidatePaths(base: string): string[] {
  const extension = extname(base);
  const knownExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".svelte", ".vue"]);
  const extensions = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".svelte", ".vue"];

  if (extension && knownExtensions.has(extension)) {
    return [toPosixPath(base)];
  }

  const candidates: string[] = [base];
  candidates.push(...extensions.map((ext) => `${base}${ext}`));
  candidates.push(...extensions.map((ext) => `${base}/index${ext}`));
  return candidates.map(toPosixPath);
}
