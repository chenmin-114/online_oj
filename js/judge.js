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
          lang.judge0LanguageId,
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

        // 首个失败测试点即可确定本次提交未通过，避免继续占用公共执行资源。
        if (!passed) break;
      } catch (err) {
        // 网络、限流等基础设施错误不是 Wrong Answer，不应记录为用户提交失败。
        throw new Error(`测试点 ${i + 1} 执行失败: ${err.message}`);
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
