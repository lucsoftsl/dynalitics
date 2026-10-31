import { useId, type ReactElement } from 'react';
import { cssVars } from './css-vars.js';
import { useInternal } from './internal-context.js';

/** Date range as a radio group (arrow keys move and select); only ranges the server allows. */
export function RangeSelector(): ReactElement {
  const dyn = useInternal();
  const name = useId();
  const index = Math.max(
    0,
    dyn.ranges.findIndex((r) => r.key === dyn.rangeKey),
  );
  return (
    <fieldset
      className="dy-range"
      style={dyn.ranges.length ? cssVars({ '--n': String(dyn.ranges.length) }) : undefined}
    >
      <legend className="vh">Date range</legend>
      {dyn.ranges.length ? (
        <span className="dy-pill" aria-hidden="true" style={cssVars({ '--i': String(index) })} />
      ) : null}
      {dyn.ranges.map((r) => (
        <label key={r.key}>
          <input
            type="radio"
            name={name}
            value={r.key}
            checked={r.key === dyn.rangeKey}
            onChange={() => dyn.setRange(r.key)}
          />
          <span>{r.key}</span>
        </label>
      ))}
    </fieldset>
  );
}
