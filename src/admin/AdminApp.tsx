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
  UserPlusIcon,
  UsersIcon,
  WifiIcon,
  CheckCircleIcon,
  XCircleIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  CopyIcon,
  CheckIcon,
  TerminalIcon,
  BookOpenIcon,
  PencilIcon,
  PlusIcon,
  ActivityIcon,
} from "lucide-react";

import { ApiError, apiRequest } from "./api";
import { formatMacAddress } from "@/lib/utils";
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
type Stats = {
  users: number;
  activeSessions: number;
  todayData: number;
  bandwidth: number;
  bandwidthDown?: number;
  bandwidthUp?: number;
  bandwidthDownKbps?: number;
  bandwidthUpKbps?: number;
};
type Session = {
  id: number;
  username: string;
  mac_address: string;
  start_time: string | null;
  quota_used_mb: number | null;
  live_down_kbps?: number;
  live_up_kbps?: number;
  total_bytes_in?: number;
  total_bytes_out?: number;
};
type AccountingStatus = {
  state: "idle" | "syncing" | "ok" | "error";
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  records: number;
  synchronized: number;
  skipped: number;
  error: string | null;
};
type SessionsResponse = {
  sessions: Session[];
  accounting: AccountingStatus;
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
  package_id?: number | null;
  package_name?: string | null;
  is_active: number | boolean;
};
type Package = {
  id: number;
  name: string;
  duration_minutes: number;
  quota_mb?: number | null;
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
type DataState = {
  stats: Stats;
  sessions: Session[];
  accounting: AccountingStatus | null;
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
  accounting: null,
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
    description: "Tạo, khóa và quản lý tài khoản khách nội bộ.",
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
    description: "Cấu hình kết nối Router và RADIUS.",
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
  // SQLite CURRENT_TIMESTAMP is UTC but is returned without an offset, for
  // example "2026-08-28 16:00:50". Browsers otherwise parse that format as
  // local time, displaying it seven hours behind in Vietnam.
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? `${value.replace(" ", "T")}Z`
    : value;
  const date = new Date(normalized);
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

function formatSpeed(kbps: number | null | undefined) {
  if (!kbps || kbps <= 0) return "0 Kbps";
  if (kbps >= 1000) {
    return `${(kbps / 1000).toFixed(1)} Mbps`;
  }
  return `${Math.round(kbps)} Kbps`;
}

function LiveSpeedBadge({ downKbps, upKbps }: { downKbps?: number; upKbps?: number }) {
  const down = downKbps || 0;
  const up = upKbps || 0;
  const isTransmitting = down > 0 || up > 0;

  return (
    <div className="flex items-center gap-1.5 font-mono text-xs">
      <span
        className={`inline-block size-2 rounded-full transition-colors ${
          isTransmitting ? "bg-emerald-500 animate-pulse" : "bg-zinc-300 dark:bg-zinc-600"
        }`}
        title={isTransmitting ? "Tốc độ trung bình từ bản cập nhật Accounting gần nhất" : "Đang nghỉ hoặc chưa có số liệu Accounting mới"}
      />
      <span className={down > 0 ? "font-semibold text-emerald-600 dark:text-emerald-400" : "text-muted-foreground"}>
        ↓ {formatSpeed(down)}
      </span>
      <span className="text-muted-foreground">/</span>
      <span className={up > 0 ? "font-semibold text-sky-600 dark:text-sky-400" : "text-muted-foreground"}>
        ↑ {formatSpeed(up)}
      </span>
    </div>
  );
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
  const [createPackageDialogOpen, setCreatePackageDialogOpen] = useState(false);
  const [editingPackage, setEditingPackage] = useState<Package | null>(null);
  const [editingUser, setEditingUser] = useState<PortalUser | null>(null);
  const [backupMessage, setBackupMessage] = useState("");
  const [isBackingUp, setIsBackingUp] = useState(false);

  // Settings state
  const [settingsConfig, setSettingsConfig] = useState<SettingsConfig | null>(null);
  const [isSettingsLoading, setIsSettingsLoading] = useState(false);
  const [radiusTestResult, setRadiusTestResult] = useState<TestResult | null>(null);
  const [isRadiusTesting, setIsRadiusTesting] = useState(false);
  const [radiusTestInput, setRadiusTestInput] = useState({ routerIp: "", sharedSecret: "", authPort: 1812 });

  const loadData = useCallback(async (showRefreshState = false) => {
    if (showRefreshState) setIsRefreshing(true);
    setPageError("");

    try {
      const [stats, sessionsResponse, devices, users, packages, macAuthorizations] = await Promise.all([
        apiRequest<Stats>("/admin/api/stats"),
        apiRequest<SessionsResponse>("/api/sessions"),
        apiRequest<Device[]>("/api/devices"),
        apiRequest<PortalUser[]>("/api/users"),
        apiRequest<Package[]>("/api/packages"),
        apiRequest<MacAuthorization[]>("/api/guest/whitelist"),
      ]);
      setData({ stats, sessions: sessionsResponse.sessions, accounting: sessionsResponse.accounting, devices, users, packages, macAuthorizations });
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

  // Live polling: 5 seconds for Overview & Sessions, 30 seconds for others
  useEffect(() => {
    if (!admin) return undefined;
    const pollInterval = (view === "overview" || view === "sessions") ? 5000 : 30000;
    const interval = window.setInterval(() => void loadData(), pollInterval);
    return () => window.clearInterval(interval);
  }, [admin, loadData, view]);

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

  async function handleCreatePackage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      await apiRequest<{ id: number }>("/api/packages", {
        method: "POST",
        body: JSON.stringify({
          name: form.get("name"),
          duration_minutes: Number(form.get("duration_minutes")),
          quota_mb: null,
          bandwidth_down_kbps: Number(form.get("bandwidth_down_kbps")) || 5000,
          bandwidth_up_kbps: Number(form.get("bandwidth_up_kbps")) || 2000,
          max_devices: Number(form.get("max_devices")) || 1,
        }),
      });
      setCreatePackageDialogOpen(false);
      await loadData(true);
      toast.add({ title: "Đã tạo gói cước mới", type: "success" });
    } catch (caughtError) {
      toast.add({
        title: "Không thể tạo gói cước",
        description: caughtError instanceof Error ? caughtError.message : "Vui lòng thử lại.",
        type: "error",
      });
    }
  }

  async function handleUpdatePackage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editingPackage) return;
    const form = new FormData(event.currentTarget);
    try {
      await apiRequest<{ message: string }>(`/api/packages/${editingPackage.id}`, {
        method: "PUT",
        body: JSON.stringify({
          name: form.get("name"),
          duration_minutes: Number(form.get("duration_minutes")),
          quota_mb: null,
          bandwidth_down_kbps: Number(form.get("bandwidth_down_kbps")) || 5000,
          bandwidth_up_kbps: Number(form.get("bandwidth_up_kbps")) || 2000,
          max_devices: Number(form.get("max_devices")) || 1,
        }),
      });
      setEditingPackage(null);
      await loadData(true);
      toast.add({ title: "Đã cập nhật gói cước", type: "success" });
    } catch (caughtError) {
      toast.add({
        title: "Không thể cập nhật gói cước",
        description: caughtError instanceof Error ? caughtError.message : "Vui lòng thử lại.",
        type: "error",
      });
    }
  }

  async function handleUpdateUser(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editingUser) return;
    const form = new FormData(event.currentTarget);
    const pkgId = form.get("package_id");
    try {
      await apiRequest<{ success: boolean }>(`/api/users/${editingUser.id}`, {
        method: "PUT",
        body: JSON.stringify({
          max_devices: Number(form.get("max_devices")) || 3,
          package_id: pkgId && pkgId !== "" ? Number(pkgId) : null,
        }),
      });
      setEditingUser(null);
      await loadData(true);
      toast.add({ title: "Đã cập nhật tài khoản", type: "success" });
    } catch (caughtError) {
      toast.add({
        title: "Không thể cập nhật tài khoản",
        description: caughtError instanceof Error ? caughtError.message : "Vui lòng thử lại.",
        type: "error",
      });
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
            {view === "sessions" ? <SessionsView sessions={data.sessions} accounting={data.accounting} isLoading={isLoading} onTerminate={(session) => queueAction("Ngắt phiên kết nối?", `Phiên của ${session.username} sẽ bị kết thúc ngay.`, async () => {
              await apiRequest<{ success: boolean }>(`/api/sessions/${session.id}`, { method: "DELETE" });
              await loadData(true);
              toast.add({ title: "Đã ngắt phiên kết nối", type: "success" });
            })} /> : null}
            {view === "devices" ? <DevicesView devices={data.devices} isLoading={isLoading} onDisconnect={(device) => queueAction("Ngắt thiết bị?", `Thiết bị ${formatMacAddress(device.mac_address)} sẽ bị đưa về trạng thái ngoại tuyến.`, async () => {
              await apiRequest<{ success: boolean }>(`/api/devices/${encodeURIComponent(device.mac_address)}`, { method: "DELETE" });
              await loadData(true);
              toast.add({ title: "Đã ngắt thiết bị", type: "success" });
            })} /> : null}
            {view === "access" ? <AccessView entries={data.macAuthorizations} isLoading={isLoading} onRevoke={(entry) => queueAction("Thu hồi quyền MAC?", `Thiết bị ${formatMacAddress(entry.mac)} sẽ không thể truy cập khi gửi yêu cầu RADIUS kế tiếp.`, async () => {
              await apiRequest<{ success: boolean }>(`/api/guest/whitelist/${encodeURIComponent(entry.mac)}`, { method: "DELETE" });
              await loadData(true);
              toast.add({ title: "Đã thu hồi quyền MAC", type: "success" });
            })} /> : null}
            {view === "accounts" ? <AccountsView
              users={data.users}
              packages={data.packages}
              isLoading={isLoading}
              createDialogOpen={createDialogOpen}
              setCreateDialogOpen={setCreateDialogOpen}
              editingUser={editingUser}
              setEditingUser={setEditingUser}
              onCreate={async (event) => {
                event.preventDefault();
                const form = new FormData(event.currentTarget);
                const pkgId = form.get("package_id");
                try {
                  await apiRequest<{ id: number }>("/api/users", {
                    method: "POST",
                    body: JSON.stringify({
                      username: form.get("username"),
                      password: form.get("password"),
                      max_devices: Number(form.get("max_devices")),
                      package_id: pkgId && pkgId !== "" ? Number(pkgId) : null,
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
              onUpdate={handleUpdateUser}
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
            {view === "packages" ? <PackagesView
              packages={data.packages}
              isLoading={isLoading}
              createDialogOpen={createPackageDialogOpen}
              setCreateDialogOpen={setCreatePackageDialogOpen}
              editingPackage={editingPackage}
              setEditingPackage={setEditingPackage}
              onCreate={handleCreatePackage}
              onUpdate={handleUpdatePackage}
              onDelete={(pkg) => queueAction("Xóa gói cước?", `Gói cước "${pkg.name}" sẽ bị xóa vĩnh viễn khỏi danh sách.`, async () => {
                await apiRequest<{ message: string }>(`/api/packages/${pkg.id}`, { method: "DELETE" });
                await loadData(true);
                toast.add({ title: "Đã xóa gói cước", type: "success" });
              })}
            /> : null}
            {view === "backup" ? <BackupView isBackingUp={isBackingUp} message={backupMessage} onCreate={() => void createBackup()} /> : null}
            {view === "settings" ? <SettingsView
              config={settingsConfig}
              isLoading={isSettingsLoading}
              radiusTestResult={radiusTestResult}
              isRadiusTesting={isRadiusTesting}
              radiusTestInput={radiusTestInput}
              onRadiusTestInputChange={setRadiusTestInput}
              onTestRadius={() => void testRadiusConnection()}
              onRefresh={() => void loadSettings()}
            /> : null}
          </div>
        </main>
      </div>

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
  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Tài khoản" value={data.stats.users} description="Tổng số tài khoản portal" icon={UsersIcon} />
        <StatCard label="Đang trực tuyến" value={data.stats.activeSessions} description="Phiên RADIUS đang hoạt động" icon={WifiIcon} />
        <StatCard label="Dữ liệu hôm nay" value={formatBytes(data.stats.todayData)} description="Tổng lưu lượng phiên hôm nay" icon={GaugeIcon} />
        <StatCard
          label="Băng thông"
          value={data.stats.bandwidth > 0 ? `${data.stats.bandwidth} Mbps` : `${data.stats.bandwidthDownKbps || 0} Kbps`}
          description={`↓ ${(data.stats.bandwidthDown ?? 0).toFixed(1)} Mbps · ↑ ${(data.stats.bandwidthUp ?? 0).toFixed(1)} Mbps`}
          icon={ActivityIcon}
        />
      </div>
      <Card>
        <CardHeader className="flex-row items-start justify-between gap-4">
          <div className="flex flex-col gap-1.5">
            <CardTitle>Phiên hoạt động gần đây</CardTitle>
            <CardDescription>Những kết nối đang được RADIUS duy trì theo thời gian thực.</CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={onSelectSessions}>Xem tất cả</Button>
        </CardHeader>
        <CardContent>
          {sessions.length ? <SessionTable sessions={sessions} /> : <NoRecords title="Chưa có phiên hoạt động" description="Phiên mới sẽ xuất hiện tại đây khi người dùng truy cập mạng." />}
        </CardContent>
      </Card>
    </div>
  );
}

function SessionTable({ sessions, onTerminate }: { sessions: Session[]; onTerminate?: (session: Session) => void }) {
  return (
    <Table>
      <TableCaption className="sr-only">Danh sách phiên kết nối đang hoạt động.</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead>Người dùng</TableHead>
          <TableHead>MAC</TableHead>
          <TableHead>Tốc độ</TableHead>
          <TableHead>Bắt đầu</TableHead>
          <TableHead>Thời lượng</TableHead>
          <TableHead>Dữ liệu</TableHead>
          {onTerminate ? <TableHead>Thao tác</TableHead> : null}
        </TableRow>
      </TableHeader>
      <TableBody>
        {sessions.map((session) => (
          <TableRow key={session.id}>
            <TableCell className="font-medium">{session.username}</TableCell>
            <TableCell className="font-mono text-xs">{formatMacAddress(session.mac_address)}</TableCell>
            <TableCell>
              <LiveSpeedBadge downKbps={session.live_down_kbps} upKbps={session.live_up_kbps} />
            </TableCell>
            <TableCell>{formatDate(session.start_time)}</TableCell>
            <TableCell>{formatElapsed(session.start_time)}</TableCell>
            <TableCell>{formatBytes((session.quota_used_mb || 0) * 1024 * 1024)}</TableCell>
            {onTerminate ? (
              <TableCell>
                <Button variant="destructive" size="sm" onClick={() => onTerminate(session)}>Ngắt phiên</Button>
              </TableCell>
            ) : null}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function SessionsView({ sessions, accounting, isLoading, onTerminate }: { sessions: Session[]; accounting: AccountingStatus | null; isLoading: boolean; onTerminate: (session: Session) => void }) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-4">
          <div className="flex flex-col gap-1">
            <CardTitle>Phiên đang hoạt động</CardTitle>
            <CardDescription>Tốc độ là trung bình theo Accounting của router (đang đặt mỗi 60 giây). Ngắt phiên sẽ gửi tín hiệu RADIUS Disconnect (RFC 5176).</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {accounting?.state === "error" ? (
          <Alert variant="destructive" className="mb-5">
            <CircleAlertIcon aria-hidden="true" />
            <AlertTitle>Không đọc được phiên từ RADIUS</AlertTitle>
            <AlertDescription>{accounting.error || "Không thể đồng bộ dữ liệu Accounting từ MariaDB."}</AlertDescription>
          </Alert>
        ) : accounting?.state === "ok" && accounting.records === 0 ? (
          <Alert className="mb-5">
            <CircleAlertIcon aria-hidden="true" />
            <AlertTitle>RADIUS chưa có Accounting đang hoạt động</AlertTitle>
            <AlertDescription>Đồng bộ kết nối MariaDB thành công nhưng bảng radacct chưa có bản ghi phù hợp. Kiểm tra router/AP đã bật Accounting Start và Interim Update.</AlertDescription>
          </Alert>
        ) : null}
        {isLoading ? <Skeleton className="h-40 w-full" /> : sessions.length ? <SessionTable sessions={sessions} onTerminate={onTerminate} /> : <NoRecords title="Không có phiên hoạt động" description="Không có người dùng nào đang trực tuyến." />}
      </CardContent>
    </Card>
  );
}

function DevicesView({ devices, isLoading, onDisconnect }: { devices: Device[]; isLoading: boolean; onDisconnect: (device: Device) => void }) {
  return <Card><CardHeader><CardTitle>Thiết bị đã nhận diện</CardTitle><CardDescription>Ngắt thiết bị đang trực tuyến để kết thúc quyền truy cập hiện tại.</CardDescription></CardHeader><CardContent>{isLoading ? <Skeleton className="h-40 w-full" /> : devices.length ? <Table><TableCaption className="sr-only">Danh sách thiết bị.</TableCaption><TableHeader><TableRow><TableHead>MAC</TableHead><TableHead>Người dùng</TableHead><TableHead>Trạng thái</TableHead><TableHead>Hoạt động cuối</TableHead><TableHead>Thao tác</TableHead></TableRow></TableHeader><TableBody>{devices.map((device) => <TableRow key={device.mac_address}><TableCell className="font-mono text-xs">{formatMacAddress(device.mac_address)}</TableCell><TableCell>{device.username || "Chưa gán"}</TableCell><TableCell><Badge variant={isActive(device.is_online) ? "secondary" : "outline"}>{isActive(device.is_online) ? "Trực tuyến" : "Ngoại tuyến"}</Badge></TableCell><TableCell>{formatDate(device.last_seen)}</TableCell><TableCell>{isActive(device.is_online) ? <Button variant="destructive" size="sm" onClick={() => onDisconnect(device)}>Ngắt thiết bị</Button> : "-"}</TableCell></TableRow>)}</TableBody></Table> : <NoRecords title="Chưa có thiết bị" description="Thiết bị xuất hiện sau lần kết nối đầu tiên." />}</CardContent></Card>;
}

function AccessView({ entries, isLoading, onRevoke }: { entries: MacAuthorization[]; isLoading: boolean; onRevoke: (entry: MacAuthorization) => void }) {
  return <Card><CardHeader><CardTitle>Quyền truy cập theo MAC</CardTitle><CardDescription>Quyền này tự hết hạn hoặc có thể bị thu hồi ngay tại đây.</CardDescription></CardHeader><CardContent>{isLoading ? <Skeleton className="h-40 w-full" /> : entries.length ? <Table><TableCaption className="sr-only">Danh sách quyền truy cập MAC.</TableCaption><TableHeader><TableRow><TableHead>MAC</TableHead><TableHead>Nguồn cấp</TableHead><TableHead>Tài khoản</TableHead><TableHead>Hết hạn</TableHead><TableHead>Thao tác</TableHead></TableRow></TableHeader><TableBody>{entries.map((entry) => <TableRow key={entry.mac}><TableCell className="font-mono text-xs">{formatMacAddress(entry.mac)}</TableCell><TableCell><Badge variant="outline">{entry.access_type === "account" ? "Tài khoản" : "Truy cập nhanh"}</Badge></TableCell><TableCell>{entry.username || "Khách"}</TableCell><TableCell>{formatDate(entry.expires_at)}</TableCell><TableCell><Button variant="destructive" size="sm" onClick={() => onRevoke(entry)}>Thu hồi</Button></TableCell></TableRow>)}</TableBody></Table> : <NoRecords title="Chưa cấp quyền MAC" description="Quyền sẽ xuất hiện sau khi khách truy cập nhanh hoặc xác thực tài khoản." />}</CardContent></Card>;
}

function AccountsView({
  users,
  packages,
  isLoading,
  createDialogOpen,
  setCreateDialogOpen,
  editingUser,
  setEditingUser,
  onCreate,
  onUpdate,
  onToggle,
  onDelete,
}: {
  users: PortalUser[];
  packages: Package[];
  isLoading: boolean;
  createDialogOpen: boolean;
  setCreateDialogOpen: (open: boolean) => void;
  editingUser: PortalUser | null;
  setEditingUser: (user: PortalUser | null) => void;
  onCreate: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  onUpdate: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  onToggle: (user: PortalUser) => void;
  onDelete: (user: PortalUser) => void;
}) {
  const [assignPackage, setAssignPackage] = useState(false);

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-4">
        <div className="flex flex-col gap-1.5">
          <CardTitle>Tài khoản portal</CardTitle>
          <CardDescription>Quản lý tài khoản người dùng và gán gói cước băng thông tương ứng.</CardDescription>
        </div>
        <Dialog open={createDialogOpen} onOpenChange={(open) => { setCreateDialogOpen(open); if (!open) setAssignPackage(false); }}>
          <DialogTrigger render={<Button />}><UserPlusIcon data-icon="inline-start" />Thêm tài khoản</DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Tạo tài khoản nội bộ</DialogTitle>
              <DialogDescription>Tài khoản này được dùng để đăng nhập portal nội bộ.</DialogDescription>
            </DialogHeader>
            <form onSubmit={(event) => void onCreate(event)}>
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="new-username">Tài khoản</FieldLabel>
                  <Input id="new-username" name="username" autoComplete="off" required />
                </Field>
                <Field>
                  <FieldLabel htmlFor="new-password">Mật khẩu</FieldLabel>
                  <Input id="new-password" name="password" type="password" autoComplete="new-password" required />
                </Field>
                <Field>
                  <FieldLabel htmlFor="new-max-devices">Số thiết bị tối đa</FieldLabel>
                  <Input id="new-max-devices" name="max_devices" type="number" min="1" defaultValue="3" required />
                </Field>

                {/* Checkbox và Dropdown chọn gói cước */}
                <Field>
                  <div className="flex items-center gap-2 pt-1 pb-2">
                    <input
                      type="checkbox"
                      id="assign-pkg-check"
                      checked={assignPackage}
                      onChange={(e) => setAssignPackage(e.target.checked)}
                      className="size-4 rounded border-input text-primary focus:ring-primary cursor-pointer"
                    />
                    <label htmlFor="assign-pkg-check" className="text-sm font-medium cursor-pointer select-none">
                      Áp dụng gói cước cho tài khoản này
                    </label>
                  </div>
                  {assignPackage && (
                    <div className="space-y-1.5 pl-6">
                      <FieldLabel htmlFor="new-pkg-select">Chọn gói cước</FieldLabel>
                      <select
                        id="new-pkg-select"
                        name="package_id"
                        className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      >
                        <option value="">-- Chọn gói cước --</option>
                        {packages.map((pkg) => (
                          <option key={pkg.id} value={pkg.id}>
                            {pkg.name} ({formatMinutes(pkg.duration_minutes)} · ↓{formatSpeed(pkg.bandwidth_down_kbps)} / ↑{formatSpeed(pkg.bandwidth_up_kbps)})
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                </Field>

                <DialogFooter>
                  <DialogClose render={<Button variant="outline" />}>Hủy</DialogClose>
                  <Button type="submit">Tạo tài khoản</Button>
                </DialogFooter>
              </FieldGroup>
            </form>
          </DialogContent>
        </Dialog>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-40 w-full" />
        ) : users.length ? (
          <Table>
            <TableCaption className="sr-only">Danh sách tài khoản portal.</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead>Tài khoản</TableHead>
                <TableHead>Loại</TableHead>
                <TableHead>Gói cước</TableHead>
                <TableHead>Thiết bị</TableHead>
                <TableHead>Trạng thái</TableHead>
                <TableHead>Thao tác</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.map((user) => (
                <TableRow key={user.id}>
                  <TableCell className="font-medium">{user.identifier}</TableCell>
                  <TableCell><Badge variant="outline">{user.type}</Badge></TableCell>
                  <TableCell>
                    <Badge variant={user.package_name ? "secondary" : "outline"}>
                      {user.package_name || "Mặc định"}
                    </Badge>
                  </TableCell>
                  <TableCell>{user.max_devices}</TableCell>
                  <TableCell>
                    <Badge variant={isActive(user.is_active) ? "secondary" : "destructive"}>
                      {isActive(user.is_active) ? "Hoạt động" : "Đã khóa"}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <div className="flex gap-2">
                      <Button variant="outline" size="sm" onClick={() => setEditingUser(user)}>
                        <PencilIcon data-icon="inline-start" />
                        Sửa
                      </Button>
                      <Button variant="outline" size="sm" onClick={() => onToggle(user)}>
                        {isActive(user.is_active) ? "Khóa" : "Mở khóa"}
                      </Button>
                      <Button variant="destructive" size="sm" onClick={() => onDelete(user)}>Xóa</Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <NoRecords title="Chưa có tài khoản" description="Tạo một tài khoản để khách có thể đăng nhập vào portal." />
        )}
      </CardContent>

      {/* Dialog Sửa tài khoản & Đổi gói cước */}
      <Dialog open={Boolean(editingUser)} onOpenChange={(open) => { if (!open) setEditingUser(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Chỉnh sửa tài khoản</DialogTitle>
            <DialogDescription>Cập nhật số thiết bị và gói cước cho tài khoản &quot;{editingUser?.identifier}&quot;.</DialogDescription>
          </DialogHeader>
          {editingUser && (
            <form onSubmit={(event) => void onUpdate(event)}>
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="edit-user-devices">Số thiết bị tối đa</FieldLabel>
                  <Input id="edit-user-devices" name="max_devices" type="number" min="1" defaultValue={editingUser.max_devices} required />
                </Field>

                <Field>
                  <FieldLabel htmlFor="edit-user-pkg">Gói cước áp dụng</FieldLabel>
                  <select
                    id="edit-user-pkg"
                    name="package_id"
                    defaultValue={editingUser.package_id || ""}
                    className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    <option value="">-- Mặc định hệ thống (Không gắn gói) --</option>
                    {packages.map((pkg) => (
                      <option key={pkg.id} value={pkg.id}>
                        {pkg.name} ({formatMinutes(pkg.duration_minutes)} · ↓{formatSpeed(pkg.bandwidth_down_kbps)} / ↑{formatSpeed(pkg.bandwidth_up_kbps)})
                      </option>
                    ))}
                  </select>
                  <FieldDescription>Router sẽ nhận giới hạn tốc độ và thời lượng theo gói này khi user đăng nhập.</FieldDescription>
                </Field>

                <DialogFooter>
                  <DialogClose render={<Button variant="outline" />}>Hủy</DialogClose>
                  <Button type="submit">Lưu thay đổi</Button>
                </DialogFooter>
              </FieldGroup>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function PackagesView({
  packages,
  isLoading,
  createDialogOpen,
  setCreateDialogOpen,
  editingPackage,
  setEditingPackage,
  onCreate,
  onUpdate,
  onDelete,
}: {
  packages: Package[];
  isLoading: boolean;
  createDialogOpen: boolean;
  setCreateDialogOpen: (open: boolean) => void;
  editingPackage: Package | null;
  setEditingPackage: (pkg: Package | null) => void;
  onCreate: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  onUpdate: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  onDelete: (pkg: Package) => void;
}) {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-medium">Gói cước WiFi & Băng thông</h2>
          <p className="text-sm text-muted-foreground">Cấu hình thời lượng và tốc độ tải xuống/lên gửi xuống router qua RADIUS.</p>
        </div>
        <Button onClick={() => setCreateDialogOpen(true)}>
          <PlusIcon data-icon="inline-start" />
          Thêm gói cước
        </Button>
      </div>

      {isLoading ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 3 }, (_, index) => (
            <Card key={index}>
              <CardHeader><Skeleton className="h-5 w-32" /><Skeleton className="h-4 w-48" /></CardHeader>
              <CardContent><Skeleton className="h-16 w-full" /></CardContent>
            </Card>
          ))}
        </div>
      ) : !packages.length ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center p-8 text-center">
            <NoRecords title="Chưa có gói cước nào" description="Tạo gói cước để thiết lập giới hạn tốc độ và thời gian cho mạng WiFi." />
            <Button className="mt-4" onClick={() => setCreateDialogOpen(true)}>
              <PlusIcon data-icon="inline-start" />
              Thêm gói cước ngay
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {packages.map((pkg) => (
            <Card key={pkg.id} className="flex flex-col justify-between">
              <CardHeader>
                <div className="flex items-start justify-between gap-3">
                  <div className="flex flex-col gap-1">
                    <CardTitle className="text-lg">{pkg.name}</CardTitle>
                    <CardDescription>{formatMinutes(pkg.duration_minutes)}</CardDescription>
                  </div>
                  <Badge variant="secondary">{pkg.max_devices} thiết bị</Badge>
                </div>
              </CardHeader>
              <CardContent className="flex flex-col gap-3 text-sm">
                <div className="flex items-center justify-between gap-4">
                  <span className="text-muted-foreground">Tốc độ Tải xuống (Down)</span>
                  <span className="font-mono font-medium text-emerald-600 dark:text-emerald-400">
                    ↓ {formatSpeed(pkg.bandwidth_down_kbps)} ({pkg.bandwidth_down_kbps} Kbps)
                  </span>
                </div>
                <div className="flex items-center justify-between gap-4">
                  <span className="text-muted-foreground">Tốc độ Tải lên (Up)</span>
                  <span className="font-mono font-medium text-sky-600 dark:text-sky-400">
                    ↑ {formatSpeed(pkg.bandwidth_up_kbps)} ({pkg.bandwidth_up_kbps} Kbps)
                  </span>
                </div>
              </CardContent>
              <CardFooter className="flex items-center justify-end gap-2 border-t pt-4">
                <Button variant="outline" size="sm" onClick={() => setEditingPackage(pkg)}>
                  <PencilIcon data-icon="inline-start" />
                  Sửa
                </Button>
                <Button variant="destructive" size="sm" onClick={() => onDelete(pkg)}>
                  <Trash2Icon data-icon="inline-start" />
                  Xóa
                </Button>
              </CardFooter>
            </Card>
          ))}
        </div>
      )}

      {/* Dialog Tạo gói cước mới */}
      <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Thêm gói cước mới</DialogTitle>
            <DialogDescription>Cấu hình giới hạn thời gian và băng thông tải xuống/lên.</DialogDescription>
          </DialogHeader>
          <form onSubmit={(event) => void onCreate(event)}>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="pkg-name">Tên gói cước</FieldLabel>
                <Input id="pkg-name" name="name" placeholder="Ví dụ: Gói 1 giờ, Gói VIP, Gói Ngày" required />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field>
                  <FieldLabel htmlFor="pkg-duration">Thời lượng (phút)</FieldLabel>
                  <Input id="pkg-duration" name="duration_minutes" type="number" min="1" defaultValue="60" required />
                </Field>
                <Field>
                  <FieldLabel htmlFor="pkg-devices">Số thiết bị</FieldLabel>
                  <Input id="pkg-devices" name="max_devices" type="number" min="1" defaultValue="1" required />
                </Field>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field>
                  <FieldLabel htmlFor="pkg-down">Tải xuống (Kbps)</FieldLabel>
                  <Input id="pkg-down" name="bandwidth_down_kbps" type="number" min="128" defaultValue="5000" required />
                  <FieldDescription>5000 Kbps ≈ 5 Mbps</FieldDescription>
                </Field>
                <Field>
                  <FieldLabel htmlFor="pkg-up">Tải lên (Kbps)</FieldLabel>
                  <Input id="pkg-up" name="bandwidth_up_kbps" type="number" min="128" defaultValue="2000" required />
                  <FieldDescription>2000 Kbps ≈ 2 Mbps</FieldDescription>
                </Field>
              </div>
              <DialogFooter>
                <DialogClose render={<Button variant="outline" />}>Hủy</DialogClose>
                <Button type="submit">Tạo gói cước</Button>
              </DialogFooter>
            </FieldGroup>
          </form>
        </DialogContent>
      </Dialog>

      {/* Dialog Chỉnh sửa gói cước */}
      <Dialog open={Boolean(editingPackage)} onOpenChange={(open) => { if (!open) setEditingPackage(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Chỉnh sửa gói cước</DialogTitle>
            <DialogDescription>Cập nhật thông số gói cước &quot;{editingPackage?.name}&quot;.</DialogDescription>
          </DialogHeader>
          {editingPackage && (
            <form onSubmit={(event) => void onUpdate(event)}>
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="edit-pkg-name">Tên gói cước</FieldLabel>
                  <Input id="edit-pkg-name" name="name" defaultValue={editingPackage.name} required />
                </Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field>
                    <FieldLabel htmlFor="edit-pkg-duration">Thời lượng (phút)</FieldLabel>
                    <Input id="edit-pkg-duration" name="duration_minutes" type="number" min="1" defaultValue={editingPackage.duration_minutes} required />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="edit-pkg-devices">Số thiết bị</FieldLabel>
                    <Input id="edit-pkg-devices" name="max_devices" type="number" min="1" defaultValue={editingPackage.max_devices} required />
                  </Field>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <Field>
                    <FieldLabel htmlFor="edit-pkg-down">Tải xuống (Kbps)</FieldLabel>
                    <Input id="edit-pkg-down" name="bandwidth_down_kbps" type="number" min="128" defaultValue={editingPackage.bandwidth_down_kbps} required />
                    <FieldDescription>{(editingPackage.bandwidth_down_kbps / 1000).toFixed(1)} Mbps</FieldDescription>
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="edit-pkg-up">Tải lên (Kbps)</FieldLabel>
                    <Input id="edit-pkg-up" name="bandwidth_up_kbps" type="number" min="128" defaultValue={editingPackage.bandwidth_up_kbps} required />
                    <FieldDescription>{(editingPackage.bandwidth_up_kbps / 1000).toFixed(1)} Mbps</FieldDescription>
                  </Field>
                </div>
                <DialogFooter>
                  <DialogClose render={<Button variant="outline" />}>Hủy</DialogClose>
                  <Button type="submit">Lưu thay đổi</Button>
                </DialogFooter>
              </FieldGroup>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function BackupView({ isBackingUp, message, onCreate }: { isBackingUp: boolean; message: string; onCreate: () => void }) {
  return <Card className="max-w-2xl"><CardHeader><CardTitle>Sao lưu cơ sở dữ liệu</CardTitle><CardDescription>Tạo bản sao lưu thủ công. Nếu WebDAV đã cấu hình trên máy chủ, hệ thống sẽ gửi kèm bản sao đó.</CardDescription></CardHeader><CardContent className="flex flex-col gap-5">{message ? <Alert><DatabaseBackupIcon aria-hidden="true" /><AlertTitle>Trạng thái sao lưu</AlertTitle><AlertDescription>{message}</AlertDescription></Alert> : null}<Button size="lg" className="w-fit" onClick={onCreate} disabled={isBackingUp}>{isBackingUp ? <Spinner data-icon="inline-start" /> : <DatabaseBackupIcon data-icon="inline-start" />}{isBackingUp ? "Đang sao lưu" : "Tạo sao lưu ngay"}</Button></CardContent><CardFooter className="text-sm text-muted-foreground">Chỉ quản trị viên mới có thể tạo sao lưu.</CardFooter></Card>;
}

function SettingsView({
  config,
  isLoading,
  radiusTestResult,
  isRadiusTesting,
  radiusTestInput,
  onRadiusTestInputChange,
  onTestRadius,
  onRefresh,
}: {
  config: SettingsConfig | null;
  isLoading: boolean;
  radiusTestResult: TestResult | null;
  isRadiusTesting: boolean;
  radiusTestInput: { routerIp: string; sharedSecret: string; authPort: number };
  onRadiusTestInputChange: (input: { routerIp: string; sharedSecret: string; authPort: number }) => void;
  onTestRadius: () => void;
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
/ip hotspot profile set [find default=yes] use-radius=yes radius-accounting=yes radius-interim-update=received login-by=http-pap
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
                  <li><strong>Kích hoạt trên Hotspot:</strong> Vào <code>IP</code> → <code>Hotspot</code> → <code>Server Profiles</code> → Chọn profile → Tab <code>RADIUS</code> (Tích chọn <code>Use RADIUS</code>, <code>Accounting</code>, Interim Update: <code>received</code>) → Tab <code>Login</code> (Chọn <code>HTTP PAP</code>).</li>
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
                    <li>Accounting: chọn Interim Update <code>received</code>; RADIUS cấp interval 10 giây.</li>
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

export default AdminApp;
