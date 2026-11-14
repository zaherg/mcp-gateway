import type { ReactNode, RefObject } from 'react';

import { Button } from '@mcp-gateway/mainview/components/mac/button';
import { Modal } from '@mcp-gateway/mainview/components/ui';
import { changelogBlocks, changelogSection } from '@mcp-gateway/shared/changelog';
// Bundled at build time, so the notes always belong to this build.
import changelog from '../../../CHANGELOG.md?raw';

const INLINE = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/;

/** Renders inline code and bold; a link keeps its text only, because the window cannot navigate. */
const inline = (text: string): ReactNode[] => {
  let offset = 0;
  return text.split(INLINE).map((part) => {
    // The character offset is unique within the line, unlike the text of a repeated code span.
    const key = offset;
    offset += part.length;
    if (part.startsWith('`')) return <code key={key}>{part.slice(1, -1)}</code>;
    if (part.startsWith('**')) return <strong key={key}>{part.slice(2, -2)}</strong>;
    if (part.startsWith('[') && part.endsWith(')')) return part.slice(1, part.indexOf(']('));
    return part;
  });
};

interface WhatsNew {
  version: string;
  onClose: () => void;
  fallbackFocus: RefObject<HTMLElement | null>;
}

export const WhatsNew = ({ version, onClose, fallbackFocus }: WhatsNew) => {
  const section = changelogSection(changelog, version);
  if (!section) return null;
  return (
    <Modal title={`What's new in ${version}`} onClose={onClose} fallbackFocus={fallbackFocus}>
      <div className="whats-new">
        {changelogBlocks(section).map((block) =>
          block.kind === 'list' ? (
            <ul key={block.items[0]}>
              {block.items.map((item) => (
                <li key={item}>{inline(item)}</li>
              ))}
            </ul>
          ) : block.kind === 'heading' ? (
            <h3 key={block.text}>{block.text}</h3>
          ) : (
            <p key={block.text}>{inline(block.text)}</p>
          ),
        )}
      </div>
      <div className="dialog-actions">
        <Button variant="default" onClick={onClose}>
          Done
        </Button>
      </div>
    </Modal>
  );
};
