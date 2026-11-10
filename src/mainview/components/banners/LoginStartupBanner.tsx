import { Alert } from '@mcp-gateway/mainview/components/ui';
import type { LoginStatus } from '@mcp-gateway/shared/rpc';

interface LoginStartupBanner {
  login: LoginStatus | undefined;
  loginWanted: boolean;
  loginInDraftBar: boolean;
  dismissed: ReadonlySet<string>;
  dismiss: (id: string) => void;
}

export const LoginStartupBanner = ({
  login,
  loginWanted,
  loginInDraftBar,
  dismissed,
  dismiss,
}: LoginStartupBanner) => {
  // The Settings draft bar already shows this error next to its retry action.
  if (
    loginInDraftBar ||
    !login?.error ||
    !(loginWanted || login.supported) ||
    dismissed.has(`login-${login.occurrenceId}`)
  )
    return null;
  return (
    <Alert kind="warning" onDismiss={() => dismiss(`login-${login.occurrenceId}`)}>
      Login startup: {login.error}
    </Alert>
  );
};
