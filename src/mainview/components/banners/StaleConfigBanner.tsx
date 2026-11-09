import { Alert } from '@mcp-gateway/mainview/components/ui';

export const StaleConfigBanner = ({
  stale,
  revision,
  dismissed,
  dismiss,
}: {
  stale: boolean;
  revision: string | undefined;
  dismissed: ReadonlySet<string>;
  dismiss: (id: string) => void;
}) => {
  // App retains acknowledgements under this same key; without a snapshot it is `stale-undefined`.
  if (!stale || dismissed.has(`stale-${revision}`)) return null;
  return (
    <Alert kind="warning" role="status" onDismiss={() => dismiss(`stale-${revision}`)}>
      The configuration changed outside this window. Your draft and its original revision are
      preserved. A stale save will be refused. Copy your changes from the configuration editor
      before reloading.
    </Alert>
  );
};
