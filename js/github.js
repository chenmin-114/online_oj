/**
 * GitHub API 交互模块
 * 支持两种模式：
 * 1. Cloudflare Worker 代理（推荐，Token 安全）
 * 2. 直连 GitHub API（仅开发测试用）
 */
class GitHubStore {
  constructor() {
    this.workerUrl = window.OJ_CONFIG.WORKER_URL;
    this.token = window.OJ_CONFIG.GITHUB_TOKEN;
    this.repo = window.OJ_CONFIG.GITHUB_REPO;
  }

  /**
   * 提交判题结果
   * @param {string} problemId
   * @param {string} username
   * @param {object} result - Judge 返回的结果
   * @param {string} code - 用户源代码
   */
  async submit(problemId, username, result, code) {
    const timestamp = Date.now();
    const payload = {
      type: 'submit',
      username,
      problemId,
      passed: result.passed,
      passedTests: result.passedTests,
      totalTests: result.totalTests,
      totalTime: result.totalTime,
      language: result.language,
      code: btoa(unescape(encodeURIComponent(code))), // base64 编码源码
      timestamp,
    };

    // 优先走 Worker 代理
    if (this.workerUrl) {
      return this._submitViaWorker(payload);
    }

    // 降级：直连 GitHub API
    if (this.token && this.repo) {
      return this._submitDirect(payload, timestamp);
    }

    // 无后端模式：结果仅展示在本地
    console.warn('未配置提交后端，结果仅本地展示');
    return { mode: 'local', payload };
  }

  async _submitViaWorker(payload) {
    const response = await fetch(this.workerUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`提交失败 (${response.status}): ${errText}`);
    }

    return response.json();
  }

  async _submitDirect(payload, timestamp) {
    const path = `submissions/${payload.problemId}/${payload.username}_${timestamp}.json`;
    const content = btoa(JSON.stringify(payload));

    const response = await fetch(
      `https://api.github.com/repos/${this.repo}/contents/${path}`,
      {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'Accept': 'application/vnd.github.v3+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message: `🏁 ${payload.username} submitted ${payload.problemId} - ${payload.passed ? 'AC' : 'WA'}`,
          content,
        }),
      }
    );

    if (!response.ok) {
      const err = await response.json();
      throw new Error(`GitHub API 错误: ${err.message || response.status}`);
    }

    return response.json();
  }

  /**
   * 获取排名数据（从 dist/ranking.json 读取）
   */
  async getRanking() {
    // GitHub Pages 会把 dist/ranking.json 与前端一起发布，优先读取同源文件。
    // 这不需要在浏览器中配置仓库名或暴露 GitHub Token。
    const url = window.OJ_CONFIG.RANKING_URL ||
      (this.repo ? `https://raw.githubusercontent.com/${this.repo}/main/dist/ranking.json` : '');

    if (!url) return { overall: [], problems: {} };

    const separator = url.includes('?') ? '&' : '?';
    const response = await fetch(`${url}${separator}t=${Date.now()}`, {
      cache: 'no-store',
    });

    if (!response.ok) {
      throw new Error(`无法读取排名数据 (${response.status})`);
    }

    const ranking = await response.json();

    // 兼容 Actions 尚未更新完成时的旧版总榜数组。
    if (Array.isArray(ranking)) {
      return { overall: ranking, problems: {} };
    }

    if (!ranking || !Array.isArray(ranking.overall) ||
        typeof ranking.problems !== 'object' || ranking.problems === null) {
      throw new Error('排名数据格式不正确');
    }

    return ranking;
  }

  /**
   * 获取用户的提交历史（由 GitHub Actions 生成，不包含源代码）
   */
  async getSubmissions(username) {
    const url = window.OJ_CONFIG.SUBMISSIONS_URL ||
      (this.repo ? `https://raw.githubusercontent.com/${this.repo}/main/dist/submissions.json` : '');
    if (!url) return [];

    const separator = url.includes('?') ? '&' : '?';
    const response = await fetch(`${url}${separator}t=${Date.now()}`, {
      cache: 'no-store',
    });

    if (!response.ok) {
      throw new Error(`无法读取提交记录 (${response.status})`);
    }

    const submissions = await response.json();
    if (!Array.isArray(submissions)) {
      throw new Error('提交记录格式不正确');
    }

    const safeUsername = username.replace(/[^a-zA-Z0-9_-]/g, '_');
    return submissions
      .filter(item => item.username === safeUsername)
      .sort((a, b) => b.timestamp - a.timestamp);
  }
}
