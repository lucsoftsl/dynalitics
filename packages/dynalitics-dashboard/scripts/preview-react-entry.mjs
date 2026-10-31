// Demo page entry for scripts/preview-react.mjs. It imports the package the way a consumer does
// (`dynalitics-dashboard/react`, resolved through package.json "exports"), so previews exercise the built bundle.
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { DynaliticsDashboard } from 'dynalitics-dashboard/react';

const params = new window.URLSearchParams(window.location.search);
const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    createElement(DynaliticsDashboard, {
      // /s/<scenario>/ is the mock API's mount point (same convention as scripts/preview-server.mjs)
      endpoint: window.location.pathname.replace(/\/$/, ''),
      theme: params.get('theme') ?? 'system',
    }),
  );
}
