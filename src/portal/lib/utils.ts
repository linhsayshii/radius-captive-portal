import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Storage and API values use a separator-free MAC as the canonical key.
// Format only at the UI boundary so users see the same notation as the NAS.
export function formatMacAddress(value: string | null | undefined) {
  if (!value) return "Chưa có";
  const normalized = value.replace(/[^0-9a-f]/gi, "");
  if (!/^[0-9a-f]{12}$/i.test(normalized)) return value;
  return normalized.match(/.{2}/g)!.join(":").toUpperCase();
}
