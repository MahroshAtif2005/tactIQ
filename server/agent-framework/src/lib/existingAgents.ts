import { randomUUID } from 'node:crypto';
import { fetch } from 'undici';

type AgentType = 'fatigue' | 'risk' | 'tactical';
type RouterIntent = 'fatigue_check' | 'risk_check' | 'substitution' | 'full';
export type AgentFrameworkMode = 'route' | 'all';

type LooseRecord = Record<string, unknown>;

interface NormalizedTelemetry {
  playerId: string;
  playerName: string;
  role: string;
  fatigueIndex: number;
  heartRateRecovery: string;
  oversBowled: number;
  consecutiveOvers: number;
  injuryRisk: string;
  noBallRisk: string;
  fatigueLimit?: number;
  sleepHours?: number;
  recoveryMinutes?: number;
  isUnfit?: boolean;
}

interface NormalizedMatchContext {
  phase: string;
  requiredRunRate: number;
  currentRunRate: number;
  wicketsInHand: number;
  oversRemaining: number;
  format?: string;
  over?: number;
  intensity?: string;
  conditions?: string;
  target?: number;
  score?: number;
  balls?: number;
}

interface NormalizedPlayers {
  striker: string;
  nonStriker: string;
  bowler: string;
  bench?: string[];
}

interface NormalizedRequest {
  mode: 'auto' | 'full';
  intent: 'monitor' | 'substitution' | 'strategy' | 'full';
  telemetry: NormalizedTelemetry;
  matchContext: NormalizedMatchContext;
  players: NormalizedPlayers;
  rawPayload: LooseRecord;
}

interface RouterDecision {
  intent: RouterIntent;
  selectedAgents: AgentType[];
  reason: string;
  signals: Record<string, unknown>;
}

interface OrchestrateLikeResponse {
  fatigue?: Record<string, unknown>;
  risk?: Record<string, unknown>;
  tactical?: Record<string, unknown>;
  agentOutputs?: Record<string, unknown>;
  finalDecision?: Record<string, unknown>;
  combinedDecision: Record<string, unknown>;
  routerDecision?: RouterDecision;
  errors: Array<{ agent: AgentType; message: string }>;
  meta: {
    requestId: string;
    mode: 'auto' | 'full';
    executedAgents: AgentType[];
    modelRouting: {
      fatigueModel: string;
      riskModel: string;
      tacticalModel: string;
      fallbacksUsed: string[];
    };
    usedFallbackAgents?: AgentType[];
    timingsMs: {
      fatigue?: number;
      risk?: number;
      tactical?: number;
      total: number;
    };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

const asRecord = (value: unknown): LooseRecord => (value && typeof value === 'object' ? (value as LooseRecord) : {});
const toNumber = (value: unknown, fallback = 0): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};
const toOptionalNumber = (value: unknown): number | undefined => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};
const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));
const trimTrailingSlash = (value: string): string => value.replace(/\/+$/, '');

function normalizeIntent(value: unknown): 'monitor' | 'substitution' | 'strategy' | 'full' {
  const parsed = String(value || 'monitor').toLowerCase();
  if (parsed === 'substitution' || parsed === 'strategy' || parsed === 'full') return parsed;
  return 'monitor';
}

