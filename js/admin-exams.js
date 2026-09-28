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
  }

  init() {
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
    document.getElementById('exam-admin-list').addEventListener('click', event => this.handleListClick(event));
    document.getElementById('show-exam-grading').addEventListener('click', () => this.showGrading());
    document.getElementById('back-to-exams').addEventListener('click', () => this.showManager());
    document.getElementById('grading-exam').addEventListener('change', event => this.loadGrading(event.target.value));
    document.getElementById('grading-mode').addEventListener('change', () => this.renderGrading());
    document.getElementById('grading-part').addEventListener('change', () => this.renderGrading());
    document.getElementById('grading-student-list').addEventListener('click', event => {
      const button = event.target.closest('[data-grading-student]');
      if (button) this.selectStudent(Number(button.dataset.gradingStudent));
    });
    document.getElementById('grading-workspace').addEventListener('click', event => this.handleGradingClick(event));
    document.getElementById('grading-prev').addEventListener('click', () => this.selectStudent(this.studentIndex - 1));
    document.getElementById('grading-next').addEventListener('click', () => this.selectStudent(this.studentIndex + 1));
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
    document.querySelector('[data-panel="exams"]').addEventListener('click', () => this.ensureLoaded());
  }

  get admin() { return window.ojAdmin; }
  get group() { return this.admin?.group || 'control'; }

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

  async ensureLoaded(force = false) {
    if (!this.admin || document.body.classList.contains('auth-locked')) return;
    if (!force && this.loadedGroup === this.group && this.exams.length) return;
    const tbody = document.getElementById('exam-admin-list');
    tbody.innerHTML = '<tr><td colspan="7" class="empty-cell">正在读取...</td></tr>';
    try {
      this.exams = await this.request('admin_exam_list');
      this.loadedGroup = this.group;
      this.renderList();
      this.populateExamSelector();
    } catch (error) {
      tbody.innerHTML = `<tr><td colspan="7" class="empty-cell">${this.escape(error.message)}</td></tr>`;
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
        <td>${this.escape(exam.submitted_students || 0)}</td>
        <td>${this.escape(exam.completed_students || 0)}</td>
        <td><button type="button" class="table-link table-link-button" data-preview-exam="${this.escape(exam.id)}">预览</button> · <button type="button" class="table-link table-link-button" data-edit-exam="${this.escape(exam.id)}">编辑</button> · <button type="button" class="table-link table-link-button" data-grade-exam="${this.escape(exam.id)}">批改</button></td>
      </tr>`).join('') : '<tr><td colspan="7" class="empty-cell">当前组别还没有套卷</td></tr>';
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
    document.getElementById('exam-roster-users').value = (paper.allowedUsers || []).join('\n');
    document.getElementById('exam-roster-status').textContent = paper.allowedUsers?.length
      ? `当前已额外准入 ${paper.allowedUsers.length} 人，可继续追加导入`
      : '已有密码保持不变；仅无密码账号生成随机密码；可多次追加导入';
    document.getElementById('download-exam-roster').disabled = true;
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
        <label class="form-field"><span>分值</span><input class="admin-input" data-p-field="points" type="number" min="0" max="1000" step="0.5" value="${this.escape(part.points)}"></label>
      </div>
      <label class="form-field"><span>小题内容</span><textarea class="admin-input" rows="3" data-p-field="prompt">${this.escape(part.prompt || '')}</textarea></label>
      ${isChoice ? `<div class="form-grid two-columns"><label class="form-field"><span>选项（每行一个）</span><textarea class="admin-input" rows="4" data-p-field="options">${this.escape((part.options || []).join('\n'))}</textarea></label><label class="form-field"><span>正确答案（每行一个，文字须与选项一致）</span><textarea class="admin-input" rows="4" data-p-field="correctAnswers">${this.escape((part.correctAnswers || []).join('\n'))}</textarea></label></div>` : ''}
      ${part.type === 'fill_blank' ? `<label class="form-field"><span>可接受答案（每行一个）</span><textarea class="admin-input" rows="4" data-p-field="correctAnswers">${this.escape((part.correctAnswers || []).join('\n'))}</textarea></label><label class="test-visibility-option compact"><input type="checkbox" data-p-field="caseSensitive" ${part.caseSensitive ? 'checked' : ''}><span><strong>区分大小写</strong><small>不勾选时会忽略首尾空格和大小写</small></span></label>` : ''}
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
      if (!this.editingPaper?.id) throw new Error('请先填写试卷编号并保存一次，再导入额外账户');
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
      status.textContent = `已追加 ${result.added} 人；${existingPasswordUsers.size} 个原密码保持不变，${generated} 个账号生成了新密码。请保存试卷。`;
    } catch (error) {
      this.rosterWorkbook = null;
      status.textContent = `导入失败：${error.message}`;
    }
  }

  parseRosterWorkbook(workbook) {
    const nameHeaders = new Set(['姓名', '学生姓名', '名字', '用户名', 'name', 'username']);
    const passwordHeaders = new Set(['密码', '登录密码', '初始密码', 'password']);
    const users = new Map();
    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName];
      if (!sheet?.['!ref']) continue;
      const range = XLSX.utils.decode_range(sheet['!ref']);
      let headerRow = -1;
      let nameColumn = -1;
      let passwordColumn = -1;
      for (let row = range.s.r; row <= Math.min(range.e.r, range.s.r + 29) && nameColumn < 0; row += 1) {
        for (let column = range.s.c; column <= range.e.c; column += 1) {
          const value = String(sheet[XLSX.utils.encode_cell({ r: row, c: column })]?.v ?? '').trim().toLowerCase().replace(/[\s:：]/g, '');
          if (nameHeaders.has(value)) nameColumn = column;
          if (passwordHeaders.has(value)) passwordColumn = column;
        }
        if (nameColumn >= 0) headerRow = row;
      }
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
        return await this.admin.fetchJson(`${this.admin.config.workerUrl}/?file=problem&name=${encodeURIComponent(indexItem.file)}`);
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

  async loadGrading(examId) {
    if (!examId) return;
    const workspace = document.getElementById('grading-workspace');
    workspace.innerHTML = '<p class="empty-cell">正在读取提交...</p>';
    try {
      [this.paper, this.submissions] = await Promise.all([
        this.request('admin_exam_get', { examId }),
        this.request('admin_exam_submissions', { examId }),
      ]);
      this.studentIndex = -1;
      const partSelect = document.getElementById('grading-part');
      partSelect.innerHTML = '<option value="">选择小题</option>' + this.paper.questions.flatMap(question => question.parts.map(part =>
        `<option value="${this.escape(part.id)}">${this.escape(question.title)} · ${this.escape(part.prompt || part.id)}</option>`
      )).join('');
      this.renderGrading();
      if (this.submissions.length) await this.selectStudent(0);
    } catch (error) {
      workspace.innerHTML = `<p class="empty-cell">${this.escape(error.message)}</p>`;
    }
  }

  renderGrading() {
    const mode = document.getElementById('grading-mode').value;
    document.getElementById('grading-part').hidden = mode !== 'part';
    const formalSubmissions = this.submissions.filter(item => !item.preview);
    const completed = formalSubmissions.filter(item => item.gradingStatus === 'completed').length;
    document.getElementById('grading-summary').textContent = this.paper
      ? `${formalSubmissions.length} 人正式提交 · ${completed} 人完成批改${this.submissions.some(item => item.preview) ? ' · 含管理员预览记录' : ''}`
      : '请选择试卷';
    document.getElementById('grading-student-list').innerHTML = this.submissions.length ? this.submissions.map((submission, index) => `
      <button type="button" class="grading-student ${index === this.studentIndex ? 'active' : ''}" data-grading-student="${index}">
        <strong>${this.escape(submission.username)}${submission.preview ? '（管理员预览）' : ''}</strong><span>${submission.gradedCount}/${submission.totalParts} 题 · ${submission.totalScore}/${this.paper.totalScore} 分</span>
      </button>`).join('') : '<p class="empty-cell">还没有学生提交</p>';
    this.renderWorkspace();
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
    workspace.innerHTML = `<div class="grading-score-summary"><strong>${submission.totalScore} / ${this.paper.totalScore} 分</strong><span>已批改 ${submission.gradedCount}/${submission.totalParts}</span><label><input type="checkbox" data-release-result ${submission.released ? 'checked' : ''}> 向学生发布当前结果</label></div>` + results.map(result => {
      const found = this.findPart(result.partId);
      if (!found) return '';
      const answer = submission.answers[result.partId];
      const answerText = result.type === 'programming'
        ? `${answer?.language || ''}\n\n${answer?.code || ''}`
        : Array.isArray(answer) ? answer.join('、') : String(answer ?? '');
      const statusText = { correct: '正确', incorrect: '错误', graded: '已人工评分', pending: '待人工批改' }[result.status] || result.status;
      return `<section class="grading-part-card" data-grade-part="${this.escape(result.partId)}">
        <div class="grading-part-title"><div><strong>${this.escape(found.question.title)} · ${this.escape(found.part.prompt || found.part.id)}</strong><span>${this.escape(statusText)}${result.blockedByProgramming ? ' · 因编程未通过暂计 0 分' : ''}</span></div><b>${this.escape(result.effectiveScore || 0)} / ${this.escape(result.maxScore)}</b></div>
        <pre class="grading-answer">${this.escape(answerText || '（未作答）')}</pre>
        ${result.judge ? `<p class="grading-judge">编程测试：${result.judge.passedTests}/${result.judge.totalTests} · ${result.judge.totalTime}ms</p>` : ''}
        <div class="grading-form"><label class="form-field"><span>人工评分</span><input class="admin-input" data-grade-score type="number" min="0" max="${this.escape(result.maxScore)}" step="0.5" value="${this.escape(result.manualScore || 0)}"></label><label class="form-field"><span>批注</span><input class="admin-input" data-grade-feedback maxlength="3000" value="${this.escape(result.feedback || '')}" placeholder="可选"></label><button type="button" class="admin-button primary" data-save-grade>保存评分</button></div>
      </section>`;
    }).join('');
  }

  async handleGradingClick(event) {
    const release = event.target.closest('[data-release-result]');
    const save = event.target.closest('[data-save-grade]');
    const submission = this.submissions[this.studentIndex];
    if (!submission || (!release && !save)) return;
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
