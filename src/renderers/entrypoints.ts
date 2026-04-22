import type { Skelograph } from "../types.js";

export function renderEntrypoints(graph: Skelograph): string {
  const lines: string[] = [];
  lines.push("# Entry Points");
  lines.push("");
  lines.push("_Every real execution start in this project. For deeper traces, see FLOWS/._");
  lines.push("");

  if (graph.entryPoints.length === 0) {
    lines.push("_No entry points detected._");
    return lines.join("\n");
  }

  const groups = new Map<string, typeof graph.entryPoints>();
  for (const entry of graph.entryPoints) {
    const key = entry.kind;
    const existing = groups.get(key) ?? [];
    existing.push(entry);
    groups.set(key, existing);
  }

  const ordered = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  for (const [kind, entries] of ordered) {
    lines.push(`## ${kindHeading(kind)}`);
    lines.push("");
    for (const entry of entries) {
      const pkg = entry.packageName ? ` · \`${entry.packageName}\`` : "";
      const method = entry.httpMethod ? ` ${entry.httpMethod}` : "";
      const route = entry.routePath ? ` \`${entry.routePath}\`` : "";
      lines.push(`- **${entry.label}**${method}${route} — \`${entry.filePath}\`${pkg}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function kindHeading(kind: string): string {
  switch (kind) {
    case "sveltekit-server":
      return "SvelteKit server endpoints (`+server.ts`)";
    case "sveltekit-page-server":
      return "SvelteKit page loaders (`+page.server.ts`)";
    case "sveltekit-hooks":
      return "SvelteKit hooks";
    case "next-route":
      return "Next.js routes";
    case "next-middleware":
      return "Next.js middleware";
    case "express-app":
      return "Express apps";
    case "fastify-app":
      return "Fastify apps";
    case "websocket":
      return "WebSocket servers";
    case "queue-worker":
      return "Queue workers";
    case "cli-bin":
      return "CLI binaries";
    default:
      return kind;
  }
}
