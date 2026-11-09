import { Network } from 'lucide-react';

import { Badge } from '@mcp-gateway/mainview/components/mac/badge';
import { Button } from '@mcp-gateway/mainview/components/mac/button';
import type { AppClient, AppResult, AppSnapshot } from '@mcp-gateway/shared/rpc';
import type { GatewaySnapshot } from '@mcp-gateway/shared/types';

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
          <Badge variant={gateway?.running ? 'accent' : 'secondary'}>
            {gateway?.running ? 'Running' : 'Stopped'}
          </Badge>
        </div>
        <p className="mono">
          {gateway?.running ? (gateway.address ?? 'Listener starting') : 'No active listener'}
        </p>
      </div>
      <div className="gateway-actions">
        <Button
          variant={gateway?.running ? 'secondary' : 'default'}
          disabled={configurationLocked || (!gateway?.running && (dirty || !!gateway?.configError))}
          onClick={() =>
            void run(
              () => (gateway?.running ? client.stop() : client.start()),
              gateway?.running ? 'Gateway stopped.' : 'Gateway started.',
            )
          }
        >
          {gateway?.running ? 'Stop gateway' : 'Start gateway'}
        </Button>
      </div>
    </section>
  );
};
