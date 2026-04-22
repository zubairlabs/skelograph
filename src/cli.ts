#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSkelograph, installClaude } from "./index.js";

interface CliOptions {
  root: string;
  outDir?: string;
  format: "text" | "json";
}

async function main(argv: string[]): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) {
    printHelp();
    return;
  }

  if (argv.includes("--version") || argv.includes("-v")) {
    console.log(await packageVersion());
    return;
  }

  if (argv[0] === "install") {
    await handleInstall(argv.slice(1));
    return;
  }

  const options = parseArgs(argv);
  const result = await buildSkelograph({ root: options.root, outDir: options.outDir });
  const graph = result.graph;

  if (options.format === "json") {
    console.log(
      JSON.stringify(
        {
          root: resolve(options.root),
          outDir: result.outDir,
          written: result.written,
          skipped: result.skipped,
          files: graph.stats.totalFiles,
          packages: graph.workspace.packages.length,
          entryPoints: graph.entryPoints.length,
          flows: graph.flows.length,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(
    `skelograph scanned ${graph.stats.totalFiles} files across ${graph.workspace.packages.length} package${
      graph.workspace.packages.length === 1 ? "" : "s"
    }`,
  );
  console.log(`  entry points: ${graph.entryPoints.length}`);
  console.log(`  flows:        ${graph.flows.length}`);
  console.log(`  written:      ${result.written.length} file${result.written.length === 1 ? "" : "s"}`);
  console.log(`  skipped:      ${result.skipped.length} file${result.skipped.length === 1 ? "" : "s"} (unchanged)`);
  console.log("");
  console.log(`  start here:   ${result.outDir}/INDEX.md`);
}

async function handleInstall(argv: string[]): Promise<void> {
  const target = argv[0];
  if (target !== "claude") {
    throw new Error("Usage: skelograph install claude [--dry-run] [--root path]");
  }

  let root = ".";
  let dryRun = false;
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--root") {
      const value = argv[index + 1];
      if (!value) throw new Error("Missing value for --root");
      root = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown install flag: ${arg}`);
  }

  const result = await installClaude({ root, dryRun });
  if (result.changed.length === 0) {
    console.log("Claude Code integration is already installed.");
    return;
  }

  const action = result.dryRun ? "would update" : "updated";
  console.log(`Claude Code integration ${action}:`);
  for (const path of result.changed) {
    console.log(`- ${path}`);
  }
  if (!result.dryRun) {
    console.log("Use /skelograph inside Claude Code to rebuild the map.");
  }
}

function parseArgs(argv: string[]): CliOptions {
  const positional: string[] = [];
  let outDir: string | undefined;
  let format: "text" | "json" = "text";

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--out" || arg === "-o") {
      const value = argv[index + 1];
      if (!value) throw new Error("Missing value for --out");
      outDir = value;
      index += 1;
      continue;
    }
    if (arg === "--format") {
      const value = argv[index + 1];
      if (value !== "text" && value !== "json") throw new Error("--format must be text or json");
      format = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) throw new Error(`Unknown flag: ${arg}`);
    positional.push(arg);
  }

  return {
    root: positional[0] ?? ".",
    outDir,
    format,
  };
}

function printHelp(): void {
  console.log(`skelograph

Usage:
  skelograph [path] [--out .claude] [--format text|json]
  skelograph install claude [--dry-run] [--root path]

Writes a Claude-native navigation map into .claude/:
  INDEX.md            brain entry point — read first
  MAP.json            symbol → file lookup
  PACKAGES/*.md       per-package detail
  FLOWS/*.md          cross-package behavioral flows
  ENTRYPOINTS.md      every real execution start
  HOTSPOTS.md         load-bearing modules
  manifest.json       machine-readable nav index

Examples:
  skelograph .
  skelograph ./apps/web
  skelograph install claude
`);
}

async function packageVersion(): Promise<string> {
  const cliPath = fileURLToPath(import.meta.url);
  const packagePath = resolve(dirname(cliPath), "../../package.json");
  try {
    const packageJson = (await readFile(packagePath, "utf8")).replace(/^﻿/, "");
    const pkg = JSON.parse(packageJson) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`skelograph: ${message}`);
  process.exitCode = 1;
});
