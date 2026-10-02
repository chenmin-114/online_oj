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
      analyticsUrl: `${workerUrl}/?file=analytics`,
    };
    this.problems = [];
    this.submissions = [];
    this.group = 'control';
    this.loadSequence = 0;
    this.ranking = { overall: [], problems: {} };
    this.analytics = { daily: [], problems: {} };
    this.filteredSubmissions = [];
    this.problemImages = [];
    this.editingProblem = null;
    this.problemEditorContext = null;
    this.problemEditorHome = null;
    this.studentAccountFile = null;
    this.studentAccountWorkbook = null;
    this.studentAccountExportName = '';
    this.systemMessages = [];
    this.timedExtensions = [];
    this.controlsBound = false;
  }

  async init() {
    this.bindLogin();
    // 清除旧版本曾保存的管理员原始密码。
    sessionStorage.removeItem('oj_admin_password');
    await this.restoreSession();
  }

  bindLogin() {
    document.getElementById('admin-login-form').addEventListener('submit', event => {
      event.preventDefault();
      this.login(document.getElementById('admin-password').value);
    });
  }

  async restoreSession() {
    try {
      const response = await fetch(this.config.workerUrl, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'admin_session' }),
      });
      if (!response.ok) return;
      await this.activateSession();
    } catch {
      // 首次访问或网络暂不可用时保留登录界面。
    }
  }

  async activateSession() {
    document.body.classList.remove('auth-locked');
    document.getElementById('admin-login').hidden = true;
    document.getElementById('admin-password').value = '';
    if (!this.controlsBound) {
      this.bindNavigation();
      this.bindControls();
      this.controlsBound = true;
    }
    this.renderGroupSwitcher();
    await this.loadAll();
  }

  lockExpiredSession() {
    document.body.classList.add('auth-locked');
    document.getElementById('admin-login').hidden = false;
    document.getElementById('admin-login-status').textContent = '登录已过期，请重新输入密码';
    document.getElementById('admin-password').focus();
  }

  async login(password) {
    const button = document.getElementById('admin-login-button');
    const status = document.getElementById('admin-login-status');
    button.disabled = true;
    button.textContent = '验证中...';
    status.textContent = '';

    try {
      const response = await fetch(this.config.workerUrl, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'admin_login', password }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || `登录失败 (${response.status})`);

      await this.activateSession();
    } catch (error) {
      document.body.classList.add('auth-locked');
      document.getElementById('admin-login').hidden = false;
      status.textContent = error.message;
    } finally {
      button.disabled = false;
      button.textContent = '登录';
    }
  }

  async logout() {
    try {
      await fetch(this.config.workerUrl, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'admin_logout' }),
      });
    } finally {
      location.reload();
    }
  }

  bindNavigation() {
    document.querySelectorAll('.admin-nav-item').forEach(button => {
      button.addEventListener('click', () => {
        this.openPanel(button.dataset.panel);
        if (button.dataset.panel === 'messages') this.loadAdminMessages();
        if (button.dataset.panel === 'accounts') {
          this.populateTimedExtensionResources(true);
          this.loadTimedExtensions();
        }
      });
    });
    document.querySelectorAll('[data-open-panel]').forEach(button => {
      button.addEventListener('click', () => this.openPanel(button.dataset.openPanel));
    });
  }

  bindControls() {
    window.AdminSchedule.bind('problem');
    document.querySelectorAll('.admin-group-switch').forEach(button => {
      button.addEventListener('click', () => this.switchGroup(button.dataset.group));
    });
    document.getElementById('refresh-admin').addEventListener('click', () => this.loadAll());
    document.getElementById('logout-admin').addEventListener('click', () => this.logout());
    document.getElementById('submission-search').addEventListener('input', () => this.renderSubmissions());
    document.getElementById('submission-problem').addEventListener('change', () => this.renderSubmissions());
    document.getElementById('submission-result').addEventListener('change', () => this.renderSubmissions());
    document.getElementById('all-submissions').addEventListener('click', event => this.handleSubmissionAction(event));
    document.getElementById('export-submissions').addEventListener('click', () => this.exportSubmissions());
    document.getElementById('student-account-file').addEventListener('change', event => {
      this.selectStudentAccountFile(event.target.files?.[0] || null);
    });
    document.getElementById('import-student-accounts').addEventListener('click', () => this.importStudentAccounts());
    document.getElementById('download-student-accounts').addEventListener('click', () => this.downloadStudentAccounts());
    document.getElementById('generate-reset-password').addEventListener('click', () => {
      const input = document.getElementById('reset-student-password');
      input.value = this.generateStudentPassword();
      input.focus();
      input.select();
    });
    document.getElementById('reset-student-account-form').addEventListener('submit', event => this.resetStudentAccount(event));
    document.getElementById('timed-extension-form').addEventListener('submit', event => this.grantTimedExtension(event));
    document.getElementById('timed-extension-type').addEventListener('change', () => this.populateTimedExtensionResources(true));
    document.getElementById('refresh-timed-extensions').addEventListener('click', () => this.loadTimedExtensions());
    document.getElementById('timed-extension-list').addEventListener('click', event => this.revokeTimedExtension(event));
    document.getElementById('admin-message-audience').addEventListener('change', event => {
      const targeted = event.target.value === 'user';
      document.getElementById('admin-message-user-field').hidden = !targeted;
      document.getElementById('admin-message-username').required = targeted;
    });
    document.getElementById('admin-message-form').addEventListener('submit', event => this.publishAdminMessage(event));
    document.getElementById('refresh-admin-messages').addEventListener('click', () => this.loadAdminMessages());
    document.getElementById('admin-message-list').addEventListener('click', event => this.deleteAdminMessage(event));
    document.getElementById('admin-ranking-scope').addEventListener('change', event => {
      this.renderLeaderboard(event.target.value);
    });
    document.getElementById('show-problem-editor').addEventListener('click', () => this.startNewProblem());
    document.getElementById('close-problem-editor').addEventListener('click', () => this.hideProblemEditor());
    document.getElementById('reset-problem-editor').addEventListener('click', () => {
      if (this.editingProblem) this.editProblem(this.editingProblem.file);
      else if (this.problemEditorContext?.problemId) {
        const { problemId, onSaved } = this.problemEditorContext;
        this.startExamProblemEditor({ problemId, onSaved });
      }
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
      const editButton = event.target.closest('[data-edit-problem]');
      const previewButton = event.target.closest('[data-preview-problem]');
      if (editButton) this.editProblem(editButton.dataset.editProblem);
      if (previewButton) this.previewProblem(previewButton.dataset.previewProblem);
    });
    document.getElementById('close-admin-preview').addEventListener('click', () => this.closePreview());
    document.getElementById('admin-preview').addEventListener('click', event => {
      if (event.target.id === 'admin-preview') this.closePreview();
    });
    document.getElementById('admin-preview-body').addEventListener('click', event => this.handlePreviewAction(event));
    document.getElementById('admin-preview-body').addEventListener('change', event => {
      if (!event.target.matches('[data-preview-language]')) return;
      const code = document.querySelector('[data-preview-code]');
      if (code && !code.value.trim()) code.value = this.problemTemplate(event.target.value, this.previewProblemData);
    });
    document.getElementById('problem-id').addEventListener('input', event => {
      const fileInput = document.getElementById('problem-file');
      if (!fileInput.value || /^(?:p\d+|t\d+)\.json$/i.test(fileInput.value)) {
        const id = event.target.value.trim().toLowerCase();
        fileInput.value = id ? `${id}.json` : '';
      }
    });
    document.getElementById('problem-python-judge-mode').addEventListener('change', () => {
      this.updatePythonJudgeModeFields();
    });
  }

  groupLabel(group = this.group) {
    return group === 'vision' ? '视觉组' : '电控组';
  }

  renderGroupSwitcher() {
    document.querySelectorAll('.admin-group-switch').forEach(button => {
      const active = button.dataset.group === this.group;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
    const display = document.getElementById('problem-group-display');
    if (display) display.value = this.groupLabel();
    const advancedEditor = document.getElementById('advanced-problem-editor');
    if (advancedEditor) {
      const path = this.group === 'vision' ? 'problems/vision/index.json' : 'problems/index.json';
      advancedEditor.href = `https://github.com/${this.config.repo}/edit/main/${path}`;
    }
  }

  async switchGroup(group) {
    if (!['control', 'vision'].includes(group) || group === this.group) return;
    this.group = group;
    this.editingProblem = null;
    this.hideProblemEditor();
    this.resetProblemEditor();
    this.renderGroupSwitcher();
    window.examAdmin?.onGroupChange();
    this.timedExtensions = [];
    this.populateTimedExtensionResources();
    document.getElementById('sync-status').textContent = `正在切换到${this.groupLabel()}...`;
    await this.loadAll();
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
    const loadSequence = ++this.loadSequence;
    const requestedGroup = this.group;
    const button = document.getElementById('refresh-admin');
    button.disabled = true;
    button.textContent = '↻ 同步中...';

    const workerCheck = this.fetchWorkerHealth();
    const [problemsResult, submissionsResult, rankingResult, analyticsResult] = await Promise.allSettled([
      this.fetchJson(this.config.problemsUrl),
      this.fetchJson(this.config.submissionsUrl),
      this.fetchRanking(),
      this.fetchJson(this.config.analyticsUrl),
    ]);
    if (loadSequence !== this.loadSequence || requestedGroup !== this.group) return;

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
    if (analyticsResult.status === 'fulfilled' && analyticsResult.value) {
      this.analytics = analyticsResult.value;
    } else {
      this.analytics = { daily: [], problems: {} };
    }

    this.renderAll();
    this.populateTimedExtensionResources();
    this.updateDataStatus({ submissionsResult, rankingResult });
    this.setStatus('worker', null, '正在检查连接...');
    workerCheck.then(result => {
      this.setStatus('worker', true,
        `${result.executionProvider} · GitHub ${result.githubConfigured ? '已配置' : '未配置'}`);
    }).catch(() => {
      this.setStatus('worker', false, '连接失败');
    });
    document.getElementById('sync-status').textContent = `${this.groupLabel()} · 更新于 ${new Date().toLocaleTimeString()}`;
    button.disabled = false;
    button.textContent = '↻ 刷新数据';
    this.toast('管理数据已刷新');
  }

  async fetchJson(url) {
    const separator = url.includes('?') ? '&' : '?';
    const response = await fetch(`${url}${separator}group=${encodeURIComponent(this.group)}&t=${Date.now()}`, {
      cache: 'no-store',
      credentials: 'include',
    });
    if (response.status === 401) this.lockExpiredSession();
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
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'admin_health' }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!response.ok) throw new Error(`Worker: HTTP ${response.status}`);
    return response.json();
  }

  selectStudentAccountFile(file) {
    const status = document.getElementById('student-account-status');
    this.studentAccountFile = file;
    this.studentAccountWorkbook = null;
    this.studentAccountExportName = '';
    document.getElementById('student-account-file-name').textContent = file
      ? `${file.name} · ${this.formatFileSize(file.size)}`
      : '尚未选择文件';
    document.getElementById('import-student-accounts').disabled = !file;
    document.getElementById('download-student-accounts').disabled = true;
    document.getElementById('student-account-summary').hidden = true;
    status.className = 'account-import-status';
    status.textContent = file
      ? '文件已选择。点击“生成密码并注册账号”开始处理。'
      : '已有密码会保留；密码为空时会生成 16 位高随机密码。账号密码只以带盐哈希保存到服务器。';
  }

  async resetStudentAccount(event) {
    event.preventDefault();
    const usernameInput = document.getElementById('reset-student-username');
    const passwordInput = document.getElementById('reset-student-password');
    const button = document.getElementById('reset-student-account');
    const status = document.getElementById('reset-student-status');
    const username = usernameInput.value.trim().normalize('NFC');
    const password = passwordInput.value;
    if (!username || username.length > 50 || /[\u0000-\u001f\u007f]/.test(username)) {
      status.className = 'account-import-status error';
      status.textContent = '请输入格式正确的学生用户名。';
      return;
    }
    if (password.length < 8 || password.length > 128) {
      status.className = 'account-import-status error';
      status.textContent = '新密码长度必须为 8 到 128 位。';
      return;
    }
    if (!confirm(`确定重置“${username}”的密码，并赋予全部套卷权限吗？该账号当前登录会立即失效。`)) return;

    button.disabled = true;
    status.className = 'account-import-status';
    status.textContent = '正在本机加密新密码并更新账号...';
    try {
      const passwordData = await this.hashStudentPassword(password);
      const response = await fetch(this.config.workerUrl, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'admin_reset_student_account',
          username,
          ...passwordData,
        }),
      });
      const result = await response.json().catch(() => ({}));
      if (response.status === 401) this.lockExpiredSession();
      if (!response.ok) throw new Error(result.error || `账号更新失败 (${response.status})`);
      status.className = 'account-import-status success';
      status.textContent = `${result.created ? '账号已创建' : '密码已重置'}：${username} 已获得全部套卷权限，旧登录已失效。请复制上方新密码交给学生。`;
      usernameInput.value = '';
      passwordInput.focus();
      passwordInput.select();
    } catch (error) {
      status.className = 'account-import-status error';
      status.textContent = error.message || '账号更新失败';
    } finally {
      button.disabled = false;
    }
  }

  async timedExtensionRequest(type, payload = {}) {
    const response = await fetch(this.config.workerUrl, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, group: this.group, ...payload }),
    });
    const result = await response.json().catch(() => ({}));
    if (response.status === 401) this.lockExpiredSession();
    if (!response.ok) throw new Error(result.error || `请求失败 (${response.status})`);
    return result;
  }

  async populateTimedExtensionResources(loadExams = false) {
    const select = document.getElementById('timed-extension-resource');
    if (!select) return;
    const type = document.getElementById('timed-extension-type').value;
    const current = select.value;
    if (type === 'exam' && loadExams && window.examAdmin) {
      try { await window.examAdmin.ensureLoaded(true, true); } catch { /* 下方保留可重试提示 */ }
    }
    const resources = type === 'exam'
      ? (window.examAdmin?.exams || []).filter(item => item.status === 'published').map(item => ({ id: item.id, title: item.title }))
      : this.problems.filter(item => item.status !== 'draft').map(item => ({ id: item.id, title: item.title }));
    select.innerHTML = '<option value="">请选择</option>' + resources.map(item =>
      `<option value="${this.escape(item.id)}">${this.escape(item.id)} · ${this.escape(item.title)}</option>`
    ).join('');
    if (resources.some(item => item.id === current)) select.value = current;
    if (!resources.length) select.innerHTML = `<option value="">当前${type === 'exam' ? '没有已发布套卷' : '没有已发布题目'}</option>`;
  }

  async loadTimedExtensions() {
    const body = document.getElementById('timed-extension-list');
    const status = document.getElementById('timed-extension-status');
    if (!body || document.body.classList.contains('auth-locked')) return;
    try {
      this.timedExtensions = await this.timedExtensionRequest('admin_timed_extension_list');
      this.renderTimedExtensions();
    } catch (error) {
      status.className = 'account-import-status error';
      status.textContent = `读取补时记录失败：${error.message}`;
    }
  }

  renderTimedExtensions() {
    const body = document.getElementById('timed-extension-list');
    const rows = this.timedExtensions || [];
    body.innerHTML = rows.length ? rows.map(item => `
      <tr>
        <td>${item.resourceType === 'exam' ? '套卷' : '编程题'}</td>
        <td><strong>${this.escape(item.resourceId)}</strong></td>
        <td>${this.escape(item.username)}</td>
        <td>${this.formatDate(item.startsAt)}</td>
        <td>${this.formatDate(item.endsAt)}</td>
        <td><span class="result-pill ${item.active ? 'accepted' : 'failed'}">${item.active ? '进行中' : '已结束'}</span></td>
        <td><button type="button" class="table-link table-link-button warning" data-revoke-extension="1" data-resource-type="${this.escape(item.resourceType)}" data-resource-id="${this.escape(item.resourceId)}" data-username="${this.escape(item.username)}">撤销</button></td>
      </tr>`).join('') : '<tr><td colspan="7" class="empty-cell">暂无补时记录</td></tr>';
  }

  async grantTimedExtension(event) {
    event.preventDefault();
    const button = document.getElementById('grant-timed-extension');
    const status = document.getElementById('timed-extension-status');
    const resourceType = document.getElementById('timed-extension-type').value;
    const resourceId = document.getElementById('timed-extension-resource').value;
    const username = document.getElementById('timed-extension-username').value.trim().normalize('NFC');
    const minutes = Number(document.getElementById('timed-extension-minutes').value);
    if (!resourceId || !username || !Number.isInteger(minutes) || minutes < 1 || minutes > 1440) {
      status.className = 'account-import-status error';
      status.textContent = '请选择题目或套卷，填写学生用户名及 1 到 1440 的整数分钟数。';
      return;
    }
    if (!confirm(`确定从现在起给“${username}”开放 ${resourceId} 共 ${minutes} 分钟吗？`)) return;
    button.disabled = true;
    status.className = 'account-import-status';
    status.textContent = '正在按服务器时间授权...';
    try {
      const result = await this.timedExtensionRequest('admin_timed_extension_grant', {
        resourceType, resourceId, username, minutes,
      });
      status.className = 'account-import-status success';
      status.textContent = `授权成功：${result.username} 可从现在答题至 ${new Date(result.endsAt).toLocaleString()}。请让学生重新进入对应页面，或切回该浏览器标签页。`;
      await this.loadTimedExtensions();
    } catch (error) {
      status.className = 'account-import-status error';
      status.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  }

  async revokeTimedExtension(event) {
    const button = event.target.closest('[data-revoke-extension]');
    if (!button) return;
    if (!confirm(`确定撤销“${button.dataset.username}”对 ${button.dataset.resourceId} 的临时补时吗？`)) return;
    button.disabled = true;
    try {
      await this.timedExtensionRequest('admin_timed_extension_revoke', {
        resourceType: button.dataset.resourceType,
        resourceId: button.dataset.resourceId,
        username: button.dataset.username,
      });
      document.getElementById('timed-extension-status').className = 'account-import-status success';
      document.getElementById('timed-extension-status').textContent = '补时已撤销，服务器将立即拒绝后续修改和提交。';
      await this.loadTimedExtensions();
    } catch (error) {
      document.getElementById('timed-extension-status').className = 'account-import-status error';
      document.getElementById('timed-extension-status').textContent = `撤销失败：${error.message}`;
      button.disabled = false;
    }
  }

  async importStudentAccounts() {
    const file = this.studentAccountFile;
    const button = document.getElementById('import-student-accounts');
    const downloadButton = document.getElementById('download-student-accounts');
    const status = document.getElementById('student-account-status');
    if (!file) return;
    if (!window.XLSX) {
      status.className = 'account-import-status error';
      status.textContent = 'Excel 组件加载失败，请刷新管理页面后重试。';
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      status.className = 'account-import-status error';
      status.textContent = 'Excel 文件不能超过 10 MB。';
      return;
    }

    button.disabled = true;
    downloadButton.disabled = true;
    status.className = 'account-import-status';
    status.textContent = '正在读取 Excel 并识别姓名、密码列...';
    try {
      const workbook = XLSX.read(await file.arrayBuffer(), {
        type: 'array',
        cellDates: true,
        cellStyles: true,
      });
      const prepared = this.prepareStudentAccountWorkbook(workbook);
      if (!prepared.accounts.length) throw new Error('没有找到可注册的姓名，请检查表头和名单内容');

      const hashedAccounts = [];
      for (let index = 0; index < prepared.accounts.length; index++) {
        if (index === 0 || index % 10 === 0) {
          status.textContent = `正在本机加密账号密码 ${index + 1}/${prepared.accounts.length}...`;
        }
        const account = prepared.accounts[index];
        hashedAccounts.push({
          username: account.username,
          ...await this.hashStudentPassword(account.password),
        });
      }

      status.textContent = `正在注册 ${hashedAccounts.length} 个账号...`;
      const response = await fetch(this.config.workerUrl, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'admin_import_students', accounts: hashedAccounts }),
      });
      const result = await response.json().catch(() => ({}));
      if (response.status === 401) this.lockExpiredSession();
      if (!response.ok) throw new Error(result.error || `账号注册失败 (${response.status})`);

      this.studentAccountWorkbook = workbook;
      this.studentAccountExportName = `${file.name.replace(/\.[^.]+$/, '')}-已更新账号.xlsx`;
      document.getElementById('account-summary-total').textContent = prepared.accounts.length;
      document.getElementById('account-summary-existing').textContent = prepared.existingCount;
      document.getElementById('account-summary-generated').textContent = prepared.generatedCount;
      document.getElementById('student-account-summary').hidden = false;
      downloadButton.disabled = false;
      status.className = 'account-import-status success';
      status.textContent = `注册完成：${result.imported} 个账号已更新。请导出并妥善保存新 Excel，服务器不保存明文密码。`;
    } catch (error) {
      this.studentAccountWorkbook = null;
      this.studentAccountExportName = '';
      status.className = 'account-import-status error';
      status.textContent = error.message || 'Excel 处理失败';
    } finally {
      button.disabled = false;
    }
  }

  prepareStudentAccountWorkbook(workbook) {
    const accountHeaders = new Set(['账号', '登录账号', '用户名', 'account', 'username']);
    const nameHeaders = new Set(['姓名', '学生姓名', '名字', 'name']);
    const passwordHeaders = new Set(['密码', '登录密码', '初始密码', 'password']);
    const occurrences = [];

    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName];
      if (!sheet?.['!ref']) continue;
      const range = XLSX.utils.decode_range(sheet['!ref']);
      let section = null;
      for (let row = range.s.r; row <= Math.min(range.e.r, range.s.r + 29); row++) {
        let accountColumn = -1;
        let nameColumn = -1;
        let passwordColumn = -1;
        for (let column = range.s.c; column <= range.e.c; column++) {
          const text = this.accountCellText(sheet[XLSX.utils.encode_cell({ r: row, c: column })]);
          const normalized = text.toLowerCase().replace(/[\s:：]/g, '');
          if (accountHeaders.has(normalized)) accountColumn = column;
          if (nameHeaders.has(normalized)) nameColumn = column;
          if (passwordHeaders.has(normalized)) passwordColumn = column;
        }
        const usernameColumn = accountColumn !== -1 ? accountColumn : nameColumn;
        if (usernameColumn !== -1) {
          section = {
            sheet,
            range,
            headerRow: row,
            nameColumn: usernameColumn,
            passwordColumn: passwordColumn === -1 ? range.e.c + 1 : passwordColumn,
          };
          break;
        }
      }
      if (!section) continue;

      const passwordHeaderAddress = XLSX.utils.encode_cell({
        r: section.headerRow,
        c: section.passwordColumn,
      });
      if (!section.sheet[passwordHeaderAddress]) {
        section.sheet[passwordHeaderAddress] = { t: 's', v: '密码' };
        section.range.e.c = Math.max(section.range.e.c, section.passwordColumn);
        section.sheet['!ref'] = XLSX.utils.encode_range(section.range);
      }

      for (let row = section.headerRow + 1; row <= section.range.e.r; row++) {
        const nameAddress = XLSX.utils.encode_cell({ r: row, c: section.nameColumn });
        const passwordAddress = XLSX.utils.encode_cell({ r: row, c: section.passwordColumn });
        const username = this.accountCellText(section.sheet[nameAddress]).trim().normalize('NFC');
        if (!username) continue;
        if (username.length > 50 || /[\u0000-\u001f\u007f]/.test(username)) {
          throw new Error(`工作表“${sheetName}”第 ${row + 1} 行姓名格式不正确`);
        }
        occurrences.push({
          sheet: section.sheet,
          passwordAddress,
          username,
          password: this.accountCellText(section.sheet[passwordAddress]),
        });
      }
    }

    if (!occurrences.length) return { accounts: [], existingCount: 0, generatedCount: 0 };
    const passwords = new Map();
    const existingUsers = new Set();
    for (const occurrence of occurrences) {
      if (!occurrence.password) continue;
      if (occurrence.password.length > 128) throw new Error(`“${occurrence.username}”的密码超过 128 个字符`);
      const known = passwords.get(occurrence.username);
      if (known && known !== occurrence.password) {
        throw new Error(`姓名“${occurrence.username}”在表格中出现了不同密码，请先统一`);
      }
      passwords.set(occurrence.username, occurrence.password);
      existingUsers.add(occurrence.username);
    }

    const generatedUsers = new Set();
    const usedPasswords = new Set(passwords.values());
    for (const occurrence of occurrences) {
      let password = passwords.get(occurrence.username);
      if (!password) {
        do { password = this.generateStudentPassword(); } while (usedPasswords.has(password));
        passwords.set(occurrence.username, password);
        usedPasswords.add(password);
        generatedUsers.add(occurrence.username);
      }
      if (!occurrence.password) occurrence.sheet[occurrence.passwordAddress] = { t: 's', v: password };
    }

    return {
      accounts: Array.from(passwords, ([username, password]) => ({ username, password })),
      existingCount: existingUsers.size,
      generatedCount: generatedUsers.size,
    };
  }

  accountCellText(cell) {
    if (!cell || cell.v == null) return '';
    return String(cell.v).trim();
  }

  generateStudentPassword() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%_-';
    const limit = Math.floor(256 / alphabet.length) * alphabet.length;
    let password = '';
    while (password.length < 16) {
      const bytes = new Uint8Array(24);
      crypto.getRandomValues(bytes);
      for (const byte of bytes) {
        if (byte < limit) password += alphabet[byte % alphabet.length];
        if (password.length === 16) break;
      }
    }
    return password;
  }

  async hashStudentPassword(password) {
    const saltBytes = new Uint8Array(16);
    crypto.getRandomValues(saltBytes);
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(password),
      'PBKDF2',
      false,
      ['deriveBits'],
    );
    const bits = await crypto.subtle.deriveBits({
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt: saltBytes,
      iterations: 100000,
    }, key, 256);
    return {
      salt: this.bytesToBase64Url(saltBytes),
      hash: this.bytesToBase64Url(new Uint8Array(bits)),
    };
  }

  bytesToBase64Url(bytes) {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  downloadStudentAccounts() {
    if (!this.studentAccountWorkbook || !this.studentAccountExportName) return;
    XLSX.writeFile(this.studentAccountWorkbook, this.studentAccountExportName, { compression: true });
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
    this.renderAnalytics();
  }

  renderAnalytics() {
    const daily = Array.isArray(this.analytics.daily) ? this.analytics.daily : [];
    const chart = document.getElementById('daily-visitors-chart');
    const maxDaily = Math.max(1, ...daily.map(item => Number(item.visitors) || 0));
    chart.innerHTML = daily.length ? daily.map(item => {
      const count = Number(item.visitors) || 0;
      const shortDay = String(item.day || '').slice(5).replace('-', '/');
      return `<div class="daily-visitor-column" title="${this.escape(item.day)}：${this.escape(count)} 人">
        <span>${this.escape(count)}</span>
        <div><i style="height:${Math.max(count ? 5 : 0, count / maxDaily * 100)}%"></i></div>
        <small>${this.escape(shortDay)}</small>
      </div>`;
    }).join('') : '<p class="empty-cell">暂无浏览数据</p>';
    // 30 天数据较宽时，默认展示最右侧的最新日期。
    requestAnimationFrame(() => {
      chart.scrollLeft = chart.scrollWidth;
    });

    const problemCounts = this.analytics.problems || {};
    const acceptedUsers = this.problemAcceptedUsers();
    this.renderProblemRanking(
      'problem-accepted-ranking',
      problem => acceptedUsers[problem.id]?.size || 0,
      '人'
    );
    this.renderProblemRanking(
      'problem-visitors-ranking',
      problem => Number(problemCounts[problem.id]) || 0,
      '人'
    );
    document.getElementById('daily-visitors-subtitle').textContent = `${this.groupLabel()} · 每日独立用户名`;
    document.getElementById('problem-submissions-subtitle').textContent = `${this.groupLabel()} · 实际提交次数`;
    document.getElementById('problem-accepted-subtitle').textContent = `${this.groupLabel()} · 每题去重通过人数`;
    document.getElementById('problem-visitors-subtitle').textContent = `${this.groupLabel()} · 每题累计独立用户名`;
  }

  problemAcceptedUsers() {
    const acceptedUsers = {};
    this.submissions.filter(item => item.passed).forEach(item => {
      const problemId = String(item.problemId || '');
      const username = String(item.username || '').trim().normalize('NFC');
      if (!problemId || !username) return;
      if (!acceptedUsers[problemId]) acceptedUsers[problemId] = new Set();
      acceptedUsers[problemId].add(username);
    });
    return acceptedUsers;
  }

  renderProblemRanking(containerId, valueForProblem, suffix) {
    const container = document.getElementById(containerId);
    if (!container) return;
    const ranked = this.problems
      .map(problem => ({ ...problem, rankingValue: Number(valueForProblem(problem)) || 0 }))
      .sort((a, b) => b.rankingValue - a.rankingValue || String(a.id).localeCompare(String(b.id), 'zh-CN', { numeric: true }));
    const max = Math.max(1, ...ranked.map(problem => problem.rankingValue));
    container.innerHTML = ranked.length ? ranked.map((problem, index) => `
      <div class="activity-row">
        <div class="activity-row-header">
          <span class="activity-title"><b class="activity-rank">${index + 1}</b><span title="${this.escape(problem.id)} · ${this.escape(problem.title)}">${this.escape(problem.id)} · ${this.escape(problem.title)}</span></span>
          <span class="activity-value">${this.escape(problem.rankingValue)} ${this.escape(suffix)}</span>
        </div>
        <div class="activity-track"><div class="activity-bar" style="width:${Math.max(0, Math.min(100, problem.rankingValue / max * 100))}%"></div></div>
      </div>
    `).join('') : '<p class="empty-cell">暂无题目</p>';
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
    const counts = this.countBy(this.submissions, item => item.problemId);
    this.renderProblemRanking('problem-activity', problem => counts[problem.id] || 0, '次');
  }

  renderProblems() {
    const body = document.getElementById('problem-admin-list');
    const counts = this.countBy(this.submissions, item => item.problemId);
    const acceptedUsers = this.problemAcceptedUsers();
    const visitorCounts = this.analytics.problems || {};
    body.innerHTML = this.problems.length ? this.problems.map(problem => `
      <tr>
        <td><strong>${this.escape(problem.id)}</strong></td>
        <td>${this.escape(problem.title)}</td>
        <td><span class="result-pill ${problem.status === 'draft' ? 'failed' : 'accepted'}">${problem.status === 'draft' ? '草稿' : '已发布'}</span></td>
        <td><span class="difficulty-pill ${this.escape(problem.difficulty)}">${this.escape(this.difficultyText(problem.difficulty))}</span></td>
        <td>${this.escape(counts[problem.id] || 0)}</td>
        <td>${this.escape(Number(visitorCounts[problem.id]) || 0)}</td>
        <td>${this.escape(acceptedUsers[problem.id]?.size || 0)}</td>
        <td><button type="button" class="table-link table-link-button" data-preview-problem="${this.escape(problem.file)}">预览</button> · <button type="button" class="table-link table-link-button" data-edit-problem="${this.escape(problem.file)}">可视化编辑</button></td>
      </tr>
    `).join('') : '<tr><td colspan="8" class="empty-cell">暂无题目</td></tr>';
  }

  showProblemEditor() {
    const editor = document.getElementById('problem-editor');
    editor.hidden = false;
    if (!document.querySelector('.test-case-row')) this.addTestCase();
    editor.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setTimeout(() => document.getElementById('problem-id').focus(), 250);
  }

  hideProblemEditor() {
    const editor = document.getElementById('problem-editor');
    editor.hidden = true;
    if (this.problemEditorContext) this.finishExamProblemEditor(null);
  }

  startExamProblemEditor({ problemId, onSaved }) {
    const editor = document.getElementById('problem-editor');
    if (!this.problemEditorHome) {
      this.problemEditorHome = { parent: editor.parentNode, nextSibling: editor.nextSibling };
    }
    this.problemEditorContext = { problemId, onSaved };
    document.getElementById('exam-problem-editor-host').appendChild(editor);
    document.getElementById('exam-problem-editor-modal').hidden = false;
    document.body.classList.add('preview-open');
    this.editingProblem = null;
    this.resetProblemEditor();
    this.setProblemEditorMode(false);
    document.getElementById('problem-id').value = problemId;
    document.getElementById('problem-id').readOnly = true;
    document.getElementById('problem-file').value = `${problemId.toLowerCase()}.json`;
    document.getElementById('problem-file').readOnly = true;
    document.getElementById('problem-status').value = 'draft';
    document.getElementById('problem-editor-title').textContent = `新建套卷编程题 ${problemId}`;
    document.getElementById('problem-editor-subtitle').textContent = '与普通编程题共用完整编辑器；保存后会自动关联到当前套卷小题';
    this.showProblemEditor();
  }

  async editExamProblemEditor({ file, onSaved }) {
    const editor = document.getElementById('problem-editor');
    if (!this.problemEditorHome) {
      this.problemEditorHome = { parent: editor.parentNode, nextSibling: editor.nextSibling };
    }
    this.problemEditorContext = { onSaved };
    document.getElementById('exam-problem-editor-host').appendChild(editor);
    document.getElementById('exam-problem-editor-modal').hidden = false;
    document.body.classList.add('preview-open');
    await this.editProblem(file);
    if (this.problemEditorContext) {
      document.getElementById('problem-editor-title').textContent = '编辑套卷编程题';
      document.getElementById('problem-editor-subtitle').textContent = '保存后套卷会继续引用更新后的同一道题';
    }
  }

  finishExamProblemEditor(savedProblem) {
    const context = this.problemEditorContext;
    const editor = document.getElementById('problem-editor');
    this.problemEditorContext = null;
    document.getElementById('exam-problem-editor-modal').hidden = true;
    if (this.problemEditorHome) {
      this.problemEditorHome.parent.insertBefore(editor, this.problemEditorHome.nextSibling);
    }
    document.body.classList.remove('preview-open');
    if (!savedProblem) {
      this.editingProblem = null;
      this.setProblemEditorMode(false);
      this.resetProblemEditor();
    }
    if (savedProblem && typeof context?.onSaved === 'function') context.onSaved(savedProblem);
  }

  resetProblemEditor() {
    document.getElementById('problem-editor').reset();
    document.getElementById('problem-status').value = 'published';
    document.getElementById('sample-editor').innerHTML = '';
    document.getElementById('test-case-editor').innerHTML = '';
    document.getElementById('problem-save-status').textContent = '';
    window.AdminSchedule.set('problem', { enabled: false, windows: [], afterEndView: 'none' });
    document.getElementById('problem-import-status').textContent = '可粘贴完整题面或单独的某个部分；只更新本次识别到的内容，样例和测试点会追加';
    this.clearProblemImages();
    this.addSample();
    this.addTestCase();
    this.updatePythonJudgeModeFields();
    this.renderGroupSwitcher();
  }

  updatePythonJudgeModeFields() {
    const functionMode = document.getElementById('problem-python-judge-mode').value === 'function';
    const field = document.getElementById('python-function-signature-field');
    const input = document.getElementById('problem-python-function-signature');
    field.hidden = !functionMode;
    input.required = functionMode;
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
    document.getElementById('save-problem').textContent = isEditing ? '保存修改' : '保存题目';
  }

  async editProblem(file) {
    const requestedGroup = this.group;
    try {
      this.toast('正在读取题目内容...');
      const problem = await this.fetchJson(`${this.config.workerUrl}/?file=problem&name=${encodeURIComponent(file)}`);
      if (requestedGroup !== this.group) return;
      this.resetProblemEditor();
      this.editingProblem = { file, id: problem.id, group: this.group };
      this.setProblemEditorMode(true);

      document.getElementById('problem-id').value = problem.id || '';
      document.getElementById('problem-title').value = problem.title || '';
      document.getElementById('problem-difficulty').value = problem.difficulty || 'easy';
      document.getElementById('problem-status').value = problem.status === 'draft' ? 'draft' : 'published';
      document.getElementById('problem-file').value = file;
      document.getElementById('problem-description').value = problem.description || '';
      document.getElementById('problem-input-format').value = problem.inputFormat || '';
      document.getElementById('problem-output-format').value = problem.outputFormat || '';
      document.getElementById('problem-constraints').value = problem.constraints || '';
      document.getElementById('problem-sample-explanation').value = problem.sampleExplanation || '';
      document.getElementById('problem-show-test-details').checked = problem.showTestDetails === true;
      document.getElementById('problem-hints-default-expanded').checked = problem.hintsDefaultExpanded !== false;
      document.getElementById('problem-hints').value = Array.isArray(problem.hints) ? problem.hints.join('\n') : '';
      document.getElementById('problem-python-judge-mode').value = problem.pythonJudgeMode === 'function' ? 'function' : 'standard';
      document.getElementById('problem-python-function-signature').value = problem.pythonFunction?.signature || '';
      window.AdminSchedule.set('problem', problem.availability || { enabled: false, windows: [], afterEndView: 'none' });
      this.updatePythonJudgeModeFields();

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
      if (requestedGroup !== this.group) return;
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
    const idMatch = rawTitle.match(/\b(?:P\d{3,6}|T\d{3})\b/i);
    const id = idMatch?.[0]?.toUpperCase() || '';
    const title = titleInfo.title
      .replace(/\b(?:P\d{3,6}|T\d{3})\b/i, '')
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
      // 只解除 Markdown 标点转义，兼容被重复转义的 \\#，并保留 \le、\dots 等 LaTeX 命令。
      .replace(/\\+([#*_`~.>\-])/g, '$1');
  }

  parseMarkdownSections(source) {
    const lines = source.split('\n');
    const markers = [];
    let offset = 0;
    lines.forEach(line => {
      const trimmed = line.trim();
      const headingMatch = trimmed.match(/^#{1,6}\s+(.+?)\s*#*$/);
      const standalone = trimmed.match(/^(?:\*\*|__)(.+?)(?:\*\*|__)$/);
      const inlineBold = trimmed.match(/^(?:\*\*|__)\s*(.+?)\s*(?:\*\*|__)\s*(?:[：:]\s*)?(.*)$/);
      const plain = trimmed.match(/^(题目描述|问题描述|题意|输入格式?|输出格式?|样例输入|样例输出|说明(?:\/提示)?|解题提示|提示|数据范围|限制|约束)\s*[：:]?$/i);
      const candidate = headingMatch?.[1] || standalone?.[1] || inlineBold?.[1] || plain?.[1];
      if (candidate && this.isProblemSectionTitle(candidate)) {
        markers.push({
          title: this.cleanMarkdownHeading(candidate),
          start: offset + line.length + 1,
          lineStart: offset,
          inlineContent: inlineBold?.[2]?.trim() || '',
        });
      }
      offset += line.length + 1;
    });
    return markers.map((marker, index) => ({
      title: marker.title,
      content: [
        marker.inlineContent,
        source.slice(marker.start, markers[index + 1]?.lineStart ?? source.length).trim(),
      ].filter(Boolean).join('\n').trim(),
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
      && (/题目|问题/.test(firstLine) || /^(?:P\d{3,6}|T\d{3})\b/i.test(firstLine));
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

    // 兼容 “**样例输入 1** 10 5 15” 这类标题和内容在同一行的写法。
    const inlinePattern = /^\s*(?:#{1,6}\s*)?(?:\*\*|__)?\s*(?:(?:样例|示例)\s*(输入|输出)|(输入|输出)\s*(?:样例|示例))\s*#?\s*(\d+)?\s*(?:\*\*|__)?\s*(?:[：:]\s*)?(.+?)\s*$/gmi;
    const inlineCounters = { input: 0, output: 0 };
    while ((match = inlinePattern.exec(source)) !== null) {
      const type = (match[1] || match[2]) === '输入' ? 'input' : 'output';
      inlineCounters[type] += 1;
      const number = match[3] || String(inlineCounters[type]);
      if (!blocks.has(number)) blocks.set(number, { input: '', output: '' });
      if (!blocks.get(number)[type]) blocks.get(number)[type] = match[4].trim();
    }
    return Array.from(blocks.values()).filter(sample => sample.input || sample.output);
  }

  parseMarkdownSampleExplanation(source) {
    const lines = source.split('\n');
    const heading = /^\s*(?:#{1,6}\s*)?(?:\*\*|__)?\s*(?:样例|示例)(?:解释|说明)\s*#?\s*(\d+)?\s*(?:\*\*|__)?\s*(?:[：:]\s*)?(.*)$/i;
    const explanations = [];
    let current = null;

    lines.forEach(line => {
      const match = line.match(heading);
      if (match) {
        current = { number: match[1] || String(explanations.length + 1), lines: match[2] ? [match[2]] : [] };
        explanations.push(current);
        return;
      }
      if (current) {
        const trimmed = line.trim();
        const sectionHeading = trimmed.match(/^#{1,6}\s+(.+?)\s*#*$/)?.[1]
          || trimmed.match(/^(?:\*\*|__)\s*(.+?)\s*(?:\*\*|__)(?:\s+.*)?$/)?.[1];
        if (sectionHeading && this.isProblemSectionTitle(sectionHeading)) {
          current = null;
          return;
        }
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
    const testSectionHeading = /^\s*(?:#{1,6}\s*)?(?:\*\*|__)?\s*测试点\s*(?:\*\*|__)?\s*#*\s*$/mi.exec(normalized);
    const scopedSource = testSectionHeading
      ? normalized.slice(testSectionHeading.index + testSectionHeading[0].length)
      : normalized;

    // 兼容 Markdown 表格测试点。单元格中相邻的行内代码会按多行拼接，
    // 例如 `6``1 1 1 0 0 0` 会还原为 "6\n1 1 1 0 0 0"。
    const tableLines = scopedSource.split('\n').map(line => {
      // 某些聊天软件会把 Markdown 表格的每个竖线都转义成 \|。
      const escapedPipes = line.match(/\\\|/g)?.length || 0;
      if (escapedPipes >= 2) return line.replace(/\\\|/g, '|');
      // 也兼容只有行首竖线被转义、其余分隔符未转义的文本。
      return line.replace(/^(\s*)\\\|/, '$1|');
    });
    for (let index = 0; index < tableLines.length - 2; index += 1) {
      const headers = this.splitMarkdownTableRow(tableLines[index]);
      const separators = this.splitMarkdownTableRow(tableLines[index + 1]);
      if (headers.length < 3 || separators.length !== headers.length
        || !separators.every(cell => /^:?-{3,}:?$/.test(cell.trim()))) continue;

      const normalizedHeaders = headers.map(cell => this.normalizeSectionTitle(cell));
      const numberIndex = normalizedHeaders.findIndex(cell => cell === '#' || cell === '序号' || cell === '编号');
      const inputIndex = normalizedHeaders.findIndex(cell => cell === '输入' || cell === '测试点输入');
      const outputIndex = normalizedHeaders.findIndex(cell => cell === '输出' || cell === '测试点输出' || cell === '期望输出');
      if (inputIndex < 0 || outputIndex < 0) continue;

      let fallbackNumber = blocks.size + 1;
      for (let rowIndex = index + 2; rowIndex < tableLines.length; rowIndex += 1) {
        if (!tableLines[rowIndex].trim().startsWith('|')) break;
        const cells = this.splitMarkdownTableRow(tableLines[rowIndex]);
        if (cells.length !== headers.length) break;
        const rawNumber = numberIndex >= 0 ? cells[numberIndex].replace(/[`*_\s]/g, '') : '';
        const number = /^\d+$/.test(rawNumber) ? rawNumber : String(fallbackNumber);
        fallbackNumber += 1;
        const input = this.markdownTableCellValue(cells[inputIndex]);
        const output = this.markdownTableCellValue(cells[outputIndex]);
        if (input || output) blocks.set(number, { input, output });
        index = rowIndex;
      }
    }

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

  splitMarkdownTableRow(line) {
    const value = String(line || '').trim();
    if (!value.startsWith('|')) return [];
    const cells = [];
    let cell = '';
    let inCode = false;
    for (let index = 1; index < value.length; index += 1) {
      const character = value[index];
      if (character === '`' && value[index - 1] !== '\\') inCode = !inCode;
      if (character === '|' && !inCode) {
        cells.push(cell.trim());
        cell = '';
      } else {
        cell += character;
      }
    }
    if (cell.trim()) cells.push(cell.trim());
    return cells;
  }

  markdownTableCellValue(cell) {
    const value = String(cell || '')
      .replace(/<br\s*\/?>/gi, '\n')
      .trim();
    const codeParts = [];
    const codePattern = /`([^`]*)`/g;
    let match;
    while ((match = codePattern.exec(value)) !== null) codeParts.push(match[1].trim());
    if (codeParts.length) return codeParts.join('\n');
    return value
      .replace(/^\s*(?:\*\*|__)/, '')
      .replace(/(?:\*\*|__)\s*$/, '')
      .replace(/\\\|/g, '|')
      .trim();
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
      status: document.getElementById('problem-status').value,
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
      hintsDefaultExpanded: document.getElementById('problem-hints-default-expanded').checked,
      hints: document.getElementById('problem-hints').value.split('\n').map(item => item.trim()).filter(Boolean),
      pythonJudgeMode: document.getElementById('problem-python-judge-mode').value,
      pythonFunctionSignature: document.getElementById('problem-python-function-signature').value,
      availability: window.AdminSchedule.get('problem'),
    };

    const saveButton = document.getElementById('save-problem');
    const status = document.getElementById('problem-save-status');
    const isEditing = Boolean(this.editingProblem);
    saveButton.disabled = true;
    saveButton.textContent = '正在保存...';
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
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: isEditing ? 'update_problem' : 'create_problem',
          group: this.group,
          file: document.getElementById('problem-file').value,
          problem,
          images,
        }),
      });
      const result = await response.json().catch(() => ({}));
      if (response.status === 401) this.lockExpiredSession();
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
        ? result.testCasesChanged
          ? `${result.problem.id} 测试点已更新；已加入自动重判：普通提交 ${result.rejudge?.problemSubmissions || 0} 份，套卷提交 ${result.rejudge?.examSubmissions || 0} 份`
          : `${result.problem.id} 题面已更新；测试点未变化，不触发重判`
        : result.problem.status === 'draft'
          ? `${result.problem.id} 已保存为草稿，仅管理员可见`
          : `${result.problem.id} 已发布，前台将在 GitHub Pages 更新后显示`);
      const examContext = this.problemEditorContext;
      this.editingProblem = null;
      this.setProblemEditorMode(false);
      this.resetProblemEditor();
      document.getElementById('problem-editor').hidden = true;
      if (examContext) this.finishExamProblemEditor(result.problem);
    } catch (error) {
      status.textContent = error instanceof TypeError
        ? '无法连接 Worker，请检查网络后重试'
        : error.message;
    } finally {
      saveButton.disabled = false;
      saveButton.textContent = this.editingProblem ? '保存修改' : '保存题目';
    }
  }

  async previewProblem(file) {
    const url = new URL('index.html', location.href);
    url.searchParams.set('adminPreviewProblem', file);
    url.searchParams.set('group', this.group);
    const preview = window.open(url.href, '_blank');
    if (preview) preview.opener = null;
    else this.toast('浏览器拦截了预览窗口，请允许本站打开新窗口');
  }

  problemTemplate(languageId, problem) {
    return typeof window.getProblemLanguageTemplate === 'function'
      ? window.getProblemLanguageTemplate(languageId, problem)
      : (window.LANGUAGES?.find(language => language.id === languageId)?.template || '');
  }

  async handlePreviewAction(event) {
    const sampleButton = event.target.closest('[data-preview-sample]');
    if (sampleButton) {
      const samples = Array.isArray(this.previewProblemData?.samples) && this.previewProblemData.samples.length
        ? this.previewProblemData.samples
        : [{ input: this.previewProblemData?.sampleInput || '' }];
      const input = document.querySelector('[data-preview-input]');
      if (input) input.value = samples[Number(sampleButton.dataset.previewSample)]?.input || '';
      return;
    }
    const runButton = event.target.closest('[data-preview-run]');
    const submitButton = event.target.closest('[data-preview-submit]');
    if (!runButton && !submitButton) return;
    const problem = this.previewProblemData;
    if (!problem) return;
    const body = document.getElementById('admin-preview-body');
    const language = body.querySelector('[data-preview-language]').value;
    const code = body.querySelector('[data-preview-code]').value;
    const input = body.querySelector('[data-preview-input]').value;
    const output = body.querySelector('[data-preview-output]');
    const detail = body.querySelector('[data-preview-judge-detail]');
    const button = runButton || submitButton;
    if (!code.trim()) {
      output.textContent = '请先填写代码';
      return;
    }
    button.disabled = true;
    output.textContent = runButton ? '正在运行...' : '正在判题...';
    detail.innerHTML = '';
    try {
      const payload = runButton
        ? {
          type: 'admin_execute',
          script: code,
          stdin: input,
          languageId: window.LANGUAGES.find(item => item.id === language)?.judge0LanguageId,
        }
        : {
          type: 'judge_preview',
          username: '管理员预览',
          problemId: problem.id,
          group: this.group,
          language,
          code,
        };
      const response = await fetch(this.config.workerUrl, {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      });
      const result = await response.json().catch(() => ({}));
      if (response.status === 401) this.lockExpiredSession();
      if (!response.ok) throw new Error(result.error || `请求失败 (${response.status})`);
      if (runButton) {
        output.textContent = result.compileError || result.exitCode !== 0
          ? (result.error || result.status || '运行失败')
          : (result.output || '（程序没有输出）');
      } else {
        output.textContent = result.passed
          ? `✅ 全部通过（${result.passedTests}/${result.totalTests}）`
          : `❌ 未通过（${result.passedTests}/${result.totalTests}）`;
        detail.innerHTML = `<div class="preview-judge-list">${(result.results || []).map(item => `<div class="${item.passed ? 'success' : 'error'}"><strong>测试点 ${this.escape(item.index)}：${item.passed ? '通过' : '未通过'}</strong><span>${this.escape(item.time ?? '—')}ms</span>${item.message ? `<p>${this.escape(item.message)}</p>` : ''}${typeof item.input === 'string' ? `<pre>输入：\n${this.escape(item.input)}</pre>` : ''}${typeof item.actualOutput === 'string' ? `<pre>实际输出：\n${this.escape(item.actualOutput)}</pre>` : ''}</div>`).join('')}</div>`;
      }
    } catch (error) {
      output.textContent = `失败：${error.message}`;
    } finally {
      button.disabled = false;
    }
  }

  renderMarkdown(value) {
    const source = String(value || '');
    if (!window.marked || !window.DOMPurify) return `<p>${this.escape(source).replace(/\n/g, '<br>')}</p>`;
    try {
      return window.DOMPurify.sanitize(window.marked.parse(source, { gfm: true, breaks: true }), {
        USE_PROFILES: { html: true },
        FORBID_TAGS: ['style', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'textarea', 'select', 'option'],
        FORBID_ATTR: ['style'],
        ALLOW_DATA_ATTR: false,
      });
    } catch {
      return `<p>${this.escape(source).replace(/\n/g, '<br>')}</p>`;
    }
  }

  enhancePreview(container) {
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
    if (window.hljs) container.querySelectorAll('pre code').forEach(block => window.hljs.highlightElement(block));
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

  showPreview(title, html) {
    const preview = document.getElementById('admin-preview');
    const body = document.getElementById('admin-preview-body');
    document.getElementById('admin-preview-title').textContent = title;
    body.innerHTML = html;
    preview.hidden = false;
    document.body.classList.add('preview-open');
    this.enhancePreview(body);
  }

  closePreview() {
    document.getElementById('admin-preview').hidden = true;
    document.getElementById('admin-preview-body').innerHTML = '';
    document.body.classList.remove('preview-open');
    this.previewProblemData = null;
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
        <td><div class="submission-actions"><button type="button" class="table-link table-link-button" data-rejudge-submission="${this.escape(item.id)}">重新判题</button><button type="button" class="table-link table-link-button warning" data-request-resubmission="${this.escape(item.id)}">要求重新提交</button></div></td>
      </tr>
    `).join('') : '<tr><td colspan="8" class="empty-cell">没有符合条件的提交</td></tr>';
  }

  async handleSubmissionAction(event) {
    const rejudge = event.target.closest('[data-rejudge-submission]');
    const request = event.target.closest('[data-request-resubmission]');
    if (!rejudge && !request) return;
    const submissionId = Number((rejudge || request).dataset[rejudge ? 'rejudgeSubmission' : 'requestResubmission']);
    const submission = this.submissions.find(item => Number(item.id) === submissionId);
    if (!submission) return;
    if (request && !confirm(`确定要求“${submission.username}”重新提交 ${submission.problemId} 吗？学生登录后会看到提醒。`)) return;
    const button = rejudge || request;
    button.disabled = true;
    try {
      const response = await fetch(this.config.workerUrl, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: rejudge ? 'admin_rejudge_submission' : 'admin_request_resubmission',
          submissionKind: 'problem',
          submissionId,
        }),
      });
      const result = await response.json().catch(() => ({}));
      if (response.status === 401) this.lockExpiredSession();
      if (!response.ok) throw new Error(result.error || `操作失败 (${response.status})`);
      this.toast(rejudge ? '已加入自动重判队列' : '已向该学生发送重新提交通知');
    } catch (error) {
      this.toast(`操作失败：${error.message}`);
    } finally {
      button.disabled = false;
    }
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
    link.download = `oj-submissions-${this.group}-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
    this.toast(`已导出 ${this.filteredSubmissions.length} 条记录`);
  }

  async messageRequest(type, payload = {}) {
    const response = await fetch(this.config.workerUrl, {
      method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, ...payload }),
    });
    const result = await response.json().catch(() => ({}));
    if (response.status === 401) this.lockExpiredSession();
    if (!response.ok) throw new Error(result.error || `消息操作失败 (${response.status})`);
    return result;
  }

  async loadAdminMessages() {
    const container = document.getElementById('admin-message-list');
    container.innerHTML = '<p class="empty-cell">正在读取消息...</p>';
    try {
      this.systemMessages = await this.messageRequest('admin_message_list');
      container.innerHTML = this.systemMessages.length ? this.systemMessages.map(message => `
        <article class="admin-message-item">
          <header><div><strong>${this.escape(message.title)}</strong><span>${message.audience === 'all' ? '全体学生' : `发送给 ${this.escape(message.username)}`} · ${message.popupEnabled ? '弹窗提醒' : '仅消息中心'}</span></div><button type="button" class="table-link table-link-button warning" data-delete-message="${this.escape(message.id)}">删除</button></header>
          <p>${this.escape(message.content).replace(/\n/g, '<br>')}</p>
          <footer><span>${this.formatDate(message.createdAt)}</span><span>${this.escape(message.readCount)} 人已读</span></footer>
        </article>`).join('') : '<p class="empty-cell">还没有发布消息</p>';
    } catch (error) {
      container.innerHTML = `<p class="empty-cell">${this.escape(error.message)}</p>`;
    }
  }

  async publishAdminMessage(event) {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    const button = document.getElementById('admin-message-submit');
    const status = document.getElementById('admin-message-status');
    const audience = document.getElementById('admin-message-audience').value;
    button.disabled = true;
    status.textContent = '正在发布...';
    try {
      await this.messageRequest('admin_message_create', {
        audience,
        username: audience === 'user' ? document.getElementById('admin-message-username').value.trim() : '',
        title: document.getElementById('admin-message-title').value,
        content: document.getElementById('admin-message-content').value,
        popupEnabled: document.getElementById('admin-message-popup').checked,
      });
      status.textContent = '发布成功';
      document.getElementById('admin-message-title').value = '';
      document.getElementById('admin-message-content').value = '';
      await this.loadAdminMessages();
      this.toast('消息已发布');
    } catch (error) {
      status.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  }

  async deleteAdminMessage(event) {
    const button = event.target.closest('[data-delete-message]');
    if (!button || !confirm('确定删除这条消息吗？学生端也会立即看不到。')) return;
    button.disabled = true;
    try {
      await this.messageRequest('admin_message_delete', { messageId: Number(button.dataset.deleteMessage) });
      await this.loadAdminMessages();
      this.toast('消息已删除');
    } catch (error) {
      this.toast(`删除失败：${error.message}`);
      button.disabled = false;
    }
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
