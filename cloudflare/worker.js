/**
 * Cloudflare Worker - 安全代理层
 * 功能：
 * 1. 代理 Judge0 CE 执行代码（type: 'execute'）
 * 2. 代理 GitHub API 提交结果（默认行为）
 * 3. 读取题目、排行榜与提交记录数据（GET ?file=）
 * 4. 保护 GitHub API 凭据，不暴露在前端
 *
 * 需要配置的环境变量/Secrets：
 * - GITHUB_TOKEN (Secret)
 * - ADMIN_PASSWORD (Secret)
 * - GITHUB_REPO (Plaintext)
 * - JUDGE0_API_URL (Plaintext, 可选，默认使用公共 CE 实例)
 */

const SECURITY_HEADERS = {
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
};

const ALLOWED_ORIGIN = 'https://jc-oj.online';

const CORS_HEADERS = {
  ...SECURITY_HEADERS,
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Password',
  'Access-Control-Max-Age': '86400',
};

// 允许读取的数据文件白名单：查询参数不能直接拼进 GitHub 路径
const DATA_FILES = {
  'problems': 'problems/index.json',
};

const GROUPS = {
  control: { label: '电控组', directory: 'problems' },
  vision: { label: '视觉组', directory: 'problems/vision' },
};

function normalizeGroup(value) {
  return Object.hasOwn(GROUPS, value) ? value : 'control';
}

function problemIndexPath(group) {
  return `${GROUPS[group].directory}/index.json`;
}

function problemFilePath(group, file) {
  return `${GROUPS[group].directory}/${file}`;
}

// 旧数据库记录的 problem_id 直接是 P001；视觉组使用前缀隔离，
// 因此无需改写已有 D1 表或历史提交。
function storedProblemId(group, problemId) {
  return group === 'control' ? problemId : `${group}:${problemId}`;
}

function publicProblemId(value) {
  const match = /^(control|vision):(P\d{3,6})$/.exec(String(value || ''));
  return match ? { group: match[1], problemId: match[2] } : { group: 'control', problemId: String(value || '') };
}

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

const SUBMISSION_LANGUAGE_IDS = {
  c: 103,
  cpp: 105,
  python: 92,
  java: 91,
  javascript: 93,
  go: 106,
  rust: 108,
};

export default {
  async fetch(request, env) {
    // Cloudflare 自定义域名仍可能收到明文 HTTP 请求；在处理任何数据前强制升级到 HTTPS。
    const requestUrl = new URL(request.url);
    if (requestUrl.protocol !== 'https:') {
      requestUrl.protocol = 'https:';
      return new Response(null, {
        status: 308,
        headers: {
          ...SECURITY_HEADERS,
          'Location': requestUrl.toString(),
          'Cache-Control': 'public, max-age=86400',
        },
      });
    }

    // 只允许正式主站网页跨域调用 API。没有 Origin 的服务端/命令行请求
    // 仍由各接口自身的身份验证和速率限制保护。
    const origin = request.headers.get('Origin');
    if (origin && origin !== ALLOWED_ORIGIN) {
      return jsonResponse({ error: '不允许的请求来源', code: 'ORIGIN_NOT_ALLOWED' }, 403);
    }

    // CORS 预检
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // 数据读取：绕开 GitHub Pages CDN 的 max-age=600 缓存
    if (request.method === 'GET') {
      return await handleData(request, env);
    }

    // 其余接口只接受 POST
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
      } else if (body.type === 'admin_login') {
        if (!env.ADMIN_PASSWORD) {
          return jsonResponse({ error: '管理员密码尚未配置' }, 503);
        }
        if (!await secureTextEqual(body.password, env.ADMIN_PASSWORD)) {
          return await failedAdminAuthResponse(request, env, '管理员密码错误');
        }
        return jsonResponse({ success: true });
      } else if (body.type === 'analytics_view') {
        const rateLimitError = await enforceRateLimit(env.ANALYTICS_RATE_LIMITER, request, 'analytics');
        if (rateLimitError) return rateLimitError;
        return await handleAnalyticsView(body, env);
      } else if (body.type === 'execute') {
        const rateLimitError = await enforceRateLimit(env.EXECUTION_RATE_LIMITER, request, 'code-execution');
        if (rateLimitError) return rateLimitError;
        return await handleExecute(body, env);
      } else if (body.type === 'create_problem') {
        const authError = await requireAdmin(request, env);
        if (authError) return authError;
        return await handleCreateProblem(body, env);
      } else if (body.type === 'update_problem') {
        const authError = await requireAdmin(request, env);
        if (authError) return authError;
        return await handleUpdateProblem(body, env);
      } else if (body.type === 'judge_submit') {
        const rateLimitError = await enforceRateLimit(env.EXECUTION_RATE_LIMITER, request, 'code-execution');
        if (rateLimitError) return rateLimitError;
        return await handleJudgeSubmit(body, env);
      } else if (body.type === 'judge_submit_stream') {
        const rateLimitError = await enforceRateLimit(env.EXECUTION_RATE_LIMITER, request, 'code-execution');
        if (rateLimitError) return rateLimitError;
        return await handleJudgeSubmitStream(body, env);
      } else if (body.type === 'judge_preview') {
        const authError = await requireAdmin(request, env);
        if (authError) return authError;
        return await handleJudgeSubmit(body, env, false);
      } else if (body.type === 'submit' || typeof body.passed === 'boolean') {
        return jsonResponse({
          error: '旧版成绩上报接口已停用，请刷新页面后重新提交代码',
          code: 'LEGACY_SUBMISSION_DISABLED',
        }, 410);
      }

      return jsonResponse({ error: 'Unknown request type' }, 400);

    } catch (err) {
      return jsonResponse({ error: err.message }, 500);
    }
  },
};

async function enforceRateLimit(limiter, request, scope) {
  if (!limiter) {
    return jsonResponse({ error: '请求限速器尚未配置', code: 'RATE_LIMIT_NOT_CONFIGURED' }, 503);
  }
  const clientIp = request.headers.get('CF-Connecting-IP') || 'unknown';
  const result = await limiter.limit({ key: `${scope}:${clientIp}` });
  if (result.success) return null;
  const response = jsonResponse({
    error: scope === 'admin-login'
      ? '登录尝试过于频繁，请一分钟后再试'
      : '请求过于频繁，请稍后再试',
    code: 'RATE_LIMITED',
  }, 429);
  response.headers.set('Retry-After', '60');
  return response;
}

