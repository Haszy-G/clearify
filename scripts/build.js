// Shared source lives in the root; each target becomes a self-contained folder
import { cpSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// --version x.y.z stamps all source manifests before building. Stores reject
// uploads whose version is not strictly greater than the live one.
const SEMVER = /^\d+\.\d+\.\d+$/;
function parseVersionArg() {
  const flagIndex = process.argv.indexOf('--version');
  if (flagIndex === -1) return undefined;
  const value = process.argv[flagIndex + 1];
  if (!value || !SEMVER.test(value)) {
    console.error('error: --version requires a semver value, e.g. --version 1.2.3');
    process.exit(1);
  }
  return value;
}

function compareVersions(a, b) {
  const [aMajor, aMinor, aPatch] = a.split('.').map(Number);
  const [bMajor, bMinor, bPatch] = b.split('.').map(Number);
  return aMajor - bMajor || aMinor - bMinor || aPatch - bPatch;
}

// Matches only the top-level "version" key; nested keys like "strict_min_version" don't align.
const VERSION_KEY = /^(\s*"version"\s*:\s*")[^"]*(")/m;

function stampVersion(version) {
  for (const manifest of Object.values(TARGETS)) {
    const path = join(ROOT, manifest);
    const raw = readFileSync(path, 'utf8');
    const { version: current } = JSON.parse(raw);
    if (!VERSION_KEY.test(raw)) {
      console.error(`error: no top-level "version" field found in ${manifest}`);
      process.exit(1);
    }
    if (compareVersions(version, current) <= 0) {
      console.warn(
        `warning: ${manifest} has version ${current}; stamped ${version} is not higher — stores will reject it`
      );
    }
    writeFileSync(path, raw.replace(VERSION_KEY, `$1${version}$2`));
    console.log(`stamped ${manifest}: ${current} -> ${version}`);
  }
}

// Everything shared lives in the root; each target is a complete, loadable extension folder.
const SHARED = ['utils', 'content', 'sidepanel', 'icons'];

const TARGETS = {
  // chromium covers Chrome, Edge, Brave, Vivaldi (all use chrome.sidePanel)
  chromium: 'scripts/manifests/chromium.json',
  arc: 'scripts/manifests/arc.json',
  firefox: 'scripts/manifests/firefox.json',
  opera: 'scripts/manifests/opera.json',
  // safari: no sidePanel/sidebarAction and no identity API; the action opens
  // the panel as a default popup (declared in safari.json) and OpenRouter
  // sign-in falls back to a manually pasted API key.
  // Wrap distributions/safari in a native app on macOS via scripts/build-safari.sh.
  safari: 'scripts/manifests/safari.json',
};

const version = parseVersionArg();
if (version) stampVersion(version);

for (const [name, manifest] of Object.entries(TARGETS)) {
  const out = join(ROOT, 'distributions', name);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  for (const dir of SHARED) {
    if (!existsSync(join(ROOT, dir))) continue;
    cpSync(join(ROOT, dir), join(out, dir), { recursive: true });
  }
  cpSync(join(ROOT, 'background'), join(out, 'background'), { recursive: true });

  writeFileSync(join(out, 'manifest.json'), readFileSync(join(ROOT, manifest)));

  // `zip` updates an existing archive in place — entries whose sources were
  // deleted (callback/, old icon names) would survive every rebuild and
  // ship inside the .zip while the folder beside it stays clean. Remove the
  // old archive first so each build is exactly the current tree.
  rmSync(join(ROOT, 'distributions', `${name}.zip`), { force: true });
  execFileSync('zip', ['-rq', join(ROOT, `distributions/${name}.zip`), '.'], { cwd: out });
  console.log(`built distributions/${name}/ + distributions/${name}.zip`);
}
