import { type FormEvent, useState, useEffect } from "react";
import {
  ArrowLeftIcon,
  CheckCircle2Icon,
  CircleAlertIcon,
  LockKeyholeIcon,
  ShieldCheckIcon,
  WifiIcon,
} from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldSeparator,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";

type PortalContext = {
  destination: string;
  mac: string;
  routerUrl: string;
  isAruba: boolean;
};

type Notice = {
  message: string;
  title: string;
  variant: "default" | "destructive";
};

type Package = {
  id: number;
  name: string;
  duration_minutes: number;
  quota_mb: number | null;
  bandwidth_down_kbps: number;
  bandwidth_up_kbps: number;
  max_devices: number;
  is_active: boolean;
};

function isValidMac(val: string): boolean {
  if (!val || typeof val !== "string") return false;
  try {
    val = decodeURIComponent(val);
  } catch (_) {}
  const cleaned = val.replace(/[^a-fA-F0-9]/g, "");
  return cleaned.length === 12;
}

function findValidMac(params: URLSearchParams): string {
  const keys = [
    "mac",
    "client_mac",
    "clientMac",
    "client-mac",
    "sta_mac",
    "sta-mac",
    "usermac",
    "user_mac",
    "mac_address",
    "mac-address",
    "id", // UniFi
  ];

  for (const key of keys) {
    const values = params.getAll(key);
    for (const v of values) {
      if (isValidMac(v)) return v;
    }
  }

  // Also check all query params
  for (const [, value] of params.entries()) {
    if (isValidMac(value)) return value;
  }

  return "";
}

function readPortalContext(): PortalContext {
  const params = new URLSearchParams(window.location.search);
  const mac = findValidMac(params);

  const switchIp = params.get("switchip") || params.get("switch_ip") || params.get("ap_ip") || "";
  const isAruba = Boolean(switchIp || params.get("cmd") === "login");

  let routerUrl =
    params.get("link-login-only") ||
    params.get("link-login") ||
    params.get("router_url") ||
    params.get("login_url") ||
    "";

  if (!routerUrl && switchIp) {
    // Only construct router login URL if switchIp is explicitly provided and valid
    routerUrl = switchIp.startsWith("http") ? `${switchIp}/cgi-bin/login` : `http://${switchIp}/cgi-bin/login`;
  }

  return {
    mac,
    routerUrl,
    destination: params.get("dst") || params.get("url") || params.get("userurl") || params.get("orig") || "",
    isAruba,
  };
}

function updateMode(mode?: "account") {
  const params = new URLSearchParams(window.location.search);
  if (mode) {
    params.set("mode", mode);
  } else {
    params.delete("mode");
  }
  const search = params.toString();
  window.history.replaceState(null, "", `${window.location.pathname}${search ? `?${search}` : ""}`);
}

function PortalFrame({ children }: { children: React.ReactNode }) {
  return (
    <main className="grid min-h-[100dvh] overflow-hidden bg-background lg:grid-cols-[minmax(0,1fr)_minmax(28rem,0.9fr)]">
      <section className="relative hidden min-w-0 overflow-hidden bg-primary px-12 py-16 text-hero-foreground lg:flex lg:flex-col lg:justify-between">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_78%_20%,color-mix(in_oklch,var(--hero-foreground)_22%,transparent),transparent_28%),radial-gradient(circle_at_18%_84%,color-mix(in_oklch,var(--hero-foreground)_14%,transparent),transparent_34%)]" />
        <div className="relative flex items-center gap-3">
          <span className="flex size-11 items-center justify-center rounded-xl bg-primary-foreground text-primary">
            <WifiIcon aria-hidden="true" />
          </span>
          <span className="text-lg font-semibold tracking-tight">WiFi Portal</span>
        </div>
        <div className="relative max-w-lg">
          <Badge variant="secondary">WiFi dành cho khách</Badge>
          <h1 className="mt-5 max-w-md text-5xl font-semibold tracking-tight text-balance">
            Kết nối an toàn, bắt đầu trong vài giây.
          </h1>
          <p className="mt-5 max-w-md text-base leading-7 text-hero-foreground/80">
            Chọn truy cập nhanh hoặc xác thực bằng tài khoản được cấp quyền.
          </p>
        </div>
        <div className="relative flex items-center gap-2 text-sm text-hero-foreground/80">
          <ShieldCheckIcon aria-hidden="true" />
          <span>Thông tin đăng nhập được bảo vệ.</span>
        </div>
      </section>
      <section className="flex min-h-[100dvh] min-w-0 items-center justify-center px-5 py-10 sm:px-8">
        <div className="w-full max-w-md">{children}</div>
      </section>
    </main>
  );
}

