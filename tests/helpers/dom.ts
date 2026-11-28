import type { Component, View } from '@effect/ui';
import { BrowserHost, type Html } from '@effect/ui/html';
import {
  type BoundFunctions,
  fireEvent,
  getQueriesForElement,
  type queries,
  waitFor,
  within,
} from '@testing-library/dom';
import { Effect, Exit, Layer, Scope } from 'effect';
import { GlobalWindow } from 'happy-dom';

export { fireEvent, waitFor, within };

let activeWindow: GlobalWindow | null = null;

interface MountedHandle {
  readonly scope: Scope.Closeable;
  readonly container: HTMLElement;
}

const activeMounts: MountedHandle[] = [];

const ensureDialogMethods = (win: GlobalWindow) => {
  const proto = win.HTMLDialogElement.prototype;
  proto.showModal = function showModal() {
    this.open = true;
    this.setAttribute('open', '');
  };
  proto.close = function close() {
    this.open = false;
    this.removeAttribute('open');
  };
};

export interface MountedView<Props = unknown> extends BoundFunctions<typeof queries> {
  readonly container: HTMLElement;
  readonly setProps: (next: Props) => Promise<void>;
  readonly unmount: () => Promise<void>;
}

/** Flushes Effect UI microtask renders and queued browser tasks. */
export const flushDom = async () => {
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
};

/**
 * Mounts an Effect UI HTML component into a fresh container inside `document.body`
 * and binds `@testing-library/dom` queries to it. Registers the mounted scope for
 * deterministic `cleanupDom()` teardown so zero fibers, intervals, or CodeMirror
 * instances leak across tests.
 */
export const mountEffectView = async <
  Name extends string,
  Props,
  Model,
  Message,
  Event,
  R,
  V extends View.Elements,
>(
  component: Component.Members<Name, Props, Model, Message, Event, R, V, unknown> &
    BrowserHost.HtmlRoot<V>,
  props: Props,
  layers: Layer.Layer<Exclude<R, Html.Host>, never, never> = Layer.empty as unknown as Layer.Layer<
    Exclude<R, Html.Host>,
    never,
    never
  >,
): Promise<MountedView<Props>> => {
  const scope = Scope.makeUnsafe('sequential');
  const container = document.createElement('div');
  document.body.appendChild(container);
  const handle: MountedHandle = { scope, container };
  activeMounts.push(handle);

  const root = await Effect.runPromise(
    Effect.gen(function* () {
      const ctx = yield* Layer.buildWithScope(layers, scope);
      return yield* BrowserHost.mountEffect(component, props, container, {
        head: false,
      }).pipe(Effect.provideContext(ctx), Scope.provide(scope));
    }),
  );

  await flushDom();

  let unmounted = false;
  const unmount = async () => {
    if (unmounted) return;
    unmounted = true;
    const idx = activeMounts.indexOf(handle);
    if (idx >= 0) activeMounts.splice(idx, 1);
    await Effect.runPromise(Scope.close(scope, Exit.void));
    container.remove();
  };

  return {
    container,
    ...getQueriesForElement(container),
    setProps: async (next: Props) => {
      root.setProps(next);
      await flushDom();
    },
    unmount,
  };
};

/** Closes all active Effect UI scopes and clears the active document body. */
export const cleanupDom = async () => {
  while (activeMounts.length > 0) {
    const handle = activeMounts.pop();
    if (!handle) continue;
    await Effect.runPromise(Scope.close(handle.scope, Exit.void));
    handle.container.remove();
  }
  if (typeof document !== 'undefined' && document.body) {
    document.body.innerHTML = '';
  }
};

/**
 * Installs a Happy-DOM window and browser globals on `globalThis` for opt-in DOM tests.
 * Returns a `cleanupDom` function for per-test teardown.
 */
export const installDomEnvironment = () => {
  if (activeWindow) {
    void activeWindow.happyDOM?.cancelAsync?.();
  }
  const win = new GlobalWindow({ url: 'http://localhost/' });
  activeWindow = win;
  ensureDialogMethods(win);

  const globals = {
    window: win,
    document: win.document,
    navigator: win.navigator,
    HTMLElement: win.HTMLElement,
    HTMLDialogElement: win.HTMLDialogElement,
    HTMLInputElement: win.HTMLInputElement,
    HTMLSelectElement: win.HTMLSelectElement,
    HTMLButtonElement: win.HTMLButtonElement,
    HTMLTextAreaElement: win.HTMLTextAreaElement,
    Element: win.Element,
    Node: win.Node,
    Event: win.Event,
    CustomEvent: win.CustomEvent,
    KeyboardEvent: win.KeyboardEvent,
    MouseEvent: win.MouseEvent,
    MutationObserver: win.MutationObserver,
    getComputedStyle: win.getComputedStyle.bind(win),
    requestAnimationFrame: win.requestAnimationFrame.bind(win),
    cancelAnimationFrame: win.cancelAnimationFrame.bind(win),
  };

  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  }

  return cleanupDom;
};
