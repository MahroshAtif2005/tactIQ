import React, { useEffect, useMemo, useRef, useState } from 'react';
import { copilotChatUrl, postCopilotChat } from '../lib/apiClient';

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
  forceFallbackMode?: boolean;
  analysisExecuted?: boolean;
  analysisStale?: boolean;
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

const readNumber = (value: unknown, fallback = 0): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const readText = (value: unknown, fallback = ''): string => {
  const text = String(value ?? '').trim();
  return text || fallback;
};

const normalizeRisk = (value: unknown): 'LOW' | 'MED' | 'HIGH' => {
  const token = String(value || '').trim().toUpperCase();
  if (token === 'HIGH' || token === 'CRITICAL') return 'HIGH';
  if (token === 'MED' || token === 'MEDIUM') return 'MED';
  return 'LOW';
};

const buildDemoCopilotReply = (
  prompt: string,
  context?: CopilotChatPanelProps['fallbackContext']
): string => {
  const snapshot = (context?.matchContextSnapshot || {}) as Record<string, unknown>;
  const telemetry = ((context?.telemetry || snapshot.telemetry || {}) as Record<string, unknown>);
  const match = ((context?.matchContext || snapshot.matchContext || {}) as Record<string, unknown>);
  const players = ((context?.players || snapshot.players || {}) as Record<string, unknown>);
  const coachOutput = (context?.coachOutput || {}) as Record<string, unknown>;
  const tacticalRecommendation = (coachOutput.tacticalRecommendation || {}) as Record<string, unknown>;

  const playerName =
    readText(telemetry.playerName)
    || readText(players.bowler)
    || 'the current bowler';
  const fatigueIndex = readNumber(telemetry.fatigueIndex, 0);
  const strainIndex = readNumber(telemetry.strainIndex, 0);
  const oversBowled = readNumber(telemetry.oversBowled, 0);
  const injuryRisk = normalizeRisk(telemetry.injuryRisk);
  const noBallRisk = normalizeRisk(telemetry.noBallRisk);
  const phase = readText(match.phase, 'middle overs');
  const recovery = readText((telemetry.heartRateRecovery || telemetry.recovery), 'Moderate');
  const tacticalNextAction = readText(tacticalRecommendation.nextAction || tacticalRecommendation.primary);
  const benchList = Array.isArray(players.bench)
    ? players.bench.map((entry) => String(entry || '').trim()).filter(Boolean).slice(0, 3)
    : [];
  const benchHint = benchList.length > 0 ? ` Keep ${benchList.join(', ')} ready as rotation options.` : '';

  const promptLower = prompt.toLowerCase();
  const safeToContinue = oversBowled === 0 || (fatigueIndex <= 4 && injuryRisk === 'LOW');
  const elevatedRisk = injuryRisk !== 'LOW' || noBallRisk === 'HIGH' || fatigueIndex >= 6 || strainIndex >= 4;

  let action = safeToContinue
    ? `Continue with ${playerName} for the next over and focus on repeatable release points.`
    : elevatedRisk
      ? `Rotate ${playerName} after this over and shift to a control-first option.`
      : `Use ${playerName} for one controlled over, then reassess before committing to another spell.`;

  if (promptLower.includes('no-ball')) {
    action = safeToContinue
      ? `Keep ${playerName} on, slow the run-up slightly, and commit to a shorter, repeatable run-up marker this over.`
      : `Take one over off ${playerName}, then bring him back with a simplified run-up and yorker target plan.`;
  } else if (promptLower.includes('next 2 overs') || promptLower.includes('two overs') || promptLower.includes('2 overs')) {
    action = elevatedRisk
      ? `Split the next two overs between a control bowler now and ${playerName} only if rhythm is stable after the break.`
      : `Keep ${playerName} for one over, then use a change-up bowler for the following over to protect late-phase flexibility.`;
  } else if (promptLower.includes('safest plan')) {
    action = elevatedRisk
      ? `Safest plan is to rotate now, protect execution quality, and avoid back-to-back high-intensity overs.`
      : `Safest plan is one more controlled over from ${playerName}, with a pre-committed rotation trigger on any control drop.`;
  }

  const whyLine = elevatedRisk
    ? `${phase} pressure plus current workload signals can compound quickly if you extend the spell unchanged.`
    : `${phase} context is manageable, and current workload signals still support controlled execution.`;
  const watchLine = elevatedRisk
    ? `Watch for line-length drift or rushed run-up rhythm; rotate immediately if either appears.`
    : `Watch recovery and front-foot discipline; rotate if rhythm drops or no-ball pressure rises.`;
  const recoveryLine = `Recovery trend is ${recovery}, so keep the reassessment window short.${benchHint}`;
  const tacticalLine = tacticalNextAction
    ? `This stays aligned with the latest tactical guidance while keeping options open.`
    : `This keeps tactical flexibility for the next decision point.`;

  return `${action}\n\n${whyLine} ${recoveryLine} ${watchLine} ${tacticalLine}`;
};

