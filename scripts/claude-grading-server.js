#!/usr/bin/env node
'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const HOST = '127.0.0.1';
const PORT = 37841;
const ALLOWED_ORIGIN = 'https://jc-oj.online';
const MAX_BODY_BYTES = 12 * 1024 * 1024;
const MAX_RESULT_BYTES = 2 * 1024 * 1024;
const GRADING_TIMEOUT_MS = 20 * 60 * 1000;
let activeJob = null;

function responseHeaders(origin = '') {
  return {
    'Access-Control-Allow-Origin': origin === ALLOWED_ORIGIN ? ALLOWED_ORIGIN : ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-JC-OJ-Grading',
    'Access-Control-Allow-Private-Network': 'true',
    'Access-Control-Max-Age': '600',
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
  };
}

function sendJson(response, status, payload, origin = '') {
  const body = JSON.stringify(payload);
  response.writeHead(status, { ...responseHeaders(origin), 'Content-Length': Buffer.byteLength(body) });
  response.end(body);
}

function validPackage(payload) {
  if (!payload || payload.format !== 'jc-oj-claude-grading-v1' || !payload.exam?.id
      || !payload.partId || !Array.isArray(payload.groups) || payload.groups.length < 1 || payload.groups.length > 100) return false;
  let submissionCount = 0;
  for (const group of payload.groups) {
    if (!group || !group.question || !group.part || !Array.isArray(group.submissions)
        || !['fill_blank', 'short_answer'].includes(group.part.type)
        || String(group.question.description || '').length > 20000
        || String(group.part.prompt || '').length > 20000
        || String(group.part.gradingGuide || '').length > 12000) return false;
    for (const submission of group.submissions) {
      submissionCount += 1;
      if (!Number.isInteger(Number(submission?.submissionId))
          || !Number.isInteger(Number(submission?.sourceUpdatedAt))
          || String(submission?.answer || '').length > 30000) return false;
    }
  }
  return submissionCount >= 1 && submissionCount <= 1000;
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    request.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      if (!tooLarge) chunks.push(chunk);
    });
    request.on('end', () => tooLarge
      ? reject(new Error('批改数据超过 12 MB'))
      : resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function runClaude(payload) {
  return new Promise((resolve, reject) => {
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-oj-claude-'));
    const inputPath = path.join(temporaryDirectory, 'input.json');
    const outputPath = path.join(temporaryDirectory, 'results.json');
    fs.writeFileSync(inputPath, JSON.stringify(payload), { encoding: 'utf8', mode: 0o600 });
    const child = spawn(process.execPath, [
      path.join(__dirname, 'claude-grade.js'),
      inputPath,
      '--output', outputPath,
    ], {
      cwd: __dirname,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    activeJob = child;
    let stdout = '';
    let stderr = '';
    let outputTooLarge = false;
    const appendOutput = (current, chunk) => {
      const next = current + chunk.toString('utf8');
      if (Buffer.byteLength(next) > MAX_RESULT_BYTES) {
        outputTooLarge = true;
        child.kill();
        return current;
      }
      return next;
    };
    child.stdout.on('data', chunk => { stdout = appendOutput(stdout, chunk); });
    child.stderr.on('data', chunk => { stderr = appendOutput(stderr, chunk); });
    const timeout = setTimeout(() => child.kill(), GRADING_TIMEOUT_MS);
    child.on('error', error => {
      clearTimeout(timeout);
      activeJob = null;
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
      reject(error);
    });
    child.on('close', code => {
      clearTimeout(timeout);
      activeJob = null;
      try {
        if (outputTooLarge) throw new Error('Claude 输出超过安全限制');
        if (code !== 0) throw new Error((stderr || stdout || `批改进程退出码 ${code}`).trim());
        const stat = fs.statSync(outputPath);
        if (stat.size > MAX_RESULT_BYTES) throw new Error('Claude 结果文件超过 2 MB');
        const result = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
        if (result?.format !== 'jc-oj-claude-grading-results-v1' || !Array.isArray(result.results)) {
          throw new Error('Claude 结果格式不正确');
        }
        resolve(result);
      } catch (error) {
        reject(error);
      } finally {
        fs.rmSync(temporaryDirectory, { recursive: true, force: true });
      }
    });
  });
}

const server = http.createServer(async (request, response) => {
  const origin = String(request.headers.origin || '');
  if (origin !== ALLOWED_ORIGIN) {
    sendJson(response, 403, { error: '不允许的请求来源' });
    return;
  }
  if (request.method === 'OPTIONS') {
    response.writeHead(204, responseHeaders(origin));
    response.end();
    return;
  }
  if (request.method === 'GET' && request.url === '/health') {
    sendJson(response, 200, { ok: true, busy: Boolean(activeJob) }, origin);
    return;
  }
  if (request.method !== 'POST' || request.url !== '/grade') {
    sendJson(response, 404, { error: '接口不存在' }, origin);
    return;
  }
  if (request.headers['x-jc-oj-grading'] !== '1') {
    sendJson(response, 400, { error: '缺少批改请求标记' }, origin);
    return;
  }
  if (activeJob) {
    sendJson(response, 409, { error: 'Claude 正在批改另一批答案，请稍后重试' }, origin);
    return;
  }
  const declaredLength = Number(request.headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    sendJson(response, 413, { error: '批改数据超过 12 MB' }, origin);
    return;
  }
  try {
    const payload = JSON.parse(await readRequestBody(request));
    if (!validPackage(payload)) {
      sendJson(response, 400, { error: '批改包格式或数量不正确' }, origin);
      return;
    }
    response.once('close', () => {
      if (!response.writableEnded && activeJob) activeJob.kill();
    });
    const result = await runClaude(payload);
    sendJson(response, 200, result, origin);
  } catch (error) {
    if (!response.headersSent) sendJson(response, 500, { error: String(error.message || error).slice(0, 1000) }, origin);
  }
});

server.requestTimeout = 0;
server.headersTimeout = 10000;
server.listen(PORT, HOST, () => {
  console.log(`机创 OJ Claude 批改助手已启动：http://${HOST}:${PORT}`);
  console.log('请保持此窗口开启，然后回到管理端点击“检测助手”或“Claude 一键批改”。');
  console.log('按 Ctrl+C 可以停止助手。');
});

