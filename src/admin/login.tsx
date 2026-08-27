import { type FormEvent, useState } from "react";
import { createRoot } from "react-dom/client";
import { CircleAlertIcon, LockKeyholeIcon, ShieldCheckIcon, WifiIcon } from "lucide-react";

import { ApiError, apiRequest } from "./api";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import "@/styles.css";
import "./styles.css";

type LoginResponse = { success: boolean; username: string };

function AdminLogin() {
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    const form = new FormData(event.currentTarget);
    setIsSubmitting(true);

    try {
      await apiRequest<LoginResponse>("/auth/login", {
        method: "POST",
        body: JSON.stringify({
          username: form.get("username"),
          password: form.get("password"),
        }),
      });
      window.location.assign("/admin");
    } catch (caughtError) {
      setError(caughtError instanceof ApiError ? caughtError.message : "Không thể kết nối đến máy chủ.");
      setIsSubmitting(false);
    }
  }

  return (
    <main className="flex min-h-[100dvh] items-center justify-center bg-background px-5 py-10 sm:px-8">
      <Card className="w-full max-w-md">
        <CardHeader className="gap-4">
          <div className="flex size-11 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            <WifiIcon aria-hidden="true" />
          </div>
          <div className="flex flex-col gap-1.5">
            <CardTitle className="text-2xl tracking-tight">Quản trị WiFi Portal</CardTitle>
            <CardDescription>Đăng nhập để quản lý truy cập, thiết bị và tài khoản.</CardDescription>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          {error ? (
            <Alert variant="destructive">
              <CircleAlertIcon aria-hidden="true" />
              <AlertTitle>Đăng nhập chưa thành công</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          <form onSubmit={handleSubmit} noValidate>
            <FieldGroup>
              <Field data-invalid={Boolean(error)}>
                <FieldLabel htmlFor="username">Tài khoản</FieldLabel>
                <Input id="username" name="username" autoComplete="username" autoFocus required />
              </Field>
              <Field data-invalid={Boolean(error)}>
                <FieldLabel htmlFor="password">Mật khẩu</FieldLabel>
                <Input id="password" name="password" type="password" autoComplete="current-password" required />
                {error ? <FieldError>{error}</FieldError> : null}
              </Field>
              <Button type="submit" size="lg" className="h-11 w-full" disabled={isSubmitting}>
                {isSubmitting ? <Spinner data-icon="inline-start" /> : <LockKeyholeIcon data-icon="inline-start" />}
                {isSubmitting ? "Đang đăng nhập" : "Đăng nhập"}
              </Button>
            </FieldGroup>
          </form>
        </CardContent>
        <CardFooter className="flex items-center gap-2 text-sm text-muted-foreground">
          <ShieldCheckIcon aria-hidden="true" />
          Chỉ dành cho quản trị viên được ủy quyền.
        </CardFooter>
      </Card>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<AdminLogin />);