async function failedAdminAuthResponse(request, env, message) {
  const rateLimitError = await enforceRateLimit(env.ADMIN_LOGIN_RATE_LIMITER, request, 'admin-login');
  return rateLimitError || jsonResponse({ error: message }, 401);
}

async function requireAdmin(request, env) {
  if (!env.ADMIN_PASSWORD) {
    return jsonResponse({ error: '管理员密码尚未配置' }, 503);
  }
  const password = request.headers.get('X-Admin-Password') || '';
  if (!await secureTextEqual(password, env.ADMIN_PASSWORD)) {
    return await failedAdminAuthResponse(request, env, '管理员身份验证失败，请重新登录');
  }
  return null;
}

async function secureTextEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const encoder = new TextEncoder();
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(left)),
    crypto.subtle.digest('SHA-256', encoder.encode(right)),
  ]);
  const leftBytes = new Uint8Array(leftHash);
  const rightBytes = new Uint8Array(rightHash);
  let difference = 0;
  for (let index = 0; index < leftBytes.length; index++) {
    difference |= leftBytes[index] ^ rightBytes[index];
  }
  return difference === 0;
}

/**
 * 读取仓库数据文件（题目 / 排行榜 / 提交记录）。
 * 走 GitHub Contents API 而不是 raw.githubusercontent：raw 自身也带 CDN 缓存，
 * 会把旧数据再返回一次；API 响应不缓存，且带 Token 不受匿名限额影响。
 */
async function handleData(request, env) {
  const params = new URL(request.url).searchParams;
  const fileType = params.get('file');
  const requestedGroup = params.get('group');
  if (requestedGroup && !Object.hasOwn(GROUPS, requestedGroup)) {
    return jsonResponse({ error: '组别不正确' }, 400);
  }
  const group = normalizeGroup(requestedGroup);

  if (env.OJ_DB && fileType === 'submissions') {
    return await handleD1Submissions(request, env, params);
  }
  if (env.OJ_DB && fileType === 'ranking-v2') {
    const authError = await requireAdmin(request, env);
    if (authError) return authError;
    return await handleD1Ranking(env, group);
  }
  if (env.OJ_DB && fileType === 'analytics') {
    const authError = await requireAdmin(request, env);
    if (authError) return authError;
    return await handleAnalyticsReport(env, group);
  }

  if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) {
    return jsonResponse({ error: 'GitHub 存储尚未配置' }, 503);
  }

  let path = fileType === 'problems' ? problemIndexPath(group) : DATA_FILES[fileType];
  if (fileType === 'problem') {
    const name = String(params.get('name') || '').toLowerCase();
    if (!/^p\d{3,6}(?:-[a-z0-9-]+)?\.json$/.test(name)) {
      return jsonResponse({ error: '题目文件名不正确' }, 400);
    }
    path = problemFilePath(group, name);
  }
  if (!path) {
    return jsonResponse({ error: '不支持的数据文件' }, 400);
  }

  const githubRes = await fetch(
    `https://api.github.com/repos/${env.GITHUB_REPO}/contents/${path}`,
    {
      headers: {
        ...githubHeaders(env.GITHUB_TOKEN),
        // 直接取原始内容：文件超过 1MB 时 base64 形式的接口会返回空 content
        'Accept': 'application/vnd.github.raw',
      },
    }
  );
  if (!githubRes.ok) {
    if (fileType === 'problems' && group === 'vision' && githubRes.status === 404) {
      return jsonResponse([]);
    }
    return githubErrorResponse(githubRes, '读取数据文件失败');
  }

  const rawContent = await githubRes.text();
  if (fileType === 'problems' && env.OJ_DB) {
    try {
      const problems = JSON.parse(rawContent);
      const statsResult = await env.OJ_DB.prepare(`
        SELECT problem_id, COUNT(*) AS total,
               COUNT(DISTINCT username) AS participants,
               COUNT(DISTINCT CASE WHEN passed = 1 THEN username END) AS accepted_users
        FROM submissions
        WHERE ${group === 'control' ? "problem_id NOT LIKE 'vision:%'" : "problem_id LIKE 'vision:%'"}
        GROUP BY problem_id
      `).all();
      const stats = new Map((statsResult.results || []).map(row => {
        const parsed = publicProblemId(row.problem_id);
        return [parsed.problemId, row];
      }));
      for (const problem of problems) {
        const problemStats = stats.get(problem.id);
        const total = Number(problemStats?.total || 0);
        const participants = Number(problemStats?.participants || 0);
        const acceptedUsers = Number(problemStats?.accepted_users || 0);
        problem.submitCount = total;
        problem.acceptRate = participants > 0
          ? `${Math.round((acceptedUsers / participants) * 100)}%`
          : '0%';
      }
      return jsonResponse(problems);
    } catch (error) {
      console.error('D1 题目统计读取失败，使用仓库中的统计快照:', error);
    }
  }

  if (fileType === 'problem') {
    let problem;
    try {
      problem = JSON.parse(rawContent);
    } catch {
      return jsonResponse({ error: '题目文件格式不正确' }, 500);
    }

    const suppliedPassword = request.headers.get('X-Admin-Password');
    if (suppliedPassword) {
      if (!env.ADMIN_PASSWORD || !await secureTextEqual(suppliedPassword, env.ADMIN_PASSWORD)) {
        return await failedAdminAuthResponse(request, env, '管理员身份验证失败，请重新登录');
      }
      const hiddenProblem = await readHiddenProblem(problem.id, env, group);
      if (!hiddenProblem || !Array.isArray(hiddenProblem.testCases)) {
        return jsonResponse({ error: '隐藏测试数据不存在' }, 503);
      }
      problem.testCases = hiddenProblem.testCases;
    } else {
      // 学生只能读取公开题面，隐藏测试点只保存在 KV 中。
      delete problem.testCases;
    }

    problem.group = group;
    return jsonResponse(problem);
  }

  return new Response(rawContent, {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...CORS_HEADERS,
    },
  });
}

