import type { FileRecord, SkelImport, SkelSymbol, SymbolKind, Visibility } from "./types.js";

interface SwiftPattern {
  regex: RegExp;
  kind: SymbolKind;
  nameGroup: number;
}

const SWIFT_TYPE_PATTERNS: SwiftPattern[] = [
  {
    regex: /^\s*(?:@\w+(?:\([^)]*\))?\s+)*(?:public\s+|internal\s+|private\s+|fileprivate\s+|open\s+|final\s+)*(?:class|struct|actor)\s+([A-Za-z_]\w*)/,
    kind: "class",
    nameGroup: 1,
  },
  {
    regex: /^\s*(?:@\w+(?:\([^)]*\))?\s+)*(?:public\s+|internal\s+|private\s+|fileprivate\s+|open\s+)*protocol\s+([A-Za-z_]\w*)/,
    kind: "interface",
    nameGroup: 1,
  },
  {
    regex: /^\s*(?:@\w+(?:\([^)]*\))?\s+)*(?:public\s+|internal\s+|private\s+|fileprivate\s+|open\s+)*(?:indirect\s+)?enum\s+([A-Za-z_]\w*)/,
    kind: "enum",
    nameGroup: 1,
  },
  {
    regex: /^\s*(?:public\s+|internal\s+|private\s+|fileprivate\s+)?typealias\s+([A-Za-z_]\w*)/,
    kind: "type",
    nameGroup: 1,
  },
];

const SWIFT_FUNC_PATTERN =
  /^\s*(?:@\w+(?:\([^)]*\))?\s+)*(?:public\s+|internal\s+|private\s+|fileprivate\s+|open\s+|final\s+|static\s+|class\s+|mutating\s+|nonisolated\s+|override\s+)*func\s+([A-Za-z_]\w*)\s*(?:<[^>]*>)?\s*\(/;

const SWIFT_EXTENSION_PATTERN =
  /^\s*(?:@\w+(?:\([^)]*\))?\s+)*(?:public\s+|internal\s+|private\s+|fileprivate\s+|open\s+|final\s+)*extension\s+([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*(?::\s*([^{]+?))?\s*(?:where\b[^{]*)?\{/;

export function isSwift(file: FileRecord): boolean {
  return file.extension === ".swift";
}

export function extractSwiftSymbols(file: FileRecord): SkelSymbol[] {
  const symbols: SkelSymbol[] = [];
  const lines = file.content.split(/\r?\n/);
  let block = false;
  const seen = new Set<string>();

  for (let i = 0; i < lines.length; i += 1) {
    const stripped = stripCComments(lines[i] ?? "", block);
    block = stripped.blockNext;
    const code = stripped.text;
    if (!code.trim()) continue;

    const ext = SWIFT_EXTENSION_PATTERN.exec(code);
    if (ext) {
      const target = ext[1];
      const conformances = ext[2]?.trim();
      const name = conformances ? `${target}: ${conformances}` : target;
      const visibility: Visibility = /^\s*(?:private|fileprivate)\b/.test(code) ? "private" : "public";
      const key = `extension:${name}`;
      if (!seen.has(key)) {
        seen.add(key);
        symbols.push({ name, kind: "extension", line: i + 1, visibility });
      }
      continue;
    }

    let matched = false;
    for (const pattern of SWIFT_TYPE_PATTERNS) {
      const m = pattern.regex.exec(code);
      if (!m) continue;
      const name = m[pattern.nameGroup];
      const visibility: Visibility = /\b(?:private|fileprivate)\b/.test(code) ? "private" : "public";
      const key = `${pattern.kind}:${name}`;
      if (!seen.has(key)) {
        seen.add(key);
        symbols.push({ name, kind: pattern.kind, line: i + 1, visibility });
      }
      matched = true;
      break;
    }
    if (matched) continue;

    const fn = SWIFT_FUNC_PATTERN.exec(code);
    if (fn) {
      const name = fn[1];
      const visibility: Visibility = /\b(?:private|fileprivate)\b/.test(code) ? "private" : "public";
      const key = `function:${name}`;
      if (!seen.has(key)) {
        seen.add(key);
        symbols.push({ name, kind: "function", line: i + 1, visibility });
      }
    }
  }
  return symbols;
}

export function extractSwiftImports(file: FileRecord): SkelImport[] {
  const imports: SkelImport[] = [];
  const lines = file.content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^\s*import\s+(?:[A-Za-z_]+\s+)?([\w.]+)\s*$/.exec(lines[i] ?? "");
    if (m?.[1]) imports.push({ specifier: m[1], line: i + 1 });
  }
  return imports;
}

export function extractSwiftFileDoc(file: FileRecord): string | undefined {
  const lines = file.content.split(/\r?\n/);
  const tripleSlash: string[] = [];
  for (const line of lines) {
    const m = /^\s*\/\/\/\s?(.*)$/.exec(line);
    if (!m) {
      if (tripleSlash.length > 0) break;
      if (!line.trim()) continue;
      break;
    }
    tripleSlash.push(m[1]);
  }
  if (tripleSlash.length > 0) return firstSentence(tripleSlash.join(" "));

  const trimmed = file.content.trimStart();
  const block = /^\/\*\*([\s\S]*?)\*\//.exec(trimmed);
  if (block) {
    const cleaned = block[1]
      .split(/\r?\n/)
      .map((l) => l.replace(/^\s*\*\s?/, ""))
      .join(" ")
      .trim();
    return firstSentence(cleaned);
  }
  return undefined;
}

function firstSentence(text: string): string {
  if (!text) return text;
  const period = text.indexOf(".");
  if (period === -1) return text.trim().slice(0, 200);
  return text.slice(0, period + 1).trim();
}

function stripCComments(line: string, inBlock: boolean): { text: string; blockNext: boolean } {
  let result = "";
  let i = 0;
  let block = inBlock;
  while (i < line.length) {
    if (block) {
      const end = line.indexOf("*/", i);
      if (end === -1) return { text: result, blockNext: true };
      i = end + 2;
      block = false;
      continue;
    }
    if (line[i] === "/" && line[i + 1] === "/") break;
    if (line[i] === "/" && line[i + 1] === "*") {
      block = true;
      i += 2;
      continue;
    }
    result += line[i];
    i += 1;
  }
  return { text: result, blockNext: block };
}
