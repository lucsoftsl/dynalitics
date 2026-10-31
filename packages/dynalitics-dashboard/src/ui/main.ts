import { startDashboard } from './dashboard.js';

// Browser entry of the single-file dashboard (bundled to one IIFE by scripts/build-html.mjs).
const base = document.querySelector('meta[name="dynalitics-base"]')?.getAttribute('content') ?? '';
startDashboard({ base });
