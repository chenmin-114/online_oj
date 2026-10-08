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
const ADMIN_SESSION_COOKIE = '__Host-oj_admin_session';
const ADMIN_SESSION_TTL_SECONDS = 2 * 60 * 60;
const STUDENT_SESSION_COOKIE = '__Host-oj_student_session';
const STUDENT_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const ADMIN_IMPERSONATION_TTL_SECONDS = 30 * 60;
const STUDENT_PASSWORD_ITERATIONS = 100000;
// 套卷答案允许最多 600 KB 文本；考虑 UTF-8 中文和 JSON 转义后，普通请求保留 2 MiB 余量。
const NORMAL_REQUEST_BODY_LIMIT = 2 * 1024 * 1024;
// 题目图片原文件合计允许 10 MB，Base64 会额外增加约三分之一体积。
const PROBLEM_UPLOAD_BODY_LIMIT = 16 * 1024 * 1024;
const LARGE_BODY_REQUEST_TYPES = new Set(['create_problem', 'update_problem']);
const TIMED_GRACE_MS = 60 * 1000;
const AFTER_END_VIEW_POLICIES = new Set(['none', 'all', 'authorized']);

const CORS_HEADERS = {
  ...SECURITY_HEADERS,
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Credentials': 'true',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
  'Vary': 'Origin',
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
  const match = /^(control|vision):((?:P\d{3,6}|T\d{3}))$/.exec(String(value || ''));
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

    const declaredLength = Number(request.headers.get('Content-Length'));
    if (Number.isFinite(declaredLength) && declaredLength > PROBLEM_UPLOAD_BODY_LIMIT) {
      return requestBodyTooLargeResponse(PROBLEM_UPLOAD_BODY_LIMIT);
    }
    // 正常浏览器上传图片时会携带 Content-Length。大请求先验证管理员会话，
    // 避免匿名请求借图片上传额度消耗 Worker 内存。
    if (Number.isFinite(declaredLength) && declaredLength > NORMAL_REQUEST_BODY_LIMIT) {
      const adminToken = readCookie(request, ADMIN_SESSION_COOKIE);
      if (!/^[A-Za-z0-9_-]{43}$/.test(adminToken)) {
        return requestBodyTooLargeResponse(NORMAL_REQUEST_BODY_LIMIT);
      }
      const authError = await requireAdmin(request, env);
      if (authError) return authError;
    }

    let parsedBody;
    try {
      parsedBody = await readJsonRequest(request, PROBLEM_UPLOAD_BODY_LIMIT);
    } catch (error) {
      if (error?.code === 'REQUEST_BODY_TOO_LARGE') {
        return requestBodyTooLargeResponse(PROBLEM_UPLOAD_BODY_LIMIT);
      }
      return jsonResponse({ error: '请求格式不正确' }, 400);
    }
    const body = parsedBody.value;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return jsonResponse({ error: '请求格式不正确' }, 400);
    }
    const bodyLimit = LARGE_BODY_REQUEST_TYPES.has(body.type)
      ? PROBLEM_UPLOAD_BODY_LIMIT
      : NORMAL_REQUEST_BODY_LIMIT;
    if (parsedBody.byteLength > bodyLimit) {
      return requestBodyTooLargeResponse(bodyLimit);
    }

    try {

      // 路由：根据 type 字段分发
      if (body.type === 'health') {
        return jsonResponse({ ok: true });
      } else if (body.type === 'admin_health') {
        const authError = await requireAdmin(request, env);
        if (authError) return authError;
        return jsonResponse({
          ok: true,
          executionProvider: 'Judge0 CE',
          githubConfigured: Boolean(env.GITHUB_TOKEN && env.GITHUB_REPO),
        });
      } else if (body.type === 'admin_login') {
        if (!env.ADMIN_PASSWORD) {
          return jsonResponse({ error: '管理员密码尚未配置' }, 503);
        }
        if (!await secureTextEqual(body.password, env.ADMIN_PASSWORD)) {
          return await failedAdminAuthResponse(request, env, '管理员密码错误');
        }
        const session = await createAdminSession(env);
        if (session.error) return session.error;
        return jsonResponse({ success: true, expiresIn: ADMIN_SESSION_TTL_SECONDS }, 200, {
          'Set-Cookie': buildAdminSessionCookie(session.token, ADMIN_SESSION_TTL_SECONDS),
        });
      } else if (body.type === 'admin_session') {
        const authError = await requireAdmin(request, env);
        if (authError) return authError;
        return jsonResponse({ success: true });
      } else if (body.type === 'admin_logout') {
        await revokeAdminSession(request, env);
        return jsonResponse({ success: true }, 200, {
          'Set-Cookie': buildAdminSessionCookie('', 0),
        });
      } else if (body.type === 'admin_import_students') {
        const authError = await requireAdmin(request, env);
        if (authError) return authError;
        return await handleAdminImportStudents(body, env);
      } else if (body.type === 'admin_reset_student_account') {
        const authError = await requireAdmin(request, env);
        if (authError) return authError;
        return await handleAdminResetStudentAccount(body, env);
      } else if (body.type === 'admin_impersonate_student') {
        const authError = await requireAdmin(request, env);
        if (authError) return authError;
        return await handleAdminImpersonateStudent(body, env);
      } else if (body.type === 'admin_timed_extension_list') {
        const authError = await requireAdmin(request, env);
        if (authError) return authError;
        return await handleAdminTimedExtensionList(body, env);
      } else if (body.type === 'admin_timed_extension_grant') {
        const authError = await requireAdmin(request, env);
        if (authError) return authError;
        return await handleAdminTimedExtensionGrant(body, env);
      } else if (body.type === 'admin_timed_extension_revoke') {
        const authError = await requireAdmin(request, env);
        if (authError) return authError;
        return await handleAdminTimedExtensionRevoke(body, env);
      } else if (body.type === 'admin_system_settings_get') {
        const authError = await requireAdmin(request, env);
        if (authError) return authError;
        return jsonResponse({ examMode: await isExamModeEnabled(env) });
      } else if (body.type === 'admin_system_settings_save') {
        const authError = await requireAdmin(request, env);
        if (authError) return authError;
        return await handleAdminSystemSettingsSave(body, env);
      } else if (body.type === 'admin_exam_list') {
        const authError = await requireAdmin(request, env);
        if (authError) return authError;
        return await handleAdminExamList(body, env);
      } else if (body.type === 'admin_exam_get') {
        const authError = await requireAdmin(request, env);
        if (authError) return authError;
        return await handleAdminExamGet(body, env);
      } else if (body.type === 'admin_exam_save') {
        const authError = await requireAdmin(request, env);
        if (authError) return authError;
        return await handleAdminExamSave(body, env);
      } else if (body.type === 'admin_exam_roster_account_status') {
        const authError = await requireAdmin(request, env);
        if (authError) return authError;
        return await handleAdminExamRosterAccountStatus(body, env);
      } else if (body.type === 'admin_exam_roster_import') {
        const authError = await requireAdmin(request, env);
        if (authError) return authError;
        return await handleAdminExamRosterImport(body, env);
      } else if (body.type === 'admin_exam_access_revoke') {
        const authError = await requireAdmin(request, env);
        if (authError) return authError;
        return await handleAdminExamAccessRevoke(body, env);
      } else if (body.type === 'admin_exam_preview_grade') {
        const rateLimitError = await enforceRateLimit(env.EXECUTION_RATE_LIMITER, request, 'code-execution');
        if (rateLimitError) return rateLimitError;
        const authError = await requireAdmin(request, env);
        if (authError) return authError;
        return await handleAdminExamPreviewGrade(body, env);
      } else if (body.type === 'admin_exam_preview_get') {
        const authError = await requireAdmin(request, env);
        if (authError) return authError;
        return await handleAdminExamPreviewGet(body, env);
      } else if (body.type === 'admin_exam_preview_submit') {
        const rateLimitError = await enforceRateLimit(env.EXECUTION_RATE_LIMITER, request, 'code-execution');
        if (rateLimitError) return rateLimitError;
        const authError = await requireAdmin(request, env);
        if (authError) return authError;
        return await handleAdminExamPreviewSubmit(body, env);
      } else if (body.type === 'admin_exam_submissions') {
        const authError = await requireAdmin(request, env);
        if (authError) return authError;
        return await handleAdminExamSubmissions(body, env);
      } else if (body.type === 'admin_exam_submission_get') {
        const authError = await requireAdmin(request, env);
        if (authError) return authError;
        return await handleAdminExamSubmissionGet(body, env);
      } else if (body.type === 'admin_exam_grade') {
        const authError = await requireAdmin(request, env);
        if (authError) return authError;
        return await handleAdminExamGrade(body, env);
      } else if (body.type === 'admin_exam_ai_export') {
        const authError = await requireAdmin(request, env);
        if (authError) return authError;
        return await handleAdminExamAiExport(body, env);
      } else if (body.type === 'admin_exam_ai_import') {
        const authError = await requireAdmin(request, env);
        if (authError) return authError;
        return await handleAdminExamAiImport(body, env);
      } else if (body.type === 'admin_exam_ai_adopt') {
        const authError = await requireAdmin(request, env);
        if (authError) return authError;
        return await handleAdminExamAiAdopt(body, env);
      } else if (body.type === 'admin_exam_ai_delete') {
        const authError = await requireAdmin(request, env);
        if (authError) return authError;
        return await handleAdminExamAiDelete(body, env);
      } else if (body.type === 'admin_exam_part_clear_grading') {
        const authError = await requireAdmin(request, env);
        if (authError) return authError;
        return await handleAdminExamPartClearGrading(body, env);
      } else if (body.type === 'admin_exam_part_bulk_action') {
        const authError = await requireAdmin(request, env);
        if (authError) return authError;
        return await handleAdminExamPartBulkAction(body, env);
      } else if (body.type === 'admin_rejudge_submission') {
        const authError = await requireAdmin(request, env);
        if (authError) return authError;
        return await handleAdminRejudgeSubmission(body, env);
      } else if (body.type === 'admin_request_resubmission') {
        const authError = await requireAdmin(request, env);
        if (authError) return authError;
        return await handleAdminRequestResubmission(body, env);
      } else if (body.type === 'admin_message_list') {
        const authError = await requireAdmin(request, env);
        if (authError) return authError;
        return await handleAdminMessageList(env);
      } else if (body.type === 'admin_message_create') {
        const authError = await requireAdmin(request, env);
        if (authError) return authError;
        return await handleAdminMessageCreate(body, env);
      } else if (body.type === 'admin_message_delete') {
        const authError = await requireAdmin(request, env);
        if (authError) return authError;
        return await handleAdminMessageDelete(body, env);
      } else if (body.type === 'student_account_status') {
        const rateLimitError = await enforceRateLimit(env.STUDENT_AUTH_RATE_LIMITER, request, 'student-auth');
        if (rateLimitError) return rateLimitError;
        return await handleStudentAccountStatus(body, env);
      } else if (body.type === 'student_login') {
        const rateLimitError = await enforceRateLimit(
          env.STUDENT_LOGIN_RATE_LIMITER,
          request,
          'student-login',
          normalizeStudentUsername(body.username),
          false,
        );
        if (rateLimitError) return rateLimitError;
        return await handleStudentLogin(body, env);
      } else if (body.type === 'student_set_password') {
        const rateLimitError = await enforceRateLimit(env.STUDENT_AUTH_RATE_LIMITER, request, 'student-auth');
        if (rateLimitError) return rateLimitError;
        return await handleStudentSetPassword(body, env);
      } else if (body.type === 'student_change_password') {
        const rateLimitError = await enforceRateLimit(
          env.STUDENT_LOGIN_RATE_LIMITER,
          request,
          'student-login',
          normalizeStudentUsername(body.username),
          false,
        );
        if (rateLimitError) return rateLimitError;
        if (await isExamModeEnabled(env)) {
          return jsonResponse({ error: '考试模式下不能修改密码', code: 'EXAM_MODE_PASSWORD_LOCKED' }, 403);
        }
        return await handleStudentChangePassword(body, env);
      } else if (body.type === 'student_session') {
        const rateLimitError = await enforceRateLimit(env.STUDENT_AUTH_RATE_LIMITER, request, 'student-auth');
        if (rateLimitError) return rateLimitError;
        const authError = await requireStudentSession(request, env, body.username);
        if (authError) return authError;
        return jsonResponse({
          success: true,
          adminImpersonation: await isAdminImpersonationSession(request, env, body.username),
          examMode: await isExamModeEnabled(env),
        });
      } else if (body.type === 'student_resubmission_notices') {
        const authError = await requireStudentAccess(request, env, body.username);
        if (authError) return authError;
        return await handleStudentResubmissionNotices(body, env);
      } else if (body.type === 'student_messages') {
        const authError = await requireStudentAccess(request, env, body.username);
        if (authError) return authError;
        return await handleStudentMessages(body, env);
      } else if (body.type === 'student_message_read') {
        const authError = await requireStudentAccess(request, env, body.username);
        if (authError) return authError;
        return await handleStudentMessageRead(body, env);
      } else if (body.type === 'student_skip_login') {
        const rateLimitError = await enforceRateLimit(env.STUDENT_AUTH_RATE_LIMITER, request, 'student-auth');
        if (rateLimitError) return rateLimitError;
        return await handleStudentSkipLogin(body, env);
      } else if (body.type === 'student_logout') {
        await revokeStudentSession(request, env);
        return jsonResponse({ success: true }, 200, {
          'Set-Cookie': buildStudentSessionCookie('', 0),
        });
      } else if (body.type === 'exam_list') {
        const authError = await requireStudentAccess(request, env, body.username);
        if (authError) return authError;
        return await handleStudentExamList(body, env);
      } else if (body.type === 'exam_get') {
        const authError = await requireStudentAccess(request, env, body.username);
        if (authError) return authError;
        return await handleStudentExamGet(body, env);
      } else if (body.type === 'timed_draft_save') {
        const rateLimitError = await enforceRateLimit(
          env.DRAFT_RATE_LIMITER, request, 'timed-draft', normalizeStudentUsername(body.username), false,
        );
        if (rateLimitError) return rateLimitError;
        const authError = await requireStudentAccess(request, env, body.username);
        if (authError) return authError;
        if (body.resourceType === 'problem' && await isExamModeEnabled(env)) return examModeOnlyResponse();
        const impersonationError = await requireImpersonationConfirmation(
          request, env, body, '保存限时草稿', body.resourceType, body.resourceId,
        );
        if (impersonationError) return impersonationError;
        return await handleTimedDraftSave(body, env);
      } else if (body.type === 'time_sync') {
        const rateLimitError = await enforceRateLimit(
          env.DRAFT_RATE_LIMITER, request, 'time-sync', normalizeStudentUsername(body.username), false,
        );
        if (rateLimitError) return rateLimitError;
        const authError = await requireStudentAccess(request, env, body.username);
        if (authError) return authError;
        if (body.resourceType === 'problem' && await isExamModeEnabled(env)) return examModeOnlyResponse();
        return await handleTimeSync(body, env);
      } else if (body.type === 'timed_finalize') {
        const rateLimitError = await enforceRateLimit(
          env.DRAFT_RATE_LIMITER, request, 'timed-finalize', normalizeStudentUsername(body.username), false,
        );
        if (rateLimitError) return rateLimitError;
        const authError = await requireStudentAccess(request, env, body.username);
        if (authError) return authError;
        if (body.resourceType === 'problem' && await isExamModeEnabled(env)) return examModeOnlyResponse();
        const impersonationError = await requireImpersonationConfirmation(
          request, env, body, '提交截止答案', body.resourceType, body.resourceId,
        );
        if (impersonationError) return impersonationError;
        return await handleTimedFinalize(body, env);
      } else if (body.type === 'exam_submit') {
        const rateLimitError = await enforceRateLimit(env.EXECUTION_RATE_LIMITER, request, 'code-execution');
        if (rateLimitError) return rateLimitError;
        const authError = await requireStudentAccess(request, env, body.username);
        if (authError) return authError;
        const impersonationError = await requireImpersonationConfirmation(
          request, env, body, '提交套卷', 'exam', body.examId,
        );
        if (impersonationError) return impersonationError;
        return await handleStudentExamSubmit(body, env);
      } else if (body.type === 'analytics_view') {
        const rateLimitError = await enforceRateLimit(env.ANALYTICS_RATE_LIMITER, request, 'analytics');
        if (rateLimitError) return rateLimitError;
        const authError = await requireStudentAccess(request, env, body.visitorId);
        if (authError) return authError;
        return await handleAnalyticsView(body, env);
      } else if (body.type === 'execute') {
        const rateLimitError = await enforceRateLimit(env.EXECUTION_RATE_LIMITER, request, 'code-execution');
        if (rateLimitError) return rateLimitError;
        const authError = await requireStudentAccess(request, env, body.username);
        if (authError) return authError;
        if (await isExamModeEnabled(env)) {
          const examExecutionError = await validateExamModeExecution(body, env);
          if (examExecutionError) return examExecutionError;
        }
        return await handleExecute(body, env);
      } else if (body.type === 'admin_execute') {
        const rateLimitError = await enforceRateLimit(env.EXECUTION_RATE_LIMITER, request, 'code-execution');
        if (rateLimitError) return rateLimitError;
        const authError = await requireAdmin(request, env);
        if (authError) return authError;
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
        const authError = await requireStudentAccess(request, env, body.username);
        if (authError) return authError;
        if (await isExamModeEnabled(env)) return examModeOnlyResponse();
        const impersonationError = await requireImpersonationConfirmation(
          request, env, body, '提交编程题', 'problem', body.problemId,
        );
        if (impersonationError) return impersonationError;
        return await handleJudgeSubmit(body, env);
      } else if (body.type === 'judge_submit_stream') {
        const rateLimitError = await enforceRateLimit(env.EXECUTION_RATE_LIMITER, request, 'code-execution');
        if (rateLimitError) return rateLimitError;
        const authError = await requireStudentAccess(request, env, body.username);
        if (authError) return authError;
        if (await isExamModeEnabled(env)) return examModeOnlyResponse();
        const impersonationError = await requireImpersonationConfirmation(
          request, env, body, '提交编程题', 'problem', body.problemId,
        );
        if (impersonationError) return impersonationError;
        return await handleJudgeSubmitStream(body, env);
      } else if (body.type === 'judge_preview') {
        const rateLimitError = await enforceRateLimit(env.EXECUTION_RATE_LIMITER, request, 'code-execution');
        if (rateLimitError) return rateLimitError;
        const authError = await requireAdmin(request, env);
        if (authError) return authError;
        return await handleJudgeSubmit(body, env, false, true);
      } else if (body.type === 'judge_preview_stream') {
        const rateLimitError = await enforceRateLimit(env.EXECUTION_RATE_LIMITER, request, 'code-execution');
        if (rateLimitError) return rateLimitError;
        const authError = await requireAdmin(request, env);
        if (authError) return authError;
        return await handleJudgeSubmitStream(body, env, false, true);
      } else if (body.type === 'submit' || typeof body.passed === 'boolean') {
        return jsonResponse({
          error: '旧版成绩上报接口已停用，请刷新页面后重新提交代码',
          code: 'LEGACY_SUBMISSION_DISABLED',
        }, 410);
      }

      return jsonResponse({ error: 'Unknown request type' }, 400);

    } catch (error) {
      console.error('API 请求处理失败:', error);
      return jsonResponse({ error: '服务器内部错误' }, 500);
    }
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(Promise.all([
      processNextRejudgeJob(env),
      processNextTimedSubmission(env),
    ]));
  },
};

