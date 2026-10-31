import type { ReactElement } from 'react';

/** Hatch and dot patterns shared by every chart (docs/DESIGN.md 2.3). Same ids as the HTML page. */
export function Defs(): ReactElement {
  return (
    <svg width="0" height="0" aria-hidden="true" focusable="false" className="dy-defs">
      <defs>
        <pattern
          id="dy-hatch"
          width="6"
          height="6"
          patternUnits="userSpaceOnUse"
          patternTransform="rotate(45)"
        >
          <rect width="6" height="6" className="dy-pat-ground" />
          <line x1="0" y1="0" x2="0" y2="6" strokeWidth="2" className="dy-hatch-line" />
        </pattern>
        <pattern id="dy-dots" width="5" height="5" patternUnits="userSpaceOnUse">
          <rect width="5" height="5" className="dy-pat-ground" />
          <circle cx="2.5" cy="2.5" r="1.1" className="dy-dot" />
        </pattern>
        <pattern
          id="dy-hatch-other"
          width="6"
          height="6"
          patternUnits="userSpaceOnUse"
          patternTransform="rotate(-45)"
        >
          <rect width="6" height="6" className="dy-pat-ground" />
          <line x1="0" y1="0" x2="0" y2="6" strokeWidth="2" className="dy-other-line" />
        </pattern>
      </defs>
    </svg>
  );
}
