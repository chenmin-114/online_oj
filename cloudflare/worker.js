/**
 * Cloudflare Worker - 安全代理层
 * 功能：
 * 1. 代理 JDoodle API 执行代码（type: 'execute'）
 * 2. 代理 GitHub API 提交结果（默认行为）
 * 3. 保护所有 API 凭据，不暴露在前端
 * 
 * 需要配置的环境变量/Secrets：
 * - JDOODLE_CLIENT_ID (Secret)
 * - JDOODLE_CLIENT_SECRET (Secret)
 * - GITHUB_TOKEN (Secret)
 * - GITHUB_REPO (Plaintext)
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
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
      if (body.type === 'execute') {
        return await handleExecute(body, env);
      } else {
        return await handleSubmit(body, env);
      }

    } catch (err) {
      return jsonResponse({ error: err.message }, 500);
    }
  },
};

/**
 * 处理代码执行请求（代理 JDoodle API）
 */
async function handleExecute(body, env) {
  const { script, language, versionIndex, stdin } = body;

  if (!script || !language) {
    return jsonResponse({ error: 'Missing script or language' }, 400);
  }

  // Secret 存在但值为空、仍是示例值时，不要把难以理解的上游 401/403
  // 原样返回给前端。注意：JDoodle 普通账号凭据不能代替 Compiler API 凭据。
  if (!isConfiguredSecret(env.JDOODLE_CLIENT_ID) || !isConfiguredSecret(env.JDOODLE_CLIENT_SECRET)) {
    return jsonResponse({
      error: '代码执行服务尚未正确配置',
      code: 'JDOODLE_NOT_CONFIGURED',
    }, 503);
  }

  let jdoodleRes;
  try {
    jdoodleRes = await fetch('https://api.jdoodle.com/v1/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        script,
        language,
        versionIndex: String(versionIndex ?? '0'),
        stdin: stdin || '',
        clientId: env.JDOODLE_CLIENT_ID.trim(),
        clientSecret: env.JDOODLE_CLIENT_SECRET.trim(),
      }),
    });
  } catch {
    return jsonResponse({
      error: '暂时无法连接代码执行服务，请稍后重试',
      code: 'JDOODLE_UNAVAILABLE',
    }, 502);
  }

  const data = await parseJsonResponse(jdoodleRes);

  if (jdoodleRes.status === 401 || jdoodleRes.status === 403) {
    return jsonResponse({
      error: 'JDoodle API 鉴权失败，请重新配置有效的 Compiler API Client ID 和 Client Secret',
      code: 'JDOODLE_AUTH_FAILED',
    }, 503);
  }

  if (jdoodleRes.status === 429) {
    return jsonResponse({
      error: '今日代码执行额度已用完，请在额度重置后重试',
      code: 'JDOODLE_QUOTA_EXCEEDED',
    }, 429);
  }

  if (!jdoodleRes.ok) {
    return jsonResponse({
      error: data.error || '代码执行服务请求失败',
      code: 'JDOODLE_REQUEST_FAILED',
    }, 502);
  }

  return jsonResponse(data, jdoodleRes.status);
}

function isConfiguredSecret(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  return !/^(your[_-]?|replace[_-]?me|xxx)/i.test(value.trim());
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
    return jsonResponse({ error: 'GitHub API error', details: err }, githubRes.status);
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
