import projectIcon from "../project-icon.svg";
import "../startup-screen.css";

export function StartupScreen() {
  return (
    <main className="startup-screen" aria-busy="true">
      <div className="startup-indicator" role="status" aria-label="正在启动">
        <span className="startup-ring" aria-hidden="true" />
        <img
          className="startup-logo"
          src={projectIcon}
          alt=""
          width="56"
          height="56"
        />
      </div>
    </main>
  );
}
