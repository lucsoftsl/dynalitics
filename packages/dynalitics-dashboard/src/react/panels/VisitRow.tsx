import type { ReactElement } from 'react';
import type { RecentVisit } from '../../protocol.js';
import type { Formatters } from '../../ui/format.js';
import { splitTimestamp } from '../../ui/format.js';
import type { Column } from '../../ui/panels/visit-row.js';
import { cx } from '../css-vars.js';
import { StatusBadge } from './StatusBadge.js';

// Every visitor-supplied value below is a React text child. There is no markup path for it.

function Dash(props: { label: string }): ReactElement {
  return (
    <span className="dash">
      <span aria-hidden="true">—</span>
      <span className="vh">{props.label}</span>
    </span>
  );
}

function ValueOrDash(props: { value: string | null; className?: string }): ReactElement {
  return props.value === null ? (
    <Dash label="not provided" />
  ) : (
    <span className={cx('v', props.className)}>{props.value}</span>
  );
}

function TimeCell(props: { f: Formatters; iso: string }): ReactElement {
  const parts = splitTimestamp(props.f, props.iso);
  return (
    <td className="t-time" data-label="Time" role="cell">
      {parts ? (
        <time dateTime={props.iso}>
          <b>{parts.time}</b>
          <span className="dy-t2">{parts.date}</span>
        </time>
      ) : (
        <span className="v">{props.iso}</span>
      )}
    </td>
  );
}

function PiiCell(props: { cls: string; label: string; value: string | null }): ReactElement {
  return (
    <td className={`${props.cls} dy-pii`} data-label={props.label} role="cell">
      <ValueOrDash value={props.value} />
    </td>
  );
}

/** Username on line one and the user id (as masked or revealed by the server) on line two; id alone if no username role. */
function UserCell(props: { visit: RecentVisit; idOnly: boolean }): ReactElement {
  const { visit, idOnly } = props;
  return (
    <td className="c-user dy-pii" data-label={idOnly ? 'User ID' : 'User'} role="cell">
      {idOnly ? (
        <ValueOrDash value={visit.userId} />
      ) : (
        <>
          <ValueOrDash value={visit.username} />
          {visit.userId ? <span className="v dy-t2">{visit.userId}</span> : null}
        </>
      )}
    </td>
  );
}

/** One table row. Declined visits get ONE merged "not collected" cell, never dashes or blanks. */
export function VisitRow(props: {
  visit: RecentVisit;
  columns: readonly Column[];
  f: Formatters;
}): ReactElement {
  const { visit: v, columns, f } = props;
  const piiCount = columns.filter((c) => c.pii).length;
  let mergedDone = false;
  const cells: ReactElement[] = [];
  for (const c of columns) {
    if (c.pii && !v.consent) {
      if (!mergedDone) {
        cells.push(
          <td key="na" className="na" colSpan={piiCount} role="cell">
            Not collected: visitor declined consent
          </td>,
        );
        mergedDone = true;
      }
      continue;
    }
    switch (c.key) {
      case 'time':
        cells.push(<TimeCell key={c.key} f={f} iso={v.timestamp} />);
        break;
      case 'page':
        cells.push(
          <td key={c.key} className="v c-page" dir="auto" role="cell">
            {v.pageVisited}
          </td>,
        );
        break;
      case 'status': {
        const status = v.status ?? null;
        const reason = v.errorReason ?? null;
        cells.push(
          <td key={c.key} className="c-status" data-label="Status" role="cell">
            {status === null ? <Dash label="no status" /> : <StatusBadge status={status} />}
            {reason === null ? null : <span className="v dy-t2 dy-err-reason">{reason}</span>}
          </td>,
        );
        break;
      }
      case 'consent':
        cells.push(
          <td key={c.key} className="c-consent" data-label="Consent" role="cell">
            <span className="chip">
              <span
                className={`dy-sw dy-sw-${v.consent ? 'granted' : 'declined'}`}
                aria-hidden="true"
              />
              {v.consent ? 'Granted' : 'Declined'}
            </span>
          </td>,
        );
        break;
      case 'first': {
        const value = v.consent ? v.isFirstVisit : null;
        cells.push(
          <td key={c.key} className="c-first" data-label="First" role="cell">
            {value === null ? (
              <Dash label="unknown" />
            ) : (
              <span className={value ? 'yes' : 'no'}>{value ? 'Yes' : 'No'}</span>
            )}
          </td>,
        );
        break;
      }
      case 'ip':
        cells.push(<PiiCell key={c.key} cls="c-ip" label="IP" value={v.ipAddress} />);
        break;
      case 'email':
        cells.push(<PiiCell key={c.key} cls="c-email" label="Email" value={v.email} />);
        break;
      case 'user':
        cells.push(<UserCell key={c.key} visit={v} idOnly={c.idOnly === true} />);
        break;
    }
  }
  return <tr role="row">{cells}</tr>;
}

export function HeaderRow(props: { columns: readonly Column[]; masked: boolean }): ReactElement {
  return (
    <tr role="row">
      {props.columns.map((c) => (
        <th
          key={c.key}
          className={`dy-th c-${c.key}${c.pii && props.masked ? ' th-lock' : ''}`}
          scope="col"
          role="columnheader"
        >
          {c.label}
          {c.pii && props.masked ? <span className="vh"> (masked)</span> : null}
        </th>
      ))}
    </tr>
  );
}
