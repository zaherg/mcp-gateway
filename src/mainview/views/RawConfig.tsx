import { Field } from "@mcp-gateway/mainview/components/ui";
import type { Document } from "@mcp-gateway/mainview/dialogs/ServerEditor";
import type { ConfigFormat } from "@mcp-gateway/shared/config-document";
import type { GatewaySnapshot } from "@mcp-gateway/shared/types";
import { ArrowDownToLine, ChevronRight, Code2 } from "lucide-react";
import type { RefObject } from "react";

export const RawConfig = ({
  doc,
  setDoc,
  configurationLocked,
  format,
  filename,
  gateway,
  dirty,
  retryLogin,
  save,
  rawOpen,
  setRawOpen,
  fallbackFocus,
  setNotice,
}: {
  doc: Document;
  setDoc: (doc: Document) => void;
  configurationLocked: boolean;
  format: ConfigFormat;
  filename: string;
  gateway: GatewaySnapshot | undefined;
  dirty: boolean;
  retryLogin: boolean;
  save: () => Promise<boolean>;
  rawOpen: boolean;
  setRawOpen: (open: boolean) => void;
  fallbackFocus: RefObject<HTMLButtonElement | null>;
  setNotice: (notice: string) => void;
}) => {
  return (
    <section className="panel raw-panel">
      <button
        type="button"
        className="raw-heading"
        ref={fallbackFocus}
        aria-expanded={rawOpen}
        onClick={() => setRawOpen(!rawOpen)}
      >
        <Code2 size={18} />
        <span>
          <strong>Authoritative configuration</strong>
          <small>{filename} · advanced editing</small>
        </span>
        <ChevronRight className={rawOpen ? "expanded" : ""} size={18} />
      </button>
      {rawOpen && (
        <div className="raw-body">
          <p className="mono config-path">{gateway?.configPath}</p>
          <p>
            Full file contents, including credentials. Invalid saves are rejected without discarding
            your draft. Preserve a copy of your edits before reloading external changes.{" "}
            {format === "jsonc"
              ? "JSONC accepts // and /* */ comments and trailing commas."
              : "Strict JSON: comments and trailing commas are not allowed."}{" "}
            Changing the filename requires reopening the app.
          </p>
          <Field label={filename}>
            <textarea
              className="code-editor"
              readOnly={configurationLocked}
              spellCheck={false}
              value={doc.text}
              onChange={(event) => {
                if (configurationLocked) return;
                setDoc({ ...doc, text: event.target.value, dirty: true });
                setNotice("");
              }}
            />
          </Field>
          <button
            type="button"
            className="button primary"
            disabled={configurationLocked || (!dirty && !retryLogin)}
            onClick={() => void save()}
          >
            <ArrowDownToLine size={15} /> Save {filename}
          </button>
        </div>
      )}
    </section>
  );
};
