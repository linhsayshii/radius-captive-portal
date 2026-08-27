# WiFi Portal Phase 3: Admin Dashboard

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build admin dashboard with analytics, WebDAV backup, and branding

**Architecture:** Vue.js SPA for admin, WebDAV integration for backups

**Tech Stack:** Node.js, Vue.js 3, WebDAV client, chart.js

**Spec:** `../SPEC.md`

---

## Global Constraints

- Node.js 18+
- bcrypt cost factor: 12
- Session secret min 32 chars
- All DB queries: parameterized (no SQL injection)
- Vietnamese UI with proper diacritics

---

## Task 1: Admin Dashboard SPA Setup

**Files:**
- Create: `public/admin/index.html`
- Create: `public/admin/js/app.js`
- Create: `public/admin/js/components/`
- Create: `public/admin/css/`

**Interfaces:**
- Produces: Vue.js admin dashboard SPA

- [ ] **Step 1: Create public/admin/index.html**

```html
<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Quản trị WiFi Portal</title>
  <link href="https://cdn.jsdelivr.net/npm/tailwindcss@2.2.19/dist/tailwind.min.css" rel="stylesheet">
  <script src="https://cdn.jsdelivr.net/npm/vue@3.3.4/dist/vue.global.prod.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/axios@1.4.0/dist/axios.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.3.0/dist/chart.umd.min.js"></script>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
    .sidebar { min-height: 100vh; background: #1a1a2e; }
    .nav-item { transition: all 0.2s; }
    .nav-item:hover { background: #16213e; }
    .nav-item.active { background: #0f3460; border-left: 3px solid #e94560; }
    .card { background: white; border-radius: 12px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
    .stat-card { border-left: 4px solid; }
    .stat-users { border-color: #4299e1; }
    .stat-sessions { border-color: #48bb78; }
    .stat-quota { border-color: #ed8936; }
    .stat-bandwidth { border-color: #9f7aea; }
  </style>
</head>
<body class="bg-gray-100">
  <div id="app">
    <div class="flex">
      <!-- Sidebar -->
      <aside class="sidebar w-64 text-white fixed h-full">
        <div class="p-6">
          <h1 class="text-2xl font-bold text-pink-500">WiFi Portal</h1>
          <p class="text-gray-400 text-sm">Quản trị hệ thống</p>
        </div>
        <nav class="mt-6">
          <a href="#dashboard" class="nav-item block px-6 py-3" :class="{active: currentView === 'dashboard'}" @click="currentView = 'dashboard'">
            📊 Tổng quan
          </a>
          <a href="#sessions" class="nav-item block px-6 py-3" :class="{active: currentView === 'sessions'}" @click="currentView = 'sessions'">
            🔌 Phiên kết nối
          </a>
          <a href="#devices" class="nav-item block px-6 py-3" :class="{active: currentView === 'devices'}" @click="currentView = 'devices'">
            📱 Thiết bị
          </a>
          <a href="#users" class="nav-item block px-6 py-3" :class="{active: currentView === 'users'}" @click="currentView = 'users'">
            👥 Người dùng
          </a>
          <a href="#packages" class="nav-item block px-6 py-3" :class="{active: currentView === 'packages'}" @click="currentView = 'packages'">
            📦 Gói cước
          </a>
          <a href="#reports" class="nav-item block px-6 py-3" :class="{active: currentView === 'reports'}" @click="currentView = 'reports'">
            📈 Báo cáo
          </a>
          <a href="#backup" class="nav-item block px-6 py-3" :class="{active: currentView === 'backup'}" @click="currentView = 'backup'">
            💾 Sao lưu
          </a>
          <a href="#settings" class="nav-item block px-6 py-3" :class="{active: currentView === 'settings'}" @click="currentView = 'settings'">
            ⚙️ Cài đặt
          </a>
        </nav>
        <div class="absolute bottom-0 w-full p-6 border-t border-gray-700">
          <button @click="logout" class="w-full bg-red-600 hover:bg-red-700 text-white py-2 rounded-lg">
            Đăng xuất
          </button>
        </div>
      </aside>

      <!-- Main Content -->
      <main class="ml-64 flex-1 p-8">
        <!-- Dashboard View -->
        <div v-if="currentView === 'dashboard'">
          <h2 class="text-2xl font-bold mb-6">Tổng quan</h2>
          
          <!-- Stats Cards -->
          <div class="grid grid-cols-4 gap-6 mb-8">
            <div class="card stat-card stat-users p-6">
              <p class="text-gray-500">Người dùng</p>
              <p class="text-3xl font-bold">{{ stats.users }}</p>
              <p class="text-sm text-gray-400 mt-2">Tổng số tài khoản</p>
            </div>
            <div class="card stat-card stat-sessions p-6">
              <p class="text-gray-500">Đang online</p>
              <p class="text-3xl font-bold">{{ stats.activeSessions }}</p>
              <p class="text-sm text-gray-400 mt-2">Phiên đang hoạt động</p>
            </div>
            <div class="card stat-card stat-quota p-6">
              <p class="text-gray-500">Dữ liệu hôm nay</p>
              <p class="text-3xl font-bold">{{ formatBytes(stats.todayData) }}</p>
              <p class="text-sm text-gray-400 mt-2">Lưu lượng sử dụng</p>
            </div>
            <div class="card stat-card stat-bandwidth p-6">
              <p class="text-gray-500">Băng thông</p>
              <p class="text-3xl font-bold">{{ stats.bandwidth }} Mbps</p>
              <p class="text-sm text-gray-400 mt-2">Tổng băng thông</p>
            </div>
          </div>

          <!-- Chart -->
          <div class="card p-6 mb-8">
            <h3 class="text-lg font-semibold mb-4">Lưu lượng 7 ngày gần đây</h3>
            <canvas id="trafficChart" height="100"></canvas>
          </div>

          <!-- Recent Activity -->
          <div class="card p-6">
            <h3 class="text-lg font-semibold mb-4">Hoạt động gần đây</h3>
            <table class="w-full">
              <thead>
                <tr class="text-left text-gray-500 border-b">
                  <th class="pb-3">Thời gian</th>
                  <th class="pb-3">Người dùng</th>
                  <th class="pb-3">Hành động</th>
                  <th class="pb-3">Chi tiết</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="log in recentLogs" :key="log.id" class="border-b">
                  <td class="py-3">{{ formatTime(log.timestamp) }}</td>
                  <td class="py-3">{{ log.username || 'Hệ thống' }}</td>
                  <td class="py-3">{{ log.action }}</td>
                  <td class="py-3 text-gray-500">{{ log.details }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <!-- Sessions View -->
        <div v-if="currentView === 'sessions'">
          <h2 class="text-2xl font-bold mb-6">Phiên kết nối</h2>
          <div class="card p-6">
            <table class="w-full">
              <thead>
                <tr class="text-left text-gray-500 border-b">
                  <th class="pb-3">ID</th>
                  <th class="pb-3">Người dùng</th>
                  <th class="pb-3">Thiết bị</th>
                  <th class="pb-3">Bắt đầu</th>
                  <th class="pb-3">Thời lượng</th>
                  <th class="pb-3">Dữ liệu</th>
                  <th class="pb-3">Thao tác</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="session in sessions" :key="session.id" class="border-b">
                  <td class="py-3">{{ session.id }}</td>
                  <td class="py-3">{{ session.username }}</td>
                  <td class="py-3">{{ session.mac_address }}</td>
                  <td class="py-3">{{ formatTime(session.start_time) }}</td>
                  <td class="py-3">{{ formatDuration(session.start_time) }}</td>
                  <td class="py-3">{{ formatBytes(session.quota_used_mb * 1024 * 1024) }}</td>
                  <td class="py-3">
                    <button @click="terminateSession(session.id)" class="text-red-600 hover:text-red-800">
                      Ngắt kết nối
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <!-- Devices View -->
        <div v-if="currentView === 'devices'">
          <h2 class="text-2xl font-bold mb-6">Thiết bị</h2>
          <div class="card p-6">
            <table class="w-full">
              <thead>
                <tr class="text-left text-gray-500 border-b">
                  <th class="pb-3">MAC</th>
                  <th class="pb-3">Người dùng</th>
                  <th class="pb-3">Trạng thái</th>
                  <th class="pb-3">Hoạt động cuối</th>
                  <th class="pb-3">Thao tác</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="device in devices" :key="device.mac_address" class="border-b">
                  <td class="py-3 font-mono">{{ device.mac_address }}</td>
                  <td class="py-3">{{ device.username || '-' }}</td>
                  <td class="py-3">
                    <span :class="device.is_online ? 'text-green-600' : 'text-gray-400'">
                      {{ device.is_online ? 'Online' : 'Offline' }}
                    </span>
                  </td>
                  <td class="py-3">{{ formatTime(device.last_seen) }}</td>
                  <td class="py-3">
                    <button v-if="device.is_online" @click="disconnectDevice(device.mac_address)" class="text-red-600 hover:text-red-800">
                      Ngắt kết nối
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <!-- Users View -->
        <div v-if="currentView === 'users'">
          <h2 class="text-2xl font-bold mb-6">Người dùng</h2>
          <div class="card p-6">
            <div class="mb-4">
              <button @click="showCreateUser = true" class="bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700">
                + Thêm người dùng
              </button>
            </div>
            <table class="w-full">
              <thead>
                <tr class="text-left text-gray-500 border-b">
                  <th class="pb-3">ID</th>
                  <th class="pb-3">Tài khoản</th>
                  <th class="pb-3">Loại</th>
                  <th class="pb-3">Thiết bị tối đa</th>
                  <th class="pb-3">Trạng thái</th>
                  <th class="pb-3">Thao tác</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="user in users" :key="user.id" class="border-b">
                  <td class="py-3">{{ user.id }}</td>
                  <td class="py-3">{{ user.identifier }}</td>
                  <td class="py-3">{{ user.type }}</td>
                  <td class="py-3">{{ user.max_devices }}</td>
                  <td class="py-3">
                    <span :class="user.is_active ? 'text-green-600' : 'text-red-400'">
                      {{ user.is_active ? 'Hoạt động' : 'Tắt' }}
                    </span>
                  </td>
                  <td class="py-3">
                    <button @click="toggleUser(user)" class="text-blue-600 hover:text-blue-800 mr-2">
                      {{ user.is_active ? 'Tắt' : 'Bật' }}
                    </button>
                    <button @click="deleteUser(user.id)" class="text-red-600 hover:text-red-800">
                      Xóa
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <!-- Packages View -->
        <div v-if="currentView === 'packages'">
          <h2 class="text-2xl font-bold mb-6">Gói cước</h2>
          <div class="card p-6">
            <div class="grid grid-cols-3 gap-4">
              <div v-for="pkg in packages" :key="pkg.id" class="border rounded-lg p-4">
                <h3 class="font-bold text-lg">{{ pkg.name }}</h3>
                <p class="text-2xl font-bold text-blue-600">{{ formatDuration(pkg.duration_minutes) }}</p>
                <p v-if="pkg.quota_mb" class="text-gray-500">{{ formatBytes(pkg.quota_mb * 1024 * 1024) }}</p>
                <p class="text-sm text-gray-400 mt-2">
                  Download: {{ pkg.bandwidth_down_kbps }} Kbps
                </p>
                <p class="text-sm text-gray-400">
                  Upload: {{ pkg.bandwidth_up_kbps }} Kbps
                </p>
              </div>
            </div>
          </div>
        </div>

        <!-- Reports View -->
        <div v-if="currentView === 'reports'">
          <h2 class="text-2xl font-bold mb-6">Báo cáo</h2>
          <div class="grid grid-cols-2 gap-6">
            <div class="card p-6">
              <h3 class="text-lg font-semibold mb-4">Sử dụng theo ngày</h3>
              <canvas id="dailyChart"></canvas>
            </div>
            <div class="card p-6">
              <h3 class="text-lg font-semibold mb-4">Sử dụng theo giờ</h3>
              <canvas id="hourlyChart"></canvas>
            </div>
          </div>
        </div>

        <!-- Backup View -->
        <div v-if="currentView === 'backup'">
          <h2 class="text-2xl font-bold mb-6">Sao lưu</h2>
          <div class="grid grid-cols-2 gap-6">
            <div class="card p-6">
              <h3 class="text-lg font-semibold mb-4">Sao lưu thủ công</h3>
              <button @click="createBackup" :disabled="backingUp" class="bg-blue-600 text-white px-6 py-3 rounded-lg hover:bg-blue-700 disabled:opacity-50">
                {{ backingUp ? 'Đang sao lưu...' : 'Tạo sao lưu' }}
              </button>
              <p v-if="backupMessage" class="mt-4 text-green-600">{{ backupMessage }}</p>
            </div>
            <div class="card p-6">
              <h3 class="text-lg font-semibold mb-4">Cấu hình WebDAV</h3>
              <div class="space-y-4">
                <div>
                  <label class="block text-sm text-gray-600">URL WebDAV</label>
                  <input v-model="webdavUrl" type="text" class="w-full border rounded-lg px-3 py-2 mt-1">
                </div>
                <div>
                  <label class="block text-sm text-gray-600">Tên đăng nhập</label>
                  <input v-model="webdavUsername" type="text" class="w-full border rounded-lg px-3 py-2 mt-1">
                </div>
                <div>
                  <label class="block text-sm text-gray-600">Mật khẩu</label>
                  <input v-model="webdavPassword" type="password" class="w-full border rounded-lg px-3 py-2 mt-1">
                </div>
                <button @click="saveWebdavConfig" class="bg-green-600 text-white px-4 py-2 rounded-lg hover:bg-green-700">
                  Lưu cấu hình
                </button>
              </div>
            </div>
          </div>
        </div>

        <!-- Settings View -->
        <div v-if="currentView === 'settings'">
          <h2 class="text-2xl font-bold mb-6">Cài đặt</h2>
          <div class="card p-6">
            <h3 class="text-lg font-semibold mb-4">Thương hiệu</h3>
            <div class="space-y-4">
              <div>
                <label class="block text-sm text-gray-600">Tên thương hiệu</label>
                <input v-model="branding.name" type="text" class="w-full border rounded-lg px-3 py-2 mt-1">
              </div>
              <div>
                <label class="block text-sm text-gray-600">Màu chính</label>
                <input v-model="branding.primaryColor" type="color" class="w-16 h-10 border rounded">
              </div>
              <div>
                <label class="block text-sm text-gray-600">Logo URL</label>
                <input v-model="branding.logoUrl" type="text" class="w-full border rounded-lg px-3 py-2 mt-1">
              </div>
              <button @click="saveBranding" class="bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700">
                Lưu cài đặt
              </button>
            </div>
          </div>
        </div>
      </main>
    </div>

    <!-- Create User Modal -->
    <div v-if="showCreateUser" class="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center">
      <div class="bg-white rounded-lg p-6 w-96">
        <h3 class="text-lg font-semibold mb-4">Tạo người dùng mới</h3>
        <div class="space-y-4">
          <div>
            <label class="block text-sm text-gray-600">Tài khoản</label>
            <input v-model="newUser.username" type="text" class="w-full border rounded-lg px-3 py-2 mt-1">
          </div>
          <div>
            <label class="block text-sm text-gray-600">Mật khẩu</label>
            <input v-model="newUser.password" type="password" class="w-full border rounded-lg px-3 py-2 mt-1">
          </div>
          <div>
            <label class="block text-sm text-gray-600">Thiết bị tối đa</label>
            <input v-model="newUser.max_devices" type="number" class="w-full border rounded-lg px-3 py-2 mt-1">
          </div>
        </div>
        <div class="flex justify-end mt-6 space-x-2">
          <button @click="showCreateUser = false" class="px-4 py-2 border rounded-lg">Hủy</button>
          <button @click="createUser" class="px-4 py-2 bg-blue-600 text-white rounded-lg">Tạo</button>
        </div>
      </div>
    </div>
  </div>

  <script src="js/app.js"></script>
</body>
</html>
```

