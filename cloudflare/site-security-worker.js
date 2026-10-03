const HTML_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' https: data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' https://api.jc-oj.online",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  'upgrade-insecure-requests',
].join('; ');

// The admin page can optionally talk to the local, loopback-only Claude grading
// helper. Keep this exception off student pages. Do not add
// upgrade-insecure-requests here: the helper deliberately serves plain HTTP on
// 127.0.0.1 and an upgrade to HTTPS would make the browser miss it.
const ADMIN_HTML_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' https: data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' https://api.jc-oj.online http://127.0.0.1:37841",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const RESPONSE_SECURITY_HEADERS = {
  // www 子域名仍由注册商 DNS 直连 GitHub，暂不把 HSTS 强制扩散到子域名。
  'Strict-Transport-Security': 'max-age=31536000',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'X-Permitted-Cross-Domain-Policies': 'none',
};

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.protocol !== 'https:') {
      url.protocol = 'https:';
      return new Response(null, {
        status: 308,
        headers: {
          Location: url.toString(),
          ...RESPONSE_SECURITY_HEADERS,
        },
      });
    }

    // Worker Route 下的 fetch(request) 会继续请求原站 GitHub Pages；
    // 页面内容、缓存与自动部署方式保持不变，只补充响应安全头。
    const originResponse = await fetch(request);
    const headers = new Headers(originResponse.headers);
    for (const [name, value] of Object.entries(RESPONSE_SECURITY_HEADERS)) {
      headers.set(name, value);
    }
    if ((headers.get('Content-Type') || '').toLowerCase().includes('text/html')) {
      const isAdminPage = url.pathname === '/admin.html' || url.pathname === '/admin';
      headers.set('Content-Security-Policy', isAdminPage ? ADMIN_HTML_CSP : HTML_CSP);
    }

    return new Response(originResponse.body, {
      status: originResponse.status,
      statusText: originResponse.statusText,
      headers,
    });
  },
};
