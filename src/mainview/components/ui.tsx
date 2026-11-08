import { X } from "lucide-react";
import {
  Children,
  cloneElement,
  isValidElement,
  type ReactNode,
  type RefObject,
  useEffect,
  useId,
  useRef,
} from "react";

export const Alert = ({
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
}) => {
  return (
    <div className={`alert ${kind}`} role={role ?? (kind === "success" ? "status" : "alert")}>
      <span>{children}</span>
      <button type="button" className="icon-button" aria-label={label} onClick={onDismiss}>
        <X size={16} />
      </button>
    </div>
  );
};

export const Field = ({
  label,
  help,
  children,
}: {
  label: string;
  help?: string;
  children: ReactNode;
}) => {
  const id = useId();
  const associate = (node: ReactNode): ReactNode => {
    if (!isValidElement<{ id?: string; "aria-describedby"?: string; children?: ReactNode }>(node))
      return node;
    if (typeof node.type === "string" && ["input", "select", "textarea"].includes(node.type)) {
      return cloneElement(node, { id, "aria-describedby": help ? `${id}-help` : undefined });
    }
    return node.props.children
      ? cloneElement(node, { children: Children.map(node.props.children, associate) })
      : node;
  };
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {Children.map(children, associate)}
      {help && <small id={`${id}-help`}>{help}</small>}
    </div>
  );
};

export const Toggle = ({
  label,
  description,
  checked,
  onChange,
  disabled = false,
}: {
  label: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) => {
  return (
    <label className="toggle-row">
      <span>
        <strong>{label}</strong>
        <small>{description}</small>
      </span>
      <input
        type="checkbox"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
  );
};

export const Modal = ({
  title,
  children,
  onClose,
  fallbackFocus,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  fallbackFocus: RefObject<HTMLElement | null>;
}) => {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    const opener = document.activeElement;
    dialog?.showModal();
    return () => {
      dialog?.close();
      if (opener instanceof HTMLElement && opener.isConnected && !opener.matches(":disabled"))
        opener.focus();
      else fallbackFocus.current?.focus();
    };
  }, [fallbackFocus]);
  return (
    <dialog
      ref={ref}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      aria-labelledby={titleId}
    >
      <div className="dialog-heading">
        <h2 id={titleId}>{title}</h2>
        <button type="button" className="icon-button" aria-label="Close dialog" onClick={onClose}>
          <X size={18} />
        </button>
      </div>
      {children}
    </dialog>
  );
};
