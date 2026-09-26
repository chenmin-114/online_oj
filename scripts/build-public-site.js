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

// GitHub Pages only receives public problem statements. Hidden tests remain in Worker KV.
const publicProblemsDirectory = path.join(outputDirectory, 'problems');
for (const filePath of walkFiles(publicProblemsDirectory)) {
  const file = path.basename(filePath);
  if (!/^p\d{3,6}(?:-[a-z0-9-]+)?\.json$/i.test(file)) continue;
  const problem = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  delete problem.testCases;
  fs.writeFileSync(filePath, `${JSON.stringify(problem, null, 2)}\n`);
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