async function readJsonRequest(request, maxBytes) {
  if (!request.body) throw new Error('EMPTY_BODY');
  const reader = request.body.getReader();
  const chunks = [];
  let byteLength = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    byteLength += value.byteLength;
    if (byteLength > maxBytes) {
      try { await reader.cancel(); } catch { /* 请求流可能已经结束 */ }
      const error = new Error('REQUEST_BODY_TOO_LARGE');
      error.code = 'REQUEST_BODY_TOO_LARGE';
      throw error;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return {
    value: JSON.parse(new TextDecoder().decode(bytes)),
    byteLength,
  };
}

function requestBodyTooLargeResponse(limit) {
  const limitMiB = Math.round(limit / (1024 * 1024));
  return jsonResponse({
    error: `请求内容过大，最大允许 ${limitMiB} MiB`,
    code: 'REQUEST_BODY_TOO_LARGE',
  }, 413);
}

async function enforceRateLimit(limiter, request, scope, discriminator = '', includeClientIp = true) {
  if (!limiter) {
    return jsonResponse({ error: '请求限速器尚未配置', code: 'RATE_LIMIT_NOT_CONFIGURED' }, 503);
  }
  const clientIp = request.headers.get('CF-Connecting-IP') || 'unknown';
  const discriminatorHash = discriminator ? (await sha256Hex(discriminator)).slice(0, 16) : '';
  const keyParts = [scope];
  if (includeClientIp) keyParts.push(clientIp);
  if (discriminatorHash) keyParts.push(discriminatorHash);
  const result = await limiter.limit({ key: keyParts.join(':') });
  if (result.success) return null;
  const response = jsonResponse({
    error: scope === 'admin-login'
      ? '登录尝试过于频繁，请一分钟后再试'
      : scope === 'student-auth'
        ? '账号操作过于频繁，请一分钟后再试'
      : scope === 'student-login'
        ? '该账号密码尝试过于频繁，请一分钟后再试'
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
  if (!env.OJ_DB) {
    return jsonResponse({ error: '管理员会话数据库尚未配置' }, 503);
  }
  const token = readCookie(request, ADMIN_SESSION_COOKIE);
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
    return adminSessionErrorResponse();
  }

  const sessionHash = await sha256Hex(token);
  const now = Date.now();
  const session = await env.OJ_DB.prepare(`
    SELECT expires_at
    FROM admin_sessions
    WHERE session_hash = ?1
  `).bind(sessionHash).first();
  if (!session || Number(session.expires_at) <= now) {
    if (session) {
      await env.OJ_DB.prepare('DELETE FROM admin_sessions WHERE session_hash = ?1')
        .bind(sessionHash).run();
    }
    return adminSessionErrorResponse();
  }
  return null;
}

function adminSessionErrorResponse() {
  return jsonResponse({ error: '管理员登录已失效，请重新登录' }, 401, {
    'Set-Cookie': buildAdminSessionCookie('', 0),
  });
}

async function createAdminSession(env) {
  if (!env.OJ_DB) {
    return { error: jsonResponse({ error: '管理员会话数据库尚未配置' }, 503) };
  }
  const randomBytes = new Uint8Array(32);
  crypto.getRandomValues(randomBytes);
  const token = bytesToBase64Url(randomBytes);
  const sessionHash = await sha256Hex(token);
  const createdAt = Date.now();
  const expiresAt = createdAt + ADMIN_SESSION_TTL_SECONDS * 1000;
  await env.OJ_DB.batch([
    env.OJ_DB.prepare('DELETE FROM admin_sessions WHERE expires_at <= ?1').bind(createdAt),
    env.OJ_DB.prepare(`
      INSERT INTO admin_sessions (session_hash, created_at, expires_at)
      VALUES (?1, ?2, ?3)
    `).bind(sessionHash, createdAt, expiresAt),
  ]);
  return { token };
}

async function revokeAdminSession(request, env) {
  if (!env.OJ_DB) return;
  const token = readCookie(request, ADMIN_SESSION_COOKIE);
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return;
  await env.OJ_DB.prepare('DELETE FROM admin_sessions WHERE session_hash = ?1')
    .bind(await sha256Hex(token)).run();
}

function readCookie(request, name) {
  const cookieHeader = request.headers.get('Cookie') || '';
  for (const item of cookieHeader.split(';')) {
    const separator = item.indexOf('=');
    if (separator === -1) continue;
    if (item.slice(0, separator).trim() === name) {
      return item.slice(separator + 1).trim();
    }
  }
  return '';
}

function buildAdminSessionCookie(token, maxAge) {
  return `${ADMIN_SESSION_COOKIE}=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`;
}

function bytesToBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function normalizeStudentUsername(value) {
  const username = String(value || '').trim().normalize('NFC');
  if (!username || username.length > 50 || /[\u0000-\u001f\u007f]/.test(username)) return '';
  return username;
}

async function isExamModeEnabled(env) {
  if (!env.OJ_DB) return false;
  const setting = await env.OJ_DB.prepare(`
    SELECT setting_value FROM system_settings WHERE setting_key = 'exam_mode'
  `).first();
  return setting?.setting_value === '1';
}

function examModeOnlyResponse() {
  return jsonResponse({
    error: '当前处于考试模式，只能访问和提交套卷',
    code: 'EXAM_MODE_ONLY',
  }, 403);
}

async function handleAdminSystemSettingsSave(body, env) {
  if (!env.OJ_DB) return jsonResponse({ error: '系统设置数据库尚未配置' }, 503);
  const examMode = body.examMode === true;
  await env.OJ_DB.prepare(`
    INSERT INTO system_settings (setting_key, setting_value, updated_at)
    VALUES ('exam_mode', ?1, ?2)
    ON CONFLICT(setting_key) DO UPDATE SET
      setting_value = excluded.setting_value,
      updated_at = excluded.updated_at
  `).bind(examMode ? '1' : '0', Date.now()).run();
  return jsonResponse({ success: true, examMode });
}

async function handleStudentAccountStatus(body, env) {
  if (!env.OJ_DB) return jsonResponse({ error: '学生账号数据库尚未配置' }, 503);
  const username = normalizeStudentUsername(body.username);
  if (!username) return jsonResponse({ error: '用户名格式不正确' }, 400);
  const account = await env.OJ_DB.prepare(`
    SELECT password_hash
    FROM student_accounts
    WHERE username = ?1
  `).bind(username).first();
  return jsonResponse({
    registered: Boolean(account),
    hasPassword: Boolean(account?.password_hash),
    examMode: await isExamModeEnabled(env),
  });
}

async function handleStudentLogin(body, env) {
  if (!env.OJ_DB) return jsonResponse({ error: '学生账号数据库尚未配置' }, 503);
  const username = normalizeStudentUsername(body.username);
  const password = typeof body.password === 'string' ? body.password : '';
  if (!username || !password || password.length > 128) {
    return jsonResponse({ error: '用户名或密码错误' }, 401);
  }
  const account = await env.OJ_DB.prepare(`
    SELECT password_salt, password_hash, password_iterations, auth_version
    FROM student_accounts
    WHERE username = ?1
  `).bind(username).first();
  if (!account?.password_hash || !account.password_salt) {
    return jsonResponse({ error: '用户名或密码错误' }, 401);
  }
  const iterations = Number(account.password_iterations);
  if (!Number.isInteger(iterations) || iterations < 100000 || iterations > 1000000) {
    return jsonResponse({ error: '账号密码数据异常，请联系管理员' }, 503);
  }
  const candidateHash = await deriveStudentPasswordHash(password, account.password_salt, iterations);
  if (!await secureTextEqual(candidateHash, account.password_hash)) {
    return jsonResponse({ error: '用户名或密码错误' }, 401);
  }
  return await studentSessionSuccessResponse(username, Number(account.auth_version), env);
}

async function handleStudentSetPassword(body, env) {
  if (!env.OJ_DB) return jsonResponse({ error: '学生账号数据库尚未配置' }, 503);
  const username = normalizeStudentUsername(body.username);
  const password = typeof body.password === 'string' ? body.password : '';
  if (!username) return jsonResponse({ error: '用户名格式不正确' }, 400);
  if (password.length < 8 || password.length > 128) {
    return jsonResponse({ error: '密码长度需要为 8 到 128 个字符' }, 400);
  }

  const saltBytes = new Uint8Array(16);
  crypto.getRandomValues(saltBytes);
  const salt = bytesToBase64Url(saltBytes);
  const hash = await deriveStudentPasswordHash(password, salt, STUDENT_PASSWORD_ITERATIONS);
  const now = Date.now();
  const result = await env.OJ_DB.prepare(`
    INSERT INTO student_accounts (
      username, password_salt, password_hash, password_iterations, auth_version, created_at, updated_at
    ) VALUES (?1, ?2, ?3, ?4, 1, ?5, ?5)
    ON CONFLICT(username) DO UPDATE SET
      password_salt = excluded.password_salt,
      password_hash = excluded.password_hash,
      password_iterations = excluded.password_iterations,
      auth_version = student_accounts.auth_version + 1,
      updated_at = excluded.updated_at
    WHERE student_accounts.password_hash IS NULL
  `).bind(username, salt, hash, STUDENT_PASSWORD_ITERATIONS, now).run();
  if (!Number(result.meta?.changes)) {
    return jsonResponse({ error: '该账号已经设置密码，请返回后输入原密码' }, 409);
  }
  await env.OJ_DB.prepare('DELETE FROM student_sessions WHERE username = ?1').bind(username).run();
  const account = await env.OJ_DB.prepare('SELECT auth_version FROM student_accounts WHERE username = ?1')
    .bind(username).first();
  return await studentSessionSuccessResponse(username, Number(account.auth_version), env);
}

async function handleStudentChangePassword(body, env) {
  if (!env.OJ_DB) return jsonResponse({ error: '学生账号数据库尚未配置' }, 503);
  const username = normalizeStudentUsername(body.username);
  const currentPassword = typeof body.currentPassword === 'string' ? body.currentPassword : '';
  const newPassword = typeof body.newPassword === 'string' ? body.newPassword : '';
  if (!username || !currentPassword || currentPassword.length > 128) {
    return jsonResponse({ error: '当前密码不正确' }, 401);
  }
  if (newPassword.length < 8 || newPassword.length > 128) {
    return jsonResponse({ error: '新密码长度需要为 8 到 128 个字符' }, 400);
  }
  if (currentPassword === newPassword) {
    return jsonResponse({ error: '新密码不能与当前密码相同' }, 400);
  }
  const account = await env.OJ_DB.prepare(`
    SELECT password_salt, password_hash, password_iterations, auth_version
    FROM student_accounts WHERE username = ?1
  `).bind(username).first();
  if (!account?.password_hash || !account.password_salt) {
    return jsonResponse({ error: '当前密码不正确' }, 401);
  }
  const iterations = Number(account.password_iterations);
  if (!Number.isInteger(iterations) || iterations < 100000 || iterations > 1000000) {
    return jsonResponse({ error: '账号密码数据异常，请联系管理员' }, 503);
  }
  const currentHash = await deriveStudentPasswordHash(currentPassword, account.password_salt, iterations);
  if (!await secureTextEqual(currentHash, account.password_hash)) {
    return jsonResponse({ error: '当前密码不正确' }, 401);
  }

  const saltBytes = new Uint8Array(16);
  crypto.getRandomValues(saltBytes);
  const salt = bytesToBase64Url(saltBytes);
  const hash = await deriveStudentPasswordHash(newPassword, salt, STUDENT_PASSWORD_ITERATIONS);
  const nextAuthVersion = Number(account.auth_version) + 1;
  const now = Date.now();
  await env.OJ_DB.batch([
    env.OJ_DB.prepare(`
      UPDATE student_accounts
      SET password_salt = ?2, password_hash = ?3, password_iterations = ?4,
          auth_version = ?5, updated_at = ?6
      WHERE username = ?1
    `).bind(username, salt, hash, STUDENT_PASSWORD_ITERATIONS, nextAuthVersion, now),
    env.OJ_DB.prepare('DELETE FROM student_sessions WHERE username = ?1').bind(username),
  ]);
  return await studentSessionSuccessResponse(username, nextAuthVersion, env);
}

async function handleStudentSkipLogin(body, env) {
  if (!env.OJ_DB) return jsonResponse({ error: '学生账号数据库尚未配置' }, 503);
  const username = normalizeStudentUsername(body.username);
  if (!username) return jsonResponse({ error: '用户名格式不正确' }, 400);
  const account = await env.OJ_DB.prepare(`
    SELECT password_hash, auth_version
    FROM student_accounts
    WHERE username = ?1
  `).bind(username).first();
  if (account?.password_hash) {
    return jsonResponse({
      error: '该账号已经设置密码，不能跳过验证',
      code: 'STUDENT_AUTH_REQUIRED',
    }, 409);
  }
  if (!account) {
    const now = Date.now();
    await env.OJ_DB.prepare(`
      INSERT OR IGNORE INTO student_accounts (
        username, password_salt, password_hash, password_iterations, auth_version, created_at, updated_at
      ) VALUES (?1, NULL, NULL, NULL, 1, ?2, ?2)
    `).bind(username, now).run();
  }
  const authVersion = account ? Number(account.auth_version) : 1;
  return await studentSessionSuccessResponse(username, authVersion, env);
}

async function studentSessionSuccessResponse(username, authVersion, env) {
  const session = await createStudentSession(username, authVersion, env);
  return jsonResponse({
    success: true,
    expiresIn: STUDENT_SESSION_TTL_SECONDS,
    examMode: await isExamModeEnabled(env),
  }, 200, {
    'Set-Cookie': buildStudentSessionCookie(session.token, STUDENT_SESSION_TTL_SECONDS),
  });
}

async function createStudentSession(username, authVersion, env, options = {}) {
  const randomBytes = new Uint8Array(32);
  crypto.getRandomValues(randomBytes);
  const token = bytesToBase64Url(randomBytes);
  const sessionHash = await sha256Hex(token);
  const createdAt = Date.now();
  const ttlSeconds = options.adminImpersonation
    ? ADMIN_IMPERSONATION_TTL_SECONDS
    : STUDENT_SESSION_TTL_SECONDS;
  const expiresAt = createdAt + ttlSeconds * 1000;
  const statements = [
    env.OJ_DB.prepare('DELETE FROM student_sessions WHERE expires_at <= ?1').bind(createdAt),
    env.OJ_DB.prepare('DELETE FROM admin_impersonation_sessions WHERE expires_at <= ?1').bind(createdAt),
    env.OJ_DB.prepare(`
      INSERT INTO student_sessions (session_hash, username, auth_version, created_at, expires_at)
      VALUES (?1, ?2, ?3, ?4, ?5)
    `).bind(sessionHash, username, authVersion, createdAt, expiresAt),
  ];
  if (options.adminImpersonation) {
    statements.push(
      env.OJ_DB.prepare(`
        INSERT INTO admin_impersonation_sessions (session_hash, username, created_at, expires_at)
        VALUES (?1, ?2, ?3, ?4)
      `).bind(sessionHash, username, createdAt, expiresAt),
      env.OJ_DB.prepare(`
        INSERT INTO admin_impersonation_audit (username, action, resource_type, resource_id, created_at)
        VALUES (?1, '开始代登录', 'account', ?1, ?2)
      `).bind(username, createdAt),
    );
  }
  await env.OJ_DB.batch(statements);
  return { token, ttlSeconds };
}

async function revokeStudentSession(request, env) {
  if (!env.OJ_DB) return;
  const token = readCookie(request, STUDENT_SESSION_COOKIE);
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return;
  const sessionHash = await sha256Hex(token);
  await env.OJ_DB.batch([
    env.OJ_DB.prepare('DELETE FROM student_sessions WHERE session_hash = ?1').bind(sessionHash),
    env.OJ_DB.prepare('DELETE FROM admin_impersonation_sessions WHERE session_hash = ?1').bind(sessionHash),
  ]);
}

function buildStudentSessionCookie(token, maxAge) {
  return `${STUDENT_SESSION_COOKIE}=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`;
}

async function requireStudentAccess(request, env, suppliedUsername) {
  return await requireStudentSession(request, env, suppliedUsername);
}

async function requireStudentSession(request, env, suppliedUsername) {
  if (!env.OJ_DB) return jsonResponse({ error: '学生账号数据库尚未配置' }, 503);
  const username = normalizeStudentUsername(suppliedUsername);
  if (!username) return jsonResponse({ error: '用户名格式不正确' }, 400);
  const token = readCookie(request, STUDENT_SESSION_COOKIE);
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return studentAuthRequiredResponse();
  const sessionHash = await sha256Hex(token);
  const now = Date.now();
  const session = await env.OJ_DB.prepare(`
    SELECT s.username, s.expires_at, s.auth_version, a.auth_version AS current_auth_version
    FROM student_sessions AS s
    LEFT JOIN student_accounts AS a ON a.username = s.username
    WHERE s.session_hash = ?1
  `).bind(sessionHash).first();
  if (!session
      || Number(session.expires_at) <= now
      || session.username !== username
      || Number(session.auth_version) !== Number(session.current_auth_version)) {
    if (session && Number(session.expires_at) <= now) {
      await env.OJ_DB.prepare('DELETE FROM student_sessions WHERE session_hash = ?1')
        .bind(sessionHash).run();
    }
    return studentAuthRequiredResponse();
  }
  return null;
}

async function isAdminImpersonationSession(request, env, suppliedUsername) {
  if (!env.OJ_DB) return false;
  const username = normalizeStudentUsername(suppliedUsername);
  const token = readCookie(request, STUDENT_SESSION_COOKIE);
  if (!username || !/^[A-Za-z0-9_-]{43}$/.test(token)) return false;
  const row = await env.OJ_DB.prepare(`
    SELECT 1 AS found
    FROM admin_impersonation_sessions
    WHERE session_hash = ?1 AND username = ?2 AND expires_at > ?3
  `).bind(await sha256Hex(token), username, Date.now()).first();
  return Boolean(row);
}

async function requireImpersonationConfirmation(request, env, body, action, resourceType, resourceId) {
  const username = normalizeStudentUsername(body.username);
  if (!await isAdminImpersonationSession(request, env, username)) return null;
  if (body.adminImpersonationConfirmed !== true) {
    return jsonResponse({
      error: '这是管理员代登录会话，请在页面确认后再执行该操作',
      code: 'ADMIN_IMPERSONATION_CONFIRMATION_REQUIRED',
    }, 409);
  }
  await env.OJ_DB.prepare(`
    INSERT INTO admin_impersonation_audit (username, action, resource_type, resource_id, created_at)
    VALUES (?1, ?2, ?3, ?4, ?5)
  `).bind(
    username, normalizeExamText(action, 80), normalizeExamText(resourceType, 30),
    normalizeExamText(resourceId, 80), Date.now(),
  ).run();
  return null;
}

async function handleAdminImpersonateStudent(body, env) {
  if (!env.OJ_DB) return jsonResponse({ error: '学生账号数据库尚未配置' }, 503);
  const username = normalizeStudentUsername(body.username);
  if (!username) return jsonResponse({ error: '学生用户名格式不正确' }, 400);
  const account = await env.OJ_DB.prepare(`
    SELECT auth_version FROM student_accounts WHERE username = ?1
  `).bind(username).first();
  if (!account) return jsonResponse({ error: '找不到该学生账号' }, 404);
  const session = await createStudentSession(username, Number(account.auth_version), env, {
    adminImpersonation: true,
  });
  return jsonResponse({
    success: true,
    username,
    expiresIn: session.ttlSeconds,
    adminImpersonation: true,
  }, 200, {
    'Set-Cookie': buildStudentSessionCookie(session.token, session.ttlSeconds),
  });
}

async function studentSessionUsername(request, env) {
  if (!env.OJ_DB) return '';
  const token = readCookie(request, STUDENT_SESSION_COOKIE);
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return '';
  const session = await env.OJ_DB.prepare(`
    SELECT s.username, s.expires_at, s.auth_version, a.auth_version AS current_auth_version
    FROM student_sessions s JOIN student_accounts a ON a.username = s.username
    WHERE s.session_hash = ?1
  `).bind(await sha256Hex(token)).first();
  return session && Number(session.expires_at) > Date.now()
    && Number(session.auth_version) === Number(session.current_auth_version)
    ? session.username : '';
}

function studentAuthRequiredResponse() {
  return jsonResponse({
    error: '该账号需要重新验证密码',
    code: 'STUDENT_AUTH_REQUIRED',
  }, 401, {
    'Set-Cookie': buildStudentSessionCookie('', 0),
  });
}

async function handleAdminImportStudents(body, env) {
  if (!env.OJ_DB) return jsonResponse({ error: '学生账号数据库尚未配置' }, 503);
  if (!Array.isArray(body.accounts) || body.accounts.length < 1 || body.accounts.length > 2000) {
    return jsonResponse({ error: '账号数量必须在 1 到 2000 之间' }, 400);
  }

  const accounts = new Map();
  for (const item of body.accounts) {
    const username = normalizeStudentUsername(item?.username);
    const salt = String(item?.salt || '');
    const hash = String(item?.hash || '');
    if (!username || !/^[A-Za-z0-9_-]{22}$/.test(salt) || !/^[A-Za-z0-9_-]{43}$/.test(hash)) {
      return jsonResponse({ error: '账号数据格式不正确' }, 400);
    }
    accounts.set(username, { username, salt, hash });
  }

  const now = Date.now();
  const statements = Array.from(accounts.values()).flatMap(account => [
    env.OJ_DB.prepare(`
      INSERT INTO student_accounts (
        username, password_salt, password_hash, password_iterations, auth_version, is_managed, created_at, updated_at
      ) VALUES (?1, ?2, ?3, ?4, 1, 1, ?5, ?5)
      ON CONFLICT(username) DO UPDATE SET
        password_salt = excluded.password_salt,
        password_hash = excluded.password_hash,
        password_iterations = excluded.password_iterations,
        auth_version = student_accounts.auth_version + 1,
        is_managed = 1,
        updated_at = excluded.updated_at
    `).bind(
      account.username,
      account.salt,
      account.hash,
      STUDENT_PASSWORD_ITERATIONS,
      now,
    ),
    env.OJ_DB.prepare('DELETE FROM student_sessions WHERE username = ?1').bind(account.username),
    env.OJ_DB.prepare('DELETE FROM exam_access_revocations WHERE username = ?1').bind(account.username),
    env.OJ_DB.prepare(`
      INSERT OR IGNORE INTO exam_roster (exam_id, username, created_at)
      SELECT exam_id, ?1, ?2 FROM exam_access_policies WHERE managed_default_allowed = 0
    `).bind(account.username, now),
  ]);
  for (let index = 0; index < statements.length; index += 100) {
    await env.OJ_DB.batch(statements.slice(index, index + 100));
  }
  return jsonResponse({ success: true, imported: accounts.size });
}

async function handleAdminResetStudentAccount(body, env) {
  if (!env.OJ_DB) return jsonResponse({ error: '学生账号数据库尚未配置' }, 503);
  const username = normalizeStudentUsername(body.username);
  const salt = String(body.salt || '');
  const hash = String(body.hash || '');
  if (!username || !/^[A-Za-z0-9_-]{22}$/.test(salt) || !/^[A-Za-z0-9_-]{43}$/.test(hash)) {
    return jsonResponse({ error: '账号或密码数据格式不正确' }, 400);
  }
  const existing = await env.OJ_DB.prepare('SELECT 1 AS found FROM student_accounts WHERE username = ?1')
    .bind(username).first();
  const now = Date.now();
  await env.OJ_DB.batch([
    env.OJ_DB.prepare(`
      INSERT INTO student_accounts (
        username, password_salt, password_hash, password_iterations, auth_version, is_managed, created_at, updated_at
      ) VALUES (?1, ?2, ?3, ?4, 1, 1, ?5, ?5)
      ON CONFLICT(username) DO UPDATE SET
        password_salt = excluded.password_salt,
        password_hash = excluded.password_hash,
        password_iterations = excluded.password_iterations,
        auth_version = student_accounts.auth_version + 1,
        is_managed = 1,
        updated_at = excluded.updated_at
    `).bind(username, salt, hash, STUDENT_PASSWORD_ITERATIONS, now),
    env.OJ_DB.prepare('DELETE FROM student_sessions WHERE username = ?1').bind(username),
    env.OJ_DB.prepare('DELETE FROM exam_access_revocations WHERE username = ?1').bind(username),
    env.OJ_DB.prepare(`
      INSERT OR IGNORE INTO exam_roster (exam_id, username, created_at)
      SELECT exam_id, ?1, ?2 FROM exam_access_policies WHERE managed_default_allowed = 0
    `).bind(username, now),
  ]);
  return jsonResponse({
    success: true,
    username,
    created: !existing,
    access: 'all_exams',
  });
}

function normalizeTimedExtensionTarget(body) {
  const resourceType = body.resourceType === 'problem' ? 'problem' : body.resourceType === 'exam' ? 'exam' : '';
  const resourceId = resourceType === 'exam'
    ? normalizeExamId(body.resourceId)
    : String(body.resourceId || '').trim().toUpperCase();
  const username = normalizeStudentUsername(body.username);
  const minutes = Number(body.minutes);
  return { resourceType, resourceId, username, minutes };
}

async function handleAdminTimedExtensionList(body, env) {
  if (!env.OJ_DB) return jsonResponse({ error: '补时数据库尚未配置' }, 503);
  const group = normalizeGroup(body.group);
  const now = Date.now();
  await env.OJ_DB.prepare('DELETE FROM timed_extensions WHERE ends_at < ?1')
    .bind(now - 7 * 24 * 60 * 60 * 1000).run();
  const result = await env.OJ_DB.prepare(`
    SELECT resource_type, resource_id, username, starts_at, ends_at, created_at
    FROM timed_extensions WHERE group_name = ?1
    ORDER BY ends_at DESC LIMIT 200
  `).bind(group).all();
  return jsonResponse((result.results || []).map(row => ({
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    username: row.username,
    startsAt: Number(row.starts_at),
    endsAt: Number(row.ends_at),
    createdAt: Number(row.created_at),
    active: Number(row.ends_at) > now,
  })));
}

async function handleAdminTimedExtensionGrant(body, env) {
  if (!env.OJ_DB) return jsonResponse({ error: '补时数据库尚未配置' }, 503);
  const group = normalizeGroup(body.group);
  const { resourceType, resourceId, username, minutes } = normalizeTimedExtensionTarget(body);
  if (!resourceType || !username || !Number.isInteger(minutes) || minutes < 1 || minutes > 1440
      || (resourceType === 'problem' && !/^(?:P\d{3,6}|T\d{3})$/.test(resourceId))) {
    return jsonResponse({ error: '补时参数不正确；分钟数必须为 1 到 1440' }, 400);
  }
  const account = await env.OJ_DB.prepare('SELECT 1 AS found FROM student_accounts WHERE username = ?1')
    .bind(username).first();
  if (!account) return jsonResponse({ error: '该学生账号不存在，请先注册账号' }, 404);

  let availability;
  if (resourceType === 'exam') {
    const record = await readExamRecord(env, resourceId);
    if (!record || record.status !== 'published' || record.group_name !== group) {
      return jsonResponse({ error: '套卷不存在、未发布或不属于当前组别' }, 404);
    }
    if (!await canStudentAccessExam(env, resourceId, username)) {
      return jsonResponse({ error: '该学生没有这张套卷的准入权限，请先赋予准入权限' }, 403);
    }
    availability = parseExamRecord(record).availability;
  } else {
    const problem = await readHiddenProblem(resourceId, env, group);
    if (!problem || problem.status === 'draft') return jsonResponse({ error: '题目不存在或尚未发布' }, 404);
    availability = problem.availability;
  }
  if (!availability?.enabled) return jsonResponse({ error: '该题目或套卷没有启用定时答题，无需补时' }, 409);

  const startsAt = Date.now();
  const endsAt = startsAt + minutes * 60 * 1000;
  await env.OJ_DB.prepare(`
    INSERT INTO timed_extensions (
      resource_type, group_name, resource_id, username, starts_at, ends_at, created_at
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?5)
    ON CONFLICT(resource_type, group_name, resource_id, username)
    DO UPDATE SET starts_at = excluded.starts_at, ends_at = excluded.ends_at, created_at = excluded.created_at
  `).bind(resourceType, group, resourceId, username, startsAt, endsAt).run();
  return jsonResponse({ success: true, resourceType, resourceId, username, startsAt, endsAt, minutes });
}

async function handleAdminTimedExtensionRevoke(body, env) {
  if (!env.OJ_DB) return jsonResponse({ error: '补时数据库尚未配置' }, 503);
  const group = normalizeGroup(body.group);
  const { resourceType, resourceId, username } = normalizeTimedExtensionTarget(body);
  if (!resourceType || !resourceId || !username) return jsonResponse({ error: '撤销参数不正确' }, 400);
  await env.OJ_DB.prepare(`
    DELETE FROM timed_extensions
    WHERE resource_type = ?1 AND group_name = ?2 AND resource_id = ?3 AND username = ?4
  `).bind(resourceType, group, resourceId, username).run();
  return jsonResponse({ success: true });
}

async function readStudentAccountStates(env, usernames) {
  const states = new Map();
  for (let index = 0; index < usernames.length; index += 100) {
    const chunk = usernames.slice(index, index + 100);
    const placeholders = chunk.map((_, position) => `?${position + 1}`).join(',');
    const result = await env.OJ_DB.prepare(`
      SELECT username, password_hash, is_managed FROM student_accounts
      WHERE username IN (${placeholders})
    `).bind(...chunk).all();
    for (const row of result.results || []) states.set(row.username, row);
  }
  return states;
}

function normalizeRosterUsernames(values) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map(normalizeStudentUsername).filter(Boolean))];
}

