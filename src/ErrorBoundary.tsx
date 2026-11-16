import React from "react";

type Props = { children: React.ReactNode };
type State = { error: Error | null };

/** Catches render-time crashes so the voice HUD shows a recoverable screen. */
export class ErrorBoundary extends React.Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("Voice HUD crashed", error, info);
  }

  override render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <main className="errorScreen">
        <section className="errorCard" role="alert">
          <h1>页面遇到错误 · Something went wrong</h1>
          <p className="errorMessage">{error.message || "未知错误 · Unknown error"}</p>
          <button className="errorReload" type="button" onClick={() => window.location.reload()}>
            重新加载 · Reload
          </button>
        </section>
      </main>
    );
  }
}