function hongKongDay(timestamp = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Hong_Kong',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(timestamp));
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

async function analyticsVisitorHash(visitorId, env) {
  const secret = String(env.ADMIN_PASSWORD || 'jc-oj-analytics');
  const bytes = new TextEncoder().encode(`v1:${secret}:${visitorId}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function handleAnalyticsView(body, env) {
  if (!env.OJ_DB) return jsonResponse({ error: '访问统计数据库尚未配置' }, 503);
  const visitorId = String(body.visitorId || '').trim().normalize('NFC');
  if (!visitorId || visitorId.length > 50 || /[\u0000-\u001f\u007f]/.test(visitorId)) {
    return jsonResponse({ error: '登录用户名格式不正确' }, 400);
  }

  const group = normalizeGroup(body.group);
  const problemId = body.problemId == null ? '' : String(body.problemId).trim().toUpperCase();
  if (problemId && !/^P\d{3,6}$/.test(problemId)) {
    return jsonResponse({ error: '题号格式不正确' }, 400);
  }

  const now = Date.now();
  const visitorHash = await analyticsVisitorHash(visitorId, env);
  const statements = [env.OJ_DB.prepare(`
    INSERT OR IGNORE INTO analytics_site_daily (day, group_name, visitor_hash, first_seen)
    VALUES (?1, ?2, ?3, ?4)
  `).bind(hongKongDay(now), group, visitorHash, now)];

  if (problemId) {
    statements.push(env.OJ_DB.prepare(`
      INSERT INTO analytics_problem_visitors
        (group_name, problem_id, visitor_hash, first_seen, last_seen)
      VALUES (?1, ?2, ?3, ?4, ?4)
      ON CONFLICT(group_name, problem_id, visitor_hash)
      DO UPDATE SET last_seen = excluded.last_seen
    `).bind(group, problemId, visitorHash, now));
  }

  await env.OJ_DB.batch(statements);
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

async function handleAnalyticsReport(env, group) {
  const today = hongKongDay();
  const startDate = new Date(`${today}T00:00:00+08:00`);
  startDate.setUTCDate(startDate.getUTCDate() - 29);
  const startDay = hongKongDay(startDate.getTime());

  const submissionGroupCondition = group === 'control'
    ? "problem_id NOT LIKE 'vision:%'"
    : "problem_id LIKE 'vision:%'";
  const [dailyResult, problemVisitorResult, submitterResult] = await env.OJ_DB.batch([
    env.OJ_DB.prepare(`
      SELECT day, COUNT(*) AS visitors
      FROM analytics_site_daily
      WHERE group_name = ?1 AND day >= ?2 AND day <= ?3
      GROUP BY day
      ORDER BY day ASC
    `).bind(group, startDay, today),
    env.OJ_DB.prepare(`
      SELECT problem_id, visitor_hash
      FROM analytics_problem_visitors
      WHERE group_name = ?1
      ORDER BY problem_id ASC
    `).bind(group),
    env.OJ_DB.prepare(`
      SELECT DISTINCT problem_id, username
      FROM submissions
      WHERE ${submissionGroupCondition}
      ORDER BY problem_id ASC
    `),
  ]);

  const dailyCounts = new Map((dailyResult.results || []).map(row => [row.day, Number(row.visitors) || 0]));
  const daily = [];
  for (let offset = 29; offset >= 0; offset--) {
    const date = new Date(`${today}T00:00:00+08:00`);
    date.setUTCDate(date.getUTCDate() - offset);
    const day = hongKongDay(date.getTime());
    daily.push({ day, visitors: dailyCounts.get(day) || 0 });
  }

  // 已提交过题目的用户名一定浏览过该题。将提交用户与浏览记录做并集，
  // 同一用户名既浏览又提交时仍然只计算一次。
  const problemVisitors = new Map();
  for (const row of problemVisitorResult.results || []) {
    if (!problemVisitors.has(row.problem_id)) problemVisitors.set(row.problem_id, new Set());
    problemVisitors.get(row.problem_id).add(row.visitor_hash);
  }
  const submitterRows = submitterResult.results || [];
  const uniqueUsernames = Array.from(new Set(submitterRows
    .map(row => String(row.username || '').trim().normalize('NFC'))
    .filter(Boolean)));
  const usernameHashes = new Map(await Promise.all(uniqueUsernames.map(async username => [
    username,
    await analyticsVisitorHash(username, env),
  ])));
  for (const row of submitterRows) {
    const username = String(row.username || '').trim().normalize('NFC');
    if (!username) continue;
    const problemId = publicProblemId(row.problem_id).problemId;
    if (!problemVisitors.has(problemId)) problemVisitors.set(problemId, new Set());
    problemVisitors.get(problemId).add(usernameHashes.get(username));
  }

  const problems = {};
  for (const [problemId, visitors] of problemVisitors) {
    problems[problemId] = visitors.size;
  }
  return jsonResponse({ daily, problems });
}

function submissionSummary(row) {
  const parsed = publicProblemId(row.problem_id);
  return {
    username: row.username,
    group: parsed.group,
    problemId: parsed.problemId,
    passed: Number(row.passed) === 1,
    passedTests: Number(row.passed_tests),
    totalTests: Number(row.total_tests),
    totalTime: Number(row.total_time),
    language: row.language,
    timestamp: Number(row.timestamp),
  };
}

async function handleD1Submissions(request, env, params) {
  const group = normalizeGroup(params.get('group'));
  const groupCondition = group === 'control'
    ? "problem_id NOT LIKE 'vision:%'"
    : "problem_id LIKE 'vision:%'";
  const suppliedPassword = request.headers.get('X-Admin-Password');
  if (suppliedPassword) {
    if (!env.ADMIN_PASSWORD || !await secureTextEqual(suppliedPassword, env.ADMIN_PASSWORD)) {
      return await failedAdminAuthResponse(request, env, '管理员身份验证失败，请重新登录');
    }
    const result = await env.OJ_DB.prepare(`
      SELECT username, problem_id, passed, passed_tests, total_tests,
             total_time, language, timestamp
      FROM submissions
      WHERE ${groupCondition}
      ORDER BY timestamp DESC
      LIMIT 20000
    `).all();
    return jsonResponse((result.results || []).map(submissionSummary));
  }

  const username = String(params.get('username') || '').trim().normalize('NFC');
  if (!username) {
    return jsonResponse({ error: '读取个人提交记录时必须提供用户名' }, 400);
  }
  if (username.length > 50) {
    return jsonResponse({ error: '读取个人提交记录时必须提供用户名' }, 400);
  }
  const result = await env.OJ_DB.prepare(`
    SELECT username, problem_id, passed, passed_tests, total_tests,
           total_time, language, timestamp
    FROM submissions
    WHERE username = ?1 AND ${groupCondition}
    ORDER BY timestamp DESC
    LIMIT 500
  `).bind(username).all();
  return jsonResponse((result.results || []).map(submissionSummary));
}

async function handleD1Ranking(env, group) {
  const groupCondition = group === 'control'
    ? "problem_id NOT LIKE 'vision:%'"
    : "problem_id LIKE 'vision:%'";
  const result = await env.OJ_DB.prepare(`
    SELECT username, problem_id, passed, total_time, timestamp
    FROM submissions
    WHERE ${groupCondition}
    ORDER BY timestamp ASC
    LIMIT 100000
  `).all();
  const submissions = (result.results || []).map(row => ({
    username: row.username,
    problemId: publicProblemId(row.problem_id).problemId,
    passed: Number(row.passed) === 1,
    totalTime: Number(row.total_time),
    timestamp: Number(row.timestamp),
  }));
  return jsonResponse(calculateRanking(submissions));
}

function calculateRanking(submissions) {
  const userStats = new Map();
  const problemStats = new Map();

  for (const submission of submissions) {
    const { username, problemId, passed, totalTime, timestamp } = submission;
    if (!username || !problemId || !Number.isFinite(timestamp)) continue;
    if (!userStats.has(username)) {
      userStats.set(username, { solved: new Map(), totalTime: 0, lastSubmit: 0 });
    }
    const user = userStats.get(username);
    user.lastSubmit = Math.max(user.lastSubmit, timestamp);
    if (passed && !user.solved.has(problemId)) {
      const executionTime = Number(totalTime) || 0;
      user.solved.set(problemId, { timestamp, executionTime });
      user.totalTime += executionTime;
    }

    if (!problemStats.has(problemId)) problemStats.set(problemId, new Map());
    const problemUsers = problemStats.get(problemId);
    if (!problemUsers.has(username)) {
      problemUsers.set(username, { attempts: 0, acceptedAt: null, totalTime: null });
    }
    const problemUser = problemUsers.get(username);
    if (problemUser.acceptedAt === null) {
      problemUser.attempts += 1;
      if (passed) {
        problemUser.acceptedAt = timestamp;
        problemUser.totalTime = Number(totalTime) || 0;
      }
    }
  }

  const overall = Array.from(userStats.entries()).map(([username, stats]) => ({
    username,
    solvedCount: stats.solved.size,
    totalTime: stats.totalTime,
    lastSubmit: stats.lastSubmit,
  })).sort((a, b) => b.solvedCount - a.solvedCount
    || a.totalTime - b.totalTime
    || a.lastSubmit - b.lastSubmit);

  const problems = {};
  for (const [problemId, users] of problemStats.entries()) {
    problems[problemId] = Array.from(users.entries())
      .filter(([, stats]) => stats.acceptedAt !== null)
      .map(([username, stats]) => ({ username, ...stats }))
      .sort((a, b) => a.totalTime - b.totalTime || a.acceptedAt - b.acceptedAt);
  }
  return { overall, problems };
}

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
    judge0Res = await fetch(`${judge0BaseUrl}/submissions?base64_encoded=true&wait=true`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        source_code: encodeBase64Utf8(script),
        language_id: languageId,
        stdin: encodeBase64Utf8(stdin || ''),
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
  const stdout = decodeJudge0Field(data.stdout);
  const stderr = decodeJudge0Field(data.stderr);
  const compileOutput = decodeJudge0Field(data.compile_output);
  const message = decodeJudge0Field(data.message);
  const error = compileOutput || stderr || message ||
    (accepted ? '' : statusText);

  return jsonResponse({
    output: stdout,
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
  if (!env.OJ_TESTS) return jsonResponse({ error: '隐藏测试数据库尚未配置' }, 503);

  if (body.group && !Object.hasOwn(GROUPS, body.group)) {
    return jsonResponse({ error: '组别不正确' }, 400);
  }
  const group = normalizeGroup(body.group);
  const validation = validateProblem(body.problem, body.file);
  if (validation.error) return jsonResponse({ error: validation.error }, 400);

  const { problem, file } = validation;
  const imageValidation = validateProblemImages(body.images, problem.id, group);
  if (imageValidation.error) return jsonResponse({ error: imageValidation.error }, 400);
  const images = imageValidation.images;
  if (images.length) {
    const imagesWithoutPlaceholder = [];
    for (const image of images) {
      const placeholder = `oj-image:${image.id}`;
      if (problem.description.includes(placeholder)) {
        problem.description = problem.description.replaceAll(placeholder, image.path);
      } else {
        imagesWithoutPlaceholder.push(image);
      }
    }
    if (imagesWithoutPlaceholder.length) {
      const imageMarkdown = imagesWithoutPlaceholder
        .map(image => `![${image.alt}](${image.path})`)
        .join('\n\n');
      problem.description = `${problem.description}\n\n${imageMarkdown}`;
    }
  }
  const indexPath = problemIndexPath(group);
  const problemPath = problemFilePath(group, file);
  const headers = githubHeaders(env.GITHUB_TOKEN);
  const indexUrl = `https://api.github.com/repos/${env.GITHUB_REPO}/contents/${indexPath}`;

  const indexRes = await fetch(indexUrl, { headers });
  if (!indexRes.ok && !(group === 'vision' && indexRes.status === 404)) {
    return githubErrorResponse(indexRes, '读取题目索引失败');
  }

  const indexFile = indexRes.ok ? await indexRes.json() : null;
  let index;
  if (indexFile) {
    try {
      index = JSON.parse(decodeBase64Utf8(indexFile.content));
    } catch {
      return jsonResponse({ error: '题目索引格式不正确' }, 500);
    }
  } else {
    index = [];
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

  // 先确认目标图片路径均未被占用，避免覆盖仓库中已有文件。
  for (const image of images) {
    const imageUrl = `https://api.github.com/repos/${env.GITHUB_REPO}/contents/${image.path}`;
    const existingImage = await fetch(imageUrl, { headers });
    if (existingImage.ok) {
      return jsonResponse({ error: `图片文件已经存在：${image.path}` }, 409);
    }
    if (existingImage.status !== 404) {
      return githubErrorResponse(existingImage, '检查图片文件失败');
    }
  }

  // 图片保存在仓库内，学生访问题目时不依赖外部图床。
  for (const image of images) {
    const imageUrl = `https://api.github.com/repos/${env.GITHUB_REPO}/contents/${image.path}`;
    const createImageRes = await fetch(imageUrl, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        message: `🖼️ Add image for ${problem.id}`,
        content: image.content,
      }),
    });
    if (!createImageRes.ok) {
      return githubErrorResponse(createImageRes, `上传图片 ${image.alt} 失败`);
    }
  }

  await env.OJ_TESTS.put(`problem:${group}:${problem.id}`, JSON.stringify(problem));
  const publicProblem = { ...problem, group };
  delete publicProblem.testCases;

  const createProblemRes = await fetch(problemUrl, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      message: `📝 Add ${GROUPS[group].label} problem ${problem.id} - ${problem.title}`,
      content: encodeBase64Utf8(JSON.stringify(publicProblem, null, 2)),
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
      message: `🗂️ Register ${GROUPS[group].label} problem ${problem.id}`,
      content: encodeBase64Utf8(JSON.stringify(index, null, 2)),
      ...(indexFile ? { sha: indexFile.sha } : {}),
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

function decodeJudge0Field(value) {
  if (!value) return '';
  try {
    return decodeBase64Utf8(String(value));
  } catch {
    return String(value);
  }
}

/**
 * 从管理页面修改题目，并同步题目索引中的标题和难度。
 */
async function handleUpdateProblem(body, env) {
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) {
    return jsonResponse({ error: 'GitHub 存储尚未配置' }, 503);
  }
  if (!env.OJ_TESTS) return jsonResponse({ error: '隐藏测试数据库尚未配置' }, 503);

  if (body.group && !Object.hasOwn(GROUPS, body.group)) {
    return jsonResponse({ error: '组别不正确' }, 400);
  }
  const group = normalizeGroup(body.group);
  const validation = validateProblem(body.problem, body.file);
  if (validation.error) return jsonResponse({ error: validation.error }, 400);
  const { problem, file } = validation;
  const imageValidation = validateProblemImages(body.images, problem.id, group);
  if (imageValidation.error) return jsonResponse({ error: imageValidation.error }, 400);
  const images = imageValidation.images;

  if (images.length) {
    const imagesWithoutPlaceholder = [];
    for (const image of images) {
      const placeholder = `oj-image:${image.id}`;
      if (problem.description.includes(placeholder)) {
        problem.description = problem.description.replaceAll(placeholder, image.path);
      } else {
        imagesWithoutPlaceholder.push(image);
      }
    }
    if (imagesWithoutPlaceholder.length) {
      problem.description += `\n\n${imagesWithoutPlaceholder
        .map(image => `![${image.alt}](${image.path})`)
        .join('\n\n')}`;
    }
  }

  const headers = githubHeaders(env.GITHUB_TOKEN);
  const indexPath = problemIndexPath(group);
  const problemPath = problemFilePath(group, file);
  const indexUrl = `https://api.github.com/repos/${env.GITHUB_REPO}/contents/${indexPath}`;
  const problemUrl = `https://api.github.com/repos/${env.GITHUB_REPO}/contents/${problemPath}`;
  const [indexRes, problemRes] = await Promise.all([
    fetch(indexUrl, { headers }),
    fetch(problemUrl, { headers }),
  ]);
  if (!indexRes.ok) return githubErrorResponse(indexRes, '读取题目索引失败');
  if (!problemRes.ok) return githubErrorResponse(problemRes, '读取题目文件失败');

  const indexFile = await indexRes.json();
  const problemFile = await problemRes.json();
  let index;
  try {
    index = JSON.parse(decodeBase64Utf8(indexFile.content));
  } catch {
    return jsonResponse({ error: '题目索引格式不正确' }, 500);
  }
  if (!Array.isArray(index)) return jsonResponse({ error: '题目索引必须是数组' }, 500);

  const indexItem = index.find(item => item.file === file);
  if (!indexItem) return jsonResponse({ error: '题目不在题目列表中' }, 404);
  if (indexItem.id !== problem.id) {
    return jsonResponse({ error: '编辑题目时不能修改题号' }, 400);
  }

  for (const image of images) {
    const imageUrl = `https://api.github.com/repos/${env.GITHUB_REPO}/contents/${image.path}`;
    const existingImage = await fetch(imageUrl, { headers });
    if (existingImage.ok) return jsonResponse({ error: `图片文件已经存在：${image.path}` }, 409);
    if (existingImage.status !== 404) return githubErrorResponse(existingImage, '检查图片文件失败');
  }
  for (const image of images) {
    const imageUrl = `https://api.github.com/repos/${env.GITHUB_REPO}/contents/${image.path}`;
    const createImageRes = await fetch(imageUrl, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        message: `🖼️ Add image for ${problem.id}`,
        content: image.content,
      }),
    });
    if (!createImageRes.ok) return githubErrorResponse(createImageRes, `上传图片 ${image.alt} 失败`);
  }

  await env.OJ_TESTS.put(`problem:${group}:${problem.id}`, JSON.stringify(problem));
  const publicProblem = { ...problem, group };
  delete publicProblem.testCases;

  const updateProblemRes = await fetch(problemUrl, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      message: `✏️ Update ${GROUPS[group].label} problem ${problem.id} - ${problem.title}`,
      content: encodeBase64Utf8(JSON.stringify(publicProblem, null, 2)),
      sha: problemFile.sha,
    }),
  });
  if (!updateProblemRes.ok) return githubErrorResponse(updateProblemRes, '更新题目文件失败');

  indexItem.title = problem.title;
  indexItem.difficulty = problem.difficulty;
  const updateIndexRes = await fetch(indexUrl, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      message: `🗂️ Sync ${GROUPS[group].label} problem ${problem.id} metadata`,
      content: encodeBase64Utf8(JSON.stringify(index, null, 2)),
      sha: indexFile.sha,
    }),
  });
  if (!updateIndexRes.ok) {
    return githubErrorResponse(updateIndexRes, '题目内容已更新，但同步题目列表失败，请重试');
  }

  return jsonResponse({ success: true, problem: indexItem });
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

  let samples = [];
  if (input.samples !== undefined) {
    if (!Array.isArray(input.samples) || input.samples.length > 20) {
      return { error: '样例数量不能超过 20 组' };
    }
    for (const [index, sample] of input.samples.entries()) {
      if (!sample || typeof sample.input !== 'string' || typeof sample.output !== 'string') {
        return { error: `样例 ${index + 1} 格式不正确` };
      }
      if (sample.input || sample.output) samples.push({ input: sample.input, output: sample.output });
    }
  } else if (input.sampleInput || input.sampleOutput) {
    samples = [{
      input: String(input.sampleInput || ''),
      output: String(input.sampleOutput || ''),
    }];
  }

  const pythonJudgeMode = input.pythonJudgeMode === 'function' ? 'function' : 'standard';
  let pythonFunction = null;
  if (pythonJudgeMode === 'function') {
    const functionValidation = normalizePythonFunctionSignature(input.pythonFunctionSignature);
    if (functionValidation.error) return { error: functionValidation.error };
    pythonFunction = functionValidation.pythonFunction;
  }

  const problem = {
    id,
    title: input.title.trim().slice(0, 100),
    difficulty,
    description: input.description.trim().slice(0, 20000),
    inputFormat: input.inputFormat.trim().slice(0, 10000),
    outputFormat: input.outputFormat.trim().slice(0, 10000),
    constraints: String(input.constraints || '').trim().slice(0, 10000),
    sampleExplanation: String(input.sampleExplanation || '').trim().slice(0, 20000),
    // 保留首组旧字段，兼容已经缓存的旧版学生页面。
    sampleInput: samples[0]?.input || '',
    sampleOutput: samples[0]?.output || '',
    samples,
    testCases,
    showTestDetails: input.showTestDetails === true,
    // 旧题没有该字段时保持原有行为：默认展开提示。
    hintsDefaultExpanded: input.hintsDefaultExpanded !== false,
    hints: Array.isArray(input.hints)
      ? input.hints.map(item => String(item).trim()).filter(Boolean).slice(0, 20)
      : [],
    pythonJudgeMode,
    ...(pythonFunction ? { pythonFunction } : {}),
  };

  return { problem, file };
}

