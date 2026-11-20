import { Button } from '@mcp-gateway/mainview/components/mac/button';
import { useI18n } from '@mcp-gateway/mainview/i18n';
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
  const { t } = useI18n();
  const running = gateway?.running ?? false;
  // An unreadable stored key is retried by Start, for example after unlocking Keychain.
  const blocked =
    !running &&
    (dirty || (!!gateway?.configError && gateway.configError.code !== 'KeyUnavailable'));
  // A disabled button gets no pointer events, so the reason sits on a wrapper.
  const reason =
    configurationLocked || !blocked
      ? undefined
      : dirty
        ? t('toggle.saveFirst')
        : t('toggle.repairFirst');
  return (
    <>
      <span className="sr-only" role="status">
        {running ? t('common.gatewayRunning') : t('common.gatewayStopped')}
      </span>
      <span className="inline-flex" title={reason}>
        <Button
          variant={running ? 'secondary' : 'default'}
          disabled={configurationLocked || blocked}
          onClick={() => void run(() => (running ? client.stop() : client.start()), '')}
        >
          {running ? t('common.stopGateway') : t('common.startGateway')}
        </Button>
      </span>
    </>
  );
};
