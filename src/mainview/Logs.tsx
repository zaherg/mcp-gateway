import { ArrowDownToLine, Check, CircleHelp, Copy } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { Button } from '@mcp-gateway/mainview/components/mac/button';
import { Input } from '@mcp-gateway/mainview/components/mac/input';
import {
  NativeSelect,
  NativeSelectOption,
} from '@mcp-gateway/mainview/components/mac/native-select';
import { Alert } from '@mcp-gateway/mainview/components/ui';
import { useI18n } from '@mcp-gateway/mainview/i18n';
import type { AppClient } from '@mcp-gateway/shared/rpc';
import { LOG_LEVELS, LOG_LIMITS, type LogEntry, type LogLevel } from '@mcp-gateway/shared/types';

// Bounds the wait only. Callers discard a late answer with their own cancelled and generation checks.
const logRequest = async <T,>(pending: Promise<T>) => {
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
const entrySize = (entry: LogEntry) => {
  let size = entrySizes.get(entry);
  if (size === undefined) {
    size = encoder.encode(JSON.stringify(entry)).byteLength + 1;
    entrySizes.set(entry, size);
  }
  return size;
};

interface LogsProps {
  client: AppClient;
  servers: string[];
}

export const Logs = ({ client, servers }: LogsProps) => {
  const { t } = useI18n();
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [level, setLevel] = useState<LogLevel | ''>('');
  const [server, setServer] = useState('');
  const [text, setText] = useState('');
  const [followTail, setFollowTail] = useState(true);
  const [infoOpen, setInfoOpen] = useState(false);
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [clearError, setClearError] = useState<string | null>(null);
  const [gap, setGap] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [epoch, setEpoch] = useState(0);

  const searchInputRef = useRef<HTMLInputElement>(null);
  const scrollerRef = useRef<HTMLElement>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestGeneration = useRef(0);
  const cursor = useRef(0);
  const bufferGeneration = useRef<number | undefined>(undefined);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(
    () => () => {
      if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current);
    },
    [],
  );

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
      // A failed read retries at the normal pace instead of stopping the view.
      let delay = 2000;
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
        if (page.hasMore) delay = 0;
      } catch {
        if (!cancelled && generation === requestGeneration.current) setError(t('logs.readFailed'));
      } finally {
        if (!cancelled && generation === requestGeneration.current) timer = setTimeout(poll, delay);
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

  const latestFilteredId = filtered.at(-1)?.id;
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll when filtered length or latest entry changes while followTail is active.
  useEffect(() => {
    if (!followTail || !scrollerRef.current) return;
    scrollerRef.current.scrollTop = scrollerRef.current.scrollHeight;
  }, [followTail, filtered.length, latestFilteredId]);

  const handleScroll = () => {
    const el = scrollerRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= 16;
    if (!atBottom && followTail) {
      setFollowTail(false);
    } else if (atBottom && !followTail) {
      setFollowTail(true);
    }
  };

  const copyEntry = (entry: LogEntry) => {
    const source = entry.server ?? t('logs.appSource');
    const formatted = `${entry.time} [${entry.level.toUpperCase()}] [${source}] ${entry.text}`;
    void navigator.clipboard.writeText(formatted).then(() => {
      if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current);
      setCopiedId(entry.id);
      copyTimerRef.current = setTimeout(() => {
        copyTimerRef.current = null;
        setCopiedId((previous) => (previous === entry.id ? null : previous));
      }, 1_500);
    });
  };

  return (
    <section className="panel logs-panel" aria-label={t('logs.title')}>
      <div className="log-toolbar">
        <NativeSelect
          className="w-fit shrink-0"
          aria-label={t('logs.level')}
          value={level}
          onChange={(event) =>
            setLevel(LOG_LEVELS.find((item) => item === event.target.value) ?? '')
          }
        >
          <NativeSelectOption value="">{t('logs.allLevels')}</NativeSelectOption>
          {LOG_LEVELS.map((value) => (
            <NativeSelectOption key={value}>{value}</NativeSelectOption>
          ))}
        </NativeSelect>
        <NativeSelect
          className="w-fit max-w-44 shrink-0"
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
        <div className="min-w-28 flex-1">
          <Input
            ref={searchInputRef}
            aria-label={t('logs.search')}
            placeholder={`${t('logs.search')} (⌘F)`}
            value={text}
            maxLength={LOG_LIMITS.queryTextCharacters}
            onChange={(event) => setText(event.target.value)}
          />
        </div>
        <Button
          variant={followTail ? 'default' : 'secondary'}
          aria-pressed={followTail}
          onClick={() => {
            const next = !followTail;
            setFollowTail(next);
            if (next && scrollerRef.current) {
              scrollerRef.current.scrollTop = scrollerRef.current.scrollHeight;
            }
          }}
        >
          <ArrowDownToLine /> Follow Tail
        </Button>
        <Button onClick={() => void clear()} disabled={clearing}>
          {t('logs.clear')}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t('logs.sensitiveTitle')}
          aria-expanded={infoOpen}
          title={`${t('logs.sensitiveTitle')} ${t('logs.sensitiveBody')}`}
          onClick={() => setInfoOpen((previous) => !previous)}
        >
          <CircleHelp />
        </Button>
      </div>
      {infoOpen && (
        <div className="schema-popover mb-3">
          <p className="m-0 text-[12px] text-mac-label">
            <strong>{t('logs.sensitiveTitle')}</strong> {t('logs.sensitiveBody')}
          </p>
          <p className="m-0 mt-1 text-[11px] text-mac-label-secondary">
            {t('logs.limits', {
              entries: LOG_LIMITS.entries,
              megabytes: LOG_LIMITS.bytes / 1024 / 1024,
              kilobytes: LOG_LIMITS.entryBytes / 1024,
            })}
          </p>
        </div>
      )}
      {error && <Alert onDismiss={() => setError(null)}>{error}</Alert>}
      {clearError && <Alert onDismiss={() => setClearError(null)}>{clearError}</Alert>}
      {gap && (
        <p role="status" className="mb-2 text-[12px] text-mac-label-secondary">
          {t('logs.gap')}
        </p>
      )}
      <section
        ref={scrollerRef}
        onScroll={handleScroll}
        className="log-entries"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: The bounded scroll region needs keyboard scrolling.
        tabIndex={0}
        aria-label={t('logs.entries')}
      >
        {filtered.length ? (
          <div className="log-table">
            {filtered.map((entry) => {
              const copied = copiedId === entry.id;
              return (
                <div key={entry.id} className="log-row">
                  <div className="log-row-header">
                    <time className="log-time">{entry.time}</time>
                    <span className={`log-level-pill ${entry.level}`}>{entry.level}</span>
                    <span className="log-source">{entry.server ?? t('logs.appSource')}</span>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="ml-auto"
                      aria-label="Copy log entry"
                      onClick={() => copyEntry(entry)}
                    >
                      {copied ? <Check /> : <Copy />}
                    </Button>
                  </div>
                  <div className="log-message">
                    {entry.text}
                    {entry.truncated ? ` (${t('logs.truncated')})` : ''}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="empty-state">{entries.length ? t('logs.noMatches') : t('logs.empty')}</p>
        )}
      </section>
    </section>
  );
};
