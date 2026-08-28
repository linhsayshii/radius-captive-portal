# WiFi Captive Portal & FreeRADIUS

Hệ thống quản lý mạng WiFi tập trung tích hợp **Captive Portal**, **FreeRADIUS**, MariaDB, Google OAuth 2.0 và Admin Dashboard. Giao diện portal, gói cước, giới hạn thời lượng, tốc độ upload/download, quota và số thiết bị được giữ lại; RADIUS UDP không còn do Node.js tự xử lý.

Hỗ trợ đa nền tảng phần cứng mạng: **MikroTik RouterOS**, **Aruba Instant AP (IAP / Virtual Controller)**, **OpenWrt (CoovaChilli / OpenNDS)**, **Ubiquiti UniFi**, **pfSense / OPNsense**, **Cisco Meraki**.

---

## 🚀 Khởi chạy bằng Docker Compose

1. Sao chép `.env.example` thành `.env`, sau đó đặt các secret mạnh cho `RADIUS_SHARED_SECRET`, `RADIUS_DB_PASSWORD`, `MARIADB_ROOT_PASSWORD` và `ADMIN_SESSION_SECRET`.
2. Đặt `RADIUS_CLIENTS` thành danh sách IP của router/NAS, phân cách bằng dấu phẩy.
3. Khởi chạy:

   ```bash
   docker compose up --build
   ```

FreeRADIUS nhận Auth trên UDP `1812` và Accounting trên UDP `1813`; MariaDB chỉ nằm trong mạng Docker. Không dùng cấu hình `client all` trong tài liệu Splash ở môi trường production.

## Cài đặt phát triển

1. Sao chép file cấu hình mẫu và điền thông tin:
   ```bash
   cp .env.example .env
   ```
2. Cài đặt các thư viện phụ thuộc:
   ```bash
   npm install
   ```
3. Khởi tạo cơ sở dữ liệu và tài khoản quản trị Admin:
   ```bash
   npm run init-db
   npm run create-admin
   ```
4. Build giao diện Portal và Admin:
   ```bash
   npm run build:portal
   npm run build:admin
   ```
5. Khởi chạy ứng dụng:
   ```bash
   npm start
   ```

- **Captive Portal**: `http://<IP_SERVER>:3000/`
- **Trang Quản trị Admin Dashboard**: `http://<IP_SERVER>:3000/admin`

---

## 📡 Hướng dẫn cấu hình Router

### 1. Aruba Instant AP (IAP / Virtual Controller)
Xem hướng dẫn chi tiết tại [docs/aruba-instant-radius-setup.md](docs/aruba-instant-radius-setup.md).

- **Tạo Guest Network**: Chọn `Primary usage: Guest`.
- **Splash page type**: Chọn `External`.
  - IP/Hostname: `<IP_SERVER_PORTAL>`
  - Port: `3000`
  - URL: `/?mac=%m`
- **RADIUS Auth Server**:
  - IP: `<IP_SERVER_PORTAL>` | Auth Port: `1812` | Acct Port: `1813`
  - Shared key: Khớp với `RADIUS_SHARED_SECRET`
  - **RFC 3576 (CoA / Disconnect)**: Bật `Enable` -> Port `3799` *(để Server ngắt kết nối khi hết hạn hoặc bị kick)*.
- **Pre-Auth Role (Walled Garden)**: Thêm Rule `Allow TCP port 3000` tới `<IP_SERVER_PORTAL>`.

---

### 2. MikroTik RouterOS
Xem hướng dẫn chi tiết tại [docs/mikrotik-radius-hotspot.md](docs/mikrotik-radius-hotspot.md).

Chạy các lệnh sau trong **Terminal** của RouterOS:

```routeros
# 1. Khai báo máy chủ RADIUS
/radius add address=IP_SERVER secret=RADIUS_SECRET service=hotspot authentication-port=1812 accounting-port=1813

# 2. Bật cổng nhận lệnh ngắt kết nối (Incoming CoA/Disconnect) từ Server
/radius incoming set accept=yes port=3799

# 3. Kích hoạt RADIUS và gửi Accounting định kỳ trong Hotspot Profile
/ip hotspot profile set [find default=yes] use-radius=yes radius-accounting=yes radius-interim-update=1m login-by=http-pap
/ip hotspot user profile set [find default=yes] session-timeout=1d

# 4. Walled Garden cho máy chủ Portal
/ip hotspot walled-garden ip add dst-address=IP_SERVER action=accept
```

Trong file `login.html` của Hotspot MikroTik, chuyển hướng về:
```text
http://IP_SERVER:3000/?mac=$(mac)&link-login-only=$(link-login-only)&dst=$(link-orig)
```

---

## 🔐 Google OAuth 2.0

Để cho phép người dùng đăng nhập bằng tài khoản Google, tạo một OAuth 2.0 Web Client trên [Google Cloud Console](https://console.cloud.google.com/apis/credentials) và cấu hình trong `.env`:

```env
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-client-secret
GOOGLE_CALLBACK_URL=https://wifi.yourdomain.com/auth/google/callback
```

### 🌐 Danh sách tên miền cần Walled Garden (Whitelist trên Router)

Khi người dùng chưa đăng nhập, Router cần mở thông các tên miền sau để giao diện Google Sign-in hoạt động bình thường:

| Tên miền | Mục đích |
| :--- | :--- |
| `wifi.yourdomain.com` (hoặc IP Server) | Giao diện Captive Portal & Callback URL |
| `accounts.google.com` | Trang đăng nhập tài khoản Google |
| `accounts.youtube.com` | Phiên SSO / Identity của Google |
| `ssl.gstatic.com`, `fonts.gstatic.com` | Static CDN tài nguyên & Font giao diện |
| `fonts.googleapis.com` | Google Fonts |
| `apis.google.com`, `play.google.com` | Thư viện OAuth Client SDK |
| `*.google.com`, `*.gstatic.com`, `*.googleapis.com` | Wildcard toàn bộ dịch vụ phụ trợ Google OAuth |


---

## ⚡ Các cổng mạng (Ports) sử dụng

| Cổng | Giao thức | Dịch vụ | Mục đích |
| :--- | :--- | :--- | :--- |
| **`3000`** | TCP (HTTP) | Web Server | Giao diện Captive Portal & Admin Dashboard |
| **`1812`** | UDP | FreeRADIUS Auth | Router gửi `Access-Request` để xác thực quyền |
| **`1813`** | UDP | FreeRADIUS Acct | Router gửi `Accounting-Request` (Start, Interim, Stop) |
