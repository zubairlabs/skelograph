import { readFile, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { toPosixPath } from "./ignore.js";
import type { PackageInfo, WorkspaceInfo } from "./types.js";

export interface CargoToml {
  workspace?: { members: string[]; dependencies?: Record<string, CargoDep> };
  package?: { name?: string; description?: string; version?: string };
  dependencies?: Record<string, CargoDep>;
  bins?: Array<{ name?: string; path?: string }>;
}

export interface CargoDep {
  version?: string;
  path?: string;
  workspace?: boolean;
  package?: string;
  raw: string;
}

export async function detectCargoWorkspace(root: string): Promise<WorkspaceInfo | undefined> {
  const rootTomlPath = join(root, "Cargo.toml");
  const rootRaw = await readTextIfExists(rootTomlPath);
  if (!rootRaw) return undefined;
  const rootToml = parseCargoToml(rootRaw);

  const packages: PackageInfo[] = [];
  const memberPaths = rootToml.workspace?.members ?? [];

  if (memberPaths.length > 0) {
    const resolved = await expandCargoMembers(root, memberPaths);
    for (const memberAbs of resolved) {
      const memberToml = await readTextIfExists(join(memberAbs, "Cargo.toml"));
      if (!memberToml) continue;
      const parsed = parseCargoToml(memberToml);
      const info = buildCargoPackageInfo(parsed, toPosixPath(memberAbs.slice(root.length).replace(/^[\\/]/, "")), false);
      if (info) packages.push(info);
    }
  }

  const isWorkspace = memberPaths.length > 0;
  if (!isWorkspace && rootToml.package?.name) {
    const info = buildCargoPackageInfo(rootToml, ".", true);
    if (info) packages.push(info);
  }

  if (packages.length === 0 && !isWorkspace) return undefined;

  return {
    kind: "cargo",
    rootPackageName: rootToml.package?.name,
    rootDescription: rootToml.package?.description,
    packages,
  };
}

function buildCargoPackageInfo(toml: CargoToml, relativePath: string, isRoot: boolean): PackageInfo | undefined {
  const name = toml.package?.name;
  if (!name) return undefined;

  const binEntries: Record<string, string> = {};
  for (const bin of toml.bins ?? []) {
    if (bin.name && bin.path) binEntries[bin.name] = bin.path;
    else if (bin.name) binEntries[bin.name] = "src/main.rs";
  }
  if (Object.keys(binEntries).length === 0) {
    binEntries[name] = "src/main.rs";
  }

  const dependencies = Object.keys(toml.dependencies ?? {}).sort();

  return {
    name,
    relativePath,
    description: toml.package?.description,
    dependencies,
    devDependencies: [],
    isRoot,
    binEntries,
    scripts: {},
    framework: detectCargoFramework(toml),
  };
}

function detectCargoFramework(toml: CargoToml): PackageInfo["framework"] {
  const deps = { ...(toml.dependencies ?? {}) };
  if ("axum" in deps) return "axum" as PackageInfo["framework"];
  if ("actix-web" in deps) return "actix-web" as PackageInfo["framework"];
  if ("rocket" in deps) return "rocket" as PackageInfo["framework"];
  if ("tonic" in deps) return "tonic" as PackageInfo["framework"];
  return "unknown";
}

async function expandCargoMembers(root: string, patterns: string[]): Promise<string[]> {
  const results = new Set<string>();
  for (const pattern of patterns) {
    const normalized = pattern.replace(/\\/g, "/").replace(/\/$/, "");
    if (normalized.includes("*")) {
      const starIndex = normalized.indexOf("*");
      const prefix = normalized.slice(0, starIndex).replace(/\/$/, "");
      const prefixDir = prefix ? join(root, prefix) : root;
      if (!(await isDirectory(prefixDir))) continue;
      try {
        const entries = await readdir(prefixDir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          if (entry.name.startsWith(".")) continue;
          const candidate = join(prefixDir, entry.name);
          if (await fileExists(join(candidate, "Cargo.toml"))) results.add(candidate);
        }
      } catch {
        continue;
      }
    } else {
      const candidate = join(root, normalized);
      if (await fileExists(join(candidate, "Cargo.toml"))) results.add(candidate);
    }
  }
  return [...results].sort();
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isDirectory();
  } catch {
    return false;
  }
}

async function readTextIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    return undefined;
  }
}

void resolve;

// -------------- Minimal TOML parser -----------------------------------------
// Handles exactly the subset of TOML we need: section headers ([x] and [[x]]),
// key = value lines with string / boolean / integer / array literals, inline
// tables { k = v }, multi-line arrays, and `key.workspace = true` shortcuts.

