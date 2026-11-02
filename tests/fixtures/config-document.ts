import type { GatewayConfig } from "../../src/shared/types";

export function jsoncFixture(config: GatewayConfig): string {
  return `// workspace comment\r\n${JSON.stringify(config, null, 2)
    .replace('"gateway": {', '"gateway": { /* gateway block */')
    .replace('"host":', '/* host policy */ "host":')
    .replace('"token":', '/* credential reference */ "token":')
    .replace('"mcpServers":', '/* servers retained */ "mcpServers":')
    .replace('"url":', '/* upstream retained */ "url":')
    .replace('"headers":', '/* headers retained */ "headers":')
    .replace('"args":', '/* arguments retained */ "args":')
    .replace(/\n}$/, ",\n}")
    .replaceAll("\n", "\r\n")}\r\n`;
}
