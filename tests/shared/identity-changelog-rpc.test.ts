import { describe, expect, test } from 'bun:test';

import { changelogBlocks, changelogSection } from '@mcp-gateway/shared/changelog';
import { appNameFor, PRODUCTION_IDENTIFIER, TEST_IDENTIFIER } from '@mcp-gateway/shared/identity';
import { type LoginStatus, needsLoginRetry, SOCIAL_LINK_TARGETS } from '@mcp-gateway/shared/rpc';
import { LOG_LEVELS, LOG_LIMITS } from '@mcp-gateway/shared/types';

describe('identity', () => {
  test('exports stable production and test bundle identifiers', () => {
    expect(PRODUCTION_IDENTIFIER).toBe('dev.srvr.mcpgateway');
    expect(TEST_IDENTIFIER).toBe('dev.srvr.mcpgateway.test');
  });

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
      '### Added',
      'First line of intro',
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
      { kind: 'heading', text: 'Added' },
      { kind: 'paragraph', text: 'First line of intro second line of intro' },
      { kind: 'list', items: ['First item continued text', 'Second item'] },
      { kind: 'paragraph', text: 'Closing note after list with a second line.' },
      { kind: 'heading', text: 'Fixed' },
      { kind: 'paragraph', text: 'Paragraph after heading.' },
    ]);
  });
});

describe('rpc and shared constants', () => {
  test('needsLoginRetry returns false whenever status.supported is false', () => {
    const cases: Array<[LoginStatus, boolean]> = [
      [{ supported: false, enabled: false, error: null }, true],
      [{ supported: false, enabled: true, error: null }, false],
      [{ supported: false, enabled: false, error: 'Registration failed' }, false],
      [{ supported: false, enabled: true, error: 'Registration failed' }, true],
    ];
    for (const [status, wanted] of cases) {
      expect(needsLoginRetry(status, wanted)).toBe(false);
    }
  });

  test('needsLoginRetry returns true when supported and error is non-null even if enabled matches wanted', () => {
    expect(
      needsLoginRetry({ supported: true, enabled: true, error: 'SMAppService error' }, true),
    ).toBe(true);
    expect(
      needsLoginRetry({ supported: true, enabled: false, error: 'SMAppService error' }, false),
    ).toBe(true);
  });

  test('needsLoginRetry returns true when supported, error is null, and enabled differs from wanted', () => {
    expect(needsLoginRetry({ supported: true, enabled: false, error: null }, true)).toBe(true);
    expect(needsLoginRetry({ supported: true, enabled: true, error: null }, false)).toBe(true);
  });

  test('needsLoginRetry returns false when supported, error is null, and enabled matches wanted', () => {
    expect(needsLoginRetry({ supported: true, enabled: true, error: null }, true)).toBe(false);
    expect(needsLoginRetry({ supported: true, enabled: false, error: null }, false)).toBe(false);
  });

  test('SOCIAL_LINK_TARGETS, LOG_LIMITS, and LOG_LEVELS match expected invariants', () => {
    expect(SOCIAL_LINK_TARGETS).toEqual(['docs', 'github', 'x']);
    expect(Object.isFrozen(LOG_LIMITS)).toBe(true);
    expect(LOG_LIMITS).toEqual({
      entries: 500,
      bytes: 4 * 1024 * 1024,
      entryBytes: 32 * 1024,
      batchEntries: 50,
      batchBytes: 256 * 1024,
      requestTimeoutMs: 10_000,
      queryTextCharacters: 512,
    });
    expect(LOG_LEVELS).toEqual(['debug', 'info', 'warn', 'error']);
  });
});
