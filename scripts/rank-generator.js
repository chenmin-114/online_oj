const fs = require('fs');
const path = require('path');

/**
 * 递归读取 submissions 目录下的所有提交文件
 */
function loadSubmissions() {
  const submissionsDir = './submissions';
  const results = [];

  if (!fs.existsSync(submissionsDir)) {
    console.error('submissions 目录不存在');
    return results;
  }

  function walk(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.name.endsWith('.json')) {
        try {
          const data = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
          results.push(data);
        } catch (e) {
          console.error(`无效提交文件: ${fullPath}`, e.message);
        }
      }
    }
  }

  walk(submissionsDir);
  return results;
}

/**
 * 计算排名
 * 排序规则：
 * 1. 解题数降序
 * 2. 总耗时升序（仅计算首次 AC 的题目）
 * 3. 最后提交时间升序（越早越好）
 */
function calculateRanking(submissions) {
  const userStats = {};

  for (const sub of submissions) {
    const { username, problemId, passed, totalTime, timestamp } = sub;

    if (!userStats[username]) {
      userStats[username] = {
        solved: new Map(), // problemId -> first AC time
        totalAttempts: 0,
        totalTime: 0,
        lastSubmit: 0,
      };
    }

    const stats = userStats[username];
    stats.totalAttempts++;
    stats.lastSubmit = Math.max(stats.lastSubmit, timestamp);

    // 记录首次 AC
    if (passed && !stats.solved.has(problemId)) {
      stats.solved.set(problemId, timestamp);
      stats.totalTime += totalTime;
    }
  }

  // 转换为数组并排序
  return Object.entries(userStats)
    .map(([username, stats]) => ({
      username,
      solvedCount: stats.solved.size,
      totalTime: stats.totalTime,
      lastSubmit: stats.lastSubmit,
    }))
    .sort((a, b) => {
      if (b.solvedCount !== a.solvedCount) {
        return b.solvedCount - a.solvedCount;
      }
      if (a.totalTime !== b.totalTime) {
        return a.totalTime - b.totalTime;
      }
      return a.lastSubmit - b.lastSubmit;
    });
}

// 主流程
const submissions = loadSubmissions();
const ranking = calculateRanking(submissions);
process.stdout.write(JSON.stringify(ranking, null, 2));
