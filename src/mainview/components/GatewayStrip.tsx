import { Button } from '@mcp-gateway/mainview/components/mac/button';
import type { AppClient, AppResult, AppSnapshot } from '@mcp-gateway/shared/rpc';
import type { GatewaySnapshot } from '@mcp-gateway/shared/types';

type Run = (
  operation: () => Promise<AppResult<AppSnapshot | null>>,
  message: string,
  saved?: boolean,
) => Promise<boolean>;

interface GatewayStrip {
  gateway: GatewaySnapshot | undefined;
  dirty: boolean;
  configurationLocked: boolean;
  run: Run;
  client: AppClient;
}

// Shown on every tab, above the draft bar. The address is the one figure the page leads with.
export const GatewayStrip = ({
  gateway,
  dirty,
  configurationLocked,
  run,
  client,
}: GatewayStrip) => {
  const running = gateway?.running ?? false;
  return (
    <section className="listener panel" aria-label="Gateway status">
      <div className="listener-body">
        <div className="listener-label">
          <span className={`led ${running ? 'on' : ''}`} />
          <strong>Gateway</strong>
          <span>{running ? 'Running' : 'Stopped'}</span>
        </div>
        <p className={running ? 'listener-address' : 'listener-address idle'}>
          {running ? (gateway?.address ?? 'Starting listener') : 'No active listener'}
        </p>
      </div>
      <div className="listener-actions">
        <Button
          variant={running ? 'secondary' : 'default'}
          disabled={configurationLocked || (!running && (dirty || !!gateway?.configError))}
          onClick={() =>
            void run(
              () => (running ? client.stop() : client.start()),
              running ? 'Gateway stopped.' : 'Gateway started.',
            )
          }
        >
          {running ? 'Stop gateway' : 'Start gateway'}
        </Button>
      </div>
    </section>
  );
};