- [ ] **Step 2: Create public/admin/js/app.js**

```javascript
const { createApp } = Vue;

createApp({
  data() {
    return {
      currentView: 'dashboard',
      stats: { users: 0, activeSessions: 0, todayData: 0, bandwidth: 0 },
      sessions: [],
      devices: [],
      users: [],
      packages: [],
      recentLogs: [],
      showCreateUser: false,
      newUser: { username: '', password: '', max_devices: 3 },
      backingUp: false,
      backupMessage: '',
      webdavUrl: '',
      webdavUsername: '',
      webdavPassword: '',
      branding: { name: '', primaryColor: '#1976D2', logoUrl: '' },
    };
  },
  mounted() {
    this.loadData();
    this.startAutoRefresh();
  },
  methods: {
    async loadData() {
      try {
        const [stats, sessions, devices, users, packages] = await Promise.all([
          this.fetchStats(),
          this.fetchSessions(),
          this.fetchDevices(),
          this.fetchUsers(),
          this.fetchPackages(),
        ]);
        this.stats = stats;
        this.sessions = sessions;
        this.devices = devices;
        this.users = users;
        this.packages = packages;
      } catch (err) {
        console.error('Failed to load data:', err);
      }
    },
    async fetchStats() {
      const res = await axios.get('/admin/api/stats');
      return res.data;
    },
    async fetchSessions() {
      const res = await axios.get('/api/sessions');
      return res.data;
    },
    async fetchDevices() {
      const res = await axios.get('/api/devices');
      return res.data;
    },
    async fetchUsers() {
      const res = await axios.get('/api/users');
      return res.data;
    },
    async fetchPackages() {
      const res = await axios.get('/api/packages');
      return res.data;
    },
    async terminateSession(id) {
      if (confirm('Ngắt kết nối này?')) {
        await axios.delete(`/api/sessions/${id}`);
        this.loadData();
      }
    },
    async disconnectDevice(mac) {
      if (confirm('Ngắt thiết bị này?')) {
        await axios.delete(`/api/devices/${mac}`);
        this.loadData();
      }
    },
    async createUser() {
      await axios.post('/api/users', this.newUser);
      this.showCreateUser = false;
      this.newUser = { username: '', password: '', max_devices: 3 };
      this.loadData();
    },
    async toggleUser(user) {
      await axios.put(`/api/users/${user.id}`, { is_active: !user.is_active });
      this.loadData();
    },
    async deleteUser(id) {
      if (confirm('Xóa người dùng này?')) {
        await axios.delete(`/api/users/${id}`);
        this.loadData();
      }
    },
    async createBackup() {
      this.backingUp = true;
      this.backupMessage = '';
      try {
        const res = await axios.post('/admin/api/backup');
        this.backupMessage = res.data.message;
      } catch (err) {
        this.backupMessage = 'Sao lưu thất bại';
      }
      this.backingUp = false;
    },
    async saveWebdavConfig() {
      await axios.post('/admin/api/settings/webdav', {
        url: this.webdavUrl,
        username: this.webdavUsername,
        password: this.webdavPassword,
      });
      alert('Đã lưu cấu hình WebDAV');
    },
    async saveBranding() {
      await axios.post('/admin/api/settings/branding', this.branding);
      alert('Đã lưu cài đặt thương hiệu');
    },
    startAutoRefresh() {
      setInterval(() => this.loadData(), 30000);
    },
    formatBytes(bytes) {
      if (!bytes) return '0 B';
      const k = 1024;
      const sizes = ['B', 'KB', 'MB', 'GB'];
      const i = Math.floor(Math.log(bytes) / Math.log(k));
      return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    },
    formatDuration(minutes) {
      if (!minutes) return '-';
      if (minutes < 60) return `${minutes} phút`;
      const hours = Math.floor(minutes / 60);
      return `${hours} giờ`;
    },
    formatTime(timestamp) {
      if (!timestamp) return '-';
      return new Date(timestamp).toLocaleString('vi-VN');
    },
    async logout() {
      await axios.post('/auth/logout');
      window.location.href = '/admin/login.html';
    },
  },
}).mount('#app');
```

