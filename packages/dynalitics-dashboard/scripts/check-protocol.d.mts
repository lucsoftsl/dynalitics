export const VENDORED: string;
export const SERVER: string;
export function compareProtocol(
  vendoredPath?: string,
  serverPath?: string,
): Promise<{ ok: boolean; reason: string }>;
