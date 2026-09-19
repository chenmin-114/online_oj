/**
 * JDoodle API 代码执行引擎
 * 通过 Cloudflare Worker 代理调用 JDoodle API（避免 CORS 问题，保护 API 凭据）
 * 每日额度取决于 JDoodle Compiler API 套餐
 * 申请地址: https://www.jdoodle.com/compiler-api
 */
class CodeRunner {
  constructor(workerUrl) {
    this.workerUrl = workerUrl || window.OJ_CONFIG.WORKER_URL;
  }

  /**
   * 执行代码
   * @param {string} language - JDoodle 语言标识 (如 'c', 'cpp17', 'python3')
   * @param {string} versionIndex - JDoodle 版本索引
   * @param {string} code - 源代码
   * @param {string} stdin - 标准输入
   * @returns {Promise<{stdout: string, stderr: string, exitCode: number, time: number, signal: string|null, compileError: boolean}>}
   */
  async execute(language, versionIndex, code, stdin = '') {
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
        language,
        versionIndex,
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

    // JDoodle 不返回 exit code，需要从 output 和 error 判断
    const output = (data.output || '').substring(0, window.OJ_CONFIG.MAX_OUTPUT_SIZE);
    const error = (data.error || '').substring(0, window.OJ_CONFIG.MAX_OUTPUT_SIZE);
    const statusCode = data.statusCode || -1;

    // 判断是否为编译错误
    const isCompileError = error.includes('error:') || error.includes('Error:');

    // 从 cpuTime 获取执行时间（JDoodle 返回的是秒，转为毫秒）
    const cpuTimeMs = data.cpuTime ? Math.round(parseFloat(data.cpuTime) * 1000) : elapsed;

    return {
      stdout: isCompileError ? '' : output,
      stderr: isCompileError ? (error || output) : error,
      exitCode: isCompileError ? 1 : (statusCode >= 400 ? 1 : 0),
      time: cpuTimeMs,
      signal: data.signal || null,
      compileError: isCompileError,
      memory: data.memory,
    };
  }
}
