export const PACKAGE_DIRS: string[];
export interface CheckInput {
  pkg: Record<string, any>;
  files: string[];
  size: number;
  exists: (relPath: string) => boolean;
  tag?: string;
  licenseText: string | null;
  rootLicenseText: string;
  hasReadme: boolean;
  allowPlaceholder?: boolean;
}
export function checkPackage(input: CheckInput): string[];
export function checkAll(
  tag?: string,
  allowPlaceholder?: boolean,
): { problems: string[]; summary: string[] };
