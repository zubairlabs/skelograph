import { posix } from "node:path";
import type { FileRecord, SkelImport, SkelSymbol, SymbolKind, Visibility } from "./types.js";

interface JvmPattern {
  regex: RegExp;
  kind: SymbolKind;
  nameGroup: number;
}

const KOTLIN_TYPE_PATTERNS: JvmPattern[] = [
  {
    regex: /^\s*(?:public\s+|internal\s+|private\s+|protected\s+)?(?:abstract\s+|open\s+|final\s+)?(?:data\s+|inner\s+|annotation\s+|inline\s+|value\s+)?(?:enum\s+)class\s+([A-Za-z_]\w*)/,
    kind: "enum",
    nameGroup: 1,
  },
  {
    regex: /^\s*(?:public\s+|internal\s+|private\s+|protected\s+)?(?:abstract\s+|open\s+|final\s+|sealed\s+)?(?:data\s+|inner\s+|annotation\s+|inline\s+|value\s+)?class\s+([A-Za-z_]\w*)/,
    kind: "class",
    nameGroup: 1,
  },
  {
    regex: /^\s*(?:public\s+|internal\s+|private\s+|protected\s+)?(?:sealed\s+|fun\s+)?interface\s+([A-Za-z_]\w*)/,
    kind: "interface",
    nameGroup: 1,
  },
  {
    regex: /^\s*(?:public\s+|internal\s+|private\s+|protected\s+)?(?:companion\s+|data\s+)?object\s+([A-Za-z_]\w*)/,
    kind: "object",
    nameGroup: 1,
  },
  {
    regex: /^\s*(?:public\s+|internal\s+|private\s+|protected\s+)?typealias\s+([A-Za-z_]\w*)/,
    kind: "type",
    nameGroup: 1,
  },
];

const KOTLIN_FUN_PATTERN =
  /^\s*(?:public\s+|internal\s+|private\s+|protected\s+)?(?:override\s+|suspend\s+|inline\s+|operator\s+|infix\s+|tailrec\s+|abstract\s+|open\s+|final\s+|external\s+)*fun\s+(?:<[^>]+>\s+)?(?:[A-Za-z_]\w*\.)?([A-Za-z_]\w*)\s*\(/;

const KOTLIN_TOP_BINDING_PATTERN =
  /^(?:public\s+|internal\s+|private\s+|protected\s+)?(?:const\s+)?(val|var)\s+([A-Za-z_]\w*)/;

const JAVA_TYPE_PATTERNS: JvmPattern[] = [
  {
    regex: /^\s*(?:public\s+|protected\s+|private\s+|static\s+|final\s+|abstract\s+|sealed\s+|non-sealed\s+)*(?:class|record)\s+([A-Za-z_]\w*)/,
    kind: "class",
    nameGroup: 1,
  },
  {
    regex: /^\s*(?:public\s+|protected\s+|private\s+|static\s+|final\s+|abstract\s+|sealed\s+|non-sealed\s+)*interface\s+([A-Za-z_]\w*)/,
    kind: "interface",
    nameGroup: 1,
  },
  {
    regex: /^\s*(?:public\s+|protected\s+|private\s+|static\s+|final\s+|abstract\s+)*enum\s+([A-Za-z_]\w*)/,
    kind: "enum",
    nameGroup: 1,
  },
  {
    regex: /^\s*(?:public\s+|protected\s+|private\s+)*@interface\s+([A-Za-z_]\w*)/,
    kind: "interface",
    nameGroup: 1,
  },
];

const JAVA_METHOD_PATTERN =
  /^\s*(?:@\w+(?:\([^)]*\))?\s+)*(?:public\s+|protected\s+|private\s+|static\s+|final\s+|abstract\s+|synchronized\s+|native\s+|default\s+)+(?:<[^>]+>\s+)?(?:[A-Za-z_][\w.<>?,\s\[\]]*?)\s+([A-Za-z_]\w*)\s*\([^)]*\)\s*(?:throws\s+[\w.,\s]+)?\s*[;{]/;

const JAVA_CONTROL_KEYWORDS = new Set([
  "if",
  "for",
  "while",
  "switch",
  "return",
  "throw",
  "new",
  "synchronized",
]);

export function isJvm(file: FileRecord): boolean {
  return file.extension === ".kt" || file.extension === ".kts" || file.extension === ".java";
}

export function isKotlin(file: FileRecord): boolean {
  return file.extension === ".kt" || file.extension === ".kts";
}

export function isJava(file: FileRecord): boolean {
  return file.extension === ".java";
}

export function extractJvmSymbols(file: FileRecord): SkelSymbol[] {
  if (isKotlin(file)) return extractKotlinSymbols(file);
  if (isJava(file)) return extractJavaSymbols(file);
  return [];
}

export function extractJvmFileDoc(file: FileRecord): string | undefined {
  const trimmed = file.content.trimStart();
  const m = /^\/\*\*([\s\S]*?)\*\//.exec(trimmed);
  if (!m) return undefined;
  const cleaned = m[1]
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*\*\s?/, ""))
    .join(" ")
    .trim();
  return firstSentence(cleaned);
}

