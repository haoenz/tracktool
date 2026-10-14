import { render, Text } from "ink";
import type { Instance } from "ink";
import type { TaskEvent } from "../shared/contracts.js";
export class Reporter {
  private ui?: Instance;
  private readonly threshold: number;
  constructor(level: string, verbose: number, quiet: boolean) {
    this.threshold =
      verbose >= 2
        ? 0
        : verbose === 1
          ? 1
          : quiet
            ? 3
            : Math.max(
                0,
                ["DEBUG", "VERBOSE", "INFO", "WARNING", "ERROR"].indexOf(level),
              );
  }
  report = (event: TaskEvent): void => {
    if (event.type === "log") {
      if (
        ["DEBUG", "VERBOSE", "INFO", "WARNING", "ERROR"].indexOf(event.level) <
        this.threshold
      )
        return;
      this.ui?.clear();
      process.stderr.write(`${event.level}: ${event.message}\n`);
    } else if (process.stderr.isTTY && this.threshold <= 2) {
      const filled = event.total
        ? Math.round((event.completed / event.total) * 20)
        : 0;
      const view = (
        <Text color="cyan">
          {"█".repeat(filled)}
          {"░".repeat(20 - filled)} {event.completed}/{event.total}
        </Text>
      );
      if (this.ui) this.ui.rerender(view);
      else
        this.ui = render(view, {
          stdout: process.stderr,
          stderr: process.stderr,
          stdin: process.stdin,
          exitOnCtrlC: false,
          patchConsole: false,
        });
    }
  };
  close(): void {
    this.ui?.unmount();
    this.ui = undefined;
  }
}