function NoticeAlert({ notice }: { notice: Notice | null }) {
  if (!notice) return null;

  return (
    <Alert variant={notice.variant}>
      <CircleAlertIcon aria-hidden="true" />
      <AlertTitle>{notice.title}</AlertTitle>
      <AlertDescription>{notice.message}</AlertDescription>
    </Alert>
  );
}

function AccountLogin({ context, onBack }: { context: PortalContext; onBack: () => void }) {
  const [notice, setNotice] = useState<Notice | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function submitLocalLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setNotice(null);

    if (!context.mac) {
      setNotice({
        title: "Không nhận được thiết bị",
        message: "Hãy mở portal từ trang chuyển hướng của router để tiếp tục.",
        variant: "destructive",
      });
      return;
    }

    const form = new FormData(event.currentTarget);
    setIsSubmitting(true);

    try {
      const response = await fetch("/auth/local", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: form.get("username"),
          password: form.get("password"),
          mac_address: context.mac,
        }),
      });
      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.error || "Không thể xác thực tài khoản.");
      }

      // After account login the MAC is authorised. Redirect to destination —
      // the NAS (Aruba/MikroTik) will complete authentication via RADIUS.
      const destination = context.destination && context.destination.startsWith("http")
        ? context.destination
        : "http://captive.apple.com";
      window.location.href = destination;
    } catch (error) {
      setNotice({
        title: "Đăng nhập chưa thành công",
        message: error instanceof Error ? error.message : "Vui lòng thử lại.",
        variant: "destructive",
      });
      setIsSubmitting(false);
    }
  }

  function continueWithGoogle() {
    const params = new URLSearchParams();
    if (context.mac) params.set("mac", context.mac);
    if (context.routerUrl) params.set("router_url", context.routerUrl);
    if (context.destination) params.set("dst", context.destination);

    window.location.assign(`/auth/google?${params.toString()}`);
  }

  return (
    <Card className="w-full min-w-0">
      <CardHeader>
        <Button variant="ghost" size="sm" className="-ml-2 w-fit" onClick={onBack}>
          <ArrowLeftIcon data-icon="inline-start" />
          Quay lại
        </Button>
        <div className="mt-4 flex size-11 items-center justify-center rounded-xl bg-primary text-primary-foreground">
          <LockKeyholeIcon aria-hidden="true" />
        </div>
        <CardTitle className="mt-4 text-2xl tracking-tight">Đăng nhập tài khoản</CardTitle>
        <CardDescription>
          Dùng tài khoản nội bộ hoặc Google đã được quản trị viên cấp quyền.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <NoticeAlert notice={notice} />
        <Button
          variant="outline"
          size="lg"
          className="h-11 w-full"
          disabled={isSubmitting}
          onClick={continueWithGoogle}
        >
          Đăng nhập với Google
        </Button>
        <form onSubmit={submitLocalLogin} noValidate>
          <FieldGroup>
            <FieldSeparator>hoặc dùng tài khoản nội bộ</FieldSeparator>
            <Field data-invalid={Boolean(notice)}>
              <FieldLabel htmlFor="username">Tài khoản</FieldLabel>
              <Input id="username" name="username" autoComplete="username" required />
              <FieldDescription>Thông tin do quản trị viên cung cấp.</FieldDescription>
            </Field>
            <Field data-invalid={Boolean(notice)}>
              <FieldLabel htmlFor="password">Mật khẩu</FieldLabel>
              <Input id="password" name="password" type="password" autoComplete="current-password" required />
              {notice ? <FieldError>{notice.message}</FieldError> : null}
            </Field>
            <Button type="submit" size="lg" className="h-11 w-full" disabled={isSubmitting}>
              {isSubmitting ? <Spinner data-icon="inline-start" /> : null}
              {isSubmitting ? "Đang xác thực" : "Đăng nhập"}
            </Button>
          </FieldGroup>
        </form>
      </CardContent>
      <CardFooter>
        <p className="text-sm leading-6 text-muted-foreground">
          Chỉ những tài khoản được cấp quyền mới có thể truy cập mạng.
        </p>
      </CardFooter>
    </Card>
  );
}

