// @vitest-environment jsdom
// Server rendering and hydration (Next.js client components are rendered on the server first).
import { hydrateRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { DynaliticsDashboard, DynaliticsProvider, TopPages } from '../../src/react/index.js';
import { mockFetch } from '../fixtures/api.js';
import { inAct, settleReact } from './render.js';

afterEach(() => vi.restoreAllMocks());

describe('server rendering', () => {
  test('renders the shell and loading state without any data or browser storage', () => {
    const html = renderToString(<DynaliticsDashboard endpoint="/admin/analytics" />);
    expect(html).toContain('dynalitics');
    for (const title of [
      'Visits over time',
      'Top pages',
      'New vs returning',
      'Consent',
      'Recent visits',
    ])
      expect(html).toContain(title);
    expect(html).toContain('dy-loading--wait'); // skeletons stay hidden for the first 200 ms
    expect(html).not.toContain('data-theme'); // follows the OS through CSS until the browser reads a choice
    expect(html).toContain('aria-busy="true"');
  });

  test('a fixed theme is rendered on the server', () => {
    expect(renderToString(<DynaliticsDashboard theme="dark" />)).toContain('data-theme="dark"');
  });

  test('standalone widgets render inside the provider', () => {
    const html = renderToString(
      <DynaliticsProvider>
        <TopPages />
      </DynaliticsProvider>,
    );
    expect(html).toContain('Top pages');
    expect(html).not.toContain('Visits over time');
  });

  test('hydrating the server HTML produces no mismatch or React warnings', async () => {
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation(
      (...a: unknown[]) => void errors.push(a.join(' ')),
    );
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const ui = <DynaliticsDashboard endpoint="/s/x" fetch={mockFetch('ok')} locale="en-GB" />;
    const container = document.createElement('div');
    container.innerHTML = renderToString(ui);
    document.body.appendChild(container);
    let root!: ReturnType<typeof hydrateRoot>;
    await inAct(() => {
      root = hydrateRoot(container, ui);
    });
    await settleReact();
    expect(container.querySelectorAll('.dy-panel')).toHaveLength(5);
    expect(container.querySelector('.p-hero .dy-hero-num')).not.toBeNull(); // data arrived after hydration
    await inAct(() => {
      root.unmount();
    });
    expect(errors).toEqual([]);
  });
});
