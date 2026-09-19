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
    if (!this.repo) return [];

    try {
      const url = `https://raw.githubusercontent.com/${this.repo}/main/dist/ranking.json`;
      const response = await fetch(url);
      if (!response.ok) return [];
      return response.json();
    } catch {
      return [];
    }
  }

  /**
   * 获取用户的提交历史
   */
  async getSubmissions(username) {
    if (!this.token || !this.repo) return [];

    try {
      const url = `https://api.github.com/repos/${this.repo}/contents/submissions`;
      const response = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'Accept': 'application/vnd.github.v3+json',
        },
      });

      if (!response.ok) return [];

      const dirs = await response.json();
      const submissions = [];

      for (const dir of dirs) {
        if (dir.type !== 'dir') continue;
        const filesRes = await fetch(dir.url, {
          headers: {
            'Authorization': `Bearer ${this.token}`,
            'Accept': 'application/vnd.github.v3+json',
          },
        });
        if (!filesRes.ok) continue;
        const files = await filesRes.json();

        for (const file of files) {
          if (!file.name.startsWith(username + '_') || !file.name.endsWith('.json')) continue;
          const fileRes = await fetch(file.download_url);
          if (!fileRes.ok) continue;
          const data = await fileRes.json();
          submissions.push(data);
        }
      }

      return submissions.sort((a, b) => b.timestamp - a.timestamp);
    } catch {
      return [];
    }
  }
}
