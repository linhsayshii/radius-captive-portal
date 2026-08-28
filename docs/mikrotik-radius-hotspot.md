# MikroTik HotSpot + FreeRADIUS

Portal cấp quyền theo MAC sau khi người dùng chọn gói hoặc đăng nhập. MikroTik
phải dùng HTTP-PAP: FreeRADIUS nhận username/password là MAC đã chuẩn hoá (ví
dụ `aabbccddeeff`). Không bật HTTP-CHAP cho profile này.

## 1. Biến môi trường trên server

```env
RADIUS_SHARED_SECRET=<secret-trung-voi-router>
RADIUS_CLIENTS=<IP-nguon-radius-cua-mikrotik>
```

`RADIUS_CLIENTS` là IP mà MikroTik dùng làm **source** khi gửi RADIUS, không
phải IP WiFi client. Mỗi router phải có một IP rõ ràng; không dùng `0.0.0.0/0`.

## 2. Cấu hình RouterOS

Thay `RADIUS_SERVER`, `RADIUS_SECRET`, `hotspot1` và `hsprof1` bằng giá trị
thật. Chỉ chạy lệnh `/radius add` nếu chưa có RADIUS service `hotspot` trỏ đến
server đó.

```routeros
# Xem service RADIUS HotSpot hiện có trước khi thêm mới.
/radius print detail where service~"hotspot"

# FreeRADIUS trong Docker Compose.
/radius add address=RADIUS_SERVER service=hotspot secret=RADIUS_SECRET authentication-port=1812 accounting-port=1813 timeout=3s

# Bắt buộc PAP và nhận chu kỳ interim 60 giây từ FreeRADIUS.
/ip hotspot profile set hsprof1 use-radius=yes radius-accounting=yes radius-interim-update=received login-by=http-pap
/ip hotspot set hotspot1 profile=hsprof1

# Cho phép client chưa đăng nhập mở portal.
/ip hotspot walled-garden ip add dst-address=PORTAL_SERVER_IP action=accept
```

FreeRADIUS trả `Session-Timeout`, `Idle-Timeout`, `Acct-Interim-Interval` và
`Mikrotik-Rate-Limit`; RouterOS sẽ áp thời lượng và tốc độ cho phiên đó.

## 3. Chuyển từ login.html của MikroTik sang portal ngoài

Tạo/cập nhật `login.html` trong hotspot HTML directory của profile. Thay
`PORTAL_URL` bằng URL thật (ví dụ `wifi.example.com`). Các biến có hậu `-esc`
là bắt buộc để URL không vỡ khi giá trị chứa ký tự đặc biệt.

```html
<!doctype html>
<html><head><meta charset="utf-8"><title>Đang chuyển tới WiFi Portal</title></head>
<body>
  <form id="portal" method="get" action="https://PORTAL_URL/">
    <input type="hidden" name="mac" value="$(mac-esc)">
    <input type="hidden" name="link-login-only" value="$(link-login-only-esc)">
    <input type="hidden" name="dst" value="$(link-orig-esc)">
  </form>
  <script>document.getElementById('portal').submit()</script>
</body></html>
```

Sau khi chọn gói, portal gửi form POST về `link-login-only` với username và
password là MAC chuẩn hoá. MikroTik gửi Access-Request PAP tới FreeRADIUS và
chỉ mở Internet khi nhận Access-Accept.

## 4. Walled garden khi dùng HTTPS/OAuth

```routeros
/ip hotspot walled-garden add dst-host=wifi.example.com action=allow
/ip hotspot walled-garden add dst-host=accounts.google.com action=allow
/ip hotspot walled-garden add dst-host=*.gstatic.com action=allow
/ip hotspot walled-garden add dst-host=*.googleapis.com action=allow
```

Nên dùng FQDN có chứng chỉ TLS hợp lệ cho portal. Mở firewall trên **server**
chỉ cho IP router vào UDP `1812` và `1813`; không public hai cổng này ra
Internet.

## 5. Kiểm tra

```routeros
/radius monitor [find where service~"hotspot"] once
/log print where topics~"radius"
/ip hotspot active print
```

`accepts` phải tăng sau khi client chọn gói. Nếu `timeouts` tăng: kiểm tra
firewall, IP trong `RADIUS_CLIENTS`, và `RADIUS_SHARED_SECRET` trên router có
khớp `.env` hay không.

## Phạm vi policy hiện tại

- Đã thực thi: thời lượng, idle timeout, upload/download và accounting.
- Quota MikroTik được gửi bằng `Mikrotik-Total-Limit`, giới hạn kỹ thuật tối đa
  khoảng 4 GiB mỗi phiên. Quota lớn hơn và số thiết bị đồng thời cần thêm policy
  accounting/CoA ở bước tiếp theo, chưa nên coi là đã được FreeRADIUS ép chặt.