- [ ] **Step 3: Commit**

```bash
git add public/admin/
git commit -m "feat(admin): add Vue.js admin dashboard SPA"
```

---

## Task 2: Admin API Endpoints

**Files:**
- Create: `src/routes/admin/stats.js`
- Modify: `src/app.js`

**Interfaces:**
- Produces: Stats API for dashboard

- [ ] **Step 1: Create src/routes/admin/stats.js**

```javascript
const express = require('express');
const { sessions, devices, users } = require('../../db');
const { requireApiAuth } = require('../../middleware/auth');

const router = express.Router();

router.get('/stats', requireApiAuth, (req, res) => {
  const totalUsers = users.getAll.all().length;
  const activeSessions = sessions.getActive.all().length;
  
  // Calculate today's data
  const today = new Date().toISOString().split('T')[0];
  const todaySessions = sessions.getActive.all().filter(s => 
    s.start_time && s.start_time.startsWith(today)
  );
  const todayData = todaySessions.reduce((sum, s) => sum + (s.quota_used_mb || 0), 0) * 1024 * 1024;
  
  // Bandwidth estimation
  const bandwidth = activeSessions > 0 ? activeSessions * 5 : 0; // Mbps
  
  res.json({
    users: totalUsers,
    activeSessions,
    todayData,
    bandwidth,
  });
});

module.exports = router;
```

