import { readFile, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { toPosixPath } from "./ignore.js";
import { detectCargoWorkspace } from "./cargo.js";
import type { PackageInfo, WorkspaceInfo } from "./types.js";

interface PackageJson {
  name?: string;
  description?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  bin?: string | Record<string, string>;
  scripts?: Record<string, string>;
  workspaces?: string[] | { packages?: string[] };
}

export async function detectWorkspace(rootInput: string): Promise<WorkspaceInfo> {
  const root = resolve(rootInput);
  const rootPackage = await readPackageJson(join(root, "package.json"));

  const pnpmPatterns = await readPnpmWorkspacePatterns(root);
  const turboHint = await fileExists(join(root, "turbo.json"));
  const npmPatterns = parseNpmWorkspaces(rootPackage?.workspaces);

  // If there's no JS/TS workspace signal, try Cargo.
  if (!rootPackage && pnpmPatterns.length === 0 && npmPatterns.length === 0) {
    const cargoWorkspace = await detectCargoWorkspace(root);
    if (cargoWorkspace) return cargoWorkspace;
  }

  let kind: WorkspaceInfo["kind"] = "single";
  let patterns: string[] = [];
  if (pnpmPatterns.length > 0) {
    kind = "pnpm";
    patterns = pnpmPatterns;
  } else if (npmPatterns.length > 0) {
    kind = await fileExists(join(root, "yarn.lock")) ? "yarn" : "npm";
    patterns = npmPatterns;
  } else if (turboHint) {
    kind = "turborepo-hinted";
  }

  const packages: PackageInfo[] = [];

  if (patterns.length > 0) {
    const packageDirs = await expandWorkspaceGlobs(root, patterns);
    for (const packageDir of packageDirs) {
      const pkgPath = join(packageDir, "package.json");
      const pkg = await readPackageJson(pkgPath);
      if (!pkg?.name) continue;
      const relativePath = toPosixPath(packageDir.slice(root.length).replace(/^[\\/]/, "")) || ".";
      packages.push(buildPackageInfo(pkg, relativePath, false));
    }
  }

  if (rootPackage?.name) {
    const isMonorepoRoot = packages.length > 0;
    const rootEntry = buildPackageInfo(rootPackage, ".", isMonorepoRoot);
    if (!isMonorepoRoot) {
      packages.push(rootEntry);
    }
  }

  return {
    kind,
    rootPackageName: rootPackage?.name,
    rootDescription: rootPackage?.description,
    packages,
  };
}

function buildPackageInfo(pkg: PackageJson, relativePath: string, isRoot: boolean): PackageInfo {
  const binEntries: Record<string, string> = {};
  if (typeof pkg.bin === "string" && pkg.name) {
    binEntries[pkg.name] = pkg.bin;
  } else if (pkg.bin && typeof pkg.bin === "object") {
    for (const [name, path] of Object.entries(pkg.bin)) {
      binEntries[name] = path;
    }
  }

  return {
    name: pkg.name ?? relativePath,
    relativePath,
    description: pkg.description,
    dependencies: Object.keys(pkg.dependencies ?? {}).sort(),
    devDependencies: Object.keys(pkg.devDependencies ?? {}).sort(),
    isRoot,
    binEntries,
    scripts: pkg.scripts ?? {},
    framework: detectFramework(pkg),
  };
}

function detectFramework(pkg: PackageJson): PackageInfo["framework"] {
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  if ("@sveltejs/kit" in deps) return "sveltekit";
  if ("next" in deps) return "next";
  if ("@nestjs/core" in deps) return "nestjs";
  if ("fastify" in deps) return "fastify";
  if ("express" in deps) return "express";
  return "unknown";
}

async function readPackageJson(path: string): Promise<PackageJson | undefined> {
  try {
    const raw = (await readFile(path, "utf8")).replace(/^﻿/, "");
    return JSON.parse(raw) as PackageJson;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    return undefined;
  }
}

function parseNpmWorkspaces(workspaces: PackageJson["workspaces"]): string[] {
  if (!workspaces) return [];
  if (Array.isArray(workspaces)) return workspaces;
  return workspaces.packages ?? [];
}

async function readPnpmWorkspacePatterns(root: string): Promise<string[]> {
  const path = join(root, "pnpm-workspace.yaml");
  try {
    const raw = await readFile(path, "utf8");
    return parseYamlPackages(raw);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return [];
    return [];
  }
}

function parseYamlPackages(yaml: string): string[] {
  const patterns: string[] = [];
  const lines = yaml.split(/\r?\n/);
  let inside = false;
  for (const line of lines) {
    if (/^\s*#/.test(line)) continue;
    if (/^packages\s*:/.test(line)) {
      inside = true;
      continue;
    }
    if (inside) {
      const match = /^\s*-\s*['"]?([^'"#]+?)['"]?\s*$/.exec(line);
      if (match) {
        patterns.push(match[1].trim());
        continue;
      }
      if (/^\S/.test(line)) {
        inside = false;
      }
    }
  }
  return patterns;
}

async function expandWorkspaceGlobs(root: string, patterns: string[]): Promise<string[]> {
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
          if (await fileExists(join(candidate, "package.json"))) {
            results.add(candidate);
          }
        }
      } catch {
        continue;
      }
    } else {
      const candidate = join(root, normalized);
      if (await fileExists(join(candidate, "package.json"))) {
        results.add(candidate);
      }
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

export function packageForFile(relativePath: string, workspace: WorkspaceInfo): PackageInfo | undefined {
  const normalized = toPosixPath(relativePath);
  let bestMatch: PackageInfo | undefined;
  let bestLength = -1;
  for (const pkg of workspace.packages) {
    if (pkg.relativePath === "." && !bestMatch) {
      bestMatch = pkg;
      continue;
    }
    const prefix = `${pkg.relativePath}/`;
    if (normalized === pkg.relativePath || normalized.startsWith(prefix)) {
      if (pkg.relativePath.length > bestLength) {
        bestMatch = pkg;
        bestLength = pkg.relativePath.length;
      }
    }
  }
  return bestMatch;
}
