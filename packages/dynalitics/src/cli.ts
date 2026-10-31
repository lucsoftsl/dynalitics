#!/usr/bin/env node
import { nodeIo } from './cli/io.js';
import { runCli } from './cli/run.js';

process.exitCode = await runCli(process.argv.slice(2), nodeIo);
