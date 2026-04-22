import type {
  EntryPoint,
  FileRecord,
  SkelImport,
  SkelSymbol,
  SymbolKind,
  WorkspaceInfo,
} from "./types.js";
import { toPosixPath } from "./ignore.js";

interface RustPattern {
  regex: RegExp;
  kind: SymbolKind;
  nameGroup: number;
}

const PATTERNS: RustPattern[] = [
  { regex: /^\s*(pub(?:\s*\([^)]*\))?\s+)?(?:async\s+)?(?:const\s+|unsafe\s+)?fn\s+([A-Za-z_][\w]*)/, kind: "function", nameGroup: 2 },
  { regex: /^\s*(pub(?:\s*\([^)]*\))?\s+)?struct\s+([A-Za-z_][\w]*)/, kind: "class", nameGroup: 2 },
  { regex: /^\s*(pub(?:\s*\([^)]*\))?\s+)?enum\s+([A-Za-z_][\w]*)/, kind: "enum", nameGroup: 2 },
  { regex: /^\s*(pub(?:\s*\([^)]*\))?\s+)?trait\s+([A-Za-z_][\w]*)/, kind: "interface", nameGroup: 2 },
  { regex: /^\s*(pub(?:\s*\([^)]*\))?\s+)?type\s+([A-Za-z_][\w]*)\s*=/, kind: "type", nameGroup: 2 },
  { regex: /^\s*(pub(?:\s*\([^)]*\))?\s+)?(?:static|const)\s+([A-Z_][\w]*)\s*:/, kind: "const", nameGroup: 2 },
];

export function isRust(file: FileRecord): boolean {
  return file.extension === ".rs";
}

export function extractRustFileDoc(file: FileRecord): string | undefined {
  const lines = file.content.split(/\r?\n/);
  const doc: string[] = [];
  for (const line of lines) {
    const match = /^\s*\/\/!\s?(.*)$/.exec(line);
    if (!match) {
      if (doc.length > 0) break;
      if (!line.trim()) continue;
      break;
    }
    doc.push(match[1]);
  }
  if (doc.length === 0) return undefined;
  return firstSentence(doc.join(" "));
}

