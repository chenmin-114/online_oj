const fs = require('fs');
const path = require('path');

const repositoryRoot = process.cwd();
const outputDirectory = path.resolve(repositoryRoot, '.pages-site');

if (outputDirectory === repositoryRoot || !outputDirectory.startsWith(`${repositoryRoot}${path.sep}`)) {
  throw new Error('Refusing to build outside the repository workspace');
}

const publicFiles = ['index.html', 'admin.html', 'CNAME'];
const publicDirectories = ['assets', 'css', 'js', 'vendor', 'problems'];
const forbiddenTopLevelEntries = new Set([
  '.git',
  '.github',
  '.wrangler',
  'cloudflare',
  'dist',
  'scripts',
  'submissions',
  'README.md',
  'logo.jpg',
]);

fs.rmSync(outputDirectory, { recursive: true, force: true });
fs.mkdirSync(outputDirectory, { recursive: true });

for (const file of publicFiles) {
  const source = path.join(repositoryRoot, file);
  if (!fs.existsSync(source)) throw new Error(`Required public file is missing: ${file}`);
  fs.copyFileSync(source, path.join(outputDirectory, file));
}

for (const directory of publicDirectories) {
  const source = path.join(repositoryRoot, directory);
  if (!fs.existsSync(source)) throw new Error(`Required public directory is missing: ${directory}`);
  fs.cpSync(source, path.join(outputDirectory, directory), { recursive: true });
}

buildClaudeHelperDownload();

function buildClaudeHelperDownload() {
  const downloadsDirectory = path.join(outputDirectory, 'downloads');
  fs.mkdirSync(downloadsDirectory, { recursive: true });
  const helperFiles = [
    'start-claude-grading-helper.cmd',
    'claude-grading-server.js',
    'claude-grade.js',
    'CLAUDE-GRADING-HELPER-README.txt',
  ].map(name => {
    const source = path.join(repositoryRoot, 'scripts', name);
    if (!fs.existsSync(source)) throw new Error(`Claude helper file is missing: ${name}`);
    let data = fs.readFileSync(source);
    if (name.endsWith('.cmd') || name.endsWith('.txt')) {
      data = Buffer.from(data.toString('utf8').replace(/\r?\n/g, '\r\n'), 'utf8');
    }
    return { name, data };
  });
  fs.writeFileSync(
    path.join(downloadsDirectory, 'claude-grading-helper.zip'),
    createStoredZip(helperFiles),
  );
}

function createStoredZip(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8');
    const data = Buffer.from(file.data);
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(33, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(33, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// GitHub Pages only receives published problem statements. Drafts remain available
// to the authenticated admin through the Worker/GitHub API, and hidden tests stay in KV.
const publicProblemsDirectory = path.join(outputDirectory, 'problems');
sanitizeProblemDirectory(publicProblemsDirectory);
sanitizeProblemDirectory(path.join(publicProblemsDirectory, 'vision'));

function sanitizeProblemDirectory(directory) {
  const indexPath = path.join(directory, 'index.json');
  if (!fs.existsSync(indexPath)) return;
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  if (!Array.isArray(index)) throw new Error(`Problem index must be an array: ${indexPath}`);
  const published = index.filter(problem => problem.status !== 'draft');
  const publishedFiles = new Set(published.map(problem => problem.file));
  fs.writeFileSync(indexPath, `${JSON.stringify(published, null, 2)}\n`);

  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !/^(?:p\d{3,6}|t\d{3})(?:-[a-z0-9-]+)?\.json$/i.test(entry.name)) continue;
    const filePath = path.join(directory, entry.name);
    if (!publishedFiles.has(entry.name)) {
      fs.unlinkSync(filePath);
      continue;
    }
    const problem = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    delete problem.testCases;
    fs.writeFileSync(filePath, `${JSON.stringify(problem, null, 2)}\n`);
  }
}

function walkFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const entryPath = path.join(directory, entry.name);
    return entry.isDirectory() ? walkFiles(entryPath) : [entryPath];
  });
}

fs.writeFileSync(path.join(outputDirectory, '.nojekyll'), '');

const publishedEntries = fs.readdirSync(outputDirectory);
const leakedEntry = publishedEntries.find(entry => forbiddenTopLevelEntries.has(entry));
if (leakedEntry) throw new Error(`Forbidden entry entered the Pages artifact: ${leakedEntry}`);

for (const requiredPath of [
  'index.html',
  'admin.html',
  'js/app.js',
  'js/admin.js',
  'js/exams.js',
  'js/exam-docx.js',
  'js/admin-exams.js',
  'css/style.css',
  'vendor/jszip/jszip.min.js',
  'downloads/claude-grading-helper.zip',
  'problems/index.json',
  'problems/vision/index.json',
]) {
  if (!fs.existsSync(path.join(outputDirectory, requiredPath))) {
    throw new Error(`Pages artifact is incomplete: ${requiredPath}`);
  }
}

console.log(`Public Pages artifact created at ${outputDirectory}`);
console.log(`Published top-level entries: ${publishedEntries.sort().join(', ')}`);