function extractKotlinSymbols(file: FileRecord): SkelSymbol[] {
  const symbols: SkelSymbol[] = [];
  const lines = file.content.split(/\r?\n/);
  let block = false;
  let composablePending = false;
  const seen = new Set<string>();

  for (let i = 0; i < lines.length; i += 1) {
    const stripped = stripCComments(lines[i] ?? "", block);
    block = stripped.blockNext;
    const code = stripped.text;
    if (!code.trim()) continue;

    if (/^\s*@Composable\b/.test(code) && !/\bfun\b/.test(code)) {
      composablePending = true;
      continue;
    }

    let matched = false;
    for (const pattern of KOTLIN_TYPE_PATTERNS) {
      const m = pattern.regex.exec(code);
      if (!m) continue;
      const name = m[pattern.nameGroup];
      const visibility = lineVisibility(code);
      const key = `${pattern.kind}:${name}`;
      if (!seen.has(key)) {
        seen.add(key);
        symbols.push({ name, kind: pattern.kind, line: i + 1, visibility });
      }
      composablePending = false;
      matched = true;
      break;
    }
    if (matched) continue;

    const fn = KOTLIN_FUN_PATTERN.exec(code);
    if (fn) {
      const name = fn[1];
      const visibility = lineVisibility(code);
      const doc = composablePending ? "[@Composable]" : undefined;
      const key = `function:${name}`;
      if (!seen.has(key)) {
        seen.add(key);
        symbols.push({ name, kind: "function", line: i + 1, visibility, doc });
      }
      composablePending = false;
      continue;
    }

    if (/^[A-Za-z_]/.test(code) || /^\s*(?:public|internal|private|protected|const)\b.*\b(val|var)\b/.test(code)) {
      const bindingMatch = KOTLIN_TOP_BINDING_PATTERN.exec(code);
      if (bindingMatch) {
        const kind: SymbolKind = bindingMatch[1] === "val" ? "const" : "variable";
        const name = bindingMatch[2];
        const visibility = lineVisibility(code);
        const key = `${kind}:${name}`;
        if (!seen.has(key)) {
          seen.add(key);
          symbols.push({ name, kind, line: i + 1, visibility });
        }
      }
    }
  }
  return symbols;
}

