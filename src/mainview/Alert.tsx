import { X } from "lucide-react";
import type { ReactNode } from "react";

export function Alert({
  children,
  kind = "error",
  onDismiss,
  label = "Dismiss error",
  role,
}: {
  children: ReactNode;
  kind?: "error" | "success" | "warning";
  onDismiss: () => void;
  label?: string;
  role?: "alert" | "status";
}) {
  return (
    <div className={`alert ${kind}`} role={role ?? (kind === "success" ? "status" : "alert")}>
      <span>{children}</span>
      <button type="button" className="icon-button" aria-label={label} onClick={onDismiss}>
        <X size={16} />
      </button>
    </div>
  );
}
