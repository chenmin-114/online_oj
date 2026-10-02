/**
 * Monaco Editor 封装
 * 加载 Monaco 并管理编辑器实例
 */
class EditorManager {
  constructor(containerId) {
    this.containerId = containerId;
    this.editor = null;
    this.currentLanguage = 'c';
    this.pendingCode = null;
    this.changeListeners = [];
    this.fontSize = window.OJ_CONFIG.EDITOR_FONT_SIZE;
  }

  async init() {
    // 从本站加载固定版本 Monaco，避免第三方 CDN 成为脚本供应链入口。
    await this._loadMonaco();
    this._createEditor();
  }

  _loadMonaco() {
    return new Promise((resolve, reject) => {
      if (window.monaco) { resolve(); return; }
      const loader = document.createElement('script');
      loader.src = '/vendor/monaco/vs/loader.js?v=0.45.0';
      loader.onload = () => {
        window.require.config({
          paths: { vs: '/vendor/monaco/vs' }
        });
        window.require(['vs/editor/editor.main'], () => resolve());
      };
      loader.onerror = () => reject(new Error('代码编辑器加载失败，请刷新页面重试'));
      document.head.appendChild(loader);
    });
  }

  _createEditor() {
    const lang = getLanguageById(this.currentLanguage);
    this.editor = monaco.editor.create(
      document.getElementById(this.containerId),
      {
        value: this.pendingCode === null ? lang.template : this.pendingCode,
        language: lang.monacoLang,
        theme: window.OJ_CONFIG.DEFAULT_THEME,
        fontSize: this.fontSize,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        automaticLayout: true,
        tabSize: 4,
        insertSpaces: true,
        wordWrap: 'on',
        lineNumbers: 'on',
        renderWhitespace: 'selection',
        padding: { top: 10, bottom: 10 },
      }
    );
    this.editor.onDidChangeModelContent(() => {
      const code = this.editor.getValue();
      this.changeListeners.forEach(listener => listener(code));
    });
  }

  getCode() {
    return this.editor ? this.editor.getValue() : '';
  }

  setCode(code) {
    this.pendingCode = String(code ?? '');
    if (this.editor && this.editor.getValue() !== this.pendingCode) {
      this.editor.setValue(this.pendingCode);
    }
  }

  setLanguage(langId) {
    this.currentLanguage = langId;
    const lang = getLanguageById(langId);
    if (this.editor) {
      monaco.editor.setModelLanguage(this.editor.getModel(), lang.monacoLang);
    }
  }

  setTheme(theme) {
    if (this.editor) monaco.editor.setTheme(theme);
  }

  setFontSize(size) {
    this.fontSize = size;
    if (this.editor) this.editor.updateOptions({ fontSize: size });
  }

  setReadOnly(readOnly) {
    if (this.editor) this.editor.updateOptions({ readOnly: Boolean(readOnly) });
  }

  onChange(listener) {
    if (typeof listener === 'function') this.changeListeners.push(listener);
  }

  focus() {
    if (this.editor) this.editor.focus();
  }
}