function extractJavaSymbols(file: FileRecord): SkelSymbol[] {
  const symbols: SkelSymbol[] = [];
  const lines = file.content.split(/\r?\n/);
  let block = false;
  const seen = new Set<string>();

  const classStack: Array<{ name: string; depth: number; visibility: Visibility }> = [];
  let braceDepth = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const stripped = stripCComments(lines[i] ?? "", block);
    block = stripped.blockNext;
    const code = stripped.text;

    let matched = false;
    if (code.trim()) {
      for (const pattern of JAVA_TYPE_PATTERNS) {
        const m = pattern.regex.exec(code);
        if (!m) continue;
        const name = m[pattern.nameGroup];
        const visibility: Visibility = /\bpublic\b/.test(code) ? "public" : "private";
        const key = `${pattern.kind}:${name}`;
        if (!seen.has(key)) {
          seen.add(key);
          symbols.push({ name, kind: pattern.kind, line: i + 1, visibility });
        }
        if (code.includes("{")) {
          classStack.push({ name, depth: braceDepth, visibility });
        }
        matched = true;
        break;
      }

      if (!matched && classStack.length > 0) {
        const m = JAVA_METHOD_PATTERN.exec(code);
        if (m) {
          const name = m[1];
          if (!JAVA_CONTROL_KEYWORDS.has(name)) {
            const enclosing = classStack[classStack.length - 1];
            const visibility: Visibility = /\bpublic\b/.test(code)
              ? "public"
              : enclosing.visibility === "public"
                ? "public"
                : "private";
            const qualified = `${enclosing.name}.${name}`;
            const key = `method:${qualified}`;
            if (!seen.has(key)) {
              seen.add(key);
              symbols.push({ name: qualified, kind: "method", line: i + 1, visibility });
            }
          }
        }
      }
    }

    let inStr: '"' | "'" | undefined;
    for (let k = 0; k < code.length; k += 1) {
      const ch = code[k];
      if (inStr) {
        if (ch === "\\") {
          k += 1;
          continue;
        }
        if (ch === inStr) inStr = undefined;
        continue;
      }
      if (ch === '"' || ch === "'") {
        inStr = ch as '"' | "'";
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

function lineVisibility(code: string): Visibility {
  return /^\s*(?:private|internal|protected)\b/.test(code) ? "private" : "public";
}

export interface JvmIndex {
  classToFile: Map<string, string>;
}

export function buildJvmIndex(files: FileRecord[]): JvmIndex {
  const classToFile = new Map<string, string>();
  for (const file of files) {
    if (!isJvm(file)) continue;
    const pkg = extractJvmPackage(file.content);
    if (!pkg) continue;

    const baseName = posix.basename(file.relativePath).replace(/\.(kts?|java)$/i, "");
    classToFile.set(`${pkg}.${baseName}`, file.relativePath);

    if (isKotlin(file)) {
      for (const sym of extractKotlinSymbols(file)) {
        if (
          sym.kind === "class"
          || sym.kind === "interface"
          || sym.kind === "enum"
          || sym.kind === "object"
          || sym.kind === "type"
        ) {
          classToFile.set(`${pkg}.${sym.name}`, file.relativePath);
        }
      }
    }
  }
  return { classToFile };
}

function extractJvmPackage(content: string): string | undefined {
  const m = /^[ \t]*package\s+([\w.]+)\s*;?\s*$/m.exec(content);
  return m?.[1];
}

export function extractJvmImports(file: FileRecord, jvmIndex: JvmIndex): SkelImport[] {
  const imports: SkelImport[] = [];
  const lines = file.content.split(/\r?\n/);

  if (isKotlin(file)) {
    for (let i = 0; i < lines.length; i += 1) {
      const m = /^\s*import\s+([\w.]+)(?:\s+as\s+\w+)?\s*$/.exec(lines[i] ?? "");
      if (m?.[1]) {
        const specifier = m[1];
        imports.push({
          specifier,
          line: i + 1,
          resolvedRelativePath: jvmIndex.classToFile.get(specifier),
        });
      }
    }
    return imports;
  }

  for (let i = 0; i < lines.length; i += 1) {
    const m = /^\s*import\s+(?:static\s+)?([\w.]+(?:\.\*)?)\s*;/.exec(lines[i] ?? "");
    if (m?.[1] && !m[1].endsWith(".*")) {
      const specifier = m[1];
      imports.push({
        specifier,
        line: i + 1,
        resolvedRelativePath: jvmIndex.classToFile.get(specifier),
      });
    }
  }
  return imports;
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
