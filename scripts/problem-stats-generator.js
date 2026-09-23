const fs = require('fs');
const path = require('path');

const indexPath = path.join('problems', 'index.json');
const submissionsPath = 'submissions';
const problems = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
const stats = new Map(problems.map(problem => [problem.id, { total: 0, accepted: 0 }]));

function walk(directory) {
  if (!fs.existsSync(directory)) return;

  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath);
      continue;
    }
    if (!entry.name.endsWith('.json')) continue;

    try {
      const submission = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
      const problemStats = stats.get(submission.problemId);
      if (!problemStats) continue;
      problemStats.total += 1;
      if (submission.passed === true) problemStats.accepted += 1;
    } catch (error) {
      console.error(`忽略无效提交文件 ${fullPath}: ${error.message}`);
    }
  }
}

walk(submissionsPath);

for (const problem of problems) {
  const problemStats = stats.get(problem.id);
  problem.submitCount = problemStats.total;
  problem.acceptRate = problemStats.total > 0
    ? `${Math.round((problemStats.accepted / problemStats.total) * 100)}%`
    : '0%';
}

fs.writeFileSync(indexPath, `${JSON.stringify(problems, null, 2)}\n`);
