import React from 'react';

// A render error in one page used to blank the whole app (header included).
// This keeps the shell up and says what broke; App keys it by route, so
// navigating elsewhere clears the error.
export default class ErrorBoundary extends React.Component {
  state = { error: null };

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error(error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div role="alert" className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-md p-4 space-y-1">
        <div className="font-medium">This page hit an error and couldn’t be shown.</div>
        <div className="font-mono text-xs break-words">{String(this.state.error.message || this.state.error)}</div>
        <div>Reload the page to try again, or pick another page above.</div>
      </div>
    );
  }
}
