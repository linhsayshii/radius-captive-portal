import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function normalizeMacAddress(value: string | null | undefined) {
  if (typeof value !== "string") return "";
  const normalized = value.replace(/[^0-9a-f]/gi, "").toLowerCase();
  return /^[0-9a-f]{12}$/.test(normalized) ? normalized : "";
}

// Storage and API values use a separator-free MAC as the canonical key.
// Format only at the UI boundary so users see the same notation as the NAS.
export function formatMacAddress(value: string | null | undefined) {
  const normalized = normalizeMacAddress(value);
  if (!normalized) return "Chưa có";
  return normalized.match(/.{2}/g)!.join(":").toUpperCase();
}
