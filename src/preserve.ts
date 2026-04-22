export interface Frontmatter {
  generated: boolean;
  raw: string;
  body: string;
  fields: Record<string, string>;
}

export function parseFrontmatter(content: string): Frontmatter {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
  if (!match) {
    return { generated: false, raw: "", body: content, fields: {} };
  }
  const raw = match[1];
  const body = content.slice(match[0].length);
  const fields: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const fieldMatch = /^([A-Za-z0-9_-]+)\s*:\s*(.+?)\s*$/.exec(line);
    if (fieldMatch) fields[fieldMatch[1]] = fieldMatch[2];
  }
  const generatedValue = fields.generated;
  const generated = generatedValue === "true";
  return { generated, raw, body, fields };
}

export function isGeneratedFile(content: string): boolean {
  return parseFrontmatter(content).generated;
}

export function writeFrontmatter(fields: Record<string, string>, body: string): string {
  const lines = ["---"];
  for (const [key, value] of Object.entries(fields)) {
    lines.push(`${key}: ${value}`);
  }
  lines.push("---");
  return `${lines.join("\n")}\n\n${body.trimStart()}`;
}

const USER_NOTES_START = "<!-- user-notes:start -->";
const USER_NOTES_END = "<!-- user-notes:end -->";

export function preserveUserNotes(nextBody: string, previousBody: string | undefined): string {
  if (!previousBody) return nextBody;
  const match = new RegExp(`${USER_NOTES_START}([\\s\\S]*?)${USER_NOTES_END}`).exec(previousBody);
  if (!match) return nextBody;
  const preserved = match[1];
  return nextBody.replace(
    new RegExp(`${USER_NOTES_START}[\\s\\S]*?${USER_NOTES_END}`),
    `${USER_NOTES_START}${preserved}${USER_NOTES_END}`,
  );
}

export function userNotesBlock(placeholder: string = "\n_User edits below are preserved across regeneration._\n"): string {
  return `${USER_NOTES_START}${placeholder}${USER_NOTES_END}`;
}

const MARKER_START = "<!-- skelograph:start -->";
const MARKER_END = "<!-- skelograph:end -->";

export interface UpsertOptions {
  placement?: "top" | "bottom";
}

export function upsertMarkedSection(
  existing: string,
  section: string,
  options: UpsertOptions = {},
): string {
  const placement = options.placement ?? "bottom";
  const fenced = `${MARKER_START}\n${section.trim()}\n${MARKER_END}`;
  if (!existing || existing.trim().length === 0) {
    return `${fenced}\n`;
  }
  const normalized = existing.replace(/\s+$/u, "");
  const start = normalized.indexOf(MARKER_START);
  const end = normalized.indexOf(MARKER_END);

  if (start >= 0 && end > start) {
    const before = normalized.slice(0, start).trimEnd();
    const after = normalized.slice(end + MARKER_END.length).trimStart();
    return [before, fenced, after].filter(Boolean).join("\n\n") + "\n";
  }

  if (placement === "top") {
    const headingMatch = /^(#\s.*?\r?\n)/.exec(normalized);
    if (headingMatch) {
      const heading = headingMatch[1];
      const rest = normalized.slice(heading.length).trimStart();
      return `${heading}\n${fenced}\n\n${rest}\n`;
    }
    return `${fenced}\n\n${normalized}\n`;
  }

  return `${normalized}\n\n${fenced}\n`;
}
