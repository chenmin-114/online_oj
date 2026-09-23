const fs = require('fs');
const path = require('path');

const problemsDirectory = path.join(process.cwd(), 'problems');

for (const file of fs.readdirSync(problemsDirectory)) {
  if (!/^p\d{3,6}(?:-[a-z0-9-]+)?\.json$/i.test(file)) continue;
  const filePath = path.join(problemsDirectory, file);
  const problem = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!Object.prototype.hasOwnProperty.call(problem, 'testCases')) continue;
  delete problem.testCases;
  fs.writeFileSync(filePath, `${JSON.stringify(problem, null, 2)}\n`);
  console.log(`Removed public testCases from ${file}`);
}
