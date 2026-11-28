import { useGT, useLocale } from "gt-react";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
import { usePrimarySettings } from "~/hooks/useSettings";
import { formatFullTimestamp } from "~/timestampFormat";
import { parseAntigravityQuotaReport, type AntigravityQuotaGroup } from "./antigravityQuotaReport";

export interface AntigravityQuotaSnapshot {
  readonly groups: readonly AntigravityQuotaGroup[] | null;
  readonly openedAt: string;
}

function PreviewContent({ snapshot }: { snapshot: AntigravityQuotaSnapshot }) {
  const gt = useGT();
  const locale = useLocale();
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const [reading, setReading] = useState(snapshot);
  const [input, setInput] = useState("");
  const [sourceAccount, setSourceAccount] = useState("");
  const percentage = new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1 });
  const unknown = gt("Unknown", { $context: "missing quota or account information" });

  if (!reading.groups) {
    return (
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          const groups = parseAntigravityQuotaReport(input);
          if (groups) {
            setReading({ groups, openedAt: new Date().toISOString() });
            setInput("");
          }
        }}
      >
        <p role="alert" className="text-sm text-muted-foreground">
          {gt(
            "No complete Antigravity quota report was found. Select the command output again or paste the JSON below.",
          )}
        </p>
        <Textarea
          aria-label={gt("Antigravity quota JSON")}
          value={input}
          onChange={(event) => setInput(event.currentTarget.value)}
          spellCheck={false}
        />
        <Button type="submit" disabled={!input.trim()}>
          {gt("Show quota")}
        </Button>
      </form>
    );
  }

  return (
    <>
      <div className="space-y-1.5">
        <label className="block text-sm">
          {gt("Source account (optional)")}
          <Input
            className="mt-1.5"
            placeholder={unknown}
            value={sourceAccount}
            onChange={(event) => setSourceAccount(event.currentTarget.value)}
          />
        </label>
        <p className="text-xs text-muted-foreground">
          {gt("Opened in T3 at {time}", {
            time: formatFullTimestamp(reading.openedAt, timestampFormat),
          })}
        </p>
      </div>
      {reading.groups.map((group) => (
        <section key={group.name} className="space-y-2 rounded-lg border border-border p-3">
          <h3 className="wrap-anywhere text-sm font-medium">{group.name}</h3>
          {group.windows.map((window) => (
            <div key={window.id} className="space-y-1">
              <div className="flex items-baseline justify-between gap-2 text-sm">
                <span className="wrap-anywhere">{window.label}</span>
                <span className="shrink-0 tabular-nums">
                  {window.remaining === null ? unknown : percentage.format(window.remaining)}
                </span>
              </div>
              {window.remaining !== null && (
                <div className="h-2 overflow-hidden rounded-full bg-muted" aria-hidden="true">
                  <div
                    className="h-full rounded-full bg-primary"
                    style={{ width: `${window.remaining * 100}%` }}
                  />
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                {window.resetsAt
                  ? gt("Resets at {time}", {
                      time: formatFullTimestamp(window.resetsAt, timestampFormat),
                    })
                  : gt("Reset time unknown")}
              </p>
            </div>
          ))}
        </section>
      ))}
    </>
  );
}

export function AntigravityQuotaPreview({
  snapshot,
  onClose,
  restoreFocus,
}: {
  snapshot: AntigravityQuotaSnapshot | null;
  onClose: () => void;
  restoreFocus: () => void;
}) {
  const gt = useGT();
  return (
    <Dialog open={snapshot !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogPopup
        finalFocus={() => {
          restoreFocus();
          return false;
        }}
      >
        <DialogHeader>
          <DialogTitle>{gt("Antigravity quota")}</DialogTitle>
          <DialogDescription>{gt("Manual snapshot from terminal output")}</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {snapshot && <PreviewContent key={snapshot.openedAt} snapshot={snapshot} />}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
