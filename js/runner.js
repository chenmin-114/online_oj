/**
 * Judge0 CE 代码执行引擎
 * 通过 Cloudflare Worker 代理调用 Judge0，统一处理跨域和执行结果。
 */
class CodeRunner {
  constructor(workerUrl) {
    this.workerUrl = workerUrl || window.OJ_CONFIG.WORKER_URL;
  }

  /**
   * 执行代码
   * @param {number} languageId - Judge0 语言 ID
   * @param {string} code - 源代码
   * @param {string} stdin - 标准输入
   * @returns {Promise<{stdout: string, stderr: string, exitCode: number, time: number, signal: string|null, compileError: boolean}>}
   */
  async execute(languageId, code, stdin = '') {
    const startTime = performance.now();

    if (!this.workerUrl) {
      throw new Error('未配置 Cloudflare Worker URL，无法执行代码');
    }

    const response = await fetch(this.workerUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'execute',
        script: code,
        languageId,
        stdin,
        compileTimeout: window.OJ_CONFIG.COMPILE_TIMEOUT,
        memoryLimit: window.OJ_CONFIG.MEMORY_LIMIT,
      }),
    });

    const elapsed = Math.round(performance.now() - startTime);

    if (!response.ok) {
      const errText = await response.text();
      let message = errText;
      try {
        const errorData = JSON.parse(errText);
        message = errorData.error || errText;
      } catch {
        // Worker 也可能返回非 JSON 的网关错误，保留原始文本便于排查。
      }
      throw new Error(`代码执行失败 (${response.status}): ${message}`);
    }

    const data = await response.json();

    const output = (data.output || '').substring(0, window.OJ_CONFIG.MAX_OUTPUT_SIZE);
    const error = (data.error || '').substring(0, window.OJ_CONFIG.MAX_OUTPUT_SIZE);
    const isCompileError = data.compileError === true;

    return {
      stdout: isCompileError ? '' : output,
      stderr: isCompileError ? (error || output) : error,
      exitCode: Number.isInteger(data.exitCode) ? data.exitCode : 1,
      time: Number.isFinite(data.time) ? data.time : elapsed,
      signal: data.signal || null,
      compileError: isCompileError,
      memory: data.memory,
      status: data.status,
    };
  }
}
