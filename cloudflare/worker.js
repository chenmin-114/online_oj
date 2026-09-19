/**
 * Cloudflare Worker - 安全代理层
 * 作用：
 * 1. 隐藏 GitHub Token，防止前端泄露
 * 2. 验证提交数据格式
 * 3. 可选：服务端二次验证代码执行结果
 * 
 * 部署步骤：
 * 1. 登录 https://dash.cloudflare.com/
 * 2. Workers & Pages → Create Worker
 * 3. 粘贴此代码
 * 4. Settings → Variables → 添加：
 *    - GITHUB_TOKEN: GitHub Personal Access Token (repo 权限)
 *    - GITHUB_REPO: 仓库名 (格式: username/repo)
 * 5. Deploy
 */

export default {
  async fetch(request, env) {
    // CORS 预检
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    // 只接受 POST
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    try {
      const { username, problemId, passed, passedTests, totalTests, totalTime, language, code, timestamp } = await request.json();

      // 基础验证
      if (!username || !problemId || typeof passed !== 'boolean') {
        return new Response(JSON.stringify({ error: 'Invalid payload' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // 构建提交文件路径
      const safeUsername = username.replace(/[^a-zA-Z0-9_-]/g, '_');
      const safeProblemId = problemId.replace(/[^a-zA-Z0-9_-]/g, '_');
      const path = `submissions/${safeProblemId}/${safeUsername}_${timestamp}.json`;

      // 构建提交内容
      const payload = {
        username: safeUsername,
        problemId: safeProblemId,
        passed,
        passedTests,
        totalTests,
        totalTime,
        language,
        code, // 已 base64 编码
        timestamp,
      };

      // 写入 GitHub
      const githubRes = await fetch(
        `https://api.github.com/repos/${env.GITHUB_REPO}/contents/${path}`,
        {
          method: 'PUT',
          headers: {
            'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
            'Accept': 'application/vnd.github.v3+json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            message: `🏁 ${safeUsername} submitted ${safeProblemId} - ${passed ? 'AC' : 'WA'}`,
            content: btoa(JSON.stringify(payload)),
          }),
        }
      );

      if (!githubRes.ok) {
        const err = await githubRes.text();
        return new Response(JSON.stringify({ error: 'GitHub API error', details: err }), {
          status: githubRes.status,
          headers: { 
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          },
        });
      }

      const result = await githubRes.json();

      return new Response(JSON.stringify({ 
        success: true, 
        sha: result.content.sha,
        path: result.content.path,
      }), {
        headers: { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      });

    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }
  },
};
