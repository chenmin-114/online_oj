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
 * 计算总榜和单题排行榜。
 * 总榜：解题数降序、首次 AC 总耗时升序、最后提交时间升序。
 * 单题榜：首次 AC 判题耗时升序、AC 时间升序。
 */
function calculateRanking(submissions) {
  const userStats = new Map();
  const problemStats = new Map();

  // 文件遍历顺序不等于提交顺序；先排序才能准确找出首次 AC。
  submissions.sort((a, b) => Number(a.timestamp) - Number(b.timestamp));

  for (const sub of submissions) {
    const { username, problemId, passed, totalTime, timestamp } = sub;
    if (!username || !problemId || !Number.isFinite(Number(timestamp))) continue;

    if (!userStats.has(username)) {
      userStats.set(username, {
        solved: new Map(),
        totalAttempts: 0,
        totalTime: 0,
        lastSubmit: 0,
      });
    }

    const stats = userStats.get(username);
    stats.totalAttempts++;
    stats.lastSubmit = Math.max(stats.lastSubmit, Number(timestamp));

    if (passed && !stats.solved.has(problemId)) {
      const executionTime = Number(totalTime) || 0;
      stats.solved.set(problemId, { timestamp: Number(timestamp), executionTime });
      stats.totalTime += executionTime;
    }

    if (!problemStats.has(problemId)) problemStats.set(problemId, new Map());
    const users = problemStats.get(problemId);
    if (!users.has(username)) {
      users.set(username, { attempts: 0, acceptedAt: null, totalTime: null });
    }

    const problemUser = users.get(username);
    if (problemUser.acceptedAt === null) {
      problemUser.attempts++;
      if (passed) {
        problemUser.acceptedAt = Number(timestamp);
        problemUser.totalTime = Number(totalTime) || 0;
      }
    }
  }

  const overall = Array.from(userStats.entries())
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

  const problems = {};
  for (const [problemId, users] of problemStats.entries()) {
    problems[problemId] = Array.from(users.entries())
      .filter(([, stats]) => stats.acceptedAt !== null)
      .map(([username, stats]) => ({ username, ...stats }))
      .sort((a, b) => {
        if (a.totalTime !== b.totalTime) return a.totalTime - b.totalTime;
        return a.acceptedAt - b.acceptedAt;
      });
  }

  return { overall, problems };
}

// 主流程
const submissions = loadSubmissions();
const ranking = calculateRanking(submissions);
process.stdout.write(JSON.stringify(ranking, null, 2));