function normalizePythonFunctionSignature(value) {
  let signature = typeof value === 'string' ? value.trim() : '';
  signature = signature.replace(/^def\s+/, '').replace(/:\s*$/, '').trim();
  const match = /^([A-Za-z_]\w*)\s*\((.*)\)\s*(?:->\s*(.+))?$/.exec(signature);
  if (!match) {
    return { error: 'Python 方法签名格式不正确，例如：hasCycle(self, head: ListNode) -> bool' };
  }

  const methodName = match[1];
  const rawParameters = match[2].trim() ? match[2].split(',').map(item => item.trim()) : [];
  if (rawParameters[0] !== 'self') {
    return { error: 'Python 核心函数的第一个参数必须是 self' };
  }

  const normalizedParameters = ['self'];
  const parameterTypes = [];
  const parameterNames = new Set(['self']);
  for (const parameter of rawParameters.slice(1)) {
    const parameterMatch = /^([A-Za-z_]\w*)\s*:\s*(.+)$/.exec(parameter);
    if (!parameterMatch) return { error: `参数“${parameter}”需要填写类型标注` };
    if (parameterNames.has(parameterMatch[1])) return { error: `参数名“${parameterMatch[1]}”重复` };
    const type = normalizePythonFunctionType(parameterMatch[2]);
    if (!type) return { error: `暂不支持参数类型“${parameterMatch[2]}”` };
    parameterNames.add(parameterMatch[1]);
    parameterTypes.push(type);
    normalizedParameters.push(`${parameterMatch[1]}: ${type}`);
  }

  const returnType = match[3] ? normalizePythonFunctionType(match[3], true) : 'Any';
  if (!returnType) return { error: `暂不支持返回类型“${match[3]}”` };
  return {
    pythonFunction: {
      signature: `${methodName}(${normalizedParameters.join(', ')}) -> ${returnType}`,
      methodName,
      parameterTypes,
      returnType,
    },
  };
}

