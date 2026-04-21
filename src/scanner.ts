import { readdir, readFile, stat } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { isIgnored, loadIgnoreRules, relativePosix } from "./ignore.js";
import type { FileRecord, ScanResult, ScanStats } from "./types.js";

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".ts": "typescript",
  ".tsx": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".cs": "csharp",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".cxx": "cpp",
  ".c": "c",
  ".h": "c",
  ".hpp": "cpp",
  ".rb": "ruby",
  ".php": "php",
  ".swift": "swift",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".md": "markdown",
  ".mdx": "markdown",
  ".txt": "text",
  ".json": "json",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "toml",
};

const DEFAULT_MAX_FILE_BYTES = 1_000_000;
const SENSITIVE_NAMES = new Set([
  ".env",
  ".env.local",
  ".env.production",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
]);

const SENSITIVE_EXTENSIONS = new Set([".pem", ".key", ".p12", ".pfx"]);

export function languageForExtension(extension: string): string | undefined {
  return LANGUAGE_BY_EXTENSION[extension.toLowerCase()];
}

export async function scan(rootInput: string, maxFileBytes = DEFAULT_MAX_FILE_BYTES): Promise<ScanResult> {
  const root = resolve(rootInput);
  const rootStat = await stat(root);
  if (!rootStat.isDirectory()) {
    throw new Error(`Root must be a directory: ${root}`);
  }

  const rules = await loadIgnoreRules(root);
  const files: FileRecord[] = [];
  const stats: ScanStats = {
    totalFiles: 0,
    totalBytes: 0,
    totalLines: 0,
    skippedIgnored: 0,
    skippedSensitive: 0,
    skippedLarge: 0,
    languages: {},
  };

  async function walk(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const absolutePath = resolve(current, entry.name);
      const rel = relativePosix(root, absolutePath);
      const directory = entry.isDirectory();

      if (isIgnored(rules, rel, directory)) {
        stats.skippedIgnored += 1;
        continue;
      }

      if (directory) {
        await walk(absolutePath);
        continue;
      }

      if (!entry.isFile()) continue;

      const extension = extname(entry.name).toLowerCase();
      if (isSensitiveFile(entry.name, extension)) {
        stats.skippedSensitive += 1;
        continue;
      }

      const language = languageForExtension(extension);
      if (!language) continue;

      const fileStat = await stat(absolutePath);
      if (fileStat.size > maxFileBytes) {
        stats.skippedLarge += 1;
        continue;
      }

      const content = await readFile(absolutePath, "utf8");
      const lineCount = content.length === 0 ? 0 : content.split(/\r?\n/).length;
      files.push({
        absolutePath,
        relativePath: rel,
        extension,
        language,
        sizeBytes: fileStat.size,
        lineCount,
        content,
      });
      stats.totalFiles += 1;
      stats.totalBytes += fileStat.size;
      stats.totalLines += lineCount;
      stats.languages[language] = (stats.languages[language] ?? 0) + 1;
    }
  }

  await walk(root);
  return { root, files, stats };
}

function isSensitiveFile(name: string, extension: string): boolean {
  const lower = name.toLowerCase();
  return SENSITIVE_NAMES.has(lower) || SENSITIVE_EXTENSIONS.has(extension);
}
