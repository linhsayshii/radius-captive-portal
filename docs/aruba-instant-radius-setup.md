# Aruba Instant AP (IAP) + External Captive Portal & RADIUS

Hướng dẫn tích hợp mạng WiFi Khách trên **Aruba Instant AP (Virtual Controller)** với máy chủ **Captive Portal & RADIUS** tập trung.

---

## Luồng xác thực chuẩn (End-to-End Authentication Flow)

```
1.  Client kết nối WiFi Guest (Role: Pre-Auth)
        │
        ▼
2.  Aruba redirect HTTP request → Captive Portal
    URL: https://captiveportal.hnglinh.io.vn/?mac=%m&switchip=%s&url=%u
        │
        ▼
3.  Client mở portal trên trình duyệt / popup CNA
        │
        ▼
4.  User bấm "Đăng nhập nhanh" → Chọn gói cước (hoặc "Đăng nhập nội bộ")
        │
        ▼
5.  Portal gọi POST /api/guest/connect
    → Lưu MAC & thông số gói cước (băng thông, thời hạn) vào bảng mac_authorizations
        │
        ▼
6.  Portal submit Form POST sang Aruba Virtual Controller:
    Action: http://<switchip>/cgi-bin/login (user=MAC, password=MAC, cmd=authenticate)
        │
        ▼
7.  Aruba AP nhận form POST → gửi RADIUS Access-Request đến RADIUS server (port 1812)
    User-Name = MAC, Calling-Station-Id = MAC
        │
        ▼
8.  RADIUS server kiểm tra mac_authorizations
    → Trả RADIUS Access-Accept kèm thông số băng thông (WISPr/MikroTik) và Session-Timeout
        │
        ▼
9.  Aruba nhận Access-Accept → chuyển client sang Role Guest (mở mạng) và redirect vào Internet
```

> **Quan trọng:** Tham số `switchip` trong URL là bắt buộc (`/?mac=%m&switchip=%s&url=%u`) để portal có thể gửi lệnh xác thực về CGI endpoint của Aruba Instant AP (`/cgi-bin/login`). Sau khi nhận được lệnh này, Aruba AP mới phát gói RADIUS `Access-Request` tới máy chủ.

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
   - **URL**: `/?mac=%m&switchip=%s&url=%u` *(bắt buộc giữ `switchip`; chỉ dùng `/?mac=%m` thì portal không thể gửi lệnh xác thực về Aruba)*
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
  - **Walled Garden Domain Whitelist**:
    - Vào phần **Walled Garden** trong cấu hình mạng / role.
    - Thêm danh sách tên miền cần mở trước xác thực:
      - `portal.example.com`
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

# 3. Tạo Role Pre-Auth (Walled Garden IP & DNS)
wlan access-rule Portal-Pre-Auth
  rule 192.168.1.50 255.255.255.255 match tcp 3000 3000 permit
  rule any any match udp 53 53 permit
  rule any any match udp 67 68 permit

# 4. Cấu hình Walled Garden Domain Whitelist cho Portal
wlan walled-garden
  white-list "portal.example.com"

# 5. Khởi tạo SSID Guest Network
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

---

## 3. Kiểm tra & Xử lý sự cố

### 3.1 Kiểm tra Access-Request từ Aruba

Trên server chạy RADIUS server, dùng `tcpdump` để xem Aruba có gửi Access-Request không:

```bash
# Xem tất cả gói RADIUS (UDP port 1812 = Auth, 1813 = Accounting)
sudo tcpdump -i any udp port 1812 or udp port 1813 -v

# Chỉ xem Access-Request (code=01) từ IP của Aruba
sudo tcpdump -i any udp port 1812 -vv 'udp[0:1] = 0x01'
```

**Kết quả mong đợi:** Thấy gói UDP từ IP Aruba đến server port 1812 sau khi user bấm "Truy cập ngay" (thường trong vòng 1-5 giây).

**Nếu KHÔNG thấy gì:**
- Aruba chưa gửi Access-Request → kiểm tra **cấu hình RADIUS Authentication Server** (port 1812, shared key)
- Chạy thử trên server: `nc -ul 1812` để xem có gói UDP đến không
- Kiểm tra firewall: `sudo iptables -L -n | grep 1812` hoặc `sudo ufw status`