export function extractRustSymbols(file: FileRecord): SkelSymbol[] {
  const lines = file.content.split(/\r?\n/);
  const symbols: SkelSymbol[] = [];
  const seen = new Set<string>();

  const implStack: Array<{ type: string; trait?: string; depth: number }> = [];
  let braceDepth = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";

    const implMatch = /^\s*impl(?:\s*<[^>]*>)?\s+(?:([A-Za-z_][\w:]*(?:<[^>]*>)?)\s+for\s+)?([A-Za-z_][\w:]*)(?:<[^>]*>)?/.exec(line);
    if (implMatch && line.includes("{")) {
      const trait = implMatch[1]?.replace(/<[^>]*>/g, "");
      const type = implMatch[2].replace(/<[^>]*>/g, "");
      implStack.push({ type, trait, depth: braceDepth });
    }

    for (const pattern of PATTERNS) {
      const match = pattern.regex.exec(line);
      if (!match) continue;
      const name = match[pattern.nameGroup];
      if (!name) continue;
      const pubMarker = (match[1] ?? "").trim();
      let visibility: SkelSymbol["visibility"] = pubMarker === "pub" ? "public" : "private";

      const impl = implStack[implStack.length - 1];
      // Methods inside a trait impl are public by convention.
      if (impl?.trait && pattern.kind === "function") visibility = "public";

      const qualified = impl && pattern.kind === "function" ? `${impl.type}::${name}` : name;
      const key = `${pattern.kind}:${qualified}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const doc = findRustDocAbove(lines, index);
      symbols.push({
        name: qualified,
        kind: pattern.kind,
        line: index + 1,
        visibility,
        doc,
      });
      break;
    }

    // Update brace depth and pop impl stack entries whose scope ended.
    for (const ch of line) {
      if (ch === "{") braceDepth += 1;
      else if (ch === "}") {
        braceDepth -= 1;
        while (implStack.length > 0 && implStack[implStack.length - 1].depth >= braceDepth) {
          implStack.pop();
        }
      }
    }
  }

  return symbols;
}

export function extractRustImports(file: FileRecord, workspace: WorkspaceInfo, allRelativePaths?: Set<string>): SkelImport[] {
  const lines = file.content.split(/\r?\n/);
  const imports: SkelImport[] = [];
  const workspaceCrates = new Map(workspace.packages.map((pkg) => [pkg.name.replace(/-/g, "_"), pkg]));

  let buffer = "";
  let startLine = 0;
  let collecting = false;

  const flush = (line: number) => {
    if (!buffer) return;
    for (const specifier of splitUseGroup(buffer)) {
      const resolved = resolveRustImport(specifier, file, workspaceCrates, allRelativePaths);
      imports.push({
        specifier,
        line,
        resolvedRelativePath: resolved?.path,
        targetPackage: resolved?.crate,
      });
    }
    buffer = "";
    collecting = false;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";

    if (collecting) {
      buffer += " " + line.trim();
      if (line.includes(";")) {
        flush(startLine + 1);
      }
      continue;
    }

    const trimmed = line.trim();
    if (!/^(?:pub\s+)?use\s+/.test(trimmed)) continue;

    startLine = index;
    if (trimmed.includes(";")) {
      buffer = trimmed;
      flush(startLine + 1);
    } else {
      buffer = trimmed;
      collecting = true;
    }
  }

  if (buffer) flush(startLine + 1);

  return imports;
}

function splitUseGroup(raw: string): string[] {
  const body = raw.replace(/^(?:pub\s+)?use\s+/, "").replace(/\s*;\s*$/, "").trim();
  if (!body) return [];

  // If there's a brace group, expand it: `auth::{foo, bar}` -> ["auth::foo", "auth::bar"]
  const braceMatch = /^(.*?)\{([\s\S]*)\}\s*$/.exec(body);
  if (braceMatch) {
    const prefix = braceMatch[1].replace(/::\s*$/, "");
    const inner = braceMatch[2];
    const parts = splitTopLevelComma(inner).map((part) => part.trim()).filter(Boolean);
    const expanded: string[] = [];
    for (const part of parts) {
      if (/^self(\s+as\s+\S+)?$/.test(part)) {
        expanded.push(prefix);
      } else {
        const subBrace = /^(.*?)\{/.test(part);
        const clean = part.replace(/\s+as\s+[A-Za-z_][\w]*$/, "");
        if (subBrace) {
          for (const sub of splitUseGroup(`use ${prefix}::${clean};`)) expanded.push(sub);
        } else {
          expanded.push(prefix ? `${prefix}::${clean}` : clean);
        }
      }
    }
    return expanded;
  }

  return [body.replace(/\s+as\s+[A-Za-z_][\w]*$/, "")];
}

function splitTopLevelComma(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of text) {
    if (ch === "{") depth += 1;
    if (ch === "}") depth -= 1;
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current);
  return parts;
}

function resolveRustImport(
  specifier: string,
  file: FileRecord,
  workspaceCrates: Map<string, { name: string; relativePath: string }>,
  allRelativePaths?: Set<string>,
): { crate?: string; path?: string } | undefined {
  if (!specifier) return undefined;
  const first = specifier.split("::")[0];
  if (!first) return undefined;
  if (first === "std" || first === "core" || first === "alloc") return undefined;
  if (first === "crate" || first === "self" || first === "super") {
    return { crate: file.packageName };
  }

  const normalized = first.replace(/-/g, "_");
  const pkg = workspaceCrates.get(normalized);
  if (pkg) {
    const rest = specifier.split("::").slice(1);
    const packageRoot = pkg.relativePath;
    const lib = `${packageRoot}/src/lib.rs`;
    if (rest.length === 0) return { crate: pkg.name, path: lib };
    const moduleSegments = rest.slice(0, -1);
    if (moduleSegments.length === 0) return { crate: pkg.name, path: lib };

    // Try deepest-to-shallowest module paths; first one that exists wins.
    if (allRelativePaths) {
      for (let depth = moduleSegments.length; depth > 0; depth -= 1) {
        const prefix = moduleSegments.slice(0, depth).join("/");
        const candidates = [
          `${packageRoot}/src/${prefix}.rs`,
          `${packageRoot}/src/${prefix}/mod.rs`,
        ];
        for (const candidate of candidates) {
          if (allRelativePaths.has(candidate)) {
            return { crate: pkg.name, path: candidate };
          }
        }
      }
    }
    return { crate: pkg.name, path: lib };
  }

  return undefined; // external crate
}

function findRustDocAbove(lines: string[], index: number): string | undefined {
  const doc: string[] = [];
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const raw = lines[cursor] ?? "";
    const match = /^\s*\/\/\/\s?(.*)$/.exec(raw);
    if (match) {
      doc.unshift(match[1]);
      continue;
    }
    if (/^\s*#\[/.test(raw)) continue; // attribute, skip
    if (!raw.trim()) break;
    break;
  }
  if (doc.length === 0) return undefined;
  return firstSentence(doc.join(" "));
}

function firstSentence(text: string): string | undefined {
  const cleaned = text.trim().replace(/\s+/g, " ");
  if (!cleaned) return undefined;
  const match = /^(.+?[.!?])(\s|$)/.exec(cleaned);
  return match ? match[1] : cleaned.slice(0, 160);
}

// -------------------- Entry points -----------------------------------------

export function detectRustEntryPoints(files: FileRecord[], workspace: WorkspaceInfo): EntryPoint[] {
  const entries: EntryPoint[] = [];

  for (const file of files) {
    if (!isRust(file)) continue;
    const main = detectMainFn(file);
    if (main) entries.push(main);

    const axumRoutes = detectAxumRoutes(file);
    for (const route of axumRoutes) entries.push(route);
  }

  for (const pkg of workspace.packages) {
    for (const [binName, binPath] of Object.entries(pkg.binEntries)) {
      const posixPath = toPosixPath(
        pkg.relativePath === "." ? binPath : `${pkg.relativePath}/${binPath}`,
      );
      const exists = files.some((f) => f.relativePath === posixPath);
      if (!exists) continue;
      if (entries.some((e) => e.filePath === posixPath && (e.kind === "rust-main" || e.kind === "rust-bin"))) continue;
      entries.push({
        id: `rust-bin:${pkg.name}:${binName}`,
        kind: "rust-bin",
        filePath: posixPath,
        packageName: pkg.name,
        label: `${binName} (Cargo bin)`,
      });
    }
  }

  return entries;
}

function detectMainFn(file: FileRecord): EntryPoint | undefined {
  const lines = file.content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (/^\s*(?:async\s+)?fn\s+main\s*\(/.test(line)) {
      const prev = lines[index - 1] ?? "";
      const runtime = /^#\[(tokio::main|actix_web::main|async_std::main)/.exec(prev.trim())?.[1];
      return {
        id: `rust-main:${file.relativePath}`,
        kind: "rust-main",
        filePath: file.relativePath,
        packageName: file.packageName,
        label: runtime ? `fn main (#[${runtime}])` : "fn main",
      };
    }
  }
  return undefined;
}

