// Builds the signed macOS desktop app and stages everything a GitHub release
// needs for the in-app updater:
//
//   dist-release/Invoice-Generator_<v>_aarch64.dmg          first install
//   dist-release/Invoice-Generator_<v>_aarch64.app.tar.gz   updater payload
//   dist-release/latest.json                                updater feed
//
// The app polls releases/latest/download/latest.json (tauri.conf.json), so
// these three files must be attached to the release that GitHub marks
// "Latest". Nothing is uploaded here — the script prints the gh command.
//
// Signing key: TAURI_SIGNING_PRIVATE_KEY (path or key string), defaulting to
// ~/.tauri/invoice-generator.key. Lose it and installed apps can no longer
// verify updates.

import { execSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const REPO = 'maxzimmermnn/invoice-generator';
const PRODUCT = 'Invoice Generator';
const ARCH = 'aarch64';

const pkg = JSON.parse(readFileSync('package.json', 'utf-8'));
const version = pkg.version;
const tag = `v${version}`;

const env = { ...process.env };
env.TAURI_SIGNING_PRIVATE_KEY ||= join(homedir(), '.tauri', 'invoice-generator.key');
env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ??= '';
if (!env.TAURI_SIGNING_PRIVATE_KEY.includes('\n') && !existsSync(env.TAURI_SIGNING_PRIVATE_KEY)) {
  console.error(`Signing key not found: ${env.TAURI_SIGNING_PRIVATE_KEY}`);
  process.exit(1);
}

execSync('npx tauri build --bundles app,dmg', { stdio: 'inherit', env });

const bundle = join('src-tauri', 'target', 'release', 'bundle');
const tarball = join(bundle, 'macos', `${PRODUCT}.app.tar.gz`);
const dmg = join(bundle, 'dmg', `${PRODUCT}_${version}_${ARCH}.dmg`);
for (const f of [tarball, `${tarball}.sig`, dmg]) {
  if (!existsSync(f)) { console.error(`Missing build output: ${f}`); process.exit(1); }
}

// GitHub turns spaces in asset names into dots, so stage under clean names.
const out = 'dist-release';
rmSync(out, { recursive: true, force: true });
mkdirSync(out);
const base = `${PRODUCT.replace(/ /g, '-')}_${version}_${ARCH}`;
copyFileSync(tarball, join(out, `${base}.app.tar.gz`));
copyFileSync(dmg, join(out, `${base}.dmg`));

// Release notes for the update dialog: this version's CHANGELOG section.
const changelog = readFileSync('CHANGELOG.md', 'utf-8');
const start = changelog.indexOf(`## [${version}]`);
let notes = '';
if (start !== -1) {
  const rest = changelog.slice(start);
  const next = rest.indexOf('\n## [', 1);
  notes = (next === -1 ? rest : rest.slice(0, next))
    .split('\n').slice(1).join('\n').trim()
    // renderMarkdown() in the update modal has no notion of wrapped list
    // items — join indented continuation lines onto the bullet they belong to.
    .replace(/\n {2,}(?=\S)/g, ' ');
}

const feed = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms: {
    [`darwin-${ARCH}`]: {
      signature: readFileSync(`${tarball}.sig`, 'utf-8').trim(),
      url: `https://github.com/${REPO}/releases/download/${tag}/${base}.app.tar.gz`,
    },
  },
};
writeFileSync(join(out, 'latest.json'), JSON.stringify(feed, null, 2) + '\n');

console.log(`\nStaged in ${out}/. Attach to the ${tag} release with:\n`);
console.log(`  gh release upload ${tag} ${out}/${base}.dmg ${out}/${base}.app.tar.gz ${out}/latest.json`);
