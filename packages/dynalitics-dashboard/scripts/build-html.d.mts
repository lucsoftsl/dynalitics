export function fill(template: string, values: Record<string, string>): string;
export function escapeForInlineScript(js: string): string;
export function buildDashboardHtml(): Promise<{
  html: string;
  parts: { js: string; css: string; themeBoot: string; template: string };
}>;