function normalizePythonFunctionType(value, allowNone = false) {
  const type = String(value || '').replace(/\s/g, '');
  if (['int', 'float', 'str', 'bool', 'Any', 'ListNode', 'TreeNode'].includes(type)) return type;
  if (allowNone && type === 'None') return type;
  const generic = /^(List|list|Optional)\[(.+)\]$/.exec(type);
  if (!generic) return '';
  const inner = normalizePythonFunctionType(generic[2], allowNone);
  if (!inner) return '';
  return `${generic[1] === 'list' ? 'List' : generic[1]}[${inner}]`;
}

function validateProblemImages(input, problemId, group = 'control') {
  if (input === undefined || input === null) return { images: [] };
  if (!Array.isArray(input) || input.length > 5) {
    return { error: '每道题最多上传 5 张图片' };
  }

  const extensions = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
  };
  const images = [];
  let totalBytes = 0;

  for (const [index, image] of input.entries()) {
    const id = typeof image?.id === 'string' ? image.id.trim() : '';
    const extension = extensions[image?.type];
    const content = typeof image?.content === 'string' ? image.content.replace(/\s/g, '') : '';
    if (!/^[a-zA-Z0-9-]{8,64}$/.test(id)
        || !extension || !content || !/^[A-Za-z0-9+/]+={0,2}$/.test(content)) {
      return { error: `第 ${index + 1} 张图片格式不正确` };
    }

    let byteLength;
    try {
      byteLength = atob(content).length;
    } catch {
      return { error: `第 ${index + 1} 张图片内容损坏` };
    }
    if (byteLength > 3 * 1024 * 1024) {
      return { error: `第 ${index + 1} 张图片超过 3 MB` };
    }
    totalBytes += byteLength;
    if (totalBytes > 10 * 1024 * 1024) {
      return { error: '题目图片总大小不能超过 10 MB' };
    }

    const originalName = String(image.name || `图片 ${index + 1}`);
    const alt = originalName
      .replace(/\.[^.]+$/, '')
      .replace(/[\[\]\\]/g, '')
      .trim()
      .slice(0, 100) || `题目图片 ${index + 1}`;
    const baseName = problemId.toLowerCase();
    images.push({
      id,
      alt,
      content,
      path: group === 'control'
        ? `assets/problems/${baseName}/${baseName}-${id.slice(0, 8)}.${extension}`
        : `assets/problems/${group}/${baseName}/${baseName}-${id.slice(0, 8)}.${extension}`,
    });
  }

  return { images };
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

