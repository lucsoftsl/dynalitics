// @vitest-environment jsdom
// docs/SPEC.md 19: the React banner renders the same DOM as the plain one and is safe to server-render.
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { buildBanner, clearConsent, readConsent, writeConsent } from '../src/index.js';
import { ConsentBanner, useConsent } from '../src/react/index.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
function render(node: ReactElement): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(node));
  return host;
}
const click = (el: Element | null) => act(() => (el as HTMLElement).click());

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  clearConsent();
  document.body.innerHTML = '';
});

/** Attributes whose values are instance ids and differ by design. */
const shape = (el: Element): string => el.outerHTML.replace(/ (id|aria-labelledby)="[^"]*"/g, '');

describe('ConsentBanner', () => {
  test("the built React entry starts with 'use client' (usable from a Next.js server layout)", async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(join(import.meta.dirname, '../src/react/index.tsx'), 'utf8');
    expect(src.startsWith("'use client';")).toBe(true);
  });

  test('server rendering emits nothing (the cookie is only read in the browser)', () => {
    expect(renderToString(<ConsentBanner message="m" />)).toBe('');
  });

  test('same DOM as the plain-DOM banner, so one stylesheet serves both', () => {
    const props = { message: 'Count my visit?', title: 'Analytics', policyUrl: '/privacy' };
    const host = render(<ConsentBanner {...props} />);
    const plain = buildBanner(props, () => undefined);
    expect(shape(host.querySelector('.dy-consent')!)).toBe(shape(plain));
  });

  test('a choice is stored, the banner closes, onChange fires', () => {
    const onChange = vi.fn();
    const host = render(<ConsentBanner message="m" onChange={onChange} />);
    click(host.querySelector('[data-choice="denied"]'));
    expect(host.querySelector('.dy-consent')).toBeNull();
    expect(readConsent()).toBe('denied');
    expect(onChange).toHaveBeenCalledWith('denied');
  });

  test('enabled={false} renders nothing and writes nothing', () => {
    const host = render(<ConsentBanner message="m" enabled={false} />);
    expect(host.innerHTML).toBe('');
    expect(document.cookie).not.toContain('dynalitics_consent');
  });

  test('message is required', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => render(<ConsentBanner message="  " />)).toThrow(/message/);
  });
});

describe('useConsent', () => {
  function Settings(): ReactElement {
    const c = useConsent();
    return (
      <p>
        <span className="choice">{String(c.choice)}</span>
        <button type="button" className="reopen" onClick={c.reopen}>
          Cookie settings
        </button>
        <button type="button" className="grant" onClick={c.grant}>
          grant
        </button>
      </p>
    );
  }

  test('follows the banner, and reopen() lets the visitor change their mind', () => {
    writeConsent('granted');
    const host = render(
      <>
        <ConsentBanner message="m" />
        <Settings />
      </>,
    );
    expect(host.querySelector('.dy-consent')).toBeNull();
    expect(host.querySelector('.choice')?.textContent).toBe('granted');
    click(host.querySelector('.reopen'));
    click(host.querySelector('[data-choice="denied"]'));
    expect(host.querySelector('.choice')?.textContent).toBe('denied');
    click(host.querySelector('.grant'));
    expect(host.querySelector('.choice')?.textContent).toBe('granted');
  });
});