function normalizeRequest(payloadInput: unknown): NormalizedRequest {
  const payload = asRecord(payloadInput);
  const telemetry = asRecord(payload.telemetry);
  const matchContext = asRecord(payload.matchContext);
  const players = asRecord(payload.players);

  const legacyPlayer = asRecord(payload.player);
  const legacyMatch = asRecord(payload.match);
  const legacyTactical = asRecord(legacyMatch.tactical);

  const hasNewSchema = Object.keys(telemetry).length > 0 && Object.keys(matchContext).length > 0;
  const sourceTelemetry = hasNewSchema ? telemetry : legacyPlayer;
  const sourceMatch = hasNewSchema
    ? matchContext
    : {
        phase: legacyTactical.phase ?? legacyMatch.phase,
        requiredRunRate: legacyTactical.requiredRunRate,
        currentRunRate: legacyTactical.currentRunRate,
        wicketsInHand: legacyTactical.wicketsInHand,
        oversRemaining: legacyTactical.oversRemaining,
        format: legacyMatch.format,
        over: legacyMatch.over,
        intensity: legacyMatch.intensity,
        conditions: legacyMatch.conditions,
        target: legacyMatch.target,
        score: legacyMatch.score,
        balls: legacyMatch.balls,
      };

  const normalized: NormalizedRequest = {
    mode: payload.mode === 'full' ? 'full' : 'auto',
    intent: normalizeIntent(payload.intent),
    telemetry: {
      playerId: String(sourceTelemetry.playerId || 'UNKNOWN'),
      playerName: String(sourceTelemetry.playerName || 'Unknown Player'),
      role: String(sourceTelemetry.role || 'Unknown Role'),
      fatigueIndex: clamp(toNumber(sourceTelemetry.fatigueIndex, 0), 0, 10),
      heartRateRecovery: String(sourceTelemetry.heartRateRecovery || 'Moderate'),
      oversBowled: Math.max(0, toNumber(sourceTelemetry.oversBowled, 0)),
      consecutiveOvers: Math.max(0, toNumber(sourceTelemetry.consecutiveOvers, 0)),
      injuryRisk: String(sourceTelemetry.injuryRisk || 'MEDIUM').toUpperCase(),
      noBallRisk: String(sourceTelemetry.noBallRisk || 'MEDIUM').toUpperCase(),
      fatigueLimit: toOptionalNumber(sourceTelemetry.fatigueLimit),
      sleepHours: toOptionalNumber(sourceTelemetry.sleepHours),
      recoveryMinutes: toOptionalNumber(sourceTelemetry.recoveryMinutes),
      isUnfit: sourceTelemetry.isUnfit === true,
    },
    matchContext: {
      phase: String(sourceMatch.phase || 'middle').toLowerCase(),
      requiredRunRate: Math.max(0, toNumber(sourceMatch.requiredRunRate, 0)),
      currentRunRate: Math.max(0, toNumber(sourceMatch.currentRunRate, 0)),
      wicketsInHand: Math.max(0, toNumber(sourceMatch.wicketsInHand, 0)),
      oversRemaining: Math.max(0, toNumber(sourceMatch.oversRemaining, 0)),
      format: sourceMatch.format ? String(sourceMatch.format) : undefined,
      over: toOptionalNumber(sourceMatch.over),
      intensity: sourceMatch.intensity ? String(sourceMatch.intensity) : undefined,
      conditions: sourceMatch.conditions ? String(sourceMatch.conditions) : undefined,
      target: toOptionalNumber(sourceMatch.target),
      score: toOptionalNumber(sourceMatch.score),
      balls: toOptionalNumber(sourceMatch.balls),
    },
    players: {
      striker: String(players.striker || 'Striker'),
      nonStriker: String(players.nonStriker || 'Non-striker'),
      bowler: String(players.bowler || sourceTelemetry.playerName || 'Bowler'),
      bench: Array.isArray(players.bench) ? players.bench.map((entry) => String(entry)) : undefined,
    },
    rawPayload: payload,
  };

  return normalized;
}

function buildRouterDecision(input: NormalizedRequest): RouterDecision {
  const injuryRisk = input.telemetry.injuryRisk.toUpperCase();
  const explicitSubstitution = input.intent === 'substitution';
  const explicitRiskScore = toNumber(asRecord(input.rawPayload).riskScore, NaN);
  const hasHighRiskScore = Number.isFinite(explicitRiskScore) && explicitRiskScore >= 70;
  const highRiskSignal =
    input.telemetry.isUnfit === true ||
    hasHighRiskScore ||
    injuryRisk === 'CRITICAL' ||
    injuryRisk === 'HIGH' ||
    input.telemetry.noBallRisk === 'HIGH' ||
    input.telemetry.fatigueIndex >= 7;

  if (explicitSubstitution) {
    return {
      intent: 'substitution',
      selectedAgents: ['tactical'],
      reason: 'Substitution intent requested; routing to tactical agent.',
      signals: {
        fatigueIndex: input.telemetry.fatigueIndex,
        injuryRisk: input.telemetry.injuryRisk,
        noBallRisk: input.telemetry.noBallRisk,
        heartRateRecovery: input.telemetry.heartRateRecovery,
        oversBowled: input.telemetry.oversBowled,
        consecutiveOvers: input.telemetry.consecutiveOvers,
        phase: input.matchContext.phase,
        wicketsInHand: input.matchContext.wicketsInHand,
        oversRemaining: input.matchContext.oversRemaining,
        riskScore: Number.isFinite(explicitRiskScore) ? explicitRiskScore : undefined,
        isUnfit: Boolean(input.telemetry.isUnfit),
      },
    };
  }

  if (highRiskSignal) {
    return {
      intent: 'risk_check',
      selectedAgents: ['risk'],
      reason: 'High-risk workload signal detected; routing to risk agent.',
      signals: {
        fatigueIndex: input.telemetry.fatigueIndex,
        injuryRisk: input.telemetry.injuryRisk,
        noBallRisk: input.telemetry.noBallRisk,
        heartRateRecovery: input.telemetry.heartRateRecovery,
        oversBowled: input.telemetry.oversBowled,
        consecutiveOvers: input.telemetry.consecutiveOvers,
        phase: input.matchContext.phase,
        wicketsInHand: input.matchContext.wicketsInHand,
        oversRemaining: input.matchContext.oversRemaining,
        riskScore: Number.isFinite(explicitRiskScore) ? explicitRiskScore : undefined,
        isUnfit: Boolean(input.telemetry.isUnfit),
      },
    };
  }

  return {
    intent: 'fatigue_check',
    selectedAgents: ['fatigue'],
    reason: 'No critical risk flags; routing to fatigue agent.',
    signals: {
      fatigueIndex: input.telemetry.fatigueIndex,
      injuryRisk: input.telemetry.injuryRisk,
      noBallRisk: input.telemetry.noBallRisk,
      heartRateRecovery: input.telemetry.heartRateRecovery,
      oversBowled: input.telemetry.oversBowled,
      consecutiveOvers: input.telemetry.consecutiveOvers,
      phase: input.matchContext.phase,
      wicketsInHand: input.matchContext.wicketsInHand,
      oversRemaining: input.matchContext.oversRemaining,
      riskScore: Number.isFinite(explicitRiskScore) ? explicitRiskScore : undefined,
      isUnfit: Boolean(input.telemetry.isUnfit),
    },
  };
}

