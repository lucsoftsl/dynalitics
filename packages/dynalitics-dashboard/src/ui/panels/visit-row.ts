import type { MetaData, RecentVisit } from '../../protocol.js';
import { append, el, swatch, visitorText, visuallyHidden } from '../dom.js';
import { splitTimestamp, type Formatters } from '../format.js';
import { statusBadge } from './status.js';

export interface Column {
  readonly key: 'time' | 'page' | 'status' | 'consent' | 'first' | 'ip' | 'email' | 'user';
  readonly label: string;
  readonly pii: boolean;
  /** User column showing only the user id (no username role is mapped). */
  readonly idOnly?: boolean;
}

/** Columns come from /api/meta `fields`; unmapped roles are dropped (SPEC 10.9 rule 9). */
export function columnsFor(fields: MetaData['fields']): readonly Column[] {
  const all: (Column & { show: boolean })[] = [
    { key: 'time', label: 'Time (UTC)', pii: false, show: true },
    { key: 'page', label: 'Page', pii: false, show: true },
    { key: 'status', label: 'Status', pii: false, show: fields.status === true },
    { key: 'consent', label: 'Consent', pii: false, show: true },
    { key: 'first', label: 'First visit', pii: false, show: fields.isFirstVisit },
    { key: 'ip', label: 'IP', pii: true, show: fields.ipAddress },
    { key: 'email', label: 'Email', pii: true, show: fields.email },
    {
      key: 'user',
      label: fields.username ? 'Username' : 'User ID',
      pii: true,
      idOnly: !fields.username,
      show: fields.username || fields.userId,
    },
  ];
  return all
    .filter((c) => c.show)
    .map(({ key, label, pii, idOnly }) =>
      idOnly === undefined ? { key, label, pii } : { key, label, pii, idOnly },
    );
}

function role(node: HTMLElement, value: string): HTMLElement {
  node.setAttribute('role', value);
  return node;
}

function dash(label: string): HTMLElement {
  const span = el('span', 'dash');
  append(span, el('span', undefined, '—', { 'aria-hidden': 'true' }), visuallyHidden(label));
  return span;
}

function valueOrDash(value: string | null): Node {
  return value === null ? dash('not provided') : visitorText('span', value);
}

function timeCell(f: Formatters, iso: string): HTMLElement {
  const td = role(el('td', 't-time', null, { 'data-label': 'Time' }), 'cell');
  const parts = splitTimestamp(f, iso);
  if (!parts) {
    td.appendChild(visitorText('span', iso));
    return td;
  }
  const time = el('time', undefined, null, { datetime: iso });
  append(time, el('b', undefined, parts.time), el('span', 'dy-t2', parts.date));
  td.appendChild(time);
  return td;
}

function consentChip(granted: boolean): HTMLElement {
  const chip = el('span', 'chip');
  append(
    chip,
    swatch(granted ? 'granted' : 'declined'),
    document.createTextNode(granted ? 'Granted' : 'Declined'),
  );
  return chip;
}

/** Status badge on line one, the error reason (a code, never a message) on line two. Kept on declined rows. */
function statusCell(v: RecentVisit): HTMLElement {
  const td = role(el('td', 'c-status', null, { 'data-label': 'Status' }), 'cell');
  const status = v.status ?? null;
  if (status === null) td.appendChild(dash('no status'));
  else td.appendChild(statusBadge(status));
  const reason = v.errorReason ?? null;
  if (reason !== null) td.appendChild(visitorText('span', reason, 'dy-t2 dy-err-reason'));
  return td;
}

function firstCell(value: boolean | null): HTMLElement {
  const td = role(el('td', 'c-first', null, { 'data-label': 'First' }), 'cell');
  if (value === null) td.appendChild(dash('unknown'));
  else td.appendChild(el('span', value ? 'yes' : 'no', value ? 'Yes' : 'No'));
  return td;
}

/** Username on line one and the user id (as masked or revealed by the server) on line two; id alone if no username role. */
function userCell(v: RecentVisit, idOnly: boolean): HTMLElement {
  const td = role(
    el('td', 'c-user dy-pii', null, { 'data-label': idOnly ? 'User ID' : 'User' }),
    'cell',
  );
  if (idOnly) {
    td.appendChild(valueOrDash(v.userId));
    return td;
  }
  td.appendChild(valueOrDash(v.username));
  if (v.userId) td.appendChild(visitorText('span', v.userId, 'dy-t2'));
  return td;
}

function piiCell(cls: string, label: string, value: string | null): HTMLElement {
  const td = role(el('td', `${cls} dy-pii`, null, { 'data-label': label }), 'cell');
  td.appendChild(valueOrDash(value));
  return td;
}

/** One table row. Declined visits get ONE merged "not collected" cell, never dashes or blanks. */
export function visitRow(v: RecentVisit, columns: readonly Column[], f: Formatters): HTMLElement {
  const tr = role(el('tr'), 'row');
  const piiCount = columns.filter((c) => c.pii).length;
  let mergedDone = false;
  for (const c of columns) {
    if (c.pii && !v.consent) {
      if (!mergedDone) {
        const td = role(
          el('td', 'na', 'Not collected: visitor declined consent', { colspan: piiCount }),
          'cell',
        );
        tr.appendChild(td);
        mergedDone = true;
      }
      continue;
    }
    switch (c.key) {
      case 'time':
        tr.appendChild(timeCell(f, v.timestamp));
        break;
      case 'page':
        tr.appendChild(role(visitorText('td', v.pageVisited, 'c-page', true), 'cell'));
        break;
      case 'status':
        tr.appendChild(statusCell(v));
        break;
      case 'consent':
        tr.appendChild(
          role(el('td', 'c-consent', null, { 'data-label': 'Consent' }), 'cell'),
        ).appendChild(consentChip(v.consent));
        break;
      case 'first':
        tr.appendChild(firstCell(v.consent ? v.isFirstVisit : null));
        break;
      case 'ip':
        tr.appendChild(piiCell('c-ip', 'IP', v.ipAddress));
        break;
      case 'email':
        tr.appendChild(piiCell('c-email', 'Email', v.email));
        break;
      case 'user':
        tr.appendChild(userCell(v, c.idOnly === true));
        break;
    }
  }
  return tr;
}

export function headerRow(columns: readonly Column[], masked: boolean): HTMLElement {
  const tr = role(el('tr'), 'row');
  for (const c of columns) {
    const th = role(
      el('th', `dy-th c-${c.key}${c.pii && masked ? ' th-lock' : ''}`, c.label, { scope: 'col' }),
      'columnheader',
    );
    if (c.pii && masked) th.appendChild(visuallyHidden(' (masked)'));
    tr.appendChild(th);
  }
  return tr;
}
