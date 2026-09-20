/**
 * 主控制器
 * 协调各模块，处理用户交互
 */
class App {
  constructor() {
    this.runner = new CodeRunner();
    this.judge = new Judge(this.runner);
    this.github = new GitHubStore();
    this.editor = null;
    this.views = new ViewManager();
    this.currentProblem = null;
    this.problemList = [];
    this.username = localStorage.getItem('oj_username') || '';
  }

  async init() {
    // 初始化视图
    this.views.init();

    // 初始化编辑器
    this.editor = new EditorManager('editor-container');
    await this.editor.init();

    // 加载题目列表
    await this.loadProblemList();

    // 绑定事件
    this._bindEvents();

    // 检查用户名
    if (!this.username) {
      this._promptUsername();
    } else {
      document.getElementById('username-display').textContent = this.username;
    }
  }

  async loadProblemList() {
    try {
      const configuredUrl = window.OJ_CONFIG.PROBLEMS_URL;
      let response;

      try {
        response = await fetch(configuredUrl || 'problems/index.json', { cache: 'no-store' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
      } catch (workerError) {
        if (!configuredUrl) throw workerError;
        // 自定义接口暂时不可达时，仍允许从 GitHub Pages 加载题目列表。
        response = await fetch(`problems/index.json?t=${Date.now()}`, { cache: 'no-store' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
      }

      const problems = await response.json();
      this.problemList = problems;
      this._renderProblemList(problems);
    } catch (err) {
      console.error('加载题目列表失败:', err);
      document.getElementById('problem-list').innerHTML = 
        '<p class="error">题目列表加载失败，请检查 problems/index.json</p>';
    }
  }

  _renderProblemList(problems) {
    const container = document.getElementById('problem-list');
    container.innerHTML = problems.map(p => `
      <div class="problem-card" data-id="${p.id}" data-file="${p.file}">
        <div class="problem-header">
          <span class="problem-id">${p.id}</span>
          <span class="problem-title">${p.title}</span>
          <span class="difficulty ${p.difficulty}">${this._difficultyText(p.difficulty)}</span>
        </div>
        <div class="problem-meta">
          <span>通过率: ${p.acceptRate || 'N/A'}</span>
          <span>提交: ${p.submitCount || 0}</span>
        </div>
      </div>
    `).join('');

    // 绑定点击事件
    container.querySelectorAll('.problem-card').forEach(card => {
      card.addEventListener('click', () => {
        const file = card.dataset.file;
        this.loadProblem(file);
      });
    });
  }

  _difficultyText(diff) {
    const map = { easy: '简单', medium: '中等', hard: '困难' };
    return map[diff] || diff;
  }

  async loadProblem(file) {
    try {
      const response = await fetch(`problems/${file}`);
      this.currentProblem = await response.json();
      this._renderProblem();
      this.views.show('solve');
    } catch (err) {
      alert('题目加载失败: ' + err.message);
    }
  }

  _renderProblem() {
    const p = this.currentProblem;
    document.getElementById('problem-title').textContent = `${p.id}. ${p.title}`;
    const markdownFields = [
      ['problem-description', p.description],
      ['problem-input-format', p.inputFormat],
      ['problem-output-format', p.outputFormat],
      ['problem-constraints', p.constraints],
    ];
    markdownFields.forEach(([id, value]) => {
      const container = document.getElementById(id);
      container.innerHTML = this._formatMarkdown(value || '');
      this._enhanceMarkdown(container);
    });
    
    this._renderSamples(p);

    // 重置编辑器
    const lang = getLanguageById(window.OJ_CONFIG.DEFAULT_LANGUAGE);
    this.editor.setLanguage(lang.id);
    this.editor.setCode(lang.template);
  }

  _formatMarkdown(text) {
    const source = String(text || '');
    if (!window.marked || !window.DOMPurify) {
      return `<p>${this._escapeHtml(source).replace(/\n/g, '<br>')}</p>`;
    }

    try {
      const html = window.marked.parse(source, {
        gfm: true,
        breaks: true,
      });
      return window.DOMPurify.sanitize(html, {
        USE_PROFILES: { html: true },
      });
    } catch {
      return `<p>${this._escapeHtml(source).replace(/\n/g, '<br>')}</p>`;
    }
  }

  _renderSamples(problem) {
    const samples = Array.isArray(problem.samples) && problem.samples.length
      ? problem.samples
      : ((problem.sampleInput || problem.sampleOutput)
        ? [{ input: problem.sampleInput || '', output: problem.sampleOutput || '' }]
        : []);
    const container = document.getElementById('problem-samples');
    container.innerHTML = samples.length ? samples.map((sample, index) => `
      <div class="sample-group">
        <div class="sample">
          <div><strong>输入 #${index + 1}</strong><pre data-sample-input>${this._escapeHtml(sample.input || '')}</pre></div>
          <div><strong>输出 #${index + 1}</strong><pre>${this._escapeHtml(sample.output || '')}</pre></div>
        </div>
      </div>
    `).join('') : '<p>暂无样例</p>';
  }

  _enhanceMarkdown(container) {
    container.querySelectorAll('img').forEach(image => {
      image.classList.add('problem-image');
      image.loading = 'lazy';
    });

    container.querySelectorAll('a').forEach(link => {
      if (/^https?:\/\//i.test(link.getAttribute('href') || '')) {
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
      }
    });

    if (window.hljs) {
      container.querySelectorAll('pre code').forEach(block => window.hljs.highlightElement(block));
    }

    if (window.renderMathInElement) {
      window.renderMathInElement(container, {
        delimiters: [
          { left: '$$', right: '$$', display: true },
          { left: '$', right: '$', display: false },
          { left: '\\(', right: '\\)', display: false },
          { left: '\\[', right: '\\]', display: true },
        ],
        throwOnError: false,
      });
    }
  }

  _bindEvents() {
    // 语言切换
    document.getElementById('language-select').addEventListener('change', (e) => {
      const langId = e.target.value;
      this.editor.setLanguage(langId);
      const lang = getLanguageById(langId);
      this.editor.setCode(lang.template);
    });

    // 运行代码
    document.getElementById('run-btn').addEventListener('click', () => this.runCode());

    // 提交代码
    document.getElementById('submit-btn').addEventListener('click', () => this.submitCode());

    document.querySelector('[data-view="submissions"]').addEventListener('click', () => {
      this.loadSubmissions();
    });

    // 每次返回题目列表都重新读取统计，显示最新提交数和通过率。
    const problemsLink = document.querySelector('[data-view="problems"]');
    problemsLink.addEventListener('click', async () => {
      const problemList = document.getElementById('problem-list');
      let refreshStatus = document.getElementById('problem-refresh-status');
      if (!refreshStatus) {
        refreshStatus = document.createElement('p');
        refreshStatus.id = 'problem-refresh-status';
        refreshStatus.className = 'info';
        refreshStatus.textContent = '⏳ 正在刷新题目...';
        problemList.before(refreshStatus);
      }

      try {
        await this.loadProblemList();
      } finally {
        refreshStatus.remove();
      }
    });

    // 修改用户名
    document.getElementById('change-username-btn').addEventListener('click', () => {
      this._promptUsername();
    });

    // 填充示例输入
    document.getElementById('fill-sample-btn').addEventListener('click', () => {
      const sample = document.querySelector('[data-sample-input]')?.textContent || '';
      document.getElementById('custom-input').value = sample;
    });
  }

  _promptUsername() {
    const name = prompt('请输入你的用户名（用于排行榜显示）:', this.username);
    if (name && name.trim()) {
      this.username = name.trim();
      localStorage.setItem('oj_username', this.username);
      document.getElementById('username-display').textContent = this.username;
    }
  }

  async runCode() {
    const code = this.editor.getCode();
    const customInput = document.getElementById('custom-input').value;
    const langId = document.getElementById('language-select').value;
    const outputEl = document.getElementById('output');

    if (!code.trim()) {
      outputEl.innerHTML = '<span class="error">代码不能为空</span>';
      return;
    }

    outputEl.innerHTML = '<span class="info">⏳ 正在执行...</span>';

    try {
      const lang = getLanguageById(langId);
      const result = await this.runner.execute(
        lang.judge0LanguageId,
        code,
        customInput
      );

      if (result.compileError) {
        outputEl.innerHTML = `<span class="error">❌ 编译错误:\n${this._escapeHtml(result.stderr)}</span>`;
      } else if (result.exitCode !== 0) {
        outputEl.innerHTML = `<span class="error">❌ 运行时错误 (退出码: ${result.exitCode})\n${this._escapeHtml(result.stderr)}</span>`;
      } else {
        outputEl.innerHTML = `<span class="success">✅ 执行成功 (${result.time}ms)\n${this._escapeHtml(result.stdout)}</span>`;
      }
    } catch (err) {
      outputEl.innerHTML = `<span class="error">❌ ${this._escapeHtml(err.message)}</span>`;
    }
  }

  async submitCode() {
    if (!this.currentProblem) {
      alert('请先选择一道题目');
      return;
    }

    if (!this.username) {
      this._promptUsername();
      if (!this.username) return;
    }

    const code = this.editor.getCode();
    const langId = document.getElementById('language-select').value;
    const resultEl = document.getElementById('judge-result');

    if (!code.trim()) {
      resultEl.innerHTML = '<span class="error">代码不能为空</span>';
      return;
    }

    resultEl.innerHTML = '<span class="info">⏳ 正在判题...</span>';

    try {
      const result = await this.judge.judge(
        this.currentProblem,
        code,
        langId,
        (current, total, r) => {
          resultEl.innerHTML = `<span class="info">⏳ 判题中... ${current}/${total}</span>`;
        }
      );

      // 显示结果
      this._renderJudgeResult(result);

      // 提交到存储
      try {
        await this.github.submit(this.currentProblem.id, this.username, result, code);
      } catch (storageError) {
        resultEl.insertAdjacentHTML(
          'beforeend',
          `<div class="warning">⚠️ ${this._escapeHtml(storageError.message)}</div>`
        );
      }
    } catch (err) {
      resultEl.innerHTML = `<span class="error">❌ 判题失败: ${this._escapeHtml(err.message)}</span>`;
    }
  }

  _renderJudgeResult(result) {
    const resultEl = document.getElementById('judge-result');
    const detailEl = document.getElementById('judge-detail');

    if (result.passed) {
      resultEl.innerHTML = `<span class="success">✅ Accepted (${result.passedTests}/${result.totalTests}) - ${result.totalTime}ms</span>`;
    } else {
      const hasCompileError = result.results.some(r => r.compileError);
      if (hasCompileError) {
        resultEl.innerHTML = `<span class="error">❌ Compile Error</span>`;
      } else {
        resultEl.innerHTML = `<span class="error">❌ Wrong Answer (${result.passedTests}/${result.totalTests})</span>`;
      }
    }

    // 显示详细结果
    detailEl.innerHTML = result.results.map(r => `
      <div class="test-case ${r.passed ? 'passed' : 'failed'}">
        <div class="tc-header">
          <span>测试点 ${r.index}</span>
          <span>${r.passed ? '✅' : '❌'} ${r.time}ms</span>
        </div>
        ${!r.passed ? `
          <div class="tc-detail">
            <div><strong>输入:</strong><pre>${this._escapeHtml(r.input)}</pre></div>
            <div><strong>期望输出:</strong><pre>${this._escapeHtml(r.expectedOutput)}</pre></div>
            <div><strong>你的输出:</strong><pre>${this._escapeHtml(r.actualOutput)}</pre></div>
            ${r.stderr ? `<div><strong>错误信息:</strong><pre>${this._escapeHtml(r.stderr)}</pre></div>` : ''}
          </div>
        ` : ''}
      </div>
    `).join('');
  }

  async loadSubmissions() {
    const container = document.getElementById('submission-list');

    if (!this.username) {
      container.innerHTML = '<p class="info">请先设置用户名以查看提交记录</p>';
      return;
    }

    container.innerHTML = '<p class="info">⏳ 正在加载提交记录...</p>';

    try {
      const submissions = await this.github.getSubmissions(this.username);
      if (submissions.length === 0) {
        container.innerHTML = '<p class="info">暂无提交记录</p>';
        return;
      }

      container.innerHTML = `
        <table class="ranking">
          <thead>
            <tr>
              <th>时间</th>
              <th>题目</th>
              <th>语言</th>
              <th>结果</th>
              <th>测试点</th>
              <th>耗时</th>
            </tr>
          </thead>
          <tbody>
            ${submissions.map(item => `
              <tr>
                <td>${new Date(item.timestamp).toLocaleString()}</td>
                <td>${this._escapeHtml(item.problemId)}</td>
                <td>${this._escapeHtml(item.language)}</td>
                <td class="${item.passed ? 'success' : 'error'}">${item.passed ? 'Accepted' : 'Wrong Answer'}</td>
                <td>${item.passedTests}/${item.totalTests}</td>
                <td>${item.totalTime}ms</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      `;
    } catch (err) {
      container.innerHTML = `<p class="error">提交记录加载失败: ${this._escapeHtml(err.message)}</p>`;
    }
  }

  _escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}

// 启动应用
document.addEventListener('DOMContentLoaded', () => {
  window.app = new App();
  window.app.init();
});
