const fs = require('fs');
const path = require('path');

const repositoryRoot = process.cwd();
const submissionsDirectory = path.join(repositoryRoot, 'submissions');
const outputDirectory = path.join(repositoryRoot, '.d1-migration');
const outputFile = path.join(outputDirectory, 'submissions.sql');
const submissions = [];
let repairedProblemIds = 0;
const batchSize = 4;

function walk(directory) {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(entryPath);
    else if (entry.name.endsWith('.json')) submissions.push(JSON.parse(fs.readFileSync(entryPath, 'utf8')));
  }
}

function sqlText(value) {
  return `'${String(value ?? '').replace(/'/g, "''")}'`;
}

walk(submissionsDirectory);
submissions.sort((a, b) => Number(a.timestamp) - Number(b.timestamp));

const statements = [];
for (let offset = 0; offset < submissions.length; offset += batchSize) {
  const values = submissions.slice(offset, offset + batchSize).map(submission => {
    const username = String(submission.username || '').trim().normalize('NFC');
    let problemId = String(submission.problemId || '').trim().toUpperCase();
    const legacyProblemId = problemId.match(/^(P\d{3,6})_+$/);
    if (legacyProblemId) {
      problemId = legacyProblemId[1];
      repairedProblemIds += 1;
    }
    if (!username || !/^P\d{3,6}$/.test(problemId)) {
      throw new Error(`Invalid submission at timestamp ${submission.timestamp}`);
    }
    return `(${[
      sqlText(username),
      sqlText(problemId),
      submission.passed === true ? 1 : 0,
      Number(submission.passedTests) || 0,
      Number(submission.totalTests) || 0,
      Number(submission.totalTime) || 0,
      sqlText(submission.language),
      sqlText(submission.code),
      Math.trunc(Number(submission.timestamp)),
    ].join(', ')})`;
  });
  statements.push(`INSERT OR IGNORE INTO submissions (
  username, problem_id, passed, passed_tests, total_tests,
  total_time, language, code, timestamp
) VALUES\n${values.join(',\n')};`);
}

fs.mkdirSync(outputDirectory, { recursive: true });
fs.writeFileSync(outputFile, `${statements.join('\n\n')}\n`);
console.log(`Prepared ${submissions.length} submissions for D1 import.`);
console.log(`Repaired ${repairedProblemIds} legacy problem id(s).`);
console.log(outputFile);
