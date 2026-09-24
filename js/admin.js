class OJAdmin {
  constructor() {
    const workerUrl = 'https://api.jc-oj.online';
    this.config = {
      workerUrl,
      repo: 'chenmin-114/online_oj',
      problemsUrl: `${workerUrl}/?file=problems`,
      // 数据经 Worker 直读，绕开 GitHub Pages CDN 的 10 分钟缓存
      submissionsUrl: `${workerUrl}/?file=submissions`,
      rankingUrl: `${workerUrl}/?file=ranking-v2`,
    };
    this.problems = [];
    this.submissions = [];
    this.ranking = { overall: [], problems: {} };
    this.filteredSubmissions = [];
    this.problemImages = [];
    this.editingProblem = null;
    this.adminPassword = '';
    this.controlsBound = false;
  }

  async init() {
    this.bindLogin();
    const savedPassword = sessionStorage.getItem('oj_admin_password');
    if (savedPassword) await this.login(savedPassword, true);
  }

  bindLogin() {
    document.getElementById('admin-login-form').addEventListener('submit', event => {
      event.preventDefault();
      this.login(document.getElementById('admin-password').value);
    });
  }

  async login(password, silent = false) {
    const button = document.getElementById('admin-login-button');
    const status = document.getElementById('admin-login-status');
    button.disabled = true;
    button.textContent = '验证中...';
    status.textContent = '';

    try {
      const response = await fetch(this.config.workerUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'admin_login', password }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || `登录失败 (${response.status})`);

      this.adminPassword = password;
      sessionStorage.setItem('oj_admin_password', password);
      document.body.classList.remove('auth-locked');
      document.getElementById('admin-login').hidden = true;
      if (!this.controlsBound) {
        this.bindNavigation();
        this.bindControls();
        this.controlsBound = true;
      }
      await this.loadAll();
    } catch (error) {
      sessionStorage.removeItem('oj_admin_password');
      this.adminPassword = '';
      document.body.classList.add('auth-locked');
      document.getElementById('admin-login').hidden = false;
      status.textContent = silent ? '登录已失效，请重新输入密码' : error.message;
    } finally {
      button.disabled = false;
      button.textContent = '登录';
    }
  }

  adminHeaders(extra = {}) {
    return { ...extra, 'X-Admin-Password': this.adminPassword };
  }

  logout() {
    sessionStorage.removeItem('oj_admin_password');
    location.reload();
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
    document.getElementById('logout-admin').addEventListener('click', () => this.logout());
    document.getElementById('submission-search').addEventListener('input', () => this.renderSubmissions());
    document.getElementById('submission-problem').addEventListener('change', () => this.renderSubmissions());
    document.getElementById('submission-result').addEventListener('change', () => this.renderSubmissions());
    document.getElementById('export-submissions').addEventListener('click', () => this.exportSubmissions());
    document.getElementById('admin-ranking-scope').addEventListener('change', event => {
      this.renderLeaderboard(event.target.value);
    });
    document.getElementById('show-problem-editor').addEventListener('click', () => this.startNewProblem());
    document.getElementById('close-problem-editor').addEventListener('click', () => this.hideProblemEditor());
    document.getElementById('reset-problem-editor').addEventListener('click', () => {
      if (this.editingProblem) this.editProblem(this.editingProblem.file);
      else this.resetProblemEditor();
    });
    document.getElementById('add-sample').addEventListener('click', () => this.addSample());
    document.getElementById('add-test-case').addEventListener('click', () => this.addTestCase());
    document.getElementById('import-problem-markdown').addEventListener('click', () => this.importProblemMarkdown());
    document.getElementById('problem-images').addEventListener('change', event => {
      this.addProblemImages(event.target.files);
      event.target.value = '';
    });
    document.getElementById('problem-editor').addEventListener('submit', event => this.saveProblem(event));
    document.getElementById('problem-admin-list').addEventListener('click', event => {
      const button = event.target.closest('[data-edit-problem]');
      if (button) this.editProblem(button.dataset.editProblem);
    });
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
    const response = await fetch(`${url}${separator}t=${Date.now()}`, {
      cache: 'no-store',
      headers: this.adminHeaders(),
    });
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    return response.json();
  }

  async fetchRanking() {
    return this.fetchJson(this.config.rankingUrl);
  }

  async fetchWorkerHealth() {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 6000);
    const response = await fetch(this.config.workerUrl, {
      method: 'POST',
      headers: this.adminHeaders({ 'Content-Type': 'application/json' }),
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
        <div class="activity-row-header"><span>${this.escape(problem.id)} · ${this.escape(problem.title)}</span><span>${this.escape(problem.actualCount)} 次</span></div>
        <div class="activity-track"><div class="activity-bar" style="width:${Math.max(0, Math.min(100, Number(problem.actualCount) / max * 100))}%"></div></div>
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
        <td><span class="difficulty-pill ${this.escape(problem.difficulty)}">${this.escape(this.difficultyText(problem.difficulty))}</span></td>
        <td>${this.escape(counts[problem.id] || 0)}</td>
        <td>${this.escape(accepted[problem.id] || 0)}</td>
        <td><button type="button" class="table-link table-link-button" data-edit-problem="${this.escape(problem.file)}">可视化编辑</button></td>
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
    document.getElementById('sample-editor').innerHTML = '';
    document.getElementById('test-case-editor').innerHTML = '';
    document.getElementById('problem-save-status').textContent = '';
    document.getElementById('problem-import-status').textContent = '可粘贴完整题面或单独的某个部分；只更新本次识别到的内容，样例和测试点会追加';
    this.clearProblemImages();
    this.addSample();
    this.addTestCase();
  }

  startNewProblem() {
    this.editingProblem = null;
    this.resetProblemEditor();
    this.setProblemEditorMode(false);
    this.showProblemEditor();
  }

  setProblemEditorMode(isEditing) {
    document.getElementById('problem-editor-title').textContent = isEditing ? '编辑题目' : '新增题目';
    document.getElementById('problem-editor-subtitle').textContent = isEditing
      ? '保存时会同时更新题目详情和题目列表'
      : '填写后会自动创建题目文件并加入题目列表';
    document.getElementById('problem-id').readOnly = isEditing;
    document.getElementById('problem-file').readOnly = isEditing;
    document.getElementById('reset-problem-editor').textContent = isEditing ? '恢复原内容' : '清空';
    document.getElementById('save-problem').textContent = isEditing ? '保存修改' : '保存并发布题目';
  }

  async editProblem(file) {
    try {
      this.toast('正在读取题目内容...');
      const problem = await this.fetchJson(`${this.config.workerUrl}/?file=problem&name=${encodeURIComponent(file)}`);
      this.resetProblemEditor();
      this.editingProblem = { file, id: problem.id };
      this.setProblemEditorMode(true);

      document.getElementById('problem-id').value = problem.id || '';
      document.getElementById('problem-title').value = problem.title || '';
      document.getElementById('problem-difficulty').value = problem.difficulty || 'easy';
      document.getElementById('problem-file').value = file;
      document.getElementById('problem-description').value = problem.description || '';
      document.getElementById('problem-input-format').value = problem.inputFormat || '';
      document.getElementById('problem-output-format').value = problem.outputFormat || '';
      document.getElementById('problem-constraints').value = problem.constraints || '';
      document.getElementById('problem-sample-explanation').value = problem.sampleExplanation || '';
      document.getElementById('problem-show-test-details').checked = problem.showTestDetails === true;
      document.getElementById('problem-hints').value = Array.isArray(problem.hints) ? problem.hints.join('\n') : '';

      const sampleEditor = document.getElementById('sample-editor');
      sampleEditor.innerHTML = '';
      const samples = Array.isArray(problem.samples) && problem.samples.length
        ? problem.samples
        : [{ input: problem.sampleInput || '', output: problem.sampleOutput || '' }];
      samples.forEach(sample => this.addSample(sample.input, sample.output));

      const testCaseEditor = document.getElementById('test-case-editor');
      testCaseEditor.innerHTML = '';
      const testCases = Array.isArray(problem.testCases) && problem.testCases.length
        ? problem.testCases
        : [{ input: '', expectedOutput: '' }];
      testCases.forEach(testCase => this.addTestCase(testCase.input, testCase.expectedOutput));
      this.showProblemEditor();
    } catch (error) {
      this.toast(`读取题目失败：${error.message}`);
    }
  }

  importProblemMarkdown() {
    const source = this.normalizeImportedMarkdown(document.getElementById('problem-import-markdown').value)
      .replace(/^\uFEFF/, '')
      .replace(/\r\n?/g, '\n')
      .trim();
    const status = document.getElementById('problem-import-status');
    if (!source) {
      status.textContent = '请先粘贴完整题面';
      return;
    }

    const titleInfo = this.parseMarkdownTitle(source);
    const rawTitle = titleInfo.raw;
    const idMatch = rawTitle.match(/\bP\d{3,6}\b/i);
    const id = idMatch?.[0]?.toUpperCase() || '';
    const title = titleInfo.title
      .replace(/\bP\d{3,6}\b/i, '')
      .replace(/^\s*[:：-]\s*/, '')
      .trim();
    const sections = this.parseMarkdownSections(source);
    const hasSection = aliases => aliases.some(alias => sections.some(item => {
      const title = this.normalizeSectionTitle(item.title);
      const normalized = this.normalizeSectionTitle(alias);
      return title === normalized || title.startsWith(normalized);
    }));
    const description = this.findMarkdownSection(sections, ['题目描述', '问题描述', '题意']);
    const inputFormat = this.findMarkdownSection(sections, ['输入格式', '输入']);
    const outputFormat = this.findMarkdownSection(sections, ['输出格式', '输出']);
    const constraints = this.findMarkdownSection(sections, ['数据范围', '限制', '约束']);
    const hints = this.findMarkdownSection(sections, ['说明/提示', '说明提示', '解题提示', '提示', '说明']);
    const samples = this.parseMarkdownSamples(source);
    const sampleExplanation = this.parseMarkdownSampleExplanation(source);
    const testCases = this.parseMarkdownTestCases(source);
    const hasDescription = hasSection(['题目描述', '问题描述', '题意']);
    const hasInputFormat = hasSection(['输入格式', '输入']);
    const hasOutputFormat = hasSection(['输出格式', '输出']);
    const hasConstraints = hasSection(['数据范围', '限制', '约束']);
    const hasHints = hasSection(['说明/提示', '说明提示', '解题提示', '提示', '说明']);
    const hasSampleExplanation = Boolean(sampleExplanation);

    if (!id && !title && !hasDescription && !hasInputFormat && !hasOutputFormat && !hasConstraints && !hasHints && !hasSampleExplanation && !samples.length && !testCases.length) {
      status.textContent = '没有识别到可更新的题目内容，请检查 Markdown 格式';
      return;
    }

    if (id) {
      document.getElementById('problem-id').value = id;
      document.getElementById('problem-file').value = `${id.toLowerCase()}.json`;
    }
    if (title) document.getElementById('problem-title').value = title;
    if (hasDescription) document.getElementById('problem-description').value = description;
    if (hasInputFormat) document.getElementById('problem-input-format').value = inputFormat;
    if (hasOutputFormat) document.getElementById('problem-output-format').value = outputFormat;
    if (hasConstraints) document.getElementById('problem-constraints').value = constraints;
    if (hasHints) document.getElementById('problem-hints').value = hints;
    if (hasSampleExplanation) document.getElementById('problem-sample-explanation').value = sampleExplanation;

    if (samples.length) {
      this.appendSamples(samples);
    }
    if (testCases.length) {
      this.appendTestCases(testCases);
    }

    const recognized = [id && '题号', title && '标题', hasDescription && '描述', hasInputFormat && '输入格式', hasOutputFormat && '输出格式', hasConstraints && '数据范围', hasHints && '提示', samples.length && `追加 ${samples.length} 组样例`, hasSampleExplanation && '样例解释', testCases.length && `追加 ${testCases.length} 个测试点`]
      .filter(Boolean);
    status.textContent = `本次仅更新：${recognized.join('、')}；其他内容保持不变`;
    document.querySelector('.problem-importer').open = false;
    this.toast('题面已自动填入，请检查内容并补充隐藏测试点');
  }

  normalizeImportedMarkdown(value) {
    return String(value || '')
      // 兼容从富文本、聊天软件或网页复制后残留的换行和空格实体。
      .replace(/&#x0*d;|&#0*13;|&cr;/gi, '')
      .replace(/&#x0*a;|&#0*10;|&newline;/gi, '\n')
      .replace(/&#x0*20;|&#0*32;|&nbsp;/gi, ' ')
      // 只解除 Markdown 标点转义，保留 \le、\dots 等 LaTeX 命令。
      .replace(/\\([#*_`~.>\-])/g, '$1');
  }

  parseMarkdownSections(source) {
    const lines = source.split('\n');
    const markers = [];
    let offset = 0;
    lines.forEach(line => {
      const trimmed = line.trim();
      const headingMatch = trimmed.match(/^#{1,6}\s+(.+?)\s*#*$/);
      const standalone = trimmed.match(/^(?:\*\*|__)(.+?)(?:\*\*|__)$/);
      const plain = trimmed.match(/^(题目描述|问题描述|题意|输入格式?|输出格式?|样例输入|样例输出|说明(?:\/提示)?|解题提示|提示|数据范围|限制|约束)\s*[：:]?$/i);
      const candidate = headingMatch?.[1] || standalone?.[1] || plain?.[1];
      if (candidate && this.isProblemSectionTitle(candidate)) {
        markers.push({
          title: this.cleanMarkdownHeading(candidate),
          start: offset + line.length + 1,
          lineStart: offset,
        });
      }
      offset += line.length + 1;
    });
    return markers.map((marker, index) => ({
      title: marker.title,
      content: source.slice(marker.start, markers[index + 1]?.lineStart ?? source.length).trim(),
    }));
  }

  findMarkdownSection(sections, aliases) {
    const normalizedAliases = aliases.map(alias => this.normalizeSectionTitle(alias));
    const section = sections.find(item => {
      const title = this.normalizeSectionTitle(item.title);
      return normalizedAliases.some(alias => title === alias || title.startsWith(alias));
    });
    return section?.content || '';
  }

  parseMarkdownTitle(source) {
    const firstLine = source.split('\n').map(line => line.trim()).find(line => line) || '';
    const firstHeading = source.match(/^#{1,6}\s+(.+?)\s*#*$/m)?.[1]?.trim();
    const hasTitleLine = !this.isProblemSectionTitle(firstLine)
      && (/题目|问题/.test(firstLine) || /^P\d{3,6}\b/i.test(firstLine));
    const headingIsSection = firstHeading && this.isProblemSectionTitle(firstHeading);
    const raw = hasTitleLine ? firstLine : (headingIsSection ? '' : (firstHeading || ''));
    const cleaned = this.cleanMarkdownHeading(raw)
      .replace(/^【\s*题目\s*[:：]?\s*/, '')
      .replace(/】\s*$/, '')
      .trim();
    return { raw: cleaned, title: cleaned };
  }

  appendSamples(samples) {
    const container = document.getElementById('sample-editor');
    const rows = Array.from(container.querySelectorAll('.sample-case-row'));
    let index = 0;
    if (rows.length === 1
      && !rows[0].querySelector('.sample-input').value.trim()
      && !rows[0].querySelector('.sample-output').value.trim()) {
      rows[0].querySelector('.sample-input').value = samples[0].input || '';
      rows[0].querySelector('.sample-output').value = samples[0].output || '';
      index = 1;
    }
    samples.slice(index).forEach(sample => this.addSample(sample.input, sample.output));
  }

  appendTestCases(testCases) {
    const container = document.getElementById('test-case-editor');
    const rows = Array.from(container.querySelectorAll('.test-case-row'));
    let index = 0;
    if (rows.length === 1
      && !rows[0].querySelector('.test-input').value.trim()
      && !rows[0].querySelector('.test-output').value.trim()) {
      rows[0].querySelector('.test-input').value = testCases[0].input || '';
      rows[0].querySelector('.test-output').value = testCases[0].output || testCases[0].expectedOutput || '';
      index = 1;
    }
    testCases.slice(index).forEach(testCase => this.addTestCase(testCase.input, testCase.output || testCase.expectedOutput));
  }

  cleanMarkdownHeading(value) {
    return String(value || '')
      .replace(/^\s*(?:\*\*|__|`)+/, '')
      .replace(/(?:\*\*|__|`)+\s*$/, '')
      .replace(/^\s*(?:#{1,6}\s*)+/, '')
      .trim();
  }

  normalizeSectionTitle(value) {
    return this.cleanMarkdownHeading(value)
      .replace(/[【】「」()[\]{}]/g, '')
      .replace(/[\s　:：、。.!！?？/_-]/g, '')
      .toLowerCase();
  }

  isProblemSectionTitle(value) {
    const title = this.normalizeSectionTitle(value);
    return ['题目描述', '问题描述', '题意', '输入', '输入格式', '输出', '输出格式', '样例', '示例', '输入输出样例', '样例输入', '样例输出', '样例解释', '示例解释', '说明', '说明提示', '解题提示', '提示', '数据范围', '限制', '约束', '测试点']
      .some(alias => title === alias || title.startsWith(alias));
  }

  parseMarkdownSamples(source) {
    const blocks = new Map();
    const counters = { input: 0, output: 0 };
    const pattern = /^(?:#{1,6}\s*)?(?:\*\*|__)?\s*(?:样例|示例)?\s*(输入|输出)(?:样例|示例)?\s*#?\s*(\d+)?\s*(?:\*\*|__)?\s*\n\s*```[^\n]*\n([\s\S]*?)\n```/gm;
    let match;
    while ((match = pattern.exec(source)) !== null) {
      const type = match[1] === '输入' ? 'input' : 'output';
      counters[type] += 1;
      const number = match[2] || String(counters[type]);
      if (!blocks.has(number)) blocks.set(number, { input: '', output: '' });
      blocks.get(number)[type] = match[3].replace(/\n$/, '');
    }
    return Array.from(blocks.values()).filter(sample => sample.input || sample.output);
  }

  parseMarkdownSampleExplanation(source) {
    const lines = source.split('\n');
    const heading = /^\s*#{1,6}\s*(?:\*\*|__)?\s*(?:样例|示例)(?:解释|说明)\s*#?\s*(\d+)?\s*(?:\*\*|__)?\s*$/i;
    const anyHeading = /^\s*#{1,6}\s+/;
    const explanations = [];
    let current = null;

    lines.forEach(line => {
      const match = line.match(heading);
      if (match) {
        current = { number: match[1] || String(explanations.length + 1), lines: [] };
        explanations.push(current);
        return;
      }
      if (current && anyHeading.test(line)) {
        current = null;
        return;
      }
      if (current) current.lines.push(line);
    });

    const populated = explanations
      .map(item => ({ ...item, content: item.lines.join('\n').trim() }))
      .filter(item => item.content);
    if (populated.length) return this.formatSampleExplanations(populated);

    // 兼容紧跟在样例输出后的 “> 解释：...” 引用写法。
    const quoted = [];
    let currentQuote = null;
    const quoteStart = /^\s*>\s*(?:\*\*|__)?\s*(?:样例\s*#?\s*(\d+)\s*)?解释\s*(?:\*\*|__)?\s*[：:]\s*(.*)$/i;
    const quoteContinuation = /^\s*>\s?(.*)$/;
    lines.forEach(line => {
      const start = line.match(quoteStart);
      if (start) {
        currentQuote = {
          number: start[1] || String(quoted.length + 1),
          lines: [start[2]],
        };
        quoted.push(currentQuote);
        return;
      }
      const continuation = currentQuote && line.match(quoteContinuation);
      if (continuation) {
        currentQuote.lines.push(continuation[1]);
      } else {
        currentQuote = null;
      }
    });
    return this.formatSampleExplanations(quoted
      .map(item => ({ ...item, content: item.lines.join('\n').trim() }))
      .filter(item => item.content));
  }

  formatSampleExplanations(explanations) {
    if (explanations.length <= 1) return explanations[0]?.content || '';
    return explanations
      .map(item => `**样例 #${item.number}**\n\n${item.content}`)
      .join('\n\n');
  }

  parseMarkdownTestCases(source) {
    const blocks = new Map();
    const normalized = this.normalizeImportedMarkdown(source);
    const testSectionHeading = /^\s*#{1,6}\s*(?:\*\*|__)?\s*测试点\s*(?:\*\*|__)?\s*#*\s*$/mi.exec(normalized);
    const scopedSource = testSectionHeading
      ? normalized.slice(testSectionHeading.index + testSectionHeading[0].length)
      : normalized;
    const lines = scopedSource.split('\n');
    const marker = /^\s*(?:#{1,6}\s*)?(?:\*\*|__)?\s*(?:测试点\s*)?(输入|输出)\s*#?\s*(\d+)\s*(?:\*\*|__)?\s*$/i;
    let current = null;
    lines.forEach(line => {
      if (/^\s*```/.test(line)) return;
      const match = line.match(marker);
      if (match) {
        const number = match[2];
        const type = match[1].toLowerCase() === '输出' ? 'output' : 'input';
        if (!blocks.has(number)) blocks.set(number, { input: '', output: '' });
        current = { number, type };
        return;
      }
      if (current) blocks.get(current.number)[current.type] += `${line}\n`;
    });
    blocks.forEach(testCase => {
      testCase.input = testCase.input.replace(/\n$/, '');
      testCase.output = testCase.output.replace(/\n$/, '');
    });
    if (!blocks.size) {
      const fenced = /^(?:#{3,6}\s*)?(?:\*\*|__)?\s*测试点\s*#?\s*(\d+)?\s*(输入|输出)?\s*(?:\*\*|__)?\s*\n\s*```[^\n]*\n([\s\S]*?)\n```/gmi;
      let match;
      while ((match = fenced.exec(scopedSource)) !== null) {
        const number = match[1] || String(blocks.size + 1);
        const type = (match[2] || '输入') === '输出' ? 'output' : 'input';
        if (!blocks.has(number)) blocks.set(number, { input: '', output: '' });
        blocks.get(number)[type] = match[3].replace(/\n$/, '');
      }
    }
    return Array.from(blocks.values()).filter(testCase => testCase.input || testCase.output);
  }

  addProblemImages(fileList) {
    const allowedTypes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
    const files = Array.from(fileList || []);
    const accepted = [];

    for (const file of files) {
      if (!allowedTypes.has(file.type)) {
        this.toast(`${file.name} 不是支持的图片格式`);
        continue;
      }
      if (file.size > 3 * 1024 * 1024) {
        this.toast(`${file.name} 超过 3 MB，无法上传`);
        continue;
      }
      if (this.problemImages.length + accepted.length >= 5) {
        this.toast('每道题最多上传 5 张图片');
        break;
      }
      const id = window.crypto?.randomUUID?.()
        || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      accepted.push({
        id,
        file,
        previewUrl: URL.createObjectURL(file),
      });
    }

    const totalSize = [...this.problemImages, ...accepted]
      .reduce((sum, item) => sum + item.file.size, 0);
    if (totalSize > 10 * 1024 * 1024) {
      accepted.forEach(item => URL.revokeObjectURL(item.previewUrl));
      this.toast('题目图片总大小不能超过 10 MB');
      return;
    }

    this.problemImages.push(...accepted);
    this.insertProblemImageMarkdown(accepted);
    this.renderProblemImages();
  }

  insertProblemImageMarkdown(images) {
    if (!images.length) return;
    const textarea = document.getElementById('problem-description');
    const start = textarea.selectionStart ?? textarea.value.length;
    const end = textarea.selectionEnd ?? start;
    const before = textarea.value.slice(0, start);
    const after = textarea.value.slice(end);
    const markdown = images.map(item => {
      const alt = item.file.name
        .replace(/\.[^.]+$/, '')
        .replace(/[\[\]\\]/g, '')
        .trim() || '题目图片';
      return `![${alt}](oj-image:${item.id})`;
    }).join('\n\n');
    const prefix = before && !before.endsWith('\n') ? '\n\n' : '';
    const suffix = after && !after.startsWith('\n') ? '\n\n' : '';
    const inserted = `${prefix}${markdown}${suffix}`;

    textarea.value = `${before}${inserted}${after}`;
    const cursor = before.length + inserted.length;
    textarea.focus();
    textarea.setSelectionRange(cursor, cursor);
  }

  renderProblemImages() {
    const container = document.getElementById('problem-image-preview');
    container.hidden = this.problemImages.length === 0;
    container.innerHTML = this.problemImages.map(item => `
      <div class="problem-image-item" data-image-id="${item.id}">
        <img src="${item.previewUrl}" alt="">
        <div><strong>${this.escape(item.file.name)}</strong><span>${this.formatFileSize(item.file.size)}</span></div>
        <button type="button" title="移除图片">×</button>
      </div>
    `).join('');
    container.querySelectorAll('.problem-image-item button').forEach(button => {
      button.addEventListener('click', () => this.removeProblemImage(button.closest('.problem-image-item').dataset.imageId));
    });
  }

  removeProblemImage(id) {
    const index = this.problemImages.findIndex(item => item.id === id);
    if (index === -1) return;
    const description = document.getElementById('problem-description');
    const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    description.value = description.value
      .replace(new RegExp(`!\\[[^\\]\\r\\n]*\\]\\(oj-image:${escapedId}\\)`, 'g'), '')
      .replace(/\n{3,}/g, '\n\n');
    URL.revokeObjectURL(this.problemImages[index].previewUrl);
    this.problemImages.splice(index, 1);
    this.renderProblemImages();
  }

  clearProblemImages() {
    this.problemImages.forEach(item => URL.revokeObjectURL(item.previewUrl));
    this.problemImages = [];
    this.renderProblemImages();
  }

  formatFileSize(size) {
    return size < 1024 * 1024
      ? `${Math.max(1, Math.round(size / 1024))} KB`
      : `${(size / 1024 / 1024).toFixed(1)} MB`;
  }

  readImageAsBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
      reader.onerror = () => reject(new Error(`读取图片 ${file.name} 失败`));
      reader.readAsDataURL(file);
    });
  }

  addSample(input = '', output = '') {
    const container = document.getElementById('sample-editor');
    const number = container.children.length + 1;
    const row = document.createElement('div');
    row.className = 'sample-case-row';
    row.innerHTML = `
      <label class="form-field"><span>输入 #${number}</span><textarea class="admin-input sample-input" rows="3"></textarea></label>
      <label class="form-field"><span>输出 #${number}</span><textarea class="admin-input sample-output" rows="3"></textarea></label>
      <button type="button" class="remove-test-case" title="删除样例">×</button>
    `;
    row.querySelector('.sample-input').value = input;
    row.querySelector('.sample-output').value = output;
    row.querySelector('.remove-test-case').addEventListener('click', () => {
      if (container.children.length === 1) {
        row.querySelector('.sample-input').value = '';
        row.querySelector('.sample-output').value = '';
        return;
      }
      row.remove();
      this.renumberSamples();
    });
    container.appendChild(row);
  }

  renumberSamples() {
    document.querySelectorAll('.sample-case-row').forEach((row, index) => {
      row.querySelector('.sample-input').closest('.form-field').querySelector('span').textContent = `输入 #${index + 1}`;
      row.querySelector('.sample-output').closest('.form-field').querySelector('span').textContent = `输出 #${index + 1}`;
    });
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
    const samples = Array.from(document.querySelectorAll('.sample-case-row')).map(row => ({
      input: row.querySelector('.sample-input').value,
      output: row.querySelector('.sample-output').value,
    })).filter(sample => sample.input || sample.output);
    const problem = {
      id: document.getElementById('problem-id').value,
      title: document.getElementById('problem-title').value,
      difficulty: document.getElementById('problem-difficulty').value,
      description: document.getElementById('problem-description').value,
      inputFormat: document.getElementById('problem-input-format').value,
      outputFormat: document.getElementById('problem-output-format').value,
      constraints: document.getElementById('problem-constraints').value,
      sampleExplanation: document.getElementById('problem-sample-explanation').value,
      sampleInput: samples[0]?.input || '',
      sampleOutput: samples[0]?.output || '',
      samples,
      testCases,
      showTestDetails: document.getElementById('problem-show-test-details').checked,
      hints: document.getElementById('problem-hints').value.split('\n').map(item => item.trim()).filter(Boolean),
    };

    const saveButton = document.getElementById('save-problem');
    const status = document.getElementById('problem-save-status');
    const isEditing = Boolean(this.editingProblem);
    saveButton.disabled = true;
    saveButton.textContent = isEditing ? '正在保存...' : '正在发布...';
    status.textContent = this.problemImages.length ? '正在处理题目图片' : '正在写入 GitHub 仓库';

    try {
      const images = await Promise.all(this.problemImages.map(async item => ({
        id: item.id,
        name: item.file.name,
        type: item.file.type,
        content: await this.readImageAsBase64(item.file),
      })));
      if (images.length) status.textContent = '正在上传图片并发布题目';
      const response = await fetch(this.config.workerUrl, {
        method: 'POST',
        headers: this.adminHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          type: isEditing ? 'update_problem' : 'create_problem',
          file: document.getElementById('problem-file').value,
          problem,
          images,
        }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || `发布失败 (${response.status})`);

      if (isEditing) {
        const index = this.problems.findIndex(item => item.id === result.problem.id);
        if (index !== -1) this.problems[index] = result.problem;
      } else {
        this.problems.push(result.problem);
      }
      this.problems.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
      this.renderMetrics();
      this.renderProblems();
      this.populateFilters();
      this.populateRankingSelector();
      this.toast(isEditing
        ? `${result.problem.id} 已更新，题目列表也已同步`
        : `${result.problem.id} 已发布，前台将在 GitHub Pages 更新后显示`);
      this.editingProblem = null;
      this.setProblemEditorMode(false);
      this.resetProblemEditor();
      this.hideProblemEditor();
    } catch (error) {
      status.textContent = error instanceof TypeError
        ? '无法连接 Worker，请检查网络后重试'
        : error.message;
    } finally {
      saveButton.disabled = false;
      saveButton.textContent = this.editingProblem ? '保存修改' : '保存并发布题目';
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
        <td>${this.escape(item.passedTests)}/${this.escape(item.totalTests)}</td>
        <td>${this.escape(item.totalTime)}ms</td>
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
        items.length ? items.map((item, index) => `<tr><td>#${index + 1}</td><td>${this.escape(item.username)}</td><td>${this.escape(item.solvedCount)}</td><td>${this.escape(item.totalTime)}ms</td><td>${this.formatDate(item.lastSubmit)}</td></tr>`).join('')
          : '<tr><td colspan="5" class="empty-cell">暂无总榜数据</td></tr>'
      }</tbody></table>`;
      return;
    }

    const items = this.ranking.problems?.[scope] || [];
    container.innerHTML = `<table class="admin-table"><thead><tr><th>排名</th><th>用户</th><th>判题耗时</th><th>通过前尝试</th><th>通过时间</th></tr></thead><tbody>${
      items.length ? items.map((item, index) => `<tr><td>#${index + 1}</td><td>${this.escape(item.username)}</td><td>${this.escape(item.totalTime)}ms</td><td>${this.escape(item.attempts)}</td><td>${this.formatDate(item.acceptedAt)}</td></tr>`).join('')
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
    return ({ easy: '简单', medium: '中等', hard: '困难' })[value] || '未知';
  }

  formatDate(timestamp) {
    return Number.isFinite(Number(timestamp)) ? new Date(Number(timestamp)).toLocaleString() : '—';
  }

  csvCell(value) {
    const text = String(value ?? '');
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  escape(value) {
    const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return String(value ?? '').replace(/[&<>"']/g, character => entities[character]);
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
