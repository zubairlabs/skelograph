import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { scan } from "./scanner.js";
import { buildGraph } from "./graph.js";
import { renderReport } from "./report.js";
import type { BuildOptions, Skelograph } from "./types.js";

export interface BuildResult {
  graph: Skelograph;
  graphPath: string;
  reportPath: string;
}

export async function buildSkelograph(options: BuildOptions): Promise<BuildResult> {
  const root = resolve(options.root);
  const outDir = resolve(root, options.outDir ?? "skelograph-out");
  const scanResult = await scan(root, options.maxFileBytes);
  const graph = buildGraph(scanResult);
  const report = renderReport(graph);

  await mkdir(outDir, { recursive: true });
  const graphPath = resolve(outDir, "graph.json");
  const reportPath = resolve(outDir, "GRAPH_REPORT.md");
  await writeFile(graphPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");
  await writeFile(reportPath, report, "utf8");

  return { graph, graphPath, reportPath };
}

export { buildGraph } from "./graph.js";
export { installClaude } from "./claude.js";
export { renderReport } from "./report.js";
export { scan } from "./scanner.js";
export type { BuildOptions, FileRecord, GraphEdge, GraphNode, ScanResult, Skelograph } from "./types.js";