function PortalLogin() {
  const [context, setContext] = useState<PortalContext>(() => readPortalContext());
  const [view, setView] = useState<"choice" | "account" | "packages">(
    new URLSearchParams(window.location.search).get("mode") === "account" ? "account" : "choice",
  );
  const [notice, setNotice] = useState<Notice | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [packages, setPackages] = useState<Package[]>([]);
  const [selectedPackage, setSelectedPackage] = useState<number | null>(null);
  const [loadingPackages, setLoadingPackages] = useState(false);

  useEffect(() => {
    if (!context.mac) {
      fetch("/api/guest/client-info")
        .then((res) => res.json())
        .then((data: { mac?: string | null }) => {
          if (data?.mac) {
            setContext((prev) => ({ ...prev, mac: data.mac || "" }));
          }
        })
        .catch(() => {});
    }
  }, [context.mac]);

  function showAccount() {
    setNotice(null);
    setView("account");
    updateMode("account");
  }

  function showChoice() {
    setNotice(null);
    setView("choice");
    updateMode();
  }

  async function showPackages() {
    setNotice(null);
    setView("packages");
    setSelectedPackage(null);
    if (!packages.length) {
      setLoadingPackages(true);
      try {
        const res = await fetch("/api/packages");
        if (res.ok) {
          const data = await res.json() as Package[];
          setPackages(data.filter((p) => p.is_active));
        }
      } catch (_) {}
      setLoadingPackages(false);
    }
  }

  async function connectInstantly() {
    await showPackages();
  }

  async function connectWithPackage() {
    setNotice(null);
    setIsConnecting(true);
    try {
      const response = await fetch("/api/guest/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mac_address: context.mac || undefined,
          package_id: selectedPackage || undefined,
        }),
      });
      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.error || "Không thể cấp quyền truy cập.");
      }

      const destination = context.destination && context.destination.startsWith("http")
        ? context.destination
        : "http://captive.apple.com";
      window.location.href = destination;
    } catch (error) {
      setNotice({
        title: "Kết nối chưa thành công",
        message: error instanceof Error ? error.message : "Vui lòng thử lại.",
        variant: "destructive",
      });
      setIsConnecting(false);
    }
  }

  async function connectInstantly() {
    setNotice(null);
    setIsConnecting(true);
    try {
      const response = await fetch("/api/guest/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mac_address: context.mac || undefined }),
      });
      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.error || "Không thể cấp quyền truy cập.");
      }

      const destination = context.destination && context.destination.startsWith("http")
        ? context.destination
        : "http://captive.apple.com";
      window.location.href = destination;
    } catch (error) {
      setNotice({
        title: "Kết nối chưa thành công",
        message: error instanceof Error ? error.message : "Vui lòng thử lại.",
        variant: "destructive",
      });
      setIsConnecting(false);
    }
  }

  return (
    <PortalFrame>
      {view === "account" ? (
        <AccountLogin context={context} onBack={showChoice} />
      ) : view === "packages" ? (
        <Card className="w-full min-w-0">
          <CardHeader>
            <Button variant="ghost" size="sm" className="-ml-2 w-fit" onClick={showChoice}>
              <ArrowLeftIcon data-icon="inline-start" />
              Quay lại
            </Button>
            <div className="flex size-11 items-center justify-center rounded-xl bg-primary text-primary-foreground lg:hidden">
              <ShieldCheckIcon aria-hidden="true" />
            </div>
            <CardTitle className="mt-4 text-2xl tracking-tight">Chọn gói cước</CardTitle>
            <CardDescription>
              Chọn gói phù hợp với nhu cầu sử dụng của bạn.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <NoticeAlert notice={notice} />
            {loadingPackages ? (
              <div className="flex justify-center py-8">
                <Spinner />
              </div>
            ) : packages.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-4">
                Hiện không có gói cước nào khả dụng.
              </p>
            ) : (
              <div className="flex flex-col gap-3">
                {packages.map((pkg) => (
                  <button
                    key={pkg.id}
                    onClick={() => setSelectedPackage(pkg.id)}
                    className={`
                      w-full text-left p-4 rounded-lg border-2 transition-all cursor-pointer
                      ${selectedPackage === pkg.id
                        ? "border-primary bg-primary/5"
                        : "border-border hover:border-primary/50"}
                    `}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-semibold">{pkg.name}</span>
                      <div className={`
                        size-5 rounded-full border-2 flex items-center justify-center
                        ${selectedPackage === pkg.id ? "border-primary bg-primary" : "border-muted-foreground"}
                      `}>
                        {selectedPackage === pkg.id && (
                          <CheckCircle2Icon className="text-primary-foreground size-3" />
                        )}
                      </div>
                    </div>
                    <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                      <span>{pkg.duration_minutes} phút</span>
                      <span>↓ {pkg.bandwidth_down_kbps} kbps</span>
                      <span>↑ {pkg.bandwidth_up_kbps} kbps</span>
                      {pkg.quota_mb && <span>{pkg.quota_mb} MB</span>}
                    </div>
                  </button>
                ))}
              </div>
            )}
            <Button
              size="lg"
              className="h-11 w-full"
              onClick={connectWithPackage}
              disabled={isConnecting || !selectedPackage}
            >
              {isConnecting ? <Spinner data-icon="inline-start" /> : null}
              {isConnecting ? "Đang kết nối" : "Kết nối với gói đã chọn"}
            </Button>
          </CardContent>
          <CardFooter>
            <p className="text-sm leading-6 text-muted-foreground">
              Hoặc dùng{" "}
              <button className="text-primary underline-offset-2 hover:underline" onClick={connectInstantly}>
                Truy cập nhanh
              </button>{" "}
              để kết nối ngay với cấu hình mặc định.
            </p>
          </CardFooter>
        </Card>
      ) : (
        <Card className="w-full min-w-0">
          <CardHeader>
            <div className="flex size-11 items-center justify-center rounded-xl bg-primary text-primary-foreground lg:hidden">
              <WifiIcon aria-hidden="true" />
            </div>
            <CardTitle className="mt-4 text-2xl tracking-tight">Chào mừng bạn</CardTitle>
            <CardDescription>Chọn cách truy cập WiFi phù hợp với bạn.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-5">
            <NoticeAlert notice={notice} />
            <Button size="lg" className="h-11 w-full" onClick={connectInstantly} disabled={isConnecting}>
              {isConnecting ? <Spinner data-icon="inline-start" /> : null}
              {isConnecting ? "Đang kết nối" : "Truy cập ngay"}
            </Button>
            <Button variant="outline" size="lg" className="h-11 w-full" onClick={showAccount}>
              Đăng nhập tài khoản
            </Button>
          </CardContent>
          <CardFooter>
            <p className="text-sm leading-6 text-muted-foreground">
              Truy cập ngay sẽ cấp quyền tạm thời cho thiết bị này.
            </p>
          </CardFooter>
        </Card>
      )}
    </PortalFrame>
  );
}

