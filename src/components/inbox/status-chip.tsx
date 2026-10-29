import { Check, Circle, Clock } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ConversationStatus } from "@/types";

// The brand color marks unread only; each status has its own color, icon
// and label so the two never read the same.
export const STATUS_STYLES: Record<ConversationStatus, { chip: string; dot: string; icon: typeof Circle }> = {
  open: {
    chip: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
    dot: "bg-emerald-500",
    icon: Circle,
  },
  pending: {
    chip: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
    dot: "bg-amber-500",
    icon: Clock,
  },
  closed: {
    chip: "bg-muted text-muted-foreground",
    dot: "bg-muted-foreground",
    icon: Check,
  },
};

/** Status label with its own color and icon (never the brand color). */
export function StatusChip({ status, label, className }: { status: ConversationStatus; label: string; className?: string }) {
  const style = STATUS_STYLES[status];
  const Icon = style.icon;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 whitespace-nowrap rounded px-1.5 py-px text-[10px] font-semibold",
        style.chip,
        className
      )}
    >
      <Icon className="h-2.5 w-2.5" strokeWidth={3} />
      {label}
    </span>
  );
}
