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
    this.timingOffset = 0;
    this.timingTimer = null;
    this.autoFinalizeTimer = null;
    this.serverDraft = null;
    this.serverSaveInFlight = null;
    this.graceSavedFor = null;
    this.finalizeInFlight = null;
    this.finalizeSucceeded = false;
    this.finalizeError = '';
    this.finalizeRetryTimer = null;
    this.finalizeDeadlineTimer = null;
    this.exitTimer = null;
    this.listTimingOffset = 0;
    this.listClockTimer = null;
  }

  init() {
    const answerSheetButton = document.getElementById('download-exam-docx');
    const answerSheetImport = document.querySelector('.exam-docx-import');
    // 学生统一在线作答；Word 答题卡只保留给管理员预览检查使用。
    answerSheetButton.hidden = !this.app.adminExamPreview;
    answerSheetImport.hidden = !this.app.adminExamPreview;
    document.querySelector('[data-view="exams"]').addEventListener('click', () => this.loadList(true, Boolean(this.loadedKey)));
    document.getElementById('back-to-exam-list').addEventListener('click', () => {
      clearInterval(this.timingTimer);
      clearInterval(this.finalizeRetryTimer);
      clearTimeout(this.finalizeDeadlineTimer);
      clearTimeout(this.exitTimer);
      clearTimeout(this.app.timeSyncTimer);
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
    this.listClockTimer = setInterval(() => this.updateListClocks(), 1000);
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
      const serverTime = exams.find(exam => Number.isFinite(Number(exam?.timing?.serverTime)))?.timing?.serverTime;
      if (serverTime) this.listTimingOffset = Number(serverTime) - Date.now();
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
      const enterAllowed = allowed && exam.enterAllowed !== false;
      const submitted = Boolean(exam.submittedAt);
      const gradingText = submitted
        ? (exam.gradingStatus === 'completed' ? '批改完成' : `批改中 ${exam.gradedCount}/${exam.totalParts}`)
        : '';
      const timingState = exam.timing?.state || 'unrestricted';
      const timingText = this.listTimingText(exam.timing, Date.now() + this.listTimingOffset);
      return `<button type="button" class="exam-card${enterAllowed ? '' : ' is-locked'}" data-open-exam="${this.escape(exam.id)}" data-access-allowed="${allowed ? '1' : '0'}" data-enter-allowed="${enterAllowed ? '1' : '0'}" aria-disabled="${enterAllowed ? 'false' : 'true'}">
        <div><span class="problem-id">${this.escape(exam.id)}</span><strong>${this.escape(exam.title)}</strong>${!allowed ? '<span class="exam-card-lock">🔒 无权限</span>' : !enterAllowed ? '<span class="exam-card-lock">⏳ 未开始</span>' : ''}</div>
        <p>${this.escape(exam.description || '综合套卷')}</p>
        <footer><span>总分 ${this.escape(exam.totalScore)}</span>${exam.resultVisible ? `<b>${this.escape(exam.achievedScore)} 分</b>` : ''}<span class="exam-card-statuses"><span class="exam-status-pill timing ${this.escape(timingState)}" data-exam-timing="${this.escape(exam.id)}">${this.escape(timingText)}</span><span class="exam-status-pill submission ${submitted ? 'submitted' : 'pending'}">${submitted ? '已提交' : '未提交'}</span>${gradingText ? `<span>${this.escape(gradingText)}</span>` : ''}</span></footer>
      </button>`;
    }).join('');
    container.querySelectorAll('[data-open-exam]').forEach(button => {
      button.addEventListener('click', () => {
        if (button.dataset.accessAllowed !== '1') {
          const exam = this.exams.find(item => item.id === button.dataset.openExam);
          alert(exam?.timing?.state === 'ended' ? '这张套卷已经结束，管理员没有开放观看权限' : '暂无权限，请向管理员申请');
          return;
        }
        if (button.dataset.enterAllowed !== '1') {
          alert('尚未到答题开放时间，请等待考试开始；如需提前进入，请联系管理员单独授权。');
          return;
        }
        this.openExam(button.dataset.openExam);
      });
    });
  }

  listTimingText(timing, now = Date.now()) {
    if (!timing || timing.state === 'unrestricted') return '不限时';
    if (timing.state === 'upcoming') return `还有 ${this.app._duration(Math.max(0, timing.nextStart - now))} 开始`;
    if (timing.state === 'paused') return `已暂停答卷 · 还有 ${this.app._duration(Math.max(0, timing.nextStart - now))} 继续`;
    if (timing.state === 'active') return `还有 ${this.app._duration(Math.max(0, timing.windowEnd - now))} 结束`;
    if (timing.state === 'grace') return '答案已冻结';
    return '已结束';
  }

  updateListClocks() {
    if (this.app.views.currentView !== 'exams' || !this.exams.length) return;
    const now = Date.now() + this.listTimingOffset;
    let boundaryPassed = false;
    for (const exam of this.exams) {
      const node = document.querySelector(`[data-exam-timing="${CSS.escape(exam.id)}"]`);
      if (!node) continue;
      node.textContent = this.listTimingText(exam.timing, now);
      const target = exam.timing?.state === 'active' ? exam.timing.windowEnd
        : ['upcoming', 'paused'].includes(exam.timing?.state) ? exam.timing.nextStart
        : exam.timing?.state === 'grace' ? exam.timing.graceEndsAt : 0;
      if (target && now >= target) boundaryPassed = true;
    }
    if (boundaryPassed && !this.refreshing && Date.now() - this.lastRefreshAt > 3000) this.loadList(true, true);
  }

  async openExam(examId) {
    clearTimeout(this.autoFinalizeTimer);
    clearInterval(this.finalizeRetryTimer);
    clearTimeout(this.finalizeDeadlineTimer);
    clearTimeout(this.exitTimer);
    this.graceSavedFor = null;
    this.finalizeInFlight = null;
    this.finalizeSucceeded = false;
    this.finalizeError = '';
    this.finalizeRetryTimer = null;
    this.finalizeDeadlineTimer = null;
    this.exitTimer = null;
    const status = document.getElementById('exam-submit-status');
    document.getElementById('exam-answer-sheet-status').textContent = '';
    document.getElementById('download-exam-docx').disabled = true;
    status.textContent = '正在读取试卷...';
    this.app.views.show('exam');
    try {
      const result = await this.request('exam_get', { examId });
      this.paper = result.paper;
      this.submission = result.mySubmission;
      this.serverDraft = result.timedDraft;
      this.lastServerDraft = this.serverDraft?.answers ? JSON.stringify(this.serverDraft.answers) : '';
      this.timingOffset = Number(result.timing?.serverTime || this.paper.availability?.status?.serverTime || Date.now()) - Date.now();
      this.app.lastTimeSyncAt = Date.now();
      this.app._trackExamView(this.paper.id);
      this.renderPaper();
      document.getElementById('download-exam-docx').disabled = !this.app.adminExamPreview;
      status.textContent = this.submission
        ? `已于 ${new Date(this.submission.submittedAt).toLocaleString()} 提交；再次提交将以新答案作为最终评分依据`
        : this.app.adminExamPreview
          ? '当前以 admin 身份预览；答案会自动保存在本机，提交后可在管理端批改页查看'
          : '答案会自动保存在本机；提交整张试卷后才会进入批改';
      this.renderResult(this.submission);
      this.startTiming();
    } catch (error) {
      status.textContent = `读取失败：${error.message}`;
    }
  }

  async downloadAnswerSheet() {
    if (!this.app.adminExamPreview || !this.paper) return;
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
    if (!this.app.adminExamPreview || !file || !this.paper) return;
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
    return draft && typeof draft === 'object' ? draft : (this.serverDraft?.answers || this.submission?.answers || {});
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
      return window.getProblemLanguageTemplate(language, part?.problem || part || {});
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
    this.applyTimingState();
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
    const answers = this.collectAnswers();
    try { localStorage.setItem(this.draftKey(), JSON.stringify(answers)); } catch { /* 本机空间不足不阻塞作答 */ }
    clearTimeout(this.serverSaveTimer);
    this.serverSaveTimer = setTimeout(() => this.saveServerDraft(answers), 800);
  }

  async saveServerDraft(answers = this.collectAnswers(), force = false, adminConfirmed = false) {
    const state = this.currentTiming();
    const mayUseServerUploadBuffer = force
      && this.app._withinServerDraftUploadWindow(this.paper?.availability, this.timingOffset);
    if ((this.app.adminImpersonation && !adminConfirmed)
      || !this.paper?.availability?.enabled
      || (!['active', 'grace'].includes(state.state) && !mayUseServerUploadBuffer)
      || this.app.adminExamPreview) return false;
    if (this.serverSaveInFlight) {
      await this.serverSaveInFlight;
      const latestAnswers = this.collectAnswers();
      if (JSON.stringify(latestAnswers) !== this.lastServerDraft) return this.saveServerDraft(latestAnswers, force, adminConfirmed);
      return true;
    }
    const signature = JSON.stringify(answers);
    if (signature === this.lastServerDraft) return true;
    this.serverSaveInFlight = (async () => {
      const result = await this.request('timed_draft_save', {
        resourceType: 'exam', resourceId: this.paper.id, payload: answers,
        adminImpersonationConfirmed: adminConfirmed,
      });
      this.lastServerDraft = signature;
      this.app._applyServerTime(result.timing?.serverTime || result.updatedAt, 'exam');
      return true;
    })().catch(() => false).finally(() => { this.serverSaveInFlight = null; });
    return this.serverSaveInFlight;
  }

  currentTiming() {
    return this.app._timingState(this.paper?.availability, this.timingOffset);
  }

  applyServerAvailability(availability) {
    if (!this.paper || !availability) return;
    const changed = JSON.stringify(this.paper.availability?.windows || [])
      !== JSON.stringify(availability.windows || []);
    this.paper.availability = availability;
    if (!changed) return;
    clearTimeout(this.autoFinalizeTimer);
    clearInterval(this.finalizeRetryTimer);
    clearTimeout(this.finalizeDeadlineTimer);
    clearTimeout(this.exitTimer);
    this.autoFinalizeTimer = null;
    this.graceSavedFor = null;
    this.precloseSavedFor = null;
    this.finalizeInFlight = null;
    this.finalizeSucceeded = false;
    this.finalizeError = '';
    this.exitTimer = null;
  }

  startTiming() {
    clearInterval(this.timingTimer);
    clearTimeout(this.autoFinalizeTimer);
    this.autoFinalizeTimer = null;
    this.applyTimingState();
    if (this.paper?.availability?.enabled && !this.app.adminExamPreview) {
      this.timingTimer = setInterval(() => this.applyTimingState(), 1000);
      setTimeout(() => this.saveServerDraft(), 500);
      this.app._scheduleServerTimeSync();
    }
  }

  applyTimingState() {
    if (!this.paper) return;
    const state = this.currentTiming();
    const banner = document.getElementById(this.programmingContext ? 'problem-timing-banner' : 'exam-timing-banner');
    const now = Date.now() + this.timingOffset;
    banner.hidden = !this.paper.availability?.enabled;
    banner.className = `timing-banner ${state.state === 'active' ? 'active' : state.state === 'grace' ? 'warning' : 'closed'}`;
    if (state.state === 'upcoming') banner.textContent = `尚未开始 · ${new Date(state.nextStart).toLocaleString()} 开放（还有 ${this.app._duration(state.nextStart - now)}）`;
    else if (state.state === 'paused') banner.textContent = `已暂停答卷 · 下一时段还有 ${this.app._duration(state.nextStart - now)} 开始`;
    else if (state.state === 'active') banner.textContent = `答题进行中 · 距本时段结束 ${this.app._duration(state.windowEnd - now)} · 草稿自动保存到服务器`;
    else if (state.state === 'grace') banner.textContent = `答案已锁定 · ${this.app._duration(state.graceEndsAt - now)} 后自动提交`;
    else if (state.state === 'ended') banner.textContent = '全部答题时间已经结束，当前仅可查看。';
    const locked = !this.app.adminExamPreview && this.paper.availability?.enabled && !state.canEdit;
    document.querySelectorAll('#student-exam-form input, #student-exam-form textarea, #student-exam-form button').forEach(node => { node.disabled = locked; });
    document.getElementById('import-exam-docx').disabled = locked;
    if (this.programmingContext) {
      this.app.editor?.setReadOnly(locked);
      ['language-select', 'reset-code-btn', 'run-btn', 'custom-input', 'clear-input-btn'].forEach(id => { const node = document.getElementById(id); if (node) node.disabled = locked; });
    }
    const submit = document.getElementById('submit-exam');
    submit.disabled = !this.app.adminExamPreview && this.paper.availability?.enabled && !state.canSubmit;
    submit.textContent = state.state === 'grace' ? '确认提交冻结答案' : '提交整张试卷';
    if (state.state === 'active' && state.windowEnd - now <= 5000 && this.precloseSavedFor !== state.windowEnd) {
      this.precloseSavedFor = state.windowEnd;
      this.saveServerDraft();
    }
    if (!this.app.adminImpersonation && state.state === 'grace' && this.graceSavedFor !== state.windowEnd) {
      this.graceSavedFor = state.windowEnd;
      this.submitTimedInBackground();
    }
    if (!this.app.adminImpersonation && state.state === 'grace' && !this.autoFinalizeTimer) {
      this.autoFinalizeTimer = setTimeout(
        () => this.beginTimedAutoReport(state.windowEnd),
        Math.max(0, state.graceEndsAt - now),
      );
    }
  }

  submitTimedInBackground(adminConfirmed = false) {
    if (this.finalizeSucceeded) return Promise.resolve({ success: true });
    if (this.finalizeInFlight) return this.finalizeInFlight;
    this.finalizeInFlight = (async () => {
      const saved = await this.saveServerDraft(this.collectAnswers(), true, adminConfirmed);
      if (!saved && this.app._withinServerDraftUploadWindow(this.paper?.availability, this.timingOffset)) {
        throw new Error('截止答案还未上传成功');
      }
      const result = await this.request('timed_finalize', {
        resourceType: 'exam', resourceId: this.paper.id,
        adminImpersonationConfirmed: adminConfirmed,
      });
      this.finalizeSucceeded = true;
      this.finalizeError = '';
      return { success: true, result };
    })().catch(error => {
      this.finalizeError = error?.message || '提交失败';
      return { success: false, error: this.finalizeError };
    }).finally(() => { this.finalizeInFlight = null; });
    return this.finalizeInFlight;
  }

  finishTimedAndExit(success, message) {
    if (this.exitTimer) return;
    clearInterval(this.finalizeRetryTimer);
    clearTimeout(this.finalizeDeadlineTimer);
    clearTimeout(this.autoFinalizeTimer);
    const status = document.getElementById('exam-submit-status');
    status.textContent = `${success ? '✅' : '❌'} ${message}，5 秒后退出答题页面`;
    if (success) localStorage.removeItem(this.draftKey());
    this.exitTimer = setTimeout(() => {
      clearInterval(this.timingTimer);
      clearTimeout(this.app.timeSyncTimer);
      this.clearProgrammingContext();
      this.app.views.show('exams');
      this.loadList(true);
    }, 5000);
  }

  beginTimedAutoReport(windowEnd) {
    if (this.exitTimer) return;
    const status = document.getElementById('exam-submit-status');
    status.textContent = '⏳ 正在自动提交截止答案...';
    const attempt = () => this.submitTimedInBackground().then(outcome => {
      if (outcome.success) {
        this.finishTimedAndExit(true, '自动提交成功');
      } else if (!this.exitTimer) {
        status.textContent = `❌ 暂未提交成功：${outcome.error}，将在后台继续重试`;
      }
    });
    attempt();
    this.finalizeRetryTimer = setInterval(attempt, 5000);
    const finalAt = windowEnd + 60 * 1000;
    const remaining = Math.max(0, finalAt - (Date.now() + this.timingOffset));
    this.finalizeDeadlineTimer = setTimeout(() => {
      clearInterval(this.finalizeRetryTimer);
      if (this.finalizeSucceeded) this.finishTimedAndExit(true, '自动提交成功');
      else this.finishTimedAndExit(false, `自动提交未成功：${this.finalizeError || '网络超时'}`);
    }, remaining);
  }

  async finalizeTimed(adminConfirmed = false) {
    if (!this.paper?.availability?.enabled || this.app.adminExamPreview) return;
    const status = document.getElementById('exam-submit-status');
    status.textContent = '⏳ 正在确认截止答案...';
    const outcome = await this.submitTimedInBackground(adminConfirmed);
    if (outcome.success) this.finishTimedAndExit(true, '提交成功');
    else status.textContent = `❌ 提交失败：${outcome.error}，系统会在剩余时间内继续重试`;
  }

  async submit() {
    if (!this.paper) return;
    const timing = this.currentTiming();
    if (!this.app.adminExamPreview && timing.state === 'grace') {
      if (!this.app.confirmAdminImpersonationAction(`提交套卷《${this.paper.title}》的冻结答案`)) return;
      return this.finalizeTimed(this.app.adminImpersonation);
    }
    if (!this.app.adminExamPreview && this.paper.availability?.enabled && !timing.canEdit) return;
    const button = document.getElementById('submit-exam');
    const status = document.getElementById('exam-submit-status');
    const answers = this.collectAnswers();
    if (!this.app.confirmAdminImpersonationAction(`提交套卷《${this.paper.title}》`)) return;
    button.disabled = true;
    button.textContent = '正在自动批改...';
    status.textContent = '正在保存答案并自动批改选择题、填空题和编程题；编程题较多时需要稍等。';
    try {
      const result = await this.request('exam_submit', {
        examId: this.paper.id,
        answers,
        adminImpersonationConfirmed: this.app.adminImpersonation,
      });
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
    container.innerHTML = `<div class="exam-result-card"><h3>当前得分：${this.escape(submission.totalScore)} / ${this.escape(this.paper.totalScore)}</h3><div class="exam-result-parts">${results.map(result => {
      const feedback = String(result.feedback || '').trim();
      return `<div><span>${this.escape(result.partId)}</span><strong class="${result.status === 'correct' ? 'success' : result.status === 'pending' ? 'warning' : 'error'}">${this.escape({ correct: '正确', incorrect: '错误', pending: '待人工批改', graded: '已评分' }[result.status] || result.status)}</strong><b>${this.escape(result.effectiveScore || 0)} / ${this.escape(result.maxScore)}</b>${feedback ? `<p>${this.escape(feedback)}</p>` : ''}</div>`;
    }).join('')}</div></div>`;
  }

  escape(value) {
    const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return String(value ?? '').replace(/[&<>"']/g, character => entities[character]);
  }
}