function SuccessScreen() {
  const context = readPortalContext();

  function finish() {
    // After MAC is authorised the NAS (Aruba/MikroTik) will authenticate the
    // user via RADIUS. Redirect to the destination — no form POST needed.
    if (context.destination && context.destination.startsWith("http")) {
      window.location.assign(context.destination);
    } else {
      window.location.assign("http://captive.apple.com");
    }
  }

  return (
    <PortalFrame>
      <Card className="w-full min-w-0">
        <CardHeader>
          <div className="flex size-11 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            <CheckCircle2Icon aria-hidden="true" />
          </div>
          <CardTitle className="mt-4 text-2xl tracking-tight">Kết nối thành công</CardTitle>
          <CardDescription>
            Thiết bị của bạn đã được xác thực và cấp quyền truy cập mạng Internet.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <Button size="lg" className="h-11 w-full" onClick={finish}>
            Bắt đầu lướt web
          </Button>
        </CardContent>
      </Card>
    </PortalFrame>
  );
}

function ErrorScreen() {
  const error = new URLSearchParams(window.location.search).get("error");
  const messages: Record<string, string> = {
    invalid_oauth_state: "Phiên đăng nhập Google đã hết hạn. Hãy bắt đầu lại từ portal.",
    oauth_failed: "Google chưa thể xác thực tài khoản. Vui lòng thử lại.",
    oauth_not_configured: "Đăng nhập Google chưa được cấu hình trên máy chủ.",
    unauthorized: "Tài khoản Google này chưa được cấp quyền truy cập WiFi.",
  };

  return (
    <PortalFrame>
      <Card className="w-full min-w-0">
        <CardHeader>
          <div className="flex size-11 items-center justify-center rounded-xl bg-destructive/10 text-destructive">
            <CircleAlertIcon aria-hidden="true" />
          </div>
          <CardTitle className="mt-4 text-2xl tracking-tight">Không thể đăng nhập</CardTitle>
          <CardDescription>{messages[error || ""] || "Vui lòng thử lại từ trang portal."}</CardDescription>
        </CardHeader>
        <CardContent>
          <Button size="lg" className="h-11 w-full" onClick={() => window.location.assign("/")}>
            Quay lại portal
          </Button>
        </CardContent>
      </Card>
    </PortalFrame>
  );
}

export default function App() {
  if (window.location.pathname.endsWith("success.html")) return <SuccessScreen />;
  if (window.location.pathname.endsWith("error.html")) return <ErrorScreen />;
  return <PortalLogin />;
}
