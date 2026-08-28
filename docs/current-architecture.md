# Kiến trúc hiện hành

Đây là tài liệu nguồn cho cấu trúc runtime hiện tại. `SPEC.md` là tài liệu lịch sử của bản thử nghiệm trước và không dùng làm hướng dẫn triển khai.

```text
Thiết bị
  → Router/AP (NAS)
  → FreeRADIUS :1812 (Access-Request) / :1813 (Accounting)
  ↔ MariaDB (radcheck, radreply, radacct)
  ← Portal Node.js :3000
       ↔ SQLite (tài khoản, MAC authorization, bản chiếu session)
       → Router/AP :3799 (CoA / Disconnect khi cần ngắt)
```

- Node.js không lắng nghe cổng RADIUS 1812/1813. FreeRADIUS là dịch vụ duy nhất xử lý Auth và Accounting.
- Portal ghi quyền MAC vào SQLite rồi đồng bộ sang MariaDB; FreeRADIUS đọc policy đó cho Access-Accept.
- `radacct` là nguồn dữ liệu phiên thực tế. Portal đồng bộ về SQLite để hiển thị dashboard, quota và trạng thái thiết bị.
- `RADIUS_INTERIM_INTERVAL_SECONDS` mặc định là 10 giây. Router/AP có thể áp dụng mức tối thiểu riêng; tốc độ hiển thị là trung bình theo các Accounting update, không phải đo gói tin từng giây.
- Node.js chỉ gửi CoA/Disconnect đến NAS qua UDP 3799. Đây là client outbound, không cần mở cổng 3799 trên container Node.

Kiểm tra trước khi triển khai:

```bash
npm run check:portal
npm run test:core
npm run test:rate-limits
npm run build:portal
npm run build:admin
```

Sau khi router đã kết nối, xác nhận `radacct` có bản ghi `Acct-Status-Type = Start` và các Interim Update; sau đó trang **Phiên kết nối** sẽ phản ánh các bản ghi này.