function buildPythonFunctionSubmission(source, pythonFunction) {
  const config = JSON.stringify({
    methodName: pythonFunction.methodName,
    parameterTypes: pythonFunction.parameterTypes,
  });
  return `from typing import List, Optional, Any
import json as __oj_json
import sys as __oj_sys

class ListNode:
    def __init__(self, val=0, next=None):
        self.val = val
        self.next = next

class TreeNode:
    def __init__(self, val=0, left=None, right=None):
        self.val = val
        self.left = left
        self.right = right

${source}

def __oj_convert(value, type_name):
    type_name = type_name.replace(' ', '')
    if type_name.startswith('Optional[') and type_name.endswith(']'):
        if value is None:
            return None
        type_name = type_name[9:-1]
    if type_name in ('Any', ''):
        return value
    if type_name == 'int':
        return int(value)
    if type_name == 'float':
        return float(value)
    if type_name == 'str':
        return str(value)
    if type_name == 'bool':
        return bool(value)
    if (type_name.startswith('List[') or type_name.startswith('list[')) and type_name.endswith(']'):
        item_type = type_name[type_name.index('[') + 1:-1]
        return [__oj_convert(item, item_type) for item in value]
    if type_name == 'ListNode':
        values = value.get('values', []) if isinstance(value, dict) else value
        cycle_position = value.get('pos', -1) if isinstance(value, dict) else -1
        nodes = [ListNode(item) for item in values]
        for index in range(len(nodes) - 1):
            nodes[index].next = nodes[index + 1]
        if nodes and isinstance(cycle_position, int) and 0 <= cycle_position < len(nodes):
            nodes[-1].next = nodes[cycle_position]
        return nodes[0] if nodes else None
    if type_name == 'TreeNode':
        if not value or value[0] is None:
            return None
        nodes = [None if item is None else TreeNode(item) for item in value]
        child = 1
        for node in nodes:
            if node is None:
                continue
            if child < len(nodes):
                node.left = nodes[child]
                child += 1
            if child < len(nodes):
                node.right = nodes[child]
                child += 1
        return nodes[0]
    return value

def __oj_serialize(value):
    if isinstance(value, ListNode):
        result, visited = [], set()
        while value is not None and id(value) not in visited and len(result) < 10000:
            visited.add(id(value))
            result.append(value.val)
            value = value.next
        return result
    if isinstance(value, TreeNode):
        result, queue = [], [value]
        while queue and len(result) < 10000:
            node = queue.pop(0)
            if node is None:
                result.append(None)
                continue
            result.append(node.val)
            queue.extend([node.left, node.right])
        while result and result[-1] is None:
            result.pop()
        return result
    if isinstance(value, tuple):
        return [__oj_serialize(item) for item in value]
    if isinstance(value, list):
        return [__oj_serialize(item) for item in value]
    if isinstance(value, dict):
        return {key: __oj_serialize(item) for key, item in value.items()}
    return value

def __oj_print(value):
    value = __oj_serialize(value)
    if isinstance(value, bool):
        print('true' if value else 'false')
    elif value is None:
        print('null')
    elif isinstance(value, str):
        print(value)
    elif isinstance(value, (list, dict)):
        print(__oj_json.dumps(value, ensure_ascii=False, separators=(',', ':')))
    else:
        print(value)

__oj_config = ${config}
if 'Solution' in globals() and hasattr(Solution, __oj_config['methodName']):
    __oj_text = __oj_sys.stdin.read().strip()
    __oj_raw = __oj_json.loads(__oj_text) if __oj_text else None
    __oj_types = __oj_config['parameterTypes']
    if len(__oj_types) == 0:
        __oj_values = []
    elif len(__oj_types) == 1:
        __oj_values = [__oj_raw]
    else:
        if not isinstance(__oj_raw, list) or len(__oj_raw) != len(__oj_types):
            raise ValueError('多个参数的测试输入必须是长度匹配的 JSON 数组')
        __oj_values = __oj_raw
    __oj_args = [__oj_convert(value, type_name) for value, type_name in zip(__oj_values, __oj_types)]
    __oj_print(getattr(Solution(), __oj_config['methodName'])(*__oj_args))
`;
}

