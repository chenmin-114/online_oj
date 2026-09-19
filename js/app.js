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

    // 加载排名
    await this.loadRanking();

    // 检查用户名
    if (!this.username) {
      this._promptUsername();
    } else {
      document.getElementById('username-display').textContent = this.username;
    }
  }

  async loadProblemList() {
    try {
      const response = await fetch('problems/index.json');
      const problems = await response.json();
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
    document.getElementById('problem-description').innerHTML = this._formatMarkdown(p.description || '');
    document.getElementById('problem-input-format').innerHTML = this._formatMarkdown(p.inputFormat || '');
    document.getElementById('problem-output-format').innerHTML = this._formatMarkdown(p.outputFormat || '');
    document.getElementById('problem-constraints').innerHTML = this._formatMarkdown(p.constraints || '');
    
    document.getElementById('sample-input').textContent = p.sampleInput || '';
    document.getElementById('sample-output').textContent = p.sampleOutput || '';

    // 重置编辑器
    const lang = getLanguageById(window.OJ_CONFIG.DEFAULT_LANGUAGE);
    this.editor.setLanguage(lang.id);
    this.editor.setCode(lang.template);
  }

  _formatMarkdown(text) {
    // 简单的 Markdown 转换（生产环境可用 marked.js）
    return text
      .replace(/\n/g, '<br>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*]+)\*/g, '<em>$1</em>');
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

    // 每次打开排行榜都重新获取，避免继续显示浏览器缓存中的旧数据
    document.querySelector('[data-view="ranking"]').addEventListener('click', () => {
      this.loadRanking();
    });

    // 修改用户名
    document.getElementById('change-username-btn').addEventListener('click', () => {
      this._promptUsername();
    });

    // 填充示例输入
    document.getElementById('fill-sample-btn').addEventListener('click', () => {
      const sample = document.getElementById('sample-input').textContent;
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
      await this.github.submit(this.currentProblem.id, this.username, result, code);
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

  async loadRanking() {
    const container = document.getElementById('ranking-table');
    container.innerHTML = '<p class="info">⏳ 正在加载排名...</p>';

    try {
      const ranking = await this.github.getRanking();
      if (ranking.length === 0) {
        container.innerHTML = '<p class="info">暂无排名数据，等待 GitHub Actions 生成</p>';
        return;
      }

      container.innerHTML = `
        <table class="ranking">
          <thead>
            <tr>
              <th>排名</th>
              <th>用户名</th>
              <th>解题数</th>
              <th>总耗时</th>
              <th>最后提交</th>
            </tr>
          </thead>
          <tbody>
            ${ranking.map((r, i) => `
              <tr>
                <td>${i + 1}</td>
                <td>${this._escapeHtml(r.username)}</td>
                <td>${r.solvedCount}</td>
                <td>${r.totalTime}ms</td>
                <td>${new Date(r.lastSubmit).toLocaleString()}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      `;
    } catch (err) {
      container.innerHTML = `<p class="error">排名加载失败: ${this._escapeHtml(err.message)}</p>`;
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
