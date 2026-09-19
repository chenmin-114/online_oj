/**
 * Cloudflare Worker - 安全代理层
 * 功能：
 * 1. 代理 Judge0 CE 执行代码（type: 'execute'）
 * 2. 代理 GitHub API 提交结果（默认行为）
 * 3. 保护 GitHub API 凭据，不暴露在前端
 * 
 * 需要配置的环境变量/Secrets：
 * - GITHUB_TOKEN (Secret)
 * - GITHUB_REPO (Plaintext)
 * - JUDGE0_API_URL (Plaintext, 可选，默认使用公共 CE 实例)
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// 兼容仍在浏览器缓存中的旧版 JDoodle 前端字段。
const LEGACY_LANGUAGE_IDS = {
  c: 103,
  cpp17: 105,
  python3: 92,
  java: 91,
  nodejs: 93,
  go: 106,
  rust: 108,
};

export default {
  async fetch(request, env) {
    // CORS 预检
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    // 只接受 POST
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    try {
      const body = await request.json();

      // 路由：根据 type 字段分发
      if (body.type === 'health') {
        return jsonResponse({
          ok: true,
          executionProvider: 'Judge0 CE',
          repository: env.GITHUB_REPO || null,
          githubConfigured: Boolean(env.GITHUB_TOKEN && env.GITHUB_REPO),
        });
      } else if (body.type === 'execute') {
        return await handleExecute(body, env);
      } else if (body.type === 'submit' || typeof body.passed === 'boolean') {
        return await handleSubmit(body, env);
      }

      return jsonResponse({ error: 'Unknown request type' }, 400);

    } catch (err) {
      return jsonResponse({ error: err.message }, 500);
    }
  },
};

/**
 * 处理代码执行请求（代理 Judge0 CE API）
 */
async function handleExecute(body, env) {
  const { script, stdin } = body;
  const languageId = Number.isInteger(body.languageId)
    ? body.languageId
    : LEGACY_LANGUAGE_IDS[body.language];

  if (!script || !Number.isInteger(languageId)) {
    return jsonResponse({ error: 'Missing script or invalid languageId' }, 400);
  }

  const allowedLanguageIds = new Set([103, 105, 92, 91, 93, 106, 108]);
  if (!allowedLanguageIds.has(languageId)) {
    return jsonResponse({ error: 'Unsupported language' }, 400);
  }

  const judge0BaseUrl = (env.JUDGE0_API_URL || 'https://ce.judge0.com').replace(/\/$/, '');
  let judge0Res;
  try {
    judge0Res = await fetch(`${judge0BaseUrl}/submissions?base64_encoded=false&wait=true`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        source_code: script,
        language_id: languageId,
        stdin: stdin || '',
      }),
    });
  } catch {
    return jsonResponse({
      error: '暂时无法连接代码执行服务，请稍后重试',
      code: 'JUDGE0_UNAVAILABLE',
    }, 502);
  }

  const data = await parseJsonResponse(judge0Res);

  if (judge0Res.status === 429) {
    return jsonResponse({
      error: '公共代码执行服务当前请求过多，请稍后重试',
      code: 'JUDGE0_RATE_LIMITED',
    }, 429);
  }

  if (!judge0Res.ok) {
    return jsonResponse({
      error: data.error || data.message || '代码执行服务请求失败',
      code: 'JUDGE0_REQUEST_FAILED',
    }, 502);
  }

  const statusId = data.status?.id;
  const statusText = data.status?.description || 'Unknown';
  const accepted = statusId === 3;
  const compileError = statusId === 6;
  const error = data.compile_output || data.stderr || data.message ||
    (accepted ? '' : statusText);

  return jsonResponse({
    output: data.stdout || '',
    error,
    exitCode: accepted ? 0 : 1,
    compileError,
    time: data.time ? Math.round(Number(data.time) * 1000) : null,
    memory: data.memory ?? null,
    signal: data.signal ?? null,
    status: statusText,
  });
}

async function parseJsonResponse(response) {
  const text = await response.text();
  if (!text) return {};

  try {
    return JSON.parse(text);
  } catch {
    return { error: text.slice(0, 500) };
  }
}

/**
 * 处理提交结果请求（写入 GitHub）
 */
async function handleSubmit(body, env) {
  const { username, problemId, passed, passedTests, totalTests, totalTime, language, code, timestamp } = body;

  if (!username || !problemId || typeof passed !== 'boolean') {
    return jsonResponse({ error: 'Invalid payload' }, 400);
  }

  if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) {
    return jsonResponse({
      error: 'GitHub 提交存储尚未配置',
      code: 'GITHUB_NOT_CONFIGURED',
    }, 503);
  }

  const safeUsername = username.replace(/[^a-zA-Z0-9_-]/g, '_');
  const safeProblemId = problemId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const path = `submissions/${safeProblemId}/${safeUsername}_${timestamp}.json`;

  const payload = {
    username: safeUsername,
    problemId: safeProblemId,
    passed,
    passedTests,
    totalTests,
    totalTime,
    language,
    code,
    timestamp,
  };

  const githubRes = await fetch(
    `https://api.github.com/repos/${env.GITHUB_REPO}/contents/${path}`,
    {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
        'User-Agent': 'oj-proxy-worker',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({
        message: `🏁 ${safeUsername} submitted ${safeProblemId} - ${passed ? 'AC' : 'WA'}`,
        content: btoa(JSON.stringify(payload)),
      }),
    }
  );

  if (!githubRes.ok) {
    const err = await githubRes.text();
    let details = err;
    try {
      details = JSON.parse(err).message || err;
    } catch {
      // 保留 GitHub 返回的非 JSON 错误文本。
    }
    return jsonResponse({
      error: `GitHub 保存失败: ${details}`,
      code: 'GITHUB_REQUEST_FAILED',
    }, githubRes.status);
  }

  const result = await githubRes.json();
  return jsonResponse({
    success: true,
    sha: result.content.sha,
    path: result.content.path,
  });
}

/**
 * 统一 JSON 响应（带 CORS 头）
 */
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...CORS_HEADERS,
    },
  });
}
