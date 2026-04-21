import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";

export interface IgnoreRule {
  raw: string;
  pattern: string;
  directoryOnly: boolean;
  hasSlash: boolean;
  regex: RegExp;
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
  "skelograph-out/",
];

export function toPosixPath(value: string): string {
  return value.replace(/\\/g, "/");
}

export function relativePosix(from: string, to: string): string {
  const rel = toPosixPath(relative(from, to));
  return rel === "" ? "." : rel;
}

export async function loadIgnoreRules(root: string): Promise<IgnoreRule[]> {
  const rules = [...DEFAULT_IGNORE];
  try {
    const text = await readFile(join(root, ".skelographignore"), "utf8");
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      if (trimmed.startsWith("!")) continue;
      rules.push(trimmed);
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw error;
  }
  return rules.map(parseIgnoreRule);
}

export function parseIgnoreRule(raw: string): IgnoreRule {
  let pattern = toPosixPath(raw.trim());
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
  };
}

export function isIgnored(rules: IgnoreRule[], relativePath: string, isDirectory: boolean): boolean {
  const rel = toPosixPath(relativePath).replace(/^\.\//, "");
  if (rel === ".") return false;

  for (const rule of rules) {
    if (rule.directoryOnly && !isDirectory && !rel.startsWith(`${rule.pattern}/`)) {
      continue;
    }

    if (!rule.hasSlash) {
      const parts = rel.split("/");
      const basename = parts[parts.length - 1] ?? rel;
      if (rule.directoryOnly) {
        if (parts.includes(rule.pattern)) return true;
        continue;
      }
      if (rule.regex.test(basename) || rule.regex.test(rel)) return true;
      continue;
    }

    if (rule.directoryOnly) {
      if (rel === rule.pattern || rel.startsWith(`${rule.pattern}/`)) return true;
      continue;
    }

    if (rule.regex.test(rel)) return true;
  }

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
