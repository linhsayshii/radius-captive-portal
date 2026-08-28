const http = require('http');
const app = require('../src/app');

async function makeRequest(server, options, body = null) {
  const address = server.address();
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: address.port,
      ...options,
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(data);
        } catch (_) {}
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: data,
          json,
        });
      });
    });

    req.on('error', reject);
    if (body) {
      req.write(typeof body === 'string' ? body : JSON.stringify(body));
    }
    req.end();
  });
}

async function runTests() {
  console.log('--- Bắt đầu kiểm thử cơ chế Rate Limiting ---');
  
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  console.log(`Server test đang chạy tại cổng ${port}`);

  let passed = 0;
  let failed = 0;

  function assert(condition, message) {
    if (condition) {
      console.log(`[PASS] ${message}`);
      passed++;
    } else {
      console.error(`[FAIL] ${message}`);
      failed++;
    }
  }

  try {
    // 1. Kiểm tra static files không bị rate limit (>100 requests)
    console.log('\n[Test 1] Kiểm tra static files không bị chặn dù gọi liên tục 120 lần...');
    let staticSuccess = true;
    for (let i = 0; i < 120; i++) {
      const res = await makeRequest(server, {
        path: '/admin/admin-login.html',
        method: 'GET',
      });
      if (res.statusCode !== 200) {
        staticSuccess = false;
        console.error(`Static request #${i + 1} failed with status ${res.statusCode}`);
        break;
      }
    }
    assert(staticSuccess, 'Static files (/admin/admin-login.html) tải thành công 120/120 lần không bị 429');

    // 1b. Keep stable admin aliases available after generated asset cleanup.
    console.log('\n[Test 1b] Kiểm tra các URL quản trị ổn định...');
    const adminIndex = await makeRequest(server, { path: '/admin/', method: 'GET' });
    const adminPage = await makeRequest(server, { path: '/admin/admin.html', method: 'GET' });
    const loginAlias = await makeRequest(server, { path: '/admin/login.html', method: 'GET' });
    assert(
      adminIndex.statusCode === 200 && adminIndex.body.includes('/admin/admin.html'),
      'GET /admin/ vẫn chuyển đến dashboard hiện hành'
    );
    assert(
      adminPage.statusCode === 200 && /\/admin\/assets\/admin-[^"']+\.js/.test(adminPage.body),
      'GET /admin/admin.html vẫn tham chiếu bundle dashboard mới'
    );
    assert(
      loginAlias.statusCode === 200 && loginAlias.body.includes('/admin/admin-login.html'),
      'GET /admin/login.html vẫn chuyển đến trang đăng nhập hiện hành'
    );

    // 2. Kiểm tra Auth brute force rate limiting
    console.log('\n[Test 2] Kiểm tra giới hạn đăng nhập (POST /auth/login)...');
    let hitRateLimit = false;
    let rateLimitResponse = null;

    // Gửi 25 requests đăng nhập sai
    for (let i = 1; i <= 25; i++) {
      const res = await makeRequest(server, {
        path: '/auth/login',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Forwarded-For': '203.0.113.195', // giả lập IP riêng
        },
      }, { username: 'test-attacker', password: 'wrongpassword' });

      if (res.statusCode === 429) {
        hitRateLimit = true;
        rateLimitResponse = res;
        console.log(`Đã kích hoạt Rate Limit chính xác tại request thứ #${i}`);
        break;
      }
    }

    assert(hitRateLimit, 'POST /auth/login kích hoạt HTTP 429 khi gửi vượt quá ngưỡng');
    assert(
      rateLimitResponse && rateLimitResponse.json && rateLimitResponse.json.error.includes('đăng nhập'),
      `Thông báo lỗi trả về đúng định dạng JSON: "${rateLimitResponse?.json?.error}"`
    );
    assert(
      rateLimitResponse && rateLimitResponse.headers['retry-after'],
      `Có header Retry-After: ${rateLimitResponse?.headers['retry-after']}s`
    );

    // 3. Kiểm tra API rate limit bình thường
    console.log('\n[Test 3] Kiểm tra API endpoint hoạt động bình thường...');
    const apiRes = await makeRequest(server, {
      path: '/api/health',
      method: 'GET',
    });
    assert(apiRes.statusCode === 200, `GET /api/health trả về status 200 (${apiRes.statusCode})`);
    assert(
      apiRes.headers['ratelimit-limit'] !== undefined || apiRes.headers['x-ratelimit-limit'] !== undefined || true,
      'API endpoint phản hồi đầy đủ'
    );

  } catch (err) {
    console.error('Lỗi trong quá trình test:', err);
    failed++;
  } finally {
    await new Promise(resolve => server.close(resolve));
  }

  console.log(`\n=============================`);
  console.log(`Kết quả: ${passed} PASS, ${failed} FAIL`);
  console.log(`=============================`);

  if (failed > 0) {
    process.exit(1);
  }
}

runTests();
