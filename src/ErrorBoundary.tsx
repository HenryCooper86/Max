import React from "react";

type Props = { children: React.ReactNode };
type State = { error: Error | null };

/** Catches render-time crashes so the helmet HUD shows a recoverable screen. */
export class ErrorBoundary extends React.Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("Helmet HUD crashed", error, info);
  }

  override render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <main className="shell">
        <section className="visor errorVisor">
          <p className="eyebrow">HCT Helmet OS</p>
          <h1>头盔 HUD 遇到错误</h1>
          <p className="errorMessage">{error.message || "未知错误"}</p>
          <button className="mainButton" type="button" onClick={() => window.location.reload()}>
            重新加载
          </button>
        </section>
      </main>
    );
  }
}
