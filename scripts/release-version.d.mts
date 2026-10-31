export function nextVersion(repo: string, published: string | null): string;
export function withVersion(pkgText: string, version: string): string;
export function highestRelease(versions: string | readonly string[] | null): string | null;