async function handleAdminExamRosterAccountStatus(body, env) {
  if (!env.OJ_DB) return jsonResponse({ error: '学生账号数据库尚未配置' }, 503);
  const usernames = normalizeRosterUsernames(body.usernames);
  if (!usernames.length || usernames.length > 2000) return jsonResponse({ error: '名单人数必须在 1 到 2000 之间' }, 400);
  const states = await readStudentAccountStates(env, usernames);
  return jsonResponse({
    passwordUsers: usernames.filter(username => Boolean(states.get(username)?.password_hash)),
  });
}

async function handleAdminExamRosterImport(body, env) {
  if (!env.OJ_DB) return jsonResponse({ error: '学生账号数据库尚未配置' }, 503);
  const examId = normalizeExamId(body.examId);
  const usernames = normalizeRosterUsernames(body.usernames);
  if (!examId || !usernames.length || usernames.length > 2000) return jsonResponse({ error: '试卷编号或名单格式不正确' }, 400);
  const exam = await env.OJ_DB.prepare('SELECT id FROM exam_papers WHERE id = ?1').bind(examId).first();

  const suppliedAccounts = new Map();
  for (const item of Array.isArray(body.accounts) ? body.accounts : []) {
    const username = normalizeStudentUsername(item?.username);
    const salt = String(item?.salt || '');
    const hash = String(item?.hash || '');
    if (!username || !usernames.includes(username) || !/^[A-Za-z0-9_-]{22}$/.test(salt) || !/^[A-Za-z0-9_-]{43}$/.test(hash)) {
      return jsonResponse({ error: '准入账号数据格式不正确' }, 400);
    }
    suppliedAccounts.set(username, { username, salt, hash });
  }
  const states = await readStudentAccountStates(env, usernames);
  const missingPassword = usernames.filter(username => !states.get(username)?.password_hash && !suppliedAccounts.has(username));
  if (missingPassword.length) return jsonResponse({ error: `以下账号缺少初始密码：${missingPassword.slice(0, 5).join('、')}` }, 400);

  const now = Date.now();
  const statements = [];
  for (const username of usernames) {
    const account = suppliedAccounts.get(username);
    if (account && !states.get(username)?.password_hash) {
      statements.push(env.OJ_DB.prepare(`
        INSERT INTO student_accounts (
          username, password_salt, password_hash, password_iterations, auth_version, is_managed, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, 1, 0, ?5, ?5)
        ON CONFLICT(username) DO UPDATE SET
          password_salt = excluded.password_salt,
          password_hash = excluded.password_hash,
          password_iterations = excluded.password_iterations,
          auth_version = student_accounts.auth_version + 1,
          updated_at = excluded.updated_at
        WHERE student_accounts.password_hash IS NULL
      `).bind(username, account.salt, account.hash, STUDENT_PASSWORD_ITERATIONS, now));
      statements.push(env.OJ_DB.prepare('DELETE FROM student_sessions WHERE username = ?1').bind(username));
    }
    if (exam) {
      statements.push(env.OJ_DB.prepare(`
        INSERT OR IGNORE INTO exam_roster (exam_id, username, created_at) VALUES (?1, ?2, ?3)
      `).bind(examId, username, now));
      statements.push(env.OJ_DB.prepare(`
        DELETE FROM exam_access_revocations WHERE exam_id = ?1 AND username = ?2
      `).bind(examId, username));
    }
  }
  for (let index = 0; index < statements.length; index += 100) {
    await env.OJ_DB.batch(statements.slice(index, index + 100));
  }
  return jsonResponse({ success: true, added: usernames.length, rosterPending: !exam });
}

async function handleAdminExamAccessRevoke(body, env) {
  if (!env.OJ_DB) return jsonResponse({ error: '套卷权限数据库尚未配置' }, 503);
  const examId = normalizeExamId(body.examId);
  if (!examId) return jsonResponse({ error: '试卷编号不正确' }, 400);
  const exam = await env.OJ_DB.prepare('SELECT id FROM exam_papers WHERE id = ?1').bind(examId).first();
  if (!exam) return jsonResponse({ error: '试卷不存在，请先保存套卷' }, 404);
  const preserved = await env.OJ_DB.prepare(`
    SELECT COUNT(*) AS count FROM exam_submissions
    WHERE exam_id = ?1 AND is_preview = 0
  `).bind(examId).first();
  const now = Date.now();
  if (body.all === true) {
    await env.OJ_DB.batch([
      env.OJ_DB.prepare(`
        INSERT INTO exam_access_policies (exam_id, managed_default_allowed, updated_at)
        VALUES (?1, 0, ?2)
        ON CONFLICT(exam_id) DO UPDATE SET
          managed_default_allowed = 0,
          updated_at = excluded.updated_at
      `).bind(examId, now),
      env.OJ_DB.prepare('DELETE FROM exam_roster WHERE exam_id = ?1').bind(examId),
      env.OJ_DB.prepare('DELETE FROM exam_access_revocations WHERE exam_id = ?1').bind(examId),
    ]);
    return jsonResponse({ success: true, all: true, preservedSubmissions: Number(preserved?.count || 0) });
  }

  const username = normalizeStudentUsername(body.username);
  if (!username) return jsonResponse({ error: '学生用户名不正确' }, 400);
  const account = await env.OJ_DB.prepare('SELECT 1 AS found FROM student_accounts WHERE username = ?1')
    .bind(username).first();
  if (!account) return jsonResponse({ error: '该学生账号不存在' }, 404);
  await env.OJ_DB.batch([
    env.OJ_DB.prepare('DELETE FROM exam_roster WHERE exam_id = ?1 AND username = ?2').bind(examId, username),
    env.OJ_DB.prepare(`
      INSERT INTO exam_access_revocations (exam_id, username, created_at)
      VALUES (?1, ?2, ?3)
      ON CONFLICT(exam_id, username) DO UPDATE SET created_at = excluded.created_at
    `).bind(examId, username, now),
  ]);
  return jsonResponse({ success: true, username, preservedSubmissions: Number(preserved?.count || 0) });
}

async function deriveStudentPasswordHash(password, salt, iterations) {
  const passwordKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits({
    name: 'PBKDF2',
    hash: 'SHA-256',
    salt: base64UrlToBytes(salt),
    iterations,
  }, passwordKey, 256);
  return bytesToBase64Url(new Uint8Array(bits));
}

