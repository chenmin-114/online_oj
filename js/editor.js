/**
 * Monaco Editor 封装
 * 加载 Monaco 并管理编辑器实例
 */
class EditorManager {
  constructor(containerId) {
    this.containerId = containerId;
    this.editor = null;
    this.currentLanguage = 'c';
  }

  async init() {
    // 动态加载 Monaco Editor CDN
    await this._loadMonaco();
    this._createEditor();
  }

  _loadMonaco() {
    return new Promise((resolve, reject) => {
      if (window.monaco) { resolve(); return; }
      const loader = document.createElement('script');
      loader.src = 'https://cdn.jsdelivr.net/npm/monaco-editor@0.45.0/min/vs/loader.js';
      loader.onload = () => {
        window.require.config({
          paths: { vs: 'https://cdn.jsdelivr.net/npm/monaco-editor@0.45.0/min/vs' }
        });
        window.require(['vs/editor/editor.main'], () => resolve());
      };
      loader.onerror = () => reject(new Error('Monaco Editor 加载失败，请检查网络'));
      document.head.appendChild(loader);
    });
  }

  _createEditor() {
    const lang = getLanguageById(this.currentLanguage);
    this.editor = monaco.editor.create(
      document.getElementById(this.containerId),
      {
        value: lang.template,
        language: lang.monacoLang,
        theme: window.OJ_CONFIG.DEFAULT_THEME,
        fontSize: window.OJ_CONFIG.EDITOR_FONT_SIZE,
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
  }

  getCode() {
    return this.editor ? this.editor.getValue() : '';
  }

  setCode(code) {
    if (this.editor) this.editor.setValue(code);
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

  focus() {
    if (this.editor) this.editor.focus();
  }
}
