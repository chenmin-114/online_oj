class ExamUI {
  constructor(app) {
    this.app = app;
    this.exams = [];
    this.loadedKey = '';
    this.paper = null;
    this.submission = null;
    this.answers = {};
    this.programmingContext = null;
    this.saveTimer = null;
    this.refreshing = false;
    this.refreshTimer = null;
    this.lastRefreshAt = 0;
  }

  init() {
    document.querySelector('[data-view="exams"]').addEventListener('click', () => this.loadList(true, Boolean(this.loadedKey)));
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
    document.getElementById('download-exam-docx').addEventListener('click', () => this.downloadAnswerSheet());
    document.getElementById('import-exam-docx').addEventListener('change', event => this.importAnswerSheet(event.target));
    document.getElementById('student-exam-form').addEventListener('input', () => {
      clearTimeout(this.saveTimer);
      this.saveTimer = setTimeout(() => this.saveDraft(), 400);
    });
    document.getElementById('student-exam-form').addEventListener('change', () => {
      this.saveDraft();
    });
    document.getElementById('student-exam-form').addEventListener('click', event => {
      const button = event.target.closest('[data-open-exam-problem]');
      if (button) this.openProgrammingProblem(button.dataset.openExamProblem);
    });
    document.getElementById('back-to-exam-from-problem').addEventListener('click', () => {
      if (this.app.adminProblemPreview) window.close();
      else this.returnFromProgrammingProblem();
    });
    this.refreshTimer = setInterval(() => this.autoRefresh(), 600000);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) this.autoRefresh();
    });
    window.addEventListener('focus', () => this.autoRefresh());
  }

  async autoRefresh() {
    if (document.hidden || this.refreshing || this.app.adminExamPreview || this.app.adminProblemPreview) return;
    if (Date.now() - this.lastRefreshAt < 5000) return;
    const view = this.app.views.currentView;
    if (view !== 'exams' && view !== 'exam') return;
    this.refreshing = true;
    this.lastRefreshAt = Date.now();
    try {
      if (view === 'exams') {
        await this.loadList(true, true);
      } else if (this.paper && this.submission) {
        const result = await this.request('exam_get', { examId: this.paper.id });
        if (this.app.views.currentView !== 'exam' || result.paper?.id !== this.paper.id) return;
        const unchanged = this.submissionSignature(result.mySubmission) === this.submissionSignature(this.submission);
        this.submission = result.mySubmission;
        if (unchanged) return;
        this.renderResult(this.submission);
        document.getElementById('exam-submit-status').textContent = this.submission
          ? `已于 ${new Date(this.submission.submittedAt).toLocaleString()} 提交；批改状态会自动更新`
          : '答案会自动保存在本机；提交整张试卷后才会进入批改';
      }
    } catch {
      // 静默刷新失败时保留当前数据，下次自动重试，不打断学生作答。
    } finally {
      this.refreshing = false;
    }
  }

  submissionSignature(submission) {
    if (!submission) return '';
    return JSON.stringify({
      gradingStatus: submission.gradingStatus,
      gradedCount: submission.gradedCount,
      totalParts: submission.totalParts,
      resultVisible: submission.resultVisible,
      totalScore: submission.totalScore,
      grading: submission.grading,
    });
  }

  onGroupChange() {
    this.loadedKey = '';
    this.exams = [];
    this.paper = null;
    this.submission = null;
    this.answers = {};
    this.clearProgrammingContext();
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

  async loadList(force = false, silent = false) {
    if (this.app.adminExamPreview) return this.openExam(this.app.adminExamPreview);
    const key = `${this.app.username}:${this.app.group}`;
    if (!force && this.loadedKey === key) return;
    const container = document.getElementById('exam-list');
    if (!silent) container.innerHTML = '<p class="info">⏳ 正在加载套卷...</p>';
    try {
      const exams = await this.request('exam_list');
      if (`${this.app.username}:${this.app.group}` !== key) return;
      if (silent && JSON.stringify(exams) === JSON.stringify(this.exams)) {
        this.loadedKey = key;
        return;
      }
      this.exams = exams;
      this.loadedKey = key;
      this.renderList();
    } catch (error) {
      if (error.code === 'STUDENT_AUTH_REQUIRED') {
        await this.app._promptUsername({ verifyCurrent: true });
        return this.loadList(true);
      }
      if (!silent) container.innerHTML = `<p class="error">套卷加载失败：${this.escape(error.message)}</p>`;
    }
  }

  renderList() {
    const container = document.getElementById('exam-list');
    if (!this.exams.length) {
      container.innerHTML = `<p class="info">${this.app.group === 'vision' ? '视觉组' : '电控组'}暂无已发布套卷</p>`;
      return;
    }
    container.innerHTML = this.exams.map(exam => {
      const allowed = exam.accessAllowed !== false;
      const status = !allowed
        ? '无权限'
        : exam.submittedAt
        ? exam.gradingStatus === 'completed' ? '批改完成' : `批改中 ${exam.gradedCount}/${exam.totalParts}`
        : '未提交';
      return `<button type="button" class="exam-card${allowed ? '' : ' is-locked'}" data-open-exam="${this.escape(exam.id)}" data-access-allowed="${allowed ? '1' : '0'}" aria-disabled="${allowed ? 'false' : 'true'}">
        <div><span class="problem-id">${this.escape(exam.id)}</span><strong>${this.escape(exam.title)}</strong>${allowed ? '' : '<span class="exam-card-lock">🔒 无权限</span>'}</div>
        <p>${this.escape(exam.description || '综合套卷')}</p>
        <footer><span>总分 ${this.escape(exam.totalScore)}</span><span>${this.escape(status)}</span>${exam.resultVisible ? `<b>${this.escape(exam.achievedScore)} 分</b>` : ''}</footer>
      </button>`;
    }).join('');
    container.querySelectorAll('[data-open-exam]').forEach(button => {
      button.addEventListener('click', () => {
        if (button.dataset.accessAllowed !== '1') {
          alert('暂无权限，请向管理员申请');
          return;
        }
        this.openExam(button.dataset.openExam);
      });
    });
  }

  async openExam(examId) {
    const status = document.getElementById('exam-submit-status');
    document.getElementById('exam-answer-sheet-status').textContent = '';
    document.getElementById('download-exam-docx').disabled = true;
    status.textContent = '正在读取试卷...';
    this.app.views.show('exam');
    try {
      const result = await this.request('exam_get', { examId });
      this.paper = result.paper;
      this.submission = result.mySubmission;
      this.app._trackExamView(this.paper.id);
      this.renderPaper();
      document.getElementById('download-exam-docx').disabled = false;
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

  async downloadAnswerSheet() {
    if (!this.paper) return;
    const button = document.getElementById('download-exam-docx');
    const status = document.getElementById('exam-answer-sheet-status');
    button.disabled = true;
    status.textContent = '正在生成包含完整题目的 Word 答题卡...';
    try {
      await window.ExamDocx.download(this.paper, this.collectAnswers(), this.app.username, this.app.group);
      status.textContent = '答题卡已下载。请保留答案区域标记，填写后可在这里导入。';
    } catch (error) {
      status.textContent = `答题卡生成失败：${error.message}`;
    } finally {
      button.disabled = false;
    }
  }

  async importAnswerSheet(input) {
    const file = input.files?.[0];
    input.value = '';
    if (!file || !this.paper) return;
    const status = document.getElementById('exam-answer-sheet-status');
    status.textContent = '正在读取 Word 答题卡...';
    try {
      const currentAnswers = this.collectAnswers();
      const result = await window.ExamDocx.import(file, this.paper);
      this.answers = { ...currentAnswers, ...result.answers };
      localStorage.setItem(this.draftKey(), JSON.stringify(this.answers));
      this.renderPaper();
      status.textContent = `已从答题卡填入 ${result.imported} 个小题，答案已保存到本机草稿；请检查后再提交。`;
    } catch (error) {
      status.textContent = `答题卡导入失败：${error.message}`;
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
    for (const part of paper.questions.flatMap(question => question.parts)) {
      if (part.type !== 'programming' || answers[part.id]?.code !== undefined) continue;
      const language = this.defaultProgrammingLanguage(part);
      answers[part.id] = { language, code: this.languageTemplate(language, part) };
    }
    this.answers = answers;
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
    const promptContent = part.prompt || '';
    const prompt = `<div class="exam-part-prompt problem-content">${this.app._formatMarkdown(promptContent)}</div>`;
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
      const problemTitle = part.problem?.title || '完整编程题';
      const needsResubmission = this.app.resubmissionNotices.some(notice => notice.problemId === part.problemId);
      const hasEditedCode = Boolean(answer?.code && answer.code.trim()
        && answer.code.trim() !== this.languageTemplate(answer.language || 'c', part).trim());
      control = `<div class="exam-programming-link-card">
        <div><span>关联题目 ${this.escape(part.problemId)}</span><strong>${this.escape(problemTitle)}</strong><small class="${needsResubmission ? 'warning' : ''}">${needsResubmission ? '管理员要求重新提交这道编程题' : hasEditedCode ? '代码已保存到本套卷草稿' : '尚未填写代码'}</small></div>
        <button type="button" class="btn btn-primary" data-open-exam-problem="${this.escape(part.id)}">打开完整编程题 →</button>
      </div>`;
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

  defaultProgrammingLanguage(part) {
    return part?.pythonJudgeMode === 'function' || this.app.group === 'vision' ? 'python' : 'c';
  }

  collectAnswers() {
    const answers = { ...this.answers };
    for (const question of this.paper.questions) {
      for (const part of question.parts) {
        const selector = `[data-answer-part="${CSS.escape(part.id)}"]`;
        if (part.type === 'single_choice') {
          answers[part.id] = document.querySelector(`${selector}:checked`)?.value || '';
        } else if (part.type === 'multiple_choice') {
          answers[part.id] = [...document.querySelectorAll(`${selector}:checked`)].map(input => input.value);
        } else if (part.type === 'programming') {
          // 编程代码在完整题目页编辑，这里保留已经写入草稿的答案。
          const language = this.defaultProgrammingLanguage(part);
          answers[part.id] = answers[part.id] || { language, code: this.languageTemplate(language, part) };
        } else {
          answers[part.id] = document.querySelector(selector)?.value || '';
        }
      }
    }
    this.answers = answers;
    return answers;
  }

  openProgrammingProblem(partId) {
    const part = this.paper?.questions.flatMap(question => question.parts)
      .find(item => item.id === partId && item.type === 'programming');
    if (!part?.problem) {
      alert('完整题面暂时无法读取，请刷新套卷后重试');
      return;
    }
    this.saveDraft();
    this.programmingContext = { partId, part };
    this.app.openExamProgrammingProblem(part);
  }

  restoreProgrammingAnswer() {
    if (!this.programmingContext) return;
    const { partId, part } = this.programmingContext;
    const defaultLanguage = this.defaultProgrammingLanguage(part);
    const answer = this.answers[partId] || { language: defaultLanguage, code: this.languageTemplate(defaultLanguage, part) };
    const language = window.LANGUAGES.some(item => item.id === answer.language) ? answer.language : defaultLanguage;
    document.getElementById('language-select').value = language;
    this.app.editor.setLanguage(language);
    this.app.isRestoringCode = true;
    this.app.editor.setCode(typeof answer.code === 'string' ? answer.code : this.languageTemplate(language, part));
    this.app.isRestoringCode = false;
    this.captureProgrammingCode(this.app.editor.getCode(), language);
  }

  captureProgrammingCode(code = this.app.editor?.getCode(), language = document.getElementById('language-select')?.value) {
    if (!this.programmingContext || this.app.isRestoringCode || typeof code !== 'string') return;
    this.answers[this.programmingContext.partId] = { language: language || 'c', code };
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveDraft(), 300);
  }

  changeProgrammingLanguage(language) {
    if (!this.programmingContext) return false;
    const { partId, part } = this.programmingContext;
    const current = this.answers[partId] || {};
    const currentTemplate = this.languageTemplate(current.language || 'c', part).trim();
    const currentCode = String(this.app.editor.getCode() || '');
    const nextCode = !currentCode.trim() || currentCode.trim() === currentTemplate
      ? this.languageTemplate(language, part)
      : currentCode;
    this.app.editor.setLanguage(language);
    this.app.isRestoringCode = true;
    this.app.editor.setCode(nextCode);
    this.app.isRestoringCode = false;
    this.answers[partId] = { language, code: nextCode };
    this.saveDraft();
    return true;
  }

  returnFromProgrammingProblem() {
    if (!this.programmingContext) return;
    this.captureProgrammingCode();
    this.saveDraft();
    this.clearProgrammingContext();
    this.renderPaper();
    this.app.views.show('exam');
  }

  leaveProgrammingProblem() {
    if (!this.programmingContext) return;
    this.captureProgrammingCode();
    this.saveDraft();
    this.clearProgrammingContext();
  }

  clearProgrammingContext() {
    this.programmingContext = null;
    const context = document.getElementById('exam-problem-context');
    if (context) context.hidden = true;
    const submit = document.getElementById('submit-btn');
    if (submit) submit.textContent = '🏁 提交';
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