### 3.2 Kiểm tra MAC đã được authorize chưa

Sau khi bấm "Truy cập ngay", MAC nên xuất hiện trong bảng `mac_authorizations`. Kiểm tra qua **Admin Dashboard** → tab **Quyền truy cập MAC**, hoặc qua API:

```bash
curl -s http://localhost:3000/api/guest/whitelist \
  -H "Cookie: admin_session=<token>"
```

### 3.3 Kiểm tra server logs

Server logs cho biết Aruba có gửi Access-Request và server trả Access-Accept chưa:

```bash
# Theo dõi logs
tail -f /path/to/logs/access.log | grep -i radius

# Hoặc xem stdout/stderr nếu chạy trực tiếp
npm start 2>&1 | grep -i "radius\|access-request\|access-accept"
```

**Log mong đợi khi thành công:**
```
RADIUS Access-Request from 192.168.1.248 - User: AA:BB:CC:DD:EE:FF, MAC: aabbccddeeff
RADIUS Access-Accept for MAC: aabbccddeeff (3599s remaining, 5000/2000 kbps)
```

**Nếu thấy "Access-Reject" thay vì "Access-Accept":**
- MAC chưa được authorize → gọi lại `/api/guest/connect`
- MAC đã hết hạn → thời gian trên server/dient thoải không đúng
- User account inactive hoặc gói cước inactive

### 3.4 Kiểm tra CoA / Disconnect port 3799

Port 3799 cho phép server **chủ động ngắt kết nối** thiết bị. Kiểm tra Aruba có mở port này chưa:

```bash
# Từ server, gửi test packet đến Aruba port 3799
# (Dùng radclient của FreeRADIUS nếu có)
echo "User-Name=test" | radclient -x 192.168.1.248:3799 disconnect secret
```

Nếu Aruba không phản hồi → kiểm tra Aruba CLI:
```
show eui-acl           # xem access rules
show rights rf-threshold  # xem CoA config
```

### 3.5 Kiểm tra captive portal redirect

Trên máy client, sau khi kết nối WiFi (chưa đăng nhập), mở trình duyệt truy cập `captive.apple.com`:

- **Đúng:** Chuyển hướng đến trang portal
- **Sai:** Hiện trang "Success" (không redirect) → Aruba chưa redirect đúng

Kiểm tra trên Aruba: **Configuration → Networks → SSID → Security tab**
- Splash page type phải là **`External`**, không phải `Internal` hay `None`
- Captive portal profile phải có **Type = RADIUS Authentication**

### 3.6 iPhone / iOS captive portal hiện chậm

1. iOS đợi DHCP + DNS resolution xong mới probe → có thể 5-15 giây sau khi kết nối
2. Probe đầu tiên gửi đến `captive.apple.com` — nếu DNS resolve ra IP của portal thay vì Apple, iOS sẽ redirect
3. **Cải thiện:** Trên Aruba, đảm bảo SSID dùng **WPA2/WPA3 Enterprise** (RADIUS) thay vì WPA2 Personal

### 3.7 Android bị "about:blank blocked"

- Android dùng Chromium WebView để mở captive portal — WebView này chặn `about:blank` và `data:` URLs
- **Không phải lỗi từ portal** — đây là hạn chế của Android WebView
- Nếu sau khi đăng nhập bị redirect ra blank page → portal redirect URL bị lỗi, xem mục 3.5

### Checklist xác minh hoàn chỉnh

- [ ] Aruba gửi Access-Request đến server port 1812 (`tcpdump`)
- [ ] MAC xuất hiện trong `mac_authorizations` sau khi bấm "Truy cập ngay"
- [ ] Logs thấy `Access-Accept` (không phải `Access-Reject`)
- [ ] Client có thể truy cập Internet sau khi đăng nhập
- [ ] CoA port 3799 mở trên Aruba
- [ ] Accounting interim (port 1813) hoạt động — thấy gói Update trong logs mỗi phút
- [ ] Walled Garden đúng — `captive.apple.com` redirect về portal
