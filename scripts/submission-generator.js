const fs = require('fs');
const path = require('path');

function loadSubmissionSummaries() {
  const submissionsDir = './submissions';
  const summaries = [];

  if (!fs.existsSync(submissionsDir)) return summaries;

  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.name.endsWith('.json')) {
        try {
          const submission = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
          summaries.push({
            username: submission.username,
            problemId: submission.problemId,
            passed: submission.passed,
            passedTests: submission.passedTests,
            totalTests: submission.totalTests,
            totalTime: submission.totalTime,
            language: submission.language,
            timestamp: submission.timestamp,
          });
        } catch (error) {
          console.error(`无效提交文件: ${fullPath}`, error.message);
        }
      }
    }
  }

  walk(submissionsDir);
  return summaries.sort((a, b) => b.timestamp - a.timestamp);
}

process.stdout.write(JSON.stringify(loadSubmissionSummaries(), null, 2));
