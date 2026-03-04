import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ApiClientError, postCopilotChat } from '../lib/apiClient';

type CopilotRole = 'user' | 'assistant';

interface CopilotTurn {
  id: string;
  role: CopilotRole;
  content: string;
}

interface CopilotChatPanelProps {
  analysisReady: boolean;
  analysisId?: string;
  resetKey?: string;
  suggestedQuestions?: string[];
  onAnalysisIdSync?: (analysisId: string) => void;
  fallbackContext?: {
    matchContextSnapshot?: Record<string, unknown>;
    telemetry?: Record<string, unknown>;
    matchContext?: Record<string, unknown>;
    players?: Record<string, unknown>;
    coachOutput?: Record<string, unknown>;
    matchId?: string;
    sessionId?: string;
  };
}

const DEFAULT_QUESTIONS = [
  'Rotate now or hold one over?',
  'Safest next over?',
  'Plan next 2 overs',
  'Risk drivers right now',
];

const nextTurnId = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
};

const summarizeError = (error: unknown): string => {
  if (error instanceof ApiClientError) {
    if (error.status === 404) return 'Copilot endpoint not reachable.';
    if (error.status === 409) return 'Run Coach Analysis first.';
    if (error.status === 400) return 'Invalid Copilot request.';
    if (error.status === 429) return 'Session limit reached.';
    if (error.status && error.status >= 500) return 'Server error. Please retry.';
    return error.message;
  }
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  return 'Copilot chat is temporarily unavailable.';
};

