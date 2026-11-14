/** One block of a changelog section: the Markdown subset that CHANGELOG.md uses. */
export type ChangelogBlock =
  | { kind: 'heading' | 'paragraph'; text: string }
  | { kind: 'list'; items: string[] };

/** The body of the dated `## [version] - YYYY-MM-DD` section, or null when there is none. */
export const changelogSection = (changelog: string, version: string): string | null => {
  const heading = new RegExp(
    `^## \\[${version.replaceAll('.', '\\.')}\\] - \\d{4}-\\d{2}-\\d{2}$`,
    'm',
  ).exec(changelog);
  if (!heading) return null;
  const rest = changelog.slice(heading.index + heading[0].length);
  // The oldest section is followed by the link definitions, not by another heading.
  const next = /^(?:## \[|\[[^\]\n]+\]: )/m.exec(rest);
  return (next ? rest.slice(0, next.index) : rest).trim();
};

/** Splits a section into `###` headings, `- ` lists with indented continuation lines, and paragraphs. */
export const changelogBlocks = (section: string): ChangelogBlock[] => {
  const blocks: ChangelogBlock[] = [];
  for (const line of section.split('\n')) {
    const last = blocks.at(-1);
    if (line.startsWith('### ')) blocks.push({ kind: 'heading', text: line.slice(4).trim() });
    else if (line.startsWith('- ')) {
      if (last?.kind === 'list') last.items.push(line.slice(2).trim());
      else blocks.push({ kind: 'list', items: [line.slice(2).trim()] });
    } else if (line.startsWith('  ') && last?.kind === 'list')
      last.items[last.items.length - 1] += ` ${line.trim()}`;
    else if (line.trim()) {
      if (last?.kind === 'paragraph') last.text += ` ${line.trim()}`;
      else blocks.push({ kind: 'paragraph', text: line.trim() });
    }
  }
  return blocks;
};
