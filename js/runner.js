/**
 * Judge0 CE 代码执行引擎
 * 通过 Cloudflare Worker 代理调用 Judge0，统一处理跨域和执行结果。
 */
class CodeRunner {
  constructor(workerUrl) {
    this.workerUrl = workerUrl || window.OJ_CONFIG.WORKER_URL;
    this.useDirect = false;
    this.workerProbe = null;
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
      return this._executeDirect(languageId, code, stdin, startTime);
    }

    // workers.dev 在部分网络中会被错误解析或长时间无响应。首次执行只探测一次；
    // 如果 3 秒内不可达，本次页面会话后续测试点都直接走 Judge0。
    if (this.useDirect || !(await this._isWorkerReachable())) {
      return this._executeDirect(languageId, code, stdin, startTime);
    }

    let response;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);
    try {
      response = await fetch(this.workerUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          type: 'execute',
          script: code,
          languageId,
          stdin,
          compileTimeout: window.OJ_CONFIG.COMPILE_TIMEOUT,
          memoryLimit: window.OJ_CONFIG.MEMORY_LIMIT,
        }),
      });
    } catch {
      // 部分网络无法访问 workers.dev。Judge0 允许 GitHub Pages 跨域调用，
      // 因此在网络层失败时直接降级，并让后续测试点跳过 Worker。
      this.useDirect = true;
      return this._executeDirect(languageId, code, stdin, startTime);
    } finally {
      clearTimeout(timeoutId);
    }

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

  async _isWorkerReachable() {
    if (this.useDirect) return false;
    if (this.workerProbe) return this.workerProbe;

    this.workerProbe = (async () => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3000);

      try {
        const response = await fetch(this.workerUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({ type: 'health' }),
        });
        if (!response.ok) throw new Error(`Worker HTTP ${response.status}`);
        return true;
      } catch {
        this.useDirect = true;
        return false;
      } finally {
        clearTimeout(timeoutId);
      }
    })();

    return this.workerProbe;
  }

  async _executeDirect(languageId, code, stdin, startTime) {
    let response;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);
    try {
      response = await fetch('https://ce.judge0.com/submissions?base64_encoded=true&wait=true', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        signal: controller.signal,
        body: JSON.stringify({
          source_code: this._encodeBase64Utf8(code),
          language_id: languageId,
          stdin: this._encodeBase64Utf8(stdin || ''),
        }),
      });
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new Error('代码执行服务响应超时，请稍后重试');
      }
      throw new Error('无法连接代码执行服务，请检查网络后重试');
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok) {
      if (response.status === 429) {
        throw new Error('公共代码执行服务请求过多，请稍后重试');
      }
      throw new Error(`备用代码执行服务异常 (${response.status})`);
    }

    const data = await response.json();
    const statusId = data.status?.id;
    const accepted = statusId === 3;
    const compileError = statusId === 6;
    const stdout = this._decodeBase64Utf8(data.stdout);
    const stderr = this._decodeBase64Utf8(data.stderr);
    const compileOutput = this._decodeBase64Utf8(data.compile_output);
    const message = this._decodeBase64Utf8(data.message);
    const error = compileOutput || stderr || message ||
      (accepted ? '' : (data.status?.description || '执行失败'));

    return {
      stdout: compileError ? '' : stdout.substring(0, window.OJ_CONFIG.MAX_OUTPUT_SIZE),
      stderr: String(error).substring(0, window.OJ_CONFIG.MAX_OUTPUT_SIZE),
      exitCode: accepted ? 0 : 1,
      time: data.time ? Math.round(Number(data.time) * 1000) : Math.round(performance.now() - startTime),
      signal: data.signal || null,
      compileError,
      memory: data.memory,
      status: data.status?.description,
      provider: 'judge0-direct',
    };
  }

  _encodeBase64Utf8(value) {
    const bytes = new TextEncoder().encode(String(value));
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }

  _decodeBase64Utf8(value) {
    if (!value) return '';
    try {
      const binary = atob(String(value).replace(/\s/g, ''));
      const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
      return new TextDecoder().decode(bytes);
    } catch {
      return String(value);
    }
  }
}
