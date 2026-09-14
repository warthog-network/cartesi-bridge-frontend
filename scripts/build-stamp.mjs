#!/usr/bin/env node
/**
 * dist must come from the src that is on disk. `npm run build` / deploy-frontend.sh
 * write a stamp next to the build; the unit's ExecStartPre refuses to start a
 * dist whose stamp no longer matches src. A hand-edited chunk or an unbuilt
 * src edit then fails loudly at restart instead of quietly serving a mismatch.
 *
 *   node scripts/build-stamp.mjs --write [--dir dist]   after a build
 *   node scripts/build-stamp.mjs --check [--dir dist]   before start (exit 1 on mismatch)
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const dir = path.resolve(ROOT, args.includes('--dir') ? args[args.indexOf('--dir') + 1] : 'dist');
const stampPath = path.join(dir, 'BUILD_STAMP.json');

function walk(d, out = []) {
  for (const name of readdirSync(d).sort()) {
    if (name.endsWith('.bak') || /\.bak-/.test(name)) continue;
    const p = path.join(d, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

function srcSha() {
  const h = createHash('sha256');
  const inputs = [...walk(path.join(ROOT, 'src')), path.join(ROOT, 'package-lock.json'), path.join(ROOT, 'astro.config.mjs')];
  for (const f of inputs) {
    if (!existsSync(f)) continue;
    h.update(path.relative(ROOT, f));
    h.update('\0');
    h.update(readFileSync(f));
    h.update('\0');
  }
  return h.digest('hex');
}

function gitHead() {
  // deploy-frontend.sh exports the frontend worktree's head as PUBLIC_BUILD_SHA
  // (the served dir has no .git of its own — `git rev-parse` here would answer
  // for the parent /opt/cartesi-bridge repo, a different history). Prefer it so
  // the stamp and the browser bundle name the same build.
  if (process.env.PUBLIC_BUILD_SHA && process.env.PUBLIC_BUILD_SHA !== 'unknown') {
    return process.env.PUBLIC_BUILD_SHA;
  }
  try {
    return execSync('git rev-parse --short HEAD', { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return null;
  }
}

if (args.includes('--write')) {
  const stamp = { srcSha: srcSha(), head: gitHead(), at: new Date().toISOString() };
  writeFileSync(stampPath, JSON.stringify(stamp, null, 2) + '\n');
  console.log(`[build-stamp] wrote ${path.relative(ROOT, stampPath)} src=${stamp.srcSha.slice(0, 12)} head=${stamp.head}`);
} else if (args.includes('--check')) {
  if (!existsSync(stampPath)) {
    console.error(`[build-stamp] ${path.relative(ROOT, stampPath)} missing — dist was not produced by the build script`);
    process.exit(1);
  }
  const stamp = JSON.parse(readFileSync(stampPath, 'utf8'));
  const now = srcSha();
  if (stamp.srcSha !== now) {
    console.error(
      `[build-stamp] src changed since this dist was built (built ${stamp.at}, head ${stamp.head}). ` +
        'Run scripts/deploy-frontend.sh — do not hand-edit dist or restart on an unbuilt src.',
    );
    process.exit(1);
  }
  console.log(`[build-stamp] ok src=${now.slice(0, 12)} head=${stamp.head} built=${stamp.at}`);
} else {
  console.error('usage: build-stamp.mjs --write|--check [--dir dist]');
  process.exit(2);
}
