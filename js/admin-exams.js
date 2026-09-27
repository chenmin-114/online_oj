class ExamAdmin {
  constructor() {
    this.exams = [];
    this.editingPaper = null;
    this.paper = null;
    this.submissions = [];
    this.studentIndex = -1;
    this.loadedGroup = '';
  }

  init() {
    document.getElementById('show-exam-editor').addEventListener('click', () => this.newExam());
    document.getElementById('close-exam-editor').addEventListener('click', () => this.closeEditor());
    document.getElementById('add-exam-question').addEventListener('click', () => this.addQuestion());
    document.getElementById('exam-editor').addEventListener('submit', event => this.saveExam(event));
    document.getElementById('exam-question-editor').addEventListener('click', event => this.handleEditorClick(event));
    document.getElementById('exam-question-editor').addEventListener('change', event => this.handleEditorChange(event));
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
      problemId: type === 'programming' ? (this.admin.problems[0]?.id || '') : undefined,
    };
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
      ${part.type === 'programming' ? `<label class="form-field"><span>关联现有编程题</span><select class="admin-input" data-p-field="problemId"><option value="">请选择题目</option>${problemOptions}</select><small>复用该题的语言模板和隐藏测试点，不额外复制测试数据。</small></label>` : ''}
    </section>`;
  }

  syncEditorState() {
    if (!this.editingPaper) return;
    this.editingPaper.id = document.getElementById('exam-id').value.trim().toUpperCase();
    this.editingPaper.title = document.getElementById('exam-title').value.trim();
    this.editingPaper.description = document.getElementById('exam-description').value;
    this.editingPaper.status = document.getElementById('exam-status').value;
    this.editingPaper.resultPolicy = document.getElementById('exam-result-policy').value;
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

  addQuestion() {
    this.syncEditorState();
    this.editingPaper.questions.push(this.emptyQuestion(this.editingPaper.questions.length + 1));
    this.renderEditor();
  }

  handleEditorClick(event) {
    const removeQuestion = event.target.closest('[data-remove-question]');
    const removePart = event.target.closest('[data-remove-part]');
    const addPart = event.target.closest('[data-add-part]');
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

  async saveExam(event) {
    event.preventDefault();
    this.syncEditorState();
    const status = document.getElementById('exam-save-status');
    status.textContent = '正在保存...';
    try {
      const result = await this.request('admin_exam_save', { paper: this.editingPaper });
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
    const preview = window.open(url.href, '_blank', 'noopener');
    if (!preview) this.admin.toast('浏览器拦截了预览窗口，请允许本站打开新窗口');
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
