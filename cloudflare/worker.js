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
      } else if (body.type === 'create_problem') {
        return await handleCreateProblem(body, env);
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
 * 从管理页面新增题目。只允许创建，不允许覆盖或删除现有题目。
 */
async function handleCreateProblem(body, env) {
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) {
    return jsonResponse({ error: 'GitHub 存储尚未配置' }, 503);
  }

  const validation = validateProblem(body.problem, body.file);
  if (validation.error) return jsonResponse({ error: validation.error }, 400);

  const { problem, file } = validation;
  const indexPath = 'problems/index.json';
  const problemPath = `problems/${file}`;
  const headers = githubHeaders(env.GITHUB_TOKEN);
  const indexUrl = `https://api.github.com/repos/${env.GITHUB_REPO}/contents/${indexPath}`;

  const indexRes = await fetch(indexUrl, { headers });
  if (!indexRes.ok) {
    return githubErrorResponse(indexRes, '读取题目索引失败');
  }

  const indexFile = await indexRes.json();
  let index;
  try {
    index = JSON.parse(decodeBase64Utf8(indexFile.content));
  } catch {
    return jsonResponse({ error: '题目索引格式不正确' }, 500);
  }

  if (!Array.isArray(index)) {
    return jsonResponse({ error: '题目索引必须是数组' }, 500);
  }
  if (index.some(item => item.id === problem.id || item.file === file)) {
    return jsonResponse({ error: '题号或文件名已经存在，请更换后重试' }, 409);
  }

  const problemUrl = `https://api.github.com/repos/${env.GITHUB_REPO}/contents/${problemPath}`;
  const existingProblem = await fetch(problemUrl, { headers });
  if (existingProblem.ok) {
    return jsonResponse({ error: '题目文件已经存在，不能覆盖' }, 409);
  }
  if (existingProblem.status !== 404) {
    return githubErrorResponse(existingProblem, '检查题目文件失败');
  }

  const createProblemRes = await fetch(problemUrl, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      message: `📝 Add problem ${problem.id} - ${problem.title}`,
      content: encodeBase64Utf8(JSON.stringify(problem, null, 2)),
    }),
  });
  if (!createProblemRes.ok) {
    return githubErrorResponse(createProblemRes, '创建题目文件失败');
  }

  index.push({
    id: problem.id,
    title: problem.title,
    difficulty: problem.difficulty,
    file,
    acceptRate: '0%',
    submitCount: 0,
  });
  index.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));

  const updateIndexRes = await fetch(indexUrl, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      message: `🗂️ Register problem ${problem.id}`,
      content: encodeBase64Utf8(JSON.stringify(index, null, 2)),
      sha: indexFile.sha,
    }),
  });
  if (!updateIndexRes.ok) {
    return githubErrorResponse(updateIndexRes, '题目文件已创建，但更新索引失败，请在 GitHub 检查');
  }

  return jsonResponse({
    success: true,
    problem: index.find(item => item.id === problem.id),
  }, 201);
}

function validateProblem(input, requestedFile) {
  if (!input || typeof input !== 'object') return { error: '缺少题目内容' };

  const requiredFields = ['id', 'title', 'description', 'inputFormat', 'outputFormat'];
  for (const field of requiredFields) {
    if (typeof input[field] !== 'string' || !input[field].trim()) {
      return { error: `请填写 ${field}` };
    }
  }

  const id = input.id.trim().toUpperCase();
  if (!/^P\d{3,6}$/.test(id)) {
    return { error: '题号格式应为 P006 这样的 P 加数字' };
  }

  const difficulty = ['easy', 'medium', 'hard'].includes(input.difficulty)
    ? input.difficulty
    : 'easy';
  const file = String(requestedFile || `${id.toLowerCase()}.json`).trim().toLowerCase();
  if (!/^p\d{3,6}(?:-[a-z0-9-]+)?\.json$/.test(file)) {
    return { error: '文件名格式应为 p006-example.json' };
  }

  if (!Array.isArray(input.testCases) || input.testCases.length === 0 || input.testCases.length > 50) {
    return { error: '测试点数量必须在 1 到 50 之间' };
  }
  const testCases = [];
  for (const [index, testCase] of input.testCases.entries()) {
    if (!testCase || typeof testCase.input !== 'string' || typeof testCase.expectedOutput !== 'string') {
      return { error: `测试点 ${index + 1} 格式不正确` };
    }
    testCases.push({ input: testCase.input, expectedOutput: testCase.expectedOutput });
  }

  const problem = {
    id,
    title: input.title.trim().slice(0, 100),
    difficulty,
    description: input.description.trim().slice(0, 20000),
    inputFormat: input.inputFormat.trim().slice(0, 10000),
    outputFormat: input.outputFormat.trim().slice(0, 10000),
    constraints: String(input.constraints || '').trim().slice(0, 10000),
    sampleInput: String(input.sampleInput || ''),
    sampleOutput: String(input.sampleOutput || ''),
    testCases,
    hints: Array.isArray(input.hints)
      ? input.hints.map(item => String(item).trim()).filter(Boolean).slice(0, 20)
      : [],
  };

  return { problem, file };
}

function githubHeaders(token) {
  return {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'User-Agent': 'oj-proxy-worker',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

async function githubErrorResponse(response, fallback) {
  const data = await parseJsonResponse(response);
  return jsonResponse({
    error: `${fallback}: ${data.message || data.error || response.status}`,
  }, response.status >= 400 && response.status < 500 ? response.status : 502);
}

function encodeBase64Utf8(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeBase64Utf8(value) {
  const binary = atob(value.replace(/\s/g, ''));
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
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
