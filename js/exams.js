class ExamUI {
  constructor(app) {
    this.app = app;
    this.exams = [];
    this.loadedKey = '';
    this.paper = null;
    this.submission = null;
    this.saveTimer = null;
  }

  init() {
    document.querySelector('[data-view="exams"]').addEventListener('click', () => this.loadList());
    document.getElementById('back-to-exam-list').addEventListener('click', () => {
      this.saveDraft();
      if (this.app.adminExamPreview) {
        window.close();
        if (!window.closed) location.href = 'admin.html';
        return;
      }
      this.app.views.show('exams');
      this.loadList(true);
    });
    document.getElementById('submit-exam').addEventListener('click', () => this.submit());
    document.getElementById('student-exam-form').addEventListener('input', () => {
      clearTimeout(this.saveTimer);
      this.saveTimer = setTimeout(() => this.saveDraft(), 400);
    });
    document.getElementById('student-exam-form').addEventListener('change', event => {
      if (event.target.matches('[data-program-language]')) this.setDefaultProgram(event.target);
      this.saveDraft();
    });
  }

  onGroupChange() {
    this.loadedKey = '';
    this.exams = [];
    this.paper = null;
    this.submission = null;
    const list = document.getElementById('exam-list');
    if (list) list.innerHTML = '<p class="info">⏳ 正在加载套卷...</p>';
    if (this.app.views.currentView === 'exams') this.loadList(true);
  }

  async request(type, payload = {}) {
    const previewTypes = {
      exam_get: 'admin_exam_preview_get',
      exam_submit: 'admin_exam_preview_submit',
    };
    const requestType = this.app.adminExamPreview ? (previewTypes[type] || type) : type;
    const response = await fetch(window.OJ_CONFIG.WORKER_URL, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: requestType,
        username: this.app.username,
        group: this.app.group,
        ...payload,
      }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(result.error || `请求失败 (${response.status})`);
      error.code = result.code;
      throw error;
    }
    return result;
  }

  async loadList(force = false) {
    if (this.app.adminExamPreview) return this.openExam(this.app.adminExamPreview);
    const key = `${this.app.username}:${this.app.group}`;
    if (!force && this.loadedKey === key) return;
    const container = document.getElementById('exam-list');
    container.innerHTML = '<p class="info">⏳ 正在加载套卷...</p>';
    try {
      this.exams = await this.request('exam_list');
      this.loadedKey = key;
      this.renderList();
    } catch (error) {
      if (error.code === 'STUDENT_AUTH_REQUIRED') {
        await this.app._promptUsername({ verifyCurrent: true });
        return this.loadList(true);
      }
      container.innerHTML = `<p class="error">套卷加载失败：${this.escape(error.message)}</p>`;
    }
  }

  renderList() {
    const container = document.getElementById('exam-list');
    if (!this.exams.length) {
      container.innerHTML = `<p class="info">${this.app.group === 'vision' ? '视觉组' : '电控组'}暂无已发布套卷</p>`;
      return;
    }
    container.innerHTML = this.exams.map(exam => {
      const status = exam.submittedAt
        ? exam.gradingStatus === 'completed' ? '批改完成' : `批改中 ${exam.gradedCount}/${exam.totalParts}`
        : '未提交';
      return `<button type="button" class="exam-card" data-open-exam="${this.escape(exam.id)}">
        <div><span class="problem-id">${this.escape(exam.id)}</span><strong>${this.escape(exam.title)}</strong></div>
        <p>${this.escape(exam.description || '综合套卷')}</p>
        <footer><span>总分 ${this.escape(exam.totalScore)}</span><span>${this.escape(status)}</span>${exam.resultVisible ? `<b>${this.escape(exam.achievedScore)} 分</b>` : ''}</footer>
      </button>`;
    }).join('');
    container.querySelectorAll('[data-open-exam]').forEach(button => {
      button.addEventListener('click', () => this.openExam(button.dataset.openExam));
    });
  }

  async openExam(examId) {
    const status = document.getElementById('exam-submit-status');
    status.textContent = '正在读取试卷...';
    this.app.views.show('exam');
    try {
      const result = await this.request('exam_get', { examId });
      this.paper = result.paper;
      this.submission = result.mySubmission;
      this.renderPaper();
      status.textContent = this.submission
        ? `已于 ${new Date(this.submission.submittedAt).toLocaleString()} 提交；再次提交将以新答案作为最终评分依据`
        : this.app.adminExamPreview
          ? '当前以 admin 身份预览；答案会自动保存在本机，提交后可在管理端批改页查看'
          : '答案会自动保存在本机；提交整张试卷后才会进入批改';
      this.renderResult(this.submission);
    } catch (error) {
      status.textContent = `读取失败：${error.message}`;
    }
  }

  draftKey() {
    return this.paper ? `oj_exam_draft:${this.app.username}:${this.app.group}:${this.paper.id}:v${this.paper.version}` : '';
  }

  loadAnswers() {
    let draft = null;
    try { draft = JSON.parse(localStorage.getItem(this.draftKey()) || 'null'); } catch { /* 忽略损坏的本地草稿 */ }
    return draft && typeof draft === 'object' ? draft : (this.submission?.answers || {});
  }

  renderPaper() {
    const paper = this.paper;
    const answers = this.loadAnswers();
    document.getElementById('student-exam-title').textContent = `${paper.id} · ${paper.title}`;
    document.getElementById('student-exam-meta').textContent = `${this.app.group === 'vision' ? '视觉组' : '电控组'} · 总分 ${paper.totalScore} · 第 ${paper.version} 版`;
    const description = document.getElementById('student-exam-description');
    description.innerHTML = paper.description ? this.app._formatMarkdown(paper.description) : '';
    if (paper.description) this.app._enhanceMarkdown(description);
    document.getElementById('student-exam-form').innerHTML = paper.questions.map((question, questionIndex) => `
      <article class="student-exam-question">
        <header><div><span>第 ${questionIndex + 1} 题</span><h3>${this.escape(question.title)}</h3></div><strong>${this.questionPoints(question)} 分</strong></header>
        ${question.scoringMode === 'programming_required' ? '<p class="exam-rule-warning">本大题采用整体评分：编程部分未通过时，整道大题计 0 分。</p>' : ''}
        ${question.description ? `<div class="problem-content exam-question-description">${this.app._formatMarkdown(question.description)}</div>` : ''}
        <div class="student-exam-parts">${question.parts.map((part, partIndex) => this.partHtml(part, partIndex, answers[part.id])).join('')}</div>
      </article>`).join('');
    document.querySelectorAll('.exam-question-description, .exam-part-prompt').forEach(node => this.app._enhanceMarkdown(node));
  }

  questionPoints(question) {
    return Math.round(question.parts.reduce((sum, part) => sum + Number(part.points || 0), 0) * 100) / 100;
  }

  partHtml(part, partIndex, answer) {
    const label = `${partIndex + 1}.`;
    const prompt = `<div class="exam-part-prompt problem-content">${this.app._formatMarkdown(part.prompt || '')}</div>`;
    let control = '';
    if (part.type === 'single_choice') {
      control = `<div class="exam-options">${part.options.map(option => `<label><input type="radio" name="exam-${this.escape(part.id)}" data-answer-part="${this.escape(part.id)}" value="${this.escape(option)}" ${answer === option ? 'checked' : ''}><span>${this.escape(option)}</span></label>`).join('')}</div>`;
    } else if (part.type === 'multiple_choice') {
      const selected = Array.isArray(answer) ? answer : [];
      control = `<div class="exam-options">${part.options.map(option => `<label><input type="checkbox" data-answer-part="${this.escape(part.id)}" value="${this.escape(option)}" ${selected.includes(option) ? 'checked' : ''}><span>${this.escape(option)}</span></label>`).join('')}</div>`;
    } else if (part.type === 'fill_blank') {
      control = `<input class="exam-text-answer" data-answer-part="${this.escape(part.id)}" maxlength="2000" value="${this.escape(answer || '')}" placeholder="请输入答案">`;
    } else if (part.type === 'short_answer') {
      control = `<textarea class="exam-text-answer" data-answer-part="${this.escape(part.id)}" maxlength="30000" rows="6" placeholder="请输入你的回答">${this.escape(answer || '')}</textarea>`;
    } else if (part.type === 'programming') {
      const language = answer?.language || 'c';
      const code = answer?.code || this.languageTemplate(language, part);
      control = `<div class="exam-programming"><div><span>关联题目 ${this.escape(part.problemId)}</span><select data-program-language data-answer-part="${this.escape(part.id)}">${window.LANGUAGES.map(item => `<option value="${this.escape(item.id)}" ${item.id === language ? 'selected' : ''}>${this.escape(item.name)}</option>`).join('')}</select></div><textarea data-program-code="${this.escape(part.id)}" rows="16" spellcheck="false">${this.escape(code)}</textarea></div>`;
    }
    return `<section class="student-exam-part" data-part-id="${this.escape(part.id)}"><div class="exam-part-label"><strong>${label}</strong><span>${this.partTypeName(part.type)} · ${this.escape(part.points)} 分</span></div>${prompt}${control}</section>`;
  }

  partTypeName(type) {
    return { single_choice: '单选', multiple_choice: '多选', fill_blank: '填空', short_answer: '简答', programming: '编程' }[type] || '小题';
  }

  languageTemplate(language, part = null) {
    if (typeof window.getProblemLanguageTemplate === 'function') {
      return window.getProblemLanguageTemplate(language, part || {});
    }
    return window.LANGUAGES.find(item => item.id === language)?.template || '';
  }

  setDefaultProgram(select) {
    const textarea = select.closest('.exam-programming').querySelector('textarea');
    if (!textarea.value.trim() || window.LANGUAGES.some(item => item.template.trim() === textarea.value.trim())) {
      const partId = select.dataset.answerPart;
      const part = this.paper.questions.flatMap(question => question.parts).find(item => item.id === partId);
      textarea.value = this.languageTemplate(select.value, part);
    }
  }

  collectAnswers() {
    const answers = {};
    for (const question of this.paper.questions) {
      for (const part of question.parts) {
        const selector = `[data-answer-part="${CSS.escape(part.id)}"]`;
        if (part.type === 'single_choice') {
          answers[part.id] = document.querySelector(`${selector}:checked`)?.value || '';
        } else if (part.type === 'multiple_choice') {
          answers[part.id] = [...document.querySelectorAll(`${selector}:checked`)].map(input => input.value);
        } else if (part.type === 'programming') {
          answers[part.id] = {
            language: document.querySelector(selector)?.value || 'c',
            code: document.querySelector(`[data-program-code="${CSS.escape(part.id)}"]`)?.value || '',
          };
        } else {
          answers[part.id] = document.querySelector(selector)?.value || '';
        }
      }
    }
    return answers;
  }

  saveDraft() {
    if (!this.paper || !document.getElementById('student-exam-form').children.length) return;
    try { localStorage.setItem(this.draftKey(), JSON.stringify(this.collectAnswers())); } catch { /* 本机空间不足不阻塞作答 */ }
  }

  async submit() {
    if (!this.paper) return;
    const button = document.getElementById('submit-exam');
    const status = document.getElementById('exam-submit-status');
    const answers = this.collectAnswers();
    button.disabled = true;
    button.textContent = '正在自动批改...';
    status.textContent = '正在保存答案并自动批改选择题、填空题和编程题；编程题较多时需要稍等。';
    try {
      const result = await this.request('exam_submit', { examId: this.paper.id, answers });
      localStorage.removeItem(this.draftKey());
      this.submission = { ...result, answers, submittedAt: Date.now() };
      status.textContent = `提交成功：这是第 ${result.attemptNo} 次提交，已完成 ${result.gradedCount}/${result.totalParts} 个小题的批改。`;
      this.renderResult(this.submission);
      this.loadedKey = '';
    } catch (error) {
      status.textContent = `提交失败：${error.message}。答案仍保存在本机，可以稍后重试。`;
    } finally {
      button.disabled = false;
      button.textContent = '提交整张试卷';
    }
  }

  renderResult(submission) {
    const container = document.getElementById('exam-result');
    if (!submission) {
      container.innerHTML = '';
      return;
    }
    if (!submission.resultVisible) {
      container.innerHTML = `<div class="exam-result-card"><h3>试卷已提交</h3><p>当前已批改 ${this.escape(submission.gradedCount)}/${this.escape(submission.totalParts)} 个小题。批改结果暂未开放，请等待管理员完成或发布成绩。</p></div>`;
      return;
    }
    const results = submission.grading?.partResults || [];
    container.innerHTML = `<div class="exam-result-card"><h3>当前得分：${this.escape(submission.totalScore)} / ${this.escape(this.paper.totalScore)}</h3><div class="exam-result-parts">${results.map(result => `<div><span>${this.escape(result.partId)}</span><strong class="${result.status === 'correct' ? 'success' : result.status === 'pending' ? 'warning' : 'error'}">${this.escape({ correct: '正确', incorrect: '错误', pending: '待人工批改', graded: '已评分' }[result.status] || result.status)}</strong><b>${this.escape(result.effectiveScore || 0)} / ${this.escape(result.maxScore)}</b>${result.feedback ? `<p>${this.escape(result.feedback)}</p>` : ''}</div>`).join('')}</div></div>`;
  }

  escape(value) {
    const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return String(value ?? '').replace(/[&<>"']/g, character => entities[character]);
  }
}