/**
 * 从 KV 读取包含隐藏测试点的完整题目。
 */
async function readHiddenProblem(problemId, env, group = 'control') {
  if (!env.OJ_TESTS || !/^P\d{3,6}$/.test(String(problemId))) return null;
  try {
    const groupedProblem = await env.OJ_TESTS.get(`problem:${group}:${problemId}`, 'json');
    if (groupedProblem) return groupedProblem;
    // 兼容分组功能上线前保存的电控组隐藏测试点。
    return group === 'control'
      ? await env.OJ_TESTS.get(`problem:${problemId}`, 'json')
      : null;
  } catch {
    return null;
  }
}

/**
 * 服务端判题：浏览器只提交源码，最终结果由 Worker 和 Judge0 共同生成。
 */
async function prepareJudgeSubmission(body, env) {
  const username = typeof body.username === 'string' ? body.username.trim() : '';
  const problemId = typeof body.problemId === 'string' ? body.problemId.trim().toUpperCase() : '';
  const language = typeof body.language === 'string' ? body.language.trim() : '';
  const script = typeof body.code === 'string' ? body.code : '';
  const languageId = SUBMISSION_LANGUAGE_IDS[language];
  if (body.group && !Object.hasOwn(GROUPS, body.group)) {
    throw judgeError('组别不正确', 400, 'INVALID_GROUP');
  }
  const group = normalizeGroup(body.group);

  if (!username || username.length > 50 || !/^P\d{3,6}$/.test(problemId)
      || !Number.isInteger(languageId) || !script.trim() || script.length > 200000) {
    throw judgeError('提交内容格式不正确', 400, 'INVALID_SUBMISSION');
  }

  const problem = await readHiddenProblem(problemId, env, group);
  const testCases = problem?.testCases;
  if (!Array.isArray(testCases) || testCases.length === 0 || testCases.length > 50) {
    throw judgeError('题目隐藏测试数据不可用', 503, 'TESTS_UNAVAILABLE');
  }

  return { username, problemId, group, language, script, languageId, problem, testCases };
}

function judgeError(message, status = 500, code = 'JUDGE_FAILED') {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function wait(delayMs) {
  return new Promise(resolve => setTimeout(resolve, delayMs));
}

async function executeWithRetry(payload, env, onRetry) {
  const maxAttempts = 3;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const executionResponse = await handleExecute(payload, env);
    const execution = await executionResponse.json();
    if (executionResponse.ok) return execution;

    lastError = judgeError(
      execution.error || '代码执行服务暂时不可用',
      executionResponse.status,
      execution.code || 'JUDGE_UNAVAILABLE'
    );
    const retryable = executionResponse.status === 429 || executionResponse.status >= 500;
    if (!retryable || attempt === maxAttempts) break;
    if (onRetry) await onRetry(attempt + 1, maxAttempts);
    await wait(attempt * 700);
  }

  throw lastError || judgeError('代码执行服务暂时不可用', 502, 'JUDGE_UNAVAILABLE');
}