export default function CopilotChatPanel({
  analysisReady,
  analysisId,
  resetKey,
  suggestedQuestions,
  onAnalysisIdSync,
  forceFallbackMode = false,
  analysisExecuted = false,
  analysisStale = false,
  fallbackContext,
}: CopilotChatPanelProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState<CopilotTurn[]>([]);
  const [input, setInput] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [messagesUsed, setMessagesUsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [lastPrompt, setLastPrompt] = useState<string>('');
  const [runtimeSource, setRuntimeSource] = useState<'ai' | 'fallback'>(forceFallbackMode ? 'fallback' : 'ai');
  const [runtimeNote, setRuntimeNote] = useState<string | null>(
    forceFallbackMode ? 'Copilot is running in fallback/local mode because Azure OpenAI is unavailable.' : null
  );
  const [hoveredSuggestionIndex, setHoveredSuggestionIndex] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const railRef = useRef<HTMLDivElement | null>(null);

  const promptLimit = 10;
  const limitReached = messagesUsed >= promptLimit;
  const localRulesMode = forceFallbackMode;
  const hasFallbackContext = Boolean(
    fallbackContext?.coachOutput ||
    fallbackContext?.matchContextSnapshot ||
    fallbackContext?.telemetry ||
    fallbackContext?.matchContext
  );
  const canSend = analysisReady || String(analysisId || '').trim().length > 0 || (localRulesMode && hasFallbackContext);
  const resolvedSuggestions = useMemo(
    () => (Array.isArray(suggestedQuestions) && suggestedQuestions.length > 0 ? suggestedQuestions.slice(0, 6) : DEFAULT_QUESTIONS),
    [suggestedQuestions]
  );
  const copilotStyle: React.CSSProperties = {
    background: 'linear-gradient(135deg, rgba(16,185,129,0.18) 0%, rgba(34,211,238,0.14) 55%, rgba(99,102,241,0.10) 100%)',
    border: '1px solid rgba(16,185,129,0.22)',
    boxShadow: '0 0 0 1px rgba(16,185,129,0.10), 0 10px 30px rgba(16,185,129,0.10)',
    borderRadius: '16px',
  };
  const userStyle: React.CSSProperties = {
    background: 'rgba(255,255,255,0.05)',
    border: '1px solid rgba(255,255,255,0.10)',
    borderRadius: '16px',
  };

  useEffect(() => {
    setIsOpen(false);
    setMessages([]);
    setInput('');
    setMessagesUsed(0);
    setError(null);
    setLastPrompt('');
    setRuntimeSource(localRulesMode ? 'fallback' : 'ai');
    setRuntimeNote(localRulesMode ? 'Copilot is running in fallback/local mode because Azure OpenAI is unavailable.' : null);
  }, [resetKey]);

  useEffect(() => {
    if (localRulesMode) {
      setRuntimeSource('fallback');
      setRuntimeNote('Copilot is running in fallback/local mode because Azure OpenAI is unavailable.');
      return;
    }
    setRuntimeSource('ai');
    setRuntimeNote((prev) => {
      if (!prev) return null;
      if (/Azure OpenAI is unavailable/i.test(prev)) return null;
      return prev;
    });
  }, [localRulesMode]);

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
    if (!canSend) {
      setError('Run Coach Analysis first to unlock Copilot Chat.');
      return;
    }
    const resolvedAnalysisId = String(analysisId || '').trim() || `local-copilot-${Date.now()}`;

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
      if (import.meta.env.DEV) {
        console.log('[copilot] submit', {
          prompt,
          analysisId: resolvedAnalysisId,
          routeCalled: localRulesMode ? 'local-fallback(no request)' : copilotChatUrl,
          localRulesMode,
          historyTurns: history.length,
        });
      }
      const basePayload = {
        analysisId: resolvedAnalysisId,
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
      if (localRulesMode) {
        if (import.meta.env.DEV) {
          console.warn('[copilot] fallback_local', {
            prompt,
            analysisId: resolvedAnalysisId,
            routeCalled: 'local-fallback(no request)',
            reason: 'forceFallbackMode',
          });
        }
        const assistantTurn: CopilotTurn = {
          id: nextTurnId(),
          role: 'assistant',
          content: buildDemoCopilotReply(prompt, fallbackContext),
        };
        setMessages((prev) => [...prev, assistantTurn]);
        setMessagesUsed((prev) => Math.min(promptLimit, prev + 1));
        setRuntimeSource('fallback');
        setRuntimeNote('Copilot is running in fallback/local mode because Azure OpenAI is unavailable.');
        onAnalysisIdSync?.(resolvedAnalysisId);
        return;
      }
      const response = await postCopilotChat(basePayload);
      const reply = String(response?.reply || '').trim() || 'No reply returned from Copilot.';
      const responseSource = String(response?.source || '').trim().toLowerCase() === 'ai' ? 'ai' : 'fallback';
      const assistantTurn: CopilotTurn = {
        id: nextTurnId(),
        role: 'assistant',
        content: reply,
      };
      setMessages((prev) => [...prev, assistantTurn]);
      setRuntimeSource(responseSource);
      setRuntimeNote(
        responseSource === 'fallback'
          ? 'Copilot response came from fallback/local mode.'
          : null
      );
      if (import.meta.env.DEV) {
        console.log('[copilot] response', {
          routeCalled: String(response?.routeCalled || copilotChatUrl || '').trim() || '/api/copilot-chat',
          source: responseSource,
          mode: response?.mode || null,
          fallbackReason: response?.fallbackReason || null,
        });
      }
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
        console.error('[copilot] send failed', {
          routeCalled: copilotChatUrl,
          error: sendError instanceof Error ? sendError.message : String(sendError),
        });
      }
      const fallbackReply = buildDemoCopilotReply(prompt, fallbackContext);
      const assistantTurn: CopilotTurn = {
        id: nextTurnId(),
        role: 'assistant',
        content: fallbackReply,
      };
      setMessages((prev) => [...prev, assistantTurn]);
      setMessagesUsed((prev) => Math.min(promptLimit, prev + 1));
      setRuntimeSource('fallback');
      setRuntimeNote('Copilot API request failed; showing local fallback response.');
      setError('Live Copilot unavailable right now; showing local fallback response.');
    } finally {
      setIsSending(false);
    }
  };

  if (!analysisReady) return null;

  return (
    <div className="w-full">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-bold text-white">Copilot Chat</h3>
          <p className="text-[11px] text-slate-400">Discuss this match state</p>
        </div>
        <div className="flex items-center gap-2">
          <span
            className={`text-[10px] px-2 py-0.5 rounded border ${
              runtimeSource === 'ai'
                ? 'border-emerald-400/40 text-emerald-100 bg-emerald-500/10'
                : 'border-amber-400/40 text-amber-100 bg-amber-500/10'
            }`}
          >
            {runtimeSource === 'ai' ? 'Live AI' : 'Fallback/local'}
          </span>
          <span className="text-[10px] px-2 py-0.5 rounded border border-slate-600 text-slate-300 bg-slate-800/70">
            {messagesUsed}/{promptLimit}
          </span>
          <button
            type="button"
            onClick={() => setIsOpen((prev) => !prev)}
            disabled={!canSend}
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
            onMouseEnter={() => setHoveredSuggestionIndex(index)}
            onMouseLeave={() => setHoveredSuggestionIndex((prev) => (prev === index ? null : prev))}
            onClick={() => {
              if (!canSend) return;
              if (!isOpen) setIsOpen(true);
              void sendMessage(question);
            }}
            disabled={!canSend || isSending || limitReached}
            className={`flex-[0_0_auto] whitespace-nowrap rounded-full px-4 py-2 text-sm font-medium transition ${
              !canSend || isSending || limitReached
                ? 'bg-white/5 border border-white/10 text-slate-400 cursor-not-allowed opacity-55'
                : 'bg-white/5 border border-white/10 text-slate-200 hover:text-white hover:bg-white/[0.08] hover:border-white/15 hover:shadow-[0_0_0_1px_rgba(99,102,241,0.25),0_0_18px_rgba(99,102,241,0.12)]'
            }`}
            style={
              !canSend || isSending || limitReached
                ? undefined
                : {
                    background:
                      hoveredSuggestionIndex === index
                        ? 'linear-gradient(180deg, rgba(34,54,102,0.44) 0%, rgba(20,35,72,0.30) 100%)'
                        : 'linear-gradient(180deg, rgba(24,40,78,0.32) 0%, rgba(16,28,58,0.22) 100%)',
                    boxShadow:
                      hoveredSuggestionIndex === index
                        ? '0 0 0 1px rgba(110,150,255,0.08), inset 0 1px 0 rgba(255,255,255,0.03), 0 8px 22px rgba(0,0,0,0.16)'
                        : '0 0 0 1px rgba(110,150,255,0.05), inset 0 1px 0 rgba(255,255,255,0.02), 0 6px 18px rgba(0,0,0,0.14)',
                    color: '#f2f6ff',
                    borderColor: 'rgba(120,150,210,0.22)',
                  }
            }
          >
            {question}
          </button>
        ))}
      </div>

      {!canSend && (
        <div className="rounded-md border border-amber-400/35 bg-amber-500/10 px-3 py-2 mt-1">
          <p className="text-[11px] text-amber-100">Run Coach Analysis first to unlock Copilot Chat.</p>
        </div>
      )}
      {runtimeSource === 'fallback' && runtimeNote && (
        <div className="rounded-md border border-amber-400/35 bg-amber-500/10 px-3 py-2 mt-1">
          <p className="text-[11px] text-amber-100">{runtimeNote}</p>
        </div>
      )}

      {isOpen && (
        <div className="mt-2 rounded-xl border border-white/10 bg-slate-900/40 p-3">
          {analysisExecuted && analysisStale && (
            <div
              style={{
                marginBottom: '10px',
                padding: '8px 10px',
                borderRadius: '10px',
                background: 'rgba(255,184,77,0.08)',
                border: '1px solid rgba(255,184,77,0.25)',
                color: '#ffd38a',
                fontSize: '12.5px',
                lineHeight: '1.4',
              }}
            >
              ⚠️ Inputs changed since the last AI analysis. Rerun or dismiss analysis for updated guidance.
            </div>
          )}
          <div ref={scrollRef} className="max-h-56 overflow-y-auto space-y-3 pr-1 pb-6">
            {messages.map((turn) => (
              <div
                key={turn.id}
                className={`text-[12px] p-4 ${turn.role === 'user' ? 'ml-8' : 'mr-8'}`}
                style={turn.role === 'assistant' ? copilotStyle : userStyle}
              >
                {turn.role === 'assistant' && (
                  <div style={{ fontSize: 11, letterSpacing: 2, fontWeight: 700, color: 'rgba(167,243,208,0.95)', marginBottom: 4 }}>COPILOT</div>
                )}
                <div style={{ color: 'rgba(255,255,255,0.92)', lineHeight: 1.65, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                  {turn.content}
                </div>
              </div>
            ))}
            {isSending && (
              <div className="text-[12px] mr-8" style={copilotStyle}>
                <div className="p-4">
                  <div style={{ fontSize: 11, letterSpacing: 2, fontWeight: 700, color: 'rgba(167,243,208,0.95)', marginBottom: 4 }}>COPILOT</div>
                  <div style={{ color: 'rgba(255,255,255,0.92)', lineHeight: 1.65 }}>Thinking…</div>
                </div>
              </div>
            )}
          </div>

          <div className="flex items-center gap-2" style={{ marginTop: 18 }}>
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
              disabled={!canSend || isSending || limitReached}
              className="flex-1 rounded-lg border border-slate-700 bg-slate-900/70 px-3 py-2 text-[12px] text-slate-100 placeholder:text-slate-500 focus:outline-none focus:ring-1 focus:ring-cyan-400/60"
            />
            <button
              type="button"
              onClick={() => void sendMessage()}
              disabled={!canSend || isSending || limitReached || input.trim().length === 0}
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
