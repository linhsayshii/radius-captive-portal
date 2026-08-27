const { createApp } = Vue;

createApp({
  data() {
    return {
      currentView: 'dashboard',
      stats: { users: 0, activeSessions: 0, todayData: 0, bandwidth: 0 },
      sessions: [],
      devices: [],
      macAuthorizations: [],
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
        const [stats, sessions, devices, users, packages, macAuthorizations] = await Promise.all([
          this.fetchStats(),
          this.fetchSessions(),
          this.fetchDevices(),
          this.fetchUsers(),
          this.fetchPackages(),
          this.fetchMacAuthorizations(),
        ]);
        this.stats = stats;
        this.sessions = sessions;
        this.devices = devices;
        this.users = users;
        this.packages = packages;
        this.macAuthorizations = macAuthorizations;
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
    async fetchMacAuthorizations() {
      const res = await axios.get('/api/guest/whitelist');
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
    async revokeMacAuthorization(mac) {
      if (confirm(`Thu hồi quyền truy cập của MAC ${mac}?`)) {
        await axios.delete(`/api/guest/whitelist/${encodeURIComponent(mac)}`);
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