function base64UrlToBytes(value) {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
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

const EXAM_PART_TYPES = new Set(['single_choice', 'multiple_choice', 'fill_blank', 'short_answer', 'programming']);
const EXAM_RESULT_POLICIES = new Set(['immediate', 'after_graded', 'manual']);

function validateAvailability(input) {
  const enabled = input?.enabled === true;
  const afterEndView = AFTER_END_VIEW_POLICIES.has(input?.afterEndView) ? input.afterEndView : 'none';
  if (!enabled) return { enabled: false, windows: [], afterEndView };
  if (!Array.isArray(input.windows) || input.windows.length < 1 || input.windows.length > 20) {
    return { error: '启用定时后必须设置 1 到 20 个答题时间段' };
  }
  const windows = input.windows.map(item => ({
    start: Math.trunc(Number(item?.start)),
    end: Math.trunc(Number(item?.end)),
  })).sort((left, right) => left.start - right.start);
  for (let index = 0; index < windows.length; index += 1) {
    const item = windows[index];
    if (!Number.isFinite(item.start) || !Number.isFinite(item.end) || item.start < 0 || item.end <= item.start) {
      return { error: `第 ${index + 1} 个答题时间段不正确` };
    }
    if (item.end - item.start < 60 * 1000) return { error: `第 ${index + 1} 个答题时间段不能短于 1 分钟` };
    if (index > 0 && item.start < windows[index - 1].end + TIMED_GRACE_MS) {
      return { error: `第 ${index + 1} 个答题时间段与前一个时间段或其 60 秒上传期重叠` };
    }
  }
  return { enabled: true, windows, afterEndView };
}

function availabilityState(availability, now = Date.now()) {
  if (!availability?.enabled || !availability.windows?.length) {
    return { state: 'unrestricted', canEdit: true, canSubmit: true, serverTime: now };
  }
  for (const [index, window] of availability.windows.entries()) {
    if (now < window.start) {
      return {
        state: index === 0 ? 'upcoming' : 'paused',
        canEdit: false, canSubmit: false, nextStart: window.start, serverTime: now,
      };
    }
    if (now < window.end) {
      return {
        state: 'active', canEdit: true, canSubmit: true,
        windowStart: window.start, windowEnd: window.end, serverTime: now,
      };
    }
    if (now < window.end + TIMED_GRACE_MS) {
      return {
        state: 'grace', canEdit: false, canSubmit: true,
        windowStart: window.start, windowEnd: window.end,
        graceEndsAt: window.end + TIMED_GRACE_MS, serverTime: now,
      };
    }
  }
  const lastEnd = availability.windows[availability.windows.length - 1].end;
  return { state: 'ended', canEdit: false, canSubmit: false, lastEnd, serverTime: now };
}

function publicAvailability(availability, now = Date.now()) {
  const normalized = availability?.enabled ? availability : { enabled: false, windows: [], afterEndView: 'none' };
  return { ...normalized, status: availabilityState(normalized, now) };
}

function availabilityWithExtension(availability, extension, now = Date.now()) {
  const normalized = availability?.enabled
    ? availability
    : { enabled: false, windows: [], afterEndView: 'none' };
  if (!extension || now >= Number(extension.ends_at) + TIMED_GRACE_MS) return normalized;
  return {
    enabled: true,
    windows: [{ start: Number(extension.starts_at), end: Number(extension.ends_at) }],
    afterEndView: normalized.afterEndView || 'none',
    personalExtension: true,
  };
}

async function studentAvailability(availability, resourceType, group, resourceId, username, env, now = Date.now()) {
  if (!env.OJ_DB || !username) return availability?.enabled ? availability : { enabled: false, windows: [], afterEndView: 'none' };
  const extension = await env.OJ_DB.prepare(`
    SELECT starts_at, ends_at FROM timed_extensions
    WHERE resource_type = ?1 AND group_name = ?2 AND resource_id = ?3 AND username = ?4
  `).bind(resourceType, group, resourceId, username).first();
  return availabilityWithExtension(availability, extension, now);
}

async function studentExtensionMap(env, username, group, now = Date.now()) {
  if (!env.OJ_DB || !username) return new Map();
  const result = await env.OJ_DB.prepare(`
    SELECT resource_type, resource_id, starts_at, ends_at FROM timed_extensions
    WHERE group_name = ?1 AND username = ?2 AND ends_at + ?3 > ?4
  `).bind(group, username, TIMED_GRACE_MS, now).all();
  return new Map((result.results || []).map(row => [`${row.resource_type}:${row.resource_id}`, row]));
}

async function isManagedStudent(env, username) {
  if (!env.OJ_DB || !username) return false;
  const row = await env.OJ_DB.prepare('SELECT is_managed FROM student_accounts WHERE username = ?1')
    .bind(username).first();
  return Number(row?.is_managed) === 1;
}

function timedAccessError(state) {
  if (state.state === 'upcoming') return jsonResponse({ error: '尚未到答题开放时间', code: 'NOT_STARTED', timing: state }, 403);
  if (state.state === 'paused') return jsonResponse({ error: '当前答题时段已暂停，请等待下一时段开始', code: 'ANSWER_PAUSED', timing: state }, 403);
  if (state.state === 'grace') return jsonResponse({ error: '答题时间已结束，答案已经冻结', code: 'ANSWER_FROZEN', timing: state }, 409);
  return jsonResponse({ error: '答题时间已经结束', code: 'ANSWER_CLOSED', timing: state }, 403);
}

function normalizeExamId(value) {
  const id = String(value || '').trim().toUpperCase();
  return /^[A-Z][A-Z0-9_-]{1,31}$/.test(id) ? id : '';
}

function normalizeExamText(value, maxLength) {
  return String(value || '').trim().normalize('NFC').slice(0, maxLength);
}

function validateExamPaper(input) {
  if (!input || typeof input !== 'object') return { error: '缺少试卷内容' };
  const id = normalizeExamId(input.id);
  const title = normalizeExamText(input.title, 120);
  const description = normalizeExamText(input.description, 10000);
  const status = input.status === 'published' ? 'published' : 'draft';
  const resultPolicy = EXAM_RESULT_POLICIES.has(input.resultPolicy) ? input.resultPolicy : 'after_graded';
  const allowedUsers = Array.isArray(input.allowedUsers)
    ? [...new Set(input.allowedUsers.map(normalizeStudentUsername).filter(Boolean))]
    : [];
  const availability = validateAvailability(input.availability);
  if (availability.error) return { error: availability.error };
  const serialNo = Number(input.serialNo || 0);
  if (!id || !title) return { error: '试卷编号或名称不正确' };
  if (allowedUsers.length > 2000) return { error: '单张套卷最多额外准入 2000 个账号' };
  if (!Number.isInteger(serialNo) || serialNo < 0 || serialNo > 99) return { error: '套卷序号必须在 1 到 99 之间' };
  if (!Array.isArray(input.questions) || input.questions.length < 1 || input.questions.length > 100) {
    return { error: '一张试卷必须包含 1 到 100 道大题' };
  }

  const ids = new Set();
  const questions = [];
  let totalParts = 0;
  let totalScore = 0;
  for (const [questionIndex, rawQuestion] of input.questions.entries()) {
    const questionId = normalizeExamText(rawQuestion?.id || `Q${questionIndex + 1}`, 40);
    if (!questionId || ids.has(questionId)) return { error: `第 ${questionIndex + 1} 道大题编号重复或为空` };
    ids.add(questionId);
    const titleText = normalizeExamText(rawQuestion?.title || `第 ${questionIndex + 1} 题`, 160);
    const question = {
      id: questionId,
      title: titleText,
      description: normalizeExamText(rawQuestion?.description, 30000),
      scoringMode: rawQuestion?.scoringMode === 'programming_required' ? 'programming_required' : 'independent',
      parts: [],
    };
    if (!Array.isArray(rawQuestion?.parts) || rawQuestion.parts.length < 1 || rawQuestion.parts.length > 30) {
      return { error: `${titleText} 必须包含 1 到 30 个小题` };
    }
    let hasProgramming = false;
    for (const [partIndex, rawPart] of rawQuestion.parts.entries()) {
      totalParts += 1;
      if (totalParts > 200) return { error: '一张试卷最多包含 200 个小题' };
      const partId = normalizeExamText(rawPart?.id || `${questionId}_${partIndex + 1}`, 50);
      const type = String(rawPart?.type || 'short_answer');
      const points = Number(rawPart?.points);
      if (!partId || ids.has(partId)) return { error: `${titleText} 的小题编号重复或为空` };
      if (!EXAM_PART_TYPES.has(type)) return { error: `${titleText} 包含不支持的题型` };
      if (!Number.isFinite(points) || points < 0 || points > 1000) return { error: `${titleText} 的小题分数不正确` };
      ids.add(partId);
      const part = {
        id: partId,
        type,
        prompt: normalizeExamText(rawPart?.prompt, 30000),
        points: Math.round(points * 100) / 100,
      };
      if (type === 'fill_blank' || type === 'short_answer') {
        part.gradingGuide = normalizeExamText(rawPart?.gradingGuide, 12000);
      }
      if (type === 'single_choice' || type === 'multiple_choice') {
        part.options = Array.isArray(rawPart.options)
          ? rawPart.options.map(option => normalizeExamText(option, 1000)).filter(Boolean).slice(0, 20)
          : [];
        part.correctAnswers = Array.isArray(rawPart.correctAnswers)
          ? [...new Set(rawPart.correctAnswers.map(answer => normalizeExamText(answer, 1000)).filter(answer => part.options.includes(answer)))]
          : [];
        if (part.options.length < 2 || part.correctAnswers.length < 1) return { error: `${titleText} 的选择题选项或答案不完整` };
        if (type === 'single_choice' && part.correctAnswers.length !== 1) return { error: `${titleText} 的单选题只能设置一个答案` };
      } else if (type === 'fill_blank') {
        part.correctAnswers = Array.isArray(rawPart.correctAnswers)
          ? [...new Set(rawPart.correctAnswers.map(answer => normalizeExamText(answer, 2000)).filter(Boolean))].slice(0, 50)
          : [];
        part.caseSensitive = rawPart.caseSensitive === true;
        if (!part.correctAnswers.length) return { error: `${titleText} 的填空题至少需要一个预设答案` };
      } else if (type === 'programming') {
        hasProgramming = true;
        part.problemId = String(rawPart.problemId || '').trim().toUpperCase();
        if (!/^(?:P\d{3,6}|T\d{3})$/.test(part.problemId)) return { error: `${titleText} 的编程小题必须关联有效题号` };
      }
      totalScore += part.points;
      question.parts.push(part);
    }
    if (question.scoringMode === 'programming_required' && !hasProgramming) {
      return { error: `${titleText} 使用“编程正确才得分”模式，但没有编程小题` };
    }
    questions.push(question);
  }
  if (totalScore > 10000) return { error: '试卷总分不能超过 10000 分' };
  return {
    paper: { id, title, description, status, resultPolicy, serialNo, allowedUsers, availability, questions },
    totalScore: Math.round(totalScore * 100) / 100,
    totalParts,
  };
}

function publicExamPaper(paper) {
  return {
    ...paper,
    questions: paper.questions.map(question => ({
      ...question,
      parts: question.parts.map(part => {
        const publicPart = { ...part };
        delete publicPart.correctAnswers;
        delete publicPart.caseSensitive;
        delete publicPart.gradingGuide;
        return publicPart;
      }),
    })),
  };
}

async function readExamRecord(env, examId) {
  if (!env.OJ_DB) return null;
  return await env.OJ_DB.prepare(`
    SELECT p.*, v.structure_json
    FROM exam_papers p
    JOIN exam_versions v ON v.exam_id = p.id AND v.version = p.version
    WHERE p.id = ?1
  `).bind(examId).first();
}

function parseExamRecord(record) {
  if (!record) return null;
  const structure = JSON.parse(record.structure_json);
  return {
    ...structure,
    id: record.id,
    title: record.title,
    description: record.description,
    status: record.status,
    resultPolicy: record.result_policy,
    version: Number(record.version),
    totalScore: Number(record.total_score),
    updatedAt: Number(record.updated_at),
    serialNo: Number(structure.serialNo || record.serial_no || 0),
    availability: structure.availability || { enabled: false, windows: [], afterEndView: 'none' },
  };
}

async function nextExamSerial(env, group) {
  const result = await env.OJ_DB.prepare(`
    SELECT MAX(CAST(json_extract(v.structure_json, '$.serialNo') AS INTEGER)) AS max_serial,
           COUNT(*) AS paper_count
    FROM exam_papers p
    JOIN exam_versions v ON v.exam_id = p.id AND v.version = p.version
    WHERE p.group_name = ?1
  `).bind(group).first();
  const next = Math.max(Number(result?.max_serial || 0), Number(result?.paper_count || 0)) + 1;
  if (next > 99) throw new Error('套卷序号已经用完（最多 99 套）');
  return next;
}

async function ensureExamSerial(paper, env, group, existing = null) {
  if (paper.serialNo > 0) return paper.serialNo;
  if (existing) {
    const parsed = parseExamRecord(existing);
    if (parsed.serialNo > 0) return parsed.serialNo;
    const rank = await env.OJ_DB.prepare(`
      SELECT COUNT(*) AS position FROM exam_papers
      WHERE group_name = ?1 AND (created_at < ?2 OR (created_at = ?2 AND id <= ?3))
    `).bind(group, Number(existing.created_at), existing.id).first();
    return Math.max(1, Math.min(Number(rank?.position || 1), 99));
  }
  return await nextExamSerial(env, group);
}

async function enrichExamProgrammingParts(paper, env, group) {
  const programmingParts = paper.questions.flatMap(question => question.parts)
    .filter(part => part.type === 'programming');
  const problemIds = [...new Set(programmingParts.map(part => part.problemId))];
  const referencedProblems = new Map(await Promise.all(problemIds.map(async problemId => [
    problemId,
    await readHiddenProblem(problemId, env, group),
  ])));
  for (const part of programmingParts) {
    const problem = referencedProblems.get(part.problemId);
    if (problem) {
      const publicProblem = { ...problem };
      delete publicProblem.testCases;
      delete publicProblem.showTestDetails;
      part.problem = publicProblem;
    }
    if (problem?.pythonJudgeMode === 'function' && problem.pythonFunction) {
      part.pythonJudgeMode = 'function';
      part.pythonFunction = problem.pythonFunction;
    }
  }
  return paper;
}

async function handleAdminExamList(body, env) {
  if (!env.OJ_DB) return jsonResponse({ error: '试卷数据库尚未配置' }, 503);
  const group = normalizeGroup(body.group);
  const result = await env.OJ_DB.prepare(`
    SELECT p.id, p.title, p.description, p.status, p.result_policy, p.total_score,
           p.version, p.updated_at,
           COALESCE(
             NULLIF(CAST(json_extract(v.structure_json, '$.serialNo') AS INTEGER), 0),
             (SELECT COUNT(*) FROM exam_papers p2
              WHERE p2.group_name = p.group_name
                AND (p2.created_at < p.created_at OR (p2.created_at = p.created_at AND p2.id <= p.id)))
           ) AS serial_no,
           (SELECT COUNT(*) FROM analytics_exam_visitors av
            WHERE av.group_name = p.group_name AND av.exam_id = p.id) AS view_students,
           COUNT(CASE WHEN s.is_final = 1 AND s.is_preview = 0 THEN 1 END) AS submitted_students,
           SUM(CASE WHEN s.is_final = 1 AND s.is_preview = 0 AND s.grading_status = 'completed' THEN 1 ELSE 0 END) AS completed_students
    FROM exam_papers p
    JOIN exam_versions v ON v.exam_id = p.id AND v.version = p.version
    LEFT JOIN exam_submissions s ON s.exam_id = p.id
    WHERE p.group_name = ?1
    GROUP BY p.id
    ORDER BY p.updated_at DESC
  `).bind(group).all();
  const [visitorResult, submitterResult] = await env.OJ_DB.batch([
    env.OJ_DB.prepare(`
      SELECT exam_id, visitor_hash
      FROM analytics_exam_visitors
      WHERE group_name = ?1
    `).bind(group),
    env.OJ_DB.prepare(`
      SELECT DISTINCT s.exam_id, s.username
      FROM exam_submissions s
      JOIN exam_papers p ON p.id = s.exam_id
      WHERE p.group_name = ?1 AND s.is_preview = 0
    `).bind(group),
  ]);
  const viewerSets = new Map();
  for (const row of visitorResult.results || []) {
    if (!viewerSets.has(row.exam_id)) viewerSets.set(row.exam_id, new Set());
    viewerSets.get(row.exam_id).add(row.visitor_hash);
  }
  const submitterRows = submitterResult.results || [];
  const uniqueUsernames = [...new Set(submitterRows
    .map(row => normalizeStudentUsername(row.username))
    .filter(Boolean))];
  const submitterHashes = new Map(await Promise.all(uniqueUsernames.map(async username => [
    username,
    await analyticsVisitorHash(username, env),
  ])));
  for (const row of submitterRows) {
    const username = normalizeStudentUsername(row.username);
    if (!username) continue;
    if (!viewerSets.has(row.exam_id)) viewerSets.set(row.exam_id, new Set());
    viewerSets.get(row.exam_id).add(submitterHashes.get(username));
  }
  return jsonResponse((result.results || []).map(row => ({
    ...row,
    view_students: viewerSets.get(row.id)?.size || 0,
  })));
}

async function handleAdminExamGet(body, env) {
  const examId = normalizeExamId(body.examId);
  if (!examId) return jsonResponse({ error: '试卷编号不正确' }, 400);
  const record = await readExamRecord(env, examId);
  if (!record) return jsonResponse({ error: '试卷不存在' }, 404);
  const paper = parseExamRecord(record);
  const roster = await env.OJ_DB.prepare('SELECT username FROM exam_roster WHERE exam_id = ?1 ORDER BY username')
    .bind(examId).all();
  paper.allowedUsers = (roster.results || []).map(row => row.username);
  const accessPolicy = await env.OJ_DB.prepare(`
    SELECT managed_default_allowed FROM exam_access_policies WHERE exam_id = ?1
  `).bind(examId).first();
  paper.managedDefaultAllowed = Number(accessPolicy?.managed_default_allowed ?? 1) === 1;
  paper.serialNo = await ensureExamSerial(paper, env, record.group_name, record);
  return jsonResponse(await enrichExamProgrammingParts(paper, env, record.group_name));
}

async function handleAdminExamSave(body, env) {
  if (!env.OJ_DB) return jsonResponse({ error: '试卷数据库尚未配置' }, 503);
  const validated = validateExamPaper(body.paper);
  if (validated.error) return jsonResponse({ error: validated.error }, 400);
  const group = normalizeGroup(body.group);
  const { paper, totalScore } = validated;
  if (paper.status === 'published') {
    const programmingIds = [...new Set(paper.questions.flatMap(question => question.parts)
      .filter(part => part.type === 'programming')
      .map(part => part.problemId))];
    if (programmingIds.length) {
      if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) return jsonResponse({ error: 'GitHub 题库尚未配置' }, 503);
      const indexResponse = await fetch(
        `https://api.github.com/repos/${env.GITHUB_REPO}/contents/${problemIndexPath(group)}`,
        { headers: { ...githubHeaders(env.GITHUB_TOKEN), 'Accept': 'application/vnd.github.raw' } },
      );
      if (!indexResponse.ok) return githubErrorResponse(indexResponse, '检查试卷关联编程题失败');
      let problemIndex;
      try { problemIndex = JSON.parse(await indexResponse.text()); } catch { return jsonResponse({ error: '题目索引格式不正确' }, 500); }
      const unavailable = programmingIds.filter(problemId => {
        const item = Array.isArray(problemIndex) ? problemIndex.find(problem => problem.id === problemId) : null;
        return !item;
      });
      if (unavailable.length) {
        return jsonResponse({ error: `试卷关联的编程题不存在：${unavailable.join('、')}` }, 409);
      }
    }
  }
  const existing = await readExamRecord(env, paper.id);
  if (existing && existing.group_name !== group) return jsonResponse({ error: '该试卷编号已被其他组别使用' }, 409);
  paper.serialNo = await ensureExamSerial(paper, env, group, existing);

  const structure = JSON.stringify({
    serialNo: paper.serialNo,
    availability: paper.availability,
    questions: paper.questions,
  });
  const structureChanged = !existing || existing.structure_json !== structure;
  const version = existing ? Number(existing.version) + (structureChanged ? 1 : 0) : 1;
  const now = Date.now();
  const statements = [];
  if (structureChanged) {
    statements.push(env.OJ_DB.prepare(`
      INSERT INTO exam_versions (exam_id, version, structure_json, created_at)
      VALUES (?1, ?2, ?3, ?4)
    `).bind(paper.id, version, structure, now));
  }
  statements.push(env.OJ_DB.prepare(`
    INSERT INTO exam_papers (
      id, group_name, title, description, status, result_policy,
      total_score, version, created_at, updated_at
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      description = excluded.description,
      status = excluded.status,
      result_policy = excluded.result_policy,
      total_score = excluded.total_score,
      version = excluded.version,
      updated_at = excluded.updated_at
  `).bind(
    paper.id, group, paper.title, paper.description, paper.status,
    paper.resultPolicy, totalScore, version, existing ? Number(existing.created_at) : now,
  ));
  if (structureChanged) {
    statements.push(env.OJ_DB.prepare(`
      DELETE FROM exam_versions
      WHERE exam_id = ?1 AND version <> ?2
        AND NOT EXISTS (
          SELECT 1 FROM exam_submissions s
          WHERE s.exam_id = exam_versions.exam_id AND s.exam_version = exam_versions.version
        )
    `).bind(paper.id, version));
    statements.push(env.OJ_DB.prepare(`
      DELETE FROM timed_drafts
      WHERE resource_type = 'exam' AND resource_id = ?1
        AND status IN ('active', 'queued', 'failed')
    `).bind(paper.id));
  }
  statements.push(env.OJ_DB.prepare('DELETE FROM exam_roster WHERE exam_id = ?1').bind(paper.id));
  for (const username of paper.allowedUsers) {
    statements.push(env.OJ_DB.prepare(`
      INSERT INTO exam_roster (exam_id, username, created_at) VALUES (?1, ?2, ?3)
    `).bind(paper.id, username, now));
    statements.push(env.OJ_DB.prepare(`
      DELETE FROM exam_access_revocations WHERE exam_id = ?1 AND username = ?2
    `).bind(paper.id, username));
  }
  for (let index = 0; index < statements.length; index += 100) {
    await env.OJ_DB.batch(statements.slice(index, index + 100));
  }
  return jsonResponse({ success: true, id: paper.id, version, totalScore, serialNo: paper.serialNo });
}

async function canStudentAccessExam(env, examId, username) {
  if (!examId || !username) return false;
  const allowed = await env.OJ_DB.prepare(`
    SELECT 1 AS allowed
    WHERE NOT EXISTS (
      SELECT 1 FROM exam_access_revocations x
      WHERE x.exam_id = ?2 AND x.username = ?1
    ) AND (
      (
        COALESCE((
          SELECT managed_default_allowed FROM exam_access_policies WHERE exam_id = ?2
        ), 1) = 1
        AND EXISTS (
          SELECT 1 FROM student_accounts WHERE username = ?1 AND is_managed = 1
        )
      ) OR EXISTS (
      SELECT 1 FROM exam_roster r
      JOIN student_accounts a ON a.username = r.username
      WHERE r.exam_id = ?2 AND r.username = ?1 AND a.password_hash IS NOT NULL
      )
    )
  `).bind(username, examId).first();
  return Boolean(allowed);
}

async function validateExamModeExecution(body, env) {
  const examId = normalizeExamId(body.examId);
  const problemId = String(body.problemId || '').trim().toUpperCase();
  const username = normalizeStudentUsername(body.username);
  if (!examId || !/^(?:P\d{3,6}|T\d{3})$/.test(problemId) || !username) return examModeOnlyResponse();
  const record = await readExamRecord(env, examId);
  if (!record || record.status !== 'published' || !await canStudentAccessExam(env, examId, username)) {
    return jsonResponse({ error: '你没有该套卷的准入权限', code: 'EXAM_ACCESS_DENIED' }, 403);
  }
  const paper = parseExamRecord(record);
  const linked = paper.questions.some(question => question.parts.some(part => (
    part.type === 'programming' && part.problemId === problemId
  )));
  if (!linked) return examModeOnlyResponse();
  const effectiveAvailability = await studentAvailability(
    paper.availability, 'exam', record.group_name, examId, username, env,
  );
  const timing = availabilityState(effectiveAvailability);
  if (timing.state !== 'unrestricted' && timing.state !== 'active') return timedAccessError(timing);
  return null;
}

async function handleStudentExamList(body, env) {
  if (!env.OJ_DB) return jsonResponse({ error: '试卷数据库尚未配置' }, 503);
  const username = normalizeStudentUsername(body.username);
  const group = normalizeGroup(body.group);
  const now = Date.now();
  const extensions = await studentExtensionMap(env, username, group, now);
  const result = await env.OJ_DB.prepare(`
    SELECT p.id, p.title, p.description, p.total_score, p.result_policy, p.updated_at,
           v.structure_json,
           s.id AS submission_id, s.grading_status, s.total_score AS achieved_score,
           s.graded_count, s.total_parts, s.released, s.submitted_at,
           CASE WHEN
             NOT EXISTS (
               SELECT 1 FROM exam_access_revocations x
               WHERE x.exam_id = p.id AND x.username = ?1
             ) AND (
               (
                 COALESCE((SELECT managed_default_allowed FROM exam_access_policies ap WHERE ap.exam_id = p.id), 1) = 1
                 AND EXISTS (SELECT 1 FROM student_accounts a WHERE a.username = ?1 AND a.is_managed = 1)
               ) OR EXISTS (
                 SELECT 1 FROM exam_roster r
                 JOIN student_accounts a ON a.username = r.username
                 WHERE r.exam_id = p.id AND r.username = ?1 AND a.password_hash IS NOT NULL
               )
             )
           THEN 1 ELSE 0 END AS access_allowed
    FROM exam_papers p
    JOIN exam_versions v ON v.exam_id = p.id AND v.version = p.version
    LEFT JOIN exam_submissions s
      ON s.exam_id = p.id AND s.username = ?1 AND s.is_preview = 0 AND s.is_final = 1
    WHERE p.group_name = ?2 AND p.status = 'published'
    ORDER BY p.updated_at DESC
  `).bind(username, group).all();
  return jsonResponse((result.results || []).map(row => {
    let availability = { enabled: false, windows: [], afterEndView: 'none' };
    try { availability = JSON.parse(row.structure_json)?.availability || availability; } catch { /* 使用无限制默认值 */ }
    const effectiveAvailability = availabilityWithExtension(availability, extensions.get(`exam:${row.id}`), now);
    const timing = publicAvailability(effectiveAvailability, now).status;
    const answerAccess = Number(row.access_allowed) === 1;
    const viewAccess = timing.state !== 'ended'
      ? answerAccess
      : availability.afterEndView === 'all' || (availability.afterEndView === 'authorized' && answerAccess);
    return {
    id: row.id,
    title: row.title,
    description: row.description,
    totalScore: Number(row.total_score),
    accessAllowed: viewAccess,
    answerAllowed: answerAccess,
    timing,
    submittedAt: row.submitted_at ? Number(row.submitted_at) : null,
    gradingStatus: row.grading_status || null,
    gradedCount: Number(row.graded_count || 0),
    totalParts: Number(row.total_parts || 0),
    resultVisible: isExamResultVisible(row.result_policy, row.grading_status, Number(row.released)),
    achievedScore: isExamResultVisible(row.result_policy, row.grading_status, Number(row.released))
      ? Number(row.achieved_score) : null,
    };
  }));
}

function isExamResultVisible(policy, gradingStatus, released) {
  return policy === 'immediate'
    || (policy === 'after_graded' && gradingStatus === 'completed')
    || (policy === 'manual' && released === 1);
}

function examCompletionMessageStatement(env, {
  examId, username, title, group, resultPolicy, gradingStatus, createdAt, submissionId = null,
}) {
  if (resultPolicy !== 'after_graded' || gradingStatus !== 'completed'
      || !examId || !username || username === 'admin') return null;
  const messageKey = `exam-graded:${examId}:${username}`;
  return env.OJ_DB.prepare(`
    INSERT OR IGNORE INTO system_messages (
      audience, username, title, content, created_at,
      message_type, group_name, problem_id, resubmission_key, popup_enabled
    )
    SELECT 'user', ?1, '套卷已批改完成', ?2, ?3, 'exam_graded', ?4, NULL, ?5, 0
    WHERE ?6 IS NULL OR EXISTS (
      SELECT 1 FROM exam_submissions
      WHERE id = ?6 AND is_final = 1 AND is_preview = 0 AND grading_status = 'completed'
    )
  `).bind(
    username,
    `你提交的套卷《${title || examId}》已完成批改，请前往套卷页面查看批改结果。`,
    createdAt || Date.now(), group || null, messageKey,
    Number.isInteger(Number(submissionId)) && Number(submissionId) > 0 ? Number(submissionId) : null,
  );
}

async function handleStudentExamGet(body, env) {
  const examId = normalizeExamId(body.examId);
  const username = normalizeStudentUsername(body.username);
  if (!examId) return jsonResponse({ error: '试卷编号不正确' }, 400);
  const record = await readExamRecord(env, examId);
  if (!record || record.status !== 'published') return jsonResponse({ error: '试卷不存在或尚未发布' }, 404);
  const paper = parseExamRecord(record);
  const effectiveAvailability = await studentAvailability(
    paper.availability, 'exam', record.group_name, examId, username, env,
  );
  const timing = availabilityState(effectiveAvailability);
  const answerAccess = await canStudentAccessExam(env, examId, username);
  const postViewAllowed = timing.state === 'ended'
    && (paper.availability.afterEndView === 'all'
      || (paper.availability.afterEndView === 'authorized' && answerAccess));
  if (!answerAccess && !postViewAllowed) return jsonResponse({ error: '你不在这张套卷的准入范围内' }, 403);
  if (timing.state === 'ended' && !postViewAllowed) {
    return jsonResponse({ error: '这张套卷已经结束且未开放观看', code: 'VIEW_CLOSED', timing }, 403);
  }
  await enrichExamProgrammingParts(paper, env, record.group_name);
  const submission = await env.OJ_DB.prepare(`
    SELECT * FROM exam_submissions
    WHERE exam_id = ?1 AND username = ?2 AND is_preview = 0 AND is_final = 1
  `).bind(examId, username).first();
  let mySubmission = null;
  if (submission) {
    const visible = isExamResultVisible(record.result_policy, submission.grading_status, Number(submission.released));
    mySubmission = {
      id: Number(submission.id),
      answers: JSON.parse(submission.answers_json),
      submittedAt: Number(submission.submitted_at),
      gradingStatus: submission.grading_status,
      gradedCount: Number(submission.graded_count),
      totalParts: Number(submission.total_parts),
      resultVisible: visible,
      ...(visible ? {
        totalScore: Number(submission.total_score),
        grading: JSON.parse(submission.grading_json),
      } : {}),
    };
  }
  let timedDraft = null;
  if (timing.windowStart) {
    const draft = await env.OJ_DB.prepare(`
      SELECT payload_json, status, updated_at FROM timed_drafts
      WHERE resource_type = 'exam' AND group_name = ?1 AND resource_id = ?2
        AND resource_version = ?3 AND username = ?4 AND window_start = ?5
    `).bind(record.group_name, examId, paper.version, username, timing.windowStart).first();
    if (draft) timedDraft = {
      answers: JSON.parse(draft.payload_json), status: draft.status, updatedAt: Number(draft.updated_at),
    };
  }
  return jsonResponse({
    paper: { ...publicExamPaper(paper), availability: publicAvailability(effectiveAvailability) },
    mySubmission, timedDraft, timing, answerAllowed: answerAccess,
  });
}

