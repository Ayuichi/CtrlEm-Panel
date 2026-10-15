// Signs build.json so other copies of the panel accept the update.
// Run from the panel folder after the program files are final:
//   node tools/sign-build.js --init   once: makes the key pair and prints the public key
//   node tools/sign-build.js          each release: writes hashes and signature into build.json
// The private key lives outside this folder (CTRLEM_SIGNING_KEY overrides the path).
// Never commit it or send it to anyone. Keep a backup: without it, signed copies cannot update.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const KEY_FILE = process.env.CTRLEM_SIGNING_KEY || path.join(os.homedir(), '.ctrlem-panel', 'signing-key.pem');
const BUILD_FILE = path.join(ROOT, 'build.json');

if (process.argv.includes('--init')) {
  if (fs.existsSync(KEY_FILE)) {
    console.error('A key already exists at ' + KEY_FILE + '. Not replacing it.');
    process.exit(1);
  }
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true });
  fs.writeFileSync(KEY_FILE, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  console.log('Private key written to ' + KEY_FILE);
  console.log('Put this public key in UPDATE_PUBLIC_KEY in server.js:\n');
  console.log(publicKey.export({ type: 'spki', format: 'pem' }));
  process.exit(0);
}

const { buildMessage, updatePathOk, verifyBuild } = require('../server.js');

const build = JSON.parse(fs.readFileSync(BUILD_FILE, 'utf8'));
if (!Number.isInteger(build.version) || !Array.isArray(build.files)) throw new Error('build.json needs version and files');
const hashes = {};
for (const rel of build.files) {
  if (!updatePathOk(rel)) throw new Error('Not an allowed update path: ' + rel);
  if (rel === 'build.json') continue;
  const data = fs.readFileSync(path.join(ROOT, rel));
  if (data.includes(13)) throw new Error(rel + ' has CRLF line endings. GitHub would serve different bytes.');
  hashes[rel] = crypto.createHash('sha256').update(data).digest('hex');
}
const key = crypto.createPrivateKey(fs.readFileSync(KEY_FILE));
const signature = crypto.sign(null, Buffer.from(buildMessage(build.version, build.files, hashes)), key).toString('base64');
const out = { version: build.version, files: build.files, hashes, signature };
verifyBuild(out);
fs.writeFileSync(BUILD_FILE, JSON.stringify(out, null, 2) + '\n');
console.log('Signed build.json version ' + build.version + ' (' + Object.keys(hashes).length + ' files).');
console.log('Commit build.json together with those files. Editing any of them afterwards needs a new signature.');