async function runJudgeSubmission(body, env, onEvent, shouldPersist = true) {
  const prepared = await prepareJudgeSubmission(body, env);
  const { username, problemId, group, language, script, languageId, problem, testCases } = prepared;
  if (onEvent) await onEvent({ type: 'start', totalTests: testCases.length });

  const results = [];
  let passedTests = 0;
  let totalTime = 0;
  const executionScript = language === 'python'
    && problem.pythonJudgeMode === 'function'
    && problem.pythonFunction
    ? buildPythonFunctionSubmission(script, problem.pythonFunction)
    : script;

  for (const [index, testCase] of testCases.entries()) {
    if (!testCase || typeof testCase.input !== 'string' || typeof testCase.expectedOutput !== 'string') {
      throw judgeError(`隐藏测试点 ${index + 1} 格式不正确`, 500, 'INVALID_TEST_CASE');
    }

    const execution = await executeWithRetry({
      script: executionScript,
      stdin: testCase.input,
      languageId,
    }, env, async (attempt, maxAttempts) => {
      if (onEvent) await onEvent({
        type: 'retry',
        current: index + 1,
        totalTests: testCases.length,
        attempt,
        maxAttempts,
      });
    });

    const passed = execution.exitCode === 0
      && String(execution.output || '').trim() === testCase.expectedOutput.trim();
    if (passed) passedTests += 1;
    totalTime += Number.isFinite(Number(execution.time)) ? Number(execution.time) : 0;

    let message = '';
    if (!passed) {
      if (execution.compileError) message = execution.error || '编译错误';
      else if (execution.exitCode !== 0) message = execution.error || execution.status || '运行错误';
      else message = '输出结果不正确';
    }
    results.push({
      index: index + 1,
      passed,
      time: execution.time,
      compileError: execution.compileError === true,
      message: String(message).slice(0, 3000),
      ...(problem.showTestDetails === true ? {
        input: testCase.input.slice(0, 10000),
        actualOutput: String(execution.output || '').slice(0, 10000),
      } : {}),
    });

    if (onEvent) await onEvent({
      type: 'progress',
      current: index + 1,
      totalTests: testCases.length,
      passed,
      time: execution.time,
    });

    if (!passed) break;
  }

  const passed = passedTests === testCases.length;
  const result = {
    problemId,
    group,
    language,
    passed,
    passedTests,
    totalTests: testCases.length,
    totalTime,
    results,
    timestamp: Date.now(),
  };

  if (shouldPersist) {
    if (onEvent) await onEvent({ type: 'saving', passed, passedTests, totalTests: testCases.length });
    const saveResponse = await persistSubmission({
      username,
      problemId,
      group,
      passed,
      passedTests,
      totalTests: testCases.length,
      totalTime,
      language,
      code: encodeBase64Utf8(script),
      timestamp: result.timestamp,
    }, env);
    if (!saveResponse.ok) {
      const saveError = await saveResponse.json();
      throw judgeError(saveError.error || '保存提交记录失败', saveResponse.status, saveError.code || 'SAVE_FAILED');
    }
  }

  return result;
}

async function handleJudgeSubmit(body, env, shouldPersist = true) {
  try {
    return jsonResponse(await runJudgeSubmission(body, env, null, shouldPersist));
  } catch (error) {
    return jsonResponse({ error: error.message, code: error.code || 'JUDGE_FAILED' }, error.status || 500);
  }
}

async function handleJudgeSubmitStream(body, env) {
  const encoder = new TextEncoder();
  const readable = new ReadableStream({
    async start(controller) {
      const send = event => controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      try {
        const result = await runJudgeSubmission(body, env, send, true);
        send({ type: 'result', result });
      } catch (error) {
        try {
          send({
            type: 'error',
            error: error.message || '判题失败',
            code: error.code || 'JUDGE_FAILED',
          });
        } catch {
          // 客户端已经断开连接。
        }
      } finally {
        try { controller.close(); } catch { /* 客户端已经断开连接。 */ }
      }
    },
  });

  return new Response(readable, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...CORS_HEADERS,
    },
  });
}

/**
 * 保存由服务端生成的可信判题结果。
 */
async function persistSubmission(body, env) {
  const { username, problemId, passed, passedTests, totalTests, totalTime, language, code, timestamp } = body;
  if (body.group && !Object.hasOwn(GROUPS, body.group)) {
    return jsonResponse({ error: '组别不正确' }, 400);
  }
  const group = normalizeGroup(body.group);

  if (!username || !problemId || typeof passed !== 'boolean') {
    return jsonResponse({ error: 'Invalid payload' }, 400);
  }

  const normalizedProblemId = String(problemId).trim().toUpperCase();
  const normalizedPassedTests = Number(passedTests);
  const normalizedTotalTests = Number(totalTests);
  const normalizedTotalTime = Number(totalTime);
  const normalizedLanguage = String(language || '').trim().slice(0, 30);
  if (!/^P\d{3,6}$/.test(normalizedProblemId)
      || !Number.isInteger(normalizedPassedTests) || normalizedPassedTests < 0
      || !Number.isInteger(normalizedTotalTests) || normalizedTotalTests < 1 || normalizedTotalTests > 1000
      || normalizedPassedTests > normalizedTotalTests
      || !Number.isFinite(normalizedTotalTime) || normalizedTotalTime < 0 || normalizedTotalTime > 3600000
      || !/^[a-zA-Z0-9_+#.-]{1,30}$/.test(normalizedLanguage)
      || typeof code !== 'string' || code.length > 3000000) {
    return jsonResponse({ error: '提交数据格式不正确' }, 400);
  }

  if (!env.OJ_DB) {
    return jsonResponse({
      error: 'D1 提交存储尚未配置',
      code: 'D1_NOT_CONFIGURED',
    }, 503);
  }

  const displayUsername = String(username)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .normalize('NFC')
    .slice(0, 50);
  if (!displayUsername) return jsonResponse({ error: '用户名不能为空' }, 400);

  const safeTimestamp = Number.isFinite(Number(timestamp)) ? Math.trunc(Number(timestamp)) : Date.now();
  try {
    const result = await env.OJ_DB.prepare(`
      INSERT INTO submissions (
        username, problem_id, passed, passed_tests, total_tests,
        total_time, language, code, timestamp
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
    `).bind(
      displayUsername,
      storedProblemId(group, normalizedProblemId),
      passed ? 1 : 0,
      normalizedPassedTests,
      normalizedTotalTests,
      normalizedTotalTime,
      normalizedLanguage,
      code,
      safeTimestamp,
    ).run();
    return jsonResponse({ success: true, id: result.meta?.last_row_id || null });
  } catch (error) {
    console.error('D1 保存提交失败:', error);
    return jsonResponse({ error: '提交记录保存失败', code: 'D1_WRITE_FAILED' }, 503);
  }
}

/**
 * 统一 JSON 响应（带 CORS 头）
 */
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...CORS_HEADERS,
    },
  });
}
