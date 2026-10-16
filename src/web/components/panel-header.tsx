import type { ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import { Button } from "./controls.js";

export function PanelHeader({
  title,
  backLabel,
  onBack,
  headingClassName,
}: {
  title: ReactNode;
  backLabel?: string;
  onBack?: () => void;
  headingClassName?: string;
}) {
  return (
    <header className="panel-header">
      {onBack && (
        <Button
          variant="ghost"
          className="panel-back"
          aria-label={backLabel}
          title={backLabel}
          onClick={onBack}
        >
          <ArrowLeft size={20} aria-hidden="true" />
        </Button>
      )}
      <h2 className={headingClassName} tabIndex={-1}>
        {title}
      </h2>
    </header>
  );
}
