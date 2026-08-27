import { FormEvent, useState } from "react";
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
};

type Notice = {
  message: string;
  title: string;
  variant: "default" | "destructive";
};

function readPortalContext(): PortalContext {
  const params = new URLSearchParams(window.location.search);

  return {
    mac: params.get("mac") || params.get("mac-address") || "",
    routerUrl:
      params.get("link-login-only") || params.get("link-login") || params.get("router_url") || "",
    destination: params.get("dst") || params.get("orig") || "",
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

function postLoginToRouter(context: PortalContext) {
  if (!context.routerUrl) {
    window.location.assign("/");
    return;
  }

  const form = document.createElement("form");
  form.method = "post";
  form.action = context.routerUrl;

  [
    ["username", context.mac],
    ["password", context.mac],
    ["dst", context.destination],
  ].forEach(([name, value]) => {
    if (!value) return;
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = name;
    input.value = value;
    form.appendChild(input);
  });

  document.body.appendChild(form);
  form.submit();
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

      postLoginToRouter(context);
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
        <Button variant="outline" size="lg" className="h-11 w-full" onClick={continueWithGoogle}>
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
  const context = readPortalContext();
  const [view, setView] = useState<"choice" | "account">(
    new URLSearchParams(window.location.search).get("mode") === "account" ? "account" : "choice",
  );
  const [notice, setNotice] = useState<Notice | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);

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

  async function connectInstantly() {
    setNotice(null);
    if (!context.mac) {
      setNotice({
        title: "Không nhận được thiết bị",
        message: "Hãy mở portal từ trang chuyển hướng của router để tiếp tục.",
        variant: "destructive",
      });
      return;
    }

    setIsConnecting(true);
    try {
      const response = await fetch("/api/guest/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mac_address: context.mac }),
      });
      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.error || "Không thể cấp quyền truy cập.");
      }

      postLoginToRouter(context);
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

  return (
    <PortalFrame>
      <Card className="w-full min-w-0">
        <CardHeader>
          <div className="flex size-11 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            <CheckCircle2Icon aria-hidden="true" />
          </div>
          <CardTitle className="mt-4 text-2xl tracking-tight">Xác thực thành công</CardTitle>
          <CardDescription>
            Google đã xác nhận tài khoản của bạn. Hoàn tất bước cuối để kết nối thiết bị.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {context.routerUrl ? (
            <Button size="lg" className="h-11 w-full" onClick={() => postLoginToRouter(context)}>
              Hoàn tất kết nối
            </Button>
          ) : (
            <Alert>
              <CircleAlertIcon aria-hidden="true" />
              <AlertTitle>Thiết bị đã được xác thực</AlertTitle>
              <AlertDescription>Hãy quay lại trang portal của router để bắt đầu kết nối.</AlertDescription>
            </Alert>
          )}
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
