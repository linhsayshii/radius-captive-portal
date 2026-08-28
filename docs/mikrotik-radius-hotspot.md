# MikroTik HotSpot, portal ngoài và FreeRADIUS

Đây là cấu hình đã xác nhận hoạt động cho mô hình:

```text
Client → SSID Guest Aruba (VLAN 29) → MikroTik HotSpot → Internet
                                          ├─ HTTPS + captive detection
                                          └─ FreeRADIUS → thời lượng / tốc độ

Client chưa đăng nhập → login.html MikroTik → portal web → POST về MikroTik
```

Aruba chỉ phát SSID và bridge VLAN Guest. MikroTik chặn truy cập, xác thực qua
RADIUS và áp giới hạn tốc độ. Portal web cấp quyền theo MAC, sau đó gửi MAC đã
chuẩn hoá làm username/password về HotSpot.

## 1. Hai domain riêng biệt

Không dùng cùng một domain cho MikroTik HotSpot và portal web.

| Vai trò | Hostname ví dụ | Đích từ client Guest |
| --- | --- | --- |
| HotSpot MikroTik | `hotspot.hnglinh.io.vn` | `10.37.3.1` |
| Portal web | `portal.hnglinh.io.vn` | Server portal, ví dụ `10.37.1.45` |

`hotspot.hnglinh.io.vn` phục vụ `/login` và `/api` từ MikroTik. Domain
`portal.hnglinh.io.vn` là ứng dụng web. Dùng chung domain sẽ làm `/login` đi
nhầm vào ứng dụng portal và có thể trả `404`.

Portal phải chạy HTTPS với certificate hợp lệ. Public DNS của domain portal trỏ
tới public IP/reverse proxy của portal; client Guest có thể dùng DNS nội bộ để
đi trực tiếp tới portal, tránh hairpin NAT.

## 2. VLAN, IP và DHCP Guest

Ví dụ dùng VLAN `29`, subnet `10.37.3.0/24` và uplink Aruba là `ARUBA_UPLINK`.
Thay giá trị viết hoa theo hệ thống; chỉ thêm các mục chưa có.

```routeros
/interface vlan
add interface=bridgeLAN name=guest_captive vlan-id=29

/interface bridge vlan
add bridge=bridgeLAN tagged=bridgeLAN,ARUBA_UPLINK vlan-ids=29

/ip address
add address=10.37.3.1/24 interface=guest_captive

/ip pool
add name=dhcp_guest ranges=10.37.3.10-10.37.3.250

/ip dhcp-server
add name=dhcp_guest interface=guest_captive address-pool=dhcp_guest disabled=no

/ip dhcp-server network
add address=10.37.3.0/24 gateway=10.37.3.1 dns-server=10.37.3.1

/ip dns
set allow-remote-requests=yes
```

SSID Guest trên Aruba phải tag VLAN 29. Một client kết nối phải nhận IP
`10.37.3.x`, gateway `10.37.3.1` và DNS `10.37.3.1`.

Ép DNS về MikroTik để client không né HotSpot bằng DNS public:

```routeros
/ip firewall nat
add chain=dstnat in-interface=guest_captive protocol=udp dst-port=53 action=redirect to-ports=53 comment="Guest DNS UDP to MikroTik"
add chain=dstnat in-interface=guest_captive protocol=tcp dst-port=53 action=redirect to-ports=53 comment="Guest DNS TCP to MikroTik"
add chain=srcnat src-address=10.37.3.0/24 action=masquerade comment="Guest Internet NAT"
```

DNS-over-HTTPS/Private DNS không bị chặn bởi hai rule trên; các client dùng
chúng có thể không tự phát hiện captive portal.

## 3. Certificate HTTPS cho HotSpot

Auto detection trên iOS/Android cần `dns-name`, HTTPS và certificate công khai
hợp lệ. Import cả certificate chain lẫn private key tương ứng:

```routeros
/certificate import file-name=fullchain.pem
/certificate import file-name=privkey.pem passphrase=""
/certificate print detail
```

Certificate gán vào HotSpot phải có SAN/CN khớp
`hotspot.hnglinh.io.vn` (wildcard `*.hnglinh.io.vn` được) và cờ `KT` trong
`/certificate print`: private key (`K`) và trusted (`T`). Không dùng
self-signed hoặc Cloudflare Origin Certificate.

> Let's Encrypt HTTP-01 cần port 80 public đi tới MikroTik khi xác minh. Nếu
> port 80 đang DNAT về portal app, hãy cấp cert bằng DNS-01/reverse proxy rồi
> import certificate và private key vào MikroTik.

## 4. HotSpot HTTPS và DNS HotSpot

Ví dụ tạo profile `hsprof1` và server `hotspot1`:

```routeros
/ip hotspot profile
add name=hsprof1 hotspot-address=10.37.3.1 dns-name=hotspot.hnglinh.io.vn login-by=https,http-pap ssl-certificate=HOTSPOT_CERTIFICATE use-radius=yes radius-accounting=yes radius-interim-update=1m

/ip hotspot
add name=hotspot1 interface=guest_captive address-pool=dhcp_guest profile=hsprof1 disabled=no
```

Nếu hai object đã tồn tại, dùng `set` thay cho `add`:

```routeros
/ip hotspot profile
set hsprof1 hotspot-address=10.37.3.1 dns-name=hotspot.hnglinh.io.vn login-by=https,http-pap ssl-certificate=HOTSPOT_CERTIFICATE use-radius=yes radius-accounting=yes radius-interim-update=1m
```

`dns-name` tự tạo DNS entry của HotSpot. Từ Guest VLAN, hostname phải resolve
về `10.37.3.1`. Kiểm tra:

```routeros
/ip dns static print detail where name="hotspot.hnglinh.io.vn"
```

Nếu bị static DNS khác ghi đè hoặc không có entry, tạo entry trỏ về gateway:

```routeros
/ip dns static add name=hotspot.hnglinh.io.vn address=10.37.3.1
```

Không trỏ `hotspot.hnglinh.io.vn` tới IP public hoặc portal app.

## 5. Bật captive detection (`api.json`)

RouterOS 7.3+ gửi DHCP captive-portal URL khi HotSpot có `dns-name` và valid
HTTPS certificate. File `api.json` trong thư mục HTML HotSpot cũng phải tồn tại.
Nếu HotSpot được tạo từ RouterOS cũ hoặc file HTML custom làm mất file này,
backup HTML rồi reset bộ HTML chuẩn:

```routeros
/ip hotspot profile reset-html [find name=hsprof1]
/file print where name~"api.json"
```

`reset-html` ghi đè `login.html`; phải backup trước và giữ lại `api.json` sau
khi upload lại trang custom. Test từ client Guest bằng hostname:

```text
https://hotspot.hnglinh.io.vn/api
```

Trang phải không lỗi TLS và trả JSON có `"captive": true` với client chưa
đăng nhập.

## 6. Cho phép portal trước khi đăng nhập

Portal cần tải được trước Access-Accept. Ví dụ portal nằm ở `10.37.1.45`:

```routeros
/ip hotspot walled-garden ip
add action=accept dst-address=10.37.1.45 comment="Allow portal before HotSpot login"

/ip dns static
add name=portal.hnglinh.io.vn address=10.37.1.45
```

DNS static thứ hai là tuỳ chọn, nhưng hữu ích để Guest đi thẳng nội bộ. Portal
vẫn phải phục vụ HTTPS certificate cho đúng hostname. Nếu app dùng CDN/API/font
ở domain khác, whitelist chính xác các dependency đó. Không whitelist domain
HotSpot `hotspot.hnglinh.io.vn`.

## 7. `login.html`: chuyển sang portal ngoài

Sau khi auto popup hoạt động bằng HTML chuẩn, upload file này vào HTML directory
của `hsprof1` với tên `login.html`. Giữ `api.json` của MikroTik.

