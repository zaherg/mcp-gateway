import type { AppClient, AppResult, AppSnapshot } from '@mcp-gateway/shared/rpc';
import type { GatewaySnapshot } from '@mcp-gateway/shared/types';
import { ArrowUpRight, Network } from 'lucide-react';

type Run = (
  operation: () => Promise<AppResult<AppSnapshot | null>>,
  message: string,
  saved?: boolean,
) => Promise<boolean>;

/** Shown on every tab, above the draft bar. */
export const GatewayStrip = ({
  gateway,
  dirty,
  configurationLocked,
  run,
  client,
}: {
  gateway: GatewaySnapshot | undefined;
  dirty: boolean;
  configurationLocked: boolean;
  run: Run;
  client: AppClient;
}) => {
  return (
    <section className="gateway-strip panel" aria-label="Gateway status">
      <div className={`status-orb ${gateway?.running ? 'online' : ''}`}>
        <Network size={25} />
      </div>
      <div className="gateway-summary">
        <div className="inline">
          <h2>Gateway</h2>
          <span className={`badge ${gateway?.running ? 'teal' : ''}`}>
            {gateway?.running ? 'Running' : 'Stopped'}
          </span>
        </div>
        <p className="mono">
          {gateway?.running ? (gateway.address ?? 'Listener starting') : 'No active listener'}
        </p>
      </div>
      <div className="gateway-actions">
        <button
          type="button"
          className={gateway?.running ? 'button' : 'button primary'}
          disabled={configurationLocked || (!gateway?.running && (dirty || !!gateway?.configError))}
          onClick={() =>
            void run(
              () => (gateway?.running ? client.stop() : client.start()),
              gateway?.running ? 'Gateway stopped.' : 'Gateway started.',
            )
          }
        >
          {gateway?.running ? 'Stop gateway' : 'Start gateway'}
          <ArrowUpRight size={15} />
        </button>
      </div>
    </section>
  );
};