export interface AxumRouteHit {
  method: string;
  path: string;
  handler: string;
  line: number;
}

export function findAxumRoutes(content: string): AxumRouteHit[] {
  const hits: AxumRouteHit[] = [];
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    let cursor = 0;
    while (true) {
      const idx = line.indexOf(".route(", cursor);
      if (idx < 0) break;
      const openParen = idx + ".route(".length - 1;
      const closeParen = findMatchingParen(line, openParen);
      if (closeParen < 0) {
        cursor = openParen + 1;
        continue;
      }
      const args = line.slice(openParen + 1, closeParen);
      const parsed = parseRouteArgs(args);
      if (parsed) hits.push({ ...parsed, line: index + 1 });
      cursor = closeParen + 1;
    }
  }
  return hits;
}

function findMatchingParen(text: string, openIndex: number): number {
  let depth = 0;
  let inString: '"' | "'" | undefined;
  for (let i = openIndex; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") {
        i += 1;
        continue;
      }
      if (ch === inString) inString = undefined;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = ch as '"' | "'";
      continue;
    }
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function parseRouteArgs(args: string): { method: string; path: string; handler: string } | undefined {
  const match = /^\s*"([^"]+)"\s*,\s*([\s\S]+)$/.exec(args);
  if (!match) return undefined;
  const path = match[1];
  const handlerArg = match[2].trim();
  const { method, handler } = parseAxumHandler(handlerArg);
  if (!handler) return undefined;
  return { method, path, handler };
}

