import { X } from 'lucide-react';
import {
  Children,
  cloneElement,
  isValidElement,
  type ReactNode,
  type RefObject,
  useEffect,
  useId,
  useRef,
} from 'react';

import { Alert as MacAlert } from '@mcp-gateway/mainview/components/mac/alert';
import { Button } from '@mcp-gateway/mainview/components/mac/button';
import { Checkbox } from '@mcp-gateway/mainview/components/mac/checkbox';
import { Input } from '@mcp-gateway/mainview/components/mac/input';
import { Label } from '@mcp-gateway/mainview/components/mac/label';
import { NativeSelect } from '@mcp-gateway/mainview/components/mac/native-select';
import { Switch } from '@mcp-gateway/mainview/components/mac/switch';
import { useI18n } from '@mcp-gateway/mainview/i18n';

const ALERT_VARIANT = { error: 'destructive', warning: 'warning', success: 'default' } as const;

interface Alert {
  children: ReactNode;
  kind?: 'error' | 'success' | 'warning';
  onDismiss: () => void;
  label?: string;
  role?: 'alert' | 'status';
}

interface Field {
  label: string;
  help?: string;
  children: ReactNode;
}

export const Alert = ({ children, kind = 'error', onDismiss, label, role }: Alert) => {
  const { t } = useI18n();
  return (
    <MacAlert
      variant={ALERT_VARIANT[kind]}
      role={role ?? (kind === 'success' ? 'status' : 'alert')}
      className="flex items-center gap-2.5 text-mac-label"
    >
      <span className="min-w-0 flex-1 wrap-anywhere">{children}</span>
      <Button
        variant="ghost"
        size="icon"
        aria-label={label ?? t('common.dismissError')}
        onClick={onDismiss}
      >
        <X />
      </Button>
    </MacAlert>
  );
};

// Controls a Field can label: the macOS input and select.
const FIELD_CONTROLS: unknown[] = [Input, NativeSelect];

export const Field = ({ label, help, children }: Field) => {
  const id = useId();
  const associate = (node: ReactNode): ReactNode => {
    if (!isValidElement<{ id?: string; 'aria-describedby'?: string; children?: ReactNode }>(node))
      return node;
    if (FIELD_CONTROLS.includes(node.type)) {
      return cloneElement(node, { id, 'aria-describedby': help ? `${id}-help` : undefined });
    }
    return node.props.children
      ? cloneElement(node, { children: Children.map(node.props.children, associate) })
      : node;
  };
  const focusUnlabelable = () => {
    const control = document.getElementById(id);
    if (control && !('labels' in control)) control.focus();
  };
  return (
    <div className="field">
      <Label htmlFor={id} id={`${id}-label`} className="font-semibold" onClick={focusUnlabelable}>
        {label}
      </Label>
      {Children.map(children, associate)}
      {help && <small id={`${id}-help`}>{help}</small>}
    </div>
  );
};

interface Toggle {
  label: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}

export const Toggle = ({ label, description, checked, onChange, disabled = false }: Toggle) => {
  const id = useId();
  return (
    <label className="toggle-row" htmlFor={id}>
      <span>
        <strong>{label}</strong>
        <small>{description}</small>
      </span>
      <Switch
        id={id}
        size="sm"
        checked={checked}
        disabled={disabled}
        onCheckedChange={(value) => onChange(value)}
      />
    </label>
  );
};

interface CheckboxRow {
  label: string;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}

export const CheckboxRow = ({ label, checked, disabled, onChange }: CheckboxRow) => {
  const id = useId();
  return (
    <div className="checkbox-row">
      <Checkbox
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={(value) => onChange(value)}
      />
      <Label htmlFor={id} className="text-mac-label-secondary">
        {label}
      </Label>
    </div>
  );
};

interface Modal {
  title: string;
  children: ReactNode;
  onClose: () => void;
  fallbackFocus: RefObject<HTMLElement | null>;
  busy?: boolean;
}

export const Modal = ({ title, children, onClose, fallbackFocus, busy = false }: Modal) => {
  const { t } = useI18n();
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    const opener = document.activeElement;
    dialog?.showModal();
    return () => {
      dialog?.close();
      if (document.querySelector('dialog[open]')) return;
      if (opener instanceof HTMLElement && opener.isConnected && !opener.matches(':disabled'))
        opener.focus();
      else fallbackFocus.current?.focus();
    };
  }, [fallbackFocus]);
  return (
    <dialog
      ref={ref}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
      aria-labelledby={titleId}
    >
      <div className="dialog-heading">
        <h2 id={titleId}>{title}</h2>
        <Button
          variant="ghost"
          size="icon-lg"
          aria-label={t('common.closeDialog')}
          disabled={busy}
          onClick={() => {
            if (!busy) onClose();
          }}
        >
          <X />
        </Button>
      </div>
      {children}
    </dialog>
  );
};
