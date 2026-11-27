import { cleanup } from '@testing-library/react';
import { GlobalWindow } from 'happy-dom';

let activeWindow: GlobalWindow | null = null;

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

/** Unmounts rendered React trees and clears the active document body. */
export const cleanupDom = () => {
  cleanup();
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
