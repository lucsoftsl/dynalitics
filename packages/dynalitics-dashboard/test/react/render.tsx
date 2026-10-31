// Test helpers for the React components. No Testing Library: React's own `act` plus DOM queries are enough.
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { mockFetch, type Scenario } from '../fixtures/api.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** `act()` for a synchronous change: its callback returns a promise so React flushes effects and the call is awaitable. */
export const inAct = (fn: () => void): Promise<void> =>
  act(() => {
    fn();
    return Promise.resolve();
  });

export interface Mounted {
  readonly container: HTMLElement;
  readonly root: Root;
  render(ui: ReactElement): Promise<void>;
  unmount(): Promise<void>;
}

export async function mountReact(ui: ReactElement): Promise<Mounted> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const mounted: Mounted = {
    container,
    root,
    render: (next) => inAct(() => root.render(next)),
    unmount: async () => {
      await inAct(() => root.unmount());
      container.remove();
    },
  };
  await mounted.render(ui);
  return mounted;
}

/** Lets timers, promises and React effects run (real timers). */
export async function settleReact(ms = 30, rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, ms));
    });
  }
}

export function fetchFor(scenario: Scenario): {
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  calls: { url: string; init: RequestInit | undefined }[];
} {
  const base = mockFetch(scenario);
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  return {
    calls,
    fetch: (input, init) => {
      calls.push({ url: input, init });
      return base(input, init);
    },
  };
}

export const click = (node: Element | null): Promise<void> =>
  inAct(() => (node as HTMLElement).click());

export const press = (node: Element | null, key: string): Promise<void> =>
  inAct(() => {
    node?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });

export const q = <T extends Element = HTMLElement>(root: ParentNode, sel: string): T | null =>
  root.querySelector<T>(sel);

export const qa = <T extends Element = HTMLElement>(root: ParentNode, sel: string): T[] => [
  ...root.querySelectorAll<T>(sel),
];
