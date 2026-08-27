import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import {
  type LucideIcon,
  CircleAlertIcon,
  DatabaseBackupIcon,
  GaugeIcon,
  KeyRoundIcon,
  LaptopMinimalIcon,
  LogOutIcon,
  NetworkIcon,
  RefreshCwIcon,
  SettingsIcon,
  ShieldCheckIcon,
  Trash2Icon,
  UserCogIcon,
  UserPlusIcon,
  UsersIcon,
  WifiIcon,
  XIcon,
  CheckCircleIcon,
  XCircleIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  CopyIcon,
  CheckIcon,
  TerminalIcon,
  BookOpenIcon,
} from "lucide-react";

import { ApiError, apiRequest } from "./api";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
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
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { toast, Toaster } from "@/components/ui/toast";

type View = "overview" | "sessions" | "devices" | "access" | "accounts" | "packages" | "backup" | "settings";

type Admin = { id: number; username: string; lastLogin: string | null };
type Stats = { users: number; activeSessions: number; todayData: number; bandwidth: number };
type Session = {
  id: number;
  username: string;
  mac_address: string;
  start_time: string | null;
  quota_used_mb: number | null;
};
type Device = {
  mac_address: string;
  username: string | null;
  is_online: number | boolean;
  last_seen: string | null;
};
type PortalUser = {
  id: number;
  identifier: string;
  type: string;
  max_devices: number;
  is_active: number | boolean;
};
type Package = {
  id: number;
  name: string;
  duration_minutes: number;
  quota_mb: number | null;
  bandwidth_down_kbps: number;
  bandwidth_up_kbps: number;
  max_devices: number;
};
type MacAuthorization = {
  mac: string;
  username: string | null;
  access_type: "account" | "instant";
  connected_at: string;
  expires_at: string;
};
type OAuthAuthorization = { id: number; google_email: string; created_at?: string };
type DataState = {
  stats: Stats;
  sessions: Session[];
  devices: Device[];
  users: PortalUser[];
  packages: Package[];
  macAuthorizations: MacAuthorization[];
};

type PendingAction = { title: string; description: string; action: () => Promise<void> };

type SettingsConfig = {
  radius: {
    sharedSecretConfigured: boolean;
    authPort: number;
    accountingPort: number;
    coaPort: number;
    serverIp?: string;
  };
  portalUrl?: string;
  oauth: {
    clientIdConfigured: boolean;
    callbackUrl: string;
  };
};

type TestResult = {
  success: boolean;
  message: string;
  configured?: boolean;
  callbackUrl?: string;
};

const emptyData: DataState = {
  stats: { users: 0, activeSessions: 0, todayData: 0, bandwidth: 0 },
  sessions: [],
  devices: [],
  users: [],
  packages: [],
  macAuthorizations: [],
};

const navigation: Array<{ id: View; label: string; icon: LucideIcon }> = [
  { id: "overview", label: "Tổng quan", icon: GaugeIcon },
  { id: "sessions", label: "Phiên kết nối", icon: NetworkIcon },
  { id: "devices", label: "Thiết bị", icon: LaptopMinimalIcon },
  { id: "access", label: "Quyền MAC", icon: KeyRoundIcon },
  { id: "accounts", label: "Tài khoản", icon: UsersIcon },
  { id: "packages", label: "Gói cước", icon: ShieldCheckIcon },
  { id: "backup", label: "Sao lưu", icon: DatabaseBackupIcon },
  { id: "settings", label: "Cài đặt", icon: SettingsIcon },
];

const viewCopy: Record<View, { title: string; description: string }> = {
  overview: {
    title: "Tổng quan",
    description: "Theo dõi trạng thái truy cập WiFi trong thời gian thực.",
  },
  sessions: {
    title: "Phiên kết nối",
    description: "Các phiên đang được RADIUS ghi nhận là hoạt động.",
  },
  devices: {
    title: "Thiết bị",
    description: "Thiết bị đã từng đăng ký và trạng thái kết nối gần nhất.",
  },
  access: {
    title: "Quyền MAC",
    description: "Quyền truy cập tạm thời mà RADIUS chấp nhận cho mỗi thiết bị.",
  },
  accounts: {
    title: "Tài khoản",
    description: "Tạo, khóa và cấp quyền Google OAuth cho tài khoản khách.",
  },
  packages: {
    title: "Gói cước",
    description: "Danh sách gói đang được mở bán cho portal.",
  },
  backup: {
    title: "Sao lưu",
    description: "Tạo một bản sao lưu cơ sở dữ liệu theo yêu cầu.",
  },
  settings: {
    title: "Cài đặt",
    description: "Cấu hình kết nối Router và Google OAuth.",
  },
};

function formatBytes(bytes: number | null | undefined) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${Number((bytes / 1024 ** index).toFixed(1))} ${units[index]}`;
}

function formatDate(value: string | null | undefined) {
  if (!value) return "Chưa có";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Chưa có" : date.toLocaleString("vi-VN");
}

function formatElapsed(startTime: string | null) {
  if (!startTime) return "Chưa có";
  const startedAt = new Date(startTime).getTime();
  if (Number.isNaN(startedAt)) return "Chưa có";
  const minutes = Math.max(0, Math.floor((Date.now() - startedAt) / 60000));
  if (minutes < 60) return `${minutes} phút`;
  const hours = Math.floor(minutes / 60);
  return `${hours} giờ ${minutes % 60} phút`;
}

function formatMinutes(minutes: number) {
  if (minutes < 60) return `${minutes} phút`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours} giờ ${remainder} phút` : `${hours} giờ`;
}

function isActive(value: number | boolean) {
  return value === true || value === 1;
}

function StatCard({
  label,
  value,
  description,
  icon: Icon,
}: {
  label: string;
  value: string | number;
  description: string;
  icon: LucideIcon;
}) {
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <CardDescription>{label}</CardDescription>
          <CardTitle className="text-2xl tracking-tight">{value}</CardTitle>
        </div>
        <div className="flex size-9 items-center justify-center rounded-lg bg-secondary text-secondary-foreground">
          <Icon aria-hidden="true" />
        </div>
      </CardHeader>
      <CardFooter className="text-sm text-muted-foreground">{description}</CardFooter>
    </Card>
  );
}

function LoadingCards() {
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {Array.from({ length: 4 }, (_, index) => (
        <Card key={index}>
          <CardHeader className="gap-3">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-8 w-20" />
          </CardHeader>
          <CardFooter><Skeleton className="h-4 w-36" /></CardFooter>
        </Card>
      ))}
    </div>
  );
}

function NoRecords({ title, description }: { title: string; description: string }) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon"><DatabaseBackupIcon aria-hidden="true" /></EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent />
    </Empty>
  );
}

function CodeSnippet({ code, label }: { code: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    void navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="relative rounded-lg bg-zinc-950 text-zinc-100 p-4 font-mono text-xs overflow-x-auto my-2 border border-zinc-800">
      {label && <div className="text-[11px] text-zinc-400 font-sans mb-2 font-medium">{label}</div>}
      <button
        type="button"
        onClick={handleCopy}
        className="absolute top-3 right-3 flex items-center gap-1.5 px-2.5 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 hover:text-white transition-colors text-xs"
        title="Sao chép lệnh"
      >
        {copied ? <CheckIcon className="size-3 text-emerald-400" /> : <CopyIcon className="size-3" />}
        <span>{copied ? "Đã sao chép!" : "Sao chép"}</span>
      </button>
      <pre className="whitespace-pre-wrap break-all pr-20 font-mono leading-relaxed select-all">{code}</pre>
    </div>
  );
}