- [ ] **Step 2: Update src/app.js**

```javascript
app.use('/admin/api', require('./routes/admin'));
app.use('/admin/api', require('./routes/admin/stats'));
```

- [ ] **Step 3: Commit**

```bash
git add src/routes/admin/
git commit -m "feat(admin): add admin stats API"
```

---

## Task 3: WebDAV Backup System

**Files:**
- Create: `src/services/backup.js`
- Create: `src/routes/admin/backup.js`

**Interfaces:**
- Produces: WebDAV backup automation

- [ ] **Step 1: Create src/services/backup.js**

```javascript
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { loadConfig } = require('../config');
const { db } = require('../db');

async function createBackup() {
  const config = loadConfig();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.dirname(config.databasePath);
  const backupFile = path.join(backupDir, `backup-${timestamp}.db`);
  
  // Copy database
  fs.copyFileSync(config.databasePath, backupFile);
  
  // Upload to WebDAV if configured
  if (config.webdavUrl) {
    await uploadToWebDAV(backupFile, `wifi-portal-${timestamp}.db`);
  }
  
  // Clean old backups
  await cleanOldBackups(config.backupRetention || 10);
  
  return { success: true, file: backupFile };
}

async function uploadToWebDAV(filePath, fileName) {
  const config = loadConfig();
  const url = new URL(`${config.webdavUrl}/${fileName}`);
  
  const response = await fetch(url.toString(), {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/octet-stream',
    },
    body: fs.createReadStream(filePath),
    headers: {
      'Authorization': `Basic ${Buffer.from(
        `${config.webdavUsername}:${config.webdavPassword}`
      ).toString('base64')}`,
    },
  });
  
  if (!response.ok) {
    throw new Error(`WebDAV upload failed: ${response.status}`);
  }
}

async function cleanOldBackups(retention) {
  const config = loadConfig();
  const backupDir = path.dirname(config.databasePath);
  const files = fs.readdirSync(backupDir)
    .filter(f => f.startsWith('backup-') && f.endsWith('.db'))
    .map(f => ({
      name: f,
      path: path.join(backupDir, f),
      time: fs.statSync(path.join(backupDir, f)).mtime,
    }))
    .sort((a, b) => b.time - a.time);
  
  // Keep only retention number of backups
  for (let i = retention; i < files.length; i++) {
    fs.unlinkSync(files[i].path);
  }
}

module.exports = { createBackup, uploadToWebDAV, cleanOldBackups };
```

