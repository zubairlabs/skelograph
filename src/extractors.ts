import { extname, posix } from "node:path";
import type { FileRecord } from "./types.js";
import { toPosixPath } from "./ignore.js";

export interface SymbolRecord {
  name: string;
  kind: string;
  line: number;
}

export interface ImportRecord {
  specifier: string;
  line: number;
  resolvedRelativePath?: string;
}

export function extractSymbols(file: FileRecord): SymbolRecord[] {
  switch (file.language) {
    case "typescript":
    case "javascript":
      return extractJavaScriptSymbols(file.content);
    case "python":
      return extractPythonSymbols(file.content);
    case "go":
      return extractGoSymbols(file.content);
    case "rust":
      return extractRustSymbols(file.content);
    case "markdown":
      return extractMarkdownHeadings(file.content);
    default:
      return [];
  }
}

export function extractImports(file: FileRecord, allFiles: FileRecord[]): ImportRecord[] {
  const imports = rawImports(file);
  const allRelatives = new Set(allFiles.map((candidate) => candidate.relativePath));
  return imports.map((item) => ({
    ...item,
    resolvedRelativePath: resolveRelativeImport(file, item.specifier, allRelatives),
  }));
}

function extractJavaScriptSymbols(content: string): SymbolRecord[] {
  const symbols: SymbolRecord[] = [];
  const lines = content.split(/\r?\n/);
  const patterns: Array<[RegExp, string]> = [
    [/^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/, "function"],
    [/^\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)\b/, "class"],
    [/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(?[^=]*\)?\s*=>/, "function"],
    [/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\b/, "binding"],
    [/^\s*export\s+default\s+function\s+([A-Za-z_$][\w$]*)?/, "function"],
  ];
  collectPatternSymbols(lines, patterns, symbols);
  return symbols;
}

function extractPythonSymbols(content: string): SymbolRecord[] {
  const symbols: SymbolRecord[] = [];
  const lines = content.split(/\r?\n/);
  const patterns: Array<[RegExp, string]> = [
    [/^\s*class\s+([A-Za-z_]\w*)\b/, "class"],
    [/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/, "function"],
  ];
  collectPatternSymbols(lines, patterns, symbols);
  return symbols;
}

function extractGoSymbols(content: string): SymbolRecord[] {
  const symbols: SymbolRecord[] = [];
  const lines = content.split(/\r?\n/);
  const patterns: Array<[RegExp, string]> = [
    [/^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(/, "function"],
    [/^\s*type\s+([A-Za-z_]\w*)\s+struct\b/, "struct"],
    [/^\s*type\s+([A-Za-z_]\w*)\s+interface\b/, "interface"],
  ];
  collectPatternSymbols(lines, patterns, symbols);
  return symbols;
}

function extractRustSymbols(content: string): SymbolRecord[] {
  const symbols: SymbolRecord[] = [];
  const lines = content.split(/\r?\n/);
  const patterns: Array<[RegExp, string]> = [
    [/^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)\s*\(/, "function"],
    [/^\s*(?:pub\s+)?struct\s+([A-Za-z_]\w*)\b/, "struct"],
    [/^\s*(?:pub\s+)?enum\s+([A-Za-z_]\w*)\b/, "enum"],
    [/^\s*(?:pub\s+)?trait\s+([A-Za-z_]\w*)\b/, "trait"],
  ];
  collectPatternSymbols(lines, patterns, symbols);
  return symbols;
}

function extractMarkdownHeadings(content: string): SymbolRecord[] {
  const symbols: SymbolRecord[] = [];
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(lines[index] ?? "");
    if (!match) continue;
    symbols.push({ name: match[2], kind: `heading${match[1].length}`, line: index + 1 });
  }
  return symbols;
}

function collectPatternSymbols(
  lines: string[],
  patterns: Array<[RegExp, string]>,
  symbols: SymbolRecord[],
): void {
  const seen = new Set<string>();
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    for (const [pattern, kind] of patterns) {
      const match = pattern.exec(line);
      if (!match) continue;
      const name = match[1] || (kind === "function" ? "default" : undefined);
      if (!name) continue;
      const key = `${kind}:${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      symbols.push({ name, kind, line: index + 1 });
      break;
    }
  }
}

function rawImports(file: FileRecord): ImportRecord[] {
  const lines = file.content.split(/\r?\n/);
  const imports: ImportRecord[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const lineNumber = index + 1;

    if (file.language === "typescript" || file.language === "javascript") {
      const patterns = [
        /\bimport\s+(?:.+?\s+from\s+)?["']([^"']+)["']/,
        /\bexport\s+.+?\s+from\s+["']([^"']+)["']/,
        /\brequire\(\s*["']([^"']+)["']\s*\)/,
      ];
      for (const pattern of patterns) {
        const match = pattern.exec(line);
        if (match?.[1]) imports.push({ specifier: match[1], line: lineNumber });
      }
    }

    if (file.language === "python") {
      const fromMatch = /^\s*from\s+([A-Za-z_][\w.]*)\s+import\s+/.exec(line);
      const importMatch = /^\s*import\s+([A-Za-z_][\w.]*)(?:\s+as\s+\w+)?/.exec(line);
      if (fromMatch?.[1]) imports.push({ specifier: fromMatch[1], line: lineNumber });
      if (importMatch?.[1]) imports.push({ specifier: importMatch[1], line: lineNumber });
    }

    if (file.language === "go") {
      const match = /"([^"]+)"/.exec(line);
      if (/^\s*import\b/.test(line) && match?.[1]) imports.push({ specifier: match[1], line: lineNumber });
    }

    if (file.language === "rust") {
      const match = /^\s*use\s+([^;]+);/.exec(line);
      if (match?.[1]) imports.push({ specifier: match[1].trim(), line: lineNumber });
    }
  }

  return imports;
}

function resolveRelativeImport(file: FileRecord, specifier: string, allRelatives: Set<string>): string | undefined {
  if (!specifier.startsWith(".")) return undefined;

  const currentDir = posix.dirname(file.relativePath);
  const base = toPosixPath(posix.normalize(posix.join("/", currentDir, specifier))).replace(/^\//, "");
  const candidates = candidatePaths(base);
  return candidates.find((candidate) => allRelatives.has(candidate));
}

function candidatePaths(base: string): string[] {
  const extension = extname(base);
  const extensions = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".py", ".go", ".rs"];
  const candidates = extension ? [base] : extensions.map((ext) => `${base}${ext}`);
  if (!extension) {
    candidates.push(...extensions.map((ext) => `${base}/index${ext}`));
    candidates.push(`${base}/__init__.py`);
  }
  return candidates.map(toPosixPath);
}

