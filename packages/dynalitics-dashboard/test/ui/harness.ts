import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startDashboard } from '../../src/ui/dashboard.js';
import { mockFetch, type Scenario } from '../fixtures/api.js';
import type { FetchFn } from '../../src/ui/api.js';

const TEMPLATE = readFileSync(join(import.meta.dirname, '../../src/ui/template.html'), 'utf8');

/** Mounts the template's <body> (test harness only) and starts the dashboard on a mock API. */
export function mount(
  scenario: Scenario,
  wrap?: (f: FetchFn) => FetchFn,
  hash = '',
): { calls: string[]; reloads: number[] } {
  const body = /<body>([\s\S]*)<\/body>/.exec(TEMPLATE)?.[1] ?? '';
  const markup = body.replace(/<script[\s\S]*?<\/script>/g, '').replace(/\{\{version\}\}/g, 'test');
  history.replaceState(null, '', `${location.pathname}${hash}`);
  document.body.innerHTML = markup;
  const calls: string[] = [];
  const reloads: number[] = [];
  const base = mockFetch(scenario);
  const counted: FetchFn = (input, init) => {
    calls.push(input);
    return base(input, init);
  };
  startDashboard({
    base: '/s/x',
    fetchFn: wrap ? wrap(counted) : counted,
    locale: 'en-GB',
    reloadPage: () => reloads.push(1),
  });
  return { calls, reloads };
}

export async function settle(ms = 30): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, ms));
}
