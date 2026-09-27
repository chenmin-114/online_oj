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
    if (!entry.isFile() || !/^p\d{3,6}(?:-[a-z0-9-]+)?\.json$/i.test(entry.name)) continue;
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
  'js/admin-exams.js',
  'css/style.css',
  'problems/index.json',
  'problems/vision/index.json',
]) {
  if (!fs.existsSync(path.join(outputDirectory, requiredPath))) {
    throw new Error(`Pages artifact is incomplete: ${requiredPath}`);
  }
}

console.log(`Public Pages artifact created at ${outputDirectory}`);
console.log(`Published top-level entries: ${publishedEntries.sort().join(', ')}`);
