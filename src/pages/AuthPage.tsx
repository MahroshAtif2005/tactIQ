import React from 'react';
import { Shield } from 'lucide-react';
import './AuthPage.css';

interface AuthPageProps {
  isChecking?: boolean;
  onContinueWithMicrosoft: () => void;
  onTryDemo: () => void;
  showDemo?: boolean;
  isLocalDev?: boolean;
  localHint?: string | null;
  onCopySwaCommand?: () => void;
  copiedSwaCommand?: boolean;
}

export default function AuthPage({
  isChecking,
  onContinueWithMicrosoft,
  onTryDemo,
  showDemo = false,
  isLocalDev = false,
  localHint = null,
  onCopySwaCommand,
  copiedSwaCommand = false,
}: AuthPageProps) {
  return (
    <div className="auth-page-shell">
      <div className="auth-page-overlay" aria-hidden="true" />
      <div className="auth-page-card">
        <div className="auth-page-icon-wrap" aria-hidden="true">
          <div className="auth-page-icon-inner">
            <Shield className="auth-page-icon" />
          </div>
        </div>

        <div className="auth-page-title-row">
          <h1 className="auth-page-title">Sign in to tactIQ</h1>
          {isLocalDev && (
            <span className="auth-page-local-badge">Local dev: Demo mode recommended</span>
          )}
        </div>
        <p className="auth-page-subtitle">
          Continue with Microsoft to access your coaching workspace and private player baselines.
        </p>
        <button
          type="button"
          onClick={onContinueWithMicrosoft}
          disabled={Boolean(isChecking)}
          className="auth-page-button auth-page-button-primary"
        >
          {isChecking ? 'Checking session…' : 'Continue with Microsoft'}
        </button>

        {showDemo && (
          <button
            type="button"
            onClick={onTryDemo}
            className="auth-page-button auth-page-button-secondary"
          >
            Try Demo
          </button>
        )}

        {localHint && (
          <div className="auth-page-local-hint" role="status" aria-live="polite">
            <p className="auth-page-local-hint-text">{localHint}</p>
            <button
              type="button"
              className="auth-page-local-hint-copy"
              onClick={onCopySwaCommand}
            >
              {copiedSwaCommand ? 'Copied SWA CLI command' : 'Copy SWA CLI command'}
            </button>
          </div>
        )}

        <p className="auth-page-footer">
          Privacy: your roster and baselines stay in your own workspace.
        </p>
      </div>
    </div>
  );
}