function parseAxumHandler(raw: string): { method: string; handler: string } {
  // Examples: get(health), post(login), get(list).post(create), MethodRouter::new().get(h)
  const methodChain = /\b(get|post|put|patch|delete|options|head)\s*\(\s*([A-Za-z_][\w:]*)\s*\)/.exec(raw);
  if (methodChain) {
    return { method: methodChain[1].toUpperCase(), handler: methodChain[2] };
  }
  return { method: "ANY", handler: raw.replace(/[^A-Za-z0-9_:]/g, "") };
}

function detectAxumRoutes(file: FileRecord): EntryPoint[] {
  if (!/\bRouter\s*::\s*new\b|\bRouter\s*::\s*with_state\b|\.route\s*\(/.test(file.content)) return [];
  const hits = findAxumRoutes(file.content);
  return hits.map((hit) => ({
    id: `axum-route:${file.relativePath}:${hit.method}:${hit.path}`,
    kind: "axum-route" as const,
    filePath: file.relativePath,
    packageName: file.packageName,
    label: `${hit.method} ${hit.path}`,
    httpMethod: hit.method,
    routePath: hit.path,
  }));
}

export function findHandlerDefinition(
  handler: string,
  file: FileRecord,
  allFiles: FileRecord[],
): { filePath: string; line: number } | undefined {
  const bare = handler.split("::").pop() ?? handler;
  const fileLines = file.content.split(/\r?\n/);
  for (let i = 0; i < fileLines.length; i += 1) {
    const line = fileLines[i] ?? "";
    if (new RegExp(`\\bfn\\s+${bare}\\b`).test(line)) {
      return { filePath: file.relativePath, line: i + 1 };
    }
  }
  // Cross-file search limited to the same package.
  for (const candidate of allFiles) {
    if (candidate.packageName !== file.packageName) continue;
    if (candidate.relativePath === file.relativePath) continue;
    if (!isRust(candidate)) continue;
    const lines = candidate.content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      if (new RegExp(`\\b(pub(?:\\s*\\([^)]*\\))?\\s+)?(?:async\\s+)?fn\\s+${bare}\\b`).test(lines[i] ?? "")) {
        return { filePath: candidate.relativePath, line: i + 1 };
      }
    }
  }
  return undefined;
}

export interface UtoipaAnnotation {
  handlerName: string;
  method?: string;
  path?: string;
  requestBody?: string;
  responses: Array<{ status: string; description?: string; body?: string }>;
  line: number;
}

export function extractUtoipaAnnotations(file: FileRecord): UtoipaAnnotation[] {
  if (!file.content.includes("utoipa::path")) return [];
  const lines = file.content.split(/\r?\n/);
  const annotations: UtoipaAnnotation[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (!/^\s*#\[utoipa::path\(/.test(line)) continue;
    // Collect the full macro block until the matching `]`.
    let block = line;
    let bracket = 0;
    let started = false;
    let endLine = i;
    for (let j = i; j < lines.length; j += 1) {
      const ln = lines[j] ?? "";
      if (j !== i) block += " " + ln;
      for (const ch of ln) {
        if (ch === "[") {
          bracket += 1;
          started = true;
        } else if (ch === "]") {
          bracket -= 1;
        }
      }
      if (started && bracket === 0) {
        endLine = j;
        break;
      }
    }

    // Find the handler name on the next non-blank line after the macro.
    let handlerName: string | undefined;
    for (let j = endLine + 1; j < Math.min(endLine + 6, lines.length); j += 1) {
      const hMatch = /^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_][\w]*)/.exec(lines[j] ?? "");
      if (hMatch) {
        handlerName = hMatch[1];
        break;
      }
    }
    if (!handlerName) continue;

    const method = /(?:^|,|\()\s*(get|post|put|patch|delete|options|head)\b/i.exec(block)?.[1]?.toUpperCase();
    const path = /\bpath\s*=\s*"([^"]+)"/.exec(block)?.[1];
    const requestBody = /\brequest_body\s*=\s*([A-Za-z_][\w:]*)/.exec(block)?.[1];

    const responses: UtoipaAnnotation["responses"] = [];
    const respRegex = /\(\s*status\s*=\s*(\d{3})\s*(?:,\s*description\s*=\s*"([^"]*)")?\s*(?:,\s*body\s*=\s*([A-Za-z_][\w:]*))?\s*\)/g;
    let rm: RegExpExecArray | null;
    while ((rm = respRegex.exec(block)) !== null) {
      responses.push({ status: rm[1], description: rm[2], body: rm[3] });
    }

    annotations.push({ handlerName, method, path, requestBody, responses, line: i + 1 });
  }

  return annotations;
}

