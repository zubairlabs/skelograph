import type { Skelograph } from "./types.js";

export function renderReport(graph: Skelograph): string {
  const fileCount = graph.nodes.filter((node) => node.kind === "file").length;
  const symbolCount = graph.nodes.filter((node) => node.kind === "symbol").length;
  const externalCount = graph.nodes.filter((node) => node.kind === "external").length;
  const imports = graph.edges.filter((edge) => edge.relation === "imports");
  const ambiguousImports = imports.filter((edge) => edge.confidence === "AMBIGUOUS").length;
  const topFiles = graph.nodes
    .filter((node) => node.kind === "file")
    .sort((a, b) => (b.lineCount ?? 0) - (a.lineCount ?? 0))
    .slice(0, 10);

  const languageRows = Object.entries(graph.stats.languages)
    .sort((a, b) => b[1] - a[1])
    .map(([language, count]) => `- ${language}: ${count}`);

  const lines = [
    `# Skelograph Report`,
    "",
    `Generated: ${graph.metadata.generatedAt}`,
    `Root: ${graph.metadata.root}`,
    "",
    "## Summary",
    "",
    `- Files: ${fileCount}`,
    `- Symbols: ${symbolCount}`,
    `- Import edges: ${imports.length}`,
    `- External or unresolved imports: ${externalCount}`,
    `- Ambiguous import edges: ${ambiguousImports}`,
    `- Total lines: ${graph.stats.totalLines}`,
    "",
    "## Languages",
    "",
    ...(languageRows.length ? languageRows : ["- None detected"]),
    "",
    "## Largest Files",
    "",
    ...(topFiles.length
      ? topFiles.map((node) => `- ${node.sourcePath}: ${node.lineCount ?? 0} lines`)
      : ["- None"]),
    "",
    "## Trust Notes",
    "",
    "- skelograph did not execute source files.",
    "- skelograph did not make network calls during analysis.",
    "- Edges marked AMBIGUOUS usually point to external packages or imports that v0 could not resolve locally.",
    "",
  ];

  if (graph.stats.skippedSensitive || graph.stats.skippedLarge || graph.stats.skippedIgnored) {
    lines.push("## Skipped");
    lines.push("");
    lines.push(`- Ignored paths: ${graph.stats.skippedIgnored}`);
    lines.push(`- Sensitive files: ${graph.stats.skippedSensitive}`);
    lines.push(`- Large files: ${graph.stats.skippedLarge}`);
    lines.push("");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}
