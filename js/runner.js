/**
 * Piston API 代码执行引擎
 * 通过 Piston (https://github.com/engineer-man/piston) 在远程沙箱中编译运行代码
 * 默认使用免费公共实例，也可自行部署
 */
class CodeRunner {
  constructor(apiUrl) {
    this.apiUrl = apiUrl || window.OJ_CONFIG.PISTON_API;
  }

  /**
   * 执行代码
   * @param {string} language - Piston 语言标识 (如 'c', 'c++', 'python')
   * @param {string} version - 语言版本
   * @param {string} code - 源代码
   * @param {string} stdin - 标准输入
   * @returns {Promise<{stdout: string, stderr: string, exitCode: number, time: number, signal: string|null}>}
   */
  async execute(language, version, code, stdin = '') {
    const startTime = performance.now();

    const response = await fetch(`${this.apiUrl}/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        language,
        version,
        files: [{ name: 'solution', content: code }],
        stdin,
        compile_timeout: window.OJ_CONFIG.COMPILE_TIMEOUT,
        run_timeout: window.OJ_CONFIG.RUN_TIMEOUT,
        compile_memory_limit: window.OJ_CONFIG.MEMORY_LIMIT,
        run_memory_limit: window.OJ_CONFIG.MEMORY_LIMIT,
      }),
    });

    const elapsed = Math.round(performance.now() - startTime);

    if (!response.ok) {
      throw new Error(`Piston API 错误: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();

    // 处理编译错误
    if (data.compile && data.compile.code !== 0) {
      return {
        stdout: '',
        stderr: data.compile.stderr || data.compile.output || '编译失败',
        exitCode: data.compile.code,
        time: elapsed,
        signal: data.compile.signal || null,
        compileError: true,
      };
    }

    // 运行结果
    const run = data.run || {};
    return {
      stdout: (run.stdout || '').substring(0, window.OJ_CONFIG.MAX_OUTPUT_SIZE),
      stderr: (run.stderr || '').substring(0, window.OJ_CONFIG.MAX_OUTPUT_SIZE),
      exitCode: run.code ?? -1,
      time: elapsed,
      signal: run.signal || null,
      compileError: false,
    };
  }

  /**
   * 获取可用语言列表
   */
  async getRuntimes() {
    const response = await fetch(`${this.apiUrl}/runtimes`);
    if (!response.ok) throw new Error('无法获取运行时列表');
    return response.json();
  }
}
