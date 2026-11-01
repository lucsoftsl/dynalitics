import type { ReactElement } from 'react';
import { statusClass } from '../../ui/panels/status.js';

const SPOKEN = {
  ok: 'success',
  redirect: 'redirect',
  client: 'client error',
  server: 'server error',
};

/** Same DOM as ui/panels/status.ts: the code is printed and the class is spoken, colour is never the only signal. */
export function StatusBadge(props: { status: number }): ReactElement {
  const cls = statusClass(props.status);
  return (
    <span className={`dy-status dy-status--${cls}`}>
      {String(props.status)}
      <span className="vh">{` ${SPOKEN[cls]}`}</span>
    </span>
  );
}
