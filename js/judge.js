/**
 * 判题引擎
 * 对每道题目逐条测试用例执行代码，比对输出并汇总结果
 */
class Judge {
  constructor(runner) {
    this.runner = runner;
  }

  /**
   * 执行判题
   * @param {object} problem - 题目对象（含 testCases 数组）
   * @param {string} code - 用户提交的代码
   * @param {string} langId - 语言 id（对应 languages.js 中的 id）
   * @param {function} onProgress - 进度回调 (currentIndex, totalCount, result)
   * @returns {Promise<JudgeResult>}
   */
  async judge(problem, code, langId, onProgress) {
    const lang = getLanguageById(langId);
    const testCases = problem.testCases || [];
    const results = [];
    let allPassed = true;

    for (let i = 0; i < testCases.length; i++) {
      const tc = testCases[i];
      try {
        const execResult = await this.runner.execute(
          lang.jdoodleLang,
          lang.versionIndex,
          code,
          tc.input
        );

        const passed = execResult.exitCode === 0 &&
          execResult.stdout.trim() === tc.expectedOutput.trim();

        if (!passed) allPassed = false;

        const result = {
          index: i + 1,
          passed,
          input: tc.input,
          expectedOutput: tc.expectedOutput,
          actualOutput: execResult.stdout.trim(),
          stderr: execResult.stderr,
          exitCode: execResult.exitCode,
          time: execResult.time,
          signal: execResult.signal,
          compileError: execResult.compileError || false,
        };

        results.push(result);
        if (onProgress) onProgress(i + 1, testCases.length, result);

        // 编译错误直接终止（后续用例无意义）
        if (execResult.compileError) {
          allPassed = false;
          break;
        }
      } catch (err) {
        allPassed = false;
        results.push({
          index: i + 1,
          passed: false,
          input: tc.input,
          expectedOutput: tc.expectedOutput,
          actualOutput: '',
          stderr: err.message,
          exitCode: -1,
          time: 0,
          signal: null,
          compileError: false,
          error: true,
        });
        if (onProgress) onProgress(i + 1, testCases.length, results[results.length - 1]);
      }
    }

    const totalTime = results.reduce((sum, r) => sum + (r.time || 0), 0);

    return {
      problemId: problem.id,
      language: langId,
      passed: allPassed,
      totalTests: testCases.length,
      passedTests: results.filter(r => r.passed).length,
      totalTime,
      results,
      timestamp: Date.now(),
    };
  }
}
