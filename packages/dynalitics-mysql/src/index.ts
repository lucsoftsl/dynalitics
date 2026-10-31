import type { DriverAdapter } from 'dynalitics/adapter';
import { createMysqlDriver } from './driver.js';

/**
 * The MySQL adapter for dynalitics: `createDynalitics({ adapter: mysql, ... })`.
 * apiVersion is a literal on purpose: it states the contract THIS package was built for (spec 5.2).
 */
export const mysql: DriverAdapter = Object.freeze({
  apiVersion: 1,
  dialect: 'mysql',
  packageName: 'dynalitics-mysql',
  createDriver: createMysqlDriver,
});
