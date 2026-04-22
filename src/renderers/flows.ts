import type { FlowSpec } from "../types.js";
import { preserveUserNotes, userNotesBlock, parseFrontmatter, writeFrontmatter } from "../preserve.js";

export interface FlowPage {
  filename: string;
  content: string;
  shouldWrite: (existing: string | undefined) => boolean;
  merge: (existing: string | undefined) => string;
}

export function renderFlowPages(flows: FlowSpec[]): FlowPage[] {
  return flows.map((flow) => {
    const filename = `${flow.name}.md`;
    const freshContent = renderFlow(flow);
    return {
      filename,
      content: freshContent,
      shouldWrite: (existing) => {
        if (!existing) return true;
        const fm = parseFrontmatter(existing);
        return fm.generated;
      },
      merge: (existing) => {
        if (!existing) return freshContent;
        const fm = parseFrontmatter(existing);
        if (!fm.generated) return existing;
        return preserveUserNotes(freshContent, fm.body);
      },
    };
  });
}

function renderFlow(flow: FlowSpec): string {
  const body: string[] = [];
  body.push(`# ${flow.title}`);
  body.push("");

  body.push("## Trigger");
  body.push("");
  body.push(flow.trigger);
  body.push("");

  body.push("## Preconditions");
  body.push("");
  for (const precondition of flow.preconditions) body.push(`- ${precondition}`);
  body.push("");

  body.push("## Steps");
  body.push("");
  flow.steps.forEach((step, index) => {
    const pkg = step.packageName ? ` (\`${step.packageName}\`)` : "";
    const symbol = step.symbol ? ` — \`${step.symbol}\`` : "";
    const desc = step.description ? ` — ${step.description}` : "";
    body.push(`${index + 1}. **${step.filePath}**${pkg}${symbol}${desc}`);
  });
  body.push("");

  body.push("## Decision Points");
  body.push("");
  for (const decision of flow.decisionPoints) {
    const location = decision.filePath && decision.line ? ` (\`${decision.filePath}:${decision.line}\`)` : "";
    body.push(`- ${decision.description}${location}`);
  }
  body.push("");

  body.push("## Failure Paths");
  body.push("");
  for (const failure of flow.failurePaths) body.push(`- ${failure.description}`);
  body.push("");

  body.push("## Related");
  body.push("");
  if (flow.related.length === 0) {
    body.push("_None detected._");
  } else {
    for (const related of flow.related) {
      // Prose entries (e.g., "Called by page: `/pricing ← ...`") are already
      // formatted; only wrap plain file-path strings in markdown links.
      if (/^FLOWS\//.test(related) || /\.md$/.test(related)) {
        body.push(`- [${related}](${related})`);
      } else {
        body.push(`- ${related}`);
      }
    }
  }
  body.push("");

  body.push("## Notes");
  body.push("");
  body.push(userNotesBlock());
  body.push("");

  const frontmatter = {
    name: flow.name,
    generated: "true",
    entry: flow.entry.filePath,
  };

  return writeFrontmatter(frontmatter, body.join("\n"));
}
