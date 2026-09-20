class OJAdmin {
  constructor() {
    const workerUrl = 'https://api.jc-oj.online';
    this.config = {
      workerUrl,
      repo: 'chenmin-114/online_oj',
      problemsUrl: 'problems/index.json',
      // 数据经 Worker 直读，绕开 GitHub Pages CDN 的 10 分钟缓存
      submissionsUrl: `${workerUrl}/?file=submissions`,
      rankingUrl: `${workerUrl}/?file=ranking-v2`,
      legacyRankingUrl: 'dist/ranking.json',
    };
    this.problems = [];
    this.submissions = [];
    this.ranking = { overall: [], problems: {} };
    this.filteredSubmissions = [];
  }

  async init() {
    this.bindNavigation();
    this.bindControls();
    await this.loadAll();
  }

  bindNavigation() {
    document.querySelectorAll('.admin-nav-item').forEach(button => {
      button.addEventListener('click', () => this.openPanel(button.dataset.panel));
    });
    document.querySelectorAll('[data-open-panel]').forEach(button => {
      button.addEventListener('click', () => this.openPanel(button.dataset.openPanel));
    });
  }

  bindControls() {
    document.getElementById('refresh-admin').addEventListener('click', () => this.loadAll());
    document.getElementById('submission-search').addEventListener('input', () => this.renderSubmissions());
    document.getElementById('submission-problem').addEventListener('change', () => this.renderSubmissions());
    document.getElementById('submission-result').addEventListener('change', () => this.renderSubmissions());
    document.getElementById('export-submissions').addEventListener('click', () => this.exportSubmissions());
    document.getElementById('admin-ranking-scope').addEventListener('change', event => {
      this.renderLeaderboard(event.target.value);
    });
    document.getElementById('show-problem-editor').addEventListener('click', () => this.showProblemEditor());
    document.getElementById('close-problem-editor').addEventListener('click', () => this.hideProblemEditor());
    document.getElementById('reset-problem-editor').addEventListener('click', () => this.resetProblemEditor());
    document.getElementById('add-test-case').addEventListener('click', () => this.addTestCase());
    document.getElementById('problem-editor').addEventListener('submit', event => this.saveProblem(event));
    document.getElementById('problem-id').addEventListener('input', event => {
      const fileInput = document.getElementById('problem-file');
      if (!fileInput.value || /^p\d+\.json$/i.test(fileInput.value)) {
        const id = event.target.value.trim().toLowerCase();
        fileInput.value = id ? `${id}.json` : '';
      }
    });
  }

  openPanel(name) {
    document.querySelectorAll('.admin-nav-item').forEach(item => {
      item.classList.toggle('active', item.dataset.panel === name);
    });
    document.querySelectorAll('.admin-panel').forEach(panel => {
      panel.classList.toggle('active', panel.id === `panel-${name}`);
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async loadAll() {
    const button = document.getElementById('refresh-admin');
    button.disabled = true;
    button.textContent = '↻ 同步中...';

    const workerCheck = this.fetchWorkerHealth();
    const [problemsResult, submissionsResult, rankingResult] = await Promise.allSettled([
      this.fetchJson(this.config.problemsUrl),
      this.fetchJson(this.config.submissionsUrl),
      this.fetchRanking(),
    ]);

    if (problemsResult.status === 'fulfilled' && Array.isArray(problemsResult.value)) {
      this.problems = problemsResult.value;
    }
    if (submissionsResult.status === 'fulfilled' && Array.isArray(submissionsResult.value)) {
      this.submissions = submissionsResult.value.sort((a, b) => b.timestamp - a.timestamp);
    }
    if (rankingResult.status === 'fulfilled') {
      this.ranking = Array.isArray(rankingResult.value)
        ? { overall: rankingResult.value, problems: {} }
        : rankingResult.value;
    }

    this.renderAll();
    this.updateDataStatus({ submissionsResult, rankingResult });
    this.setStatus('worker', null, '正在检查连接...');
    workerCheck.then(result => {
      this.setStatus('worker', true,
        `${result.executionProvider} · GitHub ${result.githubConfigured ? '已配置' : '未配置'}`);
    }).catch(() => {
      this.setStatus('worker', false, '连接失败');
    });
    document.getElementById('sync-status').textContent = `更新于 ${new Date().toLocaleTimeString()}`;
    button.disabled = false;
    button.textContent = '↻ 刷新数据';
    this.toast('管理数据已刷新');
  }

  async fetchJson(url) {
    const separator = url.includes('?') ? '&' : '?';
    const response = await fetch(`${url}${separator}t=${Date.now()}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    return response.json();
  }

  async fetchRanking() {
    try {
      return await this.fetchJson(this.config.rankingUrl);
    } catch {
      return this.fetchJson(this.config.legacyRankingUrl);
    }
  }

  async fetchWorkerHealth() {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 6000);
    const response = await fetch(this.config.workerUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'health' }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!response.ok) throw new Error(`Worker: HTTP ${response.status}`);
    return response.json();
  }

  renderAll() {
    this.renderMetrics();
    this.renderRecentSubmissions();
    this.renderProblemActivity();
    this.renderProblems();
    this.populateFilters();
    this.renderSubmissions();
    this.populateRankingSelector();
    this.renderLeaderboard('overall');
  }

  renderMetrics() {
    const accepted = this.submissions.filter(item => item.passed).length;
    const users = new Set(this.submissions.map(item => item.username)).size;
    const rate = this.submissions.length ? Math.round(accepted / this.submissions.length * 100) : 0;
    document.getElementById('metric-problems').textContent = this.problems.length;
    document.getElementById('metric-submissions').textContent = this.submissions.length;
    document.getElementById('metric-acceptance').textContent = `${rate}%`;
    document.getElementById('metric-users').textContent = users;
  }

  renderRecentSubmissions() {
    const body = document.getElementById('recent-submissions');
    const rows = this.submissions.slice(0, 8);
    body.innerHTML = rows.length ? rows.map(item => `
      <tr>
        <td>${this.escape(item.username)}</td>
        <td>${this.escape(item.problemId)}</td>
        <td>${this.resultPill(item.passed)}</td>
        <td>${this.formatDate(item.timestamp)}</td>
      </tr>
    `).join('') : '<tr><td colspan="4" class="empty-cell">暂无提交记录</td></tr>';
  }

  renderProblemActivity() {
    const container = document.getElementById('problem-activity');
    const counts = this.countBy(this.submissions, item => item.problemId);
    const max = Math.max(1, ...Object.values(counts));
    const active = this.problems
      .map(problem => ({ ...problem, actualCount: counts[problem.id] || 0 }))
      .sort((a, b) => b.actualCount - a.actualCount)
      .slice(0, 6);

    container.innerHTML = active.length ? active.map(problem => `
      <div class="activity-row">
        <div class="activity-row-header"><span>${this.escape(problem.id)} · ${this.escape(problem.title)}</span><span>${problem.actualCount} 次</span></div>
        <div class="activity-track"><div class="activity-bar" style="width:${problem.actualCount / max * 100}%"></div></div>
      </div>
    `).join('') : '<p class="empty-cell">暂无题目</p>';
  }

  renderProblems() {
    const body = document.getElementById('problem-admin-list');
    const counts = this.countBy(this.submissions, item => item.problemId);
    const accepted = this.countBy(this.submissions.filter(item => item.passed), item => item.problemId);
    body.innerHTML = this.problems.length ? this.problems.map(problem => `
      <tr>
        <td><strong>${this.escape(problem.id)}</strong></td>
        <td>${this.escape(problem.title)}</td>
        <td><span class="difficulty-pill ${this.escape(problem.difficulty)}">${this.difficultyText(problem.difficulty)}</span></td>
        <td>${counts[problem.id] || 0}</td>
        <td>${accepted[problem.id] || 0}</td>
        <td><a class="table-link" target="_blank" rel="noopener" href="https://github.com/${this.config.repo}/edit/main/problems/${encodeURIComponent(problem.file)}">编辑 ↗</a></td>
      </tr>
    `).join('') : '<tr><td colspan="6" class="empty-cell">暂无题目</td></tr>';
  }

  showProblemEditor() {
    const editor = document.getElementById('problem-editor');
    editor.hidden = false;
    if (!document.querySelector('.test-case-row')) this.addTestCase();
    editor.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setTimeout(() => document.getElementById('problem-id').focus(), 250);
  }

  hideProblemEditor() {
    document.getElementById('problem-editor').hidden = true;
  }

  resetProblemEditor() {
    document.getElementById('problem-editor').reset();
    document.getElementById('test-case-editor').innerHTML = '';
    document.getElementById('problem-save-status').textContent = '';
    this.addTestCase();
  }

  addTestCase(input = '', expectedOutput = '') {
    const container = document.getElementById('test-case-editor');
    const number = container.children.length + 1;
    const row = document.createElement('div');
    row.className = 'test-case-row';
    row.innerHTML = `
      <label class="form-field"><span>测试点 ${number} 输入</span><textarea class="admin-input test-input" rows="3"></textarea></label>
      <label class="form-field"><span>期望输出</span><textarea class="admin-input test-output" rows="3"></textarea></label>
      <button type="button" class="remove-test-case" title="删除测试点">×</button>
    `;
    row.querySelector('.test-input').value = input;
    row.querySelector('.test-output').value = expectedOutput;
    row.querySelector('.remove-test-case').addEventListener('click', () => {
      if (container.children.length === 1) {
        row.querySelector('.test-input').value = '';
        row.querySelector('.test-output').value = '';
        return;
      }
      row.remove();
      this.renumberTestCases();
    });
    container.appendChild(row);
  }

  renumberTestCases() {
    document.querySelectorAll('.test-case-row').forEach((row, index) => {
      row.querySelector('.form-field span').textContent = `测试点 ${index + 1} 输入`;
    });
  }

  async saveProblem(event) {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.reportValidity()) return;

    const testCases = Array.from(document.querySelectorAll('.test-case-row')).map(row => ({
      input: row.querySelector('.test-input').value,
      expectedOutput: row.querySelector('.test-output').value,
    }));
    const problem = {
      id: document.getElementById('problem-id').value,
      title: document.getElementById('problem-title').value,
      difficulty: document.getElementById('problem-difficulty').value,
      description: document.getElementById('problem-description').value,
      inputFormat: document.getElementById('problem-input-format').value,
      outputFormat: document.getElementById('problem-output-format').value,
      constraints: document.getElementById('problem-constraints').value,
      sampleInput: document.getElementById('problem-sample-input').value,
      sampleOutput: document.getElementById('problem-sample-output').value,
      testCases,
      hints: document.getElementById('problem-hints').value.split('\n').map(item => item.trim()).filter(Boolean),
    };

    const saveButton = document.getElementById('save-problem');
    const status = document.getElementById('problem-save-status');
    saveButton.disabled = true;
    saveButton.textContent = '正在发布...';
    status.textContent = '正在写入 GitHub 仓库';

    try {
      const response = await fetch(this.config.workerUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'create_problem',
          file: document.getElementById('problem-file').value,
          problem,
        }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || `发布失败 (${response.status})`);

      this.problems.push(result.problem);
      this.problems.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
      this.renderMetrics();
      this.renderProblems();
      this.populateFilters();
      this.populateRankingSelector();
      this.toast(`${result.problem.id} 已发布，前台将在 GitHub Pages 更新后显示`);
      this.resetProblemEditor();
      this.hideProblemEditor();
    } catch (error) {
      status.textContent = error instanceof TypeError
        ? '无法连接 Worker，请检查网络后重试'
        : error.message;
    } finally {
      saveButton.disabled = false;
      saveButton.textContent = '保存并发布题目';
    }
  }

  populateFilters() {
    const problemFilter = document.getElementById('submission-problem');
    const currentFilter = problemFilter.value;
    problemFilter.innerHTML = '<option value="">全部题目</option>' + this.problems.map(problem =>
      `<option value="${this.escape(problem.id)}">${this.escape(problem.id)} · ${this.escape(problem.title)}</option>`
    ).join('');
    problemFilter.value = currentFilter;
  }

  renderSubmissions() {
    const query = document.getElementById('submission-search').value.trim().toLowerCase();
    const problem = document.getElementById('submission-problem').value;
    const result = document.getElementById('submission-result').value;

    this.filteredSubmissions = this.submissions.filter(item => {
      const matchesQuery = !query || item.username.toLowerCase().includes(query) || item.problemId.toLowerCase().includes(query);
      const matchesProblem = !problem || item.problemId === problem;
      const matchesResult = !result || (result === 'accepted' ? item.passed : !item.passed);
      return matchesQuery && matchesProblem && matchesResult;
    });

    document.getElementById('submission-count').textContent = `${this.filteredSubmissions.length} 条记录`;
    const body = document.getElementById('all-submissions');
    body.innerHTML = this.filteredSubmissions.length ? this.filteredSubmissions.map(item => `
      <tr>
        <td>${this.formatDate(item.timestamp)}</td>
        <td>${this.escape(item.username)}</td>
        <td>${this.escape(item.problemId)}</td>
        <td>${this.escape(item.language)}</td>
        <td>${this.resultPill(item.passed)}</td>
        <td>${item.passedTests}/${item.totalTests}</td>
        <td>${item.totalTime}ms</td>
      </tr>
    `).join('') : '<tr><td colspan="7" class="empty-cell">没有符合条件的提交</td></tr>';
  }

  populateRankingSelector() {
    const select = document.getElementById('admin-ranking-scope');
    const current = select.value;
    select.innerHTML = '<option value="overall">总榜</option>' + this.problems.map(problem =>
      `<option value="${this.escape(problem.id)}">${this.escape(problem.id)} · ${this.escape(problem.title)}</option>`
    ).join('');
    select.value = current || 'overall';
  }

  renderLeaderboard(scope) {
    const container = document.getElementById('admin-ranking-content');
    if (scope === 'overall') {
      const items = this.ranking.overall || [];
      container.innerHTML = `<table class="admin-table"><thead><tr><th>排名</th><th>用户</th><th>解题数</th><th>总耗时</th><th>最后提交</th></tr></thead><tbody>${
        items.length ? items.map((item, index) => `<tr><td>#${index + 1}</td><td>${this.escape(item.username)}</td><td>${item.solvedCount}</td><td>${item.totalTime}ms</td><td>${this.formatDate(item.lastSubmit)}</td></tr>`).join('')
          : '<tr><td colspan="5" class="empty-cell">暂无总榜数据</td></tr>'
      }</tbody></table>`;
      return;
    }

    const items = this.ranking.problems?.[scope] || [];
    container.innerHTML = `<table class="admin-table"><thead><tr><th>排名</th><th>用户</th><th>判题耗时</th><th>通过前尝试</th><th>通过时间</th></tr></thead><tbody>${
      items.length ? items.map((item, index) => `<tr><td>#${index + 1}</td><td>${this.escape(item.username)}</td><td>${item.totalTime}ms</td><td>${item.attempts}</td><td>${this.formatDate(item.acceptedAt)}</td></tr>`).join('')
        : '<tr><td colspan="5" class="empty-cell">这道题还没有通过记录</td></tr>'
    }</tbody></table>`;
  }

  updateDataStatus(results) {
    this.setStatus('github', results.submissionsResult.status === 'fulfilled',
      results.submissionsResult.status === 'fulfilled' ? `${this.submissions.length} 条提交已同步` : '数据读取失败');
    this.setStatus('ranking', results.rankingResult.status === 'fulfilled',
      results.rankingResult.status === 'fulfilled' ? `${this.ranking.overall?.length || 0} 名用户` : '排名读取失败');
  }

  setStatus(name, online, text) {
    const state = online === null ? 'pending' : (online ? 'online' : 'offline');
    document.getElementById(`status-${name}-dot`).className = `status-dot ${state}`;
    document.getElementById(`status-${name}`).textContent = text;
  }

  exportSubmissions() {
    if (!this.filteredSubmissions.length) {
      this.toast('当前没有可导出的记录');
      return;
    }
    const header = ['timestamp', 'username', 'problemId', 'language', 'passed', 'passedTests', 'totalTests', 'totalTime'];
    const rows = this.filteredSubmissions.map(item => header.map(key => this.csvCell(item[key])).join(','));
    const blob = new Blob(['\ufeff' + [header.join(','), ...rows].join('\n')], { type: 'text/csv;charset=utf-8' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `oj-submissions-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
    this.toast(`已导出 ${this.filteredSubmissions.length} 条记录`);
  }

  countBy(items, selector) {
    return items.reduce((counts, item) => {
      const key = selector(item);
      counts[key] = (counts[key] || 0) + 1;
      return counts;
    }, {});
  }

  resultPill(passed) {
    return `<span class="result-pill ${passed ? 'accepted' : 'failed'}">${passed ? 'Accepted' : '未通过'}</span>`;
  }

  difficultyText(value) {
    return ({ easy: '简单', medium: '中等', hard: '困难' })[value] || value;
  }

  formatDate(timestamp) {
    return Number.isFinite(Number(timestamp)) ? new Date(Number(timestamp)).toLocaleString() : '—';
  }

  csvCell(value) {
    const text = String(value ?? '');
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  escape(value) {
    const div = document.createElement('div');
    div.textContent = String(value ?? '');
    return div.innerHTML;
  }

  toast(message) {
    const toast = document.getElementById('admin-toast');
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => toast.classList.remove('show'), 2200);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  window.ojAdmin = new OJAdmin();
  window.ojAdmin.init();
});
