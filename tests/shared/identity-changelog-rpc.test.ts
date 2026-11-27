import { describe, expect, test } from 'bun:test';

import { changelogBlocks, changelogSection } from '@mcp-gateway/shared/changelog';
import { appNameFor, PRODUCTION_IDENTIFIER, TEST_IDENTIFIER } from '@mcp-gateway/shared/identity';
import { type LoginStatus, needsLoginRetry } from '@mcp-gateway/shared/rpc';

describe('identity', () => {
  test('appNameFor returns dev app name only for the test identifier', () => {
    expect(appNameFor(PRODUCTION_IDENTIFIER)).toBe('MCP Gateway');
    expect(appNameFor(TEST_IDENTIFIER)).toBe('MCP Gateway Dev');
    expect(appNameFor('other')).toBe('MCP Gateway');
  });
});

describe('changelog', () => {
  const sampleChangelog = [
    '# Changelog',
    '',
    '## [Unreleased]',
    '',
    '### Added',
    '- Pending item',
    '',
    '## [0.8.3] - 2026-11-24',
    '',
    '### Added',
    '- Middle release feature',
    '',
    '## [0.8.2] - 2026-11-20',
    '',
    '### Fixed',
    '- Oldest release fix',
    '',
    '[Unreleased]: https://example.com/compare/v0.8.3...HEAD',
    '[0.8.3]: https://example.com/compare/v0.8.2...v0.8.3',
    '[0.8.2]: https://example.com/releases/tag/v0.8.2',
  ].join('\n');

  test('changelogSection extracts the exact body for a middle version up to the next heading', () => {
    expect(changelogSection(sampleChangelog, '0.8.3')).toBe(
      ['### Added', '- Middle release feature'].join('\n'),
    );
  });

  test('changelogSection extracts the oldest version section terminated by link definitions', () => {
    expect(changelogSection(sampleChangelog, '0.8.2')).toBe(
      ['### Fixed', '- Oldest release fix'].join('\n'),
    );
  });

  test('changelogSection extracts the final version section when there are no trailing link definitions', () => {
    const withoutFooterLinks = [
      '# Changelog',
      '',
      '## [0.9.0] - 2026-11-27',
      '',
      '### Added',
      '- Final release without link footer',
    ].join('\n');

    expect(changelogSection(withoutFooterLinks, '0.9.0')).toBe(
      ['### Added', '- Final release without link footer'].join('\n'),
    );
  });

  test('changelogSection escapes dots in the version string', () => {
    const decoyChangelog = ['## [0X8X0] - 2026-11-18', '', '### Added', '- Wrong match'].join('\n');
    expect(changelogSection(decoyChangelog, '0.8.0')).toBeNull();
  });

  test('changelogSection returns null when version is missing or only has an undated heading', () => {
    expect(changelogSection(sampleChangelog, '9.9.9')).toBeNull();
    expect(changelogSection(sampleChangelog, 'Unreleased')).toBeNull();

    const undated = ['## [0.9.0]', '', '### Added', '- Undated entry'].join('\n');
    expect(changelogSection(undated, '0.9.0')).toBeNull();
  });

  test('changelogBlocks parses headings, list items, continuation lines, and paragraphs', () => {
    const section = [
      '  indented line without preceding list',
      '### Added',
      '  indented line after heading',
      'second line of intro',
      '',
      '- First item',
      '  continued text',
      '- Second item',
      '',
      'Closing note after list',
      'with a second line.',
      '### Fixed',
      'Paragraph after heading.',
    ].join('\n');

    expect(changelogBlocks(section)).toEqual([
      { kind: 'paragraph', text: 'indented line without preceding list' },
      { kind: 'heading', text: 'Added' },
      { kind: 'paragraph', text: 'indented line after heading second line of intro' },
      { kind: 'list', items: ['First item continued text', 'Second item'] },
      { kind: 'paragraph', text: 'Closing note after list with a second line.' },
      { kind: 'heading', text: 'Fixed' },
      { kind: 'paragraph', text: 'Paragraph after heading.' },
    ]);
  });
});

describe('rpc', () => {
  test('needsLoginRetry evaluates supported, error, and enabled !== wanted truth table', () => {
    const cases: Array<[LoginStatus, boolean, boolean]> = [
      [{ supported: false, enabled: false, error: null }, true, false],
      [{ supported: false, enabled: true, error: 'Registration failed' }, true, false],
      [{ supported: true, enabled: true, error: 'SMAppService error' }, true, true],
      [{ supported: true, enabled: false, error: 'SMAppService error' }, false, true],
      [{ supported: true, enabled: false, error: null }, true, true],
      [{ supported: true, enabled: true, error: null }, false, true],
      [{ supported: true, enabled: true, error: null }, true, false],
      [{ supported: true, enabled: false, error: null }, false, false],
    ];

    for (const [status, wanted, expected] of cases) {
      expect(needsLoginRetry(status, wanted)).toBe(expected);
    }
  });
});
