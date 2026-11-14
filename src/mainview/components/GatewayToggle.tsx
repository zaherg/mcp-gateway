import { Button } from '@mcp-gateway/mainview/components/mac/button';
import type { AppClient, AppResult, AppSnapshot } from '@mcp-gateway/shared/rpc';
import type { GatewaySnapshot } from '@mcp-gateway/shared/types';

type Run = (
  operation: () => Promise<AppResult<AppSnapshot | null>>,
  message: string,
  saved?: boolean,
) => Promise<boolean>;

interface GatewayToggle {
  gateway: GatewaySnapshot | undefined;
  dirty: boolean;
  configurationLocked: boolean;
  run: Run;
  client: AppClient;
}

// Rendered in the page heading on every tab, outside the workspace fieldset that disables
// controls while an operation runs, so the caller must fold `busy` into `configurationLocked`.
export const GatewayToggle = ({
  gateway,
  dirty,
  configurationLocked,
  run,
  client,
}: GatewayToggle) => {
  const running = gateway?.running ?? false;
  const blocked = !running && (dirty || !!gateway?.configError);
  // A disabled button gets no pointer events, so the reason sits on a wrapper.
  const reason =
    configurationLocked || !blocked
      ? undefined
      : dirty
        ? 'Save or discard the unsaved changes first.'
        : 'Repair the configuration first.';
  return (
    <>
      <span className="sr-only" role="status">
        {running ? 'Gateway running' : 'Gateway stopped'}
      </span>
      <span className="inline-flex" title={reason}>
        <Button
          variant={running ? 'secondary' : 'default'}
          disabled={configurationLocked || blocked}
          onClick={() =>
            void run(
              () => (running ? client.stop() : client.start()),
              running ? 'Gateway stopped.' : 'Gateway started.',
            )
          }
        >
          {running ? 'Stop gateway' : 'Start gateway'}
        </Button>
      </span>
    </>
  );
};
