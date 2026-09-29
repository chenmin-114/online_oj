class ExamDocx {
  static xmlEscape(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  static plainText(value) {
    return String(value || '')
      .replace(/\r\n?/g, '\n')
      .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '图片：$1（$2）')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1（$2）')
      .replace(/^\s*```[^\n]*$/gm, '')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/^\s{0,3}#{1,6}\s*/gm, '')
      .replace(/^\s*>\s?/gm, '')
      .replace(/^\s*[-*+]\s+/gm, '• ')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/__([^_]+)__/g, '$1')
      .replace(/\\([#*_`])/g, '$1')
      .replace(/&#x20;/gi, ' ')
      .trim();
  }

  static addText(paragraphs, value, style = 'Body') {
    const text = this.plainText(value);
    if (!text) return;
    text.split('\n').forEach(line => paragraphs.push({ text: line, style }));
  }

  static answerText(part, answer) {
    if (part.type === 'multiple_choice') return Array.isArray(answer) ? answer.join('、') : '';
    if (part.type === 'programming') return String(answer?.code || '');
    return String(answer || '');
  }

  static buildParagraphs(paper, answers, username, group) {
    const paragraphs = [
      { text: `${paper.id} · ${paper.title}`, style: 'Title' },
      { text: `${group === 'vision' ? '视觉组' : '电控组'}｜总分 ${paper.totalScore}｜答题人：${username}`, style: 'Meta' },
      { text: '填写说明', style: 'Heading1' },
      { text: '请只在每个“答案开始”和“答案结束”标记之间作答，不要修改标记中的编号。选择题可填写完整选项或选项序号；编程题请保留语言行并粘贴完整源代码。填写后回到套卷页面导入本文件，即可自动填充。', style: 'Notice' },
    ];
    if (paper.description) {
      paragraphs.push({ text: '试卷说明与要求', style: 'Heading1' });
      this.addText(paragraphs, paper.description);
    }

    paper.questions.forEach((question, questionIndex) => {
      paragraphs.push({ text: `第 ${questionIndex + 1} 题　${question.title}（${this.questionPoints(question)} 分）`, style: 'Heading1' });
      this.addText(paragraphs, question.description);
      if (question.scoringMode === 'programming_required') {
        paragraphs.push({ text: '评分规则：编程部分未通过时，本大题整体计 0 分。', style: 'Notice' });
      }
      question.parts.forEach((part, partIndex) => {
        paragraphs.push({ text: `${questionIndex + 1}.${partIndex + 1} ${this.partTypeName(part.type)}（${part.points} 分）`, style: 'Heading2' });
        this.addText(paragraphs, part.prompt);
        if (part.options?.length) {
          part.options.forEach((option, index) => paragraphs.push({ text: `${String.fromCharCode(65 + index)}. ${this.plainText(option)}`, style: 'Option' }));
        }
        if (part.type === 'programming' && part.problem) this.addProgrammingProblem(paragraphs, part.problem);
        if (part.type === 'programming') {
          paragraphs.push({ text: `【JC-OJ语言:${part.id}】${answers[part.id]?.language || 'c'}`, style: 'AnswerMarker' });
        }
        paragraphs.push({ text: `【JC-OJ答案开始:${part.id}】`, style: 'AnswerMarker' });
        const answer = this.answerText(part, answers[part.id]);
        if (answer) answer.split(/\r?\n/).forEach(line => paragraphs.push({ text: line, style: part.type === 'programming' ? 'Code' : 'Answer' }));
        else paragraphs.push({ text: '请在此处填写答案', style: 'Placeholder' });
        paragraphs.push({ text: `【JC-OJ答案结束:${part.id}】`, style: 'AnswerMarker' });
      });
    });
    return paragraphs;
  }

  static addProgrammingProblem(paragraphs, problem) {
    paragraphs.push({ text: `完整编程题：${problem.id || ''} ${problem.title || ''}`.trim(), style: 'Heading3' });
    const sections = [
      ['题目描述', problem.description],
      ['输入格式', problem.inputFormat],
      ['输出格式', problem.outputFormat],
      ['数据范围', problem.constraints],
      ['提示', problem.hints],
    ];
    sections.forEach(([title, value]) => {
      if (!value) return;
      paragraphs.push({ text: title, style: 'Heading3' });
      this.addText(paragraphs, value);
    });
    const samples = Array.isArray(problem.samples) ? problem.samples : [];
    samples.forEach((sample, index) => {
      paragraphs.push({ text: `样例输入 #${index + 1}`, style: 'Heading3' });
      String(sample.input || '').split(/\r?\n/).forEach(line => paragraphs.push({ text: line, style: 'Code' }));
      paragraphs.push({ text: `样例输出 #${index + 1}`, style: 'Heading3' });
      String(sample.output || '').split(/\r?\n/).forEach(line => paragraphs.push({ text: line, style: 'Code' }));
    });
    if (problem.sampleExplanation) {
      paragraphs.push({ text: '样例解释', style: 'Heading3' });
      this.addText(paragraphs, problem.sampleExplanation);
    }
  }

  static questionPoints(question) {
    return Math.round(question.parts.reduce((sum, part) => sum + Number(part.points || 0), 0) * 100) / 100;
  }

  static partTypeName(type) {
    return { single_choice: '单选题', multiple_choice: '多选题', fill_blank: '填空题', short_answer: '简答题', programming: '编程题' }[type] || '小题';
  }

  static paragraphXml(item) {
    const style = this.xmlEscape(item.style || 'Body');
    const text = this.xmlEscape(item.text);
    return `<w:p><w:pPr><w:pStyle w:val="${style}"/></w:pPr><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
  }

  static async download(paper, answers, username, group) {
    if (!window.JSZip) throw new Error('Word 组件尚未加载，请刷新页面重试');
    const zip = new window.JSZip();
    const body = this.buildParagraphs(paper, answers, username, group).map(item => this.paragraphXml(item)).join('');
    zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`);
    zip.folder('_rels').file('.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
    zip.folder('word').file('document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr></w:body></w:document>`);
    zip.folder('word').file('styles.xml', this.stylesXml());
    zip.folder('word').folder('_rels').file('document.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`);
    const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 }, mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${String(paper.id || 'exam').replace(/[^A-Za-z0-9_-]/g, '_')}-答题卡-${String(username || '学生').replace(/[\\/:*?"<>|]/g, '_')}.docx`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  static stylesXml() {
    const style = (id, name, size, color, bold = false, extra = '') => `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/><w:pPr>${extra}</w:pPr><w:rPr>${bold ? '<w:b/>' : ''}<w:color w:val="${color}"/><w:sz w:val="${size}"/><w:szCs w:val="${size}"/><w:rFonts w:eastAsia="Microsoft YaHei"/></w:rPr></w:style>`;
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
      ${style('Body', '正文', 22, '222222', false, '<w:spacing w:after="100" w:line="330" w:lineRule="auto"/>')}
      ${style('Title', '标题', 36, '17365D', true, '<w:jc w:val="center"/><w:spacing w:after="180"/>')}
      ${style('Meta', '元信息', 20, '666666', false, '<w:jc w:val="center"/><w:spacing w:after="220"/>')}
      ${style('Heading1', '一级标题', 28, '17365D', true, '<w:spacing w:before="240" w:after="120"/><w:keepNext/>')}
      ${style('Heading2', '二级标题', 24, '254F7A', true, '<w:spacing w:before="180" w:after="90"/><w:keepNext/>')}
      ${style('Heading3', '三级标题', 22, '365F86', true, '<w:spacing w:before="120" w:after="70"/><w:keepNext/>')}
      ${style('Option', '选项', 22, '222222', false, '<w:ind w:left="360"/><w:spacing w:after="70"/>')}
      ${style('Notice', '说明', 20, '7A4D00', false, '<w:shd w:fill="FFF4D6"/><w:spacing w:before="80" w:after="120"/>')}
      ${style('AnswerMarker', '答案标记', 20, '1E6B45', true, '<w:shd w:fill="E8F5EE"/><w:spacing w:before="100" w:after="70"/>')}
      ${style('Answer', '答案', 22, '111111', false, '<w:ind w:left="240"/><w:spacing w:after="80"/>')}
      ${style('Placeholder', '占位提示', 20, '999999', false, '<w:ind w:left="240"/><w:spacing w:after="80"/>')}
      <w:style w:type="paragraph" w:styleId="Code"><w:name w:val="代码"/><w:pPr><w:shd w:fill="F2F4F7"/><w:ind w:left="180"/><w:spacing w:after="0"/></w:pPr><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:eastAsia="Microsoft YaHei"/><w:sz w:val="19"/><w:color w:val="202124"/></w:rPr></w:style>
    </w:styles>`;
  }

  static async import(file, paper) {
    if (!file) return {};
    if (!window.JSZip) throw new Error('Word 组件尚未加载，请刷新页面重试');
    if (file.size > 10 * 1024 * 1024) throw new Error('答题卡不能超过 10 MB');
    const zip = await window.JSZip.loadAsync(file);
    const documentEntry = zip.file('word/document.xml');
    if (!documentEntry) throw new Error('这不是有效的 Word .docx 答题卡');
    const xml = await documentEntry.async('string');
    if (xml.length > 4 * 1024 * 1024) throw new Error('答题卡内容过大');
    const documentXml = new DOMParser().parseFromString(xml, 'application/xml');
    if (documentXml.querySelector('parsererror')) throw new Error('Word 文档内容损坏');
    const paragraphs = [...documentXml.getElementsByTagNameNS('http://schemas.openxmlformats.org/wordprocessingml/2006/main', 'p')]
      .map(paragraph => paragraph.textContent || '');
    const text = paragraphs.join('\n');
    const answers = {};
    let imported = 0;
    for (const part of paper.questions.flatMap(question => question.parts)) {
      const id = String(part.id);
      const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const match = text.match(new RegExp(`【JC-OJ答案开始:${escapedId}】\\n?([\\s\\S]*?)\\n?【JC-OJ答案结束:${escapedId}】`));
      if (!match) continue;
      let value = match[1].replace(/^请在此处填写答案$/m, '').trim();
      if (part.type === 'programming') {
        const languageMatch = text.match(new RegExp(`【JC-OJ语言:${escapedId}】([^\\n]*)`));
        answers[id] = { language: this.normalizeLanguage(languageMatch?.[1]), code: value };
      } else if (part.type === 'multiple_choice') {
        answers[id] = this.matchOptions(value, part.options, true);
      } else if (part.type === 'single_choice') {
        answers[id] = this.matchOptions(value, part.options, false);
      } else {
        answers[id] = value;
      }
      imported += 1;
    }
    if (!imported) throw new Error('没有识别到答题区域，请使用本站下载的答题卡并保留答案标记');
    return { answers, imported };
  }

  static normalizeLanguage(value) {
    const language = String(value || '').trim().toLowerCase();
    if (/python|py/.test(language)) return 'python';
    if (/c\+\+|cpp/.test(language)) return 'cpp';
    if (/java(?!script)/.test(language)) return 'java';
    if (/javascript|node|js/.test(language)) return 'javascript';
    if (/rust/.test(language)) return 'rust';
    if (/go/.test(language)) return 'go';
    return 'c';
  }

  static matchOptions(value, options = [], multiple) {
    let pieces = String(value || '').split(/[\n,，、;；]+/).map(item => item.trim()).filter(Boolean);
    if (multiple && pieces.length === 1 && /^[A-Za-z]{2,}$/.test(pieces[0])) pieces = [...pieces[0]];
    const matched = pieces.map(piece => {
      const exact = options.find(option => String(option).trim() === piece);
      if (exact !== undefined) return exact;
      const label = piece.match(/^([A-Za-z]|\d+)\s*[.、:：)]?$/)?.[1];
      if (!label) return piece;
      const index = /^\d+$/.test(label) ? Number(label) - 1 : label.toUpperCase().charCodeAt(0) - 65;
      return options[index] ?? piece;
    });
    return multiple ? [...new Set(matched)] : (matched[0] || '');
  }
}

window.ExamDocx = ExamDocx;