function buildFatiguePayload(input: NormalizedRequest): Record<string, unknown> {
  return {
    playerId: input.telemetry.playerId,
    playerName: input.telemetry.playerName,
    role: input.telemetry.role,
    oversBowled: input.telemetry.oversBowled,
    consecutiveOvers: input.telemetry.consecutiveOvers,
    fatigueIndex: input.telemetry.fatigueIndex,
    injuryRisk: input.telemetry.injuryRisk,
    noBallRisk: input.telemetry.noBallRisk,
    heartRateRecovery: input.telemetry.heartRateRecovery,
    fatigueLimit: input.telemetry.fatigueLimit,
    sleepHours: input.telemetry.sleepHours,
    recoveryMinutes: input.telemetry.recoveryMinutes,
    snapshotId: `${input.telemetry.playerId}:${Date.now()}`,
    matchContext: {
      format: input.matchContext.format || 'T20',
      phase: input.matchContext.phase || 'middle',
      over: input.matchContext.over || 0,
      intensity: input.matchContext.intensity || 'Medium',
    },
  };
}

function buildRiskPayload(input: NormalizedRequest): Record<string, unknown> {
  return {
    playerId: input.telemetry.playerId,
    fatigueIndex: input.telemetry.fatigueIndex,
    injuryRisk: input.telemetry.injuryRisk,
    noBallRisk: input.telemetry.noBallRisk,
    oversBowled: input.telemetry.oversBowled,
    consecutiveOvers: input.telemetry.consecutiveOvers,
    heartRateRecovery: input.telemetry.heartRateRecovery,
    format: input.matchContext.format || 'T20',
    phase: input.matchContext.phase || 'middle',
    intensity: input.matchContext.intensity || 'Medium',
    conditions: input.matchContext.conditions,
    target: input.matchContext.target,
    score: input.matchContext.score,
    over: input.matchContext.over,
    balls: input.matchContext.balls,
  };
}

function buildTacticalPayload(input: NormalizedRequest): Record<string, unknown> {
  const phase = input.matchContext.phase === 'powerplay' || input.matchContext.phase === 'death' ? input.matchContext.phase : 'middle';
  return {
    requestId: randomUUID(),
    intent: input.intent,
    telemetry: {
      ...input.telemetry,
    },
    matchContext: {
      ...input.matchContext,
      phase,
    },
    players: input.players,
  };
}

function buildCombinedDecision(partial: {
  fatigue?: Record<string, unknown>;
  risk?: Record<string, unknown>;
  tactical?: Record<string, unknown>;
}): Record<string, unknown> {
  if (partial.tactical) {
    return {
      immediateAction: String(partial.tactical.immediateAction || 'Continue with monitored plan'),
      substitutionAdvice: partial.tactical.substitutionAdvice,
      suggestedAdjustments: Array.isArray(partial.tactical.suggestedAdjustments) ? partial.tactical.suggestedAdjustments : [],
      confidence: Number(partial.tactical.confidence || 0.6),
      rationale: String(partial.tactical.rationale || 'Tactical recommendation generated by Agent Framework route mode.'),
    };
  }

  if (partial.risk) {
    const severity = String(partial.risk.severity || '').toUpperCase();
    return {
      immediateAction:
        severity === 'CRITICAL' || severity === 'HIGH'
          ? 'Immediate substitution advised. Remove from active spell now.'
          : 'No immediate change; continue and monitor trend.',
      suggestedAdjustments: [String(partial.risk.recommendation || 'Monitor risk trajectory over the next over.')],
      confidence: severity === 'CRITICAL' ? 0.55 : severity === 'HIGH' ? 0.62 : 0.72,
      rationale: String(partial.risk.headline || 'Risk signal routed by Agent Framework.'),
    };
  }

  return {
    immediateAction: 'No immediate change; continue and monitor trend.',
    suggestedAdjustments: [String(partial.fatigue?.recommendation || 'Monitor workload trend over next over.')],
    confidence: String(partial.fatigue?.severity || '').toUpperCase() === 'HIGH' ? 0.62 : 0.72,
    rationale: String(partial.fatigue?.headline || 'Fatigue signal routed by Agent Framework.'),
  };
}

