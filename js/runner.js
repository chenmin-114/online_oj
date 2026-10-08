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
  async execute(languageId, code, stdin = '', username = '', requestType = 'execute', context = {}) {
    const startTime = performance.now();

    if (!this.workerUrl) {
      throw new Error('安全代码执行服务尚未配置');
    }

    let response;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);
    try {
      response = await fetch(this.workerUrl, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          type: requestType,
          username,
          script: code,
          languageId,
          stdin,
          compileTimeout: window.OJ_CONFIG.COMPILE_TIMEOUT,
          memoryLimit: window.OJ_CONFIG.MEMORY_LIMIT,
          examId: context.examId || undefined,
          problemId: context.problemId || undefined,
        }),
      });
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error('安全代码执行服务响应超时，请稍后重试');
      throw new Error('无法连接安全代码执行服务，请检查网络后重试');
    } finally {
      clearTimeout(timeoutId);
    }

    const elapsed = Math.round(performance.now() - startTime);

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      const error = new Error(errorData.error || `代码执行失败 (${response.status})`);
      error.code = errorData.code || '';
      error.status = response.status;
      throw error;
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