export default function CopilotChatPanel({
  analysisReady,
  analysisId,
  resetKey,
  suggestedQuestions,
  onAnalysisIdSync,
  fallbackContext,
}: CopilotChatPanelProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState<CopilotTurn[]>([]);
  const [input, setInput] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [messagesUsed, setMessagesUsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [lastPrompt, setLastPrompt] = useState<string>('');
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const railRef = useRef<HTMLDivElement | null>(null);

  const promptLimit = 10;
  const limitReached = messagesUsed >= promptLimit;
  const resolvedSuggestions = useMemo(
    () => (Array.isArray(suggestedQuestions) && suggestedQuestions.length > 0 ? suggestedQuestions.slice(0, 6) : DEFAULT_QUESTIONS),
    [suggestedQuestions]
  );

  useEffect(() => {
    setIsOpen(false);
    setMessages([]);
    setInput('');
    setMessagesUsed(0);
    setError(null);
    setLastPrompt('');
  }, [resetKey]);

  useEffect(() => {
    if (!isOpen) return;
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [isOpen, messages, isSending]);

  useEffect(() => {
    const el = railRef.current;
    if (!el) return;

    const onWheel = (event: WheelEvent) => {
      if (el.scrollWidth <= el.clientWidth) return;
      event.preventDefault();
      event.stopPropagation();
      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      el.scrollLeft += delta;
    };

    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const sendMessage = async (promptOverride?: string) => {
    const prompt = String(promptOverride ?? input).trim();
    if (!prompt || isSending || limitReached) return;
    if (!analysisReady || !analysisId || analysisId.trim().length === 0) {
      setError('Run Coach Analysis first to unlock Copilot Chat.');
      return;
    }

    const userTurn: CopilotTurn = {
      id: nextTurnId(),
      role: 'user',
      content: prompt,
    };

    setError(null);
    setLastPrompt(prompt);
    setInput('');
    setMessages((prev) => [...prev, userTurn]);
    setIsSending(true);

    try {
      const history = [...messages.slice(-7), userTurn].map((turn) => ({
        role: turn.role,
        content: turn.content,
      }));
      const basePayload = {
        analysisId: String(analysisId).trim(),
        message: prompt,
        history,
        ...(fallbackContext?.matchContextSnapshot ? { matchContextSnapshot: fallbackContext.matchContextSnapshot } : {}),
        ...(fallbackContext?.telemetry ? { telemetry: fallbackContext.telemetry } : {}),
        ...(fallbackContext?.matchContext ? { matchContext: fallbackContext.matchContext } : {}),
        ...(fallbackContext?.players ? { players: fallbackContext.players } : {}),
        ...(fallbackContext?.coachOutput ? { coachOutput: fallbackContext.coachOutput } : {}),
        ...(fallbackContext?.matchId ? { matchId: fallbackContext.matchId } : {}),
        ...(fallbackContext?.sessionId ? { sessionId: fallbackContext.sessionId } : {}),
      };
      const response = await postCopilotChat(basePayload);
      const reply = String(response?.reply || '').trim() || 'No reply returned from Copilot.';
      const assistantTurn: CopilotTurn = {
        id: nextTurnId(),
        role: 'assistant',
        content: reply,
      };
      setMessages((prev) => [...prev, assistantTurn]);
      const analysisIdUsed = String(response?.analysisIdUsed || '').trim();
      if (analysisIdUsed.length > 0) {
        onAnalysisIdSync?.(analysisIdUsed);
      }
      if (typeof response?.messagesUsed === 'number' && Number.isFinite(response.messagesUsed)) {
        setMessagesUsed(Math.max(0, Math.min(promptLimit, Math.floor(response.messagesUsed))));
      } else {
        setMessagesUsed((prev) => Math.min(promptLimit, prev + 1));
      }
    } catch (sendError) {
      if (import.meta.env.DEV) {
        console.error('[copilot] send failed', sendError);
      }
      setError(summarizeError(sendError));
    } finally {
      setIsSending(false);
    }
  };

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.04] backdrop-blur-xl shadow-[inset_0_1px_0_rgba(255,255,255,0.08)] p-4 mt-3 overflow-hidden">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-bold text-white">Copilot Chat</h3>
          <p className="text-[11px] text-slate-400">Discuss this match state</p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] px-2 py-0.5 rounded border border-slate-600 text-slate-300 bg-slate-800/70">
            {messagesUsed}/{promptLimit}
          </span>
          <button
            type="button"
            onClick={() => setIsOpen((prev) => !prev)}
            disabled={!analysisReady}
            className="text-[10px] px-2 py-0.5 rounded border border-cyan-400/35 text-cyan-200 bg-cyan-500/10 hover:bg-cyan-500/20 transition-colors"
          >
            {isOpen ? 'Close' : 'Open'}
          </button>
        </div>
      </div>

      <div
        ref={railRef}
        style={{
          display: 'flex',
          flexWrap: 'nowrap',
          gap: '8px',
          overflowX: 'auto',
          overflowY: 'hidden',
          maxWidth: '100%',
          padding: '8px 2px 8px 2px',
          WebkitOverflowScrolling: 'touch',
          scrollbarWidth: 'none',
          msOverflowStyle: 'none',
        }}
      >
        {resolvedSuggestions.map((question, index) => (
          <button
            type="button"
            key={`copilot-question-${index}`}
            onClick={() => {
              if (!analysisReady || !analysisId || analysisId.trim().length === 0) return;
              if (!isOpen) setIsOpen(true);
              void sendMessage(question);
            }}
            disabled={!analysisReady || isSending || limitReached}
            style={{
              flex: '0 0 auto',
              whiteSpace: 'nowrap',
              borderRadius: '999px',
              border: '1px solid rgba(255,255,255,0.14)',
              background: 'rgba(255,255,255,0.06)',
              color: 'rgba(255,255,255,0.92)',
              padding: '7px 12px',
              fontSize: '12px',
              cursor: isSending || limitReached ? 'not-allowed' : 'pointer',
              opacity: !analysisReady || isSending || limitReached ? 0.55 : 1,
            }}
          >
            {question}
          </button>
        ))}
      </div>

      {!analysisReady && (
        <div className="rounded-md border border-amber-400/35 bg-amber-500/10 px-3 py-2 mt-1">
          <p className="text-[11px] text-amber-100">Run Coach Analysis first to unlock Copilot Chat.</p>
        </div>
      )}

      {isOpen && (
        <div className="mt-2 rounded-xl border border-white/10 bg-slate-900/40 p-3">
          <div ref={scrollRef} className="max-h-56 overflow-y-auto space-y-2 pr-1">
            {messages.length === 0 ? (
              <p className="text-[11px] text-slate-400">Ask about this match plan, workload, and next-over tactics.</p>
            ) : (
              messages.map((turn) => (
                <div
                  key={turn.id}
                  className={`rounded-lg px-3 py-2 text-[12px] leading-relaxed ${
                    turn.role === 'user'
                      ? 'bg-cyan-500/15 border border-cyan-400/30 text-cyan-50 ml-8'
                      : 'bg-slate-800/80 border border-slate-700 text-slate-100 mr-8'
                  }`}
                >
                  {turn.content}
                </div>
              ))
            )}
            {isSending && (
              <div className="rounded-lg px-3 py-2 text-[12px] bg-slate-800/80 border border-slate-700 text-slate-300 mr-8">
                Thinking…
              </div>
            )}
          </div>

          <div className="mt-3 flex items-center gap-2">
            <input
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  void sendMessage();
                }
              }}
              placeholder={limitReached ? 'Session limit reached' : 'Ask about this match state...'}
              disabled={!analysisReady || isSending || limitReached}
              className="flex-1 rounded-lg border border-slate-700 bg-slate-900/70 px-3 py-2 text-[12px] text-slate-100 placeholder:text-slate-500 focus:outline-none focus:ring-1 focus:ring-cyan-400/60"
            />
            <button
              type="button"
              onClick={() => void sendMessage()}
              disabled={!analysisReady || isSending || limitReached || input.trim().length === 0}
              className="rounded-lg border border-cyan-400/35 bg-cyan-500/15 px-3 py-2 text-[12px] font-semibold text-cyan-100 hover:bg-cyan-500/25 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Send
            </button>
          </div>

          <p className="mt-2 text-[10px] text-slate-500">Limit: 10 messages per session</p>

          {error && (
            <div className="mt-2 flex items-center justify-between gap-2 rounded-md border border-rose-500/35 bg-rose-500/10 px-2 py-1">
              <p className="text-[11px] text-rose-100">{error}</p>
              {lastPrompt && !isSending && !limitReached && (
                <button
                  type="button"
                  onClick={() => void sendMessage(lastPrompt)}
                  className="text-[10px] px-2 py-0.5 rounded border border-rose-300/45 text-rose-100 hover:bg-rose-500/20 transition-colors"
                >
                  Retry
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
