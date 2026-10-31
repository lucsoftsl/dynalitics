import type { DriverAdapter } from 'dynalitics/adapter';
import { createMssqlDriver } from './driver.js';

/**
 * The SQL Server adapter for dynalitics: `createDynalitics({ adapter: mssql, ... })`.
 * apiVersion is a literal on purpose: it states the contract THIS package was built for (spec 5.2).
 */
export const mssql: DriverAdapter = Object.freeze({
  apiVersion: 1,
  dialect: 'mssql',
  packageName: 'dynalitics-mssql',
  createDriver: createMssqlDriver,
});
