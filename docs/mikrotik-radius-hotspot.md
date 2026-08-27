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
/radius add address=PORTAL_IP secret=RADIUS_SECRET service=hotspot authentication-port=1812 accounting-port=1813
/ip hotspot profile set hsprof1 use-radius=yes login-by=http-pap
/ip hotspot set hotspot1 profile=hsprof1
/ip hotspot user profile set [find default=yes] session-timeout=1d
```

Trong trang redirect của Hotspot, URL portal phải mang các biến MikroTik sau. Ví dụ, dùng URL tương đương với:

```text
https://portal.example.com/?mac=$(mac)&link-login-only=$(link-login-only)&dst=$(link-orig)
```

Khi nút được bấm, portal POST về `link-login-only`. Router gửi một Access-Request có `Calling-Station-Id`; ứng dụng chuẩn hoá MAC, kiểm tra quyền còn hạn và trả Access-Accept kèm `Session-Timeout`.

Không bật phương thức `mac` trong `login-by` để tự động cho toàn bộ MAC vào mạng. Quyền MAC chỉ được thêm sau thao tác trên portal. Dùng cùng `RADIUS_SHARED_SECRET` và `secret` ở router.

Tài khoản RADIUS trực tiếp vẫn dùng PAP: máy chủ chỉ Access-Accept khi bcrypt xác thực được `User-Password`. Không dùng CHAP với luồng tài khoản cục bộ hiện tại.
