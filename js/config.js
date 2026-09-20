/**
 * 机创 OJ 全局配置
 * 部署时根据实际情况修改以下配置项
 */
// Cloudflare Worker 代理地址（用于安全提交、代码执行和数据读取）
// 部署后替换为你自己的 Worker URL
const WORKER_URL = 'https://api.jc-oj.online';

window.OJ_CONFIG = {
  WORKER_URL,

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

  // 排名/提交数据（由 GitHub Actions 生成）经 Worker 直读仓库返回，响应带
  // Cache-Control: no-store。不读同源 dist/*.json，因为 GitHub Pages 的 CDN
  // 会忽略查询参数并把响应缓存 10 分钟，导致提交记录长时间不刷新。
  // dist/ranking.json（旧版数组格式）仍保留在仓库中，供已缓存的旧页面使用。
  PROBLEMS_URL: WORKER_URL ? `${WORKER_URL}/?file=problems` : '',
  RANKING_URL: WORKER_URL ? `${WORKER_URL}/?file=ranking-v2` : '',
  SUBMISSIONS_URL: WORKER_URL ? `${WORKER_URL}/?file=submissions` : '',
};
