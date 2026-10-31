// Test-only bridge to the three adapter packages' SOURCES (spec v0.5). Production core code never imports them.
import type { Driver, DriverAdapter, DriverOptions } from '../../src/driver/types.js';
import type { Dialect } from '../../src/model/types.js';

export async function loadAdapters(): Promise<Record<Dialect, DriverAdapter>> {
  const [{ postgres }, { mysql }, { mssql }] = await Promise.all([
    import('../../../dynalitics-postgres/src/index.js'),
    import('../../../dynalitics-mysql/src/index.js'),
    import('../../../dynalitics-mssql/src/index.js'),
  ]);
  return { postgres, mysql, mssql };
}

/** The pre-v0.5 `createDriver(dialect, options)` shape, routed through the real adapters. */
export async function adapterDriverFactory(): Promise<
  (dialect: Dialect, options: DriverOptions) => Promise<Driver>
> {
  const adapters = await loadAdapters();
  return (dialect, options) => adapters[dialect].createDriver(options);
}

/** A structurally valid adapter for unit tests that inject `CreateDeps.createDriver` anyway. */
export const stubAdapter = (dialect: Dialect): DriverAdapter => ({
  apiVersion: 1,
  dialect,
  packageName: `stub-${dialect}`,
  createDriver: () => Promise.reject(new Error('stubAdapter: inject CreateDeps.createDriver')),
});
