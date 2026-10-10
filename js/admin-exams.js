class ExamAdmin {
  constructor() {
    this.exams = [];
    this.editingPaper = null;
    this.paper = null;
    this.submissions = [];
    this.studentIndex = -1;
    this.loadedGroup = '';
    this.pendingImportedProblems = [];
    this.rosterWorkbook = null;
    this.rosterExportName = '';
    this.refreshing = false;
    this.gradingDirty = false;
    this.highConfidenceChecked = new Set();
    this.lastRefreshAt = 0;
    this.studentSort = 'submitted_asc';
  }

  init() {
    window.AdminSchedule.bind('exam');
    document.getElementById('show-exam-editor').addEventListener('click', () => this.newExam());
    document.getElementById('close-exam-editor').addEventListener('click', () => this.closeEditor());
    document.getElementById('add-exam-question').addEventListener('click', () => this.addQuestion());
    document.getElementById('exam-editor').addEventListener('submit', event => this.saveExam(event));
    document.getElementById('exam-question-editor').addEventListener('click', event => this.handleEditorClick(event));
    document.getElementById('exam-question-editor').addEventListener('change', event => this.handleEditorChange(event));
    document.getElementById('import-exam-markdown').addEventListener('click', () => this.importExamMarkdown());
    document.getElementById('exam-import-file').addEventListener('change', event => this.readExamMarkdownFile(event.target.files?.[0]));
    document.getElementById('export-current-exam').addEventListener('click', () => this.exportCurrentExam());
    document.getElementById('exam-roster-file').addEventListener('change', event => this.importRosterAccounts(event.target));
    document.getElementById('download-exam-roster').addEventListener('click', () => this.downloadRosterWorkbook());
    document.getElementById('revoke-exam-user').addEventListener('click', () => this.revokeExamAccess(false));
    document.getElementById('revoke-exam-all').addEventListener('click', () => this.revokeExamAccess(true));
    document.getElementById('exam-admin-list').addEventListener('click', event => this.handleListClick(event));
    document.getElementById('show-exam-grading').addEventListener('click', () => this.showGrading());
    document.getElementById('back-to-exams').addEventListener('click', () => this.showManager());
    document.getElementById('grading-exam').addEventListener('change', event => this.loadGrading(event.target.value));
    document.getElementById('grading-mode').addEventListener('change', () => this.renderGrading());
    document.getElementById('grading-part').addEventListener('change', () => this.renderGrading());
    document.getElementById('run-ai-grading').addEventListener('click', () => this.runAiGrading());
    document.getElementById('adopt-all-ai').addEventListener('click', () => this.adoptAllAiSuggestions(false));
    document.getElementById('adopt-all-ai-feedback').addEventListener('click', () => this.adoptAllAiSuggestions(true));
    document.getElementById('delete-all-ai').addEventListener('click', () => this.deleteAllAiSuggestions());
    document.getElementById('adopt-all-ai-toggle').addEventListener('click', event => this.toggleGradingMenu(event.currentTarget));
    document.getElementById('clear-part-score').addEventListener('click', () => this.clearPartGrading('score'));
    document.getElementById('clear-part-feedback').addEventListener('click', () => this.clearPartGrading('feedback'));
    document.getElementById('clear-part-grading-toggle').addEventListener('click', event => this.toggleGradingMenu(event.currentTarget));
    document.getElementById('check-claude-helper').addEventListener('click', () => this.checkClaudeHelper());
    document.getElementById('export-ai-grading').addEventListener('click', () => this.exportAiGrading());
    document.getElementById('import-ai-grading-file').addEventListener('change', event => this.importAiGrading(event.target));
    document.getElementById('grading-student-list').addEventListener('click', event => {
      const button = event.target.closest('[data-grading-student]');
      if (button) this.selectStudent(Number(button.dataset.gradingStudent));
    });
    document.getElementById('grading-student-sort').addEventListener('change', event => {
      this.studentSort = event.target.value;
      this.sortSubmissionsPreservingSelection();
      this.renderStudentList();
    });
    document.getElementById('grading-workspace').addEventListener('click', event => this.handleGradingClick(event));
    document.getElementById('grading-workspace').addEventListener('input', event => {
      if (event.target.matches('[data-grade-score], [data-grade-feedback]')) this.gradingDirty = true;
    });
    document.getElementById('grading-prev').addEventListener('click', () => this.selectStudent(this.studentIndex - 1));
    document.getElementById('grading-next').addEventListener('click', () => this.selectStudent(this.studentIndex + 1));
    document.addEventListener('click', event => {
      if (!event.target.closest('.grading-split-action')) this.closeGradingMenus();
    });
    document.getElementById('admin-preview-body').addEventListener('click', event => {
      if (event.target.closest('[data-exam-preview-submit]')) this.submitExamPreview();
    });
    document.getElementById('admin-preview-body').addEventListener('change', event => {
      if (!event.target.matches('[data-exam-preview-language]')) return;
      const code = event.target.closest('.exam-programming')?.querySelector('[data-exam-preview-code]');
      const partId = event.target.dataset.examPreviewAnswer;
      const part = this.previewPaper?.questions.flatMap(question => question.parts).find(item => item.id === partId);
      if (code && !code.value.trim()) code.value = this.languageTemplate(event.target.value, part);
    });
    document.querySelector('[data-panel="exams"]').addEventListener('click', () => this.ensureLoaded(true, this.loadedGroup === this.group));
    setInterval(() => this.autoRefresh(), 120000);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) this.autoRefresh();
    });
    window.addEventListener('focus', () => this.autoRefresh());
  }

  get admin() { return window.ojAdmin; }
  get group() { return this.admin?.group || 'control'; }

  async autoRefresh() {
    if (document.hidden || this.refreshing || !this.admin || document.body.classList.contains('auth-locked')) return;
    if (Date.now() - this.lastRefreshAt < 5000) return;
    if (!document.getElementById('panel-exams').classList.contains('active')) return;
    this.refreshing = true;
    this.lastRefreshAt = Date.now();
    try {
      const gradingVisible = !document.getElementById('exam-grading-view').hidden;
      const examId = document.getElementById('grading-exam').value;
      if (gradingVisible && examId) {
        if (!this.gradingDirty) await this.loadGrading(examId, { silent: true, preserveSelection: true });
      } else if (document.getElementById('exam-editor').hidden) {
        await this.ensureLoaded(true, true);
      }
    } catch {
      // 静默刷新失败时保留当前内容，下次自动重试。
    } finally {
      this.refreshing = false;
    }
  }

  async request(type, payload = {}) {
    const response = await fetch(this.admin.config.workerUrl, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, group: this.group, ...payload }),
    });
    const result = await response.json().catch(() => ({}));
    if (response.status === 401) this.admin.lockExpiredSession();
    if (!response.ok) throw new Error(result.error || `请求失败 (${response.status})`);
    return result;
  }

  async ensureLoaded(force = false, silent = false) {
    if (!this.admin || document.body.classList.contains('auth-locked')) return;
    if (!force && this.loadedGroup === this.group && this.exams.length) return;
    const requestedGroup = this.group;
    const tbody = document.getElementById('exam-admin-list');
    if (!silent) tbody.innerHTML = '<tr><td colspan="8" class="empty-cell">正在读取...</td></tr>';
    try {
      const exams = await this.request('admin_exam_list');
      if (this.group !== requestedGroup) return;
      if (silent && JSON.stringify(exams) === JSON.stringify(this.exams)) {
        this.loadedGroup = this.group;
        return;
      }
      this.exams = exams;
      this.loadedGroup = this.group;
      this.renderList();
      this.populateExamSelector();
      this.admin?.populateTimedExtensionResources();
    } catch (error) {
      if (!silent) tbody.innerHTML = `<tr><td colspan="8" class="empty-cell">${this.escape(error.message)}</td></tr>`;
    }
  }

  onGroupChange() {
    this.loadedGroup = '';
    this.exams = [];
    this.paper = null;
    this.submissions = [];
    this.closeEditor();
    this.showManager();
    if (document.getElementById('panel-exams').classList.contains('active')) this.ensureLoaded(true);
  }

  renderList() {
    const tbody = document.getElementById('exam-admin-list');
    tbody.innerHTML = this.exams.length ? this.exams.map(exam => `
      <tr>
        <td>${this.escape(exam.id)}</td>
        <td>${this.escape(exam.title)}</td>
        <td><span class="result-pill ${exam.status === 'published' ? 'accepted' : 'failed'}">${exam.status === 'published' ? '已发布' : '草稿'}</span></td>
        <td>${this.escape(exam.total_score)}</td>
        <td>${this.escape(exam.view_students || 0)}</td>
        <td>${this.escape(exam.submitted_students || 0)}</td>
        <td>${this.escape(exam.completed_students || 0)}</td>
        <td><button type="button" class="table-link table-link-button" data-preview-exam="${this.escape(exam.id)}">预览</button> · <button type="button" class="table-link table-link-button" data-edit-exam="${this.escape(exam.id)}">编辑</button> · <button type="button" class="table-link table-link-button" data-grade-exam="${this.escape(exam.id)}">批改</button></td>
      </tr>`).join('') : '<tr><td colspan="8" class="empty-cell">当前组别还没有套卷</td></tr>';
  }

  populateExamSelector() {
    const select = document.getElementById('grading-exam');
    const current = select.value;
    select.innerHTML = '<option value="">选择试卷</option>' + this.exams.map(exam =>
      `<option value="${this.escape(exam.id)}">${this.escape(exam.id)} · ${this.escape(exam.title)}</option>`
    ).join('');
    if (this.exams.some(exam => exam.id === current)) select.value = current;
  }

  newExam() {
    this.editingPaper = {
      id: '', title: '', description: '', status: 'draft', resultPolicy: 'after_graded',
      allowedUsers: [],
      availability: { enabled: false, windows: [], afterEndView: 'none' },
      serialNo: this.nextExamSerial(),
      questions: [this.emptyQuestion(1)],
    };
    this.renderEditor();
    document.getElementById('exam-id').disabled = false;
    document.getElementById('exam-editor-title').textContent = '新建套卷';
    document.getElementById('exam-editor').hidden = false;
    document.getElementById('exam-editor').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  emptyQuestion(index) {
    return {
      id: `Q${index}`, title: `第 ${index} 题`, description: '', scoringMode: 'independent',
      parts: [this.emptyPart(`Q${index}`, 1, 'single_choice')],
    };
  }

  emptyPart(questionId, index, type) {
    return {
      id: `${questionId}_${index}`,
      type,
      prompt: '',
      points: 10,
      options: type.includes('choice') ? ['选项 A', '选项 B'] : undefined,
      correctAnswers: type.includes('choice') ? ['选项 A'] : type === 'fill_blank' ? [''] : undefined,
      caseSensitive: false,
      gradingGuide: type === 'fill_blank' || type === 'short_answer' ? '' : undefined,
      problemId: type === 'programming' ? '' : undefined,
    };
  }

  nextExamSerial() {
    const used = this.exams.map(exam => Number(exam.serial_no || exam.serialNo || 0)).filter(Number.isInteger);
    const next = Math.max(0, ...used) + 1;
    return next <= 99 ? next : 0;
  }

  async editExam(id) {
    try {
      this.editingPaper = await this.request('admin_exam_get', { examId: id });
      this.renderEditor();
      document.getElementById('exam-id').disabled = true;
      document.getElementById('exam-editor-title').textContent = `编辑 ${id}`;
      document.getElementById('exam-editor').hidden = false;
      document.getElementById('exam-editor').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (error) {
      this.admin.toast(`读取试卷失败：${error.message}`);
    }
  }

  closeEditor() {
    document.getElementById('exam-editor').hidden = true;
    this.editingPaper = null;
  }

  renderEditor() {
    const paper = this.editingPaper;
    document.getElementById('exam-id').value = paper.id || '';
    document.getElementById('exam-title').value = paper.title || '';
    document.getElementById('exam-description').value = paper.description || '';
    document.getElementById('exam-status').value = paper.status || 'draft';
    document.getElementById('exam-result-policy').value = paper.resultPolicy || 'after_graded';
    window.AdminSchedule.set('exam', paper.availability || { enabled: false, windows: [], afterEndView: 'none' });
    document.getElementById('exam-roster-users').value = (paper.allowedUsers || []).join('\n');
    document.getElementById('exam-roster-status').textContent = paper.allowedUsers?.length
      ? `当前已额外准入 ${paper.allowedUsers.length} 人，可继续追加导入`
      : '已有密码保持不变；仅无密码账号生成随机密码；可多次追加导入';
    document.getElementById('download-exam-roster').disabled = true;
    document.getElementById('exam-revoke-username').value = '';
    document.getElementById('exam-access-status').textContent = paper.managedDefaultAllowed === false
      ? '正式注册账号的默认权限已撤销；只有当前额外名单中的学生可以进入。'
      : '';
    this.rosterWorkbook = null;
    document.getElementById('exam-editor-title').dataset.serialNo = String(paper.serialNo || this.nextExamSerial());
    document.getElementById('exam-save-status').textContent = '';
    document.getElementById('exam-question-editor').innerHTML = paper.questions.map((question, index) => this.questionHtml(question, index)).join('');
  }

  questionHtml(question, questionIndex) {
    return `<article class="exam-question-card" data-question-index="${questionIndex}">
      <div class="exam-question-heading"><strong>大题 ${questionIndex + 1}</strong><button type="button" class="remove-test-case" data-remove-question="${questionIndex}" title="删除大题">×</button></div>
      <div class="form-grid three-columns">
        <label class="form-field"><span>大题编号</span><input class="admin-input" data-q-field="id" value="${this.escape(question.id)}"></label>
        <label class="form-field"><span>大题标题</span><input class="admin-input" data-q-field="title" value="${this.escape(question.title)}"></label>
        <label class="form-field"><span>评分模式</span><select class="admin-input" data-q-field="scoringMode"><option value="independent" ${question.scoringMode !== 'programming_required' ? 'selected' : ''}>各小题独立得分</option><option value="programming_required" ${question.scoringMode === 'programming_required' ? 'selected' : ''}>编程正确整题才得分</option></select></label>
      </div>
      <label class="form-field"><span>大题说明</span><textarea class="admin-input" rows="3" data-q-field="description">${this.escape(question.description || '')}</textarea></label>
      <div class="exam-part-list">${question.parts.map((part, partIndex) => this.partHtml(part, questionIndex, partIndex)).join('')}</div>
      <div class="exam-add-part"><select class="admin-input" data-new-part-type><option value="single_choice">单选题</option><option value="multiple_choice">多选题</option><option value="fill_blank">填空题</option><option value="short_answer">简答题</option><option value="programming">编程题</option></select><button type="button" class="admin-button secondary" data-add-part="${questionIndex}">＋ 添加小题</button></div>
    </article>`;
  }

  partHtml(part, questionIndex, partIndex) {
    const isChoice = part.type === 'single_choice' || part.type === 'multiple_choice';
    const typeNames = { single_choice: '单选题', multiple_choice: '多选题', fill_blank: '填空题', short_answer: '简答题', programming: '编程题' };
    const problemOptions = this.admin.problems.map(problem => `<option value="${this.escape(problem.id)}" ${problem.id === part.problemId ? 'selected' : ''}>${this.escape(problem.id)} · ${this.escape(problem.title)}${problem.status === 'draft' ? '（草稿）' : ''}</option>`).join('');
    return `<section class="exam-part-card" data-part-index="${partIndex}">
      <div class="exam-part-heading"><strong>小题 ${partIndex + 1} · ${typeNames[part.type] || '简答题'}</strong><button type="button" class="remove-test-case" data-remove-part="${questionIndex}:${partIndex}" title="删除小题">×</button></div>
      <div class="form-grid three-columns">
        <label class="form-field"><span>小题编号</span><input class="admin-input" data-p-field="id" value="${this.escape(part.id)}"></label>
        <label class="form-field"><span>题型</span><select class="admin-input" data-p-field="type">${Object.entries(typeNames).map(([value, label]) => `<option value="${value}" ${part.type === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
        <label class="form-field"><span>分值</span><input class="admin-input" data-p-field="points" type="number" min="0" max="1000" step="0.01" value="${this.escape(part.points)}"></label>
      </div>
      <label class="form-field"><span>小题内容</span><textarea class="admin-input" rows="3" data-p-field="prompt">${this.escape(part.prompt || '')}</textarea></label>
      ${isChoice ? `<div class="form-grid two-columns"><label class="form-field"><span>选项（每行一个）</span><textarea class="admin-input" rows="4" data-p-field="options">${this.escape((part.options || []).join('\n'))}</textarea></label><label class="form-field"><span>正确答案（每行一个，文字须与选项一致）</span><textarea class="admin-input" rows="4" data-p-field="correctAnswers">${this.escape((part.correctAnswers || []).join('\n'))}</textarea></label></div>` : ''}
      ${part.type === 'fill_blank' ? `<label class="form-field"><span>可接受答案（每行一个）</span><textarea class="admin-input" rows="4" data-p-field="correctAnswers">${this.escape((part.correctAnswers || []).join('\n'))}</textarea></label><label class="test-visibility-option compact"><input type="checkbox" data-p-field="caseSensitive" ${part.caseSensitive ? 'checked' : ''}><span><strong>区分大小写</strong><small>不勾选时会忽略首尾空格和大小写</small></span></label>` : ''}
      ${part.type === 'fill_blank' || part.type === 'short_answer' ? `<label class="form-field"><span>参考答案 / 评分细则（仅管理员与 Claude 可见）</span><textarea class="admin-input" rows="4" data-p-field="gradingGuide" placeholder="建议按评分点写明每项分值、必要条件和可接受表述">${this.escape(part.gradingGuide || '')}</textarea></label>` : ''}
      ${part.type === 'programming' ? `<div class="exam-programming-source"><label class="form-field"><span>关联编程题</span><select class="admin-input" data-p-field="problemId"><option value="">请选择题目</option>${problemOptions}${part.problemId && !this.admin.problems.some(problem => problem.id === part.problemId) ? `<option value="${this.escape(part.problemId)}" selected>${this.escape(part.problemId)} · 待创建</option>` : ''}</select><small>套卷题默认保存为草稿，但发布套卷后仍可正常作答和判题。</small></label><div class="exam-programming-actions"><button type="button" class="admin-button primary" data-create-programming="${questionIndex}:${partIndex}">＋ 使用完整编辑器出题</button>${part.problemId && this.admin.problems.some(problem => problem.id === part.problemId) ? `<button type="button" class="admin-button secondary" data-edit-programming="${questionIndex}:${partIndex}">编辑关联题目</button>` : ''}</div></div>` : ''}
    </section>`;
  }

  syncEditorState() {
    if (!this.editingPaper) return;
    this.editingPaper.id = document.getElementById('exam-id').value.trim().toUpperCase();
    this.editingPaper.title = document.getElementById('exam-title').value.trim();
    this.editingPaper.description = document.getElementById('exam-description').value;
    this.editingPaper.status = document.getElementById('exam-status').value;
    this.editingPaper.resultPolicy = document.getElementById('exam-result-policy').value;
    this.editingPaper.availability = window.AdminSchedule.get('exam');
    this.editingPaper.allowedUsers = [...new Set(document.getElementById('exam-roster-users').value
      .split(/\r?\n/).map(value => value.trim().normalize('NFC')).filter(Boolean))];
    this.editingPaper.serialNo = Number(this.editingPaper.serialNo || document.getElementById('exam-editor-title').dataset.serialNo || this.nextExamSerial());
    document.querySelectorAll('.exam-question-card').forEach((questionNode, questionIndex) => {
      const question = this.editingPaper.questions[questionIndex];
      questionNode.querySelectorAll('[data-q-field]').forEach(input => { question[input.dataset.qField] = input.value; });
      questionNode.querySelectorAll('.exam-part-card').forEach((partNode, partIndex) => {
        const part = question.parts[partIndex];
        partNode.querySelectorAll('[data-p-field]').forEach(input => {
          const field = input.dataset.pField;
          if (field === 'points') part[field] = Number(input.value);
          else if (field === 'caseSensitive') part[field] = input.checked;
          else if (field === 'options' || field === 'correctAnswers') part[field] = input.value.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
          else part[field] = input.value;
        });
      });
    });
  }

  async importRosterAccounts(input) {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    const status = document.getElementById('exam-roster-status');
    const download = document.getElementById('download-exam-roster');
    download.disabled = true;
    try {
      this.syncEditorState();
      if (!this.editingPaper?.id) throw new Error('请先填写试卷编号，再导入额外账户');
      if (!window.XLSX) throw new Error('Excel 组件加载失败，请刷新管理页面后重试');
      if (file.size > 10 * 1024 * 1024) throw new Error('Excel 文件不能超过 10 MB');
      status.textContent = '正在读取 Excel 并检查账号状态...';
      const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true, cellStyles: true });
      const parsed = this.parseRosterWorkbook(workbook);
      if (!parsed.users.length) throw new Error('没有找到“姓名 / 学生姓名 / 名字 / 用户名”列');
      const accountStatus = await this.request('admin_exam_roster_account_status', { usernames: parsed.users.map(item => item.username) });
      const existingPasswordUsers = new Set(accountStatus.passwordUsers || []);
      const accounts = [];
      let generated = 0;
      for (const user of parsed.users) {
        if (existingPasswordUsers.has(user.username)) continue;
        let password = user.password;
        if (!password) {
          password = this.admin.generateStudentPassword();
          generated += 1;
        }
        user.cells.forEach(cell => {
          if (!cell.sheet[cell.passwordAddress]) cell.sheet[cell.passwordAddress] = { t: 's', v: password };
        });
        accounts.push({ username: user.username, ...await this.admin.hashStudentPassword(password) });
      }
      status.textContent = `正在注册并追加 ${parsed.users.length} 个准入账号...`;
      const result = await this.request('admin_exam_roster_import', {
        examId: this.editingPaper.id,
        usernames: parsed.users.map(item => item.username),
        accounts,
      });
      const current = document.getElementById('exam-roster-users').value.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
      const merged = [...new Set([...current, ...parsed.users.map(item => item.username)])];
      document.getElementById('exam-roster-users').value = merged.join('\n');
      this.editingPaper.allowedUsers = merged;
      this.rosterWorkbook = workbook;
      this.rosterExportName = `${file.name.replace(/\.[^.]+$/, '')}-套卷准入账号.xlsx`;
      download.disabled = false;
      status.textContent = `已追加 ${result.added} 人；${existingPasswordUsers.size} 个原密码保持不变，${generated} 个账号生成了新密码。${result.rosterPending ? '保存试卷后名单生效。' : '请保存试卷。'}`;
    } catch (error) {
      this.rosterWorkbook = null;
      status.textContent = `导入失败：${error.message}`;
    }
  }

  async revokeExamAccess(all) {
    const examId = String(this.editingPaper?.id || '').trim().toUpperCase();
    const usernameInput = document.getElementById('exam-revoke-username');
    const username = usernameInput.value.trim().normalize('NFC');
    const status = document.getElementById('exam-access-status');
    if (!examId) {
      status.textContent = '请先保存套卷，再撤销准入权限。';
      return;
    }
    if (!all && !username) {
      status.textContent = '请输入需要撤销权限的学生用户名。';
      usernameInput.focus();
      return;
    }
    const confirmed = confirm(all
      ? `确定撤销“${examId}”当前所有人的准入权限吗？\n\n账号、历史答卷和成绩不会被删除；之后可通过额外名单重新赋权。`
      : `确定撤销“${username}”进入套卷“${examId}”的权限吗？\n\n该学生的历史答卷和成绩不会被删除。`);
    if (!confirmed) return;
    const button = document.getElementById(all ? 'revoke-exam-all' : 'revoke-exam-user');
    button.disabled = true;
    status.textContent = all ? '正在撤销所有人权限...' : '正在撤销该学生权限...';
    try {
      const result = await this.request('admin_exam_access_revoke', { examId, username: all ? undefined : username, all });
      if (all) {
        this.editingPaper.allowedUsers = [];
        this.editingPaper.managedDefaultAllowed = false;
        document.getElementById('exam-roster-users').value = '';
        status.textContent = `已撤销所有人的准入权限；保留了 ${result.preservedSubmissions || 0} 份历史答卷。`;
      } else {
        this.editingPaper.allowedUsers = (this.editingPaper.allowedUsers || []).filter(item => item !== username);
        document.getElementById('exam-roster-users').value = this.editingPaper.allowedUsers.join('\n');
        usernameInput.value = '';
        status.textContent = `已撤销“${username}”的准入权限，历史答卷未删除。`;
      }
      this.admin.toast(all ? '已撤销该套卷所有人的权限' : `已撤销 ${username} 的套卷权限`);
    } catch (error) {
      status.textContent = `撤销失败：${error.message}`;
    } finally {
      button.disabled = false;
    }
  }

  parseRosterWorkbook(workbook) {
    const accountHeaders = new Set(['账号', '登录账号', '用户名', 'account', 'username']);
    const nameHeaders = new Set(['姓名', '学生姓名', '名字', 'name']);
    const passwordHeaders = new Set(['密码', '登录密码', '初始密码', 'password']);
    const users = new Map();
    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName];
      if (!sheet?.['!ref']) continue;
      const range = XLSX.utils.decode_range(sheet['!ref']);
      let headerRow = -1;
      let accountColumn = -1;
      let nameColumn = -1;
      let passwordColumn = -1;
      for (let row = range.s.r; row <= Math.min(range.e.r, range.s.r + 29) && accountColumn < 0 && nameColumn < 0; row += 1) {
        for (let column = range.s.c; column <= range.e.c; column += 1) {
          const value = String(sheet[XLSX.utils.encode_cell({ r: row, c: column })]?.v ?? '').trim().toLowerCase().replace(/[\s:：]/g, '');
          if (accountHeaders.has(value)) accountColumn = column;
          if (nameHeaders.has(value)) nameColumn = column;
          if (passwordHeaders.has(value)) passwordColumn = column;
        }
        if (accountColumn >= 0 || nameColumn >= 0) headerRow = row;
      }
      if (accountColumn >= 0) nameColumn = accountColumn;
      if (nameColumn < 0) continue;
      if (passwordColumn < 0) {
        passwordColumn = range.e.c + 1;
        range.e.c = passwordColumn;
        sheet['!ref'] = XLSX.utils.encode_range(range);
        sheet[XLSX.utils.encode_cell({ r: headerRow, c: passwordColumn })] = { t: 's', v: '密码' };
      }
      for (let row = headerRow + 1; row <= range.e.r; row += 1) {
        const username = String(sheet[XLSX.utils.encode_cell({ r: row, c: nameColumn })]?.v ?? '').trim().normalize('NFC');
        if (!username) continue;
        if (username.length > 50 || /[\u0000-\u001f\u007f]/.test(username)) throw new Error(`“${username}”用户名格式不正确`);
        const passwordAddress = XLSX.utils.encode_cell({ r: row, c: passwordColumn });
        const password = String(sheet[passwordAddress]?.v ?? '').trim();
        if (password.length > 128) throw new Error(`“${username}”的密码超过 128 个字符`);
        const user = users.get(username) || { username, password: '', cells: [] };
        if (password && user.password && password !== user.password) throw new Error(`“${username}”在表格中有不同密码`);
        if (password) user.password = password;
        user.cells.push({ sheet, passwordAddress });
        users.set(username, user);
      }
    }
    return { users: [...users.values()] };
  }

  downloadRosterWorkbook() {
    if (!this.rosterWorkbook) return;
    XLSX.writeFile(this.rosterWorkbook, this.rosterExportName || '套卷准入账号.xlsx', { compression: true });
  }

  addQuestion() {
    this.syncEditorState();
    this.editingPaper.questions.push(this.emptyQuestion(this.editingPaper.questions.length + 1));
    this.renderEditor();
  }

  handleEditorClick(event) {
    const removeQuestion = event.target.closest('[data-remove-question]');
    const removePart = event.target.closest('[data-remove-part]');
    const addPart = event.target.closest('[data-add-part]');
    const createProgramming = event.target.closest('[data-create-programming]');
    const editProgramming = event.target.closest('[data-edit-programming]');
    if (createProgramming) return this.openProgrammingEditor(createProgramming.dataset.createProgramming, false);
    if (editProgramming) return this.openProgrammingEditor(editProgramming.dataset.editProgramming, true);
    if (!removeQuestion && !removePart && !addPart) return;
    this.syncEditorState();
    if (removeQuestion) {
      if (this.editingPaper.questions.length <= 1) return this.admin.toast('试卷至少保留一道大题');
      this.editingPaper.questions.splice(Number(removeQuestion.dataset.removeQuestion), 1);
    } else if (removePart) {
      const [questionIndex, partIndex] = removePart.dataset.removePart.split(':').map(Number);
      if (this.editingPaper.questions[questionIndex].parts.length <= 1) return this.admin.toast('大题至少保留一个小题');
      this.editingPaper.questions[questionIndex].parts.splice(partIndex, 1);
    } else {
      const questionIndex = Number(addPart.dataset.addPart);
      const questionNode = addPart.closest('.exam-question-card');
      const type = questionNode.querySelector('[data-new-part-type]').value;
      const question = this.editingPaper.questions[questionIndex];
      question.parts.push(this.emptyPart(question.id || `Q${questionIndex + 1}`, question.parts.length + 1, type));
    }
    this.renderEditor();
  }

  handleEditorChange(event) {
    if (event.target.dataset.pField !== 'type') return;
    const questionIndex = Number(event.target.closest('.exam-question-card').dataset.questionIndex);
    const partIndex = Number(event.target.closest('.exam-part-card').dataset.partIndex);
    this.syncEditorState();
    const old = this.editingPaper.questions[questionIndex].parts[partIndex];
    this.editingPaper.questions[questionIndex].parts[partIndex] = { ...this.emptyPart(this.editingPaper.questions[questionIndex].id, partIndex + 1, event.target.value), id: old.id, prompt: old.prompt, points: old.points };
    this.renderEditor();
  }

  nextProgrammingProblemId() {
    const serial = Number(this.editingPaper?.serialNo || this.nextExamSerial());
    if (!Number.isInteger(serial) || serial < 1 || serial > 99) throw new Error('套卷序号不正确');
    const prefix = `T${String(serial).padStart(2, '0')}`;
    const ids = [
      ...this.admin.problems.map(problem => problem.id),
      ...this.editingPaper.questions.flatMap(question => question.parts.map(part => part.problemId || '')),
    ];
    const used = ids.map(id => new RegExp(`^${prefix}(\\d)$`).exec(id)?.[1]).filter(value => value !== undefined).map(Number);
    const index = used.length ? Math.max(...used) + 1 : 0;
    if (index > 9) throw new Error('同一套卷最多自动创建 10 道编程题（编号 0 到 9）');
    return `${prefix}${index}`;
  }

  openProgrammingEditor(position, editing) {
    this.syncEditorState();
    const [questionIndex, partIndex] = position.split(':').map(Number);
    const part = this.editingPaper.questions[questionIndex]?.parts[partIndex];
    if (!part) return;
    const onSaved = problem => {
      const current = this.editingPaper?.questions[questionIndex]?.parts[partIndex];
      if (!current) return;
      current.problemId = problem.id;
      this.renderEditor();
      this.admin.toast(`${problem.id} 已关联到当前套卷小题`);
    };
    if (editing) {
      const problem = this.admin.problems.find(item => item.id === part.problemId);
      if (!problem) return this.admin.toast('关联题目不存在，请刷新题库后重试');
      this.admin.editExamProblemEditor({ file: problem.file, onSaved });
      return;
    }
    try {
      this.admin.startExamProblemEditor({ problemId: this.nextProgrammingProblemId(), onSaved });
    } catch (error) {
      this.admin.toast(error.message);
    }
  }

  async readExamMarkdownFile(file) {
    const status = document.getElementById('exam-import-status');
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) {
      status.textContent = 'Markdown 文件不能超过 8 MB';
      return;
    }
    document.getElementById('exam-import-markdown').value = await file.text();
    status.textContent = `已读取 ${file.name}，点击“解析并自动填入”继续`;
  }

  examExportPayload(paper, problems) {
    const questions = structuredClone(paper.questions);
    questions.forEach(question => question.parts.forEach(part => {
      delete part.problem;
      delete part.pythonFunction;
      delete part.pythonJudgeMode;
    }));
    return {
      format: 'jc-oj-exam-v1',
      paper: {
        title: paper.title,
        description: paper.description || '',
        resultPolicy: paper.resultPolicy || 'after_graded',
        questions,
      },
      problems: problems.map(problem => ({
        originalId: problem.id,
        title: problem.title,
        difficulty: problem.difficulty || 'easy',
        description: problem.description || '',
        inputFormat: problem.inputFormat || '',
        outputFormat: problem.outputFormat || '',
        constraints: problem.constraints || '',
        hints: Array.isArray(problem.hints) ? problem.hints : [],
        samples: Array.isArray(problem.samples) ? problem.samples : [],
        sampleExplanation: problem.sampleExplanation || '',
        testCases: Array.isArray(problem.testCases) ? problem.testCases : [],
        pythonJudgeMode: problem.pythonJudgeMode || 'standard',
        pythonFunctionSignature: problem.pythonFunction?.signature || '',
      })),
    };
  }

  encodeBase64Utf8(value) {
    const bytes = new TextEncoder().encode(value);
    let binary = '';
    for (let index = 0; index < bytes.length; index += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
    }
    return btoa(binary);
  }

  decodeBase64Utf8(value) {
    const binary = atob(value.replace(/\s/g, ''));
    return new TextDecoder().decode(Uint8Array.from(binary, character => character.charCodeAt(0)));
  }

  readableExamMarkdown(payload) {
    const typeNames = { single_choice: '单选题', multiple_choice: '多选题', fill_blank: '填空题', short_answer: '简答题', programming: '编程题' };
    const problemMap = new Map(payload.problems.map(problem => [problem.originalId, problem]));
    const lines = [`# ${payload.paper.title}`, '', payload.paper.description || '', ''];
    payload.paper.questions.forEach((question, questionIndex) => {
      lines.push(`## 第 ${questionIndex + 1} 大题：${question.title}`, '', question.description || '', '');
      question.parts.forEach((part, partIndex) => {
        lines.push(`### ${questionIndex + 1}.${partIndex + 1} ${typeNames[part.type] || '小题'}（${part.points} 分）`, '', part.prompt || '', '');
        if (part.options?.length) lines.push(...part.options.map((option, index) => `- ${String.fromCharCode(65 + index)}. ${option}`), '');
        if (part.correctAnswers?.length) lines.push(`**参考答案：** ${part.correctAnswers.join(' / ')}`, '');
        if (part.gradingGuide) lines.push('**评分细则：**', '', part.gradingGuide, '');
        if (part.type === 'programming') {
          const problem = problemMap.get(part.problemId);
          if (problem) {
            lines.push(`#### 编程题 ${problem.originalId}：${problem.title}`, '', '##### 题目描述', '', problem.description, '', '##### 输入格式', '', problem.inputFormat, '', '##### 输出格式', '', problem.outputFormat, '');
            if (problem.constraints) lines.push('##### 数据范围', '', problem.constraints, '');
            problem.samples.forEach((sample, index) => lines.push(`##### 输入 #${index + 1}`, '', '```text', sample.input, '```', '', `##### 输出 #${index + 1}`, '', '```text', sample.output, '```', ''));
            if (problem.testCases.length) {
              lines.push('##### 测试点（管理员数据）', '');
              problem.testCases.forEach((testCase, index) => lines.push(`输入 #${index + 1}`, '```text', testCase.input, '```', `输出 #${index + 1}`, '```text', testCase.expectedOutput, '```', ''));
            }
          }
        }
      });
    });
    const encoded = this.encodeBase64Utf8(JSON.stringify(payload));
    lines.push('<!-- JC_OJ_EXAM_V1', encoded.match(/.{1,120}/g)?.join('\n') || encoded, 'JC_OJ_EXAM_V1 -->', '', '> 此文件包含参考答案和隐藏测试点，仅供管理员备份与导入，请勿发给学生。', '');
    return lines.join('\n');
  }

  async exportCurrentExam() {
    if (!this.editingPaper) return;
    this.syncEditorState();
    const status = document.getElementById('exam-save-status');
    status.textContent = '正在收集套卷和编程题内容...';
    try {
      const ids = [...new Set(this.editingPaper.questions.flatMap(question => question.parts).filter(part => part.type === 'programming' && part.problemId).map(part => part.problemId))];
      const problems = await Promise.all(ids.map(async id => {
        const indexItem = this.admin.problems.find(problem => problem.id === id);
        if (!indexItem) throw new Error(`找不到关联编程题 ${id}`);
        return await this.admin.fetchJson(`${this.admin.config.workerUrl}/?file=problem&admin=1&name=${encodeURIComponent(indexItem.file)}`);
      }));
      const markdown = this.readableExamMarkdown(this.examExportPayload(this.editingPaper, problems));
      const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `${(this.editingPaper.id || 'exam').toLowerCase()}-${new Date().toISOString().slice(0, 10)}.md`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 1000);
      status.textContent = 'Markdown 已导出（包含答案和隐藏测试点）';
    } catch (error) {
      status.textContent = `导出失败：${error.message}`;
    }
  }

  parseExamMarkdown(source) {
    const match = String(source || '').match(/<!--\s*JC_OJ_EXAM_V1\s+([A-Za-z0-9+/=\s]+?)\s+JC_OJ_EXAM_V1\s*-->/);
    if (!match) throw new Error('没有找到本站套卷数据，请使用管理端导出的 Markdown 标准格式');
    const payload = JSON.parse(this.decodeBase64Utf8(match[1]));
    if (payload?.format !== 'jc-oj-exam-v1' || !payload.paper || !Array.isArray(payload.paper.questions) || !Array.isArray(payload.problems)) {
      throw new Error('套卷 Markdown 数据格式不正确');
    }
    return payload;
  }

  async importExamMarkdown() {
    const status = document.getElementById('exam-import-status');
    const button = document.getElementById('import-exam-markdown');
    button.disabled = true;
    status.textContent = '正在解析套卷...';
    try {
      const payload = this.parseExamMarkdown(document.getElementById('exam-import-markdown').value);
      this.syncEditorState();
      const serialNo = Number(this.editingPaper?.serialNo || this.nextExamSerial());
      const idMap = new Map();
      for (let index = 0; index < payload.problems.length; index += 1) {
        if (index > 9) throw new Error('一张套卷最多导入 10 道编程题');
        const exported = payload.problems[index];
        const id = `T${String(serialNo).padStart(2, '0')}${index}`;
        idMap.set(exported.originalId, id);
        if (this.admin.problems.some(problem => problem.id === id)) continue;
        status.textContent = `正在创建编程题 ${id}（${index + 1}/${payload.problems.length}）...`;
        const problem = { ...exported, id, status: 'draft', showTestDetails: true, hintsDefaultExpanded: true };
        delete problem.originalId;
        const result = await this.request('create_problem', { file: `${id.toLowerCase()}.json`, problem, images: [] });
        this.admin.problems.push(result.problem);
      }
      this.admin.problems.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
      const questions = structuredClone(payload.paper.questions);
      questions.forEach(question => question.parts.forEach(part => {
        if (part.type === 'programming') part.problemId = idMap.get(part.problemId) || part.problemId;
      }));
      this.editingPaper = {
        ...this.editingPaper,
        title: payload.paper.title || this.editingPaper.title,
        description: payload.paper.description || '',
        resultPolicy: payload.paper.resultPolicy || 'after_graded',
        status: 'draft',
        serialNo,
        questions,
      };
      this.admin.renderProblems();
      this.renderEditor();
      document.querySelector('.exam-importer').open = false;
      status.textContent = `已填入 ${questions.length} 道大题和 ${payload.problems.length} 道编程题，请检查后保存套卷`;
      this.admin.toast('套卷 Markdown 已自动填入');
    } catch (error) {
      status.textContent = `导入失败：${error.message}`;
    } finally {
      button.disabled = false;
    }
  }

  async saveExam(event) {
    event.preventDefault();
    this.syncEditorState();
    const status = document.getElementById('exam-save-status');
    status.textContent = '正在保存...';
    try {
      const result = await this.request('admin_exam_save', { paper: this.editingPaper });
      this.editingPaper.serialNo = result.serialNo;
      status.textContent = `保存成功 · 第 ${result.version} 版 · 总分 ${result.totalScore}`;
      this.admin.toast('试卷已保存');
      await this.ensureLoaded(true);
      await this.editExam(result.id);
    } catch (error) {
      status.textContent = error.message;
    }
  }

  async handleListClick(event) {
    const preview = event.target.closest('[data-preview-exam]');
    const edit = event.target.closest('[data-edit-exam]');
    const grade = event.target.closest('[data-grade-exam]');
    if (preview) this.previewExam(preview.dataset.previewExam);
    if (edit) this.editExam(edit.dataset.editExam);
    if (grade) {
      this.showGrading();
      document.getElementById('grading-exam').value = grade.dataset.gradeExam;
      await this.loadGrading(grade.dataset.gradeExam);
    }
  }

  async previewExam(id) {
    const url = new URL('index.html', location.href);
    url.searchParams.set('adminPreviewExam', id);
    url.searchParams.set('group', this.group);
    const preview = window.open(url.href, '_blank');
    if (preview) preview.opener = null;
    else this.admin.toast('浏览器拦截了预览窗口，请允许本站打开新窗口');
  }

  previewPartHtml(part, partIndex, typeNames) {
    let answer = '';
    if (part.type === 'single_choice' || part.type === 'multiple_choice') {
      answer = `<div class="preview-options">${part.options.map(option => `<label><input type="${part.type === 'single_choice' ? 'radio' : 'checkbox'}" name="preview-${this.escape(part.id)}" data-exam-preview-answer="${this.escape(part.id)}" value="${this.escape(option)}"> ${this.escape(option)}</label>`).join('')}</div>`;
    } else if (part.type === 'fill_blank') {
      answer = `<input class="admin-input" data-exam-preview-answer="${this.escape(part.id)}" maxlength="2000" placeholder="填写答案">`;
    } else if (part.type === 'short_answer') {
      answer = `<textarea class="admin-input" data-exam-preview-answer="${this.escape(part.id)}" rows="5" maxlength="30000" placeholder="填写回答"></textarea>`;
    } else if (part.type === 'programming') {
      const language = this.group === 'vision' ? 'python' : 'c';
      answer = `<div class="exam-programming"><div><span>关联题目 ${this.escape(part.problemId)}</span><select data-exam-preview-language data-exam-preview-answer="${this.escape(part.id)}">${window.LANGUAGES.map(item => `<option value="${this.escape(item.id)}" ${item.id === language ? 'selected' : ''}>${this.escape(item.name)}</option>`).join('')}</select></div><textarea data-exam-preview-code="${this.escape(part.id)}" rows="16" spellcheck="false">${this.escape(this.languageTemplate(language, part))}</textarea></div>`;
    }
    return `<section class="preview-exam-part"><div><strong>${partIndex + 1}. ${typeNames[part.type] || '小题'}</strong><span>${this.escape(part.points)} 分</span></div><div class="problem-content">${this.admin.renderMarkdown(part.prompt || '')}</div>${answer}</section>`;
  }

  languageTemplate(languageId, part = null) {
    if (typeof window.getProblemLanguageTemplate === 'function') {
      return window.getProblemLanguageTemplate(languageId, part || {});
    }
    return window.LANGUAGES?.find(language => language.id === languageId)?.template || '';
  }

  collectPreviewAnswers() {
    const answers = {};
    for (const question of this.previewPaper.questions) {
      for (const part of question.parts) {
        const selector = `[data-exam-preview-answer="${CSS.escape(part.id)}"]`;
        if (part.type === 'single_choice') {
          answers[part.id] = document.querySelector(`${selector}:checked`)?.value || '';
        } else if (part.type === 'multiple_choice') {
          answers[part.id] = [...document.querySelectorAll(`${selector}:checked`)].map(input => input.value);
        } else if (part.type === 'programming') {
          answers[part.id] = {
            language: document.querySelector(selector)?.value || 'c',
            code: document.querySelector(`[data-exam-preview-code="${CSS.escape(part.id)}"]`)?.value || '',
          };
        } else {
          answers[part.id] = document.querySelector(selector)?.value || '';
        }
      }
    }
    return answers;
  }

  async submitExamPreview() {
    if (!this.previewPaper) return;
    const button = document.querySelector('[data-exam-preview-submit]');
    const resultNode = document.querySelector('[data-exam-preview-result]');
    button.disabled = true;
    button.textContent = '正在自动批改...';
    resultNode.innerHTML = '<p class="empty-cell">正在批改选择、填空和编程部分...</p>';
    try {
      const result = await this.request('admin_exam_preview_grade', {
        examId: this.previewPaper.id,
        answers: this.collectPreviewAnswers(),
      });
      resultNode.innerHTML = `<div class="preview-exam-result"><h3>预览得分：${this.escape(result.totalScore)} / ${this.escape(this.previewPaper.totalScore)}</h3><p>已自动批改 ${this.escape(result.gradedCount)}/${this.escape(result.totalParts)} 个小题；简答和未命中的填空仍显示待人工批改。</p>${result.grading.partResults.map(item => `<div><span>${this.escape(item.partId)}</span><strong class="${item.status === 'correct' ? 'success' : item.status === 'pending' ? 'warning' : 'error'}">${this.escape({ correct: '正确', incorrect: '错误', pending: '待人工批改', graded: '已评分' }[item.status] || item.status)}</strong><b>${this.escape(item.effectiveScore || 0)} / ${this.escape(item.maxScore)}</b>${item.judge ? `<small>测试点 ${this.escape(item.judge.passedTests)}/${this.escape(item.judge.totalTests)}</small>` : ''}</div>`).join('')}</div>`;
    } catch (error) {
      resultNode.innerHTML = `<p class="empty-cell error">提交失败：${this.escape(error.message)}</p>`;
    } finally {
      button.disabled = false;
      button.textContent = '提交整张试卷';
    }
  }

  showManager() {
    document.getElementById('exam-manage-view').hidden = false;
    document.getElementById('exam-grading-view').hidden = true;
  }

  async showGrading() {
    await this.ensureLoaded();
    document.getElementById('exam-manage-view').hidden = true;
    document.getElementById('exam-grading-view').hidden = false;
  }

  async loadGrading(examId, { silent = false, preserveSelection = false } = {}) {
    if (!examId) return;
    const requestedGroup = this.group;
    const workspace = document.getElementById('grading-workspace');
    const selectedId = preserveSelection ? this.submissions[this.studentIndex]?.id : null;
    const selectedPartId = preserveSelection ? document.getElementById('grading-part').value : '';
    const previousPaperVersion = this.paper?.id === examId ? this.paper.version : null;
    const previousSubmissionSignature = this.gradingSubmissionSignature(this.submissions);
    const workspaceScrollTop = workspace.scrollTop;
    const studentList = document.getElementById('grading-student-list');
    const studentListScrollTop = studentList.scrollTop;
    if (!preserveSelection) this.gradingDirty = false;
    if (!silent) workspace.innerHTML = '<p class="empty-cell">正在读取提交...</p>';
    try {
      const [paper, initialSubmissions] = await Promise.all([
        this.request('admin_exam_get', { examId }),
        this.request('admin_exam_submissions', { examId }),
      ]);
      let submissions = initialSubmissions;
      if (!this.highConfidenceChecked.has(examId)) {
        try {
          const adopted = await this.request('admin_exam_ai_adopt', { examId, highOnly: true, includeFeedback: false });
          this.highConfidenceChecked.add(examId);
          if (adopted.adopted || adopted.restored) {
            submissions = await this.request('admin_exam_submissions', { examId });
            const messages = [];
            if (adopted.adopted) messages.push(`自动采用 ${adopted.adopted} 条高置信度结果`);
            if (adopted.restored) messages.push(`恢复 ${adopted.restored} 条历史草稿卡片`);
            document.getElementById('ai-grading-status').textContent = `已${messages.join('，')}`;
          }
        } catch {
          // 自动处理失败不应阻止管理员查看和手工批改试卷。
        }
      }
      if (this.group !== requestedGroup || document.getElementById('grading-exam').value !== examId) return;
      if (silent
        && previousPaperVersion === paper.version
        && previousSubmissionSignature === this.gradingSubmissionSignature(submissions)) return;
      this.paper = paper;
      this.submissions = this.sortSubmissions(submissions);
      this.studentIndex = selectedId ? this.submissions.findIndex(item => item.id === selectedId) : -1;
      if (this.submissions.length && this.studentIndex < 0) this.studentIndex = 0;
      const partSelect = document.getElementById('grading-part');
      partSelect.innerHTML = '<option value="">选择小题</option>' + this.paper.questions.flatMap(question => question.parts.map(part =>
        `<option value="${this.escape(part.id)}">${this.escape(question.title)} · ${this.escape(part.prompt || part.id)}</option>`
      )).join('');
      if ([...partSelect.options].some(option => option.value === selectedPartId)) partSelect.value = selectedPartId;
      if (this.studentIndex >= 0) {
        const detail = await this.request('admin_exam_submission_get', {
          submissionId: this.submissions[this.studentIndex].id,
        });
        if (this.group !== requestedGroup || document.getElementById('grading-exam').value !== examId) return;
        this.submissions[this.studentIndex] = detail;
      }
      this.renderGrading();
      requestAnimationFrame(() => {
        workspace.scrollTop = workspaceScrollTop;
        studentList.scrollTop = studentListScrollTop;
      });
    } catch (error) {
      if (!silent) workspace.innerHTML = `<p class="empty-cell">${this.escape(error.message)}</p>`;
    }
  }

  gradingSubmissionSignature(submissions) {
    return JSON.stringify([...(submissions || [])].sort((a, b) => Number(a.id) - Number(b.id)).map(submission => ({
      id: submission.id,
      username: submission.username,
      attemptNo: submission.attemptNo,
      submittedAt: submission.submittedAt,
      gradedCount: submission.gradedCount,
      totalParts: submission.totalParts,
      totalScore: submission.totalScore,
      gradingStatus: submission.gradingStatus,
      released: submission.released,
      preview: submission.preview,
      updatedAt: submission.updatedAt,
    })));
  }

  sortSubmissions(submissions = this.submissions) {
    const compareFallback = (left, right) => Number(left.submittedAt) - Number(right.submittedAt)
      || String(left.username).localeCompare(String(right.username), 'zh-CN', { numeric: true });
    return [...(submissions || [])].sort((left, right) => {
      if (this.studentSort === 'submitted_desc') return Number(right.submittedAt) - Number(left.submittedAt)
        || String(left.username).localeCompare(String(right.username), 'zh-CN', { numeric: true });
      if (this.studentSort === 'username') return String(left.username).localeCompare(String(right.username), 'zh-CN', { numeric: true })
        || Number(left.submittedAt) - Number(right.submittedAt);
      if (this.studentSort === 'score_desc') return Number(right.totalScore) - Number(left.totalScore) || compareFallback(left, right);
      if (this.studentSort === 'score_asc') return Number(left.totalScore) - Number(right.totalScore) || compareFallback(left, right);
      return compareFallback(left, right);
    });
  }

  sortSubmissionsPreservingSelection() {
    const selectedId = this.submissions[this.studentIndex]?.id;
    this.submissions = this.sortSubmissions();
    this.studentIndex = selectedId == null ? -1 : this.submissions.findIndex(item => item.id === selectedId);
  }

  async exportAiGrading() {
    const examId = this.paper?.id;
    const partId = document.getElementById('grading-part').value;
    const status = document.getElementById('ai-grading-status');
    if (!examId || !partId) return this.admin.toast('请先选择一道填空题或简答题');
    status.textContent = '正在整理待批改答案...';
    try {
      const payload = await this.request('admin_exam_ai_export', { examId, partId });
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `${examId.toLowerCase()}-${partId.replace(/[^A-Za-z0-9_-]/g, '_')}-claude-input.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 1000);
      status.textContent = `已导出 ${payload.submissionCount} 份答案；在项目目录运行 node scripts/claude-grade.js “文件路径”`;
    } catch (error) {
      status.textContent = `导出失败：${error.message}`;
    }
  }

  splitAiGradingPackage(payload) {
    const chunks = [];
    for (const group of payload.groups || []) {
      const batches = [];
      let current = [];
      let characterCount = 0;
      for (const submission of group.submissions || []) {
        const answerLength = String(submission.answer || '').length;
        if (current.length && (current.length >= 16 || characterCount + answerLength > 60000)) {
          batches.push(current);
          current = [];
          characterCount = 0;
        }
        current.push(submission);
        characterCount += answerLength;
      }
      if (current.length) batches.push(current);
      for (let index = 0; index < batches.length; index += 6) {
        const submissions = batches.slice(index, index + 6).flat();
        chunks.push({
          ...payload,
          groups: [{ ...group, submissions }],
          submissionCount: submissions.length,
        });
      }
    }
    return chunks;
  }

  async runAiGradingChunk(gradingPackage) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25 * 60 * 1000);
    try {
      const response = await fetch('http://127.0.0.1:37841/grade', {
        method: 'POST',
        mode: 'cors',
        credentials: 'omit',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
        headers: { 'Content-Type': 'application/json', 'X-JC-OJ-Grading': '1' },
        body: JSON.stringify(gradingPackage),
        signal: controller.signal,
      });
      const localResult = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(localResult.error || `本机助手返回 ${response.status}`);
      return localResult;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('当前批次超过 25 分钟，已停止等待');
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async runAiGrading() {
    const examId = this.paper?.id;
    const mode = document.getElementById('grading-mode').value;
    const selectedPartId = document.getElementById('grading-part').value;
    const button = document.getElementById('run-ai-grading');
    const status = document.getElementById('ai-grading-status');
    if (!examId || button.disabled) return;
    const partIds = mode === 'part'
      ? (selectedPartId ? [selectedPartId] : [])
      : this.paper.questions.flatMap(question => question.parts)
        .filter(part => ['fill_blank', 'short_answer'].includes(part.type))
        .map(part => part.id);
    if (!partIds.length) return this.admin.toast(mode === 'part' ? '请先选择一道填空题或简答题' : '这份试卷没有可由 Claude 批改的题目');
    button.disabled = true;
    status.textContent = '正在整理待批改答案...';
    let importedCount = 0;
    let autoAdopted = 0;
    let drafts = 0;
    let skippedParts = 0;
    let completedChunks = 0;
    try {
      for (let index = 0; index < partIds.length; index += 1) {
        const partId = partIds[index];
        let gradingPackage;
        try {
          gradingPackage = await this.request('admin_exam_ai_export', { examId, partId });
        } catch (error) {
          if (error.message.includes('没有待批改')) {
            skippedParts += 1;
            continue;
          }
          throw error;
        }
        const chunks = this.splitAiGradingPackage(gradingPackage);
        for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
          const chunk = chunks[chunkIndex];
          status.textContent = `正在批改第 ${index + 1}/${partIds.length} 道题，第 ${chunkIndex + 1}/${chunks.length} 批（${chunk.submissionCount} 份答案）；已保存 ${importedCount} 条...`;
          const localResult = await this.runAiGradingChunk(chunk);
          status.textContent = `第 ${index + 1}/${partIds.length} 道题第 ${chunkIndex + 1}/${chunks.length} 批已完成，正在保存...`;
          const imported = await this.request('admin_exam_ai_import', { payload: localResult });
          importedCount += imported.imported || 0;
          autoAdopted += imported.autoAdopted || 0;
          drafts += imported.drafts || 0;
          completedChunks += 1;
        }
      }
      status.textContent = importedCount
        ? `批改完成：${importedCount} 条结果，高置信度自动采用 ${autoAdopted} 条，待复核 ${drafts} 条${skippedParts ? `，${skippedParts} 道题无需处理` : ''}`
        : '没有新的待批改答案；已有 Claude 草稿不会重复消耗 Token';
      await this.loadGrading(examId, { preserveSelection: true });
    } catch (error) {
      const savedText = completedChunks ? `；此前 ${completedChunks} 批共 ${importedCount} 条结果已经保存，重新运行会自动跳过` : '';
      const failureText = `一键批改中止：${error.message}${savedText}`;
      await this.loadGrading(examId, { silent: true, preserveSelection: true });
      status.textContent = failureText;
    } finally {
      button.disabled = false;
    }
  }

  async importAiGrading(input) {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    const status = document.getElementById('ai-grading-status');
    if (file.size > 900 * 1024) {
      status.textContent = '导入失败：结果文件不能超过 900 KB';
      return;
    }
    status.textContent = '正在校验并导入 Claude 建议...';
    try {
      const payload = JSON.parse(await file.text());
      const result = await this.request('admin_exam_ai_import', { payload });
      status.textContent = `已导入 ${result.imported} 条结果；高置信度自动采用 ${result.autoAdopted || 0} 条，待复核 ${result.drafts || 0} 条${result.skipped ? `，跳过 ${result.skipped} 条已变化或无效结果` : ''}`;
      await this.loadGrading(this.paper.id, { preserveSelection: true });
    } catch (error) {
      status.textContent = `导入失败：${error.message}`;
    }
  }

  async adoptAllAiSuggestions(includeFeedback = false) {
    const examId = this.paper?.id;
    const mode = document.getElementById('grading-mode').value;
    const partId = mode === 'part' ? document.getElementById('grading-part').value : '';
    const button = document.getElementById('adopt-all-ai');
    const status = document.getElementById('ai-grading-status');
    if (!examId || (mode === 'part' && !partId) || button.disabled) return;
    const scopeText = mode === 'part' ? '当前题目' : '整份试卷';
    const actionText = includeFeedback ? '分数和评价' : '分数';
    if (!confirm(`确定采纳${scopeText}所有 Claude 草稿的${actionText}吗？\n\n人工提交或修改过的正式结果不会被覆盖。`)) return;
    const actionButtons = [...document.querySelectorAll('#adopt-all-ai-actions button')];
    actionButtons.forEach(item => { item.disabled = true; });
    this.closeGradingMenus();
    status.textContent = `正在采纳${scopeText}的 Claude 草稿${actionText}...`;
    try {
      const result = await this.request('admin_exam_ai_adopt', {
        examId,
        ...(partId ? { partId } : {}),
        highOnly: false,
        includeFeedback,
      });
      status.textContent = result.adopted
        ? `已采纳 ${result.adopted} 条草稿的${actionText}，更新 ${result.submissionsUpdated} 份答卷${result.protected ? `，保护并跳过 ${result.protected} 条人工结果` : ''}`
        : `${scopeText}没有可采纳的 Claude 草稿${result.protected ? `；已保护 ${result.protected} 条人工结果` : ''}`;
      await this.loadGrading(examId, { preserveSelection: true });
    } catch (error) {
      status.textContent = `一键采纳失败：${error.message}`;
    } finally {
      actionButtons.forEach(item => { item.disabled = false; });
    }
  }

  async deleteAllAiSuggestions() {
    const examId = this.paper?.id;
    const mode = document.getElementById('grading-mode').value;
    const partId = mode === 'part' ? document.getElementById('grading-part').value : '';
    const button = document.getElementById('delete-all-ai');
    const status = document.getElementById('ai-grading-status');
    if (!examId || (mode === 'part' && !partId) || button.disabled) return;
    const scopeText = mode === 'part' ? '当前题目' : '整份试卷';
    if (!confirm(`确定删除${scopeText}的所有 Claude 草稿吗？\n\n正式分数、正式评价和学生答案都不会被删除。`)) return;
    button.disabled = true;
    status.textContent = `正在删除${scopeText}的 Claude 草稿...`;
    try {
      const result = await this.request('admin_exam_ai_delete', {
        examId,
        ...(partId ? { partId } : {}),
      });
      status.textContent = result.deleted
        ? `已删除 ${result.deleted} 条 Claude 草稿；正式评分保持不变`
        : `${scopeText}没有可删除的 Claude 草稿`;
      await this.loadGrading(examId, { preserveSelection: true });
    } catch (error) {
      status.textContent = `批量删除失败：${error.message}`;
    } finally {
      button.disabled = false;
    }
  }

  async clearPartGrading(action) {
    const examId = this.paper?.id;
    const partId = document.getElementById('grading-part').value;
    const selected = partId ? this.findPart(partId) : null;
    const actions = document.getElementById('clear-part-grading-actions');
    const status = document.getElementById('ai-grading-status');
    if (!examId || !selected || !['fill_blank', 'short_answer'].includes(selected.part.type)) return;
    const formalCount = this.submissions.filter(item => !item.preview).length;
    const deletingScore = action === 'score';
    const operation = deletingScore ? '删除正式评分和正式评价，并恢复待批改状态' : '只删除正式评价并保留分数';
    if (!confirm(`确定对“${selected.question.title} · ${selected.part.prompt || selected.part.id}”执行整题操作吗？\n\n将影响最多 ${formalCount} 名正式提交学生：${operation}。\n学生答案和 Claude 草稿都会保留。`)) return;
    const buttons = [...actions.querySelectorAll('button')];
    buttons.forEach(button => { button.disabled = true; });
    this.closeGradingMenus();
    status.textContent = deletingScore ? '正在删除整题评分和评价...' : '正在删除整题评价...';
    try {
      const result = await this.request('admin_exam_part_clear_grading', { examId, partId, action });
      status.textContent = deletingScore
        ? `已重置 ${result.affected} 份答卷的本题评分和评价`
        : `已删除 ${result.affected} 份答卷的本题评价，分数保持不变`;
      await this.loadGrading(examId, { silent: true, preserveSelection: true });
    } catch (error) {
      status.textContent = `整题操作失败：${error.message}`;
    } finally {
      buttons.forEach(button => { button.disabled = false; });
    }
  }

  toggleGradingMenu(button) {
    const owner = button.closest('.grading-split-action');
    if (!owner) return;
    const open = !owner.classList.contains('open');
    this.closeGradingMenus();
    owner.classList.toggle('open', open);
    button.setAttribute('aria-expanded', String(open));
  }

  closeGradingMenus() {
    document.querySelectorAll('.grading-split-action.open').forEach(owner => {
      owner.classList.remove('open');
      owner.querySelector('.grading-menu-toggle')?.setAttribute('aria-expanded', 'false');
    });
  }

  async checkClaudeHelper() {
    const status = document.getElementById('claude-helper-status');
    const button = document.getElementById('check-claude-helper');
    button.disabled = true;
    status.textContent = '助手状态：正在检测...';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);
    try {
      const response = await fetch('http://127.0.0.1:37841/health', {
        mode: 'cors', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', signal: controller.signal,
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || result.ok !== true) throw new Error('状态异常');
      status.textContent = result.busy
        ? `助手状态：已连接，运行 ${Number(result.activeJobs || 0)} 个${result.queuedJobs ? `，排队 ${Number(result.queuedJobs)} 个` : ''}`
        : '助手状态：已连接，可以使用';
    } catch {
      status.textContent = '助手状态：未启动，请下载并双击启动程序';
    } finally {
      clearTimeout(timeout);
      button.disabled = false;
    }
  }

  renderGrading() {
    const mode = document.getElementById('grading-mode').value;
    document.getElementById('grading-part').hidden = mode !== 'part';
    const selectedPartId = document.getElementById('grading-part').value;
    const selectedPart = selectedPartId && this.paper ? this.findPart(selectedPartId)?.part : null;
    const aiPartEligible = mode === 'part' && ['fill_blank', 'short_answer'].includes(selectedPart?.type);
    const aiExamEligible = mode === 'student' && Boolean(this.paper?.questions.some(question =>
      question.parts.some(part => ['fill_blank', 'short_answer'].includes(part.type))));
    const aiEligible = aiPartEligible || aiExamEligible;
    const runAiButton = document.getElementById('run-ai-grading');
    runAiButton.hidden = !aiEligible;
    runAiButton.textContent = mode === 'part' ? 'Claude 一键批改本题' : 'Claude 一键批改整卷';
    const adoptActions = document.getElementById('adopt-all-ai-actions');
    adoptActions.hidden = !aiEligible;
    const adoptButton = document.getElementById('adopt-all-ai');
    adoptButton.textContent = mode === 'part' ? '一键采纳本题草稿' : '一键采纳整卷草稿';
    const deleteButton = document.getElementById('delete-all-ai');
    deleteButton.hidden = !aiEligible;
    deleteButton.textContent = mode === 'part' ? '删除本题所有草稿' : '删除整卷所有草稿';
    document.getElementById('clear-part-grading-actions').hidden = !aiPartEligible;
    document.getElementById('export-ai-grading').hidden = !aiPartEligible;
    document.getElementById('import-ai-grading-label').hidden = !aiPartEligible;
    if (!aiEligible) document.getElementById('ai-grading-status').textContent = '';
    const formalSubmissions = this.submissions.filter(item => !item.preview);
    const completed = formalSubmissions.filter(item => item.gradingStatus === 'completed').length;
    document.getElementById('grading-summary').textContent = this.paper
      ? `${formalSubmissions.length} 人正式提交 · ${completed} 人完成批改${this.submissions.some(item => item.preview) ? ' · 含管理员预览记录' : ''}`
      : '请选择试卷';
    this.renderStudentList();
    this.renderWorkspace();
  }

  renderStudentList() {
    document.getElementById('grading-student-list').innerHTML = this.submissions.length ? this.submissions.map((submission, index) => `
      <button type="button" class="grading-student ${index === this.studentIndex ? 'active' : ''}" data-grading-student="${index}">
        <strong>${this.escape(submission.username)}${submission.preview ? '（管理员预览）' : ''}</strong><span>${submission.gradedCount}/${submission.totalParts} 题 · ${submission.totalScore}/${this.paper?.totalScore || 0} 分</span>
      </button>`).join('') : '<p class="empty-cell">还没有学生提交</p>';
    document.getElementById('grading-prev').disabled = this.studentIndex <= 0;
    document.getElementById('grading-next').disabled = this.studentIndex < 0 || this.studentIndex >= this.submissions.length - 1;
  }

  async selectStudent(index) {
    if (index < 0 || index >= this.submissions.length) return;
    this.studentIndex = index;
    this.renderGrading();
    const submission = this.submissions[index];
    if (!submission.answers || !submission.grading) {
      document.getElementById('grading-workspace').innerHTML = '<p class="empty-cell">正在读取该学生的答案...</p>';
      try {
        const detail = await this.request('admin_exam_submission_get', { submissionId: submission.id });
        if (this.studentIndex !== index) return;
        this.submissions[index] = detail;
        this.renderGrading();
      } catch (error) {
        document.getElementById('grading-workspace').innerHTML = `<p class="empty-cell">${this.escape(error.message)}</p>`;
      }
    }
  }

  async refreshSelectedSubmission(submissionId = null) {
    const selectedId = this.submissions[this.studentIndex]?.id;
    const targetId = submissionId || selectedId;
    if (!targetId) return;
    const workspace = document.getElementById('grading-workspace');
    const studentList = document.getElementById('grading-student-list');
    const workspaceScrollTop = workspace.scrollTop;
    const studentListScrollTop = studentList.scrollTop;
    const detail = await this.request('admin_exam_submission_get', { submissionId: targetId });
    const index = this.submissions.findIndex(item => item.id === targetId);
    if (index < 0) return;
    this.submissions[index] = detail;
    this.submissions = this.sortSubmissions();
    this.studentIndex = selectedId == null ? -1 : this.submissions.findIndex(item => item.id === selectedId);
    this.renderGrading();
    requestAnimationFrame(() => {
      workspace.scrollTop = workspaceScrollTop;
      studentList.scrollTop = studentListScrollTop;
    });
  }

  findPart(partId) {
    for (const question of this.paper.questions) {
      const part = question.parts.find(item => item.id === partId);
      if (part) return { question, part };
    }
    return null;
  }

  renderWorkspace() {
    const submission = this.submissions[this.studentIndex];
    const workspace = document.getElementById('grading-workspace');
    const prev = document.getElementById('grading-prev');
    const next = document.getElementById('grading-next');
    prev.disabled = this.studentIndex <= 0;
    next.disabled = this.studentIndex < 0 || this.studentIndex >= this.submissions.length - 1;
    if (!submission || !this.paper) {
      workspace.innerHTML = '<p class="empty-cell">暂无批改内容</p>';
      return;
    }
    document.getElementById('grading-work-title').textContent = submission.username;
    document.getElementById('grading-work-meta').textContent = `第 ${submission.attemptNo} 次提交（${submission.preview ? '管理员预览' : '最终提交'}） · ${new Date(submission.submittedAt).toLocaleString()}`;
    const mode = document.getElementById('grading-mode').value;
    const selectedPart = document.getElementById('grading-part').value;
    if (!submission.grading || !submission.answers) {
      workspace.innerHTML = '<p class="empty-cell">正在读取该学生的答案...</p>';
      return;
    }
    const results = submission.grading.partResults.filter(result => mode !== 'part' || !selectedPart || result.partId === selectedPart);
    const selected = mode === 'part' && selectedPart ? this.findPart(selectedPart) : null;
    const automaticallyVisible = this.paper.resultPolicy === 'immediate'
      || (this.paper.resultPolicy === 'after_graded' && submission.gradingStatus === 'completed');
    const policyControlsVisibility = this.paper.resultPolicy !== 'manual';
    const visibilityLabel = automaticallyVisible
      ? '已按试卷规则自动向学生显示'
      : policyControlsVisibility ? '该答卷批改完成后将自动显示' : '向学生发布当前结果';
    const formalCount = this.submissions.filter(item => !item.preview).length;
    const bulkActions = selected?.part.type === 'programming' ? `<div class="grading-bulk-actions">
      <div><strong>批量处理本题 · ${this.escape(selected.part.problemId)}</strong><span>面向 ${formalCount} 名正式提交学生；重新判题将依次进入队列</span></div>
      <div class="grading-bulk-buttons"><button type="button" class="admin-button secondary" data-bulk-rejudge-programming="${this.escape(selected.part.problemId)}">全部同学重新判题</button><button type="button" class="admin-button secondary" data-bulk-request-programming-resubmit="${this.escape(selected.part.problemId)}">全部同学需重新提交</button></div>
    </div>` : '';
    workspace.innerHTML = bulkActions + `<div class="grading-score-summary"><strong>${submission.totalScore} / ${this.paper.totalScore} 分</strong><span>已批改 ${submission.gradedCount}/${submission.totalParts}</span><label><input type="checkbox" data-release-result ${submission.released || automaticallyVisible ? 'checked' : ''} ${policyControlsVisibility ? 'disabled' : ''}> ${visibilityLabel}</label></div>` + results.map(result => {
      const found = this.findPart(result.partId);
      if (!found) return '';
      const answer = submission.answers[result.partId];
      const answerText = result.type === 'programming'
        ? `${answer?.language || ''}\n\n${answer?.code || ''}`
        : Array.isArray(answer) ? answer.join('、') : String(answer ?? '');
      const statusText = result.gradingSource === 'manual'
        ? '已人工评分（Claude 不会覆盖）'
        : result.aiAdopted
          ? (result.aiAdopted.automatic ? 'Claude 高置信度自动评分' : '已采纳 Claude 评分')
          : ({ correct: '正确', incorrect: '错误', graded: '已人工评分', pending: '待人工批改' }[result.status] || result.status);
      const aiSuggestion = result.aiSuggestion;
      const aiCanApply = aiSuggestion && (aiSuggestion.forceRegrade === true
        || (result.gradingSource !== 'manual'
          && (result.status === 'pending' || result.gradingSource === 'claude' || result.aiAdopted)));
      const adoptedLabel = result.aiAdopted
        ? (result.aiAdopted.includeFeedback ? '已采纳分数和评价' : '已采纳分数')
        : result.gradingSource === 'manual' ? '人工结果已保护' : '尚未采纳';
      const aiPanel = aiSuggestion ? `<div class="grading-ai-suggestion">
        <div class="grading-ai-heading"><div><span class="grading-ai-label">CLAUDE 草稿</span><strong>建议 ${this.escape(aiSuggestion.score)} / ${this.escape(result.maxScore)} 分</strong></div><span class="grading-ai-state">${this.escape(adoptedLabel)}</span></div>
        <div class="grading-ai-meta">置信度 ${this.escape(Math.round(Number(aiSuggestion.confidence || 0) * 100))}%${aiSuggestion.needsReview ? ' · 建议人工复核' : ' · 可直接复核'}</div>
        <p>${this.escape(aiSuggestion.feedback || '未提供评价')}</p>
        <div class="grading-ai-card-actions">
          ${aiCanApply ? `<div class="grading-split-action"><button type="button" class="admin-button secondary" data-adopt-ai>采纳分数</button><button type="button" class="admin-button secondary grading-menu-toggle" data-ai-menu-toggle aria-label="更多采纳方式" aria-expanded="false">▾</button><div class="grading-action-menu"><button type="button" data-adopt-ai-feedback>同时采纳分数和评价</button></div></div>` : '<span class="grading-ai-protected">已经人工保存，批量操作不会覆盖</span>'}
          <button type="button" class="admin-button danger" data-delete-ai>删除草稿</button>
        </div>
      </div>` : '';
      return `<section class="grading-part-card" data-grade-part="${this.escape(result.partId)}">
        <div class="grading-part-title"><div><strong>${this.escape(found.question.title)} · ${this.escape(found.part.prompt || found.part.id)}</strong><span>${this.escape(statusText)}${result.blockedByProgramming ? ' · 因编程未通过暂计 0 分' : ''}</span></div><b>${this.escape(result.effectiveScore || 0)} / ${this.escape(result.maxScore)}</b></div>
        <pre class="grading-answer">${this.escape(answerText || '（未作答）')}</pre>
        ${result.judge ? `<p class="grading-judge">编程测试：${result.judge.passedTests}/${result.judge.totalTests} · ${result.judge.totalTime}ms</p>` : ''}
        ${result.type === 'programming' && !submission.preview ? `<div class="grading-programming-actions"><button type="button" class="admin-button secondary" data-rejudge-programming="${this.escape(found.part.problemId)}">重新判题</button><button type="button" class="admin-button secondary" data-request-programming-resubmit="${this.escape(found.part.problemId)}">要求学生重新提交</button></div>` : ''}
        ${aiPanel}
        <div class="grading-form"><label class="form-field"><span>人工评分</span><input class="admin-input" data-grade-score type="number" min="0" max="${this.escape(result.maxScore)}" step="0.01" value="${this.escape(result.manualScore || 0)}"></label><label class="form-field"><span>批注</span><input class="admin-input" data-grade-feedback maxlength="3000" value="${this.escape(result.feedback || '')}" placeholder="可选"></label>${['fill_blank', 'short_answer'].includes(result.type) && !submission.preview ? `<button type="button" class="admin-button secondary" data-claude-grade>${aiSuggestion || result.status !== 'pending' ? 'Claude 重新评分' : 'Claude 评分'}</button>` : ''}<button type="button" class="admin-button primary" data-save-grade>保存评分</button></div>
      </section>`;
    }).join('');
  }

  async handleGradingClick(event) {
    const menuToggle = event.target.closest('[data-ai-menu-toggle]');
    if (menuToggle) {
      this.toggleGradingMenu(menuToggle);
      return;
    }
    const claudeGrade = event.target.closest('[data-claude-grade]');
    if (claudeGrade) {
      const card = claudeGrade.closest('[data-grade-part]');
      const submission = this.submissions[this.studentIndex];
      if (!card || !submission) return;
      const originalText = claudeGrade.textContent;
      claudeGrade.disabled = true;
      claudeGrade.textContent = 'Claude 评分中...';
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10 * 60 * 1000);
      try {
        const gradingPackage = await this.request('admin_exam_ai_export', {
          examId: this.paper.id,
          partId: card.dataset.gradePart,
          submissionId: submission.id,
          forceRegrade: true,
        });
        const response = await fetch('http://127.0.0.1:37841/grade', {
          method: 'POST',
          mode: 'cors',
          credentials: 'omit',
          cache: 'no-store',
          referrerPolicy: 'no-referrer',
          headers: { 'Content-Type': 'application/json', 'X-JC-OJ-Grading': '1' },
          body: JSON.stringify(gradingPackage),
          signal: controller.signal,
        });
        const localResult = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(localResult.error || `本机助手返回 ${response.status}`);
        const imported = await this.request('admin_exam_ai_import', { payload: localResult });
        if (!imported.imported) throw new Error('学生答案在评分期间发生变化，请重新点击');
        this.admin.toast(imported.autoAdopted
          ? 'Claude 评分完成，已自动采用高置信度分数并保留草稿'
          : 'Claude 评分完成，已生成新草稿；原有人工分数未被覆盖');
        await this.refreshSelectedSubmission(submission.id);
      } catch (error) {
        const detail = error.name === 'AbortError' ? '本机批改超过10分钟' : error.message;
        this.admin.toast(`Claude 评分失败：${detail}`);
      } finally {
        clearTimeout(timeout);
        claudeGrade.disabled = false;
        claudeGrade.textContent = originalText;
      }
      return;
    }
    const adoptAi = event.target.closest('[data-adopt-ai], [data-adopt-ai-feedback]');
    if (adoptAi) {
      const card = adoptAi.closest('[data-grade-part]');
      const submission = this.submissions[this.studentIndex];
      if (!card || !submission) return;
      const includeFeedback = adoptAi.hasAttribute('data-adopt-ai-feedback');
      adoptAi.disabled = true;
      this.closeGradingMenus();
      try {
        const result = await this.request('admin_exam_ai_adopt', {
          examId: this.paper.id,
          submissionId: submission.id,
          partId: card.dataset.gradePart,
          highOnly: false,
          includeFeedback,
          allowManualOverride: true,
        });
        if (!result.adopted) throw new Error(result.protected ? '该题已经人工保存，Claude 草稿不能覆盖' : '这条草稿已经不存在');
        this.admin.toast(includeFeedback ? '已采纳 Claude 分数和评价，草稿仍保留' : '已采纳 Claude 分数，草稿仍保留');
        await this.refreshSelectedSubmission(submission.id);
      } catch (error) {
        this.admin.toast(`采纳失败：${error.message}`);
      } finally {
        adoptAi.disabled = false;
      }
      return;
    }
    const deleteAi = event.target.closest('[data-delete-ai]');
    if (deleteAi) {
      const card = deleteAi.closest('[data-grade-part]');
      const submission = this.submissions[this.studentIndex];
      if (!card || !submission || !confirm('确定删除这条 Claude 草稿吗？正式评分和评价不会改变。')) return;
      deleteAi.disabled = true;
      try {
        const result = await this.request('admin_exam_ai_delete', {
          examId: this.paper.id,
          submissionId: submission.id,
          partId: card.dataset.gradePart,
        });
        this.admin.toast(result.deleted ? 'Claude 草稿已删除，正式评分保持不变' : '草稿已经不存在');
        await this.refreshSelectedSubmission(submission.id);
      } catch (error) {
        this.admin.toast(`删除失败：${error.message}`);
      } finally {
        deleteAi.disabled = false;
      }
      return;
    }
    const release = event.target.closest('[data-release-result]');
    const save = event.target.closest('[data-save-grade]');
    const rejudge = event.target.closest('[data-rejudge-programming]');
    const requestResubmit = event.target.closest('[data-request-programming-resubmit]');
    const bulkRejudge = event.target.closest('[data-bulk-rejudge-programming]');
    const bulkRequestResubmit = event.target.closest('[data-bulk-request-programming-resubmit]');
    if (bulkRejudge || bulkRequestResubmit) {
      const isRejudge = Boolean(bulkRejudge);
      const button = bulkRejudge || bulkRequestResubmit;
      const problemId = button.dataset[isRejudge ? 'bulkRejudgeProgramming' : 'bulkRequestProgrammingResubmit'];
      const formalCount = this.submissions.filter(item => !item.preview).length;
      const prompt = isRejudge
        ? `确定将 ${formalCount} 名正式提交学生的 ${problemId} 加入重新判题队列吗？`
        : `确定要求 ${formalCount} 名正式提交学生重新提交 ${problemId} 吗？系统会逐一发送弹窗消息。`;
      if (!confirm(prompt)) return;
      button.disabled = true;
      try {
        const result = await this.request('admin_exam_part_bulk_action', {
          examId: this.paper.id,
          problemId,
          action: isRejudge ? 'rejudge' : 'resubmit',
        });
        this.admin.toast(isRejudge
          ? `已将 ${result.count} 名学生的提交加入重判队列`
          : `已向 ${result.count} 名学生发送重新提交通知`);
      } catch (error) {
        this.admin.toast(`批量操作失败：${error.message}`);
      } finally {
        button.disabled = false;
      }
      return;
    }
    const submission = this.submissions[this.studentIndex];
    if (!submission || (!release && !save && !rejudge && !requestResubmit)) return;
    if (rejudge || requestResubmit) {
      const problemId = (rejudge || requestResubmit).dataset[rejudge ? 'rejudgeProgramming' : 'requestProgrammingResubmit'];
      if (requestResubmit && !confirm(`确定要求“${submission.username}”重新提交 ${problemId} 吗？学生登录后会看到提醒。`)) return;
      const button = rejudge || requestResubmit;
      button.disabled = true;
      try {
        await this.request(rejudge ? 'admin_rejudge_submission' : 'admin_request_resubmission', {
          submissionKind: 'exam',
          submissionId: submission.id,
          problemId,
        });
        this.admin.toast(rejudge ? '该编程题已加入自动重判队列' : '已向该学生发送重新提交通知');
      } catch (error) {
        this.admin.toast(`操作失败：${error.message}`);
      } finally {
        button.disabled = false;
      }
      return;
    }
    const payload = { submissionId: submission.id };
    if (release) payload.released = release.checked;
    if (save) {
      const card = save.closest('[data-grade-part]');
      payload.partId = card.dataset.gradePart;
      payload.score = Number(card.querySelector('[data-grade-score]').value);
      payload.feedback = card.querySelector('[data-grade-feedback]').value;
    }
    try {
      const result = await this.request('admin_exam_grade', payload);
      submission.grading = result.grading;
      submission.autoScore = result.autoScore;
      submission.manualScore = result.manualScore;
      submission.totalScore = result.totalScore;
      submission.gradedCount = result.gradedCount;
      submission.totalParts = result.totalParts;
      submission.gradingStatus = result.gradingStatus;
      submission.released = result.released;
      this.admin.toast(save ? '评分已保存' : '成绩发布状态已更新');
      this.gradingDirty = false;
      this.sortSubmissionsPreservingSelection();
      this.renderGrading();
    } catch (error) {
      this.admin.toast(`保存失败：${error.message}`);
      this.renderWorkspace();
    }
  }

  escape(value) {
    const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return String(value ?? '').replace(/[&<>"']/g, character => entities[character]);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  window.examAdmin = new ExamAdmin();
  window.examAdmin.init();
});