```html
<!doctype html>
<html>
<head><meta charset="utf-8"><title>Đang mở WiFi Portal</title></head>
<body>
  <form id="portal" method="get" action="https://portal.hnglinh.io.vn/">
    <input type="hidden" name="mac" value="$(mac-esc)">
    <input type="hidden" name="link-login-only" value="$(link-login-only-esc)">
    <input type="hidden" name="dst" value="$(link-orig-esc)">
  </form>
  <script>document.getElementById("portal").submit()</script>
</body>
</html>
```

Portal trong repository này đã hỗ trợ `mac`, `link-login-only` và `dst`. Sau
khi người dùng chọn gói/đăng nhập, app POST username/password là MAC chuẩn hoá
về `link-login-only`; MikroTik gửi Access-Request PAP tới FreeRADIUS.

## 8. FreeRADIUS

Trên server portal:

```env
RADIUS_SHARED_SECRET=<secret-trung-voi-router>
RADIUS_CLIENTS=<IP-nguon-radius-cua-mikrotik>
```

`RADIUS_CLIENTS` là source IP MikroTik gửi RADIUS, không phải IP Wi-Fi client.
Trên MikroTik, chỉ thêm service nếu chưa có RADIUS `hotspot` trỏ đúng server:

```routeros
/radius print detail where service~"hotspot"
/radius add address=RADIUS_SERVER service=hotspot secret=RADIUS_SECRET authentication-port=1812 accounting-port=1813 timeout=3s src-address=MIKROTIK_RADIUS_SOURCE_IP
/radius incoming set accept=yes
```

FreeRADIUS trả `Session-Timeout`, `Idle-Timeout`, `Acct-Interim-Interval` và
`Mikrotik-Rate-Limit`; RouterOS áp thời lượng, accounting và tốc độ cho session.

## 9. Loại Guest khỏi PCC/multi-WAN mangle

Nếu router dùng PCC và Guest nằm trong interface list bị routing mark, thêm một
rule ở đầu mangle chain để HotSpot dùng default route:

```routeros
/ip firewall mangle
add chain=prerouting in-interface=guest_captive action=accept comment="Do not apply PCC to HotSpot guests" place-before=0
```

Chỉ thêm rule này một lần.

## 10. Checklist kiểm thử

1. Client nhận IP `10.37.3.x`, gateway/DNS `10.37.3.1`.
2. `https://hotspot.hnglinh.io.vn/api` mở không lỗi cert khi chưa login.
3. Quên Wi-Fi hoặc đổi Private Wi-Fi Address/MAC, kết nối lại và chờ 10–20 giây.
4. iOS/Android tự mở captive assistant. Nếu không, dùng fallback
   `http://neverssl.com`.
5. Portal nhận `mac` và `link-login-only`, login/chọn gói thành công.
6. Xác minh RADIUS và session:

```routeros
/radius monitor [find where service~"hotspot"] once
/log print where topics~"radius"
/ip hotspot active print
```

`accepts` phải tăng sau login. Nếu `timeouts` tăng, kiểm tra firewall, source
address, `RADIUS_CLIENTS` và shared secret.

## Bảo mật và giới hạn

- Không export/chia sẻ private key, RADIUS secret, PPPoE credential hay token
  Cloudflare. Nếu token từng lộ, thu hồi và tạo token mới.
- `http-pap` được giữ để tương thích với luồng portal, nhưng portal phải POST
  về `link-login-only` HTTPS.
- Auto-popup là quyết định của hệ điều hành. HTTPS và DHCP detection cho tỷ lệ
  cao, không đảm bảo mọi client; luôn có fallback mở browser/neverssl.
- `Mikrotik-Total-Limit` có giới hạn kỹ thuật khoảng 4 GiB mỗi phiên. Quota lớn
  hơn và giới hạn số thiết bị cần accounting/CoA policy riêng.
