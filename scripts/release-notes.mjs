#!/usr/bin/env node
// Print the CHANGELOG section for the current package version (release notes).
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const changelog = readFileSync(resolve(root, 'CHANGELOG.md'), 'utf8');
const lines = changelog.split(/\r?\n/);
const start = lines.findIndex(line => line.trim() === `## ${version}`);
if (start === -1) {
  console.error(`CHANGELOG has no "## ${version}" section`);
  process.exit(1);
}
const rest = lines.slice(start + 1);
const end = rest.findIndex(line => /^##\s/.test(line));
const body = (end === -1 ? rest : rest.slice(0, end)).join('\n').trim();
if (!body) {
  console.error(`CHANGELOG section for ${version} is empty`);
  process.exit(1);
}
console.log(body);
