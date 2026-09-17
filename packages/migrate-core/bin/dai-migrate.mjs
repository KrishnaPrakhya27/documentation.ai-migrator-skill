#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, '..', 'src', 'cli.ts');
// The TypeScript loader is resolved from this file, not from wherever the command was started:
// an MCP host (Claude Desktop, Cursor…) starts it from a directory of its own choosing.
const loader = import.meta.resolve('tsx');
const child = spawn(process.execPath, ['--import', loader, cli, ...process.argv.slice(2)], { stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 1));
