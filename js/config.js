/**
 * Online OJ 全局配置
 * 部署时根据实际情况修改以下配置项
 */
window.OJ_CONFIG = {
  // Cloudflare Worker 代理地址（用于安全提交和代码执行）
  // 部署后替换为你自己的 Worker URL
  WORKER_URL: 'https://oj-proxy.1930566173.workers.dev',

  // GitHub 配置（仅开发测试时使用，生产环境应通过 Worker 代理）
  GITHUB_TOKEN: '',
  GITHUB_REPO: '',  // 格式: 'username/repo'

  // 代码执行限制
  MAX_OUTPUT_SIZE: 4096,     // 最大输出字节数
  COMPILE_TIMEOUT: 10000,    // 编译超时 (ms)
  RUN_TIMEOUT: 5000,         // 运行超时 (ms)
  MEMORY_LIMIT: 256 * 1024 * 1024, // 内存限制 256MB

  // UI 配置
  DEFAULT_LANGUAGE: 'c',
  DEFAULT_THEME: 'vs-dark',
  EDITOR_FONT_SIZE: 14,

  // 排名数据路径（由 GitHub Actions 生成）
  RANKING_URL: 'dist/ranking.json',
  SUBMISSIONS_URL: 'dist/submissions.json',
};
