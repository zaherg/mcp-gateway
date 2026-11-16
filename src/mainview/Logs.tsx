import { useEffect, useRef, useState } from 'react';

import { Button } from '@mcp-gateway/mainview/components/mac/button';
import { Input } from '@mcp-gateway/mainview/components/mac/input';
import { Label } from '@mcp-gateway/mainview/components/mac/label';
import {
  NativeSelect,
  NativeSelectOption,
} from '@mcp-gateway/mainview/components/mac/native-select';
import { Alert } from '@mcp-gateway/mainview/components/ui';
import { useI18n } from '@mcp-gateway/mainview/i18n';
import type { AppClient } from '@mcp-gateway/shared/rpc';
import { LOG_LEVELS, LOG_LIMITS, type LogEntry, type LogLevel } from '@mcp-gateway/shared/types';

// Bounds the wait only. Callers discard a late answer with their own cancelled and generation checks.
const logRequest = async <T,>(pending: Promise<T>): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('Local log request timed out.')),
          LOG_LIMITS.requestTimeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

// Each entry is measured once, when it first reaches the trimming step.
const encoder = new TextEncoder();
const entrySizes = new WeakMap<LogEntry, number>();
const entrySize = (entry: LogEntry): number => {
  let size = entrySizes.get(entry);
  if (size === undefined) {
    size = encoder.encode(JSON.stringify(entry)).byteLength + 1;
    entrySizes.set(entry, size);
  }
  return size;
};

const FILTER = 'grid min-w-35 flex-1 gap-1.5';

interface Logs {
  client: AppClient;
  servers: string[];
}

export const Logs = ({ client, servers }: Logs) => {
  const { t } = useI18n();
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [level, setLevel] = useState<LogLevel | ''>('');
  const [server, setServer] = useState('');
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [clearError, setClearError] = useState<string | null>(null);
  const [gap, setGap] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [epoch, setEpoch] = useState(0);
  const requestGeneration = useRef(0);
  const cursor = useRef(0);
  const bufferGeneration = useRef<number | undefined>(undefined);
  // biome-ignore lint/correctness/useExhaustiveDependencies: A successful clear must invalidate pending reads even when clearing state is batched.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const generation = ++requestGeneration.current;
    cursor.current = 0;
    bufferGeneration.current = undefined;
    setEntries([]);
    setError(null);
    const poll = async () => {
      try {
        const result = await logRequest(client.readLogs({ after: cursor.current }));
        if (cancelled || generation !== requestGeneration.current) return;
        if (!result.ok) {
          setError(`${result.error.code}: ${result.error.message}`);
          return;
        }
        const page = result.value;
        const reset = page.generation !== bufferGeneration.current;
        bufferGeneration.current = page.generation;
        cursor.current = page.cursor;
        if (page.gap) setGap(true);
        if (reset || page.entries.length > 0)
          setEntries((previous) => {
            const all = [...(reset ? [] : previous), ...page.entries];
            let bytes = 2;
            let start = all.length;
            while (start > 0 && all.length - start < LOG_LIMITS.entries) {
              const size = entrySize(all[start - 1]);
              if (bytes + size > LOG_LIMITS.bytes) break;
              bytes += size;
              start--;
            }
            if (start > 0) setGap(true);
            return all.slice(start);
          });
        setError(null);
        timer = setTimeout(poll, page.hasMore ? 0 : 2000);
      } catch {
        if (!cancelled && generation === requestGeneration.current) setError(t('logs.readFailed'));
      }
    };
    if (!clearing) void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [client, epoch, clearing]);

  const clear = async () => {
    requestGeneration.current++;
    setClearing(true);
    setClearError(null);
    try {
      const result = await logRequest(client.clearLogs());
      if (!result.ok) {
        setClearError(`${result.error.code}: ${result.error.message}`);
        return;
      }
      setEntries([]);
      setGap(false);
      setEpoch((value) => value + 1);
    } catch {
      setClearError(t('logs.clearFailed'));
    } finally {
      setClearing(false);
    }
  };
  const filtered = entries.filter(
    (entry) =>
      (!level || entry.level === level) &&
      (!server || entry.server === server) &&
      entry.text.toLowerCase().includes(text.toLowerCase()),
  );
  return (
    <section className="panel logs-panel" aria-label={t('logs.title')}>
      <div className="section-heading">
        <div>
          <h2>{t('logs.title')}</h2>
          <p>{t('logs.intro')}</p>
        </div>
        <Button onClick={() => void clear()} disabled={clearing}>
          {t('logs.clear')}
        </Button>
      </div>
      <p className="log-warning">
        <strong>{t('logs.sensitiveTitle')}</strong> {t('logs.sensitiveBody')}
      </p>
      <p className="fine-print">
        {t('logs.limits', {
          entries: LOG_LIMITS.entries,
          megabytes: LOG_LIMITS.bytes / 1024 / 1024,
          kilobytes: LOG_LIMITS.entryBytes / 1024,
        })}
      </p>
      <div className="log-filters">
        <Label className={FILTER}>
          {t('logs.level')}
          <NativeSelect
            aria-label={t('logs.level')}
            value={level}
            onChange={(event) =>
              setLevel(LOG_LEVELS.find((level) => level === event.target.value) ?? '')
            }
          >
            <NativeSelectOption value="">{t('logs.allLevels')}</NativeSelectOption>
            {LOG_LEVELS.map((value) => (
              <NativeSelectOption key={value}>{value}</NativeSelectOption>
            ))}
          </NativeSelect>
        </Label>
        <Label className={FILTER}>
          {t('logs.server')}
          <NativeSelect
            aria-label={t('logs.server')}
            value={server}
            onChange={(event) => setServer(event.target.value)}
          >
            <NativeSelectOption value="">{t('logs.allServers')}</NativeSelectOption>
            {Array.from(
              new Set([
                ...servers,
                ...entries.flatMap((entry) => (entry.server ? [entry.server] : [])),
              ]),
            )
              .sort()
              .map((value) => (
                <NativeSelectOption key={value}>{value}</NativeSelectOption>
              ))}
          </NativeSelect>
        </Label>
        <Label className={FILTER}>
          {t('logs.search')}
          <Input
            aria-label={t('logs.search')}
            value={text}
            maxLength={LOG_LIMITS.queryTextCharacters}
            onChange={(event) => setText(event.target.value)}
          />
        </Label>
      </div>
      {error && <Alert onDismiss={() => setError(null)}>{error}</Alert>}
      {clearError && <Alert onDismiss={() => setClearError(null)}>{clearError}</Alert>}
      {gap && <p role="status">{t('logs.gap')}</p>}
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: The bounded scroll region needs keyboard scrolling. */}
      <section className="log-entries" tabIndex={0} aria-label={t('logs.entries')}>
        {filtered.length ? (
          filtered.map((entry) => (
            <article key={entry.id} className="log-entry">
              <div className="log-meta">
                <time>{entry.time}</time> · #{entry.id} · {entry.server ?? t('logs.appSource')} ·{' '}
                {entry.level} · {entry.source}
                {entry.truncated ? ` · ${t('logs.truncated')}` : ''}
              </div>
              <pre>{entry.text}</pre>
            </article>
          ))
        ) : (
          <p className="empty-state">{entries.length ? t('logs.noMatches') : t('logs.empty')}</p>
        )}
      </section>
    </section>
  );
};
