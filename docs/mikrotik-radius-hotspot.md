# MikroTik Hotspot + RADIUS

Portal này cấp quyền theo MAC sau khi người dùng chọn **Đăng nhập ngay** hoặc xác thực tài khoản. Router phải gửi Access-Request tới ứng dụng qua RADIUS, không phải chỉ redirect HTTP tới portal.

## Biến môi trường

```env
RADIUS_SHARED_SECRET=thay-bang-mot-secret-dai-va-ngau-nhien
RADIUS_AUTH_PORT=1812
RADIUS_ACCOUNTING_PORT=1813
```

Mở UDP 1812 và UDP 1813 từ địa chỉ router đến máy chủ portal. Cổng 3799 chỉ dùng cho CoA, không dùng làm cổng xác thực.

## RouterOS

Thay `PORTAL_IP`, `RADIUS_SECRET`, `hotspot1` và `hsprof1` bằng giá trị thực tế.

```routeros
# 1. Khai báo máy chủ RADIUS
/radius add address=PORTAL_IP secret=RADIUS_SECRET service=hotspot authentication-port=1812 accounting-port=1813

# 2. Bật cổng nhận lệnh Disconnect/CoA từ Server (để Server ngắt kết nối khi cần)
/radius incoming set accept=yes port=3799

# 3. Kích hoạt RADIUS và gửi thông tin Accounting định kỳ trong Hotspot Profile
/ip hotspot profile set hsprof1 use-radius=yes radius-accounting=yes radius-interim-update=1m login-by=http-pap
/ip hotspot set hotspot1 profile=hsprof1
/ip hotspot user profile set [find default=yes] session-timeout=1d

# 4. Walled Garden cho Portal Server (cho phép máy trạm mở trang portal trước khi login)
/ip hotspot walled-garden ip add dst-address=PORTAL_IP action=accept
```

Trong trang redirect của Hotspot, URL portal phải mang các biến MikroTik sau. Ví dụ, dùng URL tương đương với:

```text
https://portal.example.com/?mac=$(mac)&link-login-only=$(link-login-only)&dst=$(link-orig)
```

Khi nút được bấm, portal POST về `link-login-only`. Router gửi một Access-Request có `Calling-Station-Id`; ứng dụng chuẩn hoá MAC, kiểm tra quyền còn hạn và trả Access-Accept kèm `Session-Timeout`, `Idle-Timeout`, và `MikroTik-Rate-Limit`.

Khi quản trị viên bấm ngắt kết nối (kick) trên Dashboard hoặc phiên hết hạn/vượt quota, RADIUS Server sẽ tự động gửi gói tin `Disconnect-Request` (UDP 3799) theo chuẩn RFC 5176 để router ngắt kết nối thiết bị ngay lập tức.

