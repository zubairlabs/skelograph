import type { Skelograph } from "../types.js";
import { packageFileName } from "./index.js";

export function renderManifest(graph: Skelograph): string {
  const manifest = {
    generatedAt: graph.metadata.generatedAt,
    schemaVersion: graph.metadata.schemaVersion,
    projectType: graph.workspace.kind,
    rootPackageName: graph.workspace.rootPackageName,
    packages: graph.workspace.packages.map((pkg) => ({
      name: pkg.name,
      relativePath: pkg.relativePath,
      page: `PACKAGES/${packageFileName(pkg)}.md`,
      framework: pkg.framework,
    })),
    flows: graph.flows.map((flow) => ({
      name: flow.name,
      title: flow.title,
      entry: flow.entry.filePath,
      page: `FLOWS/${flow.name}.md`,
    })),
    entryPoints: graph.entryPoints.length,
    stats: graph.stats,
  };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}
