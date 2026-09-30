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
    this.problemLoadSequence = 0;
    this.problemRequestSequence = 0;
    const searchParams = new URLSearchParams(location.search);
    const requestedGroup = searchParams.get('group');
    const previewExam = String(searchParams.get('adminPreviewExam') || '').trim().toUpperCase();
    const previewProblem = String(searchParams.get('adminPreviewProblem') || '').trim().toLowerCase();
    this.adminExamPreview = /^[A-Z][A-Z0-9_-]{1,31}$/.test(previewExam) ? previewExam : '';
    this.adminProblemPreview = /^(?:p\d{3,6}|t\d{3})(?:-[a-z0-9-]+)?\.json$/.test(previewProblem) ? previewProblem : '';
    this.group = ['control', 'vision'].includes(requestedGroup) ? requestedGroup : 'control';
    this.username = (this.adminExamPreview || this.adminProblemPreview) ? 'admin' : (localStorage.getItem('oj_username') || '').trim();
    this.editorFontSize = this._loadEditorFontSize();
    this.codeSaveTimer = null;
    this.isRestoringCode = false;
    this.analyticsPending = new Set();
    this.resubmissionNotices = [];
    this.systemMessages = [];
  }

  async init() {
    // 初始化视图
    this.views.init();
    this.examUI = new ExamUI(this);
    this.examUI.init();

    // 编辑器来自海外 CDN，不能阻塞题目列表和导航的首次显示。
    // 即使 Monaco 暂时加载较慢，学生仍应当能立即浏览题目。
    this.editor = new EditorManager('editor-container');
    this.editor.setFontSize(this.editorFontSize);
    this.editor.onChange(code => {
      if (this.examUI?.programmingContext) this.examUI.captureProgrammingCode(code);
      else this._scheduleCodeSave(code);
    });
    const editorInitialization = this.editor.init().catch(err => {
      console.error('代码编辑器加载失败:', err);
      const container = document.getElementById('editor-container');
      if (container && !this.editor.editor) {
        container.innerHTML = '<p class="error">代码编辑器加载失败，请刷新页面重试</p>';
      }
    });

    // 绑定事件
    this._bindEvents();
    this._updateFontSizeDisplay();
    this._initSolveResizer();
    this._renderGroupSwitcher();

    // 管理员套卷预览也初始化同一套编辑器，这样可以打开完整编程题并返回试卷。
    if (this.adminExamPreview || this.adminProblemPreview) {
      document.body.classList.remove('username-gate-pending');
      document.getElementById('username-display').textContent = 'admin';
      document.querySelector('.user-account').hidden = true;
      document.querySelectorAll('.group-switch').forEach(button => { button.disabled = true; });
      this.editorInitialization = editorInitialization;
      if (this.adminExamPreview) {
        await this.examUI.openExam(this.adminExamPreview);
      } else {
        await this.loadProblem(this.adminProblemPreview);
        const context = document.getElementById('exam-problem-context');
        context.hidden = false;
        context.querySelector('strong').textContent = '管理员正在预览普通题目';
        document.getElementById('exam-problem-context-label').textContent = '页面与学生端一致；运行和判题不会写入学生提交记录';
        const back = document.getElementById('back-to-exam-from-problem');
        back.textContent = '关闭预览';
        back.onclick = () => window.close();
      }
      return;
    }
    // 登录弹窗显示期间也加载背景题目列表，但遮罩会阻止任何操作。
    const problemListLoading = this.loadProblemList();

    // 检查用户名；没有用户名时必须完成登录，页面保持可见但不可操作。
    document.body.classList.remove('username-gate-pending');
    if (!this.username) {
      await this._promptUsername();
    } else {
      const sessionValid = await this._restoreStudentSession();
      if (sessionValid) {
        document.getElementById('username-display').textContent = this.username;
      } else {
        await this._promptUsername({ autoCheck: true });
      }
    }
    this._trackView();

    // 题目列表与编辑器并行加载；这里只等待首屏真正需要的题目数据。
    await problemListLoading;
    await this._loadResubmissionNotices(true);
    await this._loadSystemMessages(false, true);

    // 保留 Promise 引用，避免编辑器初始化失败产生未处理的异步错误。
    this.editorInitialization = editorInitialization;
  }

  async loadProblemList() {
    const loadSequence = ++this.problemLoadSequence;
    const requestedGroup = this.group;
    try {
      const configuredUrl = window.OJ_CONFIG.PROBLEMS_URL;
      let response;

      try {
        const apiUrl = configuredUrl
          ? `${configuredUrl}&group=${encodeURIComponent(this.group)}`
          : this._localProblemIndexUrl();
        response = await fetch(apiUrl, { cache: 'no-store' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
      } catch (workerError) {
        if (!configuredUrl) throw workerError;
        // 自定义接口暂时不可达时，仍允许从 GitHub Pages 加载题目列表。
        response = await fetch(`${this._localProblemIndexUrl()}?t=${Date.now()}`, { cache: 'no-store' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
      }

      const problems = (await response.json()).filter(problem => problem.status !== 'draft');
      if (loadSequence !== this.problemLoadSequence || requestedGroup !== this.group) return;
      this.problemList = problems;
      this._renderProblemList(problems);
    } catch (err) {
      if (loadSequence !== this.problemLoadSequence || requestedGroup !== this.group) return;
      console.error('加载题目列表失败:', err);
      document.getElementById('problem-list').innerHTML = 
        '<p class="error">题目列表加载失败，请稍后刷新重试</p>';
    }
  }

  _localProblemIndexUrl() {
    return this.group === 'vision' ? 'problems/vision/index.json' : 'problems/index.json';
  }

  _renderGroupSwitcher() {
    document.querySelectorAll('.group-switch').forEach(button => {
      button.classList.toggle('active', button.dataset.group === this.group);
      button.setAttribute('aria-pressed', button.dataset.group === this.group ? 'true' : 'false');
    });
    const submissionGroupLabel = document.getElementById('submission-group-label');
    if (submissionGroupLabel) {
      submissionGroupLabel.textContent = this.group === 'vision' ? '视觉组' : '电控组';
    }
  }

  async switchGroup(group) {
    if (!['control', 'vision'].includes(group) || group === this.group) return;
    this._saveCurrentCode(this.editor?.getCode(), this.editor?.currentLanguage);
    clearTimeout(this.codeSaveTimer);
    this.problemRequestSequence += 1;
    this.group = group;
    this.currentProblem = null;
    this.problemList = [];
    this._renderGroupSwitcher();
    this._trackView();
    const url = new URL(location.href);
    if (group === 'control') url.searchParams.delete('group');
    else url.searchParams.set('group', group);
    history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
    this.views.show('problems');
    this.examUI?.onGroupChange();
    document.getElementById('problem-list').innerHTML = '<p class="info">⏳ 正在加载题目...</p>';
    await this.loadProblemList();
    await this._loadResubmissionNotices(true);
  }

  _renderProblemList(problems) {
    const container = document.getElementById('problem-list');
    if (!problems.length) {
      container.innerHTML = `<p class="info">${this.group === 'vision' ? '视觉组' : '电控组'}暂无题目</p>`;
      return;
    }
    container.innerHTML = problems.map(p => {
      const difficulty = ['easy', 'medium', 'hard'].includes(p.difficulty) ? p.difficulty : 'easy';
      const submitCount = Number.isFinite(Number(p.submitCount)) ? Number(p.submitCount) : 0;
      const needsResubmission = this.resubmissionNotices.some(notice => notice.problemId === p.id);
      return `
      <div class="problem-card" data-id="${this._escapeHtml(p.id)}" data-file="${this._escapeHtml(p.file)}">
        <div class="problem-header">
          <span class="problem-id">${this._escapeHtml(p.id)}</span>
          <span class="problem-title">${this._escapeHtml(p.title)}</span>
          ${needsResubmission ? '<span class="resubmit-badge">需要重新提交</span>' : ''}
          <span class="difficulty ${difficulty}">${this._difficultyText(difficulty)}</span>
        </div>
        <div class="problem-meta">
          <span>通过率: ${this._escapeHtml(p.acceptRate || 'N/A')}</span>
          <span>提交: ${submitCount}</span>
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
    const leavingExamProblem = Boolean(this.examUI?.programmingContext);
    this.examUI?.leaveProgrammingProblem();
    if (!leavingExamProblem) this._saveCurrentCode(this.editor?.getCode(), this.editor?.currentLanguage);
    clearTimeout(this.codeSaveTimer);
    const requestSequence = ++this.problemRequestSequence;
    const requestedGroup = this.group;
    try {
      const workerUrl = window.OJ_CONFIG.WORKER_URL;
      const problemUrl = workerUrl
        ? `${workerUrl}/?file=problem&name=${encodeURIComponent(file)}&group=${encodeURIComponent(this.group)}&t=${Date.now()}`
        : `${this.group === 'vision' ? 'problems/vision' : 'problems'}/${file}?t=${Date.now()}`;
      const response = await fetch(problemUrl, {
        cache: 'no-store',
        credentials: this.adminProblemPreview ? 'include' : 'same-origin',
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const problem = await response.json();
      if (requestSequence !== this.problemRequestSequence || requestedGroup !== this.group) return;
      this._saveCurrentCode(this.editor?.getCode(), this.editor?.currentLanguage);
      clearTimeout(this.codeSaveTimer);
      this.currentProblem = problem;
      this._renderProblem();
      this.views.show('solve');
      this._trackView(problem.id);
    } catch (err) {
      if (requestSequence !== this.problemRequestSequence || requestedGroup !== this.group) return;
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
      this._setHintsExpanded(p.hintsDefaultExpanded !== false);
    } else {
      hintsContainer.innerHTML = '';
      hintsContainer.hidden = true;
      hintsTitle.hidden = true;
    }
    
    this._renderSamples(p);

    // 每次进入题目恢复默认的左右占比。
    document.querySelector('.solve-layout')?.style.removeProperty('--problem-pane-width');

    // 优先恢复当前用户在这道题、这个语言下保存的代码。
    const defaultLanguage = p.pythonJudgeMode === 'function' || this.group === 'vision'
      ? 'python'
      : window.OJ_CONFIG.DEFAULT_LANGUAGE;
    const lang = getLanguageById(defaultLanguage);
    document.getElementById('language-select').value = lang.id;
    this.editor.setLanguage(lang.id);
    this._restoreCode(lang.id);
  }

  openExamProgrammingProblem(part) {
    if (!part?.problem) return;
    this._saveCurrentCode(this.editor?.getCode(), this.editor?.currentLanguage);
    clearTimeout(this.codeSaveTimer);
    this.currentProblem = part.problem;
    this._renderProblem();
    this.examUI.restoreProgrammingAnswer();
    const context = document.getElementById('exam-problem-context');
    context.hidden = false;
    document.getElementById('exam-problem-context-label').textContent = `${this.examUI.paper?.title || '套卷'} · ${part.problemId} ${part.problem.title || ''}`;
    document.getElementById('submit-btn').textContent = '保存代码并返回套卷';
    this.views.show('solve');
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
          <div><div class="sample-heading"><strong>输入 #${index + 1}</strong><button type="button" class="btn-small sample-fill-btn" data-sample-index="${index}">自动填充</button></div><pre data-sample-input>${this._escapeHtml(sample.input || '')}</pre></div>
          <div><strong>输出 #${index + 1}</strong><pre>${this._escapeHtml(sample.output || '')}</pre></div>
        </div>
      </div>
    `).join('') : '';
    if (samples.length) this._enhanceMarkdown(container);

    container.querySelectorAll('.sample-fill-btn').forEach(button => {
      button.addEventListener('click', () => {
        const input = samples[Number(button.dataset.sampleIndex)]?.input || '';
        document.getElementById('custom-input').value = input;
        document.getElementById('custom-input').focus();
      });
    });
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
    document.querySelectorAll('.group-switch').forEach(button => {
      button.addEventListener('click', () => this.switchGroup(button.dataset.group));
    });

    // 语言切换
    document.getElementById('language-select').addEventListener('change', (e) => {
      const langId = e.target.value;
      if (this.examUI?.changeProgrammingLanguage(langId)) return;
      this._saveCurrentCode(this.editor.getCode(), this.editor.currentLanguage);
      this.editor.setLanguage(langId);
      this._restoreCode(langId);
    });

    // 运行代码
    document.getElementById('run-btn').addEventListener('click', () => this.runCode());

    // 提交代码
    document.getElementById('submit-btn').addEventListener('click', () => {
      if (this.examUI?.programmingContext) this.examUI.returnFromProgrammingProblem();
      else this.submitCode();
    });
    document.querySelectorAll('.student-message-button').forEach(button => {
      button.addEventListener('click', () => this._openSystemMessages());
    });
    document.getElementById('student-message-list').addEventListener('click', event => {
      const button = event.target.closest('[data-message-problem]');
      if (button) this._openMessageProblem(button.dataset.messageGroup, button.dataset.messageProblem);
    });
    document.getElementById('close-student-messages').addEventListener('click', () => this._closeSystemMessages());
    document.getElementById('student-message-modal').addEventListener('click', event => {
      if (event.target.id === 'student-message-modal') this._closeSystemMessages();
    });

    document.querySelectorAll('.nav-link').forEach(link => {
      link.addEventListener('click', () => this.examUI?.leaveProgrammingProblem());
    });

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
    document.getElementById('change-password-btn').addEventListener('click', () => {
      this._promptUsername({ changePassword: true });
    });

    document.getElementById('clear-input-btn').addEventListener('click', () => {
      const input = document.getElementById('custom-input');
      input.value = '';
      input.focus();
    });

    document.getElementById('font-size-decrease').addEventListener('click', () => {
      this._setEditorFontSize(this.editorFontSize - 1);
    });
    document.getElementById('font-size-increase').addEventListener('click', () => {
      this._setEditorFontSize(this.editorFontSize + 1);
    });

    document.getElementById('reset-code-btn').addEventListener('click', () => {
      if (!confirm('确定要放弃当前代码并恢复默认模板吗？')) return;
      const languageId = document.getElementById('language-select').value;
      const template = getProblemLanguageTemplate(languageId, this.currentProblem);
      this.editor.setCode(template);
      if (!this.examUI?.programmingContext) this._saveCurrentCode(template, languageId);
      this.editor.focus();
    });

    document.getElementById('toggle-hints-btn').addEventListener('click', () => {
      const button = document.getElementById('toggle-hints-btn');
      this._setHintsExpanded(button.getAttribute('aria-expanded') !== 'true');
    });

    window.addEventListener('beforeunload', () => {
      if (this.examUI?.programmingContext) {
        this.examUI.captureProgrammingCode();
        this.examUI.saveDraft();
      } else {
        this._saveCurrentCode(this.editor?.getCode(), this.editor?.currentLanguage);
      }
    });
  }

  _trackView(problemId = '') {
    if (this.adminExamPreview || this.adminProblemPreview) return;
    const workerUrl = window.OJ_CONFIG.WORKER_URL;
    if (!workerUrl || !this.username) return;
    const now = new Date();
    const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const usernameKey = encodeURIComponent(this.username.normalize('NFC'));
    const viewKey = problemId
      ? `oj_analytics_sent_problem:${usernameKey}:${this.group}:${problemId}`
      : `oj_analytics_sent_site:${usernameKey}:${this.group}:${day}`;
    try {
      if (localStorage.getItem(viewKey) || this.analyticsPending.has(viewKey)) return;
    } catch {}
    this.analyticsPending.add(viewKey);
    fetch(workerUrl, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'analytics_view',
        visitorId: this.username,
        group: this.group,
        problemId: problemId || undefined,
      }),
      keepalive: true,
    }).then(response => {
      if (!response.ok) return;
      try { localStorage.setItem(viewKey, '1'); } catch {}
    }).catch(() => {}).finally(() => this.analyticsPending.delete(viewKey));
  }

  _trackExamView(examId) {
    if (this.adminExamPreview || this.adminProblemPreview) return;
    const workerUrl = window.OJ_CONFIG.WORKER_URL;
    const normalizedExamId = String(examId || '').trim().toUpperCase();
    if (!workerUrl || !this.username || !normalizedExamId) return;
    const usernameKey = encodeURIComponent(this.username.normalize('NFC'));
    const viewKey = `oj_analytics_sent_exam:${usernameKey}:${this.group}:${normalizedExamId}`;
    try {
      if (localStorage.getItem(viewKey) || this.analyticsPending.has(viewKey)) return;
    } catch {}
    this.analyticsPending.add(viewKey);
    fetch(workerUrl, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'analytics_view',
        visitorId: this.username,
        group: this.group,
        examId: normalizedExamId,
      }),
      keepalive: true,
    }).then(response => {
      if (!response.ok) return;
      try { localStorage.setItem(viewKey, '1'); } catch {}
    }).catch(() => {}).finally(() => this.analyticsPending.delete(viewKey));
  }

  _promptUsername(options = {}) {
    const dialog = document.getElementById('username-login');
    const form = document.getElementById('username-login-form');
    const input = document.getElementById('username-login-input');
    const nameField = document.getElementById('username-login-name-field');
    const passwordField = document.getElementById('username-login-password-field');
    const passwordInput = document.getElementById('username-login-password');
    const passwordLabel = passwordField.querySelector('span');
    const currentPasswordField = document.getElementById('username-login-current-password-field');
    const currentPasswordInput = document.getElementById('username-login-current-password');
    const confirmField = document.getElementById('username-login-confirm-field');
    const confirmInput = document.getElementById('username-login-confirm');
    const status = document.getElementById('username-login-status');
    const title = document.getElementById('username-login-title');
    const description = document.getElementById('username-login-description');
    const submit = document.getElementById('username-login-submit');
    const skip = document.getElementById('username-login-skip');
    const back = document.getElementById('username-login-back');
    const changePassword = document.getElementById('username-login-change-password');
    const changing = Boolean(this.username);
    let step = 'username';
    let pendingUsername = '';

    title.textContent = changing ? '修改用户名' : '登录机创 OJ';
    description.textContent = '请输入用户名，用于提交记录显示';
    submit.textContent = '下一步';
    input.value = this.username;
    input.disabled = false;
    nameField.hidden = false;
    passwordField.hidden = true;
    currentPasswordField.hidden = true;
    confirmField.hidden = true;
    passwordInput.value = '';
    currentPasswordInput.value = '';
    confirmInput.value = '';
    passwordInput.required = false;
    currentPasswordInput.required = false;
    confirmInput.required = false;
    skip.hidden = true;
    back.hidden = true;
    changePassword.hidden = true;
    status.textContent = '';
    dialog.hidden = false;
    document.body.classList.add('username-locked');
    const lockedPageElements = document.querySelectorAll('.header, body > main');
    lockedPageElements.forEach(element => { element.inert = true; });
    setTimeout(() => input.focus(), 0);

    return new Promise(resolve => {
      const finishLogin = name => {
        this._saveCurrentCode(this.editor?.getCode(), this.editor?.currentLanguage);
        clearTimeout(this.codeSaveTimer);
        this.username = name;
        localStorage.setItem('oj_username', this.username);
        this.examUI?.onGroupChange();
        document.getElementById('username-display').textContent = this.username;
        if (this.currentProblem) this._restoreCode(document.getElementById('language-select').value);
        this._trackView(this.currentProblem?.id || '');
        this._loadResubmissionNotices(true);
        this._loadSystemMessages(false);

        form.removeEventListener('submit', handleSubmit);
        skip.removeEventListener('click', handleSkip);
        back.removeEventListener('click', handleBack);
        changePassword.removeEventListener('click', handleChangePassword);
        dialog.hidden = true;
        document.body.classList.remove('username-locked');
        lockedPageElements.forEach(element => { element.inert = false; });
        resolve(this.username);
      };

      const showPasswordStep = (name, hasPassword) => {
        pendingUsername = name;
        step = hasPassword ? 'login-password' : 'set-password';
        nameField.hidden = true;
        input.disabled = true;
        passwordField.hidden = false;
        passwordLabel.textContent = hasPassword ? '密码' : '设置密码';
        confirmField.hidden = hasPassword;
        passwordInput.required = true;
        passwordInput.minLength = hasPassword ? 1 : 8;
        passwordInput.autocomplete = hasPassword ? 'current-password' : 'new-password';
        confirmInput.required = !hasPassword;
        skip.hidden = hasPassword;
        changePassword.hidden = !hasPassword;
        back.hidden = false;
        title.textContent = hasPassword ? '输入账号密码' : '设置账号密码';
        description.textContent = hasPassword
          ? `账号“${name}”已设置密码，请验证后进入`
          : '该账号还没有密码，可以现在设置，也可以暂时跳过';
        submit.textContent = hasPassword ? '登录' : '设置密码并进入';
        status.textContent = '';
        setTimeout(() => passwordInput.focus(), 0);
      };

      const showChangePasswordStep = name => {
        pendingUsername = name;
        step = 'change-password';
        nameField.hidden = true;
        input.disabled = true;
        currentPasswordField.hidden = false;
        passwordField.hidden = false;
        passwordLabel.textContent = '新密码';
        confirmField.hidden = false;
        currentPasswordInput.required = true;
        passwordInput.required = true;
        confirmInput.required = true;
        passwordInput.minLength = 8;
        passwordInput.autocomplete = 'new-password';
        skip.hidden = true;
        changePassword.hidden = true;
        back.hidden = false;
        title.textContent = '修改账号密码';
        description.textContent = `正在修改账号“${name}”的密码`;
        submit.textContent = '确认修改密码';
        status.textContent = '';
        setTimeout(() => currentPasswordInput.focus(), 0);
      };

      const handleSubmit = async event => {
        event.preventDefault();
        submit.disabled = true;
        status.textContent = '';
        try {
          if (step === 'username') {
            const name = input.value.trim().normalize('NFC');
            if (!name) {
              status.textContent = '请输入用户名后才能进入平台';
              input.focus();
              return;
            }
            if (name.length > 50) {
              status.textContent = '用户名不能超过 50 个字符';
              return;
            }
            status.textContent = '正在检查账号...';
            try {
              const account = await this._studentAccountRequest('student_account_status', { username: name });
              showPasswordStep(name, account.hasPassword);
            } catch (error) {
              status.textContent = error.message;
            }
            return;
          }

          const password = passwordInput.value;
          if (step === 'change-password') {
            if (!currentPasswordInput.value) {
              status.textContent = '请输入当前密码';
              currentPasswordInput.focus();
              return;
            }
            if (password.length < 8) {
              status.textContent = '新密码至少需要 8 个字符';
              passwordInput.focus();
              return;
            }
            if (password !== confirmInput.value) {
              status.textContent = '两次输入的新密码不一致';
              confirmInput.focus();
              return;
            }
            status.textContent = '正在修改密码...';
            await this._studentAccountRequest('student_change_password', {
              username: pendingUsername,
              currentPassword: currentPasswordInput.value,
              newPassword: password,
            });
            finishLogin(pendingUsername);
            return;
          }
          if (step === 'login-password') {
            if (!password) {
              status.textContent = '请输入密码';
              passwordInput.focus();
              return;
            }
            status.textContent = '正在验证密码...';
            await this._studentAccountRequest('student_login', { username: pendingUsername, password });
            finishLogin(pendingUsername);
            return;
          }

          if (password.length < 8) {
            status.textContent = '新密码至少需要 8 个字符，或者选择暂不设置';
            passwordInput.focus();
            return;
          }
          if (password !== confirmInput.value) {
            status.textContent = '两次输入的密码不一致';
            confirmInput.focus();
            return;
          }
          status.textContent = '正在设置密码...';
          await this._studentAccountRequest('student_set_password', {
            username: pendingUsername,
            password,
          });
          finishLogin(pendingUsername);
        } catch (error) {
          status.textContent = error.message || '账号操作失败，请稍后重试';
        } finally {
          submit.disabled = false;
        }
      };

      const handleChangePassword = () => {
        if (!pendingUsername) return;
        const typedCurrentPassword = passwordInput.value;
        passwordInput.value = '';
        confirmInput.value = '';
        showChangePasswordStep(pendingUsername);
        currentPasswordInput.value = typedCurrentPassword;
      };

      const handleSkip = async () => {
        if (step !== 'set-password' || !pendingUsername) return;
        skip.disabled = true;
        status.textContent = '正在建立登录状态...';
        try {
          await this._studentAccountRequest('student_skip_login', { username: pendingUsername });
          finishLogin(pendingUsername);
        } catch (error) {
          status.textContent = error.message || '暂时无法跳过，请稍后重试';
        } finally {
          skip.disabled = false;
        }
      };

      const handleBack = () => {
        step = 'username';
        pendingUsername = '';
        title.textContent = changing ? '修改用户名' : '登录机创 OJ';
        description.textContent = '请输入用户名，用于提交记录显示';
        submit.textContent = '下一步';
        nameField.hidden = false;
        input.disabled = false;
        passwordField.hidden = true;
        passwordLabel.textContent = '密码';
        currentPasswordField.hidden = true;
        confirmField.hidden = true;
        passwordInput.required = false;
        currentPasswordInput.required = false;
        confirmInput.required = false;
        passwordInput.value = '';
        currentPasswordInput.value = '';
        confirmInput.value = '';
        skip.hidden = true;
        back.hidden = true;
        changePassword.hidden = true;
        status.textContent = '';
        input.focus();
      };

      form.addEventListener('submit', handleSubmit);
      skip.addEventListener('click', handleSkip);
      back.addEventListener('click', handleBack);
      changePassword.addEventListener('click', handleChangePassword);
      if (options.changePassword && this.username) {
        status.textContent = '正在检查账号...';
        this._studentAccountRequest('student_account_status', { username: this.username })
          .then(account => {
            if (account.hasPassword) showChangePasswordStep(this.username);
            else showPasswordStep(this.username, false);
          })
          .catch(error => { status.textContent = error.message || '账号检查失败'; });
      } else if (options.verifyCurrent && this.username) {
        showPasswordStep(this.username, true);
      } else if (options.autoCheck && input.value.trim()) {
        setTimeout(() => form.requestSubmit(), 0);
      }
    });
  }

  async _studentAccountRequest(type, payload) {
    const response = await fetch(window.OJ_CONFIG.WORKER_URL, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, ...payload }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(result.error || `账号服务请求失败 (${response.status})`);
      error.code = result.code || '';
      error.status = response.status;
      throw error;
    }
    return result;
  }

  async _restoreStudentSession() {
    try {
      await this._studentAccountRequest('student_session', { username: this.username });
      return true;
    } catch {
      return false;
    }
  }

  _codeCacheKey(languageId = document.getElementById('language-select')?.value) {
    if (!this.username || !this.currentProblem || !languageId) return '';
    const modeSuffix = languageId === 'python' && this.currentProblem.pythonJudgeMode === 'function' ? ':function' : '';
    return `oj_code_v1:${encodeURIComponent(this.username)}:${this.group}:${this.currentProblem.id}:${languageId}${modeSuffix}`;
  }

  _saveCurrentCode(code = this.editor?.getCode(), languageId = document.getElementById('language-select')?.value) {
    const key = this._codeCacheKey(languageId);
    if (!key || this.isRestoringCode || typeof code !== 'string') return;
    try {
      localStorage.setItem(key, code);
    } catch (error) {
      console.warn('代码本地缓存失败:', error);
    }
  }

  _scheduleCodeSave(code) {
    if (this.isRestoringCode) return;
    clearTimeout(this.codeSaveTimer);
    this.codeSaveTimer = setTimeout(() => this._saveCurrentCode(code), 250);
  }

  _restoreCode(languageId) {
    clearTimeout(this.codeSaveTimer);
    const template = getProblemLanguageTemplate(languageId, this.currentProblem);
    const key = this._codeCacheKey(languageId);
    let cachedCode = null;
    try {
      if (key) cachedCode = localStorage.getItem(key);
    } catch (error) {
      console.warn('读取代码本地缓存失败:', error);
    }
    this.isRestoringCode = true;
    this.editor.setCode(cachedCode === null ? template : cachedCode);
    this.isRestoringCode = false;
  }

  _loadEditorFontSize() {
    const saved = Number(localStorage.getItem('oj_editor_font_size'));
    return Number.isFinite(saved) && saved >= 12 && saved <= 24
      ? saved
      : window.OJ_CONFIG.EDITOR_FONT_SIZE;
  }

  _setEditorFontSize(size) {
    this.editorFontSize = Math.min(24, Math.max(12, size));
    this.editor.setFontSize(this.editorFontSize);
    localStorage.setItem('oj_editor_font_size', String(this.editorFontSize));
    this._updateFontSizeDisplay();
  }

  _updateFontSizeDisplay() {
    const display = document.getElementById('font-size-value');
    if (display) display.textContent = `${this.editorFontSize}px`;
  }

  _setHintsExpanded(expanded) {
    const container = document.getElementById('problem-hints');
    const button = document.getElementById('toggle-hints-btn');
    container.hidden = !expanded;
    button.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    button.textContent = expanded ? '收起' : '展开';
  }

  _initSolveResizer() {
    const layout = document.querySelector('.solve-layout');
    const resizer = document.getElementById('solve-resizer');
    if (!layout || !resizer) return;

    const resizeTo = clientX => {
      const rect = layout.getBoundingClientRect();
      const dividerWidth = resizer.getBoundingClientRect().width;
      const minimum = 300;
      const maximum = Math.max(minimum, rect.width - dividerWidth - 380);
      const width = Math.min(maximum, Math.max(minimum, clientX - rect.left));
      layout.style.setProperty('--problem-pane-width', `${width}px`);
    };

    resizer.addEventListener('pointerdown', event => {
      if (window.matchMedia('(max-width: 1024px)').matches) return;
      resizer.setPointerCapture(event.pointerId);
      layout.classList.add('is-resizing');
      event.preventDefault();
    });
    resizer.addEventListener('pointermove', event => {
      if (resizer.hasPointerCapture(event.pointerId)) resizeTo(event.clientX);
    });
    const stopResizing = event => {
      if (resizer.hasPointerCapture(event.pointerId)) resizer.releasePointerCapture(event.pointerId);
      layout.classList.remove('is-resizing');
    };
    resizer.addEventListener('pointerup', stopResizing);
    resizer.addEventListener('pointercancel', stopResizing);
    resizer.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      const currentWidth = document.querySelector('.problem-panel').getBoundingClientRect().width;
      resizeTo(layout.getBoundingClientRect().left + currentWidth + (event.key === 'ArrowLeft' ? -24 : 24));
      event.preventDefault();
    });
  }

  async runCode(authRetried = false) {
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
      const executionCode = langId === 'python' && this.currentProblem?.pythonJudgeMode === 'function'
        ? buildPythonFunctionScript(code, this.currentProblem.pythonFunction)
        : code;
      const result = await this.runner.execute(
        lang.judge0LanguageId,
        executionCode,
        customInput,
        this.username,
        this.adminProblemPreview ? 'admin_execute' : 'execute',
      );

      if (result.compileError) {
        outputEl.innerHTML = `<span class="error">❌ 编译错误:\n${this._escapeHtml(result.stderr)}</span>`;
      } else if (result.exitCode !== 0) {
        outputEl.innerHTML = `<span class="error">❌ 运行时错误 (退出码: ${this._escapeHtml(result.exitCode)})\n${this._escapeHtml(result.stderr)}</span>`;
      } else {
        outputEl.innerHTML = `<span class="success">✅ 执行成功 (${this._escapeHtml(result.time)}ms)\n${this._escapeHtml(result.stdout)}</span>`;
      }
    } catch (err) {
      if (err.code === 'STUDENT_AUTH_REQUIRED' && !authRetried) {
        await this._promptUsername({ verifyCurrent: true });
        return this.runCode(true);
      }
      outputEl.innerHTML = `<span class="error">❌ ${this._escapeHtml(err.message)}</span>`;
    }
  }

  async submitCode(authRetried = false) {
    if (!this.currentProblem) {
      alert('请先选择一道题目');
      return;
    }

    if (!this.username) {
      await this._promptUsername();
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
      if (this.adminProblemPreview) {
        const previewResult = await this.github.submitPreview(
          this.currentProblem.id,
          langId,
          code,
          event => this._renderJudgeProgress(event),
          this.group,
        );
        this._renderJudgeResult(previewResult);
        return;
      }
      const result = await this.github.submit(
        this.currentProblem.id,
        this.username,
        langId,
        code,
        event => this._renderJudgeProgress(event),
        this.group
      );
      this._renderJudgeResult(result);
      this._loadResubmissionNotices(false);
    } catch (err) {
      if (err.code === 'STUDENT_AUTH_REQUIRED' && !authRetried) {
        await this._promptUsername({ verifyCurrent: true });
        return this.submitCode(true);
      }
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

  async _loadResubmissionNotices() {
    if (!this.username || this.adminExamPreview || this.adminProblemPreview) return;
    try {
      const response = await fetch(window.OJ_CONFIG.WORKER_URL, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'student_resubmission_notices',
          username: this.username,
          group: this.group,
        }),
      });
      if (!response.ok) return;
      const notices = await response.json();
      this.resubmissionNotices = Array.isArray(notices) ? notices : [];
      if (this.problemList.length) this._renderProblemList(this.problemList);
    } catch {
      // 通知读取失败不影响正常浏览和判题。
    }
  }

  async _loadSystemMessages(markRead = false, showResubmissionPopup = false) {
    if (!this.username || this.adminExamPreview || this.adminProblemPreview) return;
    try {
      const response = await fetch(window.OJ_CONFIG.WORKER_URL, {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'student_messages', username: this.username, markRead }),
      });
      if (!response.ok) return;
      const messages = await response.json();
      this.systemMessages = Array.isArray(messages) ? messages : [];
      const unread = this.systemMessages.filter(message => !message.read).length;
      document.querySelectorAll('.student-message-badge').forEach(badge => {
        badge.hidden = unread === 0;
        badge.textContent = unread > 99 ? '99+' : String(unread);
      });
      if (markRead) this._renderSystemMessages();
      if (showResubmissionPopup) {
        const notice = this.systemMessages.find(message =>
          message.messageType === 'resubmission' && message.requiresAction && !message.read);
        if (notice) {
          const popupKey = `oj_message_popup:${encodeURIComponent(this.username)}:${notice.id}`;
          if (sessionStorage.getItem(popupKey) !== '1') {
            sessionStorage.setItem(popupKey, '1');
            await this._openSystemMessages();
          }
        }
      }
    } catch {
      // 消息读取失败不阻塞题目和判题。
    }
  }

  async _openSystemMessages() {
    const modal = document.getElementById('student-message-modal');
    modal.hidden = false;
    document.body.style.overflow = 'hidden';
    document.getElementById('student-message-list').innerHTML = '<p class="info">正在加载消息...</p>';
    await this._loadSystemMessages(true);
  }

  _closeSystemMessages() {
    document.getElementById('student-message-modal').hidden = true;
    document.body.style.removeProperty('overflow');
  }

  _renderSystemMessages() {
    const container = document.getElementById('student-message-list');
    container.innerHTML = this.systemMessages.length ? this.systemMessages.map(message => `
      <article class="student-message-item${message.read ? '' : ' unread'}">
        <header><strong>${this._escapeHtml(message.title)}</strong><span>${message.messageType === 'resubmission' ? (message.requiresAction ? '待重新提交' : '已完成') : (message.audience === 'all' ? '公共公告' : '个人消息')}</span></header>
        <p>${this._escapeHtml(message.content)}</p>
        <footer><span>${this._escapeHtml(new Date(message.createdAt).toLocaleString())}</span>${message.messageType === 'resubmission' && message.problemId ? `<button type="button" class="btn-small" data-message-group="${this._escapeHtml(message.group || 'control')}" data-message-problem="${this._escapeHtml(message.problemId)}">${message.requiresAction ? '去重新提交' : '查看题目'}</button>` : ''}</footer>
      </article>`).join('') : '<p class="info">暂无系统消息</p>';
  }

  async _openMessageProblem(group, problemId) {
    const targetGroup = group === 'vision' ? 'vision' : 'control';
    if (targetGroup !== this.group) await this.switchGroup(targetGroup);
    const problem = this.problemList.find(item => item.id === problemId);
    if (!problem) {
      alert(`暂时找不到题目 ${problemId}，请刷新页面后重试。`);
      return;
    }
    this._closeSystemMessages();
    await this.loadProblem(problem.file);
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

  async loadSubmissions(authRetried = false) {
    const container = document.getElementById('submission-list');

    if (!this.username) {
      container.innerHTML = '<p class="info">请先设置用户名以查看提交记录</p>';
      return;
    }

    container.innerHTML = '<p class="info">⏳ 正在加载提交记录...</p>';

    try {
      const submissions = await this.github.getSubmissions(this.username, this.group);
      if (submissions.length === 0) {
        container.innerHTML = '<p class="info">暂无提交记录</p>';
        return;
      }

      container.innerHTML = `
        <table class="ranking">
          <thead>
            <tr>
              <th>时间</th>
              <th>组别</th>
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
                <td>${this._escapeHtml((item.group || this.group) === 'vision' ? '视觉组' : '电控组')}</td>
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
      if (err.code === 'STUDENT_AUTH_REQUIRED' && !authRetried) {
        await this._promptUsername({ verifyCurrent: true });
        return this.loadSubmissions(true);
      }
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