interface TomlArray extends Array<TomlValue> {}
interface TomlObject { [key: string]: TomlValue }
type TomlValue = string | number | boolean | TomlArray | TomlObject;

export function parseCargoToml(text: string): CargoToml {
  const tokens = tokenize(text);
  const result: CargoToml = {};
  const bins: Array<{ name?: string; path?: string }> = [];

  let currentHeader: string[] = [];
  let isArrayHeader = false;
  let currentTable: Record<string, TomlValue> | undefined;

  const setSectionTarget = (): void => {
    currentTable = ensureSection(result, currentHeader, isArrayHeader, bins);
  };

  setSectionTarget();

  for (const token of tokens) {
    if (token.type === "header") {
      currentHeader = token.path;
      isArrayHeader = token.array;
      setSectionTarget();
      continue;
    }
    if (token.type === "pair" && currentTable) {
      const path = token.key;
      if (path.length === 1) {
        currentTable[path[0]] = token.value;
        continue;
      }
      let cursor = currentTable;
      for (let i = 0; i < path.length - 1; i += 1) {
        const part = path[i];
        if (typeof cursor[part] !== "object" || Array.isArray(cursor[part])) {
          cursor[part] = {};
        }
        cursor = cursor[part] as Record<string, TomlValue>;
      }
      cursor[path[path.length - 1]] = token.value;
    }
  }

  if (bins.length > 0) result.bins = bins;
  return result;
}

function ensureSection(
  result: CargoToml,
  path: string[],
  array: boolean,
  bins: Array<{ name?: string; path?: string }>,
): Record<string, TomlValue> | undefined {
  if (path.length === 0) {
    const top = result as unknown as Record<string, TomlValue>;
    return top;
  }

  const [head, ...rest] = path;

  if (head === "bin" && array && rest.length === 0) {
    const entry: { name?: string; path?: string } = {};
    bins.push(entry);
    return entry as unknown as Record<string, TomlValue>;
  }

  if (head === "workspace" && rest.length === 0) {
    if (!result.workspace) result.workspace = { members: [] };
    return result.workspace as unknown as Record<string, TomlValue>;
  }
  if (head === "workspace" && rest[0] === "dependencies") {
    if (!result.workspace) result.workspace = { members: [] };
    if (!result.workspace.dependencies) result.workspace.dependencies = {};
    return result.workspace.dependencies as unknown as Record<string, TomlValue>;
  }
  if (head === "package" && rest.length === 0) {
    if (!result.package) result.package = {};
    return result.package as unknown as Record<string, TomlValue>;
  }
  if (head === "dependencies" && rest.length === 0) {
    if (!result.dependencies) result.dependencies = {};
    return result.dependencies as unknown as Record<string, TomlValue>;
  }

  // Fallback: create a nested map under the root.
  const root = result as unknown as Record<string, TomlValue>;
  let cursor: Record<string, TomlValue> = root;
  for (const part of path) {
    if (typeof cursor[part] !== "object" || Array.isArray(cursor[part])) cursor[part] = {};
    cursor = cursor[part] as Record<string, TomlValue>;
  }
  return cursor;
}

interface HeaderToken {
  type: "header";
  path: string[];
  array: boolean;
}

interface PairToken {
  type: "pair";
  key: string[];
  value: TomlValue;
}

type TomlToken = HeaderToken | PairToken;

function tokenize(text: string): TomlToken[] {
  const tokens: TomlToken[] = [];
  const lines = text.split(/\r?\n/);

  let buffer = "";
  let inMultiline = false;

  for (const rawLine of lines) {
    const line = rawLine.replace(/^﻿/, "");
    const stripped = stripLineComment(line);
    if (!stripped.trim() && !inMultiline) continue;

    if (inMultiline) {
      buffer += " " + stripped;
      if (bracketsBalanced(buffer)) {
        const token = parseKeyValue(buffer);
        if (token) tokens.push(token);
        buffer = "";
        inMultiline = false;
      }
      continue;
    }

    const trimmed = stripped.trim();
    if (!trimmed) continue;

    const headerMatch = /^\[\[?\s*([^\]]+?)\s*\]\]?\s*$/.exec(trimmed);
    if (headerMatch && (trimmed.startsWith("[[") === trimmed.endsWith("]]")) && trimmed.startsWith("[")) {
      const isArray = trimmed.startsWith("[[");
      const name = headerMatch[1];
      tokens.push({ type: "header", path: name.split(".").map((p) => p.trim()), array: isArray });
      continue;
    }

    if (!bracketsBalanced(stripped)) {
      buffer = stripped;
      inMultiline = true;
      continue;
    }

    const token = parseKeyValue(stripped);
    if (token) tokens.push(token);
  }

  return tokens;
}

