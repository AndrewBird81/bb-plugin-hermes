#!/usr/bin/env node
// Runs the bb CLI pinned in devDependencies (bb-app), never the machine's bb:
// BB_CLI would re-exec to it, and the other BB_* variables point at a live server.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../node_modules/bb-app/dist/bb.js', import.meta.url));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('BB_')));
const run = spawnSync(process.execPath, [cli, ...process.argv.slice(2)], { stdio: 'inherit', env });
process.exit(run.status ?? 1);
