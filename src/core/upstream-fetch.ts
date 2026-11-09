// Upstream HTTP calls run inside pinned Supergateway code that uses the global
// fetch with the configured headers. fetch strips only Authorization on a
// cross-origin redirect, so a custom header such as x-api-key would follow the
// redirect to another host. Origins of upstreams that carry configured headers
// therefore refuse redirects; every other request keeps default behavior.
const guarded = new Map<string, number>();
let installed = false;

const originOf = (input: Parameters<typeof fetch>[0]): string | undefined =>
  URL.parse(input instanceof Request ? input.url : String(input))?.origin;

const install = (): void => {
  if (installed) return;
  installed = true;
  const original = globalThis.fetch;
  const guard = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const origin = originOf(input);
    const refuse = origin !== undefined && guarded.has(origin) && init?.redirect === undefined;
    return original(input, refuse ? { ...init, redirect: 'error' } : init);
  };
  // Object.assign carries over fetch's static members, such as preconnect.
  globalThis.fetch = Object.assign(guard, original);
};

/** Refuse redirects from this upstream's origin until the returned release runs. */
export const refuseUpstreamRedirects = (url: URL): (() => void) => {
  install();
  guarded.set(url.origin, (guarded.get(url.origin) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (guarded.get(url.origin) ?? 1) - 1;
    if (remaining > 0) guarded.set(url.origin, remaining);
    else guarded.delete(url.origin);
  };
};
