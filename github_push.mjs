/**
 * Pure Node.js GitHub API push — no git, no Xcode CLT needed.
 * Usage: node github_push.mjs <token>
 */
import fs from 'fs';
import path from 'path';
import https from 'https';

const TOKEN  = process.argv[2];
const OWNER  = 'MukulSharma24';
const REPO   = 'DataGuard';
const BRANCH = 'main';
const ROOT   = '/Users/mukulsharma/Desktop/DataGuard';

if (!TOKEN) { console.error('Usage: node github_push.mjs <token>'); process.exit(1); }

const SKIP_DIRS  = new Set(['node_modules','.next','.git','.idea','dist','out','build','coverage']);
const SKIP_FILES = new Set(['.env','.env.local','.env.production','push_to_github.sh','github_push.mjs','package-lock.json']);
const SKIP_EXTS  = new Set(['.log']);
const BINARY_EXTS = new Set(['.png','.jpg','.jpeg','.gif','.ico','.woff','.woff2','.ttf','.otf','.eot','.pdf','.zip','.gz','.webp']);

// ── GitHub API ────────────────────────────────────────────────────────────────
function api(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req  = https.request({
      hostname: 'api.github.com',
      path:     urlPath,
      method,
      headers: {
        'Authorization': `token ${TOKEN}`,
        'User-Agent':    'DataGuard-pusher/1.0',
        'Accept':        'application/vnd.github.v3+json',
        'Content-Type':  'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(raw);
          if (res.statusCode >= 400) reject(new Error(`GitHub ${res.statusCode}: ${json.message}`));
          else resolve(json);
        } catch { resolve(raw); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// ── Collect files ─────────────────────────────────────────────────────────────
function collect(dir, base = '') {
  const results = [];
  for (const entry of fs.readdirSync(dir)) {
    if (SKIP_FILES.has(entry)) continue;
    const abs  = path.join(dir, entry);
    const rel  = base ? `${base}/${entry}` : entry;
    const stat = fs.statSync(abs);
    if (stat.isDirectory()) {
      if (SKIP_DIRS.has(entry)) continue;
      results.push(...collect(abs, rel));
    } else {
      const ext = path.extname(entry).toLowerCase();
      if (SKIP_EXTS.has(ext)) continue;
      results.push({ abs, rel, binary: BINARY_EXTS.has(ext) });
    }
  }
  return results;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n📦 Collecting files...`);
  const files = collect(ROOT);
  console.log(`   ${files.length} files found\n`);

  // ── Step 1: Initialize empty repo by creating README via Contents API ─────
  let baseSha = null, baseTreeSha = null;
  try {
    const ref    = await api('GET', `/repos/${OWNER}/${REPO}/git/refs/heads/${BRANCH}`);
    baseSha      = ref.object?.sha;
    const commit = await api('GET', `/repos/${OWNER}/${REPO}/git/commits/${baseSha}`);
    baseTreeSha  = commit.tree?.sha;
    console.log(`🔗 Existing branch at ${baseSha.slice(0,7)}`);
  } catch {
    console.log(`🌱 Empty repo — initializing with README...`);
    const readmePath = path.join(ROOT, 'README.md');
    const content    = Buffer.from(fs.readFileSync(readmePath)).toString('base64');
    const created    = await api('PUT', `/repos/${OWNER}/${REPO}/contents/README.md`, {
      message: 'chore: init repository',
      content,
      branch: BRANCH,
    });
    baseSha     = created.commit.sha;
    baseTreeSha = created.commit.tree.sha;
    console.log(`   ✓ Initialized at ${baseSha.slice(0,7)}\n`);
  }

  // ── Step 2: Create blobs for every file ──────────────────────────────────
  console.log('📤 Uploading files (this takes ~1 min)...');
  const treeEntries = [];
  let i = 0;
  for (const { abs, rel, binary } of files) {
    i++;
    process.stdout.write(`\r   [${i}/${files.length}] ${rel.slice(-65).padEnd(65)}`);
    const raw     = fs.readFileSync(abs);
    if (raw.length > 8_000_000) { console.log(`\n⚠️  Skipping ${rel} (>8MB)`); continue; }
    const content  = binary ? raw.toString('base64') : raw.toString('utf8');
    const encoding = binary ? 'base64' : 'utf-8';
    const blob     = await api('POST', `/repos/${OWNER}/${REPO}/git/blobs`, { content, encoding });
    treeEntries.push({ path: rel, mode: '100644', type: 'blob', sha: blob.sha });
  }
  console.log('\n');

  // ── Step 3: Create tree ───────────────────────────────────────────────────
  console.log('🌳 Building tree...');
  const tree = await api('POST', `/repos/${OWNER}/${REPO}/git/trees`, {
    base_tree: baseTreeSha,
    tree: treeEntries,
  });

  // ── Step 4: Create commit ─────────────────────────────────────────────────
  console.log('✍️  Creating commit...');
  const commit = await api('POST', `/repos/${OWNER}/${REPO}/git/commits`, {
    message: 'feat: DataGuard v1.0 — full project\n\n' +
      '- Next.js 14 + Tailwind CSS frontend (Stripe/Linear-inspired UI)\n' +
      '- Express.js REST API with Supabase PostgreSQL\n' +
      '- Async PII scanner: 11 categories + Gemini LLM classification\n' +
      '- JWT auth, AES-256 encrypted credentials\n' +
      '- Data catalogue, data map, live scan log streaming',
    tree: tree.sha,
    parents: [baseSha],
  });

  // ── Step 5: Update branch ref ─────────────────────────────────────────────
  console.log('🚀 Pushing to GitHub...');
  await api('PATCH', `/repos/${OWNER}/${REPO}/git/refs/heads/${BRANCH}`, {
    sha: commit.sha, force: true,
  });

  console.log(`\n✅ Done! Commit: ${commit.sha.slice(0,7)}`);
  console.log(`🔗 https://github.com/${OWNER}/${REPO}\n`);
}

main().catch(e => { console.error('\n❌', e.message); process.exit(1); });
