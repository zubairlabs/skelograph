import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { scan } from "./scanner.js";
import { buildGraph } from "./graph.js";
import { installClaude } from "./claude.js";
import { renderIndex } from "./renderers/index.js";
import { renderPackagePages } from "./renderers/package.js";
import { renderFlowPages } from "./renderers/flows.js";
import { renderEntrypoints } from "./renderers/entrypoints.js";
import { renderHotspots } from "./renderers/hotspots.js";
import { renderMap } from "./renderers/map.js";
import { renderManifest } from "./renderers/manifest.js";
import type { BuildOptions, Skelograph } from "./types.js";

export interface BuildResult {
  graph: Skelograph;
  outDir: string;
  written: string[];
  skipped: string[];
}

export async function buildSkelograph(options: BuildOptions): Promise<BuildResult> {
  const root = resolve(options.root);
  const outDir = resolve(root, options.outDir ?? ".claude");
  const scanResult = await scan(root, options.maxFileBytes);
  const graph = buildGraph(scanResult);

  const written: string[] = [];
  const skipped: string[] = [];

  await mkdir(outDir, { recursive: true });

  await writeIfChanged(join(outDir, "INDEX.md"), renderIndex(graph), written, skipped);
  await writeIfChanged(join(outDir, "MAP.json"), renderMap(graph), written, skipped);
  await writeIfChanged(join(outDir, "ENTRYPOINTS.md"), renderEntrypoints(graph), written, skipped);
  await writeIfChanged(join(outDir, "HOTSPOTS.md"), renderHotspots(graph), written, skipped);
  await writeIfChanged(join(outDir, "manifest.json"), renderManifest(graph), written, skipped);

  const packagesDir = join(outDir, "PACKAGES");
  await mkdir(packagesDir, { recursive: true });
  for (const page of renderPackagePages(graph)) {
    await writeIfChanged(join(packagesDir, page.filename), page.content, written, skipped);
  }

  const flowsDir = join(outDir, "FLOWS");
  await mkdir(flowsDir, { recursive: true });
  for (const page of renderFlowPages(graph.flows)) {
    const path = join(flowsDir, page.filename);
    const existing = await readTextIfExists(path);
    if (!page.shouldWrite(existing)) {
      skipped.push(path);
      continue;
    }
    const merged = page.merge(existing);
    await writeIfChanged(path, merged, written, skipped);
  }

  await installClaude({ root });

  return { graph, outDir, written, skipped };
}

async function writeIfChanged(path: string, content: string, written: string[], skipped: string[]): Promise<void> {
  const existing = await readTextIfExists(path);
  if (existing === content) {
    skipped.push(path);
    return;
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
  written.push(path);
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

export { buildGraph } from "./graph.js";
export { installClaude } from "./claude.js";
export { renderIndex } from "./renderers/index.js";
export { renderPackagePages } from "./renderers/package.js";
export { renderFlowPages } from "./renderers/flows.js";
export { renderEntrypoints } from "./renderers/entrypoints.js";
export { renderHotspots } from "./renderers/hotspots.js";
export { renderMap } from "./renderers/map.js";
export { renderManifest } from "./renderers/manifest.js";
export { scan } from "./scanner.js";
export { detectWorkspace } from "./workspace.js";
export { parseFrontmatter, upsertMarkedSection } from "./preserve.js";
export type {
  BuildOptions,
  FileRecord,
  GraphEdge,
  GraphNode,
  ScanResult,
  Skelograph,
  FlowSpec,
  WorkspaceInfo,
  PackageInfo,
  EntryPoint,
} from "./types.js";

