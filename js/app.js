/**
 * 主控制器
 * 协调各模块，处理用户交互
 */
class App {
  constructor() {
    this.runner = new CodeRunner();
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

    // 编辑器来自海外 CDN，不能阻塞题目列表和导航的首次显示。
    // 即使 Monaco 暂时加载较慢，学生仍应当能立即浏览题目。
    this.editor = new EditorManager('editor-container');
    const editorInitialization = this.editor.init().catch(err => {
      console.error('代码编辑器加载失败:', err);
      const container = document.getElementById('editor-container');
      if (container && !this.editor.editor) {
        container.innerHTML = '<p class="error">代码编辑器加载失败，请刷新页面重试</p>';
      }
    });

    // 绑定事件
    this._bindEvents();

    // 检查用户名
    if (!this.username) {
      this._promptUsername();
    } else {
      document.getElementById('username-display').textContent = this.username;
    }

    // 题目列表与编辑器并行加载；这里只等待首屏真正需要的题目数据。
    await this.loadProblemList();

    // 保留 Promise 引用，避免编辑器初始化失败产生未处理的异步错误。
    this.editorInitialization = editorInitialization;
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
    container.innerHTML = problems.map(p => {
      const difficulty = ['easy', 'medium', 'hard'].includes(p.difficulty) ? p.difficulty : 'easy';
      return `
      <div class="problem-card" data-id="${this._escapeHtml(p.id)}" data-file="${this._escapeHtml(p.file)}">
        <div class="problem-header">
          <span class="problem-id">${this._escapeHtml(p.id)}</span>
          <span class="problem-title">${this._escapeHtml(p.title)}</span>
          <span class="difficulty ${difficulty}">${this._difficultyText(difficulty)}</span>
        </div>
      </div>
    `;
    }).join('');

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
    return map[diff] || '未知';
  }

