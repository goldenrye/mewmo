import { t } from "./i18n";
import { Component, StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";
import "./readability.css";

class ErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <div className="loading-page">
        <h2>{t("Let’s try that again.")}</h2>
        <p>
          {t(
            "Mewmo couldn’t display this page. Your saved items are still on the server.",
          )}
        </p>
        <button className="primary" onClick={() => location.reload()}>
          {t("Reload Mewmo")}
        </button>
      </div>
    ) : (
      this.props.children
    );
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