async function handleAdminExamPreviewGet(body, env) {
  if (!env.OJ_DB) return jsonResponse({ error: '试卷数据库尚未配置' }, 503);
  const examId = normalizeExamId(body.examId);
  if (!examId) return jsonResponse({ error: '试卷编号不正确' }, 400);
  const record = await readExamRecord(env, examId);
  if (!record) return jsonResponse({ error: '试卷不存在' }, 404);
  const paper = parseExamRecord(record);
  await enrichExamProgrammingParts(paper, env, record.group_name);
  const submission = await env.OJ_DB.prepare(`
    SELECT * FROM exam_submissions
    WHERE exam_id = ?1 AND username = 'admin' AND is_preview = 1 AND is_final = 1
  `).bind(examId).first();
  let mySubmission = null;
  if (submission) {
    const visible = isExamResultVisible(record.result_policy, submission.grading_status, Number(submission.released));
    mySubmission = {
      id: Number(submission.id),
      answers: JSON.parse(submission.answers_json),
      submittedAt: Number(submission.submitted_at),
      gradingStatus: submission.grading_status,
      gradedCount: Number(submission.graded_count),
      totalParts: Number(submission.total_parts),
      resultVisible: visible,
      ...(visible ? {
        totalScore: Number(submission.total_score),
        grading: JSON.parse(submission.grading_json),
      } : {}),
    };
  }
  return jsonResponse({ paper: publicExamPaper(paper), mySubmission, preview: true });
}

function normalizedAnswer(value, caseSensitive = false) {
  const normalized = String(value ?? '').trim().normalize('NFC').replace(/\r\n/g, '\n');
  return caseSensitive ? normalized : normalized.toLocaleLowerCase('zh-CN');
}

