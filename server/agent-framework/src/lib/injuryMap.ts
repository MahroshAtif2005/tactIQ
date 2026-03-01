import { MatchSetupContext, RosterPlayerContext } from "../types/matchContext";

export interface LikelyInjury {
  type: string;
  reason: string;
  severity: "LOW" | "MEDIUM" | "HIGH";
}

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));
const toNumber = (value: unknown, fallback = 0): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};
const normalizeRisk = (value: unknown): "LOW" | "MEDIUM" | "HIGH" | "UNKNOWN" => {
  const token = String(value || "").trim().toUpperCase();
  if (token === "LOW") return "LOW";
  if (token === "HIGH" || token === "CRITICAL") return "HIGH";
  if (token === "MED" || token === "MEDIUM") return "MEDIUM";
  return "UNKNOWN";
};
const normalizeRole = (value: unknown): string => String(value || "").trim().toUpperCase();
const isPaceRole = (role: string): boolean => ["PACER", "PACE", "FAST", "SEAM"].some((token) => role.includes(token));
const isSpinRole = (role: string): boolean => ["SPIN", "SPINNER"].some((token) => role.includes(token));

const pushUnique = (injuries: LikelyInjury[], entry: LikelyInjury): void => {
  if (!injuries.some((item) => item.type.toLowerCase() === entry.type.toLowerCase())) injuries.push(entry);
};

const highStrainFlag = (value: number): boolean => value >= 3 || value >= 6;

const highOversThreshold = (match?: MatchSetupContext): number => {
  const format = String(match?.format || "").trim().toUpperCase();
  if (format === "ODI") return 7;
  return 4;
};

export const mapLikelyInjuries = (activePlayer?: RosterPlayerContext, match?: MatchSetupContext): LikelyInjury[] => {
  if (!activePlayer) return [];
  const role = normalizeRole(activePlayer.role);
  const fatigue = clamp(toNumber(activePlayer.live?.fatigueIndex, 0), 0, 10);
  const strain = Math.max(0, toNumber(activePlayer.live?.strainIndex, 0));
  const sleep = Math.max(0, toNumber(activePlayer.baseline?.sleepHours, 0));
  const recovery = Math.max(0, toNumber(activePlayer.baseline?.recoveryScore, 0));
  const workload7d = Math.max(0, toNumber(activePlayer.baseline?.workload7d, 0));
  const workload28d = Math.max(0, toNumber(activePlayer.baseline?.workload28d, 0));
  const oversBowled = Math.max(0, toNumber(activePlayer.live?.oversBowled, 0));
  const noBallRisk = normalizeRisk(activePlayer.live?.noBallRisk);
  const injuryRisk = normalizeRisk(activePlayer.live?.injuryRisk);
  const injuries: LikelyInjury[] = [];
  const highStrain = highStrainFlag(strain);
  const highFatigue = fatigue >= 7;
  const highWorkload = workload28d >= 70 || workload7d >= 25;
  const lowRecoveryBase = sleep < 6 || recovery < 35;
  const highOvers = oversBowled >= highOversThreshold(match);

  if (highFatigue && highStrain) {
    pushUnique(injuries, {
      type: "hamstring strain",
      reason: "High fatigue with elevated strain index indicates increased posterior-chain load.",
      severity: "HIGH",
    });
    pushUnique(injuries, {
      type: "calf strain",
      reason: "Repeated high-effort spells under strain can overload lower-leg tissue.",
      severity: "HIGH",
    });
    pushUnique(injuries, {
      type: "general soft-tissue injury",
      reason: "Combined fatigue and strain raise broad soft-tissue injury exposure.",
      severity: "MEDIUM",
    });
  }

  if (highWorkload && lowRecoveryBase) {
    pushUnique(injuries, {
      type: "overuse injury",
      reason: "High rolling workload plus weak recovery markers suggest cumulative overload.",
      severity: "HIGH",
    });
    pushUnique(injuries, {
      type: "lower back stress",
      reason: "Workload accumulation with low recovery increases trunk and lumbar stress risk.",
      severity: "MEDIUM",
    });
    pushUnique(injuries, {
      type: "tendonitis risk",
      reason: "Sustained load with insufficient rest elevates tendon irritation likelihood.",
      severity: "MEDIUM",
    });
  }

  if (noBallRisk === "HIGH" && fatigue >= 6) {
    pushUnique(injuries, {
      type: "ankle/knee stress",
      reason: "Control loss under fatigue can disrupt landing mechanics and joint load.",
      severity: "MEDIUM",
    });
    pushUnique(injuries, {
      type: "shoulder overload",
      reason: "Fatigue-related control drift can force compensatory shoulder effort.",
      severity: "MEDIUM",
    });
  }

  if (isPaceRole(role) && highOvers) {
    pushUnique(injuries, {
      type: "lumbar stress",
      reason: "Pace workload at high over counts can increase lumbar extension stress.",
      severity: "HIGH",
    });
    pushUnique(injuries, {
      type: "side strain",
      reason: "High-velocity pace bowling can overload lateral trunk structures.",
      severity: "MEDIUM",
    });
    pushUnique(injuries, {
      type: "shoulder impingement",
      reason: "Repeated high-pace shoulder loading increases impingement risk.",
      severity: "MEDIUM",
    });
  }

  if (isSpinRole(role) && highOvers && highStrain) {
    pushUnique(injuries, {
      type: "finger/wrist strain",
      reason: "Sustained spin volume under strain can overload wrist and finger tendons.",
      severity: "MEDIUM",
    });
    pushUnique(injuries, {
      type: "shoulder overuse",
      reason: "High over count and strain can drive repetitive shoulder overuse in spin.",
      severity: "MEDIUM",
    });
  }

  if (injuries.length === 0 && (injuryRisk === "HIGH" || fatigue >= 6)) {
    pushUnique(injuries, {
      type: "general soft-tissue injury",
      reason: "Current fatigue/risk signals indicate increased soft-tissue injury exposure.",
      severity: injuryRisk === "HIGH" ? "HIGH" : "MEDIUM",
    });
  }

  return injuries;
};

export const buildContinueRiskSummary = (playerName: string, injuries: LikelyInjury[]): string => {
  if (injuries.length === 0) {
    return `If ${playerName} continues, keep close monitoring for fatigue-linked control drop.`;
  }
  const leading = injuries.slice(0, 2).map((injury) => injury.type).join(" and ");
  return `If ${playerName} continues, there is increased risk of ${leading}.`;
};
