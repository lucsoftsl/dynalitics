import type { DriverAdapter } from 'dynalitics/adapter';
import { createPostgresDriver } from './driver.js';

/**
 * The PostgreSQL adapter for dynalitics: `createDynalitics({ adapter: postgres, ... })`.
 * apiVersion is a literal on purpose: it states the contract THIS package was built for (spec 5.2).
 */
export const postgres: DriverAdapter = Object.freeze({
  apiVersion: 1,
  dialect: 'postgres',
  packageName: 'dynalitics-postgres',
  createDriver: createPostgresDriver,
});