function sameChoiceAnswers(actual, expected) {
  const left = [...new Set((Array.isArray(actual) ? actual : [actual]).map(value => String(value)))].sort();
  const right = [...new Set(expected.map(value => String(value)))].sort();
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function calculateExamScores(paper, partResults) {
  const resultMap = new Map(partResults.map(result => [result.partId, result]));
  let autoScore = 0;
  let manualScore = 0;
  let totalScore = 0;
  let gradedCount = 0;
  let totalParts = 0;
  for (const question of paper.questions) {
    const results = question.parts.map(part => resultMap.get(part.id));
    const programmingPassed = question.scoringMode !== 'programming_required'
      || question.parts.filter(part => part.type === 'programming').every(part => resultMap.get(part.id)?.status === 'correct');
    for (const result of results) {
      totalParts += 1;
      if (result.status !== 'pending') gradedCount += 1;
      const effectiveAuto = programmingPassed ? Number(result.autoScore || 0) : 0;
      const effectiveManual = programmingPassed ? Number(result.manualScore || 0) : 0;
      autoScore += effectiveAuto;
      manualScore += effectiveManual;
      totalScore += effectiveAuto + effectiveManual;
      result.effectiveScore = Math.round((effectiveAuto + effectiveManual) * 100) / 100;
      result.blockedByProgramming = !programmingPassed;
    }
  }
  return {
    autoScore: Math.round(autoScore * 100) / 100,
    manualScore: Math.round(manualScore * 100) / 100,
    totalScore: Math.round(totalScore * 100) / 100,
    gradedCount,
    totalParts,
    gradingStatus: gradedCount === totalParts ? 'completed' : 'pending',
  };
}

async function gradeExamAnswers(paper, answers, username, group, env) {
  const partResults = [];
  for (const question of paper.questions) {
    for (const part of question.parts) {
      const answer = answers[part.id];
      const result = {
        questionId: question.id,
        partId: part.id,
        type: part.type,
        maxScore: part.points,
        status: 'pending',
        autoScore: 0,
        manualScore: 0,
        feedback: '',
      };
      if (part.type === 'single_choice' || part.type === 'multiple_choice') {
        const correct = sameChoiceAnswers(answer, part.correctAnswers);
        result.status = correct ? 'correct' : 'incorrect';
        result.autoScore = correct ? part.points : 0;
      } else if (part.type === 'fill_blank') {
        const actual = normalizedAnswer(answer, part.caseSensitive);
        const correct = actual && part.correctAnswers.some(expected => normalizedAnswer(expected, part.caseSensitive) === actual);
        if (correct) {
          result.status = 'correct';
          result.autoScore = part.points;
        }
      } else if (part.type === 'programming') {
        const language = String(answer?.language || 'c');
        const code = String(answer?.code || '');
        if (code.trim()) {
          try {
            const judged = await runJudgeSubmission({
              username,
              problemId: part.problemId,
              group,
              language,
              code,
            }, env, null, false, true);
            result.status = judged.passed ? 'correct' : 'incorrect';
            result.autoScore = judged.passed ? part.points : 0;
            result.judge = {
              passed: judged.passed,
              passedTests: judged.passedTests,
              totalTests: judged.totalTests,
              totalTime: judged.totalTime,
            };
          } catch (error) {
            result.feedback = `自动判题暂时失败：${String(error.message || error).slice(0, 300)}`;
          }
        } else {
          result.status = 'incorrect';
        }
      }
      partResults.push(result);
    }
  }
  return partResults;
}

async function timedResource(body, env) {
  const resourceType = body.resourceType === 'exam' ? 'exam' : body.resourceType === 'problem' ? 'problem' : '';
  const group = normalizeGroup(body.group);
  const username = normalizeStudentUsername(body.username);
  if (!resourceType || !username) return { error: jsonResponse({ error: '定时草稿参数不正确' }, 400) };
  if (resourceType === 'exam') {
    const resourceId = normalizeExamId(body.resourceId);
    const record = resourceId ? await readExamRecord(env, resourceId) : null;
    if (!record || record.status !== 'published' || record.group_name !== group) {
      return { error: jsonResponse({ error: '套卷不存在或尚未发布' }, 404) };
    }
    if (!await canStudentAccessExam(env, resourceId, username)) {
      return { error: jsonResponse({ error: '你不在这张套卷的准入范围内' }, 403) };
    }
    const paper = parseExamRecord(record);
    const availability = await studentAvailability(paper.availability, resourceType, group, resourceId, username, env);
    return { resourceType, resourceId, version: paper.version, group, username, availability, paper };
  }
  const resourceId = String(body.resourceId || '').trim().toUpperCase();
  const problem = await readHiddenProblem(resourceId, env, group);
  if (!problem || problem.status === 'draft') return { error: jsonResponse({ error: '题目不存在或尚未发布' }, 404) };
  const availability = await studentAvailability(problem.availability, resourceType, group, resourceId, username, env);
  return { resourceType, resourceId, version: 1, group, username, availability, problem };
}

async function handleTimedDraftSave(body, env) {
  if (!env.OJ_DB) return jsonResponse({ error: '定时草稿数据库尚未配置' }, 503);
  const resource = await timedResource(body, env);
  if (resource.error) return resource.error;
  const timing = availabilityState(resource.availability);
  // 截止后的宽限期只用于接收客户端已经锁定的最后草稿。
  if (timing.state !== 'active' && timing.state !== 'grace') return timedAccessError(timing);
  let payload;
  if (resource.resourceType === 'exam') {
    payload = body.payload && typeof body.payload === 'object' && !Array.isArray(body.payload) ? body.payload : null;
  } else {
    const language = String(body.payload?.language || '');
    const code = typeof body.payload?.code === 'string' ? body.payload.code : '';
    payload = SUBMISSION_LANGUAGE_IDS[language] && code.length <= 200000 ? { language, code } : null;
  }
  if (!payload) return jsonResponse({ error: '草稿内容格式不正确' }, 400);
  const payloadJson = JSON.stringify(payload);
  if (payloadJson.length > 600000) return jsonResponse({ error: '草稿不能超过 600 KB' }, 413);
  const now = Date.now();
  await env.OJ_DB.prepare(`
    INSERT INTO timed_drafts (
      resource_type, group_name, resource_id, resource_version, username,
      window_start, window_end, payload_json, status, updated_at, last_error
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'active', ?9, '')
    ON CONFLICT(resource_type, group_name, resource_id, resource_version, username, window_start)
    DO UPDATE SET payload_json = excluded.payload_json, window_end = excluded.window_end,
      updated_at = excluded.updated_at, last_error = ''
    WHERE timed_drafts.status = 'active'
  `).bind(
    resource.resourceType, resource.group, resource.resourceId, resource.version, resource.username,
    timing.windowStart, timing.windowEnd, payloadJson, now,
  ).run();
  return jsonResponse({ success: true, updatedAt: now, timing });
}

async function handleTimeSync(body, env) {
  const now = Date.now();
  if (!body.resourceType || !body.resourceId) return jsonResponse({ serverTime: now });
  const resource = await timedResource(body, env);
  if (resource.error) return resource.error;
  return jsonResponse({
    serverTime: now,
    availability: publicAvailability(resource.availability, now),
  });
}

async function handleTimedFinalize(body, env) {
  if (!env.OJ_DB) return jsonResponse({ error: '定时草稿数据库尚未配置' }, 503);
  const resource = await timedResource(body, env);
  if (resource.error) return resource.error;
  const timing = availabilityState(resource.availability);
  if (timing.state !== 'grace' && timing.state !== 'ended') {
    return jsonResponse({ error: '当前不在冻结提交阶段', code: 'NOT_IN_GRACE', timing }, 409);
  }
  const endedWindow = [...(resource.availability.windows || [])].reverse().find(item => Date.now() >= item.end);
  if (!endedWindow) return jsonResponse({ error: '找不到已结束的答题时间段' }, 409);
  const now = Date.now();
  const result = await env.OJ_DB.prepare(`
    UPDATE timed_drafts SET status = 'queued', queued_at = COALESCE(queued_at, ?7), last_error = ''
    WHERE resource_type = ?1 AND group_name = ?2 AND resource_id = ?3
      AND resource_version = ?4 AND username = ?5 AND window_start = ?6
      AND status IN ('active', 'failed')
  `).bind(
    resource.resourceType, resource.group, resource.resourceId, resource.version,
    resource.username, endedWindow.start, now,
  ).run();
  const draft = await env.OJ_DB.prepare(`
    SELECT status FROM timed_drafts WHERE resource_type = ?1 AND group_name = ?2
      AND resource_id = ?3 AND resource_version = ?4 AND username = ?5 AND window_start = ?6
  `).bind(
    resource.resourceType, resource.group, resource.resourceId, resource.version,
    resource.username, endedWindow.start,
  ).first();
  if (!draft) return jsonResponse({ error: '服务器还没有收到可提交的草稿，请联系管理员', code: 'NO_SERVER_DRAFT' }, 409);
  return jsonResponse({ success: true, queued: draft.status !== 'submitted', status: draft.status, acceptedAt: now });
}

async function handleAdminExamPreviewGrade(body, env) {
  if (!env.OJ_DB) return jsonResponse({ error: '试卷数据库尚未配置' }, 503);
  const examId = normalizeExamId(body.examId);
  const answers = body.answers && typeof body.answers === 'object' && !Array.isArray(body.answers) ? body.answers : null;
  if (!examId || !answers) return jsonResponse({ error: '预览答案格式不正确' }, 400);
  const answersJson = JSON.stringify(answers);
  if (answersJson.length > 600000) return jsonResponse({ error: '整张试卷答案不能超过 600 KB' }, 413);
  const record = await readExamRecord(env, examId);
  if (!record) return jsonResponse({ error: '试卷不存在' }, 404);
  const paper = parseExamRecord(record);
  const validPartIds = new Set(paper.questions.flatMap(question => question.parts.map(part => part.id)));
  for (const key of Object.keys(answers)) {
    if (!validPartIds.has(key)) delete answers[key];
  }
  const partResults = await gradeExamAnswers(paper, answers, '管理员预览', record.group_name, env);
  const scores = calculateExamScores(paper, partResults);
  return jsonResponse({
    preview: true,
    totalScore: scores.totalScore,
    gradedCount: scores.gradedCount,
    totalParts: scores.totalParts,
    gradingStatus: scores.gradingStatus,
    grading: { partResults },
  });
}

async function handleAdminExamPreviewSubmit(body, env) {
  if (!env.OJ_DB) return jsonResponse({ error: '试卷数据库尚未配置' }, 503);
  const examId = normalizeExamId(body.examId);
  const answers = body.answers && typeof body.answers === 'object' && !Array.isArray(body.answers) ? body.answers : null;
  if (!examId || !answers) return jsonResponse({ error: '试卷提交内容不正确' }, 400);
  const answersJson = JSON.stringify(answers);
  if (answersJson.length > 600000) return jsonResponse({ error: '整张试卷答案不能超过 600 KB' }, 413);
  const record = await readExamRecord(env, examId);
  if (!record) return jsonResponse({ error: '试卷不存在' }, 404);
  const group = record.group_name;
  if (body.group && normalizeGroup(body.group) !== group) return jsonResponse({ error: '试卷组别不正确' }, 400);
  const paper = parseExamRecord(record);
  const validPartIds = new Set(paper.questions.flatMap(question => question.parts.map(part => part.id)));
  for (const key of Object.keys(answers)) {
    if (!validPartIds.has(key)) delete answers[key];
  }
  const compactAnswersJson = JSON.stringify(answers);
  const partResults = await gradeExamAnswers(paper, answers, 'admin', group, env);
  const scores = calculateExamScores(paper, partResults);
  const gradingJson = JSON.stringify({ partResults });
  const previous = await env.OJ_DB.prepare(`
    SELECT COALESCE(MAX(attempt_no), 0) AS attempts
    FROM exam_submissions WHERE exam_id = ?1 AND username = 'admin' AND is_preview = 1
  `).bind(examId).first();
  const attemptNo = Number(previous?.attempts || 0) + 1;
  const now = Date.now();
  const statements = [
    env.OJ_DB.prepare(`
      UPDATE exam_submissions SET is_final = 0, updated_at = ?2
      WHERE exam_id = ?1 AND username = 'admin' AND is_preview = 1 AND is_final = 1
    `).bind(examId, now),
    env.OJ_DB.prepare(`
      INSERT INTO exam_submissions (
        exam_id, exam_version, username, attempt_no, answers_json, grading_json,
        auto_score, manual_score, total_score, graded_count, total_parts,
        grading_status, released, is_preview, is_final, submitted_at, updated_at
      ) VALUES (?1, ?2, 'admin', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 0, 1, 1, ?12, ?12)
    `).bind(
      examId, paper.version, attemptNo, compactAnswersJson, gradingJson,
      scores.autoScore, scores.manualScore, scores.totalScore, scores.gradedCount,
      scores.totalParts, scores.gradingStatus, now,
    ),
  ];
  await env.OJ_DB.batch(statements);
  const visible = isExamResultVisible(paper.resultPolicy, scores.gradingStatus, 0);
  return jsonResponse({
    success: true,
    preview: true,
    attemptNo,
    gradingStatus: scores.gradingStatus,
    gradedCount: scores.gradedCount,
    totalParts: scores.totalParts,
    resultVisible: visible,
    ...(visible ? { totalScore: scores.totalScore, grading: { partResults } } : {}),
  });
}

async function handleStudentExamSubmit(body, env, options = {}) {
  if (!env.OJ_DB) return jsonResponse({ error: '试卷数据库尚未配置' }, 503);
  const examId = normalizeExamId(body.examId);
  const username = normalizeStudentUsername(body.username);
  const answers = body.answers && typeof body.answers === 'object' && !Array.isArray(body.answers) ? body.answers : null;
  if (!examId || !username || !answers) return jsonResponse({ error: '试卷提交内容不正确' }, 400);
  const answersJson = JSON.stringify(answers);
  if (answersJson.length > 600000) return jsonResponse({ error: '整张试卷答案不能超过 600 KB' }, 413);
  const record = await readExamRecord(env, examId);
  if (!record || record.status !== 'published') return jsonResponse({ error: '试卷不存在或尚未发布' }, 404);
  if (!await canStudentAccessExam(env, examId, username)) return jsonResponse({ error: '你不在这张套卷的准入范围内' }, 403);
  const group = record.group_name;
  if (body.group && normalizeGroup(body.group) !== group) return jsonResponse({ error: '试卷组别不正确' }, 400);
  const paper = parseExamRecord(record);
  const effectiveAvailability = await studentAvailability(
    paper.availability, 'exam', group, examId, username, env,
  );
  const currentTiming = availabilityState(effectiveAvailability);
  if (!options.bypassTiming && !currentTiming.canEdit) return timedAccessError(currentTiming);
  const validPartIds = new Set(paper.questions.flatMap(question => question.parts.map(part => part.id)));
  for (const key of Object.keys(answers)) {
    if (!validPartIds.has(key)) delete answers[key];
  }
  const compactAnswersJson = JSON.stringify(answers);
  const partResults = await gradeExamAnswers(paper, answers, username, group, env);
  const scores = calculateExamScores(paper, partResults);
  const gradingJson = JSON.stringify({ partResults });
  const previous = await env.OJ_DB.prepare(`
    SELECT COALESCE(MAX(attempt_no), 0) AS attempts
    FROM exam_submissions WHERE exam_id = ?1 AND username = ?2 AND is_preview = 0
  `).bind(examId, username).first();
  const attemptNo = Number(previous?.attempts || 0) + 1;
  const now = Date.now();
  const visitorHash = await analyticsVisitorHash(username, env);
  const statements = [
    env.OJ_DB.prepare(`
      UPDATE exam_submissions SET is_final = 0, updated_at = ?3
      WHERE exam_id = ?1 AND username = ?2 AND is_preview = 0 AND is_final = 1
    `).bind(examId, username, now),
    env.OJ_DB.prepare(`
      INSERT INTO exam_submissions (
        exam_id, exam_version, username, attempt_no, answers_json, grading_json,
        auto_score, manual_score, total_score, graded_count, total_parts,
        grading_status, released, is_final, submitted_at, updated_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 0, 1, ?13, ?13)
    `).bind(
      examId, paper.version, username, attemptNo, compactAnswersJson, gradingJson,
      scores.autoScore, scores.manualScore, scores.totalScore, scores.gradedCount,
      scores.totalParts, scores.gradingStatus, now,
    ),
    env.OJ_DB.prepare(`
      INSERT INTO analytics_exam_visitors
        (group_name, exam_id, visitor_hash, first_seen, last_seen)
      VALUES (?1, ?2, ?3, ?4, ?4)
      ON CONFLICT(group_name, exam_id, visitor_hash)
      DO UPDATE SET last_seen = excluded.last_seen
    `).bind(group, examId, visitorHash, now),
  ];
  const completionMessage = examCompletionMessageStatement(env, {
    examId, username, title: paper.title, group,
    resultPolicy: paper.resultPolicy, gradingStatus: scores.gradingStatus, createdAt: now,
  });
  if (completionMessage) statements.push(completionMessage);
  const programmingProblemIds = [...new Set(paper.questions.flatMap(question => question.parts)
    .filter(part => part.type === 'programming' && /^(?:P\d{3,6}|T\d{3})$/.test(part.problemId))
    .map(part => part.problemId))];
  for (const problemId of programmingProblemIds) {
    statements.push(env.OJ_DB.prepare(`
      DELETE FROM resubmission_requests
      WHERE group_name = ?1 AND problem_id = ?2 AND username = ?3
    `).bind(group, problemId, username));
  }
  if (!options.bypassTiming && currentTiming.state === 'active') {
    statements.push(env.OJ_DB.prepare(`
      UPDATE timed_drafts SET status = 'submitted', submitted_at = ?6, payload_json = '{}'
      WHERE resource_type = 'exam' AND group_name = ?1 AND resource_id = ?2
        AND resource_version = ?3 AND username = ?4 AND window_start = ?5 AND status = 'active'
    `).bind(group, examId, paper.version, username, currentTiming.windowStart, now));
  }
  await env.OJ_DB.batch(statements);
  const visible = isExamResultVisible(paper.resultPolicy, scores.gradingStatus, 0);
  return jsonResponse({
    success: true,
    attemptNo,
    gradingStatus: scores.gradingStatus,
    gradedCount: scores.gradedCount,
    totalParts: scores.totalParts,
    resultVisible: visible,
    ...(visible ? { totalScore: scores.totalScore, grading: { partResults } } : {}),
  });
}

async function handleAdminExamSubmissions(body, env) {
  if (!env.OJ_DB) return jsonResponse({ error: '试卷数据库尚未配置' }, 503);
  const examId = normalizeExamId(body.examId);
  if (!examId) return jsonResponse({ error: '试卷编号不正确' }, 400);
  const result = await env.OJ_DB.prepare(`
    SELECT id, exam_id, exam_version, username, attempt_no,
           auto_score, manual_score, total_score, graded_count, total_parts,
           grading_status, released, is_preview, is_final, submitted_at, updated_at
    FROM exam_submissions
    WHERE exam_id = ?1 AND is_final = 1
    ORDER BY submitted_at ASC
  `).bind(examId).all();
  return jsonResponse((result.results || []).map(row => ({
    id: Number(row.id),
    examId: row.exam_id,
    examVersion: Number(row.exam_version),
    username: row.username,
    attemptNo: Number(row.attempt_no),
    autoScore: Number(row.auto_score),
    manualScore: Number(row.manual_score),
    totalScore: Number(row.total_score),
    gradedCount: Number(row.graded_count),
    totalParts: Number(row.total_parts),
    gradingStatus: row.grading_status,
    released: Number(row.released) === 1,
    preview: Number(row.is_preview) === 1,
    submittedAt: Number(row.submitted_at),
    updatedAt: Number(row.updated_at),
  })));
}

async function handleAdminExamSubmissionGet(body, env) {
  if (!env.OJ_DB) return jsonResponse({ error: '试卷数据库尚未配置' }, 503);
  const submissionId = Number(body.submissionId);
  if (!Number.isInteger(submissionId) || submissionId < 1) return jsonResponse({ error: '提交编号不正确' }, 400);
  const row = await env.OJ_DB.prepare(`
    SELECT id, exam_id, exam_version, username, attempt_no, answers_json, grading_json,
           auto_score, manual_score, total_score, graded_count, total_parts,
           grading_status, released, is_preview, is_final, submitted_at, updated_at
    FROM exam_submissions WHERE id = ?1
  `).bind(submissionId).first();
  if (!row || Number(row.is_final) !== 1) return jsonResponse({ error: '最终提交不存在或已经被新提交替代' }, 404);
  return jsonResponse({
    id: Number(row.id), examId: row.exam_id, examVersion: Number(row.exam_version),
    username: row.username, attemptNo: Number(row.attempt_no),
    answers: JSON.parse(row.answers_json), grading: JSON.parse(row.grading_json),
    autoScore: Number(row.auto_score), manualScore: Number(row.manual_score),
    totalScore: Number(row.total_score), gradedCount: Number(row.graded_count),
    totalParts: Number(row.total_parts), gradingStatus: row.grading_status,
    released: Number(row.released) === 1, preview: Number(row.is_preview) === 1,
    submittedAt: Number(row.submitted_at), updatedAt: Number(row.updated_at),
  });
}

async function handleAdminExamGrade(body, env) {
  if (!env.OJ_DB) return jsonResponse({ error: '试卷数据库尚未配置' }, 503);
  const submissionId = Number(body.submissionId);
  if (!Number.isInteger(submissionId) || submissionId < 1) return jsonResponse({ error: '提交编号不正确' }, 400);
  const submission = await env.OJ_DB.prepare('SELECT * FROM exam_submissions WHERE id = ?1').bind(submissionId).first();
  if (!submission) return jsonResponse({ error: '试卷提交不存在' }, 404);
  if (Number(submission.is_final) !== 1) return jsonResponse({ error: '该提交已被学生的新提交替代，不能作为最终成绩批改' }, 409);
  const version = await env.OJ_DB.prepare(`
    SELECT v.structure_json, p.title, p.description, p.status, p.result_policy,
           p.total_score, p.group_name, p.updated_at
    FROM exam_versions v JOIN exam_papers p ON p.id = v.exam_id
    WHERE v.exam_id = ?1 AND v.version = ?2
  `).bind(submission.exam_id, submission.exam_version).first();
  if (!version) return jsonResponse({ error: '试卷历史版本不存在' }, 503);
  const paper = {
    ...JSON.parse(version.structure_json),
    id: submission.exam_id,
    title: version.title,
    version: Number(submission.exam_version),
  };
  const grading = JSON.parse(submission.grading_json);
  const partResults = Array.isArray(grading.partResults) ? grading.partResults : [];
  const result = partResults.find(item => item.partId === body.partId);
  const part = paper.questions.flatMap(question => question.parts).find(item => item.id === body.partId);
  if (body.partId) {
    if (!result || !part) return jsonResponse({ error: '小题不存在' }, 404);
    const score = Number(body.score);
    if (!Number.isFinite(score) || score < 0 || score > Number(part.points)) {
      return jsonResponse({ error: `人工评分必须在 0 到 ${part.points} 之间` }, 400);
    }
    result.manualScore = Math.round(score * 100) / 100;
    result.autoScore = 0;
    result.status = score >= Number(part.points) ? 'correct' : 'graded';
    result.feedback = normalizeExamText(body.feedback, 3000);
    result.gradingSource = 'manual';
    result.manualEditedAt = Date.now();
    delete result.aiAdopted;
  }
  const scores = calculateExamScores(paper, partResults);
  const released = typeof body.released === 'boolean' ? (body.released ? 1 : 0) : Number(submission.released);
  const now = Date.now();
  const statements = [env.OJ_DB.prepare(`
    UPDATE exam_submissions
    SET grading_json = ?2, auto_score = ?3, manual_score = ?4, total_score = ?5,
        graded_count = ?6, total_parts = ?7, grading_status = ?8, released = ?9, updated_at = ?10
    WHERE id = ?1 AND is_final = 1
  `).bind(
    submissionId, JSON.stringify({ partResults }), scores.autoScore, scores.manualScore,
    scores.totalScore, scores.gradedCount, scores.totalParts, scores.gradingStatus,
    released, now,
  )];
  const completionMessage = Number(submission.is_preview) === 0
    ? examCompletionMessageStatement(env, {
      examId: submission.exam_id, username: submission.username, title: version.title,
      group: version.group_name, resultPolicy: version.result_policy,
      gradingStatus: scores.gradingStatus, createdAt: now, submissionId,
    })
    : null;
  if (completionMessage) statements.push(completionMessage);
  await env.OJ_DB.batch(statements);
  return jsonResponse({ success: true, ...scores, released: released === 1, grading: { partResults } });
}

async function handleAdminExamAiExport(body, env) {
  if (!env.OJ_DB) return jsonResponse({ error: '试卷数据库尚未配置' }, 503);
  const examId = normalizeExamId(body.examId);
  const partId = normalizeExamText(body.partId, 50);
  const submissionId = Number(body.submissionId || 0);
  const forceRegrade = body.forceRegrade === true;
  if (!examId || !partId) return jsonResponse({ error: '请选择需要 AI 辅助批改的小题' }, 400);
  if (forceRegrade && (!Number.isInteger(submissionId) || submissionId < 1)) {
    return jsonResponse({ error: '单题重新评分必须指定学生提交' }, 400);
  }
  const paperRow = await env.OJ_DB.prepare('SELECT title FROM exam_papers WHERE id = ?1').bind(examId).first();
  if (!paperRow) return jsonResponse({ error: '试卷不存在' }, 404);
  const answerPath = `$."${partId.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  const rows = await env.OJ_DB.prepare(`
    SELECT s.id, s.exam_version, json_extract(s.answers_json, ?2) AS selected_answer,
           s.grading_json, s.updated_at,
           v.structure_json
    FROM exam_submissions s
    JOIN exam_versions v ON v.exam_id = s.exam_id AND v.version = s.exam_version
    WHERE s.exam_id = ?1 AND s.is_final = 1 AND s.is_preview = 0
    ORDER BY s.id ASC
  `).bind(examId, answerPath).all();
  const groups = new Map();
  for (const row of rows.results || []) {
    if (submissionId && Number(row.id) !== submissionId) continue;
    let structure;
    let grading;
    try {
      structure = JSON.parse(row.structure_json);
      grading = JSON.parse(row.grading_json);
    } catch {
      continue;
    }
    const question = structure.questions?.find(item => item.parts?.some(part => part.id === partId));
    const part = question?.parts?.find(item => item.id === partId);
    const partResult = grading.partResults?.find(item => item.partId === partId);
    const aiEligibleType = ['fill_blank', 'short_answer'].includes(part?.type);
    if (!part || !partResult || !aiEligibleType
        || (!forceRegrade && (partResult.status !== 'pending' || partResult.aiSuggestion))) continue;
    const version = Number(row.exam_version);
    if (!groups.has(version)) {
      groups.set(version, {
        examVersion: version,
        question: {
          id: question.id,
          title: question.title,
          description: String(question.description || '').slice(0, 20000),
        },
        part: {
          id: part.id,
          type: part.type,
          prompt: String(part.prompt || '').slice(0, 20000),
          maxScore: Number(part.points),
          gradingGuide: String(part.gradingGuide || '').slice(0, 12000),
          options: (part.options || []).slice(0, 50),
          acceptedAnswers: (part.correctAnswers || []).slice(0, 50),
          caseSensitive: part.caseSensitive === true,
          problemId: String(part.problemId || '').slice(0, 20),
        },
        submissions: [],
      });
    }
    groups.get(version).submissions.push({
      submissionId: Number(row.id),
      sourceUpdatedAt: Number(row.updated_at),
      answer: String(row.selected_answer ?? '').slice(0, 30000),
    });
  }
  const exportGroups = [...groups.values()].filter(group => group.submissions.length);
  if (!exportGroups.length) {
    return jsonResponse({ error: forceRegrade
      ? '没有找到这名学生的当前小题答案'
      : '这道题没有待批改的填空或简答答案' }, 409);
  }
  return jsonResponse({
    format: 'jc-oj-claude-grading-v1',
    createdAt: Date.now(),
    exam: { id: examId, title: paperRow.title },
    partId,
    forceRegrade,
    ...(forceRegrade ? { submissionId } : {}),
    groups: exportGroups,
    submissionCount: exportGroups.reduce((sum, group) => sum + group.submissions.length, 0),
  });
}

async function handleAdminExamAiImport(body, env) {
  if (!env.OJ_DB) return jsonResponse({ error: '试卷数据库尚未配置' }, 503);
  const payload = body.payload;
  if (!payload || payload.format !== 'jc-oj-claude-grading-results-v1' || !Array.isArray(payload.results)) {
    return jsonResponse({ error: 'Claude 批改结果文件格式不正确' }, 400);
  }
  const examId = normalizeExamId(payload.examId);
  const partId = normalizeExamText(payload.partId, 50);
  const forceRegrade = payload.forceRegrade === true;
  const forcedSubmissionId = Number(payload.submissionId || 0);
  if (!examId || !partId || payload.results.length < 1 || payload.results.length > 1000) {
    return jsonResponse({ error: 'Claude 批改结果数量或题目信息不正确' }, 400);
  }
  if (forceRegrade && (!Number.isInteger(forcedSubmissionId) || forcedSubmissionId < 1
      || payload.results.length !== 1 || Number(payload.results[0]?.submissionId) !== forcedSubmissionId)) {
    return jsonResponse({ error: 'Claude 单题重新评分结果范围不正确' }, 400);
  }
  const rows = await env.OJ_DB.prepare(`
    SELECT s.id, s.exam_version, s.username, s.grading_json, s.updated_at, v.structure_json,
           p.title, p.group_name, p.result_policy
    FROM exam_submissions s
    JOIN exam_versions v ON v.exam_id = s.exam_id AND v.version = s.exam_version
    JOIN exam_papers p ON p.id = s.exam_id
    WHERE s.exam_id = ?1 AND s.is_final = 1 AND s.is_preview = 0
  `).bind(examId).all();
  const rowMap = new Map((rows.results || []).map(row => [Number(row.id), row]));
  const seen = new Set();
  const statements = [];
  const completionMessages = [];
  let skipped = 0;
  let autoAdopted = 0;
  let drafts = 0;
  const now = Date.now();
  for (const suggestion of payload.results) {
    const submissionId = Number(suggestion?.submissionId);
    const row = rowMap.get(submissionId);
    if (!row || seen.has(submissionId) || Number(suggestion?.sourceUpdatedAt) !== Number(row.updated_at)) {
      skipped += 1;
      continue;
    }
    seen.add(submissionId);
    let structure;
    let grading;
    try {
      structure = JSON.parse(row.structure_json);
      grading = JSON.parse(row.grading_json);
    } catch {
      skipped += 1;
      continue;
    }
    const part = structure.questions?.flatMap(question => question.parts || []).find(item => item.id === partId);
    const result = grading.partResults?.find(item => item.partId === partId);
    const score = Number(suggestion?.score);
    const confidence = Number(suggestion?.confidence);
    const aiEligibleType = ['fill_blank', 'short_answer'].includes(part?.type);
    if (!part || !result || !aiEligibleType
        || (!forceRegrade && result.status !== 'pending')
        || !Number.isFinite(score) || score < 0 || score > Number(part.points)
        || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      skipped += 1;
      continue;
    }
    const aiSuggestion = {
      score: Math.round(score * 100) / 100,
      feedback: normalizeExamText(suggestion.feedback, 1500),
      confidence: Math.round(confidence * 1000) / 1000,
      needsReview: suggestion.needsReview !== false,
      model: normalizeExamText(payload.model || 'Claude', 80),
      generatedAt: Number(payload.generatedAt) || now,
      forceRegrade,
    };
    result.aiSuggestion = aiSuggestion;
    const protectsExistingScore = forceRegrade && result.gradingSource === 'manual';
    if (!protectsExistingScore && isHighConfidenceAiSuggestion(aiSuggestion)) {
      adoptAiSuggestion(result, aiSuggestion, now, { automatic: true, includeFeedback: false });
      autoAdopted += 1;
    } else {
      drafts += 1;
    }
    const paper = { ...structure, id: examId, version: Number(row.exam_version) };
    const scores = calculateExamScores(paper, grading.partResults);
    statements.push(env.OJ_DB.prepare(`
      UPDATE exam_submissions
      SET grading_json = ?2, auto_score = ?3, manual_score = ?4, total_score = ?5,
          graded_count = ?6, total_parts = ?7, grading_status = ?8, updated_at = ?9
      WHERE id = ?1 AND is_final = 1 AND updated_at = ?10
    `).bind(
      submissionId, JSON.stringify(grading), scores.autoScore, scores.manualScore,
      scores.totalScore, scores.gradedCount, scores.totalParts, scores.gradingStatus,
      now, Number(row.updated_at),
    ));
    const completionMessage = examCompletionMessageStatement(env, {
      examId, username: row.username, title: row.title, group: row.group_name,
      resultPolicy: row.result_policy, gradingStatus: scores.gradingStatus,
      createdAt: now, submissionId,
    });
    if (completionMessage) completionMessages.push(completionMessage);
  }
  for (let index = 0; index < statements.length; index += 80) {
    await env.OJ_DB.batch(statements.slice(index, index + 80));
  }
  for (let index = 0; index < completionMessages.length; index += 80) {
    await env.OJ_DB.batch(completionMessages.slice(index, index + 80));
  }
  return jsonResponse({ success: true, imported: statements.length, autoAdopted, drafts, skipped });
}

const AI_HIGH_CONFIDENCE_THRESHOLD = 0.85;

function isHighConfidenceAiSuggestion(suggestion) {
  return Number(suggestion?.confidence) >= AI_HIGH_CONFIDENCE_THRESHOLD
    && suggestion?.needsReview === false;
}

function isClaudeOwnedResult(result) {
  return result?.gradingSource === 'claude'
    || (Boolean(result?.aiAdopted) && result?.gradingSource !== 'manual');
}

function restoreLegacyAiSuggestion(result) {
  const adopted = result?.aiAdopted;
  if (result?.aiSuggestion || !adopted || adopted.includeFeedback !== undefined) return false;
  const score = Number(result.manualScore);
  const confidence = Number(adopted.confidence);
  if (!Number.isFinite(score) || !Number.isFinite(confidence)) return false;
  result.aiSuggestion = {
    score: Math.round(score * 100) / 100,
    feedback: normalizeExamText(result.feedback, 1500),
    confidence: Math.round(confidence * 1000) / 1000,
    needsReview: adopted.automatic !== true,
    model: normalizeExamText(adopted.model || 'Claude', 80),
    generatedAt: Number(adopted.generatedAt) || Number(adopted.adoptedAt) || Date.now(),
  };
  result.gradingSource = 'claude';
  // 旧版本采纳时总是同时写入评价。
  adopted.includeFeedback = true;
  return true;
}

function adoptAiSuggestion(result, suggestion, now, { automatic = false, includeFeedback = false } = {}) {
  result.manualScore = Math.round(Number(suggestion.score) * 100) / 100;
  result.autoScore = 0;
  result.status = result.manualScore >= Number(result.maxScore) ? 'correct' : 'graded';
  if (includeFeedback) result.feedback = normalizeExamText(suggestion.feedback, 3000);
  result.gradingSource = 'claude';
  delete result.manualEditedAt;
  result.aiAdopted = {
    confidence: Math.round(Number(suggestion.confidence) * 1000) / 1000,
    model: normalizeExamText(suggestion.model || 'Claude', 80),
    generatedAt: Number(suggestion.generatedAt) || now,
    adoptedAt: now,
    automatic,
    includeFeedback,
  };
}

async function handleAdminExamAiAdopt(body, env) {
  if (!env.OJ_DB) return jsonResponse({ error: '试卷数据库尚未配置' }, 503);
  const examId = normalizeExamId(body.examId);
  const partId = normalizeExamText(body.partId, 50);
  const submissionId = Number(body.submissionId || 0);
  const highOnly = body.highOnly === true;
  const includeFeedback = body.includeFeedback === true;
  const allowManualOverride = body.allowManualOverride === true;
  if (!examId) return jsonResponse({ error: '试卷编号不正确' }, 400);
  if (body.submissionId != null && (!Number.isInteger(submissionId) || submissionId < 1)) {
    return jsonResponse({ error: '提交编号不正确' }, 400);
  }

  const rows = await env.OJ_DB.prepare(`
    SELECT s.id, s.exam_version, s.username, s.grading_json, s.updated_at, v.structure_json,
           p.title, p.group_name, p.result_policy
    FROM exam_submissions s
    JOIN exam_versions v ON v.exam_id = s.exam_id AND v.version = s.exam_version
    JOIN exam_papers p ON p.id = s.exam_id
    WHERE s.exam_id = ?1 AND s.is_final = 1 AND s.is_preview = 0
    ORDER BY s.id ASC
  `).bind(examId).all();
  const now = Date.now();
  const statements = [];
  const completionMessages = [];
  let adopted = 0;
  let restored = 0;
  let skipped = 0;
  let protectedCount = 0;
  for (const row of rows.results || []) {
    if (submissionId && Number(row.id) !== submissionId) continue;
    let structure;
    let grading;
    try {
      structure = JSON.parse(row.structure_json);
      grading = JSON.parse(row.grading_json);
    } catch {
      skipped += 1;
      continue;
    }
    let changed = false;
    for (const result of grading.partResults || []) {
      if (partId && result.partId !== partId) continue;
      if (restoreLegacyAiSuggestion(result)) {
        restored += 1;
        changed = true;
      }
      const suggestion = result.aiSuggestion;
      if (!suggestion) continue;
      // 批量采纳始终保护人工结果；只有管理员针对单个学生主动重新评分后，
      // 才允许该草稿在再次明确点击“采纳”时替换已有结果。
      const explicitForcedOverride = allowManualOverride && submissionId && partId
        && suggestion.forceRegrade === true;
      if (!explicitForcedOverride && (result.gradingSource === 'manual'
          || (result.status !== 'pending' && !isClaudeOwnedResult(result)))) {
        protectedCount += 1;
        continue;
      }
      const score = Number(suggestion.score);
      if (!Number.isFinite(score) || score < 0 || score > Number(result.maxScore)) {
        skipped += 1;
        continue;
      }
      if (highOnly && !isHighConfidenceAiSuggestion(suggestion)) continue;
      if (highOnly && isClaudeOwnedResult(result)
          && Number(result.aiAdopted?.generatedAt) === Number(suggestion.generatedAt)
          && result.aiAdopted?.automatic === true) continue;
      adoptAiSuggestion(result, suggestion, now, { automatic: highOnly, includeFeedback });
      adopted += 1;
      changed = true;
    }
    if (!changed) continue;
    const paper = { ...structure, id: examId, version: Number(row.exam_version) };
    const scores = calculateExamScores(paper, grading.partResults);
    statements.push(env.OJ_DB.prepare(`
      UPDATE exam_submissions
      SET grading_json = ?2, auto_score = ?3, manual_score = ?4, total_score = ?5,
          graded_count = ?6, total_parts = ?7, grading_status = ?8, updated_at = ?9
      WHERE id = ?1 AND is_final = 1 AND updated_at = ?10
    `).bind(
      Number(row.id), JSON.stringify(grading), scores.autoScore, scores.manualScore,
      scores.totalScore, scores.gradedCount, scores.totalParts, scores.gradingStatus,
      now, Number(row.updated_at),
    ));
    const completionMessage = examCompletionMessageStatement(env, {
      examId, username: row.username, title: row.title, group: row.group_name,
      resultPolicy: row.result_policy, gradingStatus: scores.gradingStatus,
      createdAt: now, submissionId: Number(row.id),
    });
    if (completionMessage) completionMessages.push(completionMessage);
  }
  for (let index = 0; index < statements.length; index += 80) {
    await env.OJ_DB.batch(statements.slice(index, index + 80));
  }
  for (let index = 0; index < completionMessages.length; index += 80) {
    await env.OJ_DB.batch(completionMessages.slice(index, index + 80));
  }
  return jsonResponse({ success: true, adopted, restored, submissionsUpdated: statements.length, skipped, protected: protectedCount });
}

async function handleAdminExamAiDelete(body, env) {
  if (!env.OJ_DB) return jsonResponse({ error: '试卷数据库尚未配置' }, 503);
  const examId = normalizeExamId(body.examId);
  const partId = normalizeExamText(body.partId, 50);
  const submissionId = Number(body.submissionId || 0);
  if (!examId) return jsonResponse({ error: '试卷编号不正确' }, 400);
  if (body.submissionId != null && (!Number.isInteger(submissionId) || submissionId < 1)) {
    return jsonResponse({ error: '提交编号不正确' }, 400);
  }

  const rows = await env.OJ_DB.prepare(`
    SELECT id, grading_json, updated_at
    FROM exam_submissions
    WHERE exam_id = ?1 AND is_final = 1 AND is_preview = 0
    ORDER BY id ASC
  `).bind(examId).all();
  const now = Date.now();
  const statements = [];
  let deleted = 0;
  let skipped = 0;
  for (const row of rows.results || []) {
    if (submissionId && Number(row.id) !== submissionId) continue;
    let grading;
    try {
      grading = JSON.parse(row.grading_json);
    } catch {
      skipped += 1;
      continue;
    }
    let changed = false;
    for (const result of grading.partResults || []) {
      if (partId && result.partId !== partId) continue;
      if (!result.aiSuggestion) continue;
      delete result.aiSuggestion;
      deleted += 1;
      changed = true;
    }
    if (!changed) continue;
    statements.push(env.OJ_DB.prepare(`
      UPDATE exam_submissions SET grading_json = ?2, updated_at = ?3
      WHERE id = ?1 AND is_final = 1 AND updated_at = ?4
    `).bind(Number(row.id), JSON.stringify(grading), now, Number(row.updated_at)));
  }
  for (let index = 0; index < statements.length; index += 80) {
    await env.OJ_DB.batch(statements.slice(index, index + 80));
  }
  return jsonResponse({ success: true, deleted, submissionsUpdated: statements.length, skipped });
}

async function handleAdminExamPartClearGrading(body, env) {
  if (!env.OJ_DB) return jsonResponse({ error: '试卷数据库尚未配置' }, 503);
  const examId = normalizeExamId(body.examId);
  const partId = normalizeExamText(body.partId, 50);
  const action = body.action === 'score' ? 'score' : body.action === 'feedback' ? 'feedback' : '';
  if (!examId || !partId) return jsonResponse({ error: '请选择需要处理的小题' }, 400);
  if (!action) return jsonResponse({ error: '清除操作类型不正确' }, 400);
  const rows = await env.OJ_DB.prepare(`
    SELECT s.id, s.exam_version, s.grading_json, s.updated_at, v.structure_json
    FROM exam_submissions s
    JOIN exam_versions v ON v.exam_id = s.exam_id AND v.version = s.exam_version
    WHERE s.exam_id = ?1 AND s.is_final = 1 AND s.is_preview = 0
    ORDER BY s.id ASC
  `).bind(examId).all();
  const statements = [];
  let affected = 0;
  let skipped = 0;
  const now = Date.now();
  for (const row of rows.results || []) {
    let structure;
    let grading;
    try {
      structure = JSON.parse(row.structure_json);
      grading = JSON.parse(row.grading_json);
    } catch {
      skipped += 1;
      continue;
    }
    const part = structure.questions?.flatMap(question => question.parts || []).find(item => item.id === partId);
    const result = grading.partResults?.find(item => item.partId === partId);
    if (!part || !result || !['fill_blank', 'short_answer'].includes(part.type)) {
      skipped += 1;
      continue;
    }
    if (action === 'feedback') {
      if (!result.feedback) continue;
      result.feedback = '';
    } else {
      result.manualScore = 0;
      result.autoScore = 0;
      result.feedback = '';
      result.status = 'pending';
      delete result.gradingSource;
      delete result.manualEditedAt;
      delete result.aiAdopted;
    }
    const paper = { ...structure, id: examId, version: Number(row.exam_version) };
    const scores = calculateExamScores(paper, grading.partResults);
    statements.push(env.OJ_DB.prepare(`
      UPDATE exam_submissions
      SET grading_json = ?2, auto_score = ?3, manual_score = ?4, total_score = ?5,
          graded_count = ?6, total_parts = ?7, grading_status = ?8, updated_at = ?9
      WHERE id = ?1 AND is_final = 1 AND is_preview = 0 AND updated_at = ?10
    `).bind(
      Number(row.id), JSON.stringify(grading), scores.autoScore, scores.manualScore,
      scores.totalScore, scores.gradedCount, scores.totalParts, scores.gradingStatus,
      now, Number(row.updated_at),
    ));
    affected += 1;
  }
  for (let index = 0; index < statements.length; index += 80) {
    await env.OJ_DB.batch(statements.slice(index, index + 80));
  }
  return jsonResponse({ success: true, action, affected, skipped });
}

async function handleAdminExamPartBulkAction(body, env) {
  if (!env.OJ_DB) return jsonResponse({ error: '试卷数据库尚未配置' }, 503);
  const examId = normalizeExamId(body.examId);
  const problemId = String(body.problemId || '').trim().toUpperCase();
  const action = body.action === 'resubmit' ? 'resubmit' : body.action === 'rejudge' ? 'rejudge' : '';
  if (!examId) return jsonResponse({ error: '试卷编号不正确' }, 400);
  if (!/^(?:P\d{3,6}|T\d{3})$/.test(problemId)) return jsonResponse({ error: '关联题号不正确' }, 400);
  if (!action) return jsonResponse({ error: '批量操作类型不正确' }, 400);

  const result = await env.OJ_DB.prepare(`
    SELECT s.id, s.username, p.group_name, v.structure_json
    FROM exam_submissions s
    JOIN exam_papers p ON p.id = s.exam_id
    JOIN exam_versions v ON v.exam_id = s.exam_id AND v.version = s.exam_version
    WHERE s.exam_id = ?1 AND s.is_final = 1 AND s.is_preview = 0
    ORDER BY s.id ASC
  `).bind(examId).all();
  const targets = [];
  for (const row of result.results || []) {
    try {
      const structure = JSON.parse(row.structure_json);
      const referenced = structure.questions?.some(question => question.parts?.some(part =>
        part.type === 'programming' && part.problemId === problemId));
      if (referenced) targets.push({
        submissionId: Number(row.id),
        username: row.username,
        group: row.group_name,
      });
    } catch {
      // 单个损坏的历史版本不应阻塞其他学生的批量操作。
    }
  }
  if (!targets.length) return jsonResponse({ success: true, action, count: 0 });

  const now = Date.now();
  const statements = [];
  if (action === 'rejudge') {
    for (const target of targets) {
      statements.push(env.OJ_DB.prepare(`
        INSERT INTO rejudge_queue (
          submission_kind, submission_id, group_name, problem_id,
          status, attempts, requested_at, updated_at, last_error
        ) VALUES ('exam', ?1, ?2, ?3, 'pending', 0, ?4, ?4, '')
        ON CONFLICT(submission_kind, submission_id, problem_id) DO UPDATE SET
          group_name = excluded.group_name, status = 'pending', attempts = 0,
          requested_at = excluded.requested_at, updated_at = excluded.updated_at,
          last_error = ''
      `).bind(target.submissionId, target.group, problemId, now));
    }
  } else {
    const uniqueTargets = [...new Map(targets.map(target => [target.username, target])).values()];
    for (const target of uniqueTargets) {
      const groupLabel = GROUPS[target.group]?.label || target.group;
      const resubmissionKey = `${target.group}:${problemId}:${target.username}`;
      statements.push(
        env.OJ_DB.prepare(`
          INSERT INTO resubmission_requests (group_name, problem_id, username, requested_at)
          VALUES (?1, ?2, ?3, ?4)
          ON CONFLICT(group_name, problem_id, username)
          DO UPDATE SET requested_at = excluded.requested_at
        `).bind(target.group, problemId, target.username, now),
        env.OJ_DB.prepare(`
          INSERT INTO system_messages (
            audience, username, title, content, created_at,
            message_type, group_name, problem_id, resubmission_key, popup_enabled
          ) VALUES ('user', ?1, ?2, ?3, ?4, 'resubmission', ?5, ?6, ?7, 1)
          ON CONFLICT(resubmission_key) DO UPDATE SET
            title = excluded.title, content = excluded.content,
            created_at = excluded.created_at, popup_enabled = 1
        `).bind(
          target.username,
          `需要重新提交：${problemId}`,
          `管理员要求你重新提交${groupLabel}题目 ${problemId}。请修改代码后重新提交判题。`,
          now, target.group, problemId, resubmissionKey,
        ),
        env.OJ_DB.prepare(`
          DELETE FROM system_message_reads
          WHERE message_id = (
            SELECT id FROM system_messages WHERE resubmission_key = ?1
          ) AND username = ?2
        `).bind(resubmissionKey, target.username),
      );
    }
    targets.length = uniqueTargets.length;
  }
  for (let index = 0; index < statements.length; index += 100) {
    await env.OJ_DB.batch(statements.slice(index, index + 100));
  }
  return jsonResponse({ success: true, action, count: targets.length });
}

async function resolveAdminSubmissionTarget(body, env) {
  const kind = body.submissionKind === 'exam' ? 'exam' : 'problem';
  const submissionId = Number(body.submissionId);
  if (!Number.isInteger(submissionId) || submissionId < 1) return { error: '提交编号不正确' };
  if (kind === 'problem') {
    const row = await env.OJ_DB.prepare(`
      SELECT id, username, problem_id FROM submissions WHERE id = ?1
    `).bind(submissionId).first();
    if (!row) return { error: '找不到该编程提交' };
    const parsed = publicProblemId(row.problem_id);
    return { kind, submissionId, username: row.username, group: parsed.group, problemId: parsed.problemId };
  }
  const problemId = String(body.problemId || '').trim().toUpperCase();
  if (!/^(?:P\d{3,6}|T\d{3})$/.test(problemId)) return { error: '关联题号不正确' };
  const row = await env.OJ_DB.prepare(`
    SELECT s.id, s.username, s.is_preview, p.group_name, v.structure_json
    FROM exam_submissions s
    JOIN exam_papers p ON p.id = s.exam_id
    JOIN exam_versions v ON v.exam_id = s.exam_id AND v.version = s.exam_version
    WHERE s.id = ?1 AND s.is_final = 1
  `).bind(submissionId).first();
  if (!row || Number(row.is_preview) === 1) return { error: '找不到该学生的最终套卷提交' };
  let referenced = false;
  try {
    const structure = JSON.parse(row.structure_json);
    referenced = structure.questions?.some(question => question.parts?.some(part =>
      part.type === 'programming' && part.problemId === problemId));
  } catch { /* 下方统一返回错误 */ }
  if (!referenced) return { error: '这份套卷提交不包含该编程题' };
  return {
    kind, submissionId, username: row.username,
    group: row.group_name, problemId,
  };
}

async function handleAdminRejudgeSubmission(body, env) {
  if (!env.OJ_DB) return jsonResponse({ error: '提交数据库尚未配置' }, 503);
  const target = await resolveAdminSubmissionTarget(body, env);
  if (target.error) return jsonResponse({ error: target.error }, 400);
  const now = Date.now();
  await env.OJ_DB.prepare(`
    INSERT INTO rejudge_queue (
      submission_kind, submission_id, group_name, problem_id,
      status, attempts, requested_at, updated_at, last_error
    ) VALUES (?1, ?2, ?3, ?4, 'pending', 0, ?5, ?5, '')
    ON CONFLICT(submission_kind, submission_id, problem_id) DO UPDATE SET
      group_name = excluded.group_name, status = 'pending', attempts = 0,
      requested_at = excluded.requested_at, updated_at = excluded.updated_at,
      last_error = ''
  `).bind(target.kind, target.submissionId, target.group, target.problemId, now).run();
  return jsonResponse({ success: true, queued: true, ...target });
}

async function handleAdminRequestResubmission(body, env) {
  if (!env.OJ_DB) return jsonResponse({ error: '提交数据库尚未配置' }, 503);
  const target = await resolveAdminSubmissionTarget(body, env);
  if (target.error) return jsonResponse({ error: target.error }, 400);
  const now = Date.now();
  const groupLabel = GROUPS[target.group]?.label || target.group;
  const resubmissionKey = `${target.group}:${target.problemId}:${target.username}`;
  await env.OJ_DB.batch([
    env.OJ_DB.prepare(`
      INSERT INTO resubmission_requests (group_name, problem_id, username, requested_at)
      VALUES (?1, ?2, ?3, ?4)
      ON CONFLICT(group_name, problem_id, username)
      DO UPDATE SET requested_at = excluded.requested_at
    `).bind(target.group, target.problemId, target.username, now),
    env.OJ_DB.prepare(`
      INSERT INTO system_messages (
        audience, username, title, content, created_at,
        message_type, group_name, problem_id, resubmission_key, popup_enabled
      ) VALUES ('user', ?1, ?2, ?3, ?4, 'resubmission', ?5, ?6, ?7, 1)
      ON CONFLICT(resubmission_key) DO UPDATE SET
        title = excluded.title, content = excluded.content,
        created_at = excluded.created_at, popup_enabled = 1
    `).bind(
      target.username,
      `需要重新提交：${target.problemId}`,
      `管理员要求你重新提交${groupLabel}题目 ${target.problemId}。请修改代码后重新提交判题。`,
      now, target.group, target.problemId, resubmissionKey,
    ),
    env.OJ_DB.prepare(`
      DELETE FROM system_message_reads
      WHERE message_id = (
        SELECT id FROM system_messages WHERE resubmission_key = ?1
      ) AND username = ?2
    `).bind(resubmissionKey, target.username),
  ]);
  return jsonResponse({ success: true, ...target, requestedAt: now });
}

async function handleStudentResubmissionNotices(body, env) {
  if (!env.OJ_DB) return jsonResponse([]);
  const username = normalizeStudentUsername(body.username);
  const group = normalizeGroup(body.group);
  const result = await env.OJ_DB.prepare(`
    SELECT problem_id, requested_at
    FROM resubmission_requests
    WHERE username = ?1 AND group_name = ?2
    ORDER BY requested_at DESC
  `).bind(username, group).all();
  return jsonResponse((result.results || []).map(row => ({
    problemId: row.problem_id,
    requestedAt: Number(row.requested_at),
  })));
}

async function handleAdminMessageList(env) {
  if (!env.OJ_DB) return jsonResponse({ error: '消息数据库尚未配置' }, 503);
  const result = await env.OJ_DB.prepare(`
    SELECT m.id, m.audience, m.username, m.title, m.content, m.created_at,
           m.message_type, m.group_name, m.problem_id, m.popup_enabled,
           COUNT(r.username) AS read_count
    FROM system_messages m
    LEFT JOIN system_message_reads r ON r.message_id = m.id
    GROUP BY m.id
    ORDER BY m.created_at DESC, m.id DESC
    LIMIT 200
  `).all();
  return jsonResponse((result.results || []).map(row => ({
    id: Number(row.id), audience: row.audience, username: row.username,
    title: row.title, content: row.content, createdAt: Number(row.created_at),
    messageType: row.message_type || 'message', group: row.group_name,
    problemId: row.problem_id,
    popupEnabled: Number(row.popup_enabled) === 1,
    readCount: Number(row.read_count || 0),
  })));
}

async function handleAdminMessageCreate(body, env) {
  if (!env.OJ_DB) return jsonResponse({ error: '消息数据库尚未配置' }, 503);
  const audience = body.audience === 'user' ? 'user' : 'all';
  const username = audience === 'user' ? normalizeStudentUsername(body.username) : null;
  const title = normalizeExamText(body.title, 120);
  const content = normalizeExamText(body.content, 10000);
  const popupEnabled = body.popupEnabled === true ? 1 : 0;
  if (!title || !content) return jsonResponse({ error: '请填写消息标题和正文' }, 400);
  if (audience === 'user') {
    if (!username) return jsonResponse({ error: '请输入接收学生的用户名' }, 400);
    const account = await env.OJ_DB.prepare('SELECT 1 AS found FROM student_accounts WHERE username = ?1')
      .bind(username).first();
    if (!account) return jsonResponse({ error: '找不到该学生账号，请检查用户名' }, 404);
  }
  const result = await env.OJ_DB.prepare(`
    INSERT INTO system_messages (audience, username, title, content, created_at, popup_enabled)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6)
  `).bind(audience, username, title, content, Date.now(), popupEnabled).run();
  return jsonResponse({ success: true, id: Number(result.meta?.last_row_id || 0) }, 201);
}

async function handleAdminMessageDelete(body, env) {
  if (!env.OJ_DB) return jsonResponse({ error: '消息数据库尚未配置' }, 503);
  const messageId = Number(body.messageId);
  if (!Number.isInteger(messageId) || messageId < 1) return jsonResponse({ error: '消息编号不正确' }, 400);
  await env.OJ_DB.batch([
    env.OJ_DB.prepare('DELETE FROM system_message_reads WHERE message_id = ?1').bind(messageId),
    env.OJ_DB.prepare('DELETE FROM system_messages WHERE id = ?1').bind(messageId),
  ]);
  return jsonResponse({ success: true });
}

async function handleStudentMessages(body, env) {
  if (!env.OJ_DB) return jsonResponse([]);
  const username = normalizeStudentUsername(body.username);
  const markRead = body.markRead === true;
  const result = await env.OJ_DB.prepare(`
    SELECT m.id, m.audience, m.title, m.content, m.created_at,
           m.message_type, m.group_name, m.problem_id, m.popup_enabled,
           CASE WHEN r.message_id IS NULL THEN 0 ELSE 1 END AS is_read,
           CASE WHEN rr.problem_id IS NULL THEN 0 ELSE 1 END AS requires_action
    FROM system_messages m
    LEFT JOIN system_message_reads r ON r.message_id = m.id AND r.username = ?1
    LEFT JOIN resubmission_requests rr
      ON m.message_type = 'resubmission'
     AND rr.username = ?1
     AND rr.group_name = m.group_name
     AND rr.problem_id = m.problem_id
    WHERE m.audience = 'all' OR (m.audience = 'user' AND m.username = ?1)
    ORDER BY m.created_at DESC, m.id DESC
    LIMIT 100
  `).bind(username).all();
  if (markRead) {
    const now = Date.now();
    const unread = (result.results || []).filter(row => Number(row.is_read) !== 1);
    for (let index = 0; index < unread.length; index += 100) {
      await env.OJ_DB.batch(unread.slice(index, index + 100).map(row => env.OJ_DB.prepare(`
        INSERT OR IGNORE INTO system_message_reads (message_id, username, read_at)
        VALUES (?1, ?2, ?3)
      `).bind(Number(row.id), username, now)));
    }
  }
  return jsonResponse((result.results || []).map(row => ({
    id: Number(row.id), audience: row.audience, title: row.title,
    content: row.content, createdAt: Number(row.created_at),
    messageType: row.message_type || 'message', group: row.group_name,
    problemId: row.problem_id, requiresAction: Number(row.requires_action) === 1,
    popupEnabled: Number(row.popup_enabled) === 1,
    read: markRead ? true : Number(row.is_read) === 1,
  })));
}

async function handleStudentMessageRead(body, env) {
  if (!env.OJ_DB) return jsonResponse({ success: true });
  const username = normalizeStudentUsername(body.username);
  const messageId = Number(body.messageId);
  if (!Number.isInteger(messageId) || messageId < 1) {
    return jsonResponse({ error: '消息编号不正确' }, 400);
  }
  await env.OJ_DB.prepare(`
    INSERT OR IGNORE INTO system_message_reads (message_id, username, read_at)
    SELECT id, ?1, ?2
    FROM system_messages
    WHERE id = ?3
      AND (audience = 'all' OR (audience = 'user' AND username = ?1))
  `).bind(username, Date.now(), messageId).run();
  return jsonResponse({ success: true });
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

  const mayBeStudentStandardPage = fileType === 'problems' || fileType === 'problem' || fileType === 'submissions';
  if (mayBeStudentStandardPage && !readCookie(request, ADMIN_SESSION_COOKIE) && await isExamModeEnabled(env)) {
    return examModeOnlyResponse();
  }

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
    if (!/^(?:p\d{3,6}|t\d{3})(?:-[a-z0-9-]+)?\.json$/.test(name)) {
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
  if (fileType === 'problems') {
    try {
      let problems = JSON.parse(rawContent);
      if (!Array.isArray(problems)) throw new Error('题目索引必须是数组');
      const hasAdminSession = Boolean(readCookie(request, ADMIN_SESSION_COOKIE));
      let studentExtensions = new Map();
      if (hasAdminSession) {
        const authError = await requireAdmin(request, env);
        if (authError) return authError;
      } else {
        problems = problems.filter(problem => problem.status !== 'draft');
        const username = await studentSessionUsername(request, env);
        studentExtensions = await studentExtensionMap(env, username, group);
        const now = Date.now();
        for (const problem of problems) {
          const effective = availabilityWithExtension(
            problem.availability,
            studentExtensions.get(`problem:${problem.id}`),
            now,
          );
          problem.availability = publicAvailability(effective, now);
        }
      }
      if (env.OJ_DB) {
        const statsResult = await env.OJ_DB.prepare(`
          SELECT problem_id, COUNT(*) AS total,
                 SUM(CASE WHEN passed = 1 THEN 1 ELSE 0 END) AS accepted
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
          const accepted = Number(problemStats?.accepted || 0);
          problem.submitCount = total;
          problem.acceptRate = total > 0 ? `${Math.round((accepted / total) * 100)}%` : '0%';
        }
      }
      return jsonResponse(problems);
    } catch (error) {
      console.error('题目列表读取失败:', error);
      return jsonResponse({ error: '题目列表格式不正确' }, 500);
    }
  }

  if (fileType === 'problem') {
    let problem;
    try {
      problem = JSON.parse(rawContent);
    } catch {
      return jsonResponse({ error: '题目文件格式不正确' }, 500);
    }

    const hasAdminSession = Boolean(readCookie(request, ADMIN_SESSION_COOKIE));
    if (hasAdminSession) {
      const authError = await requireAdmin(request, env);
      if (authError) return authError;
      const hiddenProblem = await readHiddenProblem(problem.id, env, group);
      if (!hiddenProblem || !Array.isArray(hiddenProblem.testCases)) {
        return jsonResponse({ error: '隐藏测试数据不存在' }, 503);
      }
      problem.testCases = hiddenProblem.testCases;
    } else {
      if (problem.status === 'draft') return jsonResponse({ error: '题目不存在或尚未发布' }, 404);
      const username = await studentSessionUsername(request, env);
      const effectiveAvailability = await studentAvailability(
        problem.availability, 'problem', group, problem.id, username, env,
      );
      const timing = availabilityState(effectiveAvailability);
      if (timing.state === 'ended') {
        const policy = problem.availability?.afterEndView || 'none';
        const canView = policy === 'all' || (policy === 'authorized' && await isManagedStudent(env, username));
        if (!canView) return jsonResponse({ error: '这道题已经结束且未开放观看', code: 'VIEW_CLOSED', timing }, 403);
      }
      problem.availability = effectiveAvailability;
      if (username && timing.windowStart && env.OJ_DB) {
        const draft = await env.OJ_DB.prepare(`
          SELECT payload_json, status, updated_at FROM timed_drafts
          WHERE resource_type = 'problem' AND group_name = ?1 AND resource_id = ?2
            AND resource_version = 1 AND username = ?3 AND window_start = ?4
        `).bind(group, problem.id, username, timing.windowStart).first();
        if (draft) {
          try { problem.timedDraft = { ...JSON.parse(draft.payload_json), status: draft.status, updatedAt: Number(draft.updated_at) }; } catch { /* 忽略损坏草稿 */ }
        }
      }
      // 学生只能读取公开题面，隐藏测试点只保存在 KV 中。
      delete problem.testCases;
    }

    problem.group = group;
    problem.availability = publicAvailability(problem.availability);
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
  const examId = body.examId == null ? '' : normalizeExamId(body.examId);
  if (problemId && !/^(?:P\d{3,6}|T\d{3})$/.test(problemId)) {
    return jsonResponse({ error: '题号格式不正确' }, 400);
  }
  if (body.examId != null && !examId) return jsonResponse({ error: '试卷编号格式不正确' }, 400);
  if (problemId && examId) return jsonResponse({ error: '一次只能记录一种内容的浏览' }, 400);
  if (examId) {
    const exam = await env.OJ_DB.prepare(`
      SELECT 1 AS found FROM exam_papers
      WHERE id = ?1 AND group_name = ?2 AND status = 'published'
    `).bind(examId, group).first();
    if (!exam) return jsonResponse({ error: '试卷不存在或尚未发布' }, 404);
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

  if (examId) {
    statements.push(env.OJ_DB.prepare(`
      INSERT INTO analytics_exam_visitors
        (group_name, exam_id, visitor_hash, first_seen, last_seen)
      VALUES (?1, ?2, ?3, ?4, ?4)
      ON CONFLICT(group_name, exam_id, visitor_hash)
      DO UPDATE SET last_seen = excluded.last_seen
    `).bind(group, examId, visitorHash, now));
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
    id: Number(row.id),
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
  const hasAdminSession = Boolean(readCookie(request, ADMIN_SESSION_COOKIE));
  if (hasAdminSession) {
    const authError = await requireAdmin(request, env);
    if (authError) return authError;
    const result = await env.OJ_DB.prepare(`
      SELECT id, username, problem_id, passed, passed_tests, total_tests,
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
  const authError = await requireStudentAccess(request, env, username);
  if (authError) return authError;
  const result = await env.OJ_DB.prepare(`
    SELECT id, username, problem_id, passed, passed_tests, total_tests,
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
  const rawError = compileOutput || stderr || message ||
    (accepted ? '' : statusText);
  const outputLimitExceeded = /file size limit exceeded|sigxfsz/i.test(
    `${rawError}\n${statusText}\n${data.signal || ''}`
  );
  const error = outputLimitExceeded
    ? '程序输出过多，已被安全终止。请检查是否未填写自定义输入、输入读取失败，或循环无法结束。'
    : rawError;
  const reportedExitCode = Number(data.exit_code);

  return jsonResponse({
    output: stdout,
    error,
    exitCode: Number.isInteger(reportedExitCode)
      ? reportedExitCode
      : (accepted ? 0 : 1),
    compileError,
    time: data.time ? Math.round(Number(data.time) * 1000) : null,
    memory: data.memory ?? null,
    signal: data.signal ?? null,
    status: statusText,
    code: outputLimitExceeded ? 'OUTPUT_LIMIT_EXCEEDED' : undefined,
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
    status: problem.status,
    availability: problem.availability,
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
  const previousHiddenProblem = await readHiddenProblem(problem.id, env, group);
  const testCasesChanged = JSON.stringify(previousHiddenProblem?.testCases || [])
    !== JSON.stringify(problem.testCases);
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
  indexItem.status = problem.status;
  indexItem.availability = problem.availability;
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

  const availabilityChanged = JSON.stringify(previousHiddenProblem?.availability || { enabled: false, windows: [], afterEndView: 'none' })
    !== JSON.stringify(problem.availability);
  if (availabilityChanged && env.OJ_DB) {
    await env.OJ_DB.prepare(`
      DELETE FROM timed_drafts
      WHERE resource_type = 'problem' AND group_name = ?1 AND resource_id = ?2
        AND status IN ('active', 'queued', 'failed')
    `).bind(group, problem.id).run();
  }

  const rejudge = testCasesChanged
    ? await enqueueProblemRejudges(env, group, problem.id)
    : { queued: false, problemSubmissions: 0, examSubmissions: 0 };
  return jsonResponse({ success: true, problem: indexItem, testCasesChanged, rejudge });
}

async function enqueueProblemRejudges(env, group, problemId) {
  if (!env.OJ_DB) return { queued: false, problemSubmissions: 0, examSubmissions: 0 };
  const storedId = storedProblemId(group, problemId);
  const [problemRows, examRows] = await env.OJ_DB.batch([
    env.OJ_DB.prepare('SELECT id FROM submissions WHERE problem_id = ?1').bind(storedId),
    env.OJ_DB.prepare(`
      SELECT s.id, v.structure_json
      FROM exam_submissions s
      JOIN exam_papers p ON p.id = s.exam_id
      JOIN exam_versions v ON v.exam_id = s.exam_id AND v.version = s.exam_version
      WHERE p.group_name = ?1 AND s.is_preview = 0 AND s.is_final = 1
    `).bind(group),
  ]);
  const examSubmissionIds = [];
  for (const row of examRows.results || []) {
    try {
      const structure = JSON.parse(row.structure_json);
      const referenced = structure.questions?.some(question => question.parts?.some(part =>
        part.type === 'programming' && part.problemId === problemId));
      if (referenced) examSubmissionIds.push(Number(row.id));
    } catch {
      // 损坏的历史试卷结构留给管理员人工处理，不阻塞题目更新。
    }
  }
  const now = Date.now();
  const statements = [];
  const enqueue = (kind, submissionId) => statements.push(env.OJ_DB.prepare(`
    INSERT INTO rejudge_queue (
      submission_kind, submission_id, group_name, problem_id,
      status, attempts, requested_at, updated_at, last_error
    ) VALUES (?1, ?2, ?3, ?4, 'pending', 0, ?5, ?5, '')
    ON CONFLICT(submission_kind, submission_id, problem_id) DO UPDATE SET
      group_name = excluded.group_name,
      status = 'pending', attempts = 0,
      requested_at = excluded.requested_at,
      updated_at = excluded.updated_at,
      last_error = ''
  `).bind(kind, submissionId, group, problemId, now));
  for (const row of problemRows.results || []) enqueue('problem', Number(row.id));
  for (const id of examSubmissionIds) enqueue('exam', id);
  for (let index = 0; index < statements.length; index += 100) {
    await env.OJ_DB.batch(statements.slice(index, index + 100));
  }
  return {
    queued: statements.length > 0,
    problemSubmissions: (problemRows.results || []).length,
    examSubmissions: examSubmissionIds.length,
  };
}

async function processNextRejudgeJob(env) {
  if (!env.OJ_DB) return;
  const now = Date.now();
  const staleBefore = now - 10 * 60 * 1000;
  const job = await env.OJ_DB.prepare(`
    SELECT * FROM rejudge_queue
    WHERE attempts < 5
      AND (status = 'pending' OR (status = 'processing' AND updated_at < ?1))
    ORDER BY requested_at ASC, id ASC
    LIMIT 1
  `).bind(staleBefore).first();
  if (!job) return;
  const claimed = await env.OJ_DB.prepare(`
    UPDATE rejudge_queue
    SET status = 'processing', attempts = attempts + 1, updated_at = ?2
    WHERE id = ?1 AND attempts < 5
      AND (status = 'pending' OR (status = 'processing' AND updated_at < ?3))
  `).bind(Number(job.id), now, staleBefore).run();
  if (!claimed.meta?.changes) return;

  try {
    if (job.submission_kind === 'problem') await rejudgeProblemSubmission(job, env);
    else if (job.submission_kind === 'exam') await rejudgeExamSubmission(job, env);
    else throw new Error('未知重判任务类型');
    await env.OJ_DB.prepare(`
      DELETE FROM rejudge_queue
      WHERE id = ?1 AND requested_at = ?2 AND status = 'processing'
    `).bind(Number(job.id), Number(job.requested_at)).run();
  } catch (error) {
    const attempts = Number(job.attempts || 0) + 1;
    await env.OJ_DB.prepare(`
      UPDATE rejudge_queue
      SET status = ?2, updated_at = ?3, last_error = ?4
      WHERE id = ?1 AND requested_at = ?5 AND status = 'processing'
    `).bind(
      Number(job.id), attempts >= 5 ? 'failed' : 'pending', Date.now(),
      String(error?.message || error || '重判失败').slice(0, 500),
      Number(job.requested_at),
    ).run();
    console.error(`自动重判任务 ${job.id} 失败:`, error);
  }
}

async function processNextTimedSubmission(env) {
  if (!env.OJ_DB) return;
  const now = Date.now();
  // 学生端在 30 秒时主动排队，后台仍保留到 60 秒接收在途草稿；此处是断网、关页等情况的服务端兜底。
  await env.OJ_DB.prepare(`
    UPDATE timed_drafts SET status = 'queued', queued_at = ?1
    WHERE status = 'active' AND window_end + ?2 <= ?1
  `).bind(now, TIMED_GRACE_MS).run();
  const draft = await env.OJ_DB.prepare(`
    SELECT * FROM timed_drafts WHERE status = 'queued'
    ORDER BY queued_at ASC, updated_at ASC LIMIT 1
  `).first();
  if (!draft) return;
  const keyBindings = [
    draft.resource_type, draft.group_name, draft.resource_id, Number(draft.resource_version),
    draft.username, Number(draft.window_start),
  ];
  try {
    const payload = JSON.parse(draft.payload_json);
    if (draft.resource_type === 'problem') {
      const currentProblem = await readHiddenProblem(draft.resource_id, env, draft.group_name);
      let windowStillValid = currentProblem?.availability?.windows?.some(item =>
        Number(item.start) === Number(draft.window_start) && Number(item.end) === Number(draft.window_end));
      if (!windowStillValid) {
        const extension = await env.OJ_DB.prepare(`
          SELECT 1 AS found FROM timed_extensions
          WHERE resource_type = 'problem' AND group_name = ?1 AND resource_id = ?2
            AND username = ?3 AND starts_at = ?4 AND ends_at = ?5
        `).bind(
          draft.group_name, draft.resource_id, draft.username,
          Number(draft.window_start), Number(draft.window_end),
        ).first();
        windowStillValid = Boolean(extension);
      }
      if (!windowStillValid) throw new Error('题目答题时间已经被管理员修改，旧草稿不再自动提交');
      await runJudgeSubmission({
        username: draft.username,
        problemId: draft.resource_id,
        group: draft.group_name,
        language: payload.language,
        code: payload.code,
      }, env, null, true, true);
    } else {
      const currentExam = await readExamRecord(env, draft.resource_id);
      if (!currentExam || Number(currentExam.version) !== Number(draft.resource_version)) {
        throw new Error('套卷版本已经更新，旧草稿不再自动提交');
      }
      const currentPaper = parseExamRecord(currentExam);
      let windowStillValid = currentPaper.availability?.windows?.some(item =>
        Number(item.start) === Number(draft.window_start) && Number(item.end) === Number(draft.window_end));
      if (!windowStillValid) {
        const extension = await env.OJ_DB.prepare(`
          SELECT 1 AS found FROM timed_extensions
          WHERE resource_type = 'exam' AND group_name = ?1 AND resource_id = ?2
            AND username = ?3 AND starts_at = ?4 AND ends_at = ?5
        `).bind(
          draft.group_name, draft.resource_id, draft.username,
          Number(draft.window_start), Number(draft.window_end),
        ).first();
        windowStillValid = Boolean(extension);
      }
      if (!windowStillValid) throw new Error('套卷答题时间已经被管理员修改或撤销，旧草稿不再自动提交');
      const response = await handleStudentExamSubmit({
        username: draft.username,
        examId: draft.resource_id,
        group: draft.group_name,
        answers: payload,
      }, env, { bypassTiming: true });
      if (!response.ok) {
        const failure = await response.json().catch(() => ({}));
        throw new Error(failure.error || `自动提交失败 (${response.status})`);
      }
    }
    await env.OJ_DB.prepare(`
      UPDATE timed_drafts SET status = 'submitted', submitted_at = ?7, payload_json = '{}', last_error = ''
      WHERE resource_type = ?1 AND group_name = ?2 AND resource_id = ?3
        AND resource_version = ?4 AND username = ?5 AND window_start = ?6
    `).bind(...keyBindings, Date.now()).run();
  } catch (error) {
    await env.OJ_DB.prepare(`
      UPDATE timed_drafts SET status = 'failed', last_error = ?7
      WHERE resource_type = ?1 AND group_name = ?2 AND resource_id = ?3
        AND resource_version = ?4 AND username = ?5 AND window_start = ?6
    `).bind(...keyBindings, String(error?.message || error).slice(0, 1000)).run();
  }
}

async function rejudgeProblemSubmission(job, env) {
  const row = await env.OJ_DB.prepare(`
    SELECT id, username, language, code
    FROM submissions WHERE id = ?1
  `).bind(Number(job.submission_id)).first();
  if (!row) return;
  const judged = await runJudgeSubmission({
    username: row.username,
    problemId: job.problem_id,
    group: job.group_name,
    language: row.language,
    code: decodeBase64Utf8(String(row.code || '')),
  }, env, null, false, true);
  await env.OJ_DB.prepare(`
    UPDATE submissions
    SET passed = ?2, passed_tests = ?3, total_tests = ?4, total_time = ?5
    WHERE id = ?1
  `).bind(
    Number(row.id), judged.passed ? 1 : 0, judged.passedTests,
    judged.totalTests, judged.totalTime,
  ).run();
}

async function rejudgeExamSubmission(job, env) {
  const row = await env.OJ_DB.prepare(`
    SELECT s.*, v.structure_json, p.title, p.group_name, p.result_policy
    FROM exam_submissions s
    JOIN exam_versions v ON v.exam_id = s.exam_id AND v.version = s.exam_version
    JOIN exam_papers p ON p.id = s.exam_id
    WHERE s.id = ?1 AND s.is_preview = 0 AND s.is_final = 1
  `).bind(Number(job.submission_id)).first();
  if (!row) return;
  const paper = JSON.parse(row.structure_json);
  const answers = JSON.parse(row.answers_json);
  const grading = JSON.parse(row.grading_json);
  const partResults = Array.isArray(grading.partResults) ? grading.partResults : [];
  let matched = 0;
  for (const question of paper.questions || []) {
    for (const part of question.parts || []) {
      if (part.type !== 'programming' || part.problemId !== job.problem_id) continue;
      matched += 1;
      const answer = answers[part.id] || {};
      const code = String(answer.code || '');
      const judged = code.trim() ? await runJudgeSubmission({
        username: row.username,
        problemId: part.problemId,
        group: job.group_name,
        language: String(answer.language || 'c'),
        code,
      }, env, null, false, true) : null;
      const index = partResults.findIndex(result => result.partId === part.id);
      const existing = index >= 0 ? partResults[index] : {};
      const updated = {
        ...existing,
        questionId: question.id,
        partId: part.id,
        type: 'programming',
        maxScore: Number(part.points || 0),
        status: judged?.passed ? 'correct' : 'incorrect',
        autoScore: judged?.passed ? Number(part.points || 0) : 0,
        manualScore: Number(existing.manualScore || 0),
        feedback: '',
        judge: judged ? {
          passed: judged.passed,
          passedTests: judged.passedTests,
          totalTests: judged.totalTests,
          totalTime: judged.totalTime,
        } : null,
      };
      if (index >= 0) partResults[index] = updated;
      else partResults.push(updated);
    }
  }
  if (!matched) return;
  const scores = calculateExamScores(paper, partResults);
  const now = Date.now();
  const statements = [env.OJ_DB.prepare(`
    UPDATE exam_submissions
    SET grading_json = ?2, auto_score = ?3, manual_score = ?4,
        total_score = ?5, graded_count = ?6, total_parts = ?7,
        grading_status = ?8, updated_at = ?9
    WHERE id = ?1
  `).bind(
    Number(row.id), JSON.stringify({ ...grading, partResults }),
    scores.autoScore, scores.manualScore, scores.totalScore,
    scores.gradedCount, scores.totalParts, scores.gradingStatus, now,
  )];
  const completionMessage = examCompletionMessageStatement(env, {
    examId: row.exam_id, username: row.username, title: row.title,
    group: row.group_name, resultPolicy: row.result_policy,
    gradingStatus: scores.gradingStatus, createdAt: now, submissionId: Number(row.id),
  });
  if (completionMessage) statements.push(completionMessage);
  await env.OJ_DB.batch(statements);
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
  if (!/^(?:P\d{3,6}|T\d{3})$/.test(id)) {
    return { error: '题号格式应为 P006，套卷题应为 T020 这样的格式' };
  }

  const difficulty = ['easy', 'medium', 'hard'].includes(input.difficulty)
    ? input.difficulty
    : 'easy';
  const file = String(requestedFile || `${id.toLowerCase()}.json`).trim().toLowerCase();
  if (!/^(?:p\d{3,6}|t\d{3})(?:-[a-z0-9-]+)?\.json$/.test(file)) {
    return { error: '文件名格式应为 p006-example.json 或 t020.json' };
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
  const availability = validateAvailability(input.availability);
  if (availability.error) return { error: availability.error };
  let pythonFunction = null;
  if (pythonJudgeMode === 'function') {
    const functionValidation = normalizePythonFunctionSignature(input.pythonFunctionSignature);
    if (functionValidation.error) return { error: functionValidation.error };
    pythonFunction = functionValidation.pythonFunction;
  }
  const codeTemplates = {};
  if (input.codeTemplates !== undefined) {
    if (!input.codeTemplates || typeof input.codeTemplates !== 'object' || Array.isArray(input.codeTemplates)) {
      return { error: '默认代码模板格式不正确' };
    }
    for (const languageId of ['c', 'cpp', 'python']) {
      const template = input.codeTemplates[languageId];
      if (template === undefined || template === null || template === '') continue;
      if (typeof template !== 'string') return { error: `${languageId} 默认代码模板格式不正确` };
      if (template.length > 30000) return { error: `${languageId} 默认代码模板不能超过 30000 个字符` };
      if (template.trim()) codeTemplates[languageId] = template;
    }
  }

  const problem = {
    id,
    title: input.title.trim().slice(0, 100),
    difficulty,
    status: input.status === 'draft' ? 'draft' : 'published',
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
    availability,
    pythonJudgeMode,
    ...(Object.keys(codeTemplates).length ? { codeTemplates } : {}),
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
  if (!env.OJ_TESTS || !/^(?:P\d{3,6}|T\d{3})$/.test(String(problemId))) return null;
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
async function prepareJudgeSubmission(body, env, allowDraft = false) {
  const username = typeof body.username === 'string' ? body.username.trim() : '';
  const problemId = typeof body.problemId === 'string' ? body.problemId.trim().toUpperCase() : '';
  const language = typeof body.language === 'string' ? body.language.trim() : '';
  const script = typeof body.code === 'string' ? body.code : '';
  const languageId = SUBMISSION_LANGUAGE_IDS[language];
  if (body.group && !Object.hasOwn(GROUPS, body.group)) {
    throw judgeError('组别不正确', 400, 'INVALID_GROUP');
  }
  const group = normalizeGroup(body.group);

  if (!username || username.length > 50 || !/^(?:P\d{3,6}|T\d{3})$/.test(problemId)
      || !Number.isInteger(languageId) || !script.trim() || script.length > 200000) {
    throw judgeError('提交内容格式不正确', 400, 'INVALID_SUBMISSION');
  }

  const problem = await readHiddenProblem(problemId, env, group);
  if (problem?.status === 'draft' && !allowDraft) {
    throw judgeError('题目不存在或尚未发布', 404, 'PROBLEM_NOT_PUBLISHED');
  }
  if (!allowDraft) {
    const effectiveAvailability = await studentAvailability(
      problem?.availability, 'problem', group, problemId, username, env,
    );
    const timing = availabilityState(effectiveAvailability);
    if (!timing.canEdit) {
      const paused = timing.state === 'paused';
      throw judgeError(
        timing.state === 'upcoming' ? '尚未到答题开放时间'
          : paused ? '当前答题时段已暂停，请等待下一时段开始'
          : '答题时间已经结束，答案已冻结',
        timing.state === 'grace' ? 409 : 403,
        timing.state === 'upcoming' ? 'NOT_STARTED' : paused ? 'ANSWER_PAUSED' : 'ANSWER_CLOSED',
      );
    }
  }
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

async function runJudgeSubmission(body, env, onEvent, shouldPersist = true, allowDraft = false) {
  const prepared = await prepareJudgeSubmission(body, env, allowDraft);
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
    const effectiveAvailability = await studentAvailability(
      problem.availability, 'problem', group, problemId, username, env, result.timestamp,
    );
    const timing = availabilityState(effectiveAvailability, result.timestamp);
    if (env.OJ_DB && timing.state === 'active') {
      await env.OJ_DB.prepare(`
        UPDATE timed_drafts SET status = 'submitted', submitted_at = ?5, payload_json = '{}'
        WHERE resource_type = 'problem' AND group_name = ?1 AND resource_id = ?2
          AND resource_version = 1 AND username = ?3 AND window_start = ?4 AND status = 'active'
      `).bind(group, problemId, username, timing.windowStart, result.timestamp).run();
    }
  }

  return result;
}

async function handleJudgeSubmit(body, env, shouldPersist = true, allowDraft = false) {
  try {
    return jsonResponse(await runJudgeSubmission(body, env, null, shouldPersist, allowDraft));
  } catch (error) {
    return jsonResponse({ error: error.message, code: error.code || 'JUDGE_FAILED' }, error.status || 500);
  }
}

async function handleJudgeSubmitStream(body, env, shouldPersist = true, allowDraft = false) {
  const encoder = new TextEncoder();
  const readable = new ReadableStream({
    async start(controller) {
      const send = event => controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      try {
        const result = await runJudgeSubmission(body, env, send, shouldPersist, allowDraft);
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
  if (!/^(?:P\d{3,6}|T\d{3})$/.test(normalizedProblemId)
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
    const [result] = await env.OJ_DB.batch([
      env.OJ_DB.prepare(`
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
      ),
      env.OJ_DB.prepare(`
        DELETE FROM resubmission_requests
        WHERE group_name = ?1 AND problem_id = ?2 AND username = ?3
      `).bind(group, normalizedProblemId, displayUsername),
    ]);
    return jsonResponse({ success: true, id: result.meta?.last_row_id || null });
  } catch (error) {
    console.error('D1 保存提交失败:', error);
    return jsonResponse({ error: '提交记录保存失败', code: 'D1_WRITE_FAILED' }, 503);
  }
}

/**
 * 统一 JSON 响应（带 CORS 头）
 */
function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...CORS_HEADERS,
      ...extraHeaders,
    },
  });
}
