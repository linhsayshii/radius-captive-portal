# Aruba Instant AP (IAP) + External Captive Portal & RADIUS

Hướng dẫn tích hợp mạng WiFi Khách trên **Aruba Instant AP (Virtual Controller)** với máy chủ **Captive Portal & RADIUS** tập trung.

---

## 1. Cấu hình qua giao diện Web (Aruba Instant GUI)

Đăng nhập vào Virtual Controller (`https://<IP_ARUBA>:4343`), vào menu **Configuration** -> **Networks** -> bấm **New** (hoặc dấu `+`):

### Bước 1: Khai báo SSID (Tab Basic)
- **Name (SSID)**: Tên WiFi khách (ví dụ: `WiFi Free - Khach Hang`)
- **Primary usage**: Chọn **`Guest`**
- Bấm **Next**.

### Bước 2: Cấp phát IP & VLAN (Tab VLAN)
- **Client IP assignment**:
  - `Virtual Controller managed`: Aruba AP tự cấp IP và NAT riêng cho khách (khuyên dùng).
  - Hoặc `Network assigned` (VLAN Default hoặc VLAN riêng).
- Bấm **Next**.

### Bước 3: Cấu hình External Captive Portal & RADIUS (Tab Security)
1. **Splash page type**: Chọn **`External`**.
2. **Captive portal profile**: Bấm dấu **`+`** (Thêm mới):
   - **Type**: `RADIUS Authentication`
   - **IP or Hostname**: Địa chỉ IP máy chủ Portal (ví dụ: `192.168.1.50`)
   - **URL**: `/?mac=%m&switchip=%s&url=%u` (hoặc `/?mac=%m`)
   - **Port**: `3000` (hoặc cổng HTTP/HTTPS web portal của bạn)
   - **Protocol**: `HTTP`
   - **Redirect URL**: Để trống.
3. **Authentication server 1**: Bấm dấu **`+`** thêm máy chủ RADIUS:
   - **IP address**: Địa chỉ IP máy chủ Portal (ví dụ: `192.168.1.50`)
   - **Auth port**: `1812`
   - **Accounting port**: `1813`
   - **Shared key**: Khớp với `RADIUS_SHARED_SECRET` trong file `.env`
   - **RFC 3576 (CoA / Disconnect)**: **Bật Enable** -> Port: `3799` *(Quan trọng: Cho phép Server ngắt kết nối tập trung)*.
4. **Accounting**: Chọn `Use authentication servers`, **Accounting interval**: `1 min`.
- Bấm **Next**.

### Bước 4: Phân quyền truy cập & Walled Garden (Tab Access)
- **Post-Authentication Role**: Giữ nguyên `Allow any to all destinations` 🟢 (Khách dùng full mạng sau khi đăng nhập).
- **Pre-Authentication Role**:
  - Gạt nút **`Assign pre-authentication role`** sang **ON**.
  - Trong Access Rules của Pre-Auth Role, thêm một rule **Walled Garden** (cho phép tải trang portal):
    - **Rule type**: `Access control`
    - **Service**: `tcp` -> Port: `3000` (hoặc port web portal)
    - **Action**: `Allow` (Permit)
    - **Destination**: `to a specific IP host` -> Nhập IP máy chủ Portal (`192.168.1.50`).
- Bấm **Finish** để hoàn tất.

---

## 2. Cấu hình nhanh qua dòng lệnh (Aruba IAP CLI)

Nếu bạn truy cập Aruba AP qua SSH / Console:

```aruba
# 1. Khai báo RADIUS Server kèm cổng ngắt kết nối CoA (RFC 3576 port 3799)
wlan auth-server Portal-RADIUS
  ip 192.168.1.50
  port 1812
  acct-port 1813
  key KI5JVlWwKuC92jVJAS7ykVky3uAzyVHb
  rfc3576
  rfc3576-port 3799

# 2. Khai báo External Captive Portal
wlan external-captive-portal Portal-Web
  server 192.168.1.50
  port 3000
  url "/?mac=%m&switchip=%s&url=%u"
  auth-text ""
  https no

# 3. Tạo Role Pre-Auth (Walled Garden)
wlan access-rule Portal-Pre-Auth
  rule 192.168.1.50 255.255.255.255 match tcp 3000 3000 permit
  rule any any match udp 53 53 permit
  rule any any match udp 67 68 permit

# 4. Khởi tạo SSID Guest Network
wlan ssid-profile "WiFi-Khach-Hang"
  enable
  type guest
  essid "WiFi Free - Khach Hang"
  auth-server Portal-RADIUS
  external-captive-portal Portal-Web
  dtim-period 1
  inactivity-timeout 300
  max-authentication-failures 0
  vlan local
  rf-band all
  set-role-pre-auth Portal-Pre-Auth
```