/**
 * Return method calls of the shape `.ident(` inside the given Rust body,
 * filtering std-lib noise so we only surface domain-meaningful targets.
 */
export function extractMethodCalls(body: string): string[] {
  const calls = new Set<string>();
  const re = /\.([a-z_][\w]*)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(body)) !== null) {
    calls.add(match[1]);
  }
  return [...calls].filter((name) => !STD_METHOD_NOISE.has(name) && name.length > 3);
}

const STD_METHOD_NOISE = new Set([
  "unwrap",
  "unwrap_or",
  "unwrap_or_else",
  "unwrap_or_default",
  "expect",
  "clone",
  "clone_from",
  "as_ref",
  "as_mut",
  "as_str",
  "to_string",
  "to_owned",
  "into",
  "from",
  "iter",
  "iter_mut",
  "into_iter",
  "collect",
  "map",
  "map_err",
  "filter",
  "and_then",
  "or_else",
  "ok_or",
  "ok_or_else",
  "is_some",
  "is_none",
  "is_ok",
  "is_err",
  "is_empty",
  "len",
  "push",
  "pop",
  "insert",
  "remove",
  "contains",
  "starts_with",
  "ends_with",
  "split",
  "join",
  "trim",
  "parse",
  "clone",
  "bind",
  "fetch_one",
  "fetch_optional",
  "fetch_all",
  "execute",
  "await",
  "then",
  "with_context",
  "context",
  "ok",
  "err",
  "some",
  "none",
  "default",
]);

export function findMethodDefinition(
  methodName: string,
  hintPackage: string | undefined,
  allFiles: FileRecord[],
  options: { skipFile?: string; preferImplQualified?: boolean } = {},
): { filePath: string; line: number; qualified?: string } | undefined {
  const skipFile = options.skipFile;
  // Three passes: prefer same-crate impl-qualified, then any impl-qualified, then any plain fn.
  const passes: Array<(f: FileRecord) => boolean> = [
    (f) => Boolean(hintPackage) && f.packageName === hintPackage,
    () => true,
  ];

  // Two sub-passes per pass: impl-qualified first, then plain fn.
  for (const accept of passes) {
    for (const requireImpl of [true, false]) {
      const hit = scanForMethod(allFiles, methodName, accept, skipFile, requireImpl);
      if (hit) return hit;
    }
  }
  return undefined;
}

function scanForMethod(
  allFiles: FileRecord[],
  methodName: string,
  accept: (file: FileRecord) => boolean,
  skipFile: string | undefined,
  requireImpl: boolean,
): { filePath: string; line: number; qualified?: string } | undefined {
  for (const file of allFiles) {
    if (!isRust(file)) continue;
    if (!accept(file)) continue;
    if (skipFile && file.relativePath === skipFile) continue;
    const lines = file.content.split(/\r?\n/);
    let implType: string | undefined;
    let braceDepth = 0;
    let implDepth = -1;
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? "";
      const implMatch = /^\s*impl(?:\s*<[^>]*>)?\s+(?:[A-Za-z_][\w:]*(?:<[^>]*>)?\s+for\s+)?([A-Za-z_][\w:]*)/.exec(line);
      if (implMatch && line.includes("{")) {
        implType = implMatch[1];
        implDepth = braceDepth;
      }
      const fnMatch = new RegExp(`\\b(?:pub(?:\\s*\\([^)]*\\))?\\s+)?(?:async\\s+)?fn\\s+${methodName}\\b`).test(line);
      if (fnMatch && (!requireImpl || implType)) {
        return {
          filePath: file.relativePath,
          line: i + 1,
          qualified: implType ? `${implType}::${methodName}` : methodName,
        };
      }
      for (const ch of line) {
        if (ch === "{") braceDepth += 1;
        else if (ch === "}") {
          braceDepth -= 1;
          if (braceDepth <= implDepth) {
            implType = undefined;
            implDepth = -1;
          }
        }
      }
    }
  }
  return undefined;
}