function stripLineComment(line: string): string {
  let inString: '"' | "'" | undefined;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
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
    if (ch === "#") return line.slice(0, i);
  }
  return line;
}

function bracketsBalanced(text: string): boolean {
  let depth = 0;
  let brace = 0;
  let inString: '"' | "'" | undefined;
  for (let i = 0; i < text.length; i += 1) {
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
    if (ch === "[") depth += 1;
    else if (ch === "]") depth -= 1;
    else if (ch === "{") brace += 1;
    else if (ch === "}") brace -= 1;
  }
  return depth === 0 && brace === 0;
}

function parseKeyValue(line: string): PairToken | undefined {
  const eqIndex = findTopLevelEquals(line);
  if (eqIndex < 0) return undefined;
  const keyPart = line.slice(0, eqIndex).trim();
  const valuePart = line.slice(eqIndex + 1).trim();
  const key = parseKeyPath(keyPart);
  const value = parseValue(valuePart);
  if (value === undefined) return undefined;
  return { type: "pair", key, value };
}

function findTopLevelEquals(text: string): number {
  let inString: '"' | "'" | undefined;
  let bracket = 0;
  let brace = 0;
  for (let i = 0; i < text.length; i += 1) {
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
    if (ch === "[") bracket += 1;
    else if (ch === "]") bracket -= 1;
    else if (ch === "{") brace += 1;
    else if (ch === "}") brace -= 1;
    else if (ch === "=" && bracket === 0 && brace === 0) return i;
  }
  return -1;
}

function parseKeyPath(key: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inString: '"' | "'" | undefined;
  for (let i = 0; i < key.length; i += 1) {
    const ch = key[i];
    if (inString) {
      if (ch === "\\") {
        current += key[i + 1] ?? "";
        i += 1;
        continue;
      }
      if (ch === inString) {
        inString = undefined;
        continue;
      }
      current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = ch as '"' | "'";
      continue;
    }
    if (ch === ".") {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function parseValue(raw: string): TomlValue | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith('"') || trimmed.startsWith("'")) return parseStringLiteral(trimmed);
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed.startsWith("[")) return parseArrayLiteral(trimmed);
  if (trimmed.startsWith("{")) return parseInlineTable(trimmed);
  const asNumber = Number(trimmed);
  if (!Number.isNaN(asNumber) && /^-?\d+(?:\.\d+)?$/.test(trimmed)) return asNumber;
  return trimmed;
}

function parseStringLiteral(raw: string): string {
  const quote = raw[0];
  let result = "";
  for (let i = 1; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch === "\\") {
      const next = raw[i + 1];
      if (next === "n") result += "\n";
      else if (next === "t") result += "\t";
      else if (next === "r") result += "\r";
      else if (next === "\\") result += "\\";
      else if (next === quote) result += quote;
      else result += next ?? "";
      i += 1;
      continue;
    }
    if (ch === quote) return result;
    result += ch;
  }
  return result;
}

function parseArrayLiteral(raw: string): TomlValue[] {
  const body = raw.slice(1, raw.lastIndexOf("]"));
  const items = splitTopLevel(body, ",");
  const result: TomlValue[] = [];
  for (const item of items) {
    const trimmed = item.trim();
    if (!trimmed) continue;
    const value = parseValue(trimmed);
    if (value !== undefined) result.push(value);
  }
  return result;
}

function parseInlineTable(raw: string): Record<string, TomlValue> {
  const body = raw.slice(1, raw.lastIndexOf("}"));
  const parts = splitTopLevel(body, ",");
  const result: Record<string, TomlValue> = {};
  for (const part of parts) {
    const eq = findTopLevelEquals(part);
    if (eq < 0) continue;
    const key = parseKeyPath(part.slice(0, eq).trim());
    const value = parseValue(part.slice(eq + 1).trim());
    if (value === undefined) continue;
    if (key.length === 1) result[key[0]] = value;
  }
  return result;
}

function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = [];
  let current = "";
  let bracket = 0;
  let brace = 0;
  let inString: '"' | "'" | undefined;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      current += ch;
      if (ch === "\\") {
        current += text[i + 1] ?? "";
        i += 1;
        continue;
      }
      if (ch === inString) inString = undefined;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = ch as '"' | "'";
      current += ch;
      continue;
    }
    if (ch === "[") {
      bracket += 1;
      current += ch;
      continue;
    }
    if (ch === "]") {
      bracket -= 1;
      current += ch;
      continue;
    }
    if (ch === "{") {
      brace += 1;
      current += ch;
      continue;
    }
    if (ch === "}") {
      brace -= 1;
      current += ch;
      continue;
    }
    if (ch === separator && bracket === 0 && brace === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current);
  return parts;
}
