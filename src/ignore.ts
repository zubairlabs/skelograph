import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";

export interface IgnoreRule {
  raw: string;
  pattern: string;
  directoryOnly: boolean;
  hasSlash: boolean;
  regex: RegExp;
  negate: boolean;
}

const DEFAULT_IGNORE = [
  ".git/",
  "node_modules/",
  "dist/",
  "build/",
  "coverage/",
  ".next/",
  ".nuxt/",
  ".turbo/",
  ".cache/",
  ".svelte-kit/",
  ".vercel/",
  ".output/",
  "out/",
  "target/",
  ".sqlx/",
  "skelograph-out/",
  ".claude/",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "Cargo.lock",
  "**/migrations/**/*.json",
  "**/fixtures/**",
  "**/__snapshots__/**",
  "**/__mocks__/**",
];

export function toPosixPath(value: string): string {
  return value.replace(/\\/g, "/");
}

export function relativePosix(from: string, to: string): string {
  const rel = toPosixPath(relative(from, to));
  return rel === "" ? "." : rel;
}

export async function loadIgnoreRules(root: string): Promise<IgnoreRule[]> {
  const rules: string[] = [...DEFAULT_IGNORE];
  const gitignore = await readTextIfExists(join(root, ".gitignore"));
  if (gitignore) {
    for (const line of gitignore.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      rules.push(trimmed);
    }
  }
  const skelignore = await readTextIfExists(join(root, ".skelographignore"));
  if (skelignore) {
    for (const line of skelignore.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      rules.push(trimmed);
    }
  }
  return rules.map(parseIgnoreRule);
}

export function parseIgnoreRule(raw: string): IgnoreRule {
  let pattern = toPosixPath(raw.trim());
  const negate = pattern.startsWith("!");
  if (negate) pattern = pattern.slice(1);
  pattern = pattern.replace(/^\.\//, "").replace(/^\//, "");
  const directoryOnly = pattern.endsWith("/");
  if (directoryOnly) pattern = pattern.slice(0, -1);
  const hasSlash = pattern.includes("/");
  return {
    raw,
    pattern,
    directoryOnly,
    hasSlash,
    regex: globToRegExp(pattern),
    negate,
  };
}

export function isIgnored(rules: IgnoreRule[], relativePath: string, isDirectory: boolean): boolean {
  const rel = toPosixPath(relativePath).replace(/^\.\//, "");
  if (rel === ".") return false;

  let ignored = false;
  for (const rule of rules) {
    const match = matchesRule(rule, rel, isDirectory);
    if (!match) continue;
    if (rule.negate) {
      ignored = false;
    } else {
      ignored = true;
    }
  }
  return ignored;
}

function matchesRule(rule: IgnoreRule, rel: string, isDirectory: boolean): boolean {
  if (rule.directoryOnly && !isDirectory && !rel.startsWith(`${rule.pattern}/`) && !rel.includes(`/${rule.pattern}/`)) {
    return false;
  }

  if (!rule.hasSlash) {
    const parts = rel.split("/");
    const basename = parts[parts.length - 1] ?? rel;
    if (rule.directoryOnly) {
      return parts.slice(0, -1).includes(rule.pattern) || (isDirectory && basename === rule.pattern);
    }
    if (rule.regex.test(basename)) return true;
    for (const part of parts) {
      if (rule.regex.test(part)) return true;
    }
    return false;
  }

  if (rule.directoryOnly) {
    return rel === rule.pattern || rel.startsWith(`${rule.pattern}/`);
  }

  if (rule.regex.test(rel)) return true;
  return false;
}

function globToRegExp(pattern: string): RegExp {
  let source = "^";
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    const next = pattern[i + 1];
    if (char === "*" && next === "*") {
      source += ".*";
      i += 1;
      if (pattern[i + 1] === "/") {
        i += 1;
      }
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += escapeRegExp(char);
    }
  }
  source += "$";
  return new RegExp(source);
}

function escapeRegExp(char: string): string {
  return /[\\^$+?.()|{}[\]]/.test(char) ? `\\${char}` : char;
}

async function readTextIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    throw error;
  }
}
