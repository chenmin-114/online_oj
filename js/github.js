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
   * 提交源码给 Worker 服务端判题。浏览器不再上报 passed 等结果字段。
   */
  async submit(problemId, username, language, code, onProgress, group = 'control') {
    const payload = {
      type: 'judge_submit_stream',
      username,
      problemId,
      language,
      code,
      group,
    };

    if (!this.workerUrl) throw new Error('服务端判题尚未配置');
    return this._submitViaWorker(payload, onProgress);
  }

  async _submitViaWorker(payload, onProgress) {
    let response;
    try {
      response = await fetch(this.workerUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch {
      throw new Error('无法连接服务端判题，请检查网络后重试');
    }

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`提交失败 (${response.status}): ${errText}`);
    }

    if (!response.body) throw new Error('判题服务未返回进度数据');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let finalResult = null;

    const handleLine = line => {
      if (!line.trim()) return;
      const event = JSON.parse(line);
      if (event.type === 'error') throw new Error(event.error || '服务端判题失败');
      if (event.type === 'result') finalResult = event.result;
      else if (onProgress) onProgress(event);
    };

    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) handleLine(line);
      if (done) break;
    }
    if (buffer.trim()) handleLine(buffer);
    if (!finalResult) throw new Error('判题连接提前结束，请重试');
    return finalResult;
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
  async getSubmissions(username, group = 'control') {
    const url = window.OJ_CONFIG.SUBMISSIONS_URL ||
      (this.repo ? `https://raw.githubusercontent.com/${this.repo}/main/dist/submissions.json` : '');
    if (!url) return [];

    // Worker 只返回当前用户名的记录，避免把所有学生的提交摘要下载到浏览器。
    const normalizedUsername = String(username).trim().normalize('NFC');
    const separator = url.includes('?') ? '&' : '?';
    const response = await fetch(
      `${url}${separator}username=${encodeURIComponent(normalizedUsername)}&group=${encodeURIComponent(group)}&t=${Date.now()}`,
      {
      cache: 'no-store',
      }
    );

    if (!response.ok) {
      throw new Error(`无法读取提交记录 (${response.status})`);
    }

    const submissions = await response.json();
    if (!Array.isArray(submissions)) {
      throw new Error('提交记录格式不正确');
    }

    // 提交数据保留原始 Unicode 用户名。不能再转成下划线，否则不同中文名
    // 会被合并到同一个身份，并且无法匹配新版保存的中文名称。
    return submissions
      .filter(item => typeof item.username === 'string'
        && item.username.trim().normalize('NFC') === normalizedUsername)
      .sort((a, b) => b.timestamp - a.timestamp);
  }
}
