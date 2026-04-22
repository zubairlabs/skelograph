import type { Skelograph } from "../types.js";

export function renderHotspots(graph: Skelograph): string {
  const lines: string[] = [];
  lines.push("# Hotspots");
  lines.push("");
  lines.push("_Load-bearing pieces. Touching these affects many other places._");
  lines.push("");

  lines.push("## Most-Referenced Files");
  lines.push("");
  if (graph.hotspots.topFiles.length === 0) {
    lines.push("_No internal import edges detected._");
  } else {
    for (const item of graph.hotspots.topFiles) {
      lines.push(`- \`${item.filePath}\` — imported by ${item.incoming} file${item.incoming === 1 ? "" : "s"}`);
    }
  }
  lines.push("");

  lines.push("## Most-Depended-On Packages");
  lines.push("");
  if (graph.hotspots.topPackages.length === 0) {
    lines.push("_No cross-package dependencies detected._");
  } else {
    for (const item of graph.hotspots.topPackages) {
      lines.push(`- \`${item.packageName}\` — imported across ${item.incoming} cross-package edge${item.incoming === 1 ? "" : "s"}`);
    }
  }
  lines.push("");

  lines.push("## Largest Public API Surfaces");
  lines.push("");
  if (graph.hotspots.largestApiSurfaces.length === 0) {
    lines.push("_No public exports detected._");
  } else {
    for (const item of graph.hotspots.largestApiSurfaces) {
      lines.push(`- \`${item.packageName}\` — ${item.publicSymbols} public symbol${item.publicSymbols === 1 ? "" : "s"}`);
    }
  }
  lines.push("");

  return lines.join("\n");
}