function CollapsibleCard({ title, children, defaultOpen = false }: { title: string; children: React.ReactNode; defaultOpen?: boolean }) {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  return (
    <div className="rounded-lg border">
      <button
        type="button"
        className="flex w-full items-center justify-between p-4 text-left hover:bg-muted/50 transition-colors"
        onClick={() => setIsOpen(!isOpen)}
      >
        <span className="font-medium">{title}</span>
        {isOpen ? <ChevronUpIcon className="size-4" /> : <ChevronDownIcon className="size-4" />}
      </button>
      {isOpen && <div className="border-t p-4">{children}</div>}
    </div>
  );
}

function AdminApp() {
  const [view, setView] = useState<View>("overview");
  const [admin, setAdmin] = useState<Admin | null>(null);
  const [data, setData] = useState<DataState>(emptyData);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [pageError, setPageError] = useState("");
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [isActionRunning, setIsActionRunning] = useState(false);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [googleDialogUser, setGoogleDialogUser] = useState<PortalUser | null>(null);
  const [googleAuthorizations, setGoogleAuthorizations] = useState<OAuthAuthorization[]>([]);
  const [googleEmail, setGoogleEmail] = useState("");
  const [isGoogleLoading, setIsGoogleLoading] = useState(false);
  const [isGoogleSaving, setIsGoogleSaving] = useState(false);
  const [backupMessage, setBackupMessage] = useState("");
  const [isBackingUp, setIsBackingUp] = useState(false);

  // Settings state
  const [settingsConfig, setSettingsConfig] = useState<SettingsConfig | null>(null);
  const [isSettingsLoading, setIsSettingsLoading] = useState(false);
  const [radiusTestResult, setRadiusTestResult] = useState<TestResult | null>(null);
  const [isRadiusTesting, setIsRadiusTesting] = useState(false);
  const [oauthTestResult, setOauthTestResult] = useState<TestResult | null>(null);
  const [isOauthTesting, setIsOauthTesting] = useState(false);
  const [radiusTestInput, setRadiusTestInput] = useState({ routerIp: "", sharedSecret: "", authPort: 1812 });

  const loadData = useCallback(async (showRefreshState = false) => {
    if (showRefreshState) setIsRefreshing(true);
    setPageError("");

    try {
      const [stats, sessions, devices, users, packages, macAuthorizations] = await Promise.all([
        apiRequest<Stats>("/admin/api/stats"),
        apiRequest<Session[]>("/api/sessions"),
        apiRequest<Device[]>("/api/devices"),
        apiRequest<PortalUser[]>("/api/users"),
        apiRequest<Package[]>("/api/packages"),
        apiRequest<MacAuthorization[]>("/api/guest/whitelist"),
      ]);
      setData({ stats, sessions, devices, users, packages, macAuthorizations });
    } catch (caughtError) {
      if (caughtError instanceof ApiError && caughtError.status === 401) {
        window.location.replace("/admin/login");
        return;
      }
      setPageError(caughtError instanceof Error ? caughtError.message : "Không thể tải dữ liệu quản trị.");
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  }, []);

  // Load settings config when entering settings view
  const loadSettings = useCallback(async () => {
    setIsSettingsLoading(true);
    try {
      const config = await apiRequest<SettingsConfig>("/admin/api/settings");
      setSettingsConfig(config);
      // Pre-fill radius test inputs with current config
      setRadiusTestInput((prev) => ({
        ...prev,
        authPort: config.radius.authPort,
      }));
    } catch (caughtError) {
      toast.add({
        title: "Không thể tải cài đặt",
        description: caughtError instanceof Error ? caughtError.message : "Vui lòng thử lại.",
        type: "error",
      });
    } finally {
      setIsSettingsLoading(false);
    }
  }, []);

  useEffect(() => {
    async function initialize() {
      try {
        const profile = await apiRequest<Admin>("/auth/me");
        setAdmin(profile);
        await loadData();
      } catch (caughtError) {
        if (caughtError instanceof ApiError && caughtError.status === 401) {
          window.location.replace("/admin/login");
          return;
        }
        setPageError(caughtError instanceof Error ? caughtError.message : "Không thể xác thực quản trị viên.");
        setIsLoading(false);
      }
    }

    void initialize();
  }, [loadData]);

  useEffect(() => {
    if (!admin) return undefined;
    const interval = window.setInterval(() => void loadData(), 30000);
    return () => window.clearInterval(interval);
  }, [admin, loadData]);

  // Load settings when entering settings view
  useEffect(() => {
    if (view === "settings" && !settingsConfig) {
      void loadSettings();
    }
  }, [view, settingsConfig, loadSettings]);

  const recentSessions = useMemo(() => data.sessions.slice(0, 6), [data.sessions]);

  function queueAction(title: string, description: string, action: () => Promise<void>) {
    setPendingAction({ title, description, action });
  }

  async function runPendingAction() {
    if (!pendingAction) return;
    setIsActionRunning(true);
    try {
      await pendingAction.action();
      setPendingAction(null);
    } catch (caughtError) {
      toast.add({
        title: "Không thể hoàn tất",
        description: caughtError instanceof Error ? caughtError.message : "Vui lòng thử lại.",
        type: "error",
      });
    } finally {
      setIsActionRunning(false);
    }
  }

  async function handleLogout() {
    try {
      await apiRequest<{ success: boolean }>("/auth/logout", { method: "POST" });
    } finally {
      window.location.assign("/admin/login");
    }
  }

  async function openGoogleDialog(user: PortalUser) {
    setGoogleDialogUser(user);
    setGoogleEmail("");
    setGoogleAuthorizations([]);
    setIsGoogleLoading(true);
    try {
      setGoogleAuthorizations(await apiRequest<OAuthAuthorization[]>(`/api/users/${user.id}/whitelist`));
    } catch (caughtError) {
      toast.add({
        title: "Không thể tải danh sách Google",
        description: caughtError instanceof Error ? caughtError.message : "Vui lòng thử lại.",
        type: "error",
      });
    } finally {
      setIsGoogleLoading(false);
    }
  }

  async function saveGoogleAuthorization(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!googleDialogUser) return;
    setIsGoogleSaving(true);
    try {
      await apiRequest<{ success: boolean }>(`/api/users/${googleDialogUser.id}/whitelist`, {
        method: "POST",
        body: JSON.stringify({ google_email: googleEmail }),
      });
      setGoogleAuthorizations(await apiRequest<OAuthAuthorization[]>(`/api/users/${googleDialogUser.id}/whitelist`));
      setGoogleEmail("");
      toast.add({
        title: "Đã cấp quyền Google",
        description: "Tài khoản có thể đăng nhập qua Google OAuth.",
        type: "success",
      });
    } catch (caughtError) {
      toast.add({
        title: "Không thể cấp quyền Google",
        description: caughtError instanceof Error ? caughtError.message : "Vui lòng thử lại.",
        type: "error",
      });
    } finally {
      setIsGoogleSaving(false);
    }
  }

  async function revokeGoogleAuthorization(email: string) {
    if (!googleDialogUser) return;
    await apiRequest<{ success: boolean }>(`/api/users/${googleDialogUser.id}/whitelist/${encodeURIComponent(email)}`, { method: "DELETE" });
    setGoogleAuthorizations((entries) => entries.filter((entry) => entry.google_email !== email));
    toast.add({ title: "Đã thu hồi quyền Google", type: "success" });
  }

  async function createBackup() {
    setIsBackingUp(true);
    setBackupMessage("");
    try {
      const result = await apiRequest<{ success: boolean; message: string }>("/admin/api/backup", { method: "POST" });
      setBackupMessage(result.message);
      toast.add({ title: "Sao lưu hoàn tất", description: result.message, type: "success" });
    } catch (caughtError) {
      const message = caughtError instanceof Error ? caughtError.message : "Sao lưu thất bại.";
      setBackupMessage(message);
      toast.add({ title: "Sao lưu thất bại", description: message, type: "error" });
    } finally {
      setIsBackingUp(false);
    }
  }

  // Settings test functions
  async function testRadiusConnection() {
    setIsRadiusTesting(true);
    setRadiusTestResult(null);
    try {
      const result = await apiRequest<TestResult>("/admin/api/settings/test-radius", {
        method: "POST",
        body: JSON.stringify({
          routerIp: radiusTestInput.routerIp,
          sharedSecret: radiusTestInput.sharedSecret,
          authPort: radiusTestInput.authPort,
          coaPort: settingsConfig?.radius.coaPort || 3799,
        }),
      });
      setRadiusTestResult(result);
    } catch (caughtError) {
      setRadiusTestResult({
        success: false,
        message: caughtError instanceof Error ? caughtError.message : "Lỗi kết nối",
      });
    } finally {
      setIsRadiusTesting(false);
    }
  }

  async function testOauthConnection() {
    setIsOauthTesting(true);
    setOauthTestResult(null);
    try {
      const result = await apiRequest<TestResult>("/admin/api/settings/test-oauth", {
        method: "POST",
      });
      setOauthTestResult(result);
    } catch (caughtError) {
      setOauthTestResult({
        success: false,
        message: caughtError instanceof Error ? caughtError.message : "Lỗi kết nối",
      });
    } finally {
      setIsOauthTesting(false);
    }
  }

  const currentView = viewCopy[view];

  return (
    <Toaster>
      <div className="min-h-[100dvh] bg-background md:grid md:grid-cols-[15rem_minmax(0,1fr)]">
        <DesktopNavigation admin={admin} view={view} onChangeView={setView} onLogout={() => void handleLogout()} />
        <main className="min-w-0">
          <PageHeader
            view={view}
            copy={currentView}
            isLoading={isLoading}
            isRefreshing={isRefreshing}
            onChangeView={setView}
            onLogout={() => void handleLogout()}
            onRefresh={() => void loadData(true)}
          />
          <div className="flex flex-col gap-6 p-5 sm:p-8">
            {pageError ? <LoadError message={pageError} /> : null}
            {view === "overview" ? <Overview data={data} isLoading={isLoading} sessions={recentSessions} onSelectSessions={() => setView("sessions")} /> : null}
            {view === "sessions" ? <SessionsView sessions={data.sessions} isLoading={isLoading} onTerminate={(session) => queueAction("Ngắt phiên kết nối?", `Phiên của ${session.username} sẽ bị kết thúc ngay.`, async () => {
              await apiRequest<{ success: boolean }>(`/api/sessions/${session.id}`, { method: "DELETE" });
              await loadData(true);
              toast.add({ title: "Đã ngắt phiên kết nối", type: "success" });
            })} /> : null}
            {view === "devices" ? <DevicesView devices={data.devices} isLoading={isLoading} onDisconnect={(device) => queueAction("Ngắt thiết bị?", `Thiết bị ${device.mac_address} sẽ bị đưa về trạng thái ngoại tuyến.`, async () => {
              await apiRequest<{ success: boolean }>(`/api/devices/${encodeURIComponent(device.mac_address)}`, { method: "DELETE" });
              await loadData(true);
              toast.add({ title: "Đã ngắt thiết bị", type: "success" });
            })} /> : null}
            {view === "access" ? <AccessView entries={data.macAuthorizations} isLoading={isLoading} onRevoke={(entry) => queueAction("Thu hồi quyền MAC?", `Thiết bị ${entry.mac} sẽ không thể truy cập khi gửi yêu cầu RADIUS kế tiếp.`, async () => {
              await apiRequest<{ success: boolean }>(`/api/guest/whitelist/${encodeURIComponent(entry.mac)}`, { method: "DELETE" });
              await loadData(true);
              toast.add({ title: "Đã thu hồi quyền MAC", type: "success" });
            })} /> : null}
            {view === "accounts" ? <AccountsView
              users={data.users}
              isLoading={isLoading}
              createDialogOpen={createDialogOpen}
              setCreateDialogOpen={setCreateDialogOpen}
              onCreate={async (event) => {
                event.preventDefault();
                const form = new FormData(event.currentTarget);
                try {
                  await apiRequest<{ id: number }>("/api/users", {
                    method: "POST",
                    body: JSON.stringify({
                      username: form.get("username"),
                      password: form.get("password"),
                      max_devices: Number(form.get("max_devices")),
                    }),
                  });
                  setCreateDialogOpen(false);
                  await loadData(true);
                  toast.add({ title: "Đã tạo tài khoản", type: "success" });
                } catch (caughtError) {
                  toast.add({
                    title: "Không thể tạo tài khoản",
                    description: caughtError instanceof Error ? caughtError.message : "Vui lòng thử lại.",
                    type: "error",
                  });
                }
              }}
              onOpenGoogle={(user) => void openGoogleDialog(user)}
              onToggle={(user) => queueAction(
                isActive(user.is_active) ? "Khóa tài khoản?" : "Mở khóa tài khoản?",
                `Tài khoản ${user.identifier} sẽ ${isActive(user.is_active) ? "không" : ""} thể sử dụng để đăng nhập.`,
                async () => {
                  await apiRequest<{ success: boolean }>(`/api/users/${user.id}`, {
                    method: "PUT",
                    body: JSON.stringify({ is_active: !isActive(user.is_active) }),
                  });
                  await loadData(true);
                  toast.add({ title: isActive(user.is_active) ? "Đã khóa tài khoản" : "Đã mở khóa tài khoản", type: "success" });
                },
              )}
              onDelete={(user) => queueAction("Xóa tài khoản?", `Tài khoản ${user.identifier} sẽ bị xóa vĩnh viễn.`, async () => {
                await apiRequest<{ success: boolean }>(`/api/users/${user.id}`, { method: "DELETE" });
                await loadData(true);
                toast.add({ title: "Đã xóa tài khoản", type: "success" });
              })}
            /> : null}
            {view === "packages" ? <PackagesView packages={data.packages} isLoading={isLoading} /> : null}
            {view === "backup" ? <BackupView isBackingUp={isBackingUp} message={backupMessage} onCreate={() => void createBackup()} /> : null}
            {view === "settings" ? <SettingsView
              config={settingsConfig}
              isLoading={isSettingsLoading}
              radiusTestResult={radiusTestResult}
              isRadiusTesting={isRadiusTesting}
              oauthTestResult={oauthTestResult}
              isOauthTesting={isOauthTesting}
              radiusTestInput={radiusTestInput}
              onRadiusTestInputChange={setRadiusTestInput}
              onTestRadius={() => void testRadiusConnection()}
              onTestOauth={() => void testOauthConnection()}
              onRefresh={() => void loadSettings()}
            /> : null}
          </div>
        </main>
      </div>

      <GoogleAuthorizationDialog
        user={googleDialogUser}
        entries={googleAuthorizations}
        email={googleEmail}
        isLoading={isGoogleLoading}
        isSaving={isGoogleSaving}
        onEmailChange={setGoogleEmail}
        onOpenChange={(open) => { if (!open) setGoogleDialogUser(null); }}
        onSubmit={saveGoogleAuthorization}
        onRevoke={(email) => void revokeGoogleAuthorization(email)}
      />

      <AlertDialog open={Boolean(pendingAction)} onOpenChange={(open) => { if (!open && !isActionRunning) setPendingAction(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogMedia><CircleAlertIcon aria-hidden="true" /></AlertDialogMedia>
            <AlertDialogTitle>{pendingAction?.title}</AlertDialogTitle>
            <AlertDialogDescription>{pendingAction?.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Hủy</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={isActionRunning} onClick={() => void runPendingAction()}>
              {isActionRunning ? <Spinner data-icon="inline-start" /> : <Trash2Icon data-icon="inline-start" />}
              Xác nhận
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Toaster>
  );
}

function DesktopNavigation({ admin, view, onChangeView, onLogout }: { admin: Admin | null; view: View; onChangeView: (view: View) => void; onLogout: () => void }) {
  return (
    <aside className="hidden min-h-[100dvh] border-r bg-card md:flex md:flex-col">
      <div className="flex items-center gap-3 px-5 py-5">
        <div className="flex size-9 items-center justify-center rounded-lg bg-primary text-primary-foreground"><WifiIcon aria-hidden="true" /></div>
        <div className="min-w-0"><p className="truncate text-sm font-semibold">WiFi Portal</p><p className="truncate text-xs text-muted-foreground">Quản trị hệ thống</p></div>
      </div>
      <Separator />
      <nav className="flex flex-1 flex-col gap-1 p-3" aria-label="Điều hướng quản trị">
        {navigation.map((item) => {
          const Icon = item.icon;
          return <Button key={item.id} variant={view === item.id ? "secondary" : "ghost"} className="w-full justify-start" onClick={() => onChangeView(item.id)}><Icon data-icon="inline-start" aria-hidden="true" />{item.label}</Button>;
        })}
      </nav>
      <Separator />
      <div className="flex flex-col gap-3 p-4"><div className="min-w-0"><p className="truncate text-sm font-medium">{admin?.username || "Quản trị viên"}</p><p className="truncate text-xs text-muted-foreground">Đăng nhập {formatDate(admin?.lastLogin)}</p></div><Button variant="outline" className="w-full justify-start" onClick={onLogout}><LogOutIcon data-icon="inline-start" />Đăng xuất</Button></div>
    </aside>
  );
}

function PageHeader({ view, copy, isLoading, isRefreshing, onChangeView, onLogout, onRefresh }: { view: View; copy: { title: string; description: string }; isLoading: boolean; isRefreshing: boolean; onChangeView: (view: View) => void; onLogout: () => void; onRefresh: () => void }) {
  return <header className="border-b bg-card"><div className="flex flex-col gap-4 px-5 py-4 sm:px-8 md:hidden"><div className="flex items-center justify-between gap-4"><div className="flex items-center gap-3"><div className="flex size-9 items-center justify-center rounded-lg bg-primary text-primary-foreground"><WifiIcon aria-hidden="true" /></div><span className="font-semibold">WiFi Portal</span></div><Button variant="outline" size="sm" onClick={onLogout}><LogOutIcon data-icon="inline-start" />Thoát</Button></div><nav className="flex gap-2 overflow-x-auto pb-1" aria-label="Điều hướng quản trị di động">{navigation.map((item) => { const Icon = item.icon; return <Button key={item.id} variant={view === item.id ? "secondary" : "outline"} size="sm" onClick={() => onChangeView(item.id)}><Icon data-icon="inline-start" aria-hidden="true" />{item.label}</Button>; })}</nav></div><div className="flex flex-wrap items-start justify-between gap-4 px-5 py-5 sm:px-8"><div className="min-w-0"><h1 className="text-2xl font-semibold tracking-tight">{copy.title}</h1><p className="mt-1 text-sm text-muted-foreground">{copy.description}</p></div><Button variant="outline" onClick={onRefresh} disabled={isRefreshing || isLoading}>{isRefreshing ? <Spinner data-icon="inline-start" /> : <RefreshCwIcon data-icon="inline-start" />}Làm mới</Button></div></header>;
}

function LoadError({ message }: { message: string }) {
  return <Alert variant="destructive"><CircleAlertIcon aria-hidden="true" /><AlertTitle>Không thể tải dữ liệu</AlertTitle><AlertDescription>{message}</AlertDescription></Alert>;
}

function Overview({ data, isLoading, sessions, onSelectSessions }: { data: DataState; isLoading: boolean; sessions: Session[]; onSelectSessions: () => void }) {
  if (isLoading) return <LoadingCards />;
  return <div className="flex flex-col gap-6"><div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4"><StatCard label="Tài khoản" value={data.stats.users} description="Tổng số tài khoản portal" icon={UsersIcon} /><StatCard label="Đang trực tuyến" value={data.stats.activeSessions} description="Phiên RADIUS đang hoạt động" icon={WifiIcon} /><StatCard label="Dữ liệu hôm nay" value={formatBytes(data.stats.todayData)} description="Lưu lượng từ phiên hiện tại" icon={GaugeIcon} /><StatCard label="Băng thông ước tính" value={`${data.stats.bandwidth} Mbps`} description="Theo số phiên đang hoạt động" icon={NetworkIcon} /></div><Card><CardHeader className="flex-row items-start justify-between gap-4"><div className="flex flex-col gap-1.5"><CardTitle>Phiên hoạt động gần đây</CardTitle><CardDescription>Những kết nối đang được RADIUS giữ hoạt động.</CardDescription></div><Button variant="outline" size="sm" onClick={onSelectSessions}>Xem tất cả</Button></CardHeader><CardContent>{sessions.length ? <SessionTable sessions={sessions} /> : <NoRecords title="Chưa có phiên hoạt động" description="Phiên mới sẽ xuất hiện tại đây khi người dùng truy cập mạng." />}</CardContent></Card></div>;
}

function SessionTable({ sessions, onTerminate }: { sessions: Session[]; onTerminate?: (session: Session) => void }) {
  return <Table><TableCaption className="sr-only">Danh sách phiên kết nối đang hoạt động.</TableCaption><TableHeader><TableRow><TableHead>Người dùng</TableHead><TableHead>MAC</TableHead><TableHead>Bắt đầu</TableHead><TableHead>Thời lượng</TableHead><TableHead>Dữ liệu</TableHead>{onTerminate ? <TableHead>Thao tác</TableHead> : null}</TableRow></TableHeader><TableBody>{sessions.map((session) => <TableRow key={session.id}><TableCell className="font-medium">{session.username}</TableCell><TableCell className="font-mono text-xs">{session.mac_address}</TableCell><TableCell>{formatDate(session.start_time)}</TableCell><TableCell>{formatElapsed(session.start_time)}</TableCell><TableCell>{formatBytes((session.quota_used_mb || 0) * 1024 * 1024)}</TableCell>{onTerminate ? <TableCell><Button variant="destructive" size="sm" onClick={() => onTerminate(session)}>Ngắt phiên</Button></TableCell> : null}</TableRow>)}</TableBody></Table>;
}

function SessionsView({ sessions, isLoading, onTerminate }: { sessions: Session[]; isLoading: boolean; onTerminate: (session: Session) => void }) {
  return <Card><CardHeader><CardTitle>Phiên đang hoạt động</CardTitle><CardDescription>Ngắt phiên sẽ yêu cầu hệ thống kết thúc kết nối tương ứng.</CardDescription></CardHeader><CardContent>{isLoading ? <Skeleton className="h-40 w-full" /> : sessions.length ? <SessionTable sessions={sessions} onTerminate={onTerminate} /> : <NoRecords title="Không có phiên hoạt động" description="Không có người dùng nào đang trực tuyến." />}</CardContent></Card>;
}

function DevicesView({ devices, isLoading, onDisconnect }: { devices: Device[]; isLoading: boolean; onDisconnect: (device: Device) => void }) {
  return <Card><CardHeader><CardTitle>Thiết bị đã nhận diện</CardTitle><CardDescription>Ngắt thiết bị đang trực tuyến để kết thúc quyền truy cập hiện tại.</CardDescription></CardHeader><CardContent>{isLoading ? <Skeleton className="h-40 w-full" /> : devices.length ? <Table><TableCaption className="sr-only">Danh sách thiết bị.</TableCaption><TableHeader><TableRow><TableHead>MAC</TableHead><TableHead>Người dùng</TableHead><TableHead>Trạng thái</TableHead><TableHead>Hoạt động cuối</TableHead><TableHead>Thao tác</TableHead></TableRow></TableHeader><TableBody>{devices.map((device) => <TableRow key={device.mac_address}><TableCell className="font-mono text-xs">{device.mac_address}</TableCell><TableCell>{device.username || "Chưa gán"}</TableCell><TableCell><Badge variant={isActive(device.is_online) ? "secondary" : "outline"}>{isActive(device.is_online) ? "Trực tuyến" : "Ngoại tuyến"}</Badge></TableCell><TableCell>{formatDate(device.last_seen)}</TableCell><TableCell>{isActive(device.is_online) ? <Button variant="destructive" size="sm" onClick={() => onDisconnect(device)}>Ngắt thiết bị</Button> : "-"}</TableCell></TableRow>)}</TableBody></Table> : <NoRecords title="Chưa có thiết bị" description="Thiết bị xuất hiện sau lần kết nối đầu tiên." />}</CardContent></Card>;
}

function AccessView({ entries, isLoading, onRevoke }: { entries: MacAuthorization[]; isLoading: boolean; onRevoke: (entry: MacAuthorization) => void }) {
  return <Card><CardHeader><CardTitle>Quyền truy cập theo MAC</CardTitle><CardDescription>Quyền này tự hết hạn hoặc có thể bị thu hồi ngay tại đây.</CardDescription></CardHeader><CardContent>{isLoading ? <Skeleton className="h-40 w-full" /> : entries.length ? <Table><TableCaption className="sr-only">Danh sách quyền truy cập MAC.</TableCaption><TableHeader><TableRow><TableHead>MAC</TableHead><TableHead>Nguồn cấp</TableHead><TableHead>Tài khoản</TableHead><TableHead>Hết hạn</TableHead><TableHead>Thao tác</TableHead></TableRow></TableHeader><TableBody>{entries.map((entry) => <TableRow key={entry.mac}><TableCell className="font-mono text-xs">{entry.mac}</TableCell><TableCell><Badge variant="outline">{entry.access_type === "account" ? "Tài khoản" : "Truy cập nhanh"}</Badge></TableCell><TableCell>{entry.username || "Khách"}</TableCell><TableCell>{formatDate(entry.expires_at)}</TableCell><TableCell><Button variant="destructive" size="sm" onClick={() => onRevoke(entry)}>Thu hồi</Button></TableCell></TableRow>)}</TableBody></Table> : <NoRecords title="Chưa cấp quyền MAC" description="Quyền sẽ xuất hiện sau khi khách truy cập nhanh hoặc xác thực tài khoản." />}</CardContent></Card>;
}

function AccountsView({ users, isLoading, createDialogOpen, setCreateDialogOpen, onCreate, onOpenGoogle, onToggle, onDelete }: { users: PortalUser[]; isLoading: boolean; createDialogOpen: boolean; setCreateDialogOpen: (open: boolean) => void; onCreate: (event: FormEvent<HTMLFormElement>) => Promise<void>; onOpenGoogle: (user: PortalUser) => void; onToggle: (user: PortalUser) => void; onDelete: (user: PortalUser) => void }) {
  return <Card><CardHeader className="flex-row items-start justify-between gap-4"><div className="flex flex-col gap-1.5"><CardTitle>Tài khoản portal</CardTitle><CardDescription>Tài khoản nội bộ có thể được liên kết với email Google đã được duyệt.</CardDescription></div><Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}><DialogTrigger render={<Button />}><UserPlusIcon data-icon="inline-start" />Thêm tài khoản</DialogTrigger><DialogContent><DialogHeader><DialogTitle>Tạo tài khoản nội bộ</DialogTitle><DialogDescription>Tài khoản này có thể được dùng cho đăng nhập nội bộ hoặc liên kết Google OAuth.</DialogDescription></DialogHeader><form onSubmit={(event) => void onCreate(event)}><FieldGroup><Field><FieldLabel htmlFor="new-username">Tài khoản</FieldLabel><Input id="new-username" name="username" autoComplete="off" required /></Field><Field><FieldLabel htmlFor="new-password">Mật khẩu</FieldLabel><Input id="new-password" name="password" type="password" autoComplete="new-password" required /></Field><Field><FieldLabel htmlFor="new-max-devices">Số thiết bị tối đa</FieldLabel><Input id="new-max-devices" name="max_devices" type="number" min="1" defaultValue="3" required /></Field><DialogFooter><DialogClose render={<Button variant="outline" />}>Hủy</DialogClose><Button type="submit">Tạo tài khoản</Button></DialogFooter></FieldGroup></form></DialogContent></Dialog></CardHeader><CardContent>{isLoading ? <Skeleton className="h-40 w-full" /> : users.length ? <Table><TableCaption className="sr-only">Danh sách tài khoản portal.</TableCaption><TableHeader><TableRow><TableHead>Tài khoản</TableHead><TableHead>Loại</TableHead><TableHead>Thiết bị</TableHead><TableHead>Trạng thái</TableHead><TableHead>Thao tác</TableHead></TableRow></TableHeader><TableBody>{users.map((user) => <TableRow key={user.id}><TableCell className="font-medium">{user.identifier}</TableCell><TableCell><Badge variant="outline">{user.type}</Badge></TableCell><TableCell>{user.max_devices}</TableCell><TableCell><Badge variant={isActive(user.is_active) ? "secondary" : "destructive"}>{isActive(user.is_active) ? "Hoạt động" : "Đã khóa"}</Badge></TableCell><TableCell><div className="flex gap-2"><Button variant="outline" size="sm" onClick={() => onOpenGoogle(user)}>Google OAuth</Button><Button variant="outline" size="sm" onClick={() => onToggle(user)}>{isActive(user.is_active) ? "Khóa" : "Mở khóa"}</Button><Button variant="destructive" size="sm" onClick={() => onDelete(user)}>Xóa</Button></div></TableCell></TableRow>)}</TableBody></Table> : <NoRecords title="Chưa có tài khoản" description="Tạo một tài khoản để khách có thể đăng nhập vào portal." />}</CardContent></Card>;
}

function PackagesView({ packages, isLoading }: { packages: Package[]; isLoading: boolean }) {
  if (isLoading) return <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{Array.from({ length: 3 }, (_, index) => <Card key={index}><CardHeader><Skeleton className="h-5 w-32" /><Skeleton className="h-4 w-48" /></CardHeader><CardContent><Skeleton className="h-16 w-full" /></CardContent></Card>)}</div>;
  if (!packages.length) return <Card><CardContent><NoRecords title="Chưa có gói cước" description="Tạo gói cước qua API để hiển thị tại đây." /></CardContent></Card>;
  return <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{packages.map((pkg) => <Card key={pkg.id}><CardHeader><div className="flex items-start justify-between gap-3"><div className="flex flex-col gap-1"><CardTitle>{pkg.name}</CardTitle><CardDescription>{formatMinutes(pkg.duration_minutes)}</CardDescription></div><Badge variant="secondary">{pkg.max_devices} thiết bị</Badge></div></CardHeader><CardContent className="flex flex-col gap-3 text-sm"><div className="flex items-center justify-between gap-4"><span className="text-muted-foreground">Dung lượng</span><span>{pkg.quota_mb ? formatBytes(pkg.quota_mb * 1024 * 1024) : "Không giới hạn"}</span></div><div className="flex items-center justify-between gap-4"><span className="text-muted-foreground">Tải xuống</span><span>{pkg.bandwidth_down_kbps} Kbps</span></div><div className="flex items-center justify-between gap-4"><span className="text-muted-foreground">Tải lên</span><span>{pkg.bandwidth_up_kbps} Kbps</span></div></CardContent></Card>)}</div>;
}

function BackupView({ isBackingUp, message, onCreate }: { isBackingUp: boolean; message: string; onCreate: () => void }) {
  return <Card className="max-w-2xl"><CardHeader><CardTitle>Sao lưu cơ sở dữ liệu</CardTitle><CardDescription>Tạo bản sao lưu thủ công. Nếu WebDAV đã cấu hình trên máy chủ, hệ thống sẽ gửi kèm bản sao đó.</CardDescription></CardHeader><CardContent className="flex flex-col gap-5">{message ? <Alert><DatabaseBackupIcon aria-hidden="true" /><AlertTitle>Trạng thái sao lưu</AlertTitle><AlertDescription>{message}</AlertDescription></Alert> : null}<Button size="lg" className="w-fit" onClick={onCreate} disabled={isBackingUp}>{isBackingUp ? <Spinner data-icon="inline-start" /> : <DatabaseBackupIcon data-icon="inline-start" />}{isBackingUp ? "Đang sao lưu" : "Tạo sao lưu ngay"}</Button></CardContent><CardFooter className="text-sm text-muted-foreground">Chỉ quản trị viên mới có thể tạo sao lưu.</CardFooter></Card>;
}

function SettingsView({
  config,
  isLoading,
  radiusTestResult,
  isRadiusTesting,
  oauthTestResult,
  isOauthTesting,
  radiusTestInput,
  onRadiusTestInputChange,
  onTestRadius,
  onTestOauth,
  onRefresh,
}: {
  config: SettingsConfig | null;
  isLoading: boolean;
  radiusTestResult: TestResult | null;
  isRadiusTesting: boolean;
  oauthTestResult: TestResult | null;
  isOauthTesting: boolean;
  radiusTestInput: { routerIp: string; sharedSecret: string; authPort: number };
  onRadiusTestInputChange: (input: { routerIp: string; sharedSecret: string; authPort: number }) => void;
  onTestRadius: () => void;
  onTestOauth: () => void;
  onRefresh: () => void;
}) {
  const [customServerIp, setCustomServerIp] = useState<string>("");

  if (isLoading) {
    return <div className="flex flex-col gap-4"><Skeleton className="h-48 w-full" /><Skeleton className="h-48 w-full" /></div>;
  }

  const effectiveServerIp = customServerIp.trim() || config?.radius.serverIp ||
    (typeof window !== "undefined" && window.location.hostname !== "localhost" && window.location.hostname !== "127.0.0.1" ? window.location.hostname : "192.168.1.100");

  const effectivePortalUrl = (function () {
    if (customServerIp.trim()) {
      const port = typeof window !== "undefined" && window.location.port ? `:${window.location.port}` : "";
      const protocol = typeof window !== "undefined" ? window.location.protocol : "http:";
      return `${protocol}//${customServerIp.trim()}${port}`;
    }
    return config?.portalUrl || `http://${effectiveServerIp}:3000`;
  })();

  return (
    <div className="flex flex-col gap-6">
      {/* RADIUS Connection */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <CardTitle>Kết nối Router (RADIUS)</CardTitle>
            {config?.radius.sharedSecretConfigured ? (
              <Badge variant="secondary" className="gap-1">
                <CheckCircleIcon className="size-3" />Đã cấu hình
              </Badge>
            ) : (
              <Badge variant="outline" className="gap-1 text-yellow-600">
                <XCircleIcon className="size-3" />Chưa cấu hình
              </Badge>
            )}
          </div>
          <CardDescription>Cấu hình kết nối RADIUS với router (MikroTik, Ubiquiti, v.v.)</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">Auth Port</span>
              <span className="font-mono text-lg">{config?.radius.authPort || 1812}</span>
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">Accounting Port</span>
              <span className="font-mono text-lg">{config?.radius.accountingPort || 1813}</span>
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">CoA Port</span>
              <span className="font-mono text-lg">{config?.radius.coaPort || 3799}</span>
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">Shared Secret</span>
              <span className="font-mono text-lg">{config?.radius.sharedSecretConfigured ? "●●●●●●●●" : "Chưa đặt"}</span>
            </div>
          </div>

          <CollapsibleCard title="Hướng dẫn cấu hình Router (MikroTik, OpenWrt, pfSense, UniFi)" defaultOpen={true}>
            <div className="space-y-6 text-sm">
              {/* Dynamic IP Customizer */}
              <div className="flex flex-col sm:flex-row items-start sm:items-end gap-3 bg-muted/60 p-3.5 rounded-lg border">
                <div className="flex-1 w-full">
                  <FieldLabel htmlFor="custom-portal-ip" className="text-xs font-semibold text-foreground">
                    Địa chỉ IP / Domain máy chủ Portal của bạn (để tạo script):
                  </FieldLabel>
                  <Input
                    id="custom-portal-ip"
                    placeholder={config?.radius.serverIp || "Ví dụ: 192.168.88.5 hoặc portal.mywifi.vn"}
                    value={customServerIp}
                    onChange={(e) => setCustomServerIp(e.target.value)}
                    className="bg-background font-mono text-xs mt-1"
                  />
                </div>
                {customServerIp && (
                  <Button variant="ghost" size="sm" onClick={() => setCustomServerIp("")}>
                    Đặt lại
                  </Button>
                )}
              </div>

              {/* MikroTik Section */}
              <div className="rounded-lg border border-primary/20 bg-primary/5 p-4">
                <div className="flex items-center gap-2 mb-2">
                  <TerminalIcon className="size-4 text-primary" />
                  <h4 className="font-semibold text-base text-primary">MikroTik RouterOS (Hotspot + RADIUS + Dynamic CoA)</h4>
                </div>
                <p className="text-xs text-muted-foreground mb-3">
                  Sao chép và chạy đoạn script sau trong <strong>Terminal</strong> của MikroTik RouterOS (thay <code>RADIUS_SECRET</code> bằng mật khẩu trong .env):
                </p>
                <CodeSnippet
                  label="Lệnh Terminal cấu hình MikroTik RouterOS:"
                  code={`# 1. Khai báo máy chủ RADIUS
/radius add address=${effectiveServerIp} secret=RADIUS_SECRET service=hotspot authentication-port=${config?.radius.authPort || 1812} accounting-port=${config?.radius.accountingPort || 1813}

# 2. Bật cổng nhận lệnh ngắt kết nối (Incoming CoA/Disconnect) từ Server
/radius incoming set accept=yes port=${config?.radius.coaPort || 3799}

# 3. Kích hoạt RADIUS và gửi Accounting định kỳ trong Hotspot Profile
/ip hotspot profile set [find default=yes] use-radius=yes radius-accounting=yes radius-interim-update=1m login-by=http-pap
/ip hotspot user profile set [find default=yes] session-timeout=1d

# 4. Thêm Walled Garden cho máy chủ Portal (cho phép mở trang login trước khi kết nối)
/ip hotspot walled-garden ip add dst-address=${effectiveServerIp} action=accept`}
                />

                <div className="mt-4 pt-3 border-t border-primary/10">
                  <h5 className="font-medium text-xs text-foreground mb-1">Cấu hình URL Chuyển hướng (Redirect URL trong Hotspot):</h5>
                  <p className="text-xs text-muted-foreground mb-2">
                    Trong trang <code>login.html</code> của Hotspot Router, cấu hình URL chuyển hướng tới Portal với các biến tham số:
                  </p>
                  <CodeSnippet
                    label="Redirect URL:"
                    code={`${effectivePortalUrl}/?mac=$(mac)&link-login-only=$(link-login-only)&dst=$(link-orig)`}
                  />
                </div>
              </div>

              {/* WinBox GUI Guide */}
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <BookOpenIcon className="size-4 text-foreground" />
                  <h4 className="font-semibold">Cấu hình qua giao diện MikroTik WinBox (Thủ công)</h4>
                </div>
                <ol className="list-inside list-decimal space-y-1.5 text-muted-foreground text-xs leading-relaxed">
                  <li><strong>Khai báo RADIUS:</strong> Vào menu <code>Radius</code> → Nhấn dấu <code>+</code> → Tích chọn <code>hotspot</code> → Điền Address: <code>{effectiveServerIp}</code>, Secret: <code>RADIUS_SECRET</code>, Auth Port: <code>{config?.radius.authPort || 1812}</code>, Acct Port: <code>{config?.radius.accountingPort || 1813}</code>.</li>
                  <li><strong>Bật Incoming CoA:</strong> Vào <code>Radius</code> → Nhấn nút <code>Incoming</code> → Tích chọn <code>Accept</code> và nhập Port: <code>{config?.radius.coaPort || 3799}</code> (để Server ngắt kết nối tập trung).</li>
                  <li><strong>Kích hoạt trên Hotspot:</strong> Vào <code>IP</code> → <code>Hotspot</code> → <code>Server Profiles</code> → Chọn profile → Tab <code>RADIUS</code> (Tích chọn <code>Use RADIUS</code>, <code>Accounting</code>, Interim Update: <code>1m</code>) → Tab <code>Login</code> (Chọn <code>HTTP PAP</code>).</li>
                  <li><strong>Walled Garden:</strong> Vào <code>IP</code> → <code>Hotspot</code> → <code>Walled Garden IP List</code> → Thêm Dst. Address: <code>{effectiveServerIp}</code> với Action: <code>accept</code>.</li>
                </ol>
              </div>

              {/* Other Routers */}
              <div className="grid gap-4 sm:grid-cols-2 pt-2 border-t">
                <div className="rounded-lg border p-3">
                  <h4 className="font-semibold text-xs mb-1">OpenWrt (CoovaChilli / OpenNDS)</h4>
                  <ul className="list-disc list-inside text-xs text-muted-foreground space-y-1">
                    <li>RADIUS Server: <code>{effectiveServerIp}</code></li>
                    <li>Auth Port: <code>{config?.radius.authPort || 1812}</code> | Acct Port: <code>{config?.radius.accountingPort || 1813}</code></li>
                    <li>UAM Server: Trỏ tới Portal URL (<code>{effectivePortalUrl}</code>)</li>
                    <li>CoA Port: <code>{config?.radius.coaPort || 3799}</code></li>
                  </ul>
                </div>
                <div className="rounded-lg border p-3">
                  <h4 className="font-semibold text-xs mb-1">Ubiquiti UniFi & pfSense</h4>
                  <ul className="list-disc list-inside text-xs text-muted-foreground space-y-1">
                    <li>Vào Profiles → RADIUS Profile → Nhập Server IP (<code>{effectiveServerIp}</code>) và Secret</li>
                    <li>Hotspot / Guest Control → Bật External Portal Server (<code>{effectivePortalUrl}</code>)</li>
                    <li>Accounting: Bật Interim Update interval 60s</li>
                  </ul>
                </div>
              </div>

              <div className="rounded-lg bg-muted p-3 text-xs">
                <code>.env</code> keys cần chú ý: <code>RADIUS_SHARED_SECRET</code>, <code>RADIUS_AUTH_PORT={config?.radius.authPort || 1812}</code>, <code>RADIUS_ACCOUNTING_PORT={config?.radius.accountingPort || 1813}</code>, <code>RADIUS_COA_PORT={config?.radius.coaPort || 3799}</code>
              </div>
            </div>
          </CollapsibleCard>

          <div className="border-t pt-4">
            <h4 className="mb-3 text-sm font-medium">Kiểm tra kết nối</h4>
            <div className="grid gap-3 sm:grid-cols-4">
              <div className="sm:col-span-1">
                <FieldLabel htmlFor="router-ip">Router IP</FieldLabel>
                <Input
                  id="router-ip"
                  placeholder="192.168.1.1"
                  value={radiusTestInput.routerIp}
                  onChange={(e) => onRadiusTestInputChange({ ...radiusTestInput, routerIp: e.target.value })}
                />
              </div>
              <div className="sm:col-span-1">
                <FieldLabel htmlFor="shared-secret">Shared Secret</FieldLabel>
                <Input
                  id="shared-secret"
                  type="password"
                  placeholder="Nhập shared secret"
                  value={radiusTestInput.sharedSecret}
                  onChange={(e) => onRadiusTestInputChange({ ...radiusTestInput, sharedSecret: e.target.value })}
                />
              </div>
              <div className="sm:col-span-1">
                <FieldLabel htmlFor="auth-port">Auth Port</FieldLabel>
                <Input
                  id="auth-port"
                  type="number"
                  placeholder="1812"
                  value={radiusTestInput.authPort}
                  onChange={(e) => onRadiusTestInputChange({ ...radiusTestInput, authPort: parseInt(e.target.value) || 1812 })}
                />
              </div>
              <div className="sm:col-span-1 flex items-end">
                <Button onClick={onTestRadius} disabled={isRadiusTesting} className="w-full">
                  {isRadiusTesting ? <Spinner data-icon="inline-start" /> : <NetworkIcon data-icon="inline-start" />}
                  {isRadiusTesting ? "Đang kiểm tra..." : "Kiểm tra"}
                </Button>
              </div>
            </div>
            {radiusTestResult && (
              <Alert className={`mt-3 ${radiusTestResult.success ? "border-green-500 bg-green-50" : "border-red-500 bg-red-50"}`}>
                {radiusTestResult.success ? <CheckCircleIcon className="size-4 text-green-600" /> : <XCircleIcon className="size-4 text-red-600" />}
                <AlertDescription className={radiusTestResult.success ? "text-green-800" : "text-red-800"}>
                  {radiusTestResult.message}
                </AlertDescription>
              </Alert>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Google OAuth */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <CardTitle>Google OAuth</CardTitle>
            {config?.oauth.clientIdConfigured ? (
              <Badge variant="secondary" className="gap-1">
                <CheckCircleIcon className="size-3" />Đã cấu hình
              </Badge>
            ) : (
              <Badge variant="outline" className="gap-1 text-yellow-600">
                <XCircleIcon className="size-3" />Chưa cấu hình
              </Badge>
            )}
          </div>
          <CardDescription>Xác thực đăng nhập qua tài khoản Google</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Callback URL</span>
            <code className="rounded bg-muted p-2 text-sm break-all">
              {config?.oauth.callbackUrl || "Chưa cấu hình"}
            </code>
            <FieldDescription>URL này cần được đăng ký trong Google Cloud Console</FieldDescription>
          </div>

          <CollapsibleCard title="Hướng dẫn cấu hình Google OAuth" defaultOpen={false}>
            <div className="space-y-4 text-sm">
              <div>
                <h4 className="font-semibold">Bước 1: Tạo OAuth Client</h4>
                <ol className="list-inside list-decimal space-y-1 text-muted-foreground">
                  <li>Truy cập <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">Google Cloud Console</a></li>
                  <li>Tạo OAuth 2.0 Client ID mới</li>
                  <li>Application type: Web application</li>
                  <li>Thêm Authorized redirect URI: <code className="bg-muted px-1 rounded">{config?.oauth.callbackUrl || "http://localhost:3000/auth/google/callback"}</code></li>
                </ol>
              </div>
              <div>
                <h4 className="font-semibold">Bước 2: Lấy credentials</h4>
                <ol className="list-inside list-decimal space-y-1 text-muted-foreground">
                  <li>Sau khi tạo, bạn sẽ nhận được Client ID và Client Secret</li>
                  <li>Thêm vào file <code className="bg-muted px-1 rounded">.env</code></li>
                </ol>
              </div>
              <div>
                <h4 className="font-semibold">Bước 3: Cấu hình .env</h4>
                <div className="rounded-lg bg-muted p-3 text-xs font-mono">
                  <div>GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com</div>
                  <div>GOOGLE_CLIENT_SECRET=your-client-secret</div>
                  <div>GOOGLE_CALLBACK_URL={config?.oauth.callbackUrl || "http://localhost:3000/auth/google/callback"}</div>
                </div>
              </div>
              <div>
                <h4 className="font-semibold">Bước 4: Khởi động lại server</h4>
                <p className="text-muted-foreground">Sau khi cập nhật .env, cần khởi động lại server để áp dụng.</p>
              </div>
              <div className="rounded-lg bg-yellow-50 p-3 text-yellow-800 text-xs">
                <strong>Lưu ý:</strong> Chỉ email được cấp quyền trong trang "Tài khoản" mới có thể đăng nhập qua Google OAuth.
              </div>
            </div>
          </CollapsibleCard>

          <div className="border-t pt-4">
            <Button onClick={onTestOauth} disabled={isOauthTesting}>
              {isOauthTesting ? <Spinner data-icon="inline-start" /> : <CheckCircleIcon data-icon="inline-start" />}
              {isOauthTesting ? "Đang kiểm tra..." : "Kiểm tra cấu hình OAuth"}
            </Button>
            {oauthTestResult && (
              <Alert className={`mt-3 ${oauthTestResult.success ? "border-green-500 bg-green-50" : "border-red-500 bg-red-50"}`}>
                {oauthTestResult.success ? <CheckCircleIcon className="size-4 text-green-600" /> : <XCircleIcon className="size-4 text-red-600" />}
                <AlertDescription className={oauthTestResult.success ? "text-green-800" : "text-red-800"}>
                  {oauthTestResult.message}
                </AlertDescription>
              </Alert>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Cài đặt hiện tại</CardTitle>
          <CardDescription>Để thay đổi cấu hình, cần chỉnh sửa file .env và khởi động lại server</CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="outline" size="sm" onClick={onRefresh}>
            <RefreshCwIcon data-icon="inline-start" />
            Tải lại cấu hình
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

function GoogleAuthorizationDialog({ user, entries, email, isLoading, isSaving, onEmailChange, onOpenChange, onSubmit, onRevoke }: { user: PortalUser | null; entries: OAuthAuthorization[]; email: string; isLoading: boolean; isSaving: boolean; onEmailChange: (email: string) => void; onOpenChange: (open: boolean) => void; onSubmit: (event: FormEvent<HTMLFormElement>) => Promise<void>; onRevoke: (email: string) => void }) {
  return <Dialog open={Boolean(user)} onOpenChange={onOpenChange}><DialogContent><DialogHeader><DialogTitle>Quyền đăng nhập Google</DialogTitle><DialogDescription>{user ? `Chỉ các email dưới đây được dùng Google OAuth cho ${user.identifier}.` : ""}</DialogDescription></DialogHeader><form onSubmit={(event) => void onSubmit(event)}><FieldGroup><Field><FieldLabel htmlFor="google-email">Email Google</FieldLabel><Input id="google-email" type="email" value={email} onChange={(event) => onEmailChange(event.target.value)} placeholder="name@gmail.com" required /><FieldDescription>Email này sẽ được đối chiếu sau khi Google xác thực.</FieldDescription></Field><Button type="submit" disabled={isSaving}>{isSaving ? <Spinner data-icon="inline-start" /> : <UserCogIcon data-icon="inline-start" />}Cấp quyền Google</Button></FieldGroup></form><Separator /><div className="flex flex-col gap-3"><p className="text-sm font-medium">Email đã được cấp quyền</p>{isLoading ? <Skeleton className="h-8 w-full" /> : null}{!isLoading && !entries.length ? <p className="text-sm text-muted-foreground">Chưa có email nào.</p> : null}{entries.map((entry) => <div key={entry.id} className="flex items-center justify-between gap-3 rounded-lg border p-2"><Badge variant="secondary">{entry.google_email}</Badge><Button variant="ghost" size="icon-sm" aria-label={`Thu hồi ${entry.google_email}`} onClick={() => onRevoke(entry.google_email)}><XIcon /></Button></div>)}</div><DialogFooter><DialogClose render={<Button variant="outline" />}>Đóng</DialogClose></DialogFooter></DialogContent></Dialog>;
}

export default AdminApp;
