import { useContext, type ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import { SheetContext } from "./sheet-handle.js";
import { Button } from "./controls.js";

export function PanelHeader({
  title,
  backLabel,
  onBack,
  headingClassName,
  className = "",
}: {
  title: ReactNode;
  backLabel?: string;
  onBack?: () => void;
  headingClassName?: string;
  className?: string;
}) {
  const sheet = useContext(SheetContext);
  return (
    <header className={`panel-header ${className}`} {...sheet?.events}>
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