  async loadProblem(file) {
    try {
      const workerUrl = window.OJ_CONFIG.WORKER_URL;
      const problemUrl = workerUrl
        ? `${workerUrl}/?file=problem&name=${encodeURIComponent(file)}&t=${Date.now()}`
        : `problems/${file}?t=${Date.now()}`;
      const response = await fetch(problemUrl, { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
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
      ['problem-sample-explanation', p.sampleExplanation],
    ];
    markdownFields.forEach(([id, value]) => {
      const container = document.getElementById(id);
      const title = document.getElementById(`${id}-title`);
      const hasContent = Boolean(String(value || '').trim());
      container.hidden = !hasContent;
      if (title) title.hidden = !hasContent;
      container.innerHTML = hasContent ? this._formatMarkdown(value) : '';
      if (hasContent) this._enhanceMarkdown(container);
    });

    const hintsTitle = document.getElementById('problem-hints-title');
    const hintsContainer = document.getElementById('problem-hints');
    const hints = Array.isArray(p.hints)
      // 管理端按行保存提示；表格每一行必须用单换行连接，不能插入空行。
      ? p.hints.filter(item => String(item || '').trim()).join('\n')
      : String(p.hints || '').trim();
    if (hints) {
      hintsContainer.innerHTML = this._formatMarkdown(hints);
      this._enhanceMarkdown(hintsContainer);
      hintsTitle.hidden = false;
    } else {
      hintsContainer.innerHTML = '';
      hintsTitle.hidden = true;
    }
    
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
        FORBID_TAGS: ['style', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'textarea', 'select', 'option'],
        FORBID_ATTR: ['style'],
        ALLOW_DATA_ATTR: false,
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
    const title = document.getElementById('problem-samples-title');
    container.hidden = !samples.length;
    if (title) title.hidden = !samples.length;
    container.innerHTML = samples.length ? samples.map((sample, index) => `
      <div class="sample-group">
        <div class="sample">
          <div><strong>输入 #${index + 1}</strong><pre data-sample-input>${this._escapeHtml(sample.input || '')}</pre></div>
          <div><strong>输出 #${index + 1}</strong><pre>${this._escapeHtml(sample.output || '')}</pre></div>
        </div>
      </div>
    `).join('') : '';
    if (samples.length) this._enhanceMarkdown(container);
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

    // 每次返回题目列表都重新读取题目，及时显示管理员发布的更新。
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
        outputEl.innerHTML = `<span class="error">❌ 运行时错误 (退出码: ${this._escapeHtml(result.exitCode)})\n${this._escapeHtml(result.stderr)}</span>`;
      } else {
        outputEl.innerHTML = `<span class="success">✅ 执行成功 (${this._escapeHtml(result.time)}ms)\n${this._escapeHtml(result.stdout)}</span>`;
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

    resultEl.innerHTML = '<span class="info">⏳ 正在进行服务端判题，请稍候...</span>';

    try {
      const result = await this.github.submit(
        this.currentProblem.id,
        this.username,
        langId,
        code,
        event => this._renderJudgeProgress(event)
      );
      this._renderJudgeResult(result);
    } catch (err) {
      resultEl.innerHTML = `<span class="error">❌ 判题失败: ${this._escapeHtml(err.message)}</span>`;
    }
  }

  _renderJudgeProgress(event) {
    const resultEl = document.getElementById('judge-result');
    if (event.type === 'start') {
      resultEl.innerHTML = `<span class="info">⏳ 准备判题，共 ${this._escapeHtml(event.totalTests)} 个测试点...</span>`;
    } else if (event.type === 'progress') {
      const icon = event.passed ? '✅' : '❌';
      resultEl.innerHTML = `<span class="info">${icon} 判题进度 ${this._escapeHtml(event.current)}/${this._escapeHtml(event.totalTests)}</span>`;
    } else if (event.type === 'retry') {
      resultEl.innerHTML = `<span class="warning">⏳ 测试点 ${this._escapeHtml(event.current)} 服务繁忙，正在重试 ${this._escapeHtml(event.attempt)}/${this._escapeHtml(event.maxAttempts)}...</span>`;
    } else if (event.type === 'saving') {
      resultEl.innerHTML = '<span class="info">⏳ 判题完成，正在保存结果...</span>';
    }
  }

  _renderJudgeResult(result) {
    const resultEl = document.getElementById('judge-result');
    const detailEl = document.getElementById('judge-detail');

    if (result.passed) {
      resultEl.innerHTML = `<span class="success">✅ Accepted (${this._escapeHtml(result.passedTests)}/${this._escapeHtml(result.totalTests)}) - ${this._escapeHtml(result.totalTime)}ms</span>`;
    } else {
      const hasCompileError = Array.isArray(result.results) && result.results.some(r => r.compileError);
      if (hasCompileError) {
        resultEl.innerHTML = `<span class="error">❌ Compile Error</span>`;
      } else {
        resultEl.innerHTML = `<span class="error">❌ Wrong Answer (${this._escapeHtml(result.passedTests)}/${this._escapeHtml(result.totalTests)})</span>`;
      }
    }

    // 显示详细结果
    const safeResults = Array.isArray(result.results) ? result.results : [];
    detailEl.innerHTML = safeResults.map(r => `
      <div class="test-case ${r.passed ? 'passed' : 'failed'}">
        <div class="tc-header">
          <span>测试点 ${this._escapeHtml(r.index)}</span>
          <span>${r.passed ? '✅' : '❌'} ${this._escapeHtml(r.time)}ms</span>
        </div>
        ${!r.passed ? `
          <div class="tc-detail">
            ${typeof r.input === 'string' ? `<div><strong>测试点输入:</strong><pre>${this._escapeHtml(r.input)}</pre></div>` : ''}
            ${typeof r.actualOutput === 'string' ? `<div><strong>实际输出:</strong><pre>${this._escapeHtml(r.actualOutput)}</pre></div>` : ''}
            <div><strong>判题信息:</strong><pre>${this._escapeHtml(r.message || '未通过该测试点')}</pre></div>
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
                <td>${this._escapeHtml(new Date(Number(item.timestamp)).toLocaleString())}</td>
                <td>${this._escapeHtml(item.problemId)}</td>
                <td>${this._escapeHtml(item.language)}</td>
                <td class="${item.passed ? 'success' : 'error'}">${item.passed ? 'Accepted' : 'Wrong Answer'}</td>
                <td>${this._escapeHtml(item.passedTests)}/${this._escapeHtml(item.totalTests)}</td>
                <td>${this._escapeHtml(item.totalTime)}ms</td>
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
    const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return String(text ?? '').replace(/[&<>"']/g, character => entities[character]);
  }
}

// 启动应用
document.addEventListener('DOMContentLoaded', () => {
  window.app = new App();
  window.app.init();
});