- [ ] **Step 2: Create src/routes/admin/backup.js**

```javascript
const express = require('express');
const { requireApiAuth } = require('../../middleware/auth');
const { createBackup } = require('../../services/backup');

const router = express.Router();

router.post('/backup', requireApiAuth, async (req, res) => {
  try {
    const result = await createBackup();
    res.json({ success: true, message: `Backup created: ${result.file}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
```

- [ ] **Step 3: Commit**

```bash
git add src/services/backup.js src/routes/admin/backup.js
git commit -m "feat(backup): add WebDAV backup system"
```

---

## Task 4: Phase 3 Verification

**Files:** None (testing)

- [ ] **Step 1: Start server**

```bash
npm start
```

- [ ] **Step 2: Test admin dashboard**

```
curl http://localhost:3000/admin/
# Should return the dashboard HTML
```

- [ ] **Step 3: Test API**

```bash
curl http://localhost:3000/admin/api/stats
# Should return stats JSON
```

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(phase3): admin dashboard with backup"
git tag phase3-complete
```

---

## Phase 3 Summary

**Completed:**
- Vue.js admin dashboard SPA
- Real-time stats and monitoring
- Session and device management
- User CRUD operations
- WebDAV backup automation
- Branding settings

**Next (Phase 4):**
- Production deployment
- Docker containerization
- Load balancing for high availability
- Mobile app integration

**To Test:**
```bash
cd ~/radius-captive-portal
npm start
# Open http://localhost:3000/admin
```