export class ExistingAgentsClient {
  private readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = trimTrailingSlash(baseUrl || 'http://localhost:7071');
  }

  private async postJson<T>(path: string, payload: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} at ${url}: ${text.slice(0, 240)}`);
    }
    return JSON.parse(text) as T;
  }

  async callRisk(payload: unknown): Promise<Record<string, unknown>> {
    return this.postJson<Record<string, unknown>>('/api/agents/risk', payload);
  }

  async callFatigue(payload: unknown): Promise<Record<string, unknown>> {
    return this.postJson<Record<string, unknown>>('/api/agents/fatigue', payload);
  }

  async callTactical(payload: unknown): Promise<Record<string, unknown>> {
    return this.postJson<Record<string, unknown>>('/api/agents/tactical', payload);
  }

  async callOrchestrator(payload: unknown): Promise<OrchestrateLikeResponse> {
    return this.postJson<OrchestrateLikeResponse>('/api/orchestrate', payload);
  }

  async run(mode: AgentFrameworkMode, payloadInput: unknown): Promise<OrchestrateLikeResponse> {
    if (mode === 'all') {
      const payload = asRecord(payloadInput);
      return this.callOrchestrator({
        ...payload,
        mode: 'full',
      });
    }

    const normalized = normalizeRequest(payloadInput);
    const routerDecision = buildRouterDecision(normalized);
    const selected = routerDecision.selectedAgents[0];
    const startedAt = Date.now();
    const requestId = randomUUID();
    const errors: Array<{ agent: AgentType; message: string }> = [];
    const timingsMs: OrchestrateLikeResponse['meta']['timingsMs'] = { total: 0 };
    const executedAgents: AgentType[] = [selected];

    let fatigue: Record<string, unknown> | undefined;
    let risk: Record<string, unknown> | undefined;
    let tactical: Record<string, unknown> | undefined;

    try {
      if (selected === 'risk') {
        const riskStart = Date.now();
        risk = await this.callRisk(buildRiskPayload(normalized));
        timingsMs.risk = Date.now() - riskStart;
      } else if (selected === 'tactical') {
        const tacticalStart = Date.now();
        tactical = await this.callTactical(buildTacticalPayload(normalized));
        timingsMs.tactical = Date.now() - tacticalStart;
      } else {
        const fatigueStart = Date.now();
        fatigue = await this.callFatigue(buildFatiguePayload(normalized));
        timingsMs.fatigue = Date.now() - fatigueStart;
      }
    } catch (error) {
      errors.push({
        agent: selected,
        message: error instanceof Error ? error.message : 'Agent call failed',
      });
    }

    timingsMs.total = Date.now() - startedAt;
    const combinedDecision = buildCombinedDecision({ fatigue, risk, tactical });

    return {
      ...(fatigue ? { fatigue } : {}),
      ...(risk ? { risk } : {}),
      ...(tactical ? { tactical } : {}),
      agentOutputs: {
        ...(fatigue ? { fatigue: { ...fatigue, status: fatigue.status || 'ok' } } : {}),
        ...(risk ? { risk: { ...risk, status: risk.status || 'ok' } } : {}),
        ...(tactical ? { tactical } : {}),
      },
      finalDecision: combinedDecision,
      combinedDecision,
      errors,
      routerDecision,
      meta: {
        requestId,
        mode: 'auto',
        executedAgents,
        modelRouting: {
          fatigueModel: selected === 'fatigue' ? 'agent-framework-http' : 'skipped',
          riskModel: selected === 'risk' ? 'agent-framework-http' : 'skipped',
          tacticalModel: selected === 'tactical' ? 'agent-framework-http' : 'skipped',
          fallbacksUsed: [],
        },
        usedFallbackAgents: [],
        timingsMs,
      },
    };
  }
}
