import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { 
  Activity, 
  Users, 
  Brain, 
  ChevronRight, 
  Settings, 
  Wind, 
  Thermometer, 
  PlayCircle, 
  AlertTriangle, 
  CheckCircle2, 
  ArrowLeft,
  Plus,
  Minus,
  Save,
  Trophy,
  Zap,
  Shield,
  LogOut,
  User,
  Hexagon,
  Trash2,
  UserMinus,
  Cpu,
  HelpCircle,
  Info
} from 'lucide-react';
import { motion, AnimatePresence, useMotionValue, useSpring, useTransform, useMotionTemplate } from 'motion/react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  FatigueAgentResponse,
  FinalRecommendation,
  OrchestrateResponse,
  RiskAgentResponse,
  TacticalAgentResponse,
  TacticalCombinedDecision,
} from './types/agents';
import {
  ApiClientError,
  apiAgentFrameworkMessagesUrl,
  apiFullAnalysisUrl,
  apiHealthUrl,
  apiOrchestrateUrl,
  checkHealth,
  deleteBaseline,
  getBaselineByPlayerId,
  getBaselinesWithMeta,
  postAgentFrameworkOrchestrate,
  postFullCombinedAnalysis,
  postOrchestrate,
  postTacticalAgent,
  resetBaselines,
  saveBaselines,
} from './lib/apiClient';
import { getRosterIds, removeFromRosterSession, ROSTER_STORAGE_KEY, setBaselineDraftCache, setRosterIds } from './lib/rosterStorage';
import { buildMatchContext, summarizeMatchContext } from './lib/buildMatchContext';
import { Baseline, BaselineRole } from './types/baseline';
import {
  clamp,
  computeInjuryRisk,
  computeLoadRatio,
  computeNoBallRisk,
  computeStatus,
  type Phase,
  type RecoveryLevel,
  type RecoveryMode,
  type Role,
  type StatusLevel,
} from './lib/riskModel';

// --- Types ---

type Page = 'landing' | 'setup' | 'dashboard' | 'baselines';
type TeamMode = 'BATTING' | 'BOWLING';
type RunMode = 'auto' | 'full';

interface MatchContext {
  matchMode: TeamMode;
  format: string;
  phase: string;
  pitch: string;
  weather: string;
}

interface MatchState {
  runs: number;
  wickets: number;
  ballsBowled: number;
  totalOvers: number;
  target?: number;
}

type DismissalStatus = 'NOT_OUT' | 'OUT';

interface Player {
  id: string;
  baselineId?: string;
  name: string;
  role: 'Bowler' | 'Fast Bowler' | 'Spinner' | 'Batsman' | 'All-rounder';
  isSub?: boolean;
  inRoster?: boolean; // Default true if undefined for backward compatibility
  isActive?: boolean;
  // Live Metrics
  overs: number;
  consecutiveOvers: number; // Legacy compatibility field; no longer user-controlled.
  lastRestOvers?: number;
  fatigue: number; // 0-10
  strainIndex?: number;
  hrRecovery: 'Good' | 'Moderate' | 'Poor';
  injuryRisk: 'Low' | 'Medium' | 'High' | 'Critical';
  noBallRisk: 'Low' | 'Medium' | 'High';
  agentFatigueOverride?: number;
  agentRiskOverride?: 'Low' | 'Medium' | 'High' | 'Critical';
  runs: number;
  balls: number;
  boundaryEvents: Array<'4' | '6'>;
  dismissalStatus?: DismissalStatus;
  isDismissed?: boolean;
  dismissalType?: 'Bowled' | 'Caught' | 'LBW' | 'Run Out' | 'Not Out';
  // Baseline Data
  baselineFatigue: number;
  sleepHours: number;
  recoveryTime: number; // in minutes
  controlBaseline?: number;
  speed?: number;
  power?: number;
  isResting?: boolean;
  restStartMs?: number;
  restStartFatigue?: number;
  restElapsedSec?: number;
  recoveryElapsed?: number;
  recoveryOffset?: number;
  isInjured?: boolean;
  isManuallyUnfit?: boolean;
  isUnfit?: boolean;
  _previousState?: {
    fatigue: number;
    hrRecovery: 'Good' | 'Moderate' | 'Poor';
    injuryRisk: 'Low' | 'Medium' | 'High' | 'Critical';
    noBallRisk: 'Low' | 'Medium' | 'High';
    overs: number;
    consecutiveOvers: number;
    lastRestOvers?: number;
    recoveryOffset: number;
    isResting: boolean;
    restElapsedSec: number;
    recoveryElapsed: number;
    isInjured: boolean;
    isManuallyUnfit: boolean;
  };
}

interface FatigueAgentPayload {
  playerId: string;
  playerName: string;
  role: string;
  oversBowled: number;
  consecutiveOvers: number;
  oversRemaining?: number;
  maxOvers?: number;
  fatigueIndex: number;
  injuryRisk: 'LOW' | 'MED' | 'HIGH' | 'MEDIUM';
  noBallRisk: 'LOW' | 'MED' | 'HIGH' | 'MEDIUM';
  heartRateRecovery: string;
  fatigueLimit: number;
  sleepHours: number;
  recoveryMinutes: number;
  snapshotId: string;
  matchContext: {
    format: string;
    phase: string;
    over: number;
    intensity: string;
  };
}

interface AiAnalysis {
  playerId: string;
  fatigueIndex?: number;
  riskScore?: number;
  injuryRisk: 'LOW' | 'MED' | 'HIGH';
  noBallRisk: 'LOW' | 'MED' | 'HIGH';
  severity: 'LOW' | 'MED' | 'HIGH' | 'CRITICAL';
  signals: string[];
  explanation: string;
  headline: string;
  recommendation: string;
}

type AgentFeedState = 'IDLE' | 'RUNNING' | 'SUCCESS' | 'SKIPPED' | 'ERROR';
type AgentKey = 'fatigue' | 'risk' | 'tactical';

interface AgentFeedStatus {
  fatigue: AgentFeedState;
  risk: AgentFeedState;
  tactical: AgentFeedState;
}

interface OrchestrateMetaView {
  mode: 'auto' | 'full';
  executedAgents: Array<'fatigue' | 'risk' | 'tactical'>;
  usedFallbackAgents: Array<'fatigue' | 'risk' | 'tactical'>;
  routerFallbackMessage?: string;
  traceId?: string;
  source?: 'azure' | 'mock';
  azureRequestId?: string;
  timingsMs?: {
    total?: number;
    router?: number;
    azureCall?: number;
  };
  agentStatuses?: Partial<Record<'fatigue' | 'risk' | 'tactical', string>>;
}

interface SuggestedBowlerRecommendation {
  bowlerId: string;
  bowlerName: string;
  reason?: string;
}

interface RunCoachAgentResult {
  response: OrchestrateResponse;
  suggestedBowler: SuggestedBowlerRecommendation | null;
}

interface RouterDecisionView {
  intent:
    | 'SUBSTITUTION'
    | 'BOWLING_NEXT'
    | 'BATTING_NEXT'
    | 'BOTH_NEXT'
    | 'SAFETY_ALERT'
    | 'GENERAL'
    | 'fatigue_check'
    | 'risk_check'
    | 'substitution'
    | 'full'
    | 'InjuryPrevention'
    | 'PressureControl'
    | 'TacticalAttack'
    | 'General'
    | string;
  agentsToRun?: Array<'RISK' | 'TACTICAL' | 'FATIGUE'>;
  selectedAgents?: Array<'fatigue' | 'risk' | 'tactical'>;
  signalSummaryBullets?: string[];
  rationale?: string;
  rulesFired: string[];
  inputsUsed: {
    activePlayerId?: string;
    active: {
      fatigueIndex?: number;
      strainIndex?: number;
      injuryRisk?: string;
      noBallRisk?: string;
    };
    match: {
      matchMode?: string;
      format?: string;
      phase?: string;
      overs?: number;
      balls?: number;
      scoreRuns?: number;
      wickets?: number;
      targetRuns?: number;
      intensity?: string;
    };
  };
  reason: string;
  signals: Record<string, unknown>;
}

interface RiskAgentPayload {
  playerId: string;
  fatigueIndex: number;
  injuryRisk: 'LOW' | 'MED' | 'HIGH' | 'MEDIUM';
  noBallRisk: 'LOW' | 'MED' | 'HIGH' | 'MEDIUM';
  oversBowled: number;
  consecutiveOvers: number;
  oversRemaining?: number;
  maxOvers?: number;
  heartRateRecovery?: string;
  format: string;
  phase: string;
  intensity: string;
  conditions?: string;
  target?: number;
  score?: number;
  over?: number;
  balls?: number;
}

interface TelemetrySnapshot {
  playerId: string;
  overs: number;
  oversRemaining: number;
  maxOvers: number;
  isResting: boolean;
  restElapsedSec: number;
}

// --- Mock Data ---

const INITIAL_PLAYERS: Player[] = [
  { 
    id: 'p1', name: 'J. Archer', role: 'Fast Bowler', 
    isActive: true,
    lastRestOvers: 0,
    overs: 2, consecutiveOvers: 2, fatigue: 3, hrRecovery: 'Good', injuryRisk: 'Low', noBallRisk: 'Low',
    runs: 0, balls: 0, boundaryEvents: [], dismissalStatus: 'NOT_OUT', dismissalType: 'Not Out',
    baselineFatigue: 6, sleepHours: 7.5, recoveryTime: 45, controlBaseline: 80, speed: 9, power: 7
  },
  { 
    id: 'p2', name: 'R. Khan', role: 'Spinner', 
    isActive: true,
    lastRestOvers: 7,
    overs: 8, consecutiveOvers: 1, fatigue: 4, hrRecovery: 'Good', injuryRisk: 'Low', noBallRisk: 'Low',
    runs: 0, balls: 0, boundaryEvents: [], dismissalStatus: 'NOT_OUT', dismissalType: 'Not Out',
    baselineFatigue: 8, sleepHours: 6, recoveryTime: 30, controlBaseline: 88, speed: 7, power: 5
  },
  { 
    id: 'p3', name: 'B. Stokes', role: 'All-rounder', 
    isActive: true,
    lastRestOvers: 0,
    overs: 3, consecutiveOvers: 3, fatigue: 5, hrRecovery: 'Moderate', injuryRisk: 'Medium', noBallRisk: 'Low',
    runs: 24, balls: 18, boundaryEvents: ['4', '4', '6'], dismissalStatus: 'NOT_OUT', dismissalType: 'Not Out',
    baselineFatigue: 5, sleepHours: 8, recoveryTime: 50, controlBaseline: 76, speed: 8, power: 8
  },
  { 
    id: 'p4', name: 'P. Cummins', role: 'Fast Bowler', 
    isActive: true,
    lastRestOvers: 10,
    overs: 10, consecutiveOvers: 0, fatigue: 7, hrRecovery: 'Poor', injuryRisk: 'High', noBallRisk: 'Medium',
    runs: 0, balls: 0, boundaryEvents: [], dismissalStatus: 'NOT_OUT', dismissalType: 'Not Out',
    baselineFatigue: 7, sleepHours: 5.5, recoveryTime: 60, controlBaseline: 82, speed: 8, power: 8
  },
];

// --- Components ---

const GlowingBackButton = ({
  onClick,
  label = "Back",
  size = 'default',
}: {
  onClick: () => void;
  label?: string;
  size?: 'default' | 'large';
}) => {
  return (
    <button type="button" 
      onClick={onClick}
      className="group flex items-center gap-3 text-slate-400 hover:text-white transition-colors px-2 py-2"
    >
      <div className="relative flex items-center justify-center">
        {/* The Glow - Moves with the arrow */}
        <div className="absolute inset-0 bg-emerald-500/60 blur-[8px] rounded-full opacity-0 group-hover:opacity-100 group-hover:-translate-x-1 transition-all duration-300 pointer-events-none" />
        
        {/* The Arrow */}
        <ArrowLeft
          className={`${size === 'large' ? 'w-6 h-6' : 'w-5 h-5'} relative z-10 group-hover:-translate-x-1 transition-transform duration-300`}
        />
      </div>
      <span className={`font-medium ${size === 'large' ? 'text-base' : 'text-sm'} tracking-wide`}>{label}</span>
    </button>
  );
};

// --- Particles Background with Parallax ---
const ParallaxParticles = () => {
  const mouseX = useMotionValue(0);
  const mouseY = useMotionValue(0);

  // Smooth out the mouse movement - lowered stiffness for "floaty" following effect
  const smoothMouseX = useSpring(mouseX, { damping: 100, stiffness: 100 });
  const smoothMouseY = useSpring(mouseY, { damping: 100, stiffness: 100 });

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      // Center the coordinate system
      mouseX.set(e.clientX - window.innerWidth / 2);
      mouseY.set(e.clientY - window.innerHeight / 2);
    };
    
    window.addEventListener("mousemove", handleMouseMove);
    return () => window.removeEventListener("mousemove", handleMouseMove);
  }, [mouseX, mouseY]);

  // Create particles with random initial positions
  const particles = React.useMemo(() => {
    return [...Array(50)].map((_, i) => ({
      id: i,
      top: Math.random() * 100,
      left: Math.random() * 100,
      size: Math.random() * 6 + 3, // Increased size: 3px to 9px
      opacity: Math.random() * 0.3 + 0.1, // Slightly lower opacity for larger particles
      depth: Math.random() * 5 + 2, // Increased depth factor for more movement
      blur: Math.random() > 0.6 ? 2 : 0, // More blur for depth feel
    }));
  }, []);

  return (
    <div className="absolute inset-0 pointer-events-none overflow-hidden z-0">
      {particles.map((p) => (
        <Particle 
          key={p.id} 
          {...p} 
          mouseX={smoothMouseX} 
          mouseY={smoothMouseY} 
        />
      ))}
    </div>
  );
};

interface ParticleProps {
  top: number;
  left: number;
  size: number;
  opacity: number;
  depth: number;
  blur: number;
  mouseX: ReturnType<typeof useSpring>;
  mouseY: ReturnType<typeof useSpring>;
}

const Particle = ({ top, left, size, opacity, depth, blur, mouseX, mouseY }: ParticleProps) => {
  // Movement factor based on depth. 
  // Positive multiplier = moves WITH mouse (follows).
  // Increased divisor to make it cover more distance.
  const x = useTransform(mouseX, (v: number) => (v * depth) / 15);
  const y = useTransform(mouseY, (v: number) => (v * depth) / 15);

  return (
    <motion.div
      className="absolute bg-emerald-500 rounded-full"
      style={{
        top: `${top}%`,
        left: `${left}%`,
        width: size,
        height: size,
        opacity,
        filter: blur ? `blur(${blur}px)` : 'none',
        x,
        y,
      }}
      animate={{
        // Add a gentle floating animation on top of the parallax
        y: [0, -20, 0],
        x: [0, 10, 0],
      }}
      transition={{
        y: {
          duration: 5 + Math.random() * 5,
          repeat: Infinity,
          ease: "easeInOut",
          delay: Math.random() * 5
        },
        x: {
          duration: 7 + Math.random() * 5,
          repeat: Infinity,
          ease: "easeInOut",
          delay: Math.random() * 5
        }
      }}
    />
  );
};

// --- Mouse Glow Follower ---
const MouseGlow = () => {
  const mouseX = useMotionValue(0);
  const mouseY = useMotionValue(0);

  // Instant tracking without lag
  const x = mouseX;
  const y = mouseY;

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      mouseX.set(e.clientX);
      mouseY.set(e.clientY);
    };
    
    window.addEventListener("mousemove", handleMouseMove);
    return () => window.removeEventListener("mousemove", handleMouseMove);
  }, []);

  return (
    <motion.div 
      className="fixed top-0 left-0 pointer-events-none z-[60] mix-blend-screen"
      style={{ x, y, translateX: '-50%', translateY: '-50%' }}
    >
      {/* Pure soft light source - no defined circle shapes, just a diffuse glow */}
      <div className="w-64 h-64 bg-emerald-500/15 rounded-full blur-[60px]" />
      
      {/* Slightly brighter core for intensity, but highly blurred */}
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-32 h-32 bg-white/10 rounded-full blur-[40px]" />
    </motion.div>
  );
};

// --- Animated Logo Component ---
const AnimatedLogo = ({ scale = 1, showText = true }: { scale?: number, showText?: boolean }) => {
  return (
    <div className="flex flex-col items-center">
      {/* Logo Icon */}
      <div className="relative mb-6" style={{ transform: `scale(${scale})` }}>
        <motion.div 
          initial={{ rotate: -180, opacity: 0 }}
          animate={{ rotate: 0, opacity: 1 }}
          transition={{ duration: 1.2, ease: "backOut" }}
          className="w-24 h-24 bg-gradient-to-tr from-emerald-600 to-emerald-400 rounded-2xl flex items-center justify-center shadow-[0_0_40px_rgba(16,185,129,0.4)] relative"
        >
          <div className="absolute inset-0 bg-white/20 rounded-2xl opacity-0 animate-pulse" />
          <Hexagon className="w-12 h-12 text-white fill-emerald-800/20 stroke-[1.5]" />
          <div className="absolute">
            <Activity className="w-6 h-6 text-white" />
          </div>
        </motion.div>
        
        {/* Orbiting Ring */}
        <motion.div 
           className="absolute -inset-4 rounded-full border border-emerald-500/30 border-t-transparent"
           animate={{ rotate: 360 }}
           transition={{ duration: 2, repeat: Infinity, ease: "linear" }}
        />
      </div>
    </div>
  );
}

// --- Splash Screen ---
function SplashScreen({ onComplete }: { onComplete: () => void }) {
  useEffect(() => {
    const timer = setTimeout(onComplete, 2500);
    return () => clearTimeout(timer);
  }, [onComplete]);

  return (
    <div className="fixed inset-0 z-[100] bg-[#020408] flex flex-col items-center justify-center overflow-hidden">
      {/* Background Ambience */}
      <div className="absolute inset-0 pointer-events-none">
        <ParallaxParticles />
        <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-transparent via-emerald-500/50 to-transparent opacity-50"></div>
        <div className="absolute inset-0 opacity-[0.05]" 
             style={{ 
               backgroundImage: 'radial-gradient(circle at 50% 50%, #10B981 1px, transparent 1px)', 
               backgroundSize: '60px 60px' 
             }} 
        />
      </div>

      {/* Logo Container */}
      <motion.div 
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 1.1, filter: 'blur(10px)' }}
        transition={{ duration: 0.8, ease: "easeOut" }}
        className="relative z-10 flex flex-col items-center"
      >
        <AnimatedLogo />
      </motion.div>
    </div>
  );
}

// --- Telemetry Logic ---

const normalizePhase = (phase: string): Phase => {
  if (phase === 'Powerplay' || phase === 'Middle' || phase === 'Death') return phase;
  return 'Middle';
};

const normalizeRole = (role: Player['role']): Role => {
  if (role === 'Fast Bowler' || role === 'Spinner' || role === 'All-rounder') return role;
  return 'All-rounder';
};
const isBowlingRole = (role: Player['role']): boolean =>
  role === 'Bowler' || role === 'Fast Bowler' || role === 'Spinner';
const isBattingRole = (role: Player['role']): boolean =>
  role === 'Batsman' || role === 'All-rounder';
const toBooleanFlag = (value: unknown): boolean => {
  if (value === true) return true;
  if (value === false || value === undefined || value === null) return false;
  const token = String(value).trim().toLowerCase();
  return token === 'true' || token === '1' || token === 'yes';
};
const isEligibleForMode = (player: Player, mode: TeamMode): boolean => {
  const roleAllowsBowling = isBowlingRole(player.role) || player.role === 'All-rounder';
  const roleAllowsBatting = isBattingRole(player.role);
  const capability = player as unknown as Record<string, unknown>;
  const canBowl = toBooleanFlag(capability.canBowl);
  const canBat = toBooleanFlag(capability.canBat);
  if (mode === 'BOWLING') {
    return roleAllowsBowling && (canBowl || roleAllowsBowling);
  }
  return roleAllowsBatting && (canBat || roleAllowsBatting);
};
const deriveFocusRoleFromPlayer = (
  player: Player | null | undefined,
  teamMode: TeamMode
): 'BOWLER' | 'BATTER' => {
  if (!player) return teamMode === 'BOWLING' ? 'BOWLER' : 'BATTER';
  if (isBowlingRole(player.role)) return 'BOWLER';
  if (player.role === 'All-rounder') return teamMode === 'BOWLING' ? 'BOWLER' : 'BATTER';
  return 'BATTER';
};

const totalBallsFromOvers = (overs: number): number => {
  return Math.max(0, Math.floor(overs)) * 6;
};

const formatOverStr = (balls: number): string => {
  const safeBalls = Math.max(0, Math.floor(balls));
  const wholeOvers = Math.floor(safeBalls / 6);
  const ballPart = safeBalls % 6;
  return `${wholeOvers}.${ballPart}`;
};

const safeNum = (v: unknown, fallback: number): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
};

const getMaxOvers = (format: string): number => {
  const normalized = String(format || '').trim().toUpperCase();
  if (normalized === 'T20') return 4;
  if (normalized === 'ODI') return 10;
  return 999; // Test / no strict cap.
};

const clampOversBowled = (value: number, maxOvers: number): number => {
  const safeMax = Math.max(1, Math.floor(safeNum(maxOvers, 1)));
  return Math.max(0, Math.min(safeMax, Math.floor(safeNum(value, 0))));
};

const computeOversRemaining = (oversBowled: number, maxOvers: number): number =>
  Math.max(0, Math.floor(safeNum(maxOvers, 0)) - Math.floor(safeNum(oversBowled, 0)));

type SanitizedBowlerWorkload = Pick<Player, 'overs' | 'consecutiveOvers' | 'lastRestOvers' | 'fatigue'> & {
  maxOvers: number;
  oversRemaining: number;
};

/**
 * Bowling workload invariants:
 * - 0 <= oversBowled <= format cap (T20=4, ODI=10, Test=999)
 * - 0 <= oversRemaining <= maxOvers
 * - oversRemaining === maxOvers - oversBowled
 * - legacy consecutiveOvers is retained as 0 for backward compatibility only
 * - fatigue is always clamped to [0, 10]
 */
const sanitizeBowlerWorkload = (player: Player, format: string): SanitizedBowlerWorkload => {
  const maxOvers = getMaxOvers(format);
  const oversBowled = clampOversBowled(safeNum(player.overs, 0), maxOvers);
  const legacySpellOvers = Math.max(0, Math.floor(safeNum(player.consecutiveOvers, 0)));
  const inferredLastRest = Math.max(0, oversBowled - legacySpellOvers);
  const lastRestOvers = Math.max(
    0,
    Math.min(
      oversBowled,
      Math.floor(safeNum(player.lastRestOvers, inferredLastRest))
    )
  );
  const oversRemaining = computeOversRemaining(oversBowled, maxOvers);
  const fatigue = clamp(safeNum(player.fatigue, 2.5), 0, 10);
  const consecutiveOvers = 0;

  if (import.meta.env.DEV) {
    const inRange =
      oversBowled >= 0 &&
      oversBowled <= maxOvers &&
      oversRemaining >= 0 &&
      oversRemaining <= maxOvers &&
      oversRemaining === maxOvers - oversBowled;
    console.assert(inRange, 'Bowler workload invariant violation (auto-corrected).', {
      playerId: player.id,
      format,
      oversBowled,
      maxOvers,
      oversRemaining,
    });
  }

  return {
    overs: oversBowled,
    lastRestOvers,
    consecutiveOvers,
    fatigue,
    maxOvers,
    oversRemaining,
  };
};

const normalizeBaselineId = (value: string): string => String(value || '').trim();
const baselineKey = (value: string): string => normalizeBaselineId(value).toLowerCase();

const playerRoleToBaselineRole = (role: Player['role']): BaselineRole => {
  if (role === 'Fast Bowler' || role === 'Bowler') return 'FAST';
  if (role === 'Spinner') return 'SPIN';
  if (role === 'Batsman') return 'BAT';
  return 'AR';
};

const baselineRoleToPlayerRole = (role: BaselineRole): Player['role'] => {
  if (role === 'FAST') return 'Fast Bowler';
  if (role === 'SPIN') return 'Spinner';
  if (role === 'BAT') return 'Batsman';
  return 'All-rounder';
};

const normalizeBaselineRecord = (baseline: Partial<Baseline>): Baseline => ({
  id: normalizeBaselineId(baseline.id || baseline.playerId || baseline.name),
  playerId: normalizeBaselineId(baseline.playerId || baseline.id || baseline.name),
  name: String(baseline.name || baseline.id || baseline.playerId || 'Unknown Player').trim() || 'Unknown Player',
  role: baseline.role,
  isActive: baseline.isActive ?? baseline.active ?? true,
  inRoster: Boolean((baseline as Baseline).inRoster),
  sleepHoursToday: clamp(safeNum(baseline.sleepHoursToday ?? baseline.sleep, 7), 0, 12),
  recoveryMinutes: clamp(safeNum(baseline.recoveryMinutes ?? baseline.recovery, 45), 0, 240),
  fatigueLimit: clamp(safeNum(baseline.fatigueLimit, 6), 0, 10),
  controlBaseline: clamp(safeNum(baseline.controlBaseline ?? baseline.control, 78), 0, 100),
  speed: clamp(safeNum(baseline.speed, 7), 0, 100),
  power: clamp(safeNum(baseline.power, 6), 0, 100),
  sleep: clamp(safeNum(baseline.sleep ?? baseline.sleepHoursToday, 7), 0, 12),
  recovery: clamp(safeNum(baseline.recovery ?? baseline.recoveryMinutes, 45), 0, 240),
  control: clamp(safeNum(baseline.control ?? baseline.controlBaseline, 78), 0, 100),
  active: baseline.active ?? baseline.isActive ?? true,
  orderIndex: Math.max(0, Math.floor(safeNum(baseline.orderIndex, 0))),
  createdAt: baseline.createdAt,
  updatedAt: baseline.updatedAt,
});

const parseBaselineOrderIndex = (value: number | undefined): number => {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value as number));
};

const sortByOrderIndex = <T extends { orderIndex?: number }>(rows: T[]): T[] =>
  rows
    .map((row, index) => ({ row, index, orderIndex: parseBaselineOrderIndex(row.orderIndex) }))
    .sort((a, b) => {
      if (a.orderIndex !== b.orderIndex) return a.orderIndex - b.orderIndex;
      return a.index - b.index;
    })
    .map((entry) => entry.row);

const orderBaselinesForDisplay = (rows: Baseline[]): Baseline[] => {
  const normalized = rows.map((row) => normalizeBaselineRecord(row));
  return sortByOrderIndex(normalized);
};

const MAX_ROSTER = 11;
const BASELINES_CHANGED_EVENT = 'tactiq-baselines-changed';
const BATTER_DISMISSAL_STORAGE_KEY = 'tactiq_batter_dismissal_v1';
const MATCH_MODE_STORAGE_KEY = 'tactiq_match_mode_v1';
const ACTIVE_PLAYER_STORAGE_KEY = 'tactiq_active_player_v1';

interface DismissalSessionEntry {
  status: DismissalStatus;
  dismissalType: Player['dismissalType'];
}

type DismissalSessionState = Record<string, DismissalSessionEntry>;

const resolveDismissalStatus = (player: Pick<Player, 'dismissalStatus' | 'isDismissed'>): DismissalStatus => {
  if (player.dismissalStatus === 'OUT' || player.dismissalStatus === 'NOT_OUT') return player.dismissalStatus;
  return player.isDismissed ? 'OUT' : 'NOT_OUT';
};

const resolveDismissalType = (
  status: DismissalStatus,
  fallback?: Player['dismissalType']
): Player['dismissalType'] => {
  if (status === 'NOT_OUT') return 'Not Out';
  if (fallback && fallback !== 'Not Out') return fallback;
  return 'Caught';
};

const normalizeDismissalPlayerState = (player: Player): Player => {
  const status = resolveDismissalStatus(player);
  return {
    ...player,
    dismissalStatus: status,
    isDismissed: status === 'OUT',
    dismissalType: resolveDismissalType(status, player.dismissalType),
  };
};

const readDismissalSessionState = (): DismissalSessionState => {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(BATTER_DISMISSAL_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};

    const entries = Object.entries(parsed as Record<string, unknown>);
    return entries.reduce<DismissalSessionState>((acc, [key, value]) => {
      if (!value || typeof value !== 'object') return acc;
      const record = value as Partial<DismissalSessionEntry>;
      if (record.status !== 'OUT' && record.status !== 'NOT_OUT') return acc;
      acc[String(key)] = {
        status: record.status,
        dismissalType: resolveDismissalType(record.status, record.dismissalType),
      };
      return acc;
    }, {});
  } catch {
    return {};
  }
};

const writeDismissalSessionState = (state: DismissalSessionState): void => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(BATTER_DISMISSAL_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Ignore storage write failures.
  }
};

const persistDismissalStatusForPlayer = (
  playerId: string,
  status: DismissalStatus,
  dismissalType?: Player['dismissalType']
): void => {
  const key = baselineKey(playerId);
  if (!key) return;
  const state = readDismissalSessionState();
  state[key] = {
    status,
    dismissalType: resolveDismissalType(status, dismissalType),
  };
  writeDismissalSessionState(state);
};

const clearDismissalStatusForPlayer = (playerId: string): void => {
  const key = baselineKey(playerId);
  if (!key) return;
  const state = readDismissalSessionState();
  if (!(key in state)) return;
  delete state[key];
  writeDismissalSessionState(state);
};

const hydrateDismissalStateFromSession = (players: Player[]): Player[] => {
  const state = readDismissalSessionState();
  return players.map((player) => {
    const key = baselineKey(player.id);
    const entry = key ? state[key] : undefined;
    if (!entry) return normalizeDismissalPlayerState(player);
    return normalizeDismissalPlayerState({
      ...player,
      dismissalStatus: entry.status,
      dismissalType: entry.dismissalType,
    });
  });
};

const normalizeMatchMode = (value: unknown): MatchContext['matchMode'] | null => {
  const normalized = String(value || '').trim().toUpperCase();
  if (normalized === 'BAT' || normalized === 'BATTING') return 'BATTING';
  if (normalized === 'BOWL' || normalized === 'BOWLING') return 'BOWLING';
  return null;
};

const readStoredMatchMode = (): MatchContext['matchMode'] | null => {
  if (typeof window === 'undefined') return null;
  try {
    return normalizeMatchMode(window.localStorage.getItem(MATCH_MODE_STORAGE_KEY));
  } catch {
    return null;
  }
};

const writeStoredMatchMode = (mode: MatchContext['matchMode']): void => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(MATCH_MODE_STORAGE_KEY, mode);
  } catch {
    // Ignore storage write failures.
  }
};

const readStoredActivePlayerId = (): string => {
  if (typeof window === 'undefined') return '';
  try {
    return normalizeBaselineId(window.localStorage.getItem(ACTIVE_PLAYER_STORAGE_KEY) || '');
  } catch {
    return '';
  }
};

const writeStoredActivePlayerId = (playerId: string): void => {
  if (typeof window === 'undefined') return;
  try {
    const normalizedId = normalizeBaselineId(playerId);
    if (!normalizedId) {
      window.localStorage.removeItem(ACTIVE_PLAYER_STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(ACTIVE_PLAYER_STORAGE_KEY, normalizedId);
  } catch {
    // Ignore storage write failures.
  }
};

const toRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const AGENT_KEYS: AgentKey[] = ['fatigue', 'risk', 'tactical'];

const getDefaultAgentFeedStatus = (): AgentFeedStatus => ({
  fatigue: 'IDLE',
  risk: 'IDLE',
  tactical: 'IDLE',
});

const toAgentKey = (value: unknown): AgentKey | null => {
  const token = String(value || '').trim().toLowerCase();
  if (token === 'fatigue' || token === 'risk' || token === 'tactical') return token as AgentKey;
  if (token === 'fatigueagent') return 'fatigue';
  if (token === 'riskagent') return 'risk';
  if (token === 'tacticalagent') return 'tactical';
  return null;
};

const toSuggestedBowlerRecommendation = (
  bowlerId: unknown,
  bowlerName: unknown,
  reason?: unknown
): SuggestedBowlerRecommendation | null => {
  const id = String(bowlerId || '').trim();
  const name = String(bowlerName || '').trim();
  if (!id || !name) return null;
  const normalizedReason = String(reason || '').trim();
  return {
    bowlerId: id,
    bowlerName: name,
    ...(normalizedReason ? { reason: normalizedReason } : {}),
  };
};

const resolveSuggestionPlayer = (
  suggestion: SuggestedBowlerRecommendation,
  rosterPlayers: Player[]
): Player | null => {
  const byId = rosterPlayers.find((player) => baselineKey(player.id) === baselineKey(suggestion.bowlerId));
  if (byId && byId.inRoster !== false) return byId;
  const byName = rosterPlayers.find((player) => baselineKey(player.name) === baselineKey(suggestion.bowlerName));
  if (byName && byName.inRoster !== false) return byName;
  return null;
};

const normalizeSuggestedBowler = (
  result: OrchestrateResponse,
  rosterPlayers: Player[] = [],
  activePlayerId?: string,
  mode: TeamMode = 'BOWLING'
): SuggestedBowlerRecommendation | null => {
  const toModeEligibleSuggestion = (candidate: SuggestedBowlerRecommendation | null): SuggestedBowlerRecommendation | null => {
    if (!candidate) return null;
    if (rosterPlayers.length === 0) return candidate;
    const resolved = resolveSuggestionPlayer(candidate, rosterPlayers);
    if (!resolved) return null;
    return isEligibleForMode(resolved, mode) ? candidate : null;
  };

  const directRecommendation = toModeEligibleSuggestion(
    result.recommendation?.bowlerId && result.recommendation.bowlerName
      ? {
          bowlerId: String(result.recommendation.bowlerId),
          bowlerName: String(result.recommendation.bowlerName),
          reason: typeof result.recommendation.reason === 'string' ? result.recommendation.reason : undefined,
        }
      : null
  );
  if (directRecommendation) return directRecommendation;

  const suggestedRotationRecommendation = toModeEligibleSuggestion(
    result.suggestedRotation?.playerId && result.suggestedRotation.name
      ? {
          bowlerId: String(result.suggestedRotation.playerId),
          bowlerName: String(result.suggestedRotation.name),
          reason: typeof result.suggestedRotation.rationale === 'string' ? result.suggestedRotation.rationale : undefined,
        }
      : null
  );
  if (suggestedRotationRecommendation) return suggestedRotationRecommendation;

  const modeFinalCandidate = mode === 'BATTING'
    ? result.finalRecommendation?.nextSafeBatter
    : result.finalRecommendation?.nextSafeBowler;
  const finalRecommendationCandidate = toModeEligibleSuggestion(
    modeFinalCandidate?.playerId && modeFinalCandidate?.name
      ? {
          bowlerId: String(modeFinalCandidate.playerId),
          bowlerName: String(modeFinalCandidate.name),
          reason: typeof modeFinalCandidate.reason === 'string' ? modeFinalCandidate.reason : undefined,
        }
      : null
  );
  if (finalRecommendationCandidate) return finalRecommendationCandidate;

  const tacticalRecord = toRecord(result.tactical as unknown);
  const tacticalSuggestedSub = toRecord(tacticalRecord.suggestedSubstitution);
  const tacticalSuggested = toModeEligibleSuggestion(toSuggestedBowlerRecommendation(
    tacticalSuggestedSub.playerId ?? tacticalSuggestedSub.bowlerId,
    tacticalSuggestedSub.name ?? tacticalSuggestedSub.bowlerName,
    tacticalSuggestedSub.reason ?? tacticalSuggestedSub.rationale
  ));
  if (tacticalSuggested) return tacticalSuggested;

  const tacticalAgentRecord = toRecord((result as unknown as Record<string, unknown>).tacticalAgent);
  const tacticalAgentRecommendation = toRecord(tacticalAgentRecord.recommendation);
  const tacticalAgentSuggested = toModeEligibleSuggestion(toSuggestedBowlerRecommendation(
    tacticalAgentRecommendation.playerId ?? tacticalAgentRecommendation.bowlerId,
    tacticalAgentRecommendation.name ?? tacticalAgentRecommendation.bowlerName,
    tacticalAgentRecommendation.reason ?? tacticalAgentRecommendation.rationale
  ));
  if (tacticalAgentSuggested) return tacticalAgentSuggested;

  const tacticalOutputRecord = toRecord(toRecord(result.agentOutputs as unknown).tactical);
  const tacticalOutputSuggestedSub = toRecord(tacticalOutputRecord.suggestedSubstitution);
  const tacticalOutputSuggested = toModeEligibleSuggestion(toSuggestedBowlerRecommendation(
    tacticalOutputSuggestedSub.playerId ?? tacticalOutputSuggestedSub.bowlerId,
    tacticalOutputSuggestedSub.name ?? tacticalOutputSuggestedSub.bowlerName,
    tacticalOutputSuggestedSub.reason ?? tacticalOutputSuggestedSub.rationale
  ));
  if (tacticalOutputSuggested) return tacticalOutputSuggested;

  const activeIdKey = baselineKey(activePlayerId || '');
  const modeRoster = rosterPlayers.filter(
    (player) =>
      player.inRoster !== false &&
      isEligibleForMode(player, mode) &&
      baselineKey(player.id) !== activeIdKey
  );
  const textFragments = [
    result.finalRecommendation?.statement,
    result.finalRecommendation?.nextSafeBowler?.reason,
    result.finalRecommendation?.nextSafeBatter?.reason,
    result.finalDecision?.rationale,
    result.finalDecision?.immediateAction,
    ...(result.finalDecision?.suggestedAdjustments || []),
    result.combinedDecision?.rationale,
    result.combinedDecision?.immediateAction,
    ...(result.combinedDecision?.suggestedAdjustments || []),
    result.tactical?.rationale,
    result.tactical?.immediateAction,
    ...(result.tactical?.suggestedAdjustments || []),
    String(toRecord((result as unknown as Record<string, unknown>).output).text || ''),
  ]
    .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    .map((entry) => entry.toLowerCase());
  const textBlob = textFragments.join(' ');
  if (textBlob) {
    const mentionedPlayer = [...modeRoster]
      .sort((a, b) => b.name.length - a.name.length)
      .find((player) => textBlob.includes(player.name.toLowerCase()));
    if (mentionedPlayer) {
      return {
        bowlerId: mentionedPlayer.id,
        bowlerName: mentionedPlayer.name,
        reason: 'Inferred from coach response text.',
      };
    }
  }

  return null;
};

const resolveRosterIdsFromBaselines = (candidateIds: string[], baselines: Baseline[]): string[] => {
  const ordered = orderBaselinesForDisplay(baselines)
    .map((row) => normalizeBaselineRecord(row));
  const activeIdByKey = new Map<string, string>();
  ordered.forEach((row) => {
    const canonicalId = normalizeBaselineId(row.id || row.playerId || row.name);
    const key = baselineKey(canonicalId);
    if (!key || activeIdByKey.has(key)) return;
    activeIdByKey.set(key, canonicalId);
  });

  const seen = new Set<string>();
  const resolved: string[] = [];
  candidateIds.forEach((id) => {
    const key = baselineKey(id);
    if (!key || seen.has(key)) return;
    const canonicalId = activeIdByKey.get(key);
    if (!canonicalId) return;
    seen.add(key);
    resolved.push(canonicalId);
  });

  return resolved.slice(0, MAX_ROSTER);
};

const baselineFromPlayer = (player: Player): Baseline =>
  normalizeBaselineRecord({
    id: normalizeBaselineId(player.id),
    playerId: normalizeBaselineId(player.id),
    name: player.name,
    role: playerRoleToBaselineRole(player.role),
    isActive: player.isActive !== false,
    active: player.isActive !== false,
    inRoster: player.inRoster !== false,
    sleepHoursToday: safeNum(player.sleepHours, 7),
    sleep: safeNum(player.sleepHours, 7),
    recoveryMinutes: safeNum(player.recoveryTime, 45),
    recovery: safeNum(player.recoveryTime, 45),
    fatigueLimit: safeNum(player.baselineFatigue, 6),
    controlBaseline: safeNum(player.controlBaseline, 78),
    control: safeNum(player.controlBaseline, 78),
    speed: safeNum(player.speed, 7),
    power: safeNum(player.power, 6),
    updatedAt: new Date().toISOString(),
  });

const buildRosterPlayersFromBaselines = (
  currentPlayers: Player[],
  baselines: Baseline[],
  rosterIds: string[]
): Player[] => {
  const byName = new Map<string, Player>();
  const byId = new Map<string, Player>();
  currentPlayers.forEach((player) => {
    byName.set(baselineKey(player.name), player);
    byId.set(player.id, player);
  });

  const baselineByKey = new Map<string, Baseline>();
  orderBaselinesForDisplay(baselines)
    .map((baseline) => normalizeBaselineRecord(baseline))
    .forEach((baseline) => {
      const id = normalizeBaselineId(baseline.id || baseline.playerId || baseline.name);
      const key = baselineKey(id);
      if (!key || baselineByKey.has(key)) return;
      baselineByKey.set(key, baseline);
    });

  const resolvedRosterIds = resolveRosterIdsFromBaselines(rosterIds, baselines);
  return resolvedRosterIds
    .map((id) => {
      const baseline = baselineByKey.get(baselineKey(id));
      if (!baseline) return null;
      const baselineId = normalizeBaselineId(baseline.id || baseline.playerId || baseline.name);
      const existing = byId.get(baselineId) || byName.get(baselineKey(baseline.name));

      if (existing) {
        return {
          ...existing,
          id: baselineId,
          baselineId,
          name: baseline.name,
          role: baselineRoleToPlayerRole(baseline.role),
          isSub: false,
          inRoster: true,
          isActive: true,
          baselineFatigue: baseline.fatigueLimit,
          sleepHours: baseline.sleepHoursToday,
          recoveryTime: baseline.recoveryMinutes,
          controlBaseline: baseline.controlBaseline,
          speed: baseline.speed,
          power: baseline.power,
        };
      }

      return {
        id: baselineId,
        baselineId,
        name: baseline.name,
        role: baselineRoleToPlayerRole(baseline.role),
        isSub: false,
        inRoster: true,
        isActive: true,
        overs: 0,
        consecutiveOvers: 0,
        lastRestOvers: 0,
        fatigue: 2.5,
        hrRecovery: 'Good',
        injuryRisk: 'Low',
        noBallRisk: 'Low',
        runs: 0,
        balls: 0,
        boundaryEvents: [],
        dismissalStatus: 'NOT_OUT',
        dismissalType: 'Not Out',
        baselineFatigue: baseline.fatigueLimit,
        sleepHours: baseline.sleepHoursToday,
        recoveryTime: baseline.recoveryMinutes,
        controlBaseline: baseline.controlBaseline,
        speed: baseline.speed,
        power: baseline.power,
        recoveryOffset: 0,
      } satisfies Player;
    })
    .filter((row): row is Player => Boolean(row))
    .map((row) => normalizeDismissalPlayerState(row));
};

const formatMMSS = (s: number): string => {
  const safe = Math.max(0, Math.floor(s));
  return `${String(Math.floor(safe / 60)).padStart(2, '0')}:${String(safe % 60).padStart(2, '0')}`;
};

interface AgentFailureDetail {
  status: number | 'network' | 'timeout' | 'cors';
  url: string;
  message: string;
  hint: string | null;
}

const normalizeApiFailureBody = (body?: string): string | null => {
  if (!body) return null;
  const trimmed = body.trim();
  if (!trimmed) return null;
  if (/^<!doctype html/i.test(trimmed) || /^<html/i.test(trimmed)) {
    return 'API returned HTML instead of JSON (likely SPA fallback intercepting /api routes).';
  }

  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const traceId =
      typeof parsed.traceId === 'string' && parsed.traceId.trim().length > 0
        ? parsed.traceId.trim()
        : null;
    const candidate = [parsed.message, parsed.error, parsed.detail].find(
      (value): value is string => typeof value === 'string' && value.trim().length > 0
    );
    if (candidate) return traceId ? `${candidate.trim()} (traceId: ${traceId})` : candidate.trim();
    if (traceId) return `Request failed (traceId: ${traceId})`;
  } catch {
    // Keep plain-text body fallback.
  }

  return trimmed.replace(/\s+/g, ' ').slice(0, 180);
};

const toAgentFailureDetail = (error: unknown, fallbackUrl: string): AgentFailureDetail => {
  if (error instanceof ApiClientError) {
    const isHealthEndpoint = error.url.includes('/health') || error.url.includes('/api/health');
    const status = error.status ?? (error.kind === 'timeout' ? 'timeout' : error.kind === 'cors' ? 'cors' : 'network');
    let message = normalizeApiFailureBody(error.body) ?? error.message;
    let hint: string | null = null;

    if (error.kind === 'timeout' || error.kind === 'network') {
      message = 'Backend not reachable. Start the API or set VITE_API_BASE_URL.';
      hint = 'Confirm the backend is running and reachable from this frontend.';
    } else if (error.kind === 'cors') {
      message = 'Request blocked (CORS). Check API CORS settings or VITE_API_BASE_URL.';
      hint = 'If API is cross-origin, allow this frontend origin in CORS settings.';
    } else if (error.status === 404 && isHealthEndpoint) {
      message = 'Health endpoint not found (/health). Check proxy/routes.';
      hint = 'Ensure /health (or /api/health) exists and Vite proxy forwards requests to the backend.';
    } else if (typeof error.status === 'number' && error.status >= 500) {
      if (!/traceid:/i.test(message)) {
        message = `Backend error (${error.status}). Check API logs.`;
      }
      hint = 'Server responded with an internal error.';
    }

    return {
      status,
      url: error.url,
      message,
      hint,
    };
  }

  return {
    status: 'network',
    url: fallbackUrl,
    message: 'Backend not reachable. Start the API or set VITE_API_BASE_URL.',
    hint: error instanceof Error ? error.message : 'Request failed before receiving an API response.',
  };
};

const RECOVERY_RATE_BY_HRR: Record<RecoveryLevel, number> = {
  Good: 0.03,
  Moderate: 0.02,
  Poor: 0.01,
};

// --- Main App Component ---

export default function App() {
  const useAgentFramework = String(import.meta.env.VITE_USE_AGENT_FRAMEWORK || '').trim().toLowerCase() === 'true';
  const initialStoredMatchMode = useMemo(() => readStoredMatchMode(), []);
  const [showSplash, setShowSplash] = useState(true);
  const [page, setPage] = useState<Page>('landing');
  const [matchContext, setMatchContext] = useState<MatchContext>({
    matchMode: initialStoredMatchMode ?? 'BOWLING',
    format: 'T20',
    phase: 'Powerplay',
    pitch: 'Medium',
    weather: 'Cool'
  });
  const [matchState, setMatchState] = useState<MatchState>({
    target: 165,
    totalOvers: 20,
    runs: 78,
    ballsBowled: 56,
    wickets: 3
  });
  const [players, setPlayers] = useState<Player[]>([]);
  const [activePlayerId, setActivePlayerId] = useState<string>(() => readStoredActivePlayerId());
  const [agentState, setAgentState] = useState<'idle' | 'thinking' | 'done' | 'offline' | 'invalid'>('idle');
  const [runMode, setRunMode] = useState<RunMode>('auto');
  const [agentWarning, setAgentWarning] = useState<string | null>(null);
  const [agentFailure, setAgentFailure] = useState<AgentFailureDetail | null>(null);
  const [aiAnalysis, setAiAnalysis] = useState<AiAnalysis | null>(null);
  const [riskAnalysis, setRiskAnalysis] = useState<AiAnalysis | null>(null);
  const [tacticalAnalysis, setTacticalAnalysis] = useState<TacticalAgentResponse | null>(null);
  const [strategicAnalysis, setStrategicAnalysis] = useState<OrchestrateResponse['strategicAnalysis'] | null>(null);
  const [combinedAnalysis, setCombinedAnalysis] = useState<OrchestrateResponse['strategicAnalysis'] | null>(null);
  const [combinedDecision, setCombinedDecision] = useState<TacticalCombinedDecision | null>(null);
  const [finalRecommendation, setFinalRecommendation] = useState<FinalRecommendation | null>(null);
  const [orchestrateMeta, setOrchestrateMeta] = useState<OrchestrateMetaView | null>(null);
  const [routerDecision, setRouterDecision] = useState<RouterDecisionView | null>(null);
  const [agentFeedStatus, setAgentFeedStatus] = useState<AgentFeedStatus>(() => getDefaultAgentFeedStatus());
  const [analysisActive, setAnalysisActive] = useState(false);
  const [analysisRequested, setAnalysisRequested] = useState(false);
  const [recoveryMode, setRecoveryMode] = useState<RecoveryMode>('auto');
  const [manualRecovery, setManualRecovery] = useState<RecoveryLevel>('Moderate');
  const [baselineSource, setBaselineSource] = useState<'cosmos' | 'fallback'>('fallback');
  const [baselineWarning, setBaselineWarning] = useState<string | null>(null);
  const [rosterMutationError, setRosterMutationError] = useState<string | null>(null);
  const [workingBaselines, setWorkingBaselines] = useState<Baseline[]>([]);
  const [matchRosterIds, setMatchRosterIds] = useState<string[]>(() => getRosterIds());
  const [isLoadingRosterPlayers, setIsLoadingRosterPlayers] = useState(true);
  const rosterLoadRequestIdRef = useRef(0);
  const rosterInitializedRef = useRef(false);
  const matchRosterIdsRef = useRef<string[]>([]);
  const teamModeLockedRef = useRef(Boolean(initialStoredMatchMode));
  const [isProfileOpen, setIsProfileOpen] = useState(false);
  const fatigueRequestSeq = useRef(0);
  const fatigueAbortRef = useRef<AbortController | null>(null);
  const recoveryIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const previousActivePlayerIdRef = useRef<string | null>(null);
  const baselineCacheRef = useRef<Map<string, Baseline>>(new Map());

  useEffect(() => {
    matchRosterIdsRef.current = matchRosterIds;
  }, [matchRosterIds]);

  useEffect(() => {
    if (teamModeLockedRef.current) return;
    const selected = players.find((player) => player.id === activePlayerId);
    if (!selected) return;
    const inferredMatchMode: MatchContext['matchMode'] = isBowlingRole(selected.role) ? 'BOWLING' : 'BATTING';
    setMatchContext((prev) => (prev.matchMode === inferredMatchMode ? prev : { ...prev, matchMode: inferredMatchMode }));
  }, [players, activePlayerId]);

  useEffect(() => {
    writeStoredMatchMode(matchContext.matchMode);
  }, [matchContext.matchMode]);

  useEffect(() => {
    writeStoredActivePlayerId(activePlayerId);
  }, [activePlayerId]);

  useEffect(() => {
    const applyBaselinesToRoster = (rows: Baseline[], reason: 'mount' | 'event') => {
      const orderedRows = orderBaselinesForDisplay(rows);
      const previousRosterIds = matchRosterIdsRef.current;
      const baseRosterIds = rosterInitializedRef.current
        ? previousRosterIds
        : getRosterIds();
      const resolvedIds = resolveRosterIdsFromBaselines(baseRosterIds, orderedRows);
      const rosterIdSet = new Set(resolvedIds.map((id) => baselineKey(id)));
      const syncedBaselines = orderedRows.map((row) => {
        const normalized = normalizeBaselineRecord(row);
        const normalizedId = normalizeBaselineId(normalized.id || normalized.playerId || normalized.name);
        return normalizeBaselineRecord({
          ...normalized,
          inRoster: rosterIdSet.has(baselineKey(normalizedId)),
        });
      });

      rosterInitializedRef.current = true;
      setMatchRosterIds(resolvedIds);
      setWorkingBaselines(syncedBaselines);
      setPlayers((prev) => {
        const derivedRoster = buildRosterPlayersFromBaselines(prev, syncedBaselines, resolvedIds);
        const hydratedRoster = hydrateDismissalStateFromSession(derivedRoster);
        setActivePlayerId((currentId) => {
          if (hydratedRoster.some((player) => player.id === currentId)) return currentId;
          return hydratedRoster[0]?.id ?? '';
        });
        return hydratedRoster;
      });
      if (import.meta.env.DEV) {
        console.log('[roster-sync] applyBaselinesToRoster', {
          reason,
          baselineCount: syncedBaselines.length,
          rosterBefore: previousRosterIds.length,
          rosterAfter: resolvedIds.length,
        });
      }
    };

    const loadFromBackend = async (reason: 'mount' | 'event') => {
      const requestId = rosterLoadRequestIdRef.current + 1;
      rosterLoadRequestIdRef.current = requestId;
      setIsLoadingRosterPlayers(true);
      if (import.meta.env.DEV) {
        console.log('[roster-sync] fetch start', { requestId, reason });
      }
      try {
        const response = await getBaselinesWithMeta();
        if (requestId !== rosterLoadRequestIdRef.current) {
          if (import.meta.env.DEV) {
            console.log('[roster-sync] stale response ignored', { requestId });
          }
          return;
        }
        const rows = orderBaselinesForDisplay(response.baselines);
        if (import.meta.env.DEV) {
          console.log('[roster-sync] fetch success', {
            requestId,
            reason,
            source: response.source,
            baselineCount: rows.length,
          });
        }
        setBaselineSource(response.source);
        setBaselineWarning(response.warning || null);
        applyBaselinesToRoster(rows, reason);
      } catch (error) {
        if (requestId !== rosterLoadRequestIdRef.current) return;
        if (import.meta.env.DEV) {
          console.warn('[roster-sync] fetch failed', { requestId, error });
        }
        setBaselineSource('fallback');
        setBaselineWarning('Failed to load baseline players from backend.');
      } finally {
        if (requestId === rosterLoadRequestIdRef.current) {
          setIsLoadingRosterPlayers(false);
        }
      }
    };

    const handleLocalEvent = () => {
      void loadFromBackend('event');
    };

    void loadFromBackend('mount');
    window.addEventListener(BASELINES_CHANGED_EVENT, handleLocalEvent);
    return () => {
      window.removeEventListener(BASELINES_CHANGED_EVENT, handleLocalEvent);
    };
  }, []);

  useEffect(() => {
    const next = new Map(baselineCacheRef.current);
    workingBaselines.forEach((row) => {
      const normalized = normalizeBaselineRecord(row);
      const idKey = baselineKey(normalizeBaselineId(normalized.id || normalized.playerId || normalized.name));
      const nameKey = baselineKey(normalized.name);
      if (idKey) next.set(idKey, normalized);
      if (nameKey) next.set(nameKey, normalized);
    });
    baselineCacheRef.current = next;
  }, [workingBaselines]);

  const getBaselineForPlayer = useCallback(async (playerId: string, signal?: AbortSignal): Promise<Baseline | null> => {
    const normalizedId = normalizeBaselineId(playerId);
    if (!normalizedId) return null;
    const cacheKey = baselineKey(normalizedId);
    const cached = baselineCacheRef.current.get(cacheKey);
    if (cached) return cached;

    const local = workingBaselines.find((row) => {
      const rowIdKey = baselineKey(normalizeBaselineId(row.id || row.playerId || row.name));
      const rowNameKey = baselineKey(row.name);
      return rowIdKey === cacheKey || rowNameKey === cacheKey;
    });
    if (local) {
      const normalized = normalizeBaselineRecord(local);
      baselineCacheRef.current.set(cacheKey, normalized);
      baselineCacheRef.current.set(baselineKey(normalized.name), normalized);
      return normalized;
    }

    try {
      const fetched = await getBaselineByPlayerId(normalizedId, signal);
      if (!fetched) return null;
      const normalized = normalizeBaselineRecord(fetched);
      baselineCacheRef.current.set(cacheKey, normalized);
      baselineCacheRef.current.set(baselineKey(normalized.name), normalized);
      return normalized;
    } catch (error) {
      if (import.meta.env.DEV) {
        console.warn('[analysis] baseline lookup failed', { playerId: normalizedId, error });
      }
      return null;
    }
  }, [workingBaselines]);

  const selectedPlayer = players.find((p) => p.id === activePlayerId) ?? null;
  const normalizedPhase = normalizePhase(matchContext.phase);
  const activeDerived = React.useMemo(() => {
    if (!selectedPlayer) return null;
    const workload = sanitizeBowlerWorkload(selectedPlayer, matchContext.format);
    const oversBowled = workload.overs;
    const maxOvers = workload.maxOvers;
    const oversRemaining = workload.oversRemaining;
    const quotaComplete = maxOvers < 999 && oversBowled >= maxOvers;
    const lastRestOvers = workload.lastRestOvers;
    const fatigueLimit = Math.max(0, safeNum(selectedPlayer.baselineFatigue, 6));
    const sleepHrs = Math.max(0, safeNum(selectedPlayer.sleepHours, 7));
    const recoveryMin = Math.max(0, safeNum(selectedPlayer.recoveryTime, 45));
    const isUnfit = Boolean(selectedPlayer.isUnfit);
    const fatigue = isUnfit ? 10 : workload.fatigue;
    const recoveryDisplayed: RecoveryLevel = isUnfit
      ? 'Poor'
      : recoveryMode === 'manual'
        ? manualRecovery
        : (selectedPlayer.hrRecovery || 'Good');
    const computedLoadRatio = computeLoadRatio(fatigue, fatigueLimit);
    const computedStatus = computeStatus(computedLoadRatio);
    const computedInjuryRisk = computeInjuryRisk(fatigue, oversBowled, maxOvers, isUnfit);
    const computedNoBallRisk = computeNoBallRisk(
      fatigue,
      oversBowled,
      maxOvers,
      matchContext.pitch || matchContext.phase,
      isUnfit
    );
    const injuryRisk: 'Low' | 'Medium' | 'High' | 'Critical' = computedInjuryRisk;
    const noBallRisk: 'Low' | 'Medium' | 'High' = computedNoBallRisk;
    const loadRatio = isUnfit ? Math.max(1.1, computeLoadRatio(fatigue, fatigueLimit)) : computedLoadRatio;
    const status: StatusLevel = isUnfit ? 'EXCEEDED LIMIT' : computedStatus;

    return {
      ...selectedPlayer,
      fatigue,
      hrRecovery: recoveryDisplayed,
      injuryRisk,
      noBallRisk,
      loadRatio,
      status,
      recoveryDisplayed,
      oversBowled,
      consecutiveOvers: 0,
      maxOvers,
      oversRemaining,
      quotaComplete,
      lastRestOvers,
      fatigueLimit,
      sleepHrs,
      recoveryMin,
    };
  }, [selectedPlayer, matchContext.format, matchContext.phase, matchContext.pitch, recoveryMode, manualRecovery]);

  const activePlayer = activeDerived;
  const currentTelemetry = React.useMemo(() => {
    if (!activeDerived) return null;
    const injuryLabel = String(activeDerived.injuryRisk || 'Low').toUpperCase();
    const injuryRisk: 'LOW' | 'MEDIUM' | 'HIGH' =
      injuryLabel === 'CRITICAL' || injuryLabel === 'HIGH'
        ? 'HIGH'
        : injuryLabel === 'MED' || injuryLabel === 'MEDIUM'
          ? 'MEDIUM'
          : 'LOW';
    const noBallLabel = String(activeDerived.noBallRisk || 'Low').toUpperCase();
    const noBallRisk: 'LOW' | 'MEDIUM' | 'HIGH' =
      noBallLabel === 'HIGH'
        ? 'HIGH'
        : noBallLabel === 'MED' || noBallLabel === 'MEDIUM'
          ? 'MEDIUM'
          : 'LOW';
    return {
      playerId: activeDerived.id.toUpperCase(),
      playerName: activeDerived.name,
      role: activeDerived.role,
      oversBowled: activeDerived.oversBowled,
      consecutiveOvers: 0,
      oversRemaining: activeDerived.oversRemaining,
      maxOvers: activeDerived.maxOvers,
      quotaComplete: Boolean(activeDerived.quotaComplete),
      fatigueIndex: activeDerived.fatigue,
      strainIndex: Math.max(0, Math.min(10, safeNum(activeDerived.strainIndex, 0))),
      injuryRisk,
      noBallRisk,
      heartRateRecovery: String(activeDerived.hrRecovery || 'Moderate'),
      fatigueLimit: activeDerived.fatigueLimit,
      sleepHours: activeDerived.sleepHrs,
      recoveryMinutes: activeDerived.recoveryMin,
      matchContext: {
        matchMode: matchContext.matchMode,
        format: matchContext.format || 'T20',
        phase: normalizedPhase,
        over: safeNum(Number(formatOverStr(matchState.ballsBowled)), 0),
        intensity: matchContext.pitch || 'Medium',
      },
    };
  }, [activeDerived, normalizedPhase, matchContext, matchState.ballsBowled]);

  const updateMatchState = (
    updates: Partial<MatchState> | ((prev: MatchState) => Partial<MatchState>)
  ) => {
    setMatchState(prev => {
      const patch = typeof updates === 'function' ? updates(prev) : updates;
      const next = { ...prev, ...patch };
      const maxBalls = totalBallsFromOvers(next.totalOvers);
      next.ballsBowled = Math.min(maxBalls, Math.max(0, Math.floor(next.ballsBowled)));
      next.wickets = Math.min(10, Math.max(0, Math.floor(next.wickets)));
      next.runs = Math.max(0, Math.floor(next.runs));
      if (next.target != null) next.target = Math.max(0, Math.floor(next.target));
      return next;
    });
  };

  useEffect(() => {
    setMatchState(prev => {
      const nextTotalOvers = matchContext.format === 'T20'
        ? 20
        : matchContext.format === 'ODI'
          ? 50
          : prev.totalOvers;

      if (nextTotalOvers === prev.totalOvers) return prev;

      const maxBalls = totalBallsFromOvers(nextTotalOvers);
      return {
        ...prev,
        totalOvers: nextTotalOvers,
        ballsBowled: Math.min(prev.ballsBowled, maxBalls),
      };
    });
    setPlayers((prev) =>
      prev.map((player) => ({
        ...player,
        ...sanitizeBowlerWorkload(player, matchContext.format),
      }))
    );
  }, [matchContext.format]);

  useEffect(() => {
    const previousActivePlayerId = previousActivePlayerIdRef.current;
    previousActivePlayerIdRef.current = activePlayerId;
    setPlayers((prev) =>
      prev.map((p) => {
        const workload = sanitizeBowlerWorkload(p, matchContext.format);
        const isPreviousActive = Boolean(previousActivePlayerId && p.id === previousActivePlayerId && p.id !== activePlayerId);
        const nextLastRest = isPreviousActive ? workload.overs : workload.lastRestOvers;
        if (
          !p.isResting &&
          !isPreviousActive &&
          workload.overs === p.overs &&
          p.consecutiveOvers === 0 &&
          nextLastRest === safeNum(p.lastRestOvers, 0) &&
          workload.fatigue === safeNum(p.fatigue, 2.5)
        ) {
          return p;
        }
        return {
          ...p,
          overs: workload.overs,
          lastRestOvers: nextLastRest,
          consecutiveOvers: 0,
          fatigue: workload.fatigue,
          isResting: false,
          restStartMs: undefined,
          restStartFatigue: undefined,
          restElapsedSec: 0,
          recoveryElapsed: 0,
        };
      })
    );
  }, [activePlayerId]);

  // Recovery Simulation Loop
  const hasRestingPlayers = players.some((p) => p.isResting);
  useEffect(() => {
    if (!hasRestingPlayers) {
      if (recoveryIntervalRef.current) {
        clearInterval(recoveryIntervalRef.current);
        recoveryIntervalRef.current = null;
      }
      return;
    }
    if (recoveryIntervalRef.current) return;

    recoveryIntervalRef.current = setInterval(() => {
      setPlayers((prev) =>
        prev.map((p) => {
          if (!p.isResting) return p;

          const workload = sanitizeBowlerWorkload(p, matchContext.format);
          const recoveryLevel =
            p.id === activePlayerId && recoveryMode === 'manual'
              ? manualRecovery
              : (p.hrRecovery || 'Good');
          const recoveryRate = RECOVERY_RATE_BY_HRR[recoveryLevel];

          const startMs = p.restStartMs ?? Date.now();
          const nextElapsedSeconds = Math.max(0, Math.floor((Date.now() - startMs) / 1000));
          const nextFatigue = clamp(workload.fatigue - recoveryRate, 0, 10);

          return {
            ...p,
            overs: workload.overs,
            lastRestOvers: workload.lastRestOvers,
            consecutiveOvers: workload.consecutiveOvers,
            fatigue: nextFatigue,
            restElapsedSec: nextElapsedSeconds,
            recoveryElapsed: nextElapsedSeconds / 60,
          };
        })
      );
    }, 1000);

    return () => {
      if (recoveryIntervalRef.current) {
        clearInterval(recoveryIntervalRef.current);
        recoveryIntervalRef.current = null;
      }
    };
  }, [hasRestingPlayers, activePlayerId, recoveryMode, manualRecovery, matchContext.format]);

  const updatePlayer = (
    id: string,
    updates: Partial<Player> | ((player: Player) => Partial<Player>)
  ) => {
    setPlayers(prev => prev.map(p => {
      if (p.id !== id) return p;

      const patch = typeof updates === 'function' ? updates(p) : updates;
      let updated = { ...p, ...patch };

      if (!('agentFatigueOverride' in patch) && !('agentRiskOverride' in patch)) {
        updated.agentFatigueOverride = undefined;
        updated.agentRiskOverride = undefined;
      }

      updated = {
        ...updated,
        ...sanitizeBowlerWorkload(updated, matchContext.format),
      };

      return normalizeDismissalPlayerState(updated);
    }));
  };

  const movePlayerToSub = (playerId: string) => {
    // "Remove from Active Squad" follows the same local-session roster removal path.
    deleteRosterPlayer(playerId);
  };

  const applyRosterIdsToState = useCallback((nextIdsInput: string[], reason: string): string[] => {
    const idSet = new Set(nextIdsInput.map((id) => baselineKey(id)));
    const orderedBaselines = orderBaselinesForDisplay(workingBaselines);
    const nextBaselines = orderedBaselines.map((baseline) => {
      const baselineId = normalizeBaselineId(baseline.id || baseline.playerId || baseline.name);
      return normalizeBaselineRecord({
        ...baseline,
        inRoster: idSet.has(baselineKey(baselineId)),
      });
    });
    const previousIds = matchRosterIdsRef.current;
    const resolvedIds = resolveRosterIdsFromBaselines(nextIdsInput, nextBaselines);
    rosterInitializedRef.current = true;
    setWorkingBaselines(nextBaselines);
    setMatchRosterIds(resolvedIds);
    setPlayers((prevPlayers) => {
      const derivedRoster = buildRosterPlayersFromBaselines(prevPlayers, nextBaselines, resolvedIds);
      const hydratedRoster = hydrateDismissalStateFromSession(derivedRoster);
      setActivePlayerId((currentId) => {
        if (hydratedRoster.some((player) => player.id === currentId)) return currentId;
        return hydratedRoster[0]?.id ?? '';
      });
      return hydratedRoster;
    });
    if (import.meta.env.DEV) {
      console.log('[roster-sync] applyMatchRosterIds', {
        reason,
        rosterBefore: previousIds.length,
        rosterAfter: resolvedIds.length,
      });
      console.log('[DASHBOARD ROSTER BUILD]', { reason, ids: resolvedIds });
    }
    setRosterMutationError(null);
    return resolvedIds;
  }, [workingBaselines]);

  const applyMatchRosterIds = useCallback((nextIdsInput: string[]): string[] => {
    const resolvedIds = applyRosterIdsToState(nextIdsInput, 'explicit_user_action');
    setRosterIds(resolvedIds);
    return resolvedIds;
  }, [applyRosterIdsToState]);

  const deleteRosterPlayer = (rosterPlayerId: string) => {
    const normalizedId = normalizeBaselineId(rosterPlayerId);
    if (!normalizedId) {
      setRosterMutationError('Cannot remove player: missing baseline id.');
      return;
    }
    const normalizedKey = baselineKey(normalizedId);
    if (!normalizedKey) {
      setRosterMutationError('Cannot remove player: invalid baseline id.');
      return;
    }

    const previousActiveId = activePlayerId;
    const removedWasSelected = baselineKey(previousActiveId) === baselineKey(normalizedId);
    const previousRosterIds = matchRosterIdsRef.current;
    if (import.meta.env.DEV) {
      console.log('[roster-delete] click', {
        id: normalizedId,
        rosterBefore: previousRosterIds.length,
      });
    }
    const removedRosterIndex = previousRosterIds.findIndex((id) => baselineKey(id) === normalizedKey);
    const nextIds = removeFromRosterSession(normalizedId, previousRosterIds);
    const nextResolvedIds = applyRosterIdsToState(nextIds, 'roster_remove');
    const nextKeys = nextIds.map((id) => baselineKey(id));
    const resolvedKeys = nextResolvedIds.map((id) => baselineKey(id));
    if (
      nextKeys.length !== resolvedKeys.length ||
      nextKeys.some((key, index) => key !== resolvedKeys[index])
    ) {
      setRosterIds(nextResolvedIds);
    }
    if (import.meta.env.DEV) {
      console.log('[roster-delete] optimistic applied', {
        id: normalizedId,
        rosterAfter: nextResolvedIds.length,
      });
    }
    setActivePlayerId((currentId) => {
      if (!removedWasSelected) return currentId;
      if (nextResolvedIds.length === 0) return '';
      const replacementIndex =
        removedRosterIndex >= 0 && removedRosterIndex < nextResolvedIds.length
          ? removedRosterIndex
          : nextResolvedIds.length - 1;
      return nextResolvedIds[replacementIndex] ?? '';
    });
    setRosterMutationError(null);
    clearDismissalStatusForPlayer(normalizedId);
  };

  useEffect(() => {
    const syncRosterFromLocalStorage = () => {
      const storedIds = getRosterIds();
      const currentIds = matchRosterIdsRef.current;
      const currentKeys = currentIds.map((id) => baselineKey(id));
      const storedKeys = storedIds.map((id) => baselineKey(id));
      if (
        currentKeys.length === storedKeys.length &&
        currentKeys.every((key, index) => key === storedKeys[index])
      ) {
        return;
      }
      applyMatchRosterIds(storedIds);
    };

    const handleStorage = (event: StorageEvent) => {
      if (event.key && event.key !== ROSTER_STORAGE_KEY) return;
      syncRosterFromLocalStorage();
    };

    window.addEventListener('storage', handleStorage);
    window.addEventListener('focus', syncRosterFromLocalStorage);
    return () => {
      window.removeEventListener('storage', handleStorage);
      window.removeEventListener('focus', syncRosterFromLocalStorage);
    };
  }, [applyMatchRosterIds]);

  const handleAddOver = () => {
    if (!activePlayer) return;
    if ((activePlayer.injuryRisk === 'High' || activePlayer.injuryRisk === 'Critical') || activePlayer.isSub || activePlayer.isUnfit) return;
    const cap = getMaxOvers(matchContext.format);
    const intensityMultiplier = fatigueIntensityMultiplier(matchContext.pitch || 'Medium');
    updatePlayer(activePlayer.id, (p) => {
      const workload = sanitizeBowlerWorkload(p, matchContext.format);
      if (workload.overs >= cap) return {};
      return {
        overs: workload.overs + 1,
        fatigue: clamp(workload.fatigue + 0.9 * intensityMultiplier, 0, 10),
        isResting: false,
      };
    });
  };

  const handleDecreaseOver = () => {
    if (!activePlayer) return;
    const intensityMultiplier = fatigueIntensityMultiplier(matchContext.pitch || 'Medium');
    updatePlayer(activePlayer.id, (p) => ({
      overs: Math.max(0, p.overs - 1),
      fatigue: clamp(safeNum(p.fatigue, 2.5) - 0.9 * intensityMultiplier, 0, 10),
    }));
  };

  const handleRest = () => {
    if (!activePlayer) return;
    if (activePlayer.isUnfit) return;
    // Rest toggles timer-driven recovery and snapshots current overs for workload bookkeeping.
    updatePlayer(
      activePlayer.id,
      (p) => {
        const workload = sanitizeBowlerWorkload(p, matchContext.format);
        const nextResting = !p.isResting;
        const elapsed = p.restElapsedSec || 0;
        const nextStartMs = nextResting ? Date.now() - elapsed * 1000 : undefined;
        return {
          lastRestOvers: nextResting ? workload.overs : p.lastRestOvers,
          isResting: nextResting,
          restStartMs: nextStartMs,
          restStartFatigue: p.restStartFatigue,
          restElapsedSec: elapsed,
          recoveryElapsed: elapsed / 60,
          isManuallyUnfit: nextResting ? false : p.isManuallyUnfit,
          isInjured: nextResting ? false : p.isInjured,
        };
      }
    );
  };

  const handleMarkUnfit = () => {
    if (!activePlayerId) return;
    setPlayers((prev) =>
      prev.map((p) => {
        if (p.id !== activePlayerId) return p;
        const workload = sanitizeBowlerWorkload(p, matchContext.format);

        if (!p.isUnfit) {
          const recoveryOffset = Math.max(0, safeNum(p.recoveryOffset, 0));
          return {
            ...p,
            _previousState: p._previousState ?? {
              fatigue: Math.max(0, safeNum(p.fatigue, 0)),
              hrRecovery: p.hrRecovery,
              injuryRisk: p.injuryRisk,
              noBallRisk: p.noBallRisk,
              overs: workload.overs,
              consecutiveOvers: workload.consecutiveOvers,
              lastRestOvers: workload.lastRestOvers,
              recoveryOffset,
              isResting: Boolean(p.isResting),
              restElapsedSec: Math.max(0, safeNum(p.restElapsedSec, 0)),
              recoveryElapsed: Math.max(0, safeNum(p.recoveryElapsed, 0)),
              isInjured: Boolean(p.isInjured),
              isManuallyUnfit: Boolean(p.isManuallyUnfit),
            },
            isUnfit: true,
            isManuallyUnfit: true,
            isInjured: true,
            overs: workload.overs,
            consecutiveOvers: workload.consecutiveOvers,
            lastRestOvers: workload.lastRestOvers,
            fatigue: 10,
            hrRecovery: 'Poor',
            injuryRisk: 'Critical',
            noBallRisk: 'High',
            isResting: false,
            restStartMs: undefined,
          };
        }

        const backup = p._previousState;
        if (backup) {
          const normalizedBackup = sanitizeBowlerWorkload(
            {
              ...p,
              overs: backup.overs,
              consecutiveOvers: backup.consecutiveOvers,
              lastRestOvers: backup.lastRestOvers,
              fatigue: backup.fatigue,
            },
            matchContext.format
          );
          return {
            ...p,
            isUnfit: false,
            _previousState: undefined,
            isManuallyUnfit: backup.isManuallyUnfit,
            isInjured: backup.isInjured,
            overs: normalizedBackup.overs,
            consecutiveOvers: normalizedBackup.consecutiveOvers,
            lastRestOvers: normalizedBackup.lastRestOvers,
            recoveryOffset: backup.recoveryOffset,
            fatigue: normalizedBackup.fatigue,
            hrRecovery: backup.hrRecovery,
            injuryRisk: backup.injuryRisk,
            noBallRisk: backup.noBallRisk,
            isResting: backup.isResting,
            restElapsedSec: backup.restElapsedSec,
            recoveryElapsed: backup.recoveryElapsed,
            restStartMs: backup.isResting ? Date.now() - backup.restElapsedSec * 1000 : undefined,
          };
        }

        return {
          ...p,
          isUnfit: false,
          _previousState: undefined,
          isManuallyUnfit: false,
          isInjured: false,
          overs: workload.overs,
          consecutiveOvers: workload.consecutiveOvers,
          lastRestOvers: workload.lastRestOvers,
        };
      })
    );
  };

  const buildAiAnalysis = (
    result: FatigueAgentResponse | RiskAgentResponse,
    agentType: 'fatigue' | 'risk'
  ): AiAnalysis | null => {
    const fatigueIndex = safeNum(result.echo?.fatigueIndex, NaN);
    const riskScore = safeNum((result as RiskAgentResponse).riskScore, NaN);
    const normalizeShortRisk = (value: unknown): 'LOW' | 'MED' | 'HIGH' => {
      const upper = String(value || '').toUpperCase();
      if (upper === 'HIGH') return 'HIGH';
      if (upper === 'MED' || upper === 'MEDIUM') return 'MED';
      return 'LOW';
    };
    const risk = normalizeShortRisk(result.echo?.injuryRisk);
    const noBallRisk = normalizeShortRisk(result.echo?.noBallRisk);
    const validSeverity =
      result.severity === 'LOW' ||
      result.severity === 'MED' ||
      result.severity === 'HIGH' ||
      result.severity === 'CRITICAL';
    const validSignals = Array.isArray(result.signals) && result.signals.every((s) => typeof s === 'string');
    const validExplanation = typeof result.explanation === 'string' && result.explanation.trim().length > 0;
    const validHeadline = typeof result.headline === 'string' && result.headline.trim().length > 0;
    const validRecommendation = typeof result.recommendation === 'string' && result.recommendation.trim().length > 0;
    if (!validSeverity || !validSignals || !validExplanation || !validHeadline || !validRecommendation) {
      return null;
    }
    if (agentType === 'fatigue' && !Number.isFinite(fatigueIndex)) {
      return null;
    }
    if (agentType === 'risk' && !Number.isFinite(riskScore)) {
      return null;
    }

    return {
      playerId: String(result.echo?.playerId || ''),
      fatigueIndex: Number.isFinite(fatigueIndex) ? fatigueIndex : undefined,
      riskScore: Number.isFinite(riskScore) ? riskScore : undefined,
      injuryRisk: risk,
      noBallRisk,
      severity: result.severity,
      signals: result.signals,
      explanation: result.explanation.trim(),
      headline: result.headline.trim(),
      recommendation: result.recommendation.trim(),
    };
  };

  const runAgent = async (
    mode: 'auto' | 'full' = 'auto',
    reason: 'button_click' | 'non_button' = 'non_button',
    options?: {
      teamMode?: TeamMode;
      focusRole?: 'BOWLER' | 'BATTER';
      strainIndex?: number;
    }
  ): Promise<RunCoachAgentResult | null> => {
    const orchestrateRequestUrl =
      mode === 'full' ? apiFullAnalysisUrl : useAgentFramework ? apiAgentFrameworkMessagesUrl : apiOrchestrateUrl;
    const frameworkMode = mode === 'full' ? 'all' : 'route';

    if (reason !== 'button_click') {
      if (import.meta.env.DEV) {
        console.warn('Coach analysis blocked', { reason });
      }
      return null;
    }
    if (import.meta.env.DEV) {
      console.log('Coach analysis triggered', { reason: 'button_click' });
    }
    setRunMode(mode);
    if (agentState === 'thinking') return null;
    if (!currentTelemetry) {
      setAgentWarning(null);
      setAgentFailure({
        status: 'network',
        url: orchestrateRequestUrl,
        message: 'No active player telemetry available for analysis.',
        hint: null,
      });
      setAgentState('invalid');
      setAnalysisActive(false);
      return null;
    }
    setAnalysisRequested(true);
    setAnalysisActive(false);

    fatigueAbortRef.current?.abort();
    const controller = new AbortController();
    fatigueAbortRef.current = controller;
    const requestId = ++fatigueRequestSeq.current;

    setAiAnalysis(null);
    setRiskAnalysis(null);
    setTacticalAnalysis(null);
    setStrategicAnalysis(null);
    setCombinedAnalysis(null);
    setCombinedDecision(null);
    setFinalRecommendation(null);
    setOrchestrateMeta(null);
    setRouterDecision(null);
    setAgentFeedStatus({ fatigue: 'RUNNING', risk: 'RUNNING', tactical: 'RUNNING' });
    setAgentWarning(null);
    setAgentFailure(null);
    setAgentState('thinking');

    const requestMode: 'auto' | 'full' = mode === 'full' ? 'full' : 'auto';
    const maxOvers = Math.max(1, safeNum(currentTelemetry.maxOvers, getMaxOvers(matchContext.format)));
    const oversBowled = clampOversBowled(safeNum(currentTelemetry.oversBowled, 0), maxOvers);
    const oversRemaining = computeOversRemaining(oversBowled, maxOvers);
    const quotaComplete = Boolean(currentTelemetry.quotaComplete) || (maxOvers < 999 && oversBowled >= maxOvers);
    const fatigue = Math.max(0, Math.min(10, safeNum(currentTelemetry.fatigueIndex, 0)));
    const injuryLabelRaw = String(currentTelemetry.injuryRisk || 'LOW').toUpperCase();
    const noBallRiskLabelRaw = String(currentTelemetry.noBallRisk || 'LOW').toUpperCase();
    const injuryLabel =
      injuryLabelRaw === 'CRITICAL' || injuryLabelRaw === 'HIGH'
        ? 'HIGH'
        : injuryLabelRaw === 'MED' || injuryLabelRaw === 'MEDIUM'
          ? 'MEDIUM'
          : 'LOW';
    const noBallRiskLabel =
      noBallRiskLabelRaw === 'HIGH' ? 'HIGH' : noBallRiskLabelRaw === 'MED' || noBallRiskLabelRaw === 'MEDIUM' ? 'MEDIUM' : 'LOW';
    const isUnfit = Boolean(activePlayer?.isUnfit);
    const injury = isUnfit || injuryLabel === 'HIGH' || injuryLabel === 'CRITICAL';
    const noBallRisk: 'LOW' | 'MEDIUM' | 'HIGH' = noBallRiskLabel === 'HIGH' ? 'HIGH' : noBallRiskLabel === 'LOW' ? 'LOW' : 'MEDIUM';
    const teamMode = options?.teamMode || matchContext.matchMode;
    const focusRole = options?.focusRole || deriveFocusRoleFromPlayer(activePlayer, teamMode);
    const strainIndex = Math.max(
      0,
      Math.min(10, safeNum(options?.strainIndex, safeNum(currentTelemetry.strainIndex, safeNum(activePlayer?.strainIndex, 0))))
    );
    const totalBalls = totalBallsFromOvers(matchState.totalOvers);
    const ballsBowled = Math.min(totalBalls, Math.max(0, matchState.ballsBowled));
    const ballsRemaining = Math.max(0, totalBalls - ballsBowled);
    const oversFaced = ballsBowled > 0 ? ballsBowled / 6 : 0;
    const currentRunRate = oversFaced > 0 ? matchState.runs / oversFaced : 0;
    const wicketsInHand = Math.max(0, 10 - matchState.wickets);
    const inningsOversRemaining = Number((ballsRemaining / 6).toFixed(1));
    const requiredRunRate =
      typeof matchState.target === 'number' && matchState.target > 0 && ballsRemaining > 0
        ? Math.max(0, (matchState.target - matchState.runs) / (ballsRemaining / 6))
        : currentRunRate;
    const batsmen = players.filter((p) => {
      if (p.role !== 'Batsman') return false;
      if (p.inRoster === false) return false;
      return resolveDismissalStatus(p) !== 'OUT';
    });
    const bench = players
      .filter((p) => {
        if (p.id === activePlayer?.id) return false;
        if (p.inRoster === false) return false;
        if (resolveDismissalStatus(p) === 'OUT') return false;
        const workload = sanitizeBowlerWorkload(p, matchContext.format);
        return workload.oversRemaining > 0;
      })
      .map((p) => p.name);
    const localSelectedBaseline = activePlayer ? baselineFromPlayer(activePlayer) : null;
    const selectedPlayerBaseline =
      await getBaselineForPlayer(activePlayer?.id || currentTelemetry.playerId, controller.signal) || localSelectedBaseline;
    const baselineSleepHours = selectedPlayerBaseline
      ? safeNum(selectedPlayerBaseline.sleepHoursToday ?? selectedPlayerBaseline.sleep, safeNum(currentTelemetry.sleepHours, 7))
      : safeNum(currentTelemetry.sleepHours, 7);
    const baselineRecoveryMinutes = selectedPlayerBaseline
      ? safeNum(selectedPlayerBaseline.recoveryMinutes ?? selectedPlayerBaseline.recovery, safeNum(currentTelemetry.recoveryMinutes, 45))
      : safeNum(currentTelemetry.recoveryMinutes, 45);
    const baselineFatigueLimit = selectedPlayerBaseline
      ? safeNum(selectedPlayerBaseline.fatigueLimit, safeNum(currentTelemetry.fatigueLimit, 6))
      : safeNum(currentTelemetry.fatigueLimit, 6);
    const baselineControl = selectedPlayerBaseline
      ? safeNum(selectedPlayerBaseline.controlBaseline ?? selectedPlayerBaseline.control, safeNum(activePlayer?.controlBaseline, 78))
      : safeNum(activePlayer?.controlBaseline, 78);
    const baselineSpeed = selectedPlayerBaseline
      ? safeNum(selectedPlayerBaseline.speed, safeNum(activePlayer?.speed, 7))
      : safeNum(activePlayer?.speed, 7);
    const baselinePower = selectedPlayerBaseline
      ? safeNum(selectedPlayerBaseline.power, safeNum(activePlayer?.power, 6))
      : safeNum(activePlayer?.power, 6);
    const baselineSummaryText = selectedPlayerBaseline
      ? `baseline sleep ${baselineSleepHours.toFixed(1)}h, recovery ${Math.round(baselineRecoveryMinutes)}m, fatigue limit ${baselineFatigueLimit.toFixed(1)}.`
      : 'baseline not available, using live telemetry only.';
    const text = `${currentTelemetry.playerName} overs ${oversBowled}/${maxOvers} (remaining ${oversRemaining}), fatigue ${fatigue.toFixed(1)}/10, strain ${strainIndex.toFixed(1)}/10, injury risk ${injuryLabel}, no-ball risk ${noBallRiskLabel}, ${quotaComplete ? 'quota completed for format' : 'quota available'}, ${isUnfit ? 'marked unfit' : 'currently fit'}, ${baselineSummaryText}`;
    const baselinesForContext = (() => {
      if (!selectedPlayerBaseline) return workingBaselines;
      const normalized = normalizeBaselineRecord(selectedPlayerBaseline);
      const selectedKey = baselineKey(normalizeBaselineId(normalized.id || normalized.playerId || normalized.name));
      let found = false;
      const merged = workingBaselines.map((row) => {
        const rowKey = baselineKey(normalizeBaselineId(row.id || row.playerId || row.name));
        if (rowKey !== selectedKey) return row;
        found = true;
        return normalizeBaselineRecord({
          ...row,
          ...normalized,
          id: normalizeBaselineId(normalized.id || normalized.playerId || normalized.name),
          playerId: normalizeBaselineId(normalized.playerId || normalized.id || normalized.name),
        });
      });
      return found ? merged : [...merged, normalized];
    })();
    const fullMatchContext = buildMatchContext({
      matchContext,
      matchState,
      players,
      baselines: baselinesForContext,
      activePlayerId: activePlayer?.id,
      autoRouting: mode === 'auto',
    });
    const contextSummary = summarizeMatchContext(fullMatchContext);
    if (contextSummary.rosterCount <= 0) {
      setAgentFeedStatus(getDefaultAgentFeedStatus());
      setAgentWarning(null);
      setAgentFailure({
        status: 'network',
        url: orchestrateRequestUrl,
        message: 'Cannot run analysis: roster is empty in FullMatchContext.',
        hint: 'Add players to roster and try again.',
      });
      setAgentState('invalid');
      setAnalysisActive(false);
      return null;
    }
    const payload = {
      context: fullMatchContext,
      teamMode,
      focusRole,
      userAction: 'RUN_COACH',
      text,
      mode: requestMode,
      signals: {
        injury,
        isUnfit,
        fatigue,
        strainIndex,
        noBallRisk,
        oversBowled,
        oversRemaining,
        maxOvers,
        quotaComplete,
        baselineAvailable: Boolean(selectedPlayerBaseline),
        baselineSleepHours: baselineSleepHours,
        baselineRecoveryMinutes: baselineRecoveryMinutes,
        baselineFatigueLimit: baselineFatigueLimit,
        intensity: matchContext.pitch || 'Medium',
      },
      telemetry: {
        playerId: currentTelemetry.playerId,
        playerName: currentTelemetry.playerName,
        role: currentTelemetry.role,
        fatigueIndex: fatigue,
        strainIndex,
        heartRateRecovery: currentTelemetry.heartRateRecovery,
        oversBowled,
        oversRemaining,
        maxOvers,
        quotaComplete,
        consecutiveOvers: 0,
        injuryRisk: injuryLabel,
        noBallRisk,
        fatigueLimit: baselineFatigueLimit,
        sleepHours: baselineSleepHours,
        recoveryMinutes: baselineRecoveryMinutes,
        isUnfit,
      },
      baseline: selectedPlayerBaseline
        ? {
            playerId: normalizeBaselineId(selectedPlayerBaseline.playerId || selectedPlayerBaseline.id || selectedPlayerBaseline.name),
            name: selectedPlayerBaseline.name,
            role: selectedPlayerBaseline.role,
            sleepHours: baselineSleepHours,
            recoveryMinutes: baselineRecoveryMinutes,
            fatigueLimit: baselineFatigueLimit,
            control: baselineControl,
            speed: baselineSpeed,
            power: baselinePower,
          }
        : null,
      matchContext: {
        teamMode,
        matchMode: matchContext.matchMode,
        format: matchContext.format,
        matchFormat: matchContext.format,
        phase: normalizedPhase,
        requiredRunRate: Number(requiredRunRate.toFixed(2)),
        currentRunRate: Number(currentRunRate.toFixed(2)),
        wicketsInHand,
        oversRemaining: inningsOversRemaining,
        over: safeNum(Number(formatOverStr(matchState.ballsBowled)), 0),
        overs: Number((ballsBowled / 6).toFixed(1)),
        ballsBowled,
        intensity: matchContext.pitch || currentTelemetry.matchContext.intensity,
        weather: matchContext.weather,
        conditions: matchContext.weather,
        target: typeof matchState.target === 'number' ? matchState.target : undefined,
        targetRuns: typeof matchState.target === 'number' ? matchState.target : undefined,
        score: matchState.runs,
        scoreRuns: matchState.runs,
        wickets: matchState.wickets,
        balls: ballsRemaining,
        ballsRemaining,
      },
      players: {
        striker: batsmen[0]?.name || 'Striker',
        nonStriker: batsmen[1]?.name || batsmen[0]?.name || 'Non-striker',
        bowler: currentTelemetry.playerName,
        bench,
        ...(selectedPlayerBaseline ? { selectedBaseline: selectedPlayerBaseline } : {}),
      },
    };
    if (import.meta.env.DEV) {
      console.log('[agent] calling', orchestrateRequestUrl, { useAgentFramework, mode: frameworkMode });
      console.log('[orchestrate] contextSummary', contextSummary);
      if (String(import.meta.env.VITE_DEBUG_CONTEXT || '').trim().toLowerCase() === 'true') {
        console.log('[orchestrate] fullContext', fullMatchContext);
      }
    }

    const logCoachAnalysisFailure = (
      tag: 'COACH_ANALYSIS_ROUTER_FAILED' | 'COACH_ANALYSIS_AGENT_FAILED',
      error: unknown,
      url: string
    ) => {
      if (!import.meta.env.DEV) return;
      if (error instanceof ApiClientError) {
        const responsePreview = typeof error.body === 'string'
          ? error.body.replace(/\s+/g, ' ').slice(0, 200)
          : '';
        console.error(tag, {
          url,
          status: error.status ?? error.kind,
          message: error.message,
          responsePreview,
        });
        return;
      }
      console.error(tag, {
        url,
        status: 'unknown',
        message: error instanceof Error ? error.message : String(error),
      });
    };

    const applyCoachResult = (
      result: OrchestrateResponse,
      options?: { extraWarning?: string }
    ): RunCoachAgentResult => {
      const fatigueMapped = result.fatigue ? buildAiAnalysis(result.fatigue, 'fatigue') : null;
      const riskMapped = result.risk ? buildAiAnalysis(result.risk, 'risk') : null;
      const tacticalMapped = result.tactical || null;

      setAiAnalysis(fatigueMapped);
      setRiskAnalysis(riskMapped);
      setTacticalAnalysis(tacticalMapped);
      setStrategicAnalysis(mode === 'auto' ? (result.strategicAnalysis || null) : null);
      setCombinedAnalysis(mode === 'full' ? (result.strategicAnalysis || null) : null);
      setCombinedDecision((result.finalDecision || result.combinedDecision) || null);
      setFinalRecommendation(result.finalRecommendation || null);
      setOrchestrateMeta({
        mode: result.meta.mode,
        executedAgents: result.meta.executedAgents,
        usedFallbackAgents: result.meta.usedFallbackAgents || [],
        routerFallbackMessage: typeof result.meta.routerFallbackMessage === 'string' ? result.meta.routerFallbackMessage : undefined,
        traceId: result.traceId || result.responseHeaders?.traceId,
        source: result.source || result.responseHeaders?.source,
        azureRequestId: result.azureRequestId,
        timingsMs: result.timingsMs,
        agentStatuses: {
          fatigue: result.agents?.fatigue?.status,
          risk: result.agents?.risk?.status,
          tactical: result.agents?.tactical?.status,
        },
      });
      setRouterDecision(mode === 'auto' ? (result.routerDecision || null) : null);

      const selectedAgentSet = new Set<AgentKey>(mode === 'full' ? AGENT_KEYS : []);
      if (mode === 'auto') {
        if (Array.isArray(result.routerDecision?.selectedAgents)) {
          result.routerDecision.selectedAgents.forEach((agent) => {
            const key = toAgentKey(agent);
            if (key) selectedAgentSet.add(key);
          });
        }
        if (Array.isArray(result.routerDecision?.agentsToRun)) {
          result.routerDecision.agentsToRun.forEach((agent) => {
            const key = toAgentKey(agent);
            if (key) selectedAgentSet.add(key);
          });
        }
      }
      if (Array.isArray(result.meta.executedAgents)) {
        result.meta.executedAgents.forEach((agent) => {
          const key = toAgentKey(agent);
          if (key) selectedAgentSet.add(key);
        });
      }
      if (selectedAgentSet.size === 0) {
        selectedAgentSet.add('tactical');
      }
      selectedAgentSet.add('tactical');

      const outputRecord = toRecord((result as unknown as Record<string, unknown>).outputs);
      const hasAgentOutput = (agent: AgentKey): boolean => {
        const mappedOutput =
          agent === 'fatigue'
            ? Boolean(fatigueMapped || result.fatigue)
            : agent === 'risk'
              ? Boolean(riskMapped || result.risk)
              : Boolean(tacticalMapped || result.tactical);
        if (mappedOutput) return true;
        const output = toRecord(outputRecord[agent]);
        if (output.ok === true) return true;
        const data = toRecord(output.data);
        return Object.keys(data).length > 0;
      };
      const normalizeAgentStatusToken = (value: unknown): string => String(value || '').trim().toUpperCase();
      const deriveFeedStatus = (agent: AgentKey): AgentFeedState => {
        if (!selectedAgentSet.has(agent)) return 'SKIPPED';
        const serverStatus = normalizeAgentStatusToken(result.agents?.[agent]?.status);
        const errored = result.errors.some((entry) => entry.agent === agent);
        if (hasAgentOutput(agent) || serverStatus === 'OK' || serverStatus === 'FALLBACK' || serverStatus === 'SUCCESS') {
          return 'SUCCESS';
        }
        if (errored || serverStatus === 'ERROR') return 'ERROR';
        return 'ERROR';
      };
      setAgentFeedStatus({
        fatigue: deriveFeedStatus('fatigue'),
        risk: deriveFeedStatus('risk'),
        tactical: deriveFeedStatus('tactical'),
      });

      const visibleErrors = result.errors.filter((e) => !(e.agent === 'tactical' && tacticalMapped));
      const fallbackNotice = typeof result.meta.routerFallbackMessage === 'string' ? result.meta.routerFallbackMessage : null;
      const errorNotice = visibleErrors.length > 0 ? visibleErrors.map((e) => `${e.agent}: ${e.message}`).join(' | ') : null;
      const responseWarnings = Array.isArray(result.warnings)
        ? result.warnings.map((entry) => String(entry || '').trim()).filter(Boolean).join(' | ')
        : null;
      const warning = [fallbackNotice, responseWarnings, errorNotice, options?.extraWarning].filter(Boolean).join(' | ') || null;
      const hasAnyAgentOutput =
        hasAgentOutput('fatigue') || hasAgentOutput('risk') || hasAgentOutput('tactical');
      setAgentWarning(warning);
      setAgentFailure(null);
      setAgentState(result.errors.length > 0 && !hasAnyAgentOutput ? 'offline' : 'done');
      setAnalysisActive(Boolean(hasAnyAgentOutput || result.strategicAnalysis || result.combinedDecision));
      return {
        response: result,
        suggestedBowler: normalizeSuggestedBowler(result, players, activePlayer?.id, teamMode),
      };
    };

    const buildAutoTacticalFallbackResponse = (
      tactical: TacticalAgentResponse,
      fallbackMessage: string
    ): OrchestrateResponse => {
      const immediateAction = String(tactical.immediateAction || 'Apply tactical control and reassess after one over.');
      const rationale = String(tactical.rationale || fallbackMessage);
      const tacticalAdjustments = Array.isArray(tactical.suggestedAdjustments)
        ? tactical.suggestedAdjustments.map((entry) => String(entry)).filter(Boolean)
        : [];
      const alternatives = tacticalAdjustments.length > 0
        ? tacticalAdjustments.slice(0, 3)
        : ['Re-run analysis once router connectivity stabilizes.'];
      const signals = Array.isArray(tactical.keySignalsUsed)
        ? tactical.keySignalsUsed.map((entry) => String(entry)).filter(Boolean).slice(0, 7)
        : [];
      const combinedDecision: TacticalCombinedDecision = {
        immediateAction,
        ...(tactical.substitutionAdvice
          ? { substitutionAdvice: tactical.substitutionAdvice }
          : {}),
        suggestedAdjustments: [
          ...tacticalAdjustments,
          'Some signals unavailable; showing best available guidance.',
        ].slice(0, 4),
        confidence: Number.isFinite(Number(tactical.confidence)) ? Number(tactical.confidence) : 0.62,
        rationale,
      };

      return {
        tactical,
        strategicAnalysis: {
          signals,
          fatigueAnalysis: 'Fatigue analysis unavailable in this run. Re-run for full workload diagnostics.',
          injuryRiskAnalysis: 'Risk analysis unavailable in this run. Tactical guidance is based on best available context.',
          tacticalRecommendation: {
            nextAction: immediateAction,
            why: rationale,
            ifIgnored: tacticalAdjustments[0] || 'Execution risk may increase if current plan is left unchanged.',
            alternatives,
          },
        },
        finalDecision: combinedDecision,
        combinedDecision,
        errors: [
          { agent: 'fatigue', message: 'Skipped due tactical fallback' },
          { agent: 'risk', message: 'Skipped due tactical fallback' },
        ],
        routerDecision: {
          intent: 'General',
          agentsToRun: ['TACTICAL'],
          selectedAgents: ['tactical'],
          signalSummaryBullets: signals,
          rationale: fallbackMessage,
          rulesFired: ['routerFallback:tacticalOnly'],
          inputsUsed: {
            activePlayerId: String(payload.telemetry?.playerId || ''),
            active: {
              fatigueIndex: safeNum(payload.telemetry?.fatigueIndex, 0),
              strainIndex: safeNum(payload.telemetry?.strainIndex, 0),
              injuryRisk: String(payload.telemetry?.injuryRisk || ''),
              noBallRisk: String(payload.telemetry?.noBallRisk || ''),
            },
            match: {
              matchMode: String(payload.matchContext?.matchMode || payload.matchContext?.teamMode || ''),
              format: String(payload.matchContext?.format || ''),
              phase: String(payload.matchContext?.phase || ''),
              overs: safeNum(payload.matchContext?.overs, 0),
              balls: safeNum(payload.matchContext?.balls, 0),
              scoreRuns: safeNum(payload.matchContext?.score, 0),
              wickets: safeNum(payload.matchContext?.wickets, 0),
              targetRuns: safeNum(payload.matchContext?.target, 0),
              intensity: String(payload.matchContext?.intensity || ''),
            },
          },
          reason: fallbackMessage,
          signals: {
            fatigueIndex: safeNum(payload.telemetry?.fatigueIndex, 0),
            strainIndex: safeNum(payload.telemetry?.strainIndex, 0),
            noBallRisk: String(payload.telemetry?.noBallRisk || ''),
            injuryRisk: String(payload.telemetry?.injuryRisk || ''),
          },
        },
        meta: {
          requestId: `coach-auto-fallback-${Date.now()}`,
          mode: 'auto',
          executedAgents: ['tactical'],
          modelRouting: {
            fatigueModel: 'skipped:fallback',
            riskModel: 'skipped:fallback',
            tacticalModel: 'direct-tactical-fallback',
            fallbacksUsed: ['router-unavailable', 'direct-tactical-fallback'],
          },
          usedFallbackAgents: ['tactical'],
          routerFallbackMessage: fallbackMessage,
          timingsMs: { total: 0, tactical: 0 },
        },
      };
    };

    try {
      try {
        await checkHealth(controller.signal);
      } catch (healthError) {
        if (import.meta.env.DEV) {
          console.warn('COACH_ANALYSIS_HEALTH_CHECK_FAILED', healthError);
        }
      }

      if (mode === 'full') {
        const fullResult = await postFullCombinedAnalysis(payload, controller.signal);
        if (requestId !== fatigueRequestSeq.current) return null;
        return applyCoachResult(fullResult);
      }

      const autoFallbackMessage = 'Routing: rules-based (safe fallback)';
      let autoResult: OrchestrateResponse | null = null;

      try {
        autoResult = useAgentFramework
          ? await postAgentFrameworkOrchestrate(payload, frameworkMode, controller.signal)
          : await postOrchestrate(payload, controller.signal);
      } catch (primaryAutoError) {
        logCoachAnalysisFailure('COACH_ANALYSIS_ROUTER_FAILED', primaryAutoError, orchestrateRequestUrl);

        if (useAgentFramework) {
          try {
            autoResult = await postOrchestrate({ ...payload, mode: 'auto' }, controller.signal);
          } catch (orchestrateFallbackError) {
            logCoachAnalysisFailure('COACH_ANALYSIS_ROUTER_FAILED', orchestrateFallbackError, apiOrchestrateUrl);
          }
        }

        if (!autoResult) {
          try {
            const tacticalResult = await postTacticalAgent(
              {
                requestId: `coach-auto-tactical-${Date.now()}`,
                intent: payload.intent,
                teamMode: payload.teamMode,
                focusRole: payload.focusRole,
                telemetry: payload.telemetry,
                matchContext: payload.matchContext,
                players: payload.players,
                context: payload.context,
              },
              controller.signal
            );
            autoResult = buildAutoTacticalFallbackResponse(tacticalResult, autoFallbackMessage);
          } catch (tacticalFallbackError) {
            logCoachAnalysisFailure('COACH_ANALYSIS_AGENT_FAILED', tacticalFallbackError, orchestrateRequestUrl);
            throw tacticalFallbackError;
          }
        }
      }

      if (!autoResult) {
        throw new Error('Coach analysis did not return a result.');
      }
      const tacticalRan = Array.isArray(autoResult.meta?.executedAgents) && autoResult.meta.executedAgents.includes('tactical');
      const hasUsableAutoOutput = Boolean(autoResult.tactical || autoResult.strategicAnalysis || autoResult.combinedDecision);
      if (!tacticalRan || !hasUsableAutoOutput) {
        try {
          const tacticalResult = await postTacticalAgent(
            {
              requestId: `coach-auto-tactical-${Date.now()}`,
              intent: payload.intent,
              teamMode: payload.teamMode,
              focusRole: payload.focusRole,
              telemetry: payload.telemetry,
              matchContext: payload.matchContext,
              players: payload.players,
              context: payload.context,
            },
            controller.signal
          );
          autoResult = buildAutoTacticalFallbackResponse(tacticalResult, autoFallbackMessage);
        } catch (tacticalFallbackError) {
          logCoachAnalysisFailure('COACH_ANALYSIS_AGENT_FAILED', tacticalFallbackError, orchestrateRequestUrl);
          throw tacticalFallbackError;
        }
      }
      if (requestId !== fatigueRequestSeq.current) return null;
      return applyCoachResult(autoResult, {
        extraWarning: autoResult.meta.routerFallbackMessage ? undefined : (autoResult.errors.length > 0 ? 'Some signals unavailable — showing best available guidance.' : undefined),
      });
    } catch (error) {
      if ((error as Error)?.name === 'AbortError') return null;
      if (requestId !== fatigueRequestSeq.current) return null;
      setAgentFeedStatus((prev) => ({
        fatigue: prev.fatigue === 'RUNNING' ? 'ERROR' : prev.fatigue,
        risk: prev.risk === 'RUNNING' ? 'ERROR' : prev.risk,
        tactical: prev.tactical === 'RUNNING' ? 'ERROR' : prev.tactical,
      }));
      setAgentWarning(null);
      setAgentFailure(toAgentFailureDetail(error, orchestrateRequestUrl));
      setAgentState('offline');
      setAnalysisActive(false);
      return null;
    }
  };

  useEffect(() => {
    if (page !== 'dashboard') return;
    fatigueAbortRef.current?.abort();
    if (!analysisRequested) {
      setAiAnalysis(null);
      setRiskAnalysis(null);
      setTacticalAnalysis(null);
      setStrategicAnalysis(null);
      setCombinedAnalysis(null);
      setCombinedDecision(null);
      setFinalRecommendation(null);
      setOrchestrateMeta(null);
      setRouterDecision(null);
      setAgentFeedStatus(getDefaultAgentFeedStatus());
      setAgentWarning(null);
      setAgentFailure(null);
      setAgentState('idle');
      setAnalysisActive(false);
    }
    setAnalysisRequested(false);
    return () => {
      fatigueAbortRef.current?.abort();
    };
  }, [activePlayerId, page]);

  const dismissAnalysis = () => {
    fatigueAbortRef.current?.abort();
    setAnalysisRequested(false);
    setAnalysisActive(false);
    setAgentState('idle');
    setAgentWarning(null);
    setAgentFailure(null);
    setAiAnalysis(null);
    setRiskAnalysis(null);
    setTacticalAnalysis(null);
    setStrategicAnalysis(null);
    setCombinedAnalysis(null);
    setCombinedDecision(null);
    setFinalRecommendation(null);
    setOrchestrateMeta(null);
    setRouterDecision(null);
    setRunMode('auto');
    setAgentFeedStatus(getDefaultAgentFeedStatus());
  };

  const navigateTo = (p: Page) => {
    window.scrollTo(0, 0);
    setPage(p);
  };

  const handleBaselinesSynced = (
    baselines: Baseline[],
    source: 'cosmos' | 'fallback',
    warning?: string,
    options?: { persist?: boolean; addToRosterIds?: string[] }
  ) => {
    const orderedBaselines = orderBaselinesForDisplay(baselines);
    const previousRosterIds = matchRosterIdsRef.current;
    const baselineIdSet = new Set(
      orderedBaselines
        .map((row) => normalizeBaselineRecord(row))
        .map((row) => baselineKey(row.id || row.playerId || row.name))
    );
    const baseRosterIds = rosterInitializedRef.current
      ? previousRosterIds
      : getRosterIds();
    const seen = new Set(baseRosterIds.map((id) => baselineKey(id)));
    const additions = (options?.addToRosterIds || [])
      .map((id) => normalizeBaselineId(id))
      .filter((id) => {
        const key = baselineKey(id);
        if (!key) return false;
        if (seen.has(key)) return false;
        if (!baselineIdSet.has(key)) return false;
        seen.add(key);
        return true;
      });
    const resolvedRosterIds = resolveRosterIdsFromBaselines([...baseRosterIds, ...additions], orderedBaselines);
    const rosterKeySet = new Set(resolvedRosterIds.map((id) => baselineKey(id)));
    const syncedBaselines = orderedBaselines.map((row) => {
      const normalized = normalizeBaselineRecord(row);
      return normalizeBaselineRecord({
        ...normalized,
        inRoster:
          rosterKeySet.has(baselineKey(normalized.id || normalized.playerId || normalized.name)),
      });
    });
    rosterInitializedRef.current = true;
    setWorkingBaselines(syncedBaselines);
    setBaselineSource(source);
    setBaselineWarning(warning || null);
    setMatchRosterIds(resolvedRosterIds);
    if ((options?.addToRosterIds || []).length > 0) {
      setRosterIds(resolvedRosterIds);
    }
    setPlayers((prev) => {
      const derivedRoster = buildRosterPlayersFromBaselines(prev, syncedBaselines, resolvedRosterIds);
      const hydratedRoster = hydrateDismissalStateFromSession(derivedRoster);
      setActivePlayerId((currentId) => {
        if (hydratedRoster.some((player) => player.id === currentId)) return currentId;
        return hydratedRoster[0]?.id ?? '';
      });
      return hydratedRoster;
    });
    if (import.meta.env.DEV) {
      console.log('[roster-sync] handleBaselinesSynced', {
        reason: 'baselines_page_sync',
        rosterBefore: previousRosterIds.length,
        rosterAfter: resolvedRosterIds.length,
      });
    }
  };

  return (
    <div className="min-h-screen h-auto w-full flex flex-col bg-[#020408] text-slate-100 font-sans selection:bg-emerald-500/30 relative">
      {/* Global Mouse Glow Cursor - Only on Landing Page */}
      {page === 'landing' && <MouseGlow />}

      {/* Splash Screen Overlay */}
      <AnimatePresence>
        {showSplash && (
          <motion.div 
            className="fixed inset-0 z-[100]"
            exit={{ opacity: 0, transition: { duration: 0.5 } }}
          >
             <SplashScreen onComplete={() => setShowSplash(false)} />
          </motion.div>
        )}
      </AnimatePresence>
      
      {!showSplash && (
        <div className="fixed inset-0 pointer-events-none z-0">
           {/* Particles */}
           <ParallaxParticles />
           
           {/* Subtle radial gradient */}
          <div className="absolute inset-0 opacity-[0.03]" 
               style={{ 
                 backgroundImage: 'radial-gradient(circle at 50% 50%, #10B981 1px, transparent 1px)', 
                 backgroundSize: '60px 60px' 
               }} 
          />
          <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-transparent via-emerald-500/50 to-transparent opacity-50"></div>
        </div>
      )}

      {/* Navigation Bar */}
      <nav className="border-b border-white/10 bg-[#060B16]/90 backdrop-blur-md sticky top-0 z-50 shrink-0">
        <div className="w-full px-3 sm:px-4">
          <div className="flex items-center justify-between h-20">
            <div className="flex items-center gap-3 cursor-pointer group" onClick={() => navigateTo('landing')}>
              <div className="w-10 h-10 border border-emerald-500 rounded-xl flex items-center justify-center transform group-hover:rotate-6 transition-transform">
                <Shield className="text-emerald-500 w-5 h-5 fill-emerald-500/20" />
              </div>
              <span className="text-xl font-bold tracking-tight text-white">tactIQ</span>
            </div>
            
            <div className="flex items-center gap-6 relative">
              {page !== 'landing' && (
                <>
                  <button type="button" 
                    onClick={() => navigateTo('dashboard')}
                    className={`text-sm font-medium transition-colors px-3 py-1.5 rounded-md ${page === 'dashboard' ? 'bg-emerald-500/10 text-emerald-400' : 'text-slate-400 hover:text-white'}`}
                  >
                    Dashboard
                  </button>
                  <button type="button" 
                    onClick={() => navigateTo('baselines')}
                    className={`text-sm font-medium transition-colors px-3 py-1.5 rounded-md ${page === 'baselines' ? 'bg-emerald-500/10 text-emerald-400' : 'text-slate-400 hover:text-white'}`}
                  >
                    Player Baselines
                  </button>
                </>
              )}
              
              {/* Profile Dropdown */}
              <div className="relative">
                <button type="button" 
                  onClick={() => setIsProfileOpen(!isProfileOpen)}
                  className="w-10 h-10 rounded-full bg-slate-800 flex items-center justify-center border border-slate-700 text-xs font-medium text-slate-400 hover:text-white hover:border-emerald-500 transition-colors"
                >
                  CM
                </button>

                <AnimatePresence>
                  {isProfileOpen && (
                    <motion.div 
                      initial={{ opacity: 0, y: 10, scale: 0.95 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      exit={{ opacity: 0, y: 10, scale: 0.95 }}
                      className="absolute right-0 mt-2 w-56 bg-[#0F172A] border border-white/10 rounded-xl shadow-2xl p-4 z-50"
                    >
                      <div className="flex items-center gap-3 mb-3 pb-3 border-b border-white/5">
                        <div className="w-10 h-10 rounded-full bg-emerald-500/10 flex items-center justify-center text-emerald-500">
                          <User className="w-5 h-5" />
                        </div>
                        <div>
                          <p className="text-sm font-bold text-white">Coach Mahrosh</p>
                          <p className="text-xs text-slate-400">coach.mahrosh@tactical.ai</p>
                        </div>
                      </div>
                      <button type="button" className="w-full flex items-center gap-2 text-sm text-slate-400 hover:text-white py-2 px-2 hover:bg-white/5 rounded-lg transition-colors">
                        <Settings className="w-4 h-4" /> Account Settings
                      </button>
                      <button type="button" className="w-full flex items-center gap-2 text-sm text-rose-400 hover:text-rose-300 py-2 px-2 hover:bg-rose-500/10 rounded-lg transition-colors">
                        <LogOut className="w-4 h-4" /> Sign Out
                      </button>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </div>
          </div>
        </div>
      </nav>

      <AnimatePresence>
        {activePlayer?.isInjured && activePlayer?.inRoster && (
          <div className="fixed inset-0 z-[150] flex items-center justify-center p-4">
             <motion.div 
               initial={{ opacity: 0 }}
               animate={{ opacity: 1 }}
               exit={{ opacity: 0 }}
               className="absolute inset-0 bg-black/80 backdrop-blur-sm"
               onClick={() => {}} 
             />
             <motion.div 
               initial={{ opacity: 0, scale: 0.9, y: 20 }}
               animate={{ opacity: 1, scale: 1, y: 0 }}
               exit={{ opacity: 0, scale: 0.9, y: 20 }}
               className="relative bg-[#0F172A] border border-rose-500/30 rounded-2xl p-6 max-w-md w-full shadow-2xl shadow-rose-900/20"
             >
                <div className="flex flex-col items-center text-center">
                  <div className="w-16 h-16 rounded-full bg-rose-500/10 flex items-center justify-center mb-4 border border-rose-500/20 animate-pulse">
                     <AlertTriangle className="w-8 h-8 text-rose-500" />
                  </div>
                  <h3 className="text-xl font-bold text-white mb-2">Critical Injury Alert</h3>
                  <p className="text-slate-400 mb-6 leading-relaxed text-sm">
                    <span className="text-white font-bold">{activePlayer.name}</span> has been marked as unfit. 
                    Continued play poses severe risk of long-term injury. Immediate substitution is required.
                  </p>
                  
                  <div className="flex gap-3 w-full">
                    <button type="button" 
                       onClick={() => updatePlayer(activePlayer.id, { isInjured: false })}
                       className="flex-1 py-3 rounded-xl bg-slate-800 text-slate-300 font-bold hover:bg-slate-700 transition-colors text-sm"
                    >
                      Dismiss
                    </button>
                    <button type="button" 
                       onClick={() => movePlayerToSub(activePlayer.id)}
                       className="flex-1 py-3 rounded-xl bg-rose-600 text-white font-bold hover:bg-rose-500 shadow-lg shadow-rose-900/20 transition-colors flex items-center justify-center gap-2 text-sm"
                    >
                       <UserMinus className="w-4 h-4" /> Remove from Squad
                    </button>
                  </div>
                </div>
             </motion.div>
          </div>
        )}
      </AnimatePresence>

      <main className="relative z-10 flex-1 min-h-0 w-full flex flex-col dashboard-main-offset">
        <AnimatePresence mode="wait">
          {page === 'landing' && (
            <LandingPage key="landing" onStart={() => navigateTo('setup')} />
          )}
          {page === 'setup' && (
            <MatchSetup 
              key="setup" 
              context={matchContext} 
              setContext={setMatchContext} 
              onNext={() => navigateTo('dashboard')} 
              onBack={() => navigateTo('landing')}
            />
          )}
          {page === 'dashboard' && (
            <Dashboard 
              key="dashboard"
              matchContext={matchContext}
              runMode={runMode}
              teamMode={matchContext.matchMode}
              setTeamMode={(mode) => {
                teamModeLockedRef.current = true;
                setMatchContext((prev) => ({ ...prev, matchMode: mode }));
              }}
              matchState={matchState}
              players={players}
              activePlayer={activePlayer}
              setActivePlayerId={setActivePlayerId}
              updatePlayer={updatePlayer}
              updateMatchState={updateMatchState}
              deleteRosterPlayer={deleteRosterPlayer}
              movePlayerToSub={movePlayerToSub}
              agentState={agentState}
              agentWarning={agentWarning}
              agentFailure={agentFailure}
              aiAnalysis={aiAnalysis}
              riskAnalysis={riskAnalysis}
              tacticalAnalysis={tacticalAnalysis}
              strategicAnalysis={strategicAnalysis}
              combinedAnalysis={combinedAnalysis}
              combinedDecision={combinedDecision}
              finalRecommendation={finalRecommendation}
              orchestrateMeta={orchestrateMeta}
              routerDecision={routerDecision}
              agentFeedStatus={agentFeedStatus}
              analysisActive={analysisActive}
              runAgent={runAgent}
              onDismissAnalysis={dismissAnalysis}
              handleAddOver={handleAddOver}
              handleDecreaseOver={handleDecreaseOver}
              handleRest={handleRest}
              handleMarkUnfit={handleMarkUnfit}
              recoveryMode={recoveryMode}
              setRecoveryMode={setRecoveryMode}
              manualRecovery={manualRecovery}
              setManualRecovery={setManualRecovery}
              isLoadingRosterPlayers={isLoadingRosterPlayers}
              rosterMutationError={rosterMutationError}
              onGoToBaselines={() => navigateTo('baselines')}
              onBack={() => navigateTo('setup')}
            />
          )}
          {page === 'baselines' && (
            <Baselines 
              key="baselines"
              baselineSource={baselineSource}
              baselineWarning={baselineWarning}
              onBaselinesSynced={handleBaselinesSynced}
              matchRosterIds={matchRosterIds}
              onMatchRosterIdsChange={applyMatchRosterIds}
              onBack={() => navigateTo('dashboard')}
            />
          )}
        </AnimatePresence>
      </main>
      
      {page !== 'landing' && (
        <footer className="py-6 text-center text-xs text-slate-600 border-t border-white/5 bg-[#020408]">
          <p>© 2026 TactIQ. Enterprise Sports Analytics.</p>
        </footer>
      )}
      
      {/* Help Icon (Bottom Right from screenshot) */}
      <div className="fixed bottom-6 right-6 z-50">
        <button type="button" className="w-8 h-8 rounded-full bg-slate-800 text-slate-400 flex items-center justify-center hover:bg-slate-700 hover:text-white transition-colors shadow-lg border border-white/5">
          <HelpCircle className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}

// --- Sub-Pages ---

function LandingPage({ onStart }: { onStart: () => void }) {
  return (
    <motion.div 
      initial={{ opacity: 0 }} 
      animate={{ opacity: 1 }} 
      exit={{ opacity: 0, scale: 0.98 }}
      className="flex-1 flex flex-col items-center justify-center relative overflow-hidden py-24 min-h-[calc(100vh-5rem)]"
    >
      
      <div className="relative z-10 max-w-6xl mx-auto px-6 text-center">
        <motion.div 
          initial={{ y: 20, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ duration: 0.6 }}
          className="flex flex-col items-center"
        >
          {/* Badge */}
          <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-[#0F172A] border border-emerald-900/30 mb-8 shadow-2xl">
            <span className="w-2 h-2 bg-emerald-500 rounded-full animate-pulse shadow-[0_0_8px_#10B981]"></span>
            <span className="text-xs font-bold text-emerald-500 uppercase tracking-wide">Live Decision Support System</span>
          </div>
          
          <h1 className="text-7xl md:text-8xl font-bold tracking-tight mb-4 text-white drop-shadow-2xl">
            tact<span className="text-emerald-500">IQ</span>
          </h1>
          
          <p className="text-xl text-slate-400 mb-12 font-medium">Tactical Coach AI</p>
          
          <div className="flex justify-center mb-24">
            <button type="button" 
              onClick={onStart}
              className="group relative bg-emerald-600 hover:bg-emerald-500 text-white px-8 py-4 rounded-xl text-lg font-bold transition-all flex items-center gap-4 shadow-[0_0_30px_rgba(16,185,129,0.3)] hover:shadow-[0_0_50px_rgba(16,185,129,0.6)] active:scale-95 overflow-hidden"
            >
              <span className="relative z-10">Start Match Analysis</span>
              
              {/* Arrow Container that moves */}
              <div className="relative flex items-center justify-center w-8 h-8 group-hover:translate-x-2 transition-transform duration-300">
                 {/* The Bright Light Halo - Large outer glow */}
                 <div className="absolute -inset-2 bg-white rounded-full blur-[15px] opacity-0 group-hover:opacity-100 transition-opacity duration-500" />
                 
                 {/* Intense Core Light - Inner bright spot */}
                 <div className="absolute inset-0 bg-white rounded-full blur-[5px] opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
                 
                 {/* Arrow - Changes color to be visible against light */}
                 <ChevronRight className="w-6 h-6 relative z-10 stroke-[3px] text-white group-hover:text-emerald-600 transition-colors duration-300" />
              </div>
            </button>
          </div>

        </motion.div>

        <div className="grid md:grid-cols-3 gap-6 text-left relative z-20">
          <FeatureCard 
            icon={<Activity className="w-6 h-6 text-emerald-400" />}
            title="Live Metrics"
            desc="Real-time tracking of fatigue, heart rate, and biomechanical stress markers."
            color="green"
          />
          <FeatureCard 
            icon={<Cpu className="w-6 h-6 text-amber-400" />}
            title="Baseline Comparison"
            desc="AI models compare live data against historical player baselines to detect anomalies."
            color="amber"
          />
          <FeatureCard 
            icon={<Shield className="w-6 h-6 text-rose-400" />}
            title="Tactical Recommendations"
            desc="Automated intervention strategies to prevent injury while maximizing performance."
            color="red"
          />
        </div>
      </div>
    </motion.div>
  );
}

function FeatureCard({ icon, title, desc, color }: { icon: React.ReactNode, title: string, desc: string, color: string }) {
  const borderColors = {
    green: 'group-hover:border-emerald-500/30',
    amber: 'group-hover:border-amber-500/30',
    red: 'group-hover:border-rose-500/30'
  };

  return (
    <motion.div 
      whileHover={{ y: -5 }}
      className={`p-8 rounded-3xl bg-[#0F172A] border border-white/5 transition-all group ${borderColors[color as keyof typeof borderColors]}`}
    >
      <div className="w-14 h-14 rounded-2xl bg-[#1E293B] border border-white/5 flex items-center justify-center mb-6">
        {icon}
      </div>
      <h3 className="text-xl font-bold text-white mb-3">{title}</h3>
      <p className="text-sm text-slate-400 leading-relaxed">{desc}</p>
    </motion.div>
  );
}

function MatchSetup({ context, setContext, onNext, onBack }: { 
  context: MatchContext, 
  setContext: (c: MatchContext) => void, 
  onNext: () => void,
  onBack: () => void 
}) {
  const handleChange = <K extends keyof MatchContext>(key: K, value: MatchContext[K]) => {
    setContext({ ...context, [key]: value });
  };

  return (
    <motion.div 
      initial={{ opacity: 0, scale: 0.95 }} 
      animate={{ opacity: 1, scale: 1 }} 
      exit={{ opacity: 0, x: -20 }}
      className="flex-1 w-full flex flex-col justify-center items-center p-4"
    >
      <div className="bg-[#0F172A] rounded-2xl border border-white/10 p-10 shadow-2xl max-w-2xl w-full relative overflow-hidden">
        <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-transparent via-emerald-500 to-transparent opacity-30"></div>

        <div className="mb-8 flex items-start gap-4">
          <GlowingBackButton onClick={onBack} />
          <div>
            <h2 className="text-3xl font-bold text-white mb-2">Match Context Setup</h2>
          </div>
        </div>

        <div className="space-y-8">
          <div>
            <label className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-3 block">Match Format</label>
            <div className="grid grid-cols-3 gap-3">
              {['T20', 'ODI', 'Test'].map(opt => (
                <button type="button"
                  key={opt}
                  onClick={() => handleChange('format', opt)}
                  className={`py-3 rounded-lg text-sm font-semibold transition-all border ${
                    context.format === opt 
                      ? 'bg-emerald-500/10 border-emerald-500 text-emerald-400 shadow-[0_0_15px_rgba(16,185,129,0.1)]' 
                      : 'bg-slate-800/50 border-transparent text-slate-400 hover:bg-slate-800 hover:text-white'
                  }`}
                >
                  {opt}
                </button>
              ))}
            </div>
          </div>

          <div>
             <label className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-3 block">Match Phase</label>
             <div className="grid grid-cols-3 gap-3">
              {['Powerplay', 'Middle', 'Death'].map(opt => (
                <button type="button"
                  key={opt}
                  onClick={() => handleChange('phase', opt)}
                  className={`py-3 rounded-lg text-sm font-semibold transition-all border ${
                    context.phase === opt 
                      ? 'bg-amber-500/10 border-amber-500 text-amber-400 shadow-[0_0_15px_rgba(245,158,11,0.1)]' 
                      : 'bg-slate-800/50 border-transparent text-slate-400 hover:bg-slate-800 hover:text-white'
                  }`}
                >
                  {opt}
                </button>
              ))}
            </div>
          </div>
          
          <div className="grid grid-cols-2 gap-6">
            <div className="space-y-3">
               <label className="text-xs font-bold text-slate-500 uppercase tracking-wider block">Pitch Intensity</label>
               <select 
                  value={context.pitch}
                  onChange={(e) => handleChange('pitch', e.target.value)}
                  className="w-full bg-slate-800 border border-slate-700 text-white rounded-lg px-4 py-3 appearance-none focus:border-indigo-500 focus:outline-none"
                >
                  {['Low', 'Medium', 'High'].map(opt => <option key={opt} value={opt}>{opt}</option>)}
                </select>
            </div>
            <div className="space-y-3">
               <label className="text-xs font-bold text-slate-500 uppercase tracking-wider block">Weather</label>
                <div className="flex gap-2">
                  <button type="button" 
                    onClick={() => handleChange('weather', 'Cool')}
                    className={`flex-1 flex items-center justify-center gap-2 py-3 rounded-lg text-sm font-medium border ${context.weather === 'Cool' ? 'bg-indigo-500/20 border-indigo-500 text-white' : 'bg-slate-800 border-slate-700 text-slate-400'}`}
                  >
                    <Wind className="w-4 h-4" /> Cool
                  </button>
                  <button type="button" 
                    onClick={() => handleChange('weather', 'Hot')}
                    className={`flex-1 flex items-center justify-center gap-2 py-3 rounded-lg text-sm font-medium border ${context.weather === 'Hot' ? 'bg-orange-500/20 border-orange-500 text-white' : 'bg-slate-800 border-slate-700 text-slate-400'}`}
                  >
                    <Thermometer className="w-4 h-4" /> Hot
                  </button>
                </div>
            </div>
          </div>

          <button type="button" 
            onClick={onNext}
            className="w-full mt-6 bg-emerald-600 hover:bg-emerald-500 text-white py-4 rounded-lg font-bold transition-all shadow-lg shadow-emerald-900/50"
          >
            Load Team Dashboard
          </button>
        </div>
      </div>
    </motion.div>
  );
}

interface FatigueForecastPoint {
  overAhead: number;
  fatigue: number;
}

interface PressureForecastPoint {
  overAhead: number;
  pressure: number;
}

const FORECAST_OVERS = [0, 1, 2, 3, 4, 5];
const FORECAST_Y_TICKS = [0, 2.5, 5, 7.5, 10];

const fatigueIntensityMultiplier = (intensity?: string): number => {
  const normalized = String(intensity || '').trim().toUpperCase();
  if (normalized === 'COOL' || normalized === 'LOW') return 0.85;
  if (normalized === 'MEDIUM') return 1.0;
  if (normalized === 'POWERPLAY' || normalized === 'HIGH') return 1.15;
  return 1.0;
};

const fatigueRecoveryDelta = (heartRateRecovery?: Player['hrRecovery'] | 'OK' | 'Ok'): number => {
  const normalized = String(heartRateRecovery || '').trim().toUpperCase();
  if (normalized === 'GOOD') return -0.2;
  if (normalized === 'OK' || normalized === 'MODERATE') return -0.1;
  if (normalized === 'POOR') return 0.0;
  return -0.1;
};

const buildFatigueForecast = ({
  currentFatigue,
  intensity,
  consecutiveOvers,
  heartRateRecovery,
}: {
  currentFatigue: number;
  intensity?: string;
  consecutiveOvers: number;
  heartRateRecovery?: Player['hrRecovery'] | 'OK' | 'Ok';
}): FatigueForecastPoint[] => {
  const startFatigue = clamp(currentFatigue, 0, 10);
  const safeConsecutiveOvers = Math.max(0, consecutiveOvers);
  const incrementPerOver =
    0.55 * fatigueIntensityMultiplier(intensity) +
    0.10 * safeConsecutiveOvers +
    fatigueRecoveryDelta(heartRateRecovery);

  return FORECAST_OVERS.map((overAhead) => ({
    overAhead,
    fatigue: Number(clamp(startFatigue + incrementPerOver * overAhead, 0, 10).toFixed(1)),
  }));
};

function FatigueForecastChart({
  currentFatigue,
  intensity,
  consecutiveOvers,
  heartRateRecovery,
}: {
  currentFatigue: number;
  intensity?: string;
  consecutiveOvers: number;
  heartRateRecovery?: Player['hrRecovery'] | 'OK' | 'Ok';
}) {
  const points: FatigueForecastPoint[] = React.useMemo(() => {
    const inc = 0.56;
    return Array.from({ length: 6 }, (_, i) => ({
      overAhead: i,
      fatigue: Math.round(clamp((currentFatigue ?? 0) + inc * i, 0, 10) * 10) / 10,
    }));
  }, [currentFatigue]);

  return (
    <div className="relative rounded-2xl border border-white/10 bg-white/[0.04] backdrop-blur-xl shadow-[inset_0_1px_0_rgba(255,255,255,0.08)] p-4 overflow-hidden">
      <div className="absolute inset-0 rounded-2xl bg-gradient-to-br from-emerald-500/10 via-cyan-500/5 to-transparent pointer-events-none" />
      <div className="relative z-10">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-bold text-white">Fatigue Forecast</h3>
            <p className="text-xs text-slate-400">Next 5 overs • AI projection</p>
          </div>
          <span className="rounded-full border border-cyan-400/35 bg-cyan-500/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-cyan-200">
            AI
          </span>
        </div>

        <div className="mt-4 h-[240px] w-full" style={{ height: 240 }}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={points} margin={{ top: 10, right: 12, left: 0, bottom: 18 }}>
              <defs>
                <linearGradient id="fatigueLine" x1="0%" y1="0%" x2="100%" y2="0%">
                  <stop offset="0%" stopColor="rgba(34,211,238,0.95)" />
                  <stop offset="100%" stopColor="rgba(16,185,129,0.95)" />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="4 6" vertical={false} stroke="rgba(255,255,255,0.08)" />
              <XAxis
                dataKey="overAhead"
                ticks={FORECAST_OVERS}
                tickFormatter={(value) => (value === 0 ? 'Now' : `+${value}`)}
                tickLine={false}
                axisLine={{ stroke: 'rgba(255,255,255,0.10)' }}
                tick={{ fill: 'rgba(255,255,255,0.55)', fontSize: 12 }}
                label={{ value: 'Overs Ahead', position: 'insideBottom', offset: -8, fill: 'rgba(255,255,255,0.55)' }}
              />
              <YAxis
                domain={[0, 10]}
                ticks={FORECAST_Y_TICKS}
                tickLine={false}
                axisLine={false}
                tick={{ fill: 'rgba(255,255,255,0.55)', fontSize: 12 }}
                label={{ value: 'Fatigue (0–10)', angle: -90, position: 'insideLeft', fill: 'rgba(255,255,255,0.55)' }}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: '#0f172a',
                  border: '1px solid rgba(255,255,255,0.1)',
                  borderRadius: '12px'
                }}
                formatter={(value: number) => value}
                labelFormatter={(label) => `+${label} overs`}
              />
              <ReferenceLine
                y={7}
                stroke="rgba(255,255,255,0.12)"
                strokeDasharray="6 6"
                label={{ value: 'High risk ≥ 7', position: 'insideTopRight', fill: 'rgba(255,255,255,0.40)' }}
              />
              <Line
                type="monotone"
                dataKey="fatigue"
                stroke="#22d3ee"
                strokeWidth={3}
                dot={{ r: 5 }}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>

        <div className="mt-4 border-t border-white/10" />

        <div className="mt-4 grid grid-cols-3 sm:grid-cols-6 gap-2">
          {points.map((point, index) => {
            const isLast = index === points.length - 1;
            return (
              <div
                key={`forecast-chip-${point.overAhead}`}
                className={`rounded-xl border bg-white/[0.03] px-3 py-2 ${
                  isLast ? 'border-emerald-400/45 shadow-[0_0_14px_rgba(16,185,129,0.16)]' : 'border-white/10'
                }`}
              >
                <p className="text-[10px] uppercase tracking-wide text-slate-400">
                  {point.overAhead === 0 ? 'Now' : `+${point.overAhead} ov`}
                </p>
                <p className={`text-xs font-mono font-bold ${isLast ? 'text-emerald-300' : 'text-cyan-200'}`}>
                  {point.fatigue.toFixed(1)}
                </p>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

const buildPressureForecast = ({
  currentPressure,
  requiredRunRate,
  currentRunRate,
  wicketsDown,
  phase,
}: {
  currentPressure: number;
  requiredRunRate: number;
  currentRunRate: number;
  wicketsDown: number;
  phase?: string;
}): PressureForecastPoint[] => {
  const startPressure = clamp(currentPressure, 0, 10);
  const rrGap = Math.max(0, requiredRunRate - currentRunRate);
  const runRateDrift = rrGap > 0 ? Math.min(0.42, rrGap * 0.07) : 0.06;
  const wicketDrift = Math.min(0.30, Math.max(0, wicketsDown - 2) * 0.06);
  const normalizedPhase = String(phase || '').trim().toUpperCase();
  const phaseDrift = normalizedPhase === 'DEATH' ? 0.12 : normalizedPhase === 'MIDDLE' ? 0.08 : 0.05;
  // Deterministic projection so pressure trend is stable across rerenders.
  const incrementPerOver = runRateDrift + wicketDrift + phaseDrift;

  return FORECAST_OVERS.map((overAhead) => ({
    overAhead,
    pressure: Number(clamp(startPressure + incrementPerOver * overAhead, 0, 10).toFixed(1)),
  }));
};

function PressureForecastChart({
  currentPressure,
  requiredRunRate,
  currentRunRate,
  wicketsDown,
  phase,
}: {
  currentPressure: number;
  requiredRunRate: number;
  currentRunRate: number;
  wicketsDown: number;
  phase?: string;
}) {
  const points: PressureForecastPoint[] = React.useMemo(
    () =>
      buildPressureForecast({
        currentPressure,
        requiredRunRate,
        currentRunRate,
        wicketsDown,
        phase,
      }),
    [currentPressure, requiredRunRate, currentRunRate, wicketsDown, phase]
  );

  return (
    <div className="relative rounded-2xl border border-white/10 bg-white/[0.04] backdrop-blur-xl shadow-[inset_0_1px_0_rgba(255,255,255,0.08)] p-4 overflow-hidden">
      <div className="absolute inset-0 rounded-2xl bg-gradient-to-br from-rose-500/12 via-red-500/8 to-transparent pointer-events-none" />
      <div className="relative z-10">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-bold text-white">Pressure Forecast</h3>
            <p className="text-xs text-slate-400">Next 5 overs • AI projection</p>
          </div>
          <span className="rounded-full border border-rose-400/35 bg-rose-500/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-rose-200">
            AI
          </span>
        </div>

        <div className="mt-4 h-[240px] w-full" style={{ height: 240 }}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={points} margin={{ top: 10, right: 12, left: 0, bottom: 18 }}>
              <defs>
                <linearGradient id="pressureLine" x1="0%" y1="0%" x2="100%" y2="0%">
                  <stop offset="0%" stopColor="rgba(248,113,113,0.95)" />
                  <stop offset="100%" stopColor="rgba(239,68,68,0.95)" />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="4 6" vertical={false} stroke="rgba(255,255,255,0.08)" />
              <XAxis
                dataKey="overAhead"
                ticks={FORECAST_OVERS}
                tickFormatter={(value) => (value === 0 ? 'Now' : `+${value}`)}
                tickLine={false}
                axisLine={{ stroke: 'rgba(255,255,255,0.10)' }}
                tick={{ fill: 'rgba(255,255,255,0.55)', fontSize: 12 }}
                label={{ value: 'Overs Ahead', position: 'insideBottom', offset: -8, fill: 'rgba(255,255,255,0.55)' }}
              />
              <YAxis
                domain={[0, 10]}
                ticks={FORECAST_Y_TICKS}
                tickLine={false}
                axisLine={false}
                tick={{ fill: 'rgba(255,255,255,0.55)', fontSize: 12 }}
                label={{ value: 'Pressure (0–10)', angle: -90, position: 'insideLeft', fill: 'rgba(255,255,255,0.55)' }}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: '#0f172a',
                  border: '1px solid rgba(255,255,255,0.1)',
                  borderRadius: '12px'
                }}
                formatter={(value: number) => `pressure: ${Number(value).toFixed(1)}`}
                labelFormatter={(label) => `+${label} overs`}
              />
              <ReferenceLine
                y={7}
                stroke="rgba(255,255,255,0.12)"
                strokeDasharray="6 6"
                label={{ value: 'High pressure ≥ 7', position: 'insideTopRight', fill: 'rgba(255,255,255,0.40)' }}
              />
              <Line
                type="monotone"
                dataKey="pressure"
                stroke="url(#pressureLine)"
                strokeWidth={3}
                dot={{ r: 5, fill: '#f87171', stroke: '#fecaca', strokeWidth: 1 }}
                activeDot={{ r: 6, fill: '#ef4444' }}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>

        <div className="mt-4 border-t border-white/10" />

        <div className="mt-4 grid grid-cols-3 sm:grid-cols-6 gap-2">
          {points.map((point, index) => {
            const isLast = index === points.length - 1;
            return (
              <div
                key={`pressure-forecast-chip-${point.overAhead}`}
                className={`rounded-xl border bg-white/[0.03] px-3 py-2 ${
                  isLast ? 'border-rose-400/45 shadow-[0_0_14px_rgba(244,63,94,0.16)]' : 'border-white/10'
                }`}
              >
                <p className="text-[10px] uppercase tracking-wide text-slate-400">
                  {point.overAhead === 0 ? 'Now' : `+${point.overAhead} ov`}
                </p>
                <p className={`text-xs font-mono font-bold ${isLast ? 'text-rose-300' : 'text-rose-200'}`}>
                  {point.pressure.toFixed(1)}
                </p>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

interface DashboardProps {
  matchContext: MatchContext;
  runMode: RunMode;
  teamMode: TeamMode;
  setTeamMode: (mode: TeamMode) => void;
  matchState: MatchState;
  players: Player[];
  activePlayer: (Player & { status: StatusLevel; loadRatio: number; maxOvers: number; oversRemaining: number }) | null;
  setActivePlayerId: React.Dispatch<React.SetStateAction<string>>;
  updatePlayer: (id: string, updates: Partial<Player> | ((player: Player) => Partial<Player>)) => void;
  updateMatchState: (updates: Partial<MatchState> | ((prev: MatchState) => Partial<MatchState>)) => void;
  deleteRosterPlayer: (id: string) => void;
  movePlayerToSub: (id: string) => void;
  agentState: 'idle' | 'thinking' | 'done' | 'offline' | 'invalid';
  aiAnalysis: AiAnalysis | null;
  riskAnalysis: AiAnalysis | null;
  tacticalAnalysis: TacticalAgentResponse | null;
  strategicAnalysis: OrchestrateResponse['strategicAnalysis'] | null;
  combinedAnalysis: OrchestrateResponse['strategicAnalysis'] | null;
  combinedDecision: TacticalCombinedDecision | null;
  finalRecommendation: FinalRecommendation | null;
  orchestrateMeta: OrchestrateMetaView | null;
  routerDecision: RouterDecisionView | null;
  agentFeedStatus: AgentFeedStatus;
  agentWarning: string | null;
  agentFailure: AgentFailureDetail | null;
  analysisActive: boolean;
  runAgent: (
    mode?: 'auto' | 'full',
    reason?: 'button_click' | 'non_button',
    options?: { teamMode?: TeamMode; focusRole?: 'BOWLER' | 'BATTER'; strainIndex?: number }
  ) => Promise<RunCoachAgentResult | null>;
  onDismissAnalysis: () => void;
  handleAddOver: () => void;
  handleDecreaseOver: () => void;
  handleRest: () => void;
  handleMarkUnfit: () => void;
  recoveryMode: RecoveryMode;
  setRecoveryMode: React.Dispatch<React.SetStateAction<RecoveryMode>>;
  manualRecovery: RecoveryLevel;
  setManualRecovery: React.Dispatch<React.SetStateAction<RecoveryLevel>>;
  isLoadingRosterPlayers: boolean;
  rosterMutationError: string | null;
  onGoToBaselines: () => void;
  onBack: () => void;
}

interface ConfirmSwitchOverlayProps {
  open: boolean;
  suggestion: SuggestedBowlerRecommendation | null;
  onSwitch: () => void;
  onCancel: () => void;
}

function ConfirmSwitchOverlay({ open, suggestion, onSwitch, onCancel }: ConfirmSwitchOverlayProps) {
  useEffect(() => {
    if (!open) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [onCancel, open]);

  if (!open || !suggestion || typeof document === 'undefined') return null;

  return createPortal(
    <div
      role="presentation"
      onClick={onCancel}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.35)',
        backdropFilter: 'blur(4px)',
        WebkitBackdropFilter: 'blur(4px)',
        zIndex: 9999,
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-switch-title"
        onClick={(event) => event.stopPropagation()}
        style={{
          position: 'fixed',
          left: '50%',
          bottom: '24px',
          transform: 'translateX(-50%)',
          width: 'min(520px, calc(100vw - 32px))',
          background: 'rgba(15,23,42,0.95)',
          border: '1px solid rgba(148,163,184,0.15)',
          borderRadius: '14px',
          padding: '16px',
          boxShadow: '0 20px 50px rgba(2,6,23,0.45)',
          color: '#E2E8F0',
          zIndex: 10000,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '8px' }}>
          <div
            style={{
              width: '36px',
              height: '36px',
              borderRadius: '999px',
              background: 'rgba(16,185,129,0.12)',
              border: '1px solid rgba(16,185,129,0.25)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            <PlayCircle style={{ width: '16px', height: '16px', color: '#6EE7B7' }} />
          </div>
          <h3
            id="confirm-switch-title"
            style={{
              margin: 0,
              fontSize: '15px',
              lineHeight: 1.35,
              fontWeight: 700,
              color: '#F8FAFC',
            }}
          >
            Coach suggests switching to: {suggestion.bowlerName}
          </h3>
        </div>
        {suggestion.reason && (
          <p
            style={{
              margin: '0 0 14px',
              fontSize: '12px',
              lineHeight: 1.4,
              color: '#94A3B8',
            }}
          >
            {suggestion.reason}
          </p>
        )}
        <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
          <button
            type="button"
            onClick={onCancel}
            style={{
              border: '1px solid rgba(148,163,184,0.25)',
              background: 'rgba(30,41,59,0.7)',
              color: '#CBD5E1',
              borderRadius: '10px',
              padding: '10px 14px',
              fontSize: '13px',
              fontWeight: 700,
              cursor: 'pointer',
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onSwitch}
            style={{
              border: '1px solid rgba(16,185,129,0.45)',
              background: '#059669',
              color: '#ECFDF5',
              borderRadius: '10px',
              padding: '10px 14px',
              fontSize: '13px',
              fontWeight: 700,
              cursor: 'pointer',
            }}
          >
            Switch
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

interface MatchModeGuardOverlayProps {
  open: boolean;
  onSwitch: () => void;
  onCancel: () => void;
}

function MatchModeGuardOverlay({ open, onSwitch, onCancel }: MatchModeGuardOverlayProps) {
  useEffect(() => {
    if (!open) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [onCancel, open]);

  if (!open || typeof document === 'undefined') return null;

  return createPortal(
    <div
      role="presentation"
      onClick={onCancel}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.45)',
        backdropFilter: 'blur(6px)',
        WebkitBackdropFilter: 'blur(6px)',
        zIndex: 9999,
        pointerEvents: 'auto',
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="match-mode-guard-title"
        onClick={(event) => event.stopPropagation()}
        style={{
          position: 'fixed',
          left: '50%',
          top: '50%',
          transform: 'translate(-50%, -50%)',
          width: 'min(520px, calc(100vw - 32px))',
          background: 'rgba(15,23,42,0.96)',
          border: '1px solid rgba(148,163,184,0.16)',
          borderRadius: '16px',
          padding: '18px 18px 16px',
          boxShadow: '0 20px 60px rgba(0,0,0,0.45)',
          color: '#E2E8F0',
          pointerEvents: 'auto',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: '12px' }}>
          <div
            style={{
              width: '40px',
              height: '40px',
              borderRadius: '999px',
              background: 'rgba(245,158,11,0.12)',
              border: '1px solid rgba(245,158,11,0.28)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            <AlertTriangle style={{ width: '18px', height: '18px', color: '#FBBF24' }} />
          </div>
          <div style={{ minWidth: 0 }}>
            <h3
              id="match-mode-guard-title"
              style={{
                margin: 0,
                fontSize: '18px',
                fontWeight: 700,
                lineHeight: 1.25,
                color: '#F8FAFC',
              }}
            >
              Batting actions locked
            </h3>
            <p
              style={{
                margin: '8px 0 0',
                fontSize: '13px',
                lineHeight: 1.45,
                color: '#94A3B8',
              }}
            >
              Batting actions are locked while match state is Bowling. Switch match state to Batting to continue.
            </p>
          </div>
        </div>
        <div
          style={{
            marginTop: '16px',
            display: 'flex',
            gap: '10px',
            justifyContent: 'flex-end',
          }}
        >
          <button
            type="button"
            onClick={onCancel}
            style={{
              minWidth: '112px',
              padding: '10px 14px',
              borderRadius: '10px',
              border: '1px solid rgba(148,163,184,0.25)',
              background: 'rgba(30,41,59,0.8)',
              color: '#CBD5E1',
              fontSize: '13px',
              fontWeight: 700,
              cursor: 'pointer',
              transition: 'background-color 140ms ease, border-color 140ms ease, color 140ms ease',
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onSwitch}
            style={{
              minWidth: '148px',
              padding: '10px 14px',
              borderRadius: '10px',
              border: '1px solid rgba(16,185,129,0.5)',
              background: 'linear-gradient(135deg, #047857 0%, #10B981 100%)',
              color: '#ECFDF5',
              fontSize: '13px',
              fontWeight: 700,
              cursor: 'pointer',
              boxShadow: '0 10px 22px rgba(6,95,70,0.35)',
              transition: 'filter 140ms ease, transform 140ms ease',
            }}
          >
            Switch to Batting
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

function Dashboard({
  matchContext, runMode, teamMode, setTeamMode, matchState, players, activePlayer, setActivePlayerId, updatePlayer, updateMatchState, deleteRosterPlayer, movePlayerToSub,
  agentState, aiAnalysis, riskAnalysis, tacticalAnalysis, strategicAnalysis, combinedAnalysis, combinedDecision, finalRecommendation, orchestrateMeta, routerDecision, agentFeedStatus, agentWarning, agentFailure, analysisActive, runAgent, onDismissAnalysis, handleAddOver, handleDecreaseOver, handleRest, handleMarkUnfit,
  recoveryMode, setRecoveryMode, manualRecovery, setManualRecovery, isLoadingRosterPlayers, rosterMutationError, onGoToBaselines, onBack
}: DashboardProps) {
  const [arTelemetryView, setArTelemetryView] = useState<'batting' | 'bowling'>('batting');
  const [strainIndex, setStrainIndex] = useState(0);
  const [isResettingBaselines, setIsResettingBaselines] = useState(false);
  const [rosterEmptyError, setRosterEmptyError] = useState<string | null>(null);
  const [substitutionRecommendation, setSubstitutionRecommendation] = useState<string | null>(null);
  const [isRunCoachHovered, setIsRunCoachHovered] = useState(false);
  const [showCoachInsights, setShowCoachInsights] = useState(false);
  const [showRouterSignals, setShowRouterSignals] = useState(false);
  const [showRawTelemetry, setShowRawTelemetry] = useState(false);
  const [briefCopied, setBriefCopied] = useState(false);
  const [showMatchModeGuard, setShowMatchModeGuard] = useState(false);
  const [inningsLockNotice, setInningsLockNotice] = useState<string | null>(null);
  const [showRotateBowlerConfirm, setShowRotateBowlerConfirm] = useState(false);
  const [rotateBowlerSuggestion, setRotateBowlerSuggestion] = useState<SuggestedBowlerRecommendation | null>(null);
  const [rotateBowlerNotice, setRotateBowlerNotice] = useState<string | null>(null);
  const [pressureStateByPlayer, setPressureStateByPlayer] = useState<{ playerId: string; base: number; eventDelta: number } | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);
  const pendingMatchModeActionRef = useRef<(() => void) | null>(null);
  const pressureDebugRef = useRef<{
    playerId: string;
    runs: number;
    ballsFaced: number;
    pressure: number;
  } | null>(null);
  const pressureEventSnapshotRef = useRef<{
    playerId: string;
    runs: number;
    ballsFaced: number;
    fours: number;
    sixes: number;
  } | null>(null);
  const lastValidPressureRef = useRef<{ playerId: string; value: number } | null>(null);

  useEffect(() => {
    setSubstitutionRecommendation(null);
  }, [activePlayer?.id]);

  useEffect(() => {
    if (!activePlayer) return;
    if (activePlayer.role === 'All-rounder') {
      setArTelemetryView('batting');
    }
  }, [activePlayer?.id, activePlayer?.role]);

  useEffect(() => {
    if (!activePlayer) {
      setStrainIndex(0);
      return;
    }
    setStrainIndex(Math.max(0, Math.min(5, safeNum(activePlayer.strainIndex, 0))));
  }, [activePlayer?.id, activePlayer?.strainIndex]);

  useEffect(() => {
    // Keep coach expansion local to the currently selected player.
    setShowCoachInsights(false);
    setShowRotateBowlerConfirm(false);
    setRotateBowlerSuggestion(null);
  }, [activePlayer?.id]);

  const rosterPlayers = players.filter((p: Player) => p.inRoster !== false);
  const totalCount = rosterPlayers.length;
  const hasRosterPlayers = rosterPlayers.length > 0;
  const isRosterEmpty = rosterPlayers.length === 0;
  const isRosterFull = totalCount >= MAX_ROSTER;

  const handleResetBaselines = async () => {
    setRosterEmptyError(null);
    setIsResettingBaselines(true);
    try {
      await resetBaselines();
      window.dispatchEvent(new Event(BASELINES_CHANGED_EVENT));
    } catch (error) {
      setRosterEmptyError(error instanceof Error ? error.message : 'Failed to reset baselines.');
    } finally {
      setIsResettingBaselines(false);
    }
  };

  const handleRemoveActive = () => {
    if (!activePlayer) return;
    setSubstitutionRecommendation(`⚠️ URGENT: ${activePlayer.name} marked unfit. Immediate substitution recommended.`);
    movePlayerToSub(activePlayer.id);
  };
  const removeFromRoster = (playerId: string) => {
    void deleteRosterPlayer(playerId);
  };

  const handleDismissAnalysis = () => {
    console.log('dismiss analysis');
    setSubstitutionRecommendation(null);
    setShowRouterSignals(false);
    setShowCoachInsights(false);
    onDismissAnalysis?.();
  };

  const telemetryView: 'batting' | 'bowling' = activePlayer?.role === 'Batsman'
    ? 'batting'
    : activePlayer?.role === 'All-rounder'
      ? arTelemetryView
      : 'bowling';
  const isBatsmanActive = telemetryView === 'batting';
  const focusRole: 'BOWLER' | 'BATTER' = telemetryView === 'bowling' ? 'BOWLER' : 'BATTER';

  const isUnlimitedInningsFormat = String(matchContext.format || '').trim().toUpperCase() === 'TEST';
  const totalBalls = totalBallsFromOvers(matchState.totalOvers);
  const ballsBowled = isUnlimitedInningsFormat
    ? Math.max(0, matchState.ballsBowled)
    : Math.min(totalBalls, Math.max(0, matchState.ballsBowled));
  const ballsRemaining = Math.max(totalBalls - ballsBowled, 0);
  // Shared innings cap for setup + batting controls.
  const isInningsFinished = !isUnlimitedInningsFormat && ballsBowled >= totalBalls;
  const inningsComplete = isInningsFinished;
  const formatMaxOvers = activePlayer?.maxOvers ?? getMaxOvers(matchContext.format);
  const hasFormatCap = formatMaxOvers < 999;
  const atOversCap = Boolean(activePlayer && activePlayer.overs >= formatMaxOvers);
  const isQuotaComplete = Boolean(activePlayer && (activePlayer.quotaComplete === true || (hasFormatCap && activePlayer.overs >= formatMaxOvers)));
  const isMedicalCritical = Boolean(activePlayer && (activePlayer.injuryRisk === 'High' || activePlayer.injuryRisk === 'Critical'));
  const showQuotaLockState = isQuotaComplete && !isMedicalCritical;
  const clampedStrainIndex = Math.max(0, Math.min(5, strainIndex));
  const isStrainMax = clampedStrainIndex >= 5;
  const strainProgress = (clampedStrainIndex / 5) * 100;
  const strainTone = clampedStrainIndex >= 4 ? 'high' : clampedStrainIndex >= 2 ? 'moderate' : 'low';
  const strainStatusText = strainTone === 'high'
    ? 'HIGH RISK'
    : strainTone === 'moderate'
      ? 'MODERATE STRAIN'
      : 'LOW STRESS';
  const strainStrokeClass = strainTone === 'high'
    ? 'text-rose-400'
    : strainTone === 'moderate'
      ? 'text-amber-300'
      : 'text-emerald-400';
  const strainTextClass = strainTone === 'high'
    ? 'text-rose-300'
    : strainTone === 'moderate'
      ? 'text-amber-200'
      : 'text-emerald-300';
  const strainBadgeClass = strainTone === 'high'
    ? 'border-rose-400/35 bg-rose-500/12 text-rose-200'
    : strainTone === 'moderate'
      ? 'border-amber-300/35 bg-amber-500/12 text-amber-200'
      : 'border-emerald-300/35 bg-emerald-500/12 text-emerald-200';
  const strainCardClass = strainTone === 'high'
    ? 'border-rose-500/45 shadow-[0_0_26px_rgba(244,63,94,0.20)]'
    : strainTone === 'moderate'
      ? 'border-amber-400/35 shadow-[0_0_22px_rgba(251,191,36,0.14)]'
      : 'border-emerald-500/30 shadow-[0_0_20px_rgba(16,185,129,0.12)]';
  const computeStrainFatigueDelta = (baseDelta: number, currentFatigue: number, oversBowled: number): number => {
    const oversMultiplier = 1 + Math.max(0, oversBowled) * 0.08;
    const diminishingReturns = Math.max(0.25, 1 - currentFatigue / 12);
    return baseDelta * oversMultiplier * diminishingReturns;
  };
  const applyStrainDelta = (strainDelta: number, baseFatigueDelta: number) => {
    if (!activePlayer) return;
    setStrainIndex((prev) => Math.max(0, Math.min(5, prev + strainDelta)));
    // Keep fatigue source-of-truth on player state so telemetry + AI read the same updated value.
    updatePlayer(activePlayer.id, (player) => {
      const currentFatigue = clamp(safeNum(player.fatigue, 2.5), 0, 10);
      const oversBowled = Math.max(0, safeNum(player.overs, 0));
      const fatigueDelta = computeStrainFatigueDelta(baseFatigueDelta, currentFatigue, oversBowled);
      return {
        strainIndex: Math.max(0, Math.min(5, safeNum(player.strainIndex, 0) + strainDelta)),
        fatigue: clamp(currentFatigue + fatigueDelta, 0, 10),
      };
    });
  };
  const handleResetStrain = () => {
    if (!activePlayer) {
      setStrainIndex(0);
      return;
    }
    setStrainIndex(0);
    updatePlayer(activePlayer.id, { strainIndex: 0 });
  };
  const overStr = formatOverStr(ballsBowled);
  const oversFaced = ballsBowled / 6;
  const currentRunRate = ballsBowled > 0 ? matchState.runs / oversFaced : 0;
  const runsNeeded = matchState.target != null ? Math.max(matchState.target - matchState.runs, 0) : 0;
  const safeBallsRemaining = Math.max(1, ballsRemaining);
  // Keep denominator >= 1 so chase pressure never collapses to zero on the final-ball transition.
  const requiredRunRate = matchState.target != null ? (runsNeeded / safeBallsRemaining) * 6 : 0;
  const requiredStrikeRate = matchState.target != null ? (runsNeeded / safeBallsRemaining) * 100 : 0;
  const projectedScoreAtCurrentRR = matchState.runs + (currentRunRate * (ballsRemaining / 6));
  const behindRuns = matchState.target != null ? Math.max(0, matchState.target - projectedScoreAtCurrentRR) : 0;
  const ballsFaced = Math.max(0, activePlayer?.balls ?? 0);
  const chaseStatus =
    matchState.target == null
      ? { label: 'On Track', tone: 'success' as const }
      : currentRunRate >= requiredRunRate + 0.3
        ? { label: 'Ahead', tone: 'info' as const }
        : currentRunRate >= requiredRunRate
          ? { label: 'On Track', tone: 'success' as const }
          : { label: 'Behind', tone: 'warning' as const };
  const batsmanStrikeRate = activePlayer && activePlayer.balls > 0
    ? (activePlayer.runs / activePlayer.balls) * 100
    : 0;
  const activeDismissalStatus: DismissalStatus = activePlayer ? resolveDismissalStatus(activePlayer) : 'NOT_OUT';
  const dismissalStatusLabel = activeDismissalStatus === 'OUT' ? 'OUT' : 'NOT OUT';
  const dismissalStatusClass = activeDismissalStatus === 'OUT'
    ? 'border-rose-500/35 bg-rose-500/15 text-rose-300'
    : 'border-emerald-500/25 bg-emerald-500/10 text-emerald-300';

  const srGap = Math.max(0, requiredStrikeRate - batsmanStrikeRate);
  const rrGap = Math.max(0, requiredRunRate - currentRunRate);
  const ballsUsedRatio = totalBalls > 0 ? ballsBowled / totalBalls : 0;
  const blend = (from: number, to: number, t: number) => from + ((to - from) * t);
  const endgame = clamp((30 - ballsRemaining) / 30, 0, 1);
  const rrStressRaw = clamp(rrGap / 6, 0, 1);
  const rrStress = blend(rrStressRaw * 0.45, rrStressRaw, endgame);
  const neededRuns = matchState.target != null ? Math.max(matchState.target - matchState.runs, 0) : 0;
  const neededRPO = matchState.target != null ? (neededRuns / Math.max(1, ballsRemaining)) * 6 : 0;
  const difficultyRaw = matchState.target != null ? clamp((neededRPO - 8) / 8, 0, 1) : 0;
  const difficulty = blend(difficultyRaw * 0.5, difficultyRaw, endgame);
  const srStressRaw = clamp(srGap / 80, 0, 1);
  const srStress = blend(srStressRaw * 0.35, srStressRaw * 0.7, endgame);
  const behindRunsDenominator = matchState.target != null ? Math.max(12, matchState.target * 0.2) : 18;
  const behindStressRaw = clamp(behindRuns / behindRunsDenominator, 0, 1);
  const behindStress = blend(behindStressRaw * 0.4, behindStressRaw * 0.9, endgame);
  const ballsStressRaw = clamp(ballsUsedRatio, 0, 1);
  const ballsStress = blend(ballsStressRaw * 0.18, ballsStressRaw * 0.55, endgame);
  const wicketStress = clamp(matchState.wickets / 10, 0, 1);
  const phaseStress = matchContext.phase === 'Death' ? 0.65 : matchContext.phase === 'Middle' ? 0.4 : 0.25;
  const pressureTightness = clamp(rrGap / 6, 0, 1);
  const pressureReliefScale = 1 + (0.5 * pressureTightness);
  const pressureStepUpCap = 0.35;
  const pressureStepDownCap = 0.8;
  const pressureBaseFloor = 2.0;
  const pressureTarget = clamp(
    pressureBaseFloor
      + (4.0 * rrStress)
      + (2.5 * difficulty)
      + (1.5 * wicketStress)
      + (1.1 * srStress)
      + (1.0 * behindStress)
      + (0.7 * ballsStress)
      + (0.4 * phaseStress),
    0,
    10
  );
  const pressureDrivers = [
    {
      key: 'rr_gap',
      score: (2.9 * rrStress) + (0.8 * difficulty),
      reason: `RR gap ${rrGap.toFixed(2)} (${currentRunRate.toFixed(2)} vs ${requiredRunRate.toFixed(2)})`,
      recommendation: 'Lift scoring intent over the next two balls to close the run-rate gap.'
    },
    {
      key: 'sr_gap',
      score: 1.1 * srStress,
      reason: `SR gap ${srGap.toFixed(1)} (${batsmanStrikeRate.toFixed(1)} vs ${requiredStrikeRate.toFixed(1)})`,
      recommendation: 'Rotate strike early in the over and avoid back-to-back dot balls.'
    },
    {
      key: 'balls_left',
      score: (0.7 * ballsStress) + (0.35 * endgame),
      reason: `${ballsRemaining} balls left from ${totalBalls}`,
      recommendation: 'Pre-plan two scoring zones and commit to high-percentage placement.'
    },
    {
      key: 'behind_runs',
      score: (1.0 * behindStress) + (1.2 * difficulty),
      reason: `${behindRuns.toFixed(1)} runs behind projection`,
      recommendation: 'Recover the chase curve with low-risk boundaries and quick twos.'
    },
    {
      key: 'wickets',
      score: 1.5 * wicketStress,
      reason: `${matchState.wickets} wickets down`,
      recommendation: 'Reduce aerial risk and preserve wicket value for the back end.'
    },
    {
      key: 'phase',
      score: 0.4 * phaseStress,
      reason: `${matchContext.phase} phase`,
      recommendation: matchContext.phase === 'Death'
        ? 'Target straighter boundary options against yorker-heavy plans.'
        : 'Work singles into gaps to keep required rate stable.'
    }
  ];

  const computedPressureRaw = pressureTarget;
  const targetBasePressure = clamp(computedPressureRaw, 0, 10);
  const pressureStateForPlayer = activePlayer && pressureStateByPlayer?.playerId === activePlayer.id
    ? pressureStateByPlayer
    : null;
  const basePressure = pressureStateForPlayer?.base ?? targetBasePressure;
  const eventPressureDelta = pressureStateForPlayer?.eventDelta ?? 0;
  const computedPressureIndex = clamp(basePressure + eventPressureDelta, 0, 10);
  const lastValidPressureForPlayer = activePlayer && lastValidPressureRef.current?.playerId === activePlayer.id
    ? lastValidPressureRef.current.value
    : computedPressureIndex;
  const pressureIndex = inningsComplete ? lastValidPressureForPlayer : computedPressureIndex;
  const isPressureCritical = pressureIndex > 7;
  const isStrikeRateBehind = batsmanStrikeRate < requiredStrikeRate;
  const showBatsmanAiAlert = isBatsmanActive && (isPressureCritical || isStrikeRateBehind);
  const sortedDrivers = [...pressureDrivers].sort((a, b) => b.score - a.score);
  const dominantDrivers = sortedDrivers.filter((driver) => driver.score > 0.35).slice(0, 3);
  const primaryDriver = dominantDrivers[0]?.key;
  const batsmanRecommendations = dominantDrivers.map((driver) => driver.recommendation).slice(0, 3);
  if (batsmanRecommendations.length < 2) {
    batsmanRecommendations.push('Target the weakest field zone and convert 1s into 2s where possible.');
  }
  const tacticalAlertTitle = primaryDriver === 'sr_gap'
    ? 'Scoring Tempo Gap Detected'
    : primaryDriver === 'rr_gap'
      ? 'Run-Rate Gap Expanding'
      : primaryDriver === 'behind_runs'
        ? 'Chase Projection Slipping'
    : primaryDriver === 'balls_left'
      ? 'Time Pressure Increasing'
      : primaryDriver === 'wickets'
        ? 'Wicket Context Raising Risk'
        : isPressureCritical
          ? 'High Batting Pressure Detected'
          : 'Run-Rate Tempo Behind Requirement';
  const tacticalAlertText = primaryDriver === 'sr_gap'
    ? 'Current scoring speed is below chase requirement; stabilize tempo without gifting high-risk chances.'
    : primaryDriver === 'rr_gap'
      ? 'Required run-rate has climbed above current scoring pace; reduce dot-ball streaks immediately.'
      : primaryDriver === 'behind_runs'
        ? 'Projected finish is behind target; recover with high-percentage scoring options.'
    : primaryDriver === 'balls_left'
      ? 'Ball inventory is shrinking quickly; prioritize strike rotation and boundary setup patterns.'
      : primaryDriver === 'wickets'
        ? 'Wickets in hand are limited, so expected-value shot selection is now critical.'
        : 'Pressure is building from multiple signals; adjust intent and shot map proactively.';
  const alertWhyLine = `Why this alert: RR gap ${rrGap.toFixed(2)}, SR gap ${srGap.toFixed(1)}, behind ${behindRuns.toFixed(1)}, balls left ${ballsRemaining}.`;
  const pressureToneClass = pressureIndex > 7 ? 'text-rose-400' : pressureIndex >= 4 ? 'text-amber-300' : 'text-emerald-400';
  const boundaryEvents = activePlayer?.boundaryEvents || [];
  const foursCount = boundaryEvents.filter((event) => event === '4').length;
  const sixesCount = boundaryEvents.filter((event) => event === '6').length;

  useEffect(() => {
    if (!isBatsmanActive || !activePlayer) {
      setPressureStateByPlayer(null);
      pressureEventSnapshotRef.current = null;
      return;
    }
    if (inningsComplete || !Number.isFinite(targetBasePressure)) return;

    const runsScored = Math.max(0, activePlayer.runs || 0);
    const currentSnapshot = {
      playerId: activePlayer.id,
      runs: runsScored,
      ballsFaced,
      fours: foursCount,
      sixes: sixesCount,
    };

    setPressureStateByPlayer((prev) => {
      const prevBase = prev?.playerId === activePlayer.id ? prev.base : targetBasePressure;
      const prevEventDelta = prev?.playerId === activePlayer.id ? prev.eventDelta : 0;
      const alphaBase = 0.18;
      const decay = 0.85;
      const nextBase = clamp(prevBase + ((targetBasePressure - prevBase) * alphaBase), 0, 10);
      let nextEventDelta = prevEventDelta;

      const previousSnapshot = pressureEventSnapshotRef.current;
      if (previousSnapshot && previousSnapshot.playerId === activePlayer.id) {
        const dRuns = runsScored - previousSnapshot.runs;
        const dBalls = ballsFaced - previousSnapshot.ballsFaced;
        const dFours = foursCount - previousSnapshot.fours;
        const dSixes = sixesCount - previousSnapshot.sixes;

        if (dBalls > 0) {
          nextEventDelta *= decay;
        }

        if (dFours > 0) {
          nextEventDelta -= 0.5 * pressureReliefScale * dFours;
        }
        if (dSixes > 0) {
          nextEventDelta -= 0.8 * pressureReliefScale * dSixes;
        }

        const boundaryRunsAdded = Math.max(0, dFours) * 4 + Math.max(0, dSixes) * 6;
        const nonBoundaryRunsAdded = Math.max(0, dRuns - boundaryRunsAdded);
        if (nonBoundaryRunsAdded > 0) {
          nextEventDelta -= 0.05 * nonBoundaryRunsAdded;
        }
        if (dBalls > 0 && dRuns <= 0) {
          nextEventDelta += 0.1 * dBalls;
        }
      }

      nextEventDelta = clamp(nextEventDelta, -3.5, 2.5);
      const prevPressure = clamp(prevBase + prevEventDelta, 0, 10);
      const rawNextPressure = clamp(nextBase + nextEventDelta, 0, 10);
      const pressureDelta = clamp(rawNextPressure - prevPressure, -pressureStepDownCap, pressureStepUpCap);
      const nextPressure = clamp(prevPressure + pressureDelta, 0, 10);
      nextEventDelta = clamp(nextPressure - nextBase, -3.5, 2.5);
      const nextState = { playerId: activePlayer.id, base: nextBase, eventDelta: nextEventDelta };
      if (
        prev?.playerId === nextState.playerId
        && Math.abs(prev.base - nextState.base) < 0.001
        && Math.abs(prev.eventDelta - nextState.eventDelta) < 0.001
      ) {
        return prev;
      }
      return nextState;
    });
    pressureEventSnapshotRef.current = currentSnapshot;
  }, [isBatsmanActive, activePlayer?.id, activePlayer?.runs, ballsFaced, foursCount, sixesCount, inningsComplete, targetBasePressure, pressureReliefScale, pressureStepDownCap, pressureStepUpCap]);

  useEffect(() => {
    if (!isBatsmanActive || !activePlayer) return;
    if (inningsComplete) return;
    if (!Number.isFinite(pressureIndex)) return;
    lastValidPressureRef.current = {
      playerId: activePlayer.id,
      value: pressureIndex,
    };
  }, [isBatsmanActive, activePlayer?.id, inningsComplete, pressureIndex]);

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    if (telemetryView !== 'batting' || !activePlayer) {
      pressureDebugRef.current = null;
      return;
    }

    const runsScored = Math.max(0, activePlayer.runs || 0);
    const safePressureRaw = Number.isFinite(computedPressureRaw) ? computedPressureRaw : 0;
    const safePressureClamped = Number.isFinite(pressureIndex) ? pressureIndex : 0;
    const requiredRRSafe = Number.isFinite(requiredRunRate) ? requiredRunRate : 0;
    const requiredSRSafe = Number.isFinite(requiredStrikeRate) ? requiredStrikeRate : 0;

    console.debug('[pressure:calc]', {
      playerId: activePlayer.id,
      ballsFaced,
      runs: runsScored,
      overs: formatOverStr(ballsBowled),
      target: matchState.target ?? null,
      wickets: matchState.wickets,
      inningsComplete,
      requiredRR: Number(requiredRRSafe.toFixed(2)),
      requiredSR: Number(requiredSRSafe.toFixed(1)),
      deltaBehind: Number(behindRuns.toFixed(1)),
      endgame: Number(endgame.toFixed(3)),
      rrStress: Number(rrStress.toFixed(3)),
      difficulty: Number(difficulty.toFixed(3)),
      neededRPO: Number(neededRPO.toFixed(2)),
      reliefScale: Number(pressureReliefScale.toFixed(3)),
      stepCaps: { up: pressureStepUpCap, down: pressureStepDownCap },
      targetBasePressure: Number(targetBasePressure.toFixed(3)),
      basePressure: Number(basePressure.toFixed(3)),
      eventDelta: Number(eventPressureDelta.toFixed(3)),
      computedPressureRaw: Number(safePressureRaw.toFixed(3)),
      computedPressureClamped: Number(Math.max(0, Math.min(10, pressureIndex)).toFixed(3)),
      pressureShown: Number(safePressureClamped.toFixed(3)),
    });

    const previous = pressureDebugRef.current;
    if (previous && previous.playerId === activePlayer.id) {
      const isChase = typeof matchState.target === 'number' && matchState.target > 0;
      const isDotBallStep = isChase && ballsFaced === previous.ballsFaced + 1 && runsScored === previous.runs;

      // Sanity guard: in a chase, consuming one more ball without adding runs should not reduce pressure.
      if (isDotBallStep && safePressureClamped + 0.05 < previous.pressure) {
        console.warn('[pressure:sanity] Dot-ball progression reduced pressure unexpectedly.', {
          previousPressure: Number(previous.pressure.toFixed(3)),
          nextPressure: Number(safePressureClamped.toFixed(3)),
          previousBalls: previous.ballsFaced,
          nextBalls: ballsFaced,
          runs: runsScored,
        });
      }
    }

    pressureDebugRef.current = {
      playerId: activePlayer.id,
      runs: runsScored,
      ballsFaced,
      pressure: safePressureClamped,
    };
  }, [
    activePlayer?.id,
    activePlayer?.runs,
    activePlayer?.balls,
    telemetryView,
    ballsBowled,
    matchState.target,
    matchState.wickets,
    behindRuns,
    inningsComplete,
    computedPressureIndex,
    pressureIndex,
    computedPressureRaw,
    targetBasePressure,
    basePressure,
    eventPressureDelta,
    endgame,
    rrStress,
    difficulty,
    neededRPO,
    pressureReliefScale,
    pressureStepUpCap,
    pressureStepDownCap,
    requiredRunRate,
    requiredStrikeRate,
  ]);

  const routerDecisionForView = runMode === 'auto' ? routerDecision : null;
  const routerSelectedAgents =
    (routerDecisionForView?.selectedAgents && routerDecisionForView.selectedAgents.length > 0
      ? routerDecisionForView.selectedAgents
      : (routerDecisionForView?.agentsToRun || []).map((agent) => {
          if (agent === 'RISK') return 'risk';
          if (agent === 'FATIGUE') return 'fatigue';
          return 'tactical';
        })) as Array<'fatigue' | 'risk' | 'tactical'>;
  const statusSelectedAgents = AGENT_KEYS.filter((agent) => {
    const status = agentFeedStatus[agent];
    return status !== 'IDLE' && status !== 'SKIPPED';
  });
  const selectedAgents = Array.from(
    new Set<('fatigue' | 'risk' | 'tactical')>([
      ...(runMode === 'full' ? AGENT_KEYS : []),
      ...routerSelectedAgents,
      ...(orchestrateMeta?.executedAgents || []),
      ...statusSelectedAgents,
    ])
  );
  const selectedAgentSet = new Set(selectedAgents);
  const isCoachOutputState = analysisActive || showCoachInsights;
  const isFullAnalysis = runMode === 'full';
  const activeStrategicAnalysis = isFullAnalysis ? combinedAnalysis : strategicAnalysis;
  const analysisBadgeLabel = isFullAnalysis ? 'FULL ANALYSIS' : 'AUTO ROUTING';
  const hasAnyAnalysis = Boolean(
    activeStrategicAnalysis || finalRecommendation || combinedDecision || tacticalAnalysis || aiAnalysis || riskAnalysis
  );
  const hasTacticalGuidance = Boolean(
    activeStrategicAnalysis?.tacticalRecommendation?.nextAction ||
    tacticalAnalysis?.immediateAction ||
    combinedDecision?.immediateAction
  );
  const showAnalysisFailureCard = Boolean(agentFailure && !hasAnyAnalysis && !hasTacticalGuidance);
  const showAnalysisFailureInline = Boolean(agentFailure && hasAnyAnalysis);
  const showAnalysisSkeleton = agentState === 'thinking' && !hasAnyAnalysis;
  const agentStatusRows: Array<{ agent: AgentKey; label: string; state: AgentFeedState; detail: string }> = [
    { agent: 'fatigue', label: 'Fatigue Agent', state: agentFeedStatus.fatigue, detail: '' },
    { agent: 'risk', label: 'Risk Agent', state: agentFeedStatus.risk, detail: '' },
    { agent: 'tactical', label: 'Tactical Agent', state: agentFeedStatus.tactical, detail: '' },
  ].map((entry) => {
    let detail = 'Waiting to run';
    if (entry.state === 'RUNNING') detail = 'Running...';
    if (entry.state === 'SUCCESS') detail = 'Output ready';
    if (entry.state === 'SKIPPED') detail = 'Skipped by router';
    if (entry.state === 'ERROR') detail = 'No output';
    return { ...entry, detail };
  });
  const advancedSignalRecord = routerDecisionForView?.signals || {};
  const advancedFatigueSignal = safeNum(advancedSignalRecord.fatigueIndex ?? aiAnalysis?.fatigueIndex ?? activePlayer?.fatigue, Number.NaN);
  const advancedStrainSignal = safeNum(advancedSignalRecord.strainIndex ?? activePlayer?.strainIndex, Number.NaN);
  const advancedOversSignal = safeNum(advancedSignalRecord.oversBowled ?? activePlayer?.overs, Number.NaN);
  const advancedNoBallSignal = String(advancedSignalRecord.noBallRisk || riskAnalysis?.noBallRisk || '').toUpperCase();
  const advancedInjurySignal = String(advancedSignalRecord.injuryRisk || riskAnalysis?.injuryRisk || '').toUpperCase();
  const advancedPressureSignal = safeNum(advancedSignalRecord.pressureIndex, Number.NaN);
  const advancedRecentEvents = toRecord(advancedSignalRecord.recentEvents);
  const advancedLastBall = String(advancedSignalRecord.lastBall || advancedRecentEvents.lastBall || '').toUpperCase();
  const noBallTrendUp =
    advancedSignalRecord.noBallTrendUp === true ||
    String(advancedSignalRecord.noBallTrend || '').toUpperCase() === 'UP' ||
    String(advancedSignalRecord.noBallSignal || '').toLowerCase() === 'true';
  const recentNoBallEvent = advancedLastBall === 'NOBALL' || advancedLastBall === 'WIDE';
  const noBallControlSignalPresent =
    advancedNoBallSignal === 'HIGH' ||
    advancedNoBallSignal === 'MEDIUM' ||
    advancedNoBallSignal === 'MED' ||
    noBallTrendUp ||
    recentNoBallEvent;
  const strongestIntentLabel = (() => {
    if (
      advancedInjurySignal === 'HIGH' ||
      advancedInjurySignal === 'CRITICAL' ||
      (Number.isFinite(advancedFatigueSignal) && advancedFatigueSignal >= 6) ||
      (Number.isFinite(advancedStrainSignal) && advancedStrainSignal >= 6)
    ) {
      return 'Injury Prevention';
    }
    if (noBallControlSignalPresent || (Number.isFinite(advancedPressureSignal) && advancedPressureSignal >= 6.5)) {
      return 'Maintain Spell Control';
    }
    return 'Attack Wicket';
  })();
  const routerIntentLabel = (() => {
    if (isFullAnalysis) return 'All Agents Forced';
    const token = String(routerDecisionForView?.intent || '').trim().toUpperCase();
    if (token === 'INJURYPREVENTION' || token === 'SUBSTITUTION' || token === 'RISK_CHECK') return 'Injury Prevention';
    if (token === 'PRESSURECONTROL' || token === 'SAFETY_ALERT') {
      return noBallControlSignalPresent ? 'Control No-Balls' : strongestIntentLabel;
    }
    if (token === 'TACTICALATTACK') return 'Attack Wicket';
    if (token === 'GENERAL') return strongestIntentLabel;
    if (token === 'BOWLING_NEXT') return 'Bowling Rotation';
    if (token === 'BATTING_NEXT') return 'Batting Continuity';
    if (token === 'BOTH_NEXT') return 'Dual Scenario Planning';
    if (token === 'FATIGUE_CHECK') return 'Fatigue Management';
    return strongestIntentLabel;
  })();
  const matchSignalBullets = (() => {
    const sanitizeSignals = (items: string[]): string[] =>
      items
        .map((entry) => String(entry).trim())
        .filter(Boolean)
        .filter((entry) => !/(unterminated|string|invalid json|trace:|source:\s*unknown|error|failed)/i.test(entry))
        .slice(0, 7);

    if (Array.isArray(activeStrategicAnalysis?.signals) && activeStrategicAnalysis.signals.length > 0) {
      return sanitizeSignals(activeStrategicAnalysis.signals);
    }
    if (Array.isArray(routerDecisionForView?.signalSummaryBullets) && routerDecisionForView.signalSummaryBullets.length > 0) {
      return sanitizeSignals(routerDecisionForView.signalSummaryBullets);
    }
    if (Array.isArray((tacticalAnalysis as unknown as Record<string, unknown>)?.signalSummaryBullets)) {
      return sanitizeSignals(
        ((tacticalAnalysis as unknown as Record<string, unknown>).signalSummaryBullets as unknown[])
          .map((entry) => String(entry))
      );
    }
    const bullets: string[] = [];
    const signalRecord = routerDecisionForView?.signals || {};
    const fatigueSignal = safeNum(
      signalRecord.fatigueIndex ?? aiAnalysis?.fatigueIndex ?? activePlayer?.fatigue,
      Number.NaN
    );
    const strainSignal = safeNum(signalRecord.strainIndex ?? activePlayer?.strainIndex, Number.NaN);
    const noBallSignal = String(signalRecord.noBallRisk || riskAnalysis?.noBallRisk || '').toUpperCase();
    const injurySignal = String(signalRecord.injuryRisk || riskAnalysis?.injuryRisk || '').toUpperCase();
    const hrrSignal = String(signalRecord.heartRateRecovery || activePlayer?.hrRecovery || '').toLowerCase();
    const sleepSignal = safeNum(signalRecord.sleepHours ?? activePlayer?.sleepHours, Number.NaN);
    const oversSignal = safeNum(signalRecord.oversBowled ?? activePlayer?.overs, Number.NaN);
    const phaseSignal = String(routerDecisionForView?.inputsUsed?.match?.phase || matchContext.phase || '').toLowerCase();

    if (Number.isFinite(fatigueSignal) && fatigueSignal >= 6.8) {
      bullets.push('Fatigue is approaching a high-load zone and needs immediate workload control.');
    } else if (Number.isFinite(fatigueSignal) && fatigueSignal >= 5) {
      bullets.push('Fatigue is trending upward and should be managed over the next over.');
    }
    if (Number.isFinite(strainSignal) && strainSignal >= 6) {
      bullets.push('Strain is elevated and points to reduced movement quality.');
    } else if (Number.isFinite(strainSignal) && strainSignal >= 4) {
      bullets.push('Strain is rising and should be monitored before extending the spell.');
    }
    if (injurySignal === 'HIGH' || injurySignal === 'CRITICAL') {
      bullets.push('Injury exposure is elevated if the current workload pattern continues.');
    }
    if (noBallSignal === 'HIGH') {
      bullets.push('No-ball risk is elevated under current pressure and rhythm.');
    }
    if (hrrSignal.includes('poor') || hrrSignal.includes('slow')) {
      bullets.push('Recovery response is lagging, suggesting incomplete reset between efforts.');
    }
    if (Number.isFinite(sleepSignal) && sleepSignal > 0 && sleepSignal < 6) {
      bullets.push('Sleep is below baseline, reducing recovery margin for this phase.');
    }
    if (Number.isFinite(oversSignal) && oversSignal >= 3) {
      bullets.push('Recent workload volume is high for this spell.');
    }
    if (phaseSignal === 'death') {
      bullets.push('Death-overs pressure is amplifying execution and injury risk trade-offs.');
    }
    if (bullets.length === 0 && routerDecisionForView) {
      bullets.push('Signal profile is stable; tactical selection focuses on control and continuity.');
    }
    return sanitizeSignals(Array.from(new Set(bullets)));
  })();
  const fatigueSectionVisible = Boolean(isFullAnalysis || selectedAgentSet.has('fatigue') || aiAnalysis);
  const likelyInjuries = finalRecommendation?.ifContinues?.likelyInjuries || [];
  const riskSectionVisible = Boolean(
    isFullAnalysis || selectedAgentSet.has('risk') || riskAnalysis || likelyInjuries.length > 0
  );
  const fatigueTrendLabel: 'Up' | 'Down' | 'Stable' = activePlayer?.isResting
    ? 'Down'
    : aiAnalysis?.severity === 'HIGH' || aiAnalysis?.severity === 'CRITICAL'
      ? 'Up'
      : 'Stable';
  const tacticalNextAction =
    activeStrategicAnalysis?.tacticalRecommendation?.nextAction ||
    combinedDecision?.immediateAction ||
    tacticalAnalysis?.immediateAction ||
    finalRecommendation?.title ||
    'Reassess tactical control and apply the safest immediate adjustment.';
  const tacticalWhy =
    activeStrategicAnalysis?.tacticalRecommendation?.why ||
    combinedDecision?.rationale ||
    tacticalAnalysis?.rationale ||
    finalRecommendation?.statement ||
    'Current match signals indicate tactical adjustment will preserve control and reduce risk.';
  const tacticalIfIgnored =
    activeStrategicAnalysis?.tacticalRecommendation?.ifIgnored ||
    finalRecommendation?.ifContinues?.riskSummary ||
    riskAnalysis?.recommendation ||
    'Risk is likely to compound across the next phase if the current plan remains unchanged.';
  const tacticalAlternative =
    activeStrategicAnalysis?.tacticalRecommendation?.alternatives?.[0] ||
    combinedDecision?.suggestedAdjustments?.[0] ||
    tacticalAnalysis?.suggestedAdjustments?.[0] ||
    'Use a lower-intensity over plan and review live signals again immediately after.';
  const fatigueShouldRun =
    (Number.isFinite(advancedFatigueSignal) && advancedFatigueSignal >= 6) ||
    (Number.isFinite(advancedStrainSignal) && advancedStrainSignal >= 5.5) ||
    (Number.isFinite(advancedOversSignal) && advancedOversSignal >= 3);
  const riskShouldRun =
    noBallControlSignalPresent ||
    (Number.isFinite(advancedPressureSignal) && advancedPressureSignal >= 6.5) ||
    (Number.isFinite(advancedFatigueSignal) && advancedFatigueSignal >= 6) ||
    advancedInjurySignal === 'HIGH' ||
    advancedInjurySignal === 'CRITICAL';
  const agentDecisionRows: Array<{ agent: 'fatigue' | 'risk' | 'tactical'; selected: boolean; why: string }> = [
    {
      agent: 'risk',
      selected: selectedAgentSet.has('risk'),
      why: selectedAgentSet.has('risk')
        ? noBallControlSignalPresent
          ? 'No-ball pressure/control signals are elevated.'
          : advancedInjurySignal === 'HIGH' || advancedInjurySignal === 'CRITICAL'
            ? 'Injury exposure signals require preventive risk analysis.'
            : 'Risk trend is relevant for the current phase.'
        : riskShouldRun && riskAnalysis
          ? 'Risk was recently analyzed this over; existing result was reused.'
          : 'Immediate risk escalation signals were not dominant this run.',
    },
    {
      agent: 'tactical',
      selected: true,
      why: 'Tactical agent always runs to produce a coach-facing action plan.',
    },
    {
      agent: 'fatigue',
      selected: selectedAgentSet.has('fatigue'),
      why: selectedAgentSet.has('fatigue')
        ? 'Workload and strain profile warrants fatigue oversight.'
        : fatigueShouldRun && aiAnalysis
          ? 'Fatigue was recently analyzed this over; existing result was reused.'
          : 'Fatigue signals stayed below escalation thresholds this run.',
    },
  ];
  const formatTelemetryValue = (key: string, value: unknown): string => {
    const lowerKey = key.toLowerCase();
    if (typeof value === 'number' && Number.isFinite(value)) {
      const rounded = Math.round(value * 10) / 10;
      if (lowerKey.includes('percent') || lowerKey.includes('confidence')) {
        const clampedPercent = Math.max(0, Math.min(100, rounded));
        return `${clampedPercent.toFixed(1)}%`;
      }
      if (lowerKey.includes('overs') || lowerKey === 'over') {
        return rounded.toFixed(1);
      }
      return rounded.toFixed(1);
    }
    if (typeof value === 'boolean') return value ? 'Yes' : 'No';
    if (Array.isArray(value)) return value.map((entry) => String(entry)).join(', ');
    if (value && typeof value === 'object') {
      return JSON.stringify(value, (_key, nestedValue) =>
        typeof nestedValue === 'number' && Number.isFinite(nestedValue)
          ? Math.round(nestedValue * 10) / 10
          : nestedValue
      );
    }
    return String(value);
  };
  const rawSignalEntries = Object.entries(routerDecisionForView?.signals || {})
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => ({
      key,
      value: formatTelemetryValue(key, value),
    }));
  const recommendationTeamMode: TeamMode = (() => {
    const token = String(routerDecisionForView?.inputsUsed?.match?.matchMode || teamMode || '').trim().toUpperCase();
    return token === 'BAT' || token === 'BATTING' ? 'BATTING' : 'BOWLING';
  })();
  const modeScopedAlternative =
    recommendationTeamMode === 'BOWLING'
      ? finalRecommendation?.nextSafeBowler?.name
        ? `${tacticalAlternative} Alternative bowler: ${finalRecommendation.nextSafeBowler.name}.`
        : tacticalAlternative
      : finalRecommendation?.nextSafeBatter?.name
        ? `${tacticalAlternative} Alternative batter: ${finalRecommendation.nextSafeBatter.name}.`
        : tacticalAlternative;
  const briefingText = [
    'AI Strategic Analysis',
    '',
    'Detected Match Signals:',
    ...(matchSignalBullets.length > 0 ? matchSignalBullets.map((item) => `- ${item}`) : ['- Signals were limited in this run.']),
    '',
    'Fatigue Analysis:',
    activeStrategicAnalysis?.fatigueAnalysis || aiAnalysis?.headline || aiAnalysis?.recommendation || 'Fatigue trend reviewed.',
    '',
    'Injury Risk Analysis:',
    activeStrategicAnalysis?.injuryRiskAnalysis || riskAnalysis?.headline || riskAnalysis?.recommendation || 'Injury risk trend reviewed.',
    '',
    'Tactical Recommendation:',
    `Next Action: ${activeStrategicAnalysis?.tacticalRecommendation?.nextAction || tacticalNextAction}`,
    `Why: ${activeStrategicAnalysis?.tacticalRecommendation?.why || tacticalWhy}`,
    `If Ignored: ${activeStrategicAnalysis?.tacticalRecommendation?.ifIgnored || tacticalIfIgnored}`,
    ...((activeStrategicAnalysis?.tacticalRecommendation?.alternatives || [modeScopedAlternative]).slice(0, 3).map((alt, index) => `Alternative ${index + 1}: ${alt}`)),
    ...(activeStrategicAnalysis?.coachNote ? ['', `Coach Note: ${activeStrategicAnalysis.coachNote}`] : []),
  ].join('\n');
  const handleCopyBriefing = useCallback(async () => {
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(briefingText);
        setBriefCopied(true);
        window.setTimeout(() => setBriefCopied(false), 1500);
      }
    } catch {
      // Copy failures should not block analysis flow.
    }
  }, [briefingText]);
  const matchMode = teamMode;
  const isBatting = matchMode === 'BATTING';
  const isBowling = matchMode === 'BOWLING';
  const selectedModeStyle: React.CSSProperties = {
    backgroundColor: 'rgba(245, 158, 11, 0.16)',
    borderColor: 'rgba(245, 158, 11, 0.55)',
    boxShadow: '0 0 0 1px rgba(245, 158, 11, 0.35), 0 10px 30px rgba(245, 158, 11, 0.08)',
    color: 'rgba(253, 230, 138, 0.95)',
    transition: 'all 200ms ease',
  };
  const unselectedModeStyle: React.CSSProperties = {
    backgroundColor: 'transparent',
    borderColor: 'rgba(148, 163, 184, 0.18)',
    boxShadow: 'none',
    color: 'rgba(148, 163, 184, 0.7)',
    transition: 'all 200ms ease',
  };
  const isActivePlayerOut = activeDismissalStatus === 'OUT';
  const showInningsFinishedNotice = useCallback(() => {
    setInningsLockNotice('Overs finished. Innings complete.');
  }, []);
  useEffect(() => {
    if (!inningsLockNotice) return;
    const timeoutId = window.setTimeout(() => setInningsLockNotice(null), 1800);
    return () => window.clearTimeout(timeoutId);
  }, [inningsLockNotice]);
  useEffect(() => {
    if (!rotateBowlerNotice) return;
    const timeoutId = window.setTimeout(() => setRotateBowlerNotice(null), 2200);
    return () => window.clearTimeout(timeoutId);
  }, [rotateBowlerNotice]);
  const handleScore = (runValue: number, ballDirection: 1 | -1 = 1) => {
    if (!activePlayer || isActivePlayerOut) return;

    const direction: 1 | -1 = runValue < 0 ? -1 : ballDirection;
    const normalizedRuns = Math.max(0, Math.floor(Math.abs(runValue)));
    const runDelta = direction === -1
      ? Math.min(normalizedRuns, Math.max(0, activePlayer.runs || 0))
      : normalizedRuns;
    const ballDelta = 1;

    if (direction === -1 && Math.max(0, activePlayer.balls || 0) <= 0) return;
    if (direction === 1 && isInningsFinished) {
      showInningsFinishedNotice();
      return;
    }

    updatePlayer(activePlayer.id, (player) => ({
      runs: direction === -1
        ? Math.max(0, (player.runs || 0) - runDelta)
        : Math.max(0, (player.runs || 0) + runDelta),
      balls: direction === -1
        ? Math.max(0, (player.balls || 0) - ballDelta)
        : Math.max(0, (player.balls || 0) + ballDelta),
    }));

    updateMatchState((prev) => {
      const maxBalls = totalBallsFromOvers(prev.totalOvers);
      return {
        runs: direction === -1
          ? Math.max(0, prev.runs - runDelta)
          : Math.max(0, prev.runs + runDelta),
        ballsBowled: direction === -1
          ? Math.max(0, prev.ballsBowled - ballDelta)
          : isUnlimitedInningsFormat
            ? Math.max(0, prev.ballsBowled + ballDelta)
            : Math.min(maxBalls, prev.ballsBowled + ballDelta),
      };
    });
  };
  const applyBoundaryChange = (boundary: '4' | '6', direction: 1 | -1) => {
    if (!activePlayer || isActivePlayerOut) return;
    if (direction === 1 && isInningsFinished) {
      showInningsFinishedNotice();
      return;
    }
    const runDelta = boundary === '4' ? 4 : 6;

    if (direction === -1) {
      const removeIndex = boundaryEvents.lastIndexOf(boundary);
      if (removeIndex < 0) return;
    }

    updatePlayer(activePlayer.id, (player) => {
      const playerEvents = player.boundaryEvents || [];
      if (direction === 1) {
        return {
          boundaryEvents: [...playerEvents, boundary],
        };
      }

      const playerRemoveIndex = playerEvents.lastIndexOf(boundary);
      if (playerRemoveIndex < 0) return {};
      const nextEvents = [...playerEvents];
      nextEvents.splice(playerRemoveIndex, 1);
      return {
        boundaryEvents: nextEvents,
      };
    });
    handleScore(direction === 1 ? runDelta : -runDelta);
  };

  const handleAddBoundary = (boundary: '4' | '6') => {
    applyBoundaryChange(boundary, 1);
  };

  const handleRemoveBoundary = (boundary: '4' | '6') => {
    applyBoundaryChange(boundary, -1);
  };

  const setBatterDismissalStatus = (nextStatus: DismissalStatus) => {
    if (!activePlayer) return;
    // Flicker fix: dismissal changes stay in local React state + localStorage only (no navigation or forced remount).
    const previousStatus = resolveDismissalStatus(activePlayer);
    const normalizedNextStatus: DismissalStatus = nextStatus === 'OUT' ? 'OUT' : 'NOT_OUT';
    const nextDismissalType = resolveDismissalType(normalizedNextStatus, activePlayer.dismissalType);
    const wasOut = previousStatus === 'OUT';
    const willBeOut = normalizedNextStatus === 'OUT';

    updatePlayer(activePlayer.id, {
      dismissalStatus: normalizedNextStatus,
      isDismissed: willBeOut,
      dismissalType: nextDismissalType,
    });

    if (wasOut !== willBeOut) {
      updateMatchState((prev) => ({
        wickets: willBeOut
          ? Math.min(10, prev.wickets + 1)
          : Math.max(0, prev.wickets - 1),
      }));
    }

    persistDismissalStatusForPlayer(activePlayer.id, normalizedNextStatus, nextDismissalType);
  };

  const panelCardBaseClass =
    'rounded-2xl border border-white/10 bg-white/[0.05] shadow-lg shadow-black/20';
  const stepButtonBaseClass =
    'h-9 w-9 min-h-[36px] min-w-[36px] rounded-xl border border-white/15 bg-white/5 text-slate-100 flex items-center justify-center transition-all duration-200 hover:bg-white/10 hover:brightness-110 active:scale-95 focus:outline-none focus:ring-2 focus:ring-emerald-400/40 disabled:opacity-50 disabled:cursor-not-allowed';
  const pill =
    "h-11 px-5 rounded-full border border-white/25 bg-white/5 text-white/90 " +
    "hover:bg-white/10 hover:border-white/35 transition flex items-center justify-center " +
    "focus:outline-none focus:ring-0";

  const PanelCard = ({
    children,
    className = '',
  }: {
    children: React.ReactNode;
    className?: string;
  }) => <div className={`${panelCardBaseClass} ${className}`}>{children}</div>;

  const Pill = ({
    children,
    tone = 'default',
    className = '',
  }: {
    children: React.ReactNode;
    tone?: 'default' | 'success' | 'warning' | 'info';
    className?: string;
  }) => {
    const toneClass =
      tone === 'success'
        ? 'bg-emerald-500/15 border-emerald-400/35 text-emerald-200'
        : tone === 'warning'
          ? 'bg-amber-500/15 border-amber-400/35 text-amber-200'
          : tone === 'info'
            ? 'bg-cyan-500/15 border-cyan-400/35 text-cyan-200'
            : 'bg-white/5 border-white/15 text-slate-200';

    return (
      <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[10px] font-semibold tracking-wide ${toneClass} ${className}`}>
        {children}
      </span>
    );
  };

  const Stepper = ({
    value,
    onIncrement,
    onDecrement,
    decrementDisabled,
    incrementDisabled,
    valueClassName = 'text-3xl md:text-4xl font-bold text-white min-w-[2.25rem]',
  }: {
    value: number;
    onIncrement: () => void;
    onDecrement: () => void;
    decrementDisabled?: boolean;
    incrementDisabled?: boolean;
    valueClassName?: string;
  }) => (
    <div className="flex items-center justify-center gap-3">
      <button
        type="button"
        onClick={onDecrement}
        disabled={decrementDisabled}
        className={stepButtonBaseClass}
      >
        <Minus className="h-3.5 w-3.5" />
      </button>
      <div className={`tabular-nums leading-none text-center ${valueClassName}`}>{value}</div>
      <button
        type="button"
        onClick={onIncrement}
        disabled={incrementDisabled}
        className={`${stepButtonBaseClass} border-emerald-400/30 bg-emerald-500/20 text-emerald-100 hover:bg-emerald-500/30 hover:border-emerald-300/50`}
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
    </div>
  );

  const MetricCard = ({
    label,
    value,
    onIncrement,
    onDecrement,
    incrementDisabled,
  }: {
    label: string;
    value: number;
    onIncrement: () => void;
    onDecrement: () => void;
    incrementDisabled?: boolean;
  }) => (
    <PanelCard className="p-4 md:p-5 text-center">
      <div className="mb-3 text-xs uppercase tracking-widest text-white/60">{label}</div>
      <Stepper
        value={value}
        onIncrement={onIncrement}
        onDecrement={onDecrement}
        decrementDisabled={value <= 0}
        incrementDisabled={incrementDisabled}
      />
    </PanelCard>
  );

  const RosterDeleteButton = ({
    playerName,
    disabled,
    onDelete,
  }: {
    playerName: string;
    disabled?: boolean;
    onDelete: () => void;
  }) => {
    const [isHoveringDelete, setIsHoveringDelete] = useState(false);
    const [isPressingDelete, setIsPressingDelete] = useState(false);
    const isInteractive = !disabled;
    const backgroundColor = isPressingDelete
      ? 'rgba(220, 38, 38, 0.25)'
      : isHoveringDelete
        ? 'rgba(220, 38, 38, 0.15)'
        : 'transparent';
    const iconColor = isPressingDelete
      ? '#fecaca'
      : isHoveringDelete
        ? '#ef4444'
        : '#94a3b8';
    const ringColor = isPressingDelete
      ? 'rgba(239, 68, 68, 0.45)'
      : isHoveringDelete
        ? 'rgba(239, 68, 68, 0.3)'
        : 'rgba(148, 163, 184, 0.22)';

    return (
      <button
        type="button"
        disabled={disabled}
        onClick={(e) => {
          e.stopPropagation();
          if (!isInteractive) return;
          onDelete();
        }}
        onMouseEnter={() => {
          if (!isInteractive) return;
          setIsHoveringDelete(true);
        }}
        onMouseLeave={() => {
          setIsHoveringDelete(false);
          setIsPressingDelete(false);
        }}
        onMouseDown={() => {
          if (!isInteractive) return;
          setIsPressingDelete(true);
        }}
        onMouseUp={() => setIsPressingDelete(false)}
        onBlur={() => setIsPressingDelete(false)}
        aria-label={`Remove ${playerName} from roster`}
        style={{
          position: 'absolute',
          right: 8,
          top: '50%',
          transform: `translateY(-50%) scale(${isHoveringDelete ? 1.05 : 1})`,
          zIndex: 20,
          width: 36,
          height: 36,
          borderRadius: 8,
          border: 'none',
          backgroundColor,
          color: iconColor,
          cursor: isInteractive ? 'pointer' : 'not-allowed',
          transition: 'all 0.2s ease',
          boxShadow: `0 0 0 1px ${ringColor}${isHoveringDelete ? ', 0 0 12px rgba(239,68,68,0.4)' : ''}`,
          opacity: isInteractive ? 1 : 0.4,
          pointerEvents: 'auto',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Trash2 size={16} />
      </button>
    );
  };

  const StrainIndexCard = () => {
    console.log('StrainIndexCard rendered');
    const radius = 46;
    const circumference = 2 * Math.PI * radius;
    const strokeOffset = circumference - (strainProgress / 100) * circumference;
    const strainButtonBase =
      'inline-flex w-full cursor-pointer select-none items-center justify-center rounded-full px-6 py-2 text-[11px] font-semibold shadow-sm transition-all duration-200 active:scale-95 focus-visible:outline-none focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-45';

    return (
        <div className={`bg-[#162032] rounded-xl p-5 border text-center relative transition-all h-full min-h-[12rem] flex flex-col ${strainCardClass}`}>
          <div className="mt-3 text-sm font-bold uppercase tracking-wide text-slate-300">Strain Index</div>
        <div className="h-[14px]" aria-hidden="true" />
        <div className="flex flex-1 flex-col items-center justify-center py-2">
          <div className="relative h-32 w-32">
            <svg className="h-full w-full -rotate-90" viewBox="0 0 120 120">
              <circle cx="60" cy="60" r={radius} className="stroke-slate-700/70" strokeWidth="10" fill="transparent" />
              <motion.circle
                cx="60"
                cy="60"
                r={radius}
                className={strainStrokeClass}
                stroke="currentColor"
                strokeWidth="10"
                strokeLinecap="round"
                fill="transparent"
                strokeDasharray={circumference}
                animate={{ strokeDashoffset: strokeOffset }}
                transition={{ duration: 0.26, ease: 'easeOut' }}
              />
            </svg>
            <div className="absolute inset-0 flex items-center justify-center">
              <div className={`text-5xl font-mono font-semibold leading-none ${strainTextClass}`}>{clampedStrainIndex}/5</div>
            </div>
          </div>
          <span className={`mt-3 inline-flex items-center rounded-full border px-2.5 py-0.5 text-[10px] font-semibold tracking-wide ${strainBadgeClass}`}>
            {strainStatusText}
          </span>
          <div className="min-h-[18px] mt-2 flex items-center justify-center">
            {isStrainMax && (
              <span className="inline-flex items-center rounded-full border border-amber-300/35 bg-amber-400/10 px-2 py-0.5 text-[10px] font-semibold text-amber-200">
                Max
              </span>
            )}
          </div>
          <div className="mt-3 grid w-full grid-cols-3 gap-4">
            <button
              type="button"
              onClick={() => applyStrainDelta(1, 0.3)}
              disabled={isStrainMax}
              className={`${strainButtonBase} bg-emerald-500/10 border border-emerald-400/30 text-emerald-200 hover:bg-emerald-500/20 hover:border-emerald-400/60 hover:shadow-[0_0_18px_rgba(16,185,129,0.25)] focus-visible:ring-emerald-400/45`}
            >
              Minor
            </button>
            <button
              type="button"
              onClick={() => applyStrainDelta(2, 0.8)}
              disabled={isStrainMax}
              className={`${strainButtonBase} bg-emerald-500/15 border border-emerald-400/40 text-white hover:bg-emerald-500/25 hover:shadow-[0_0_22px_rgba(16,185,129,0.35)] focus-visible:ring-emerald-400/45`}
            >
              Heavy
            </button>
            <button
              type="button"
              onClick={handleResetStrain}
              className={`${strainButtonBase} bg-rose-500/10 border border-rose-400/30 text-rose-200 hover:bg-rose-500/20 hover:border-rose-400/60 hover:shadow-[0_0_18px_rgba(244,63,94,0.25)] focus-visible:ring-rose-400/35`}
            >
              Reset
            </button>
          </div>
        </div>
      </div>
    );
  };

  const handleTacticalScroll = () => {
    const container = scrollRef.current;
    if (!container) return;
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    stickToBottomRef.current = distanceFromBottom < 80;
  };

  const scrollCoachOutputToBottom = (behavior: ScrollBehavior = 'smooth') => {
    const container = scrollRef.current;
    if (container) {
      container.scrollTo({ top: container.scrollHeight, behavior });
    } else {
      bottomRef.current?.scrollIntoView({ behavior, block: 'end' });
    }
  };

  const primeCoachAutoScroll = () => {
    stickToBottomRef.current = true;
    requestAnimationFrame(() => {
      scrollCoachOutputToBottom('smooth');
    });
  };

  const closeMatchModeGuard = useCallback(() => {
    pendingMatchModeActionRef.current = null;
    setShowMatchModeGuard(false);
  }, []);

  const requireMatchMode = useCallback(
    (requiredMode: TeamMode, onAllowed: () => void) => {
      if (teamMode === requiredMode) {
        onAllowed();
        return true;
      }
      pendingMatchModeActionRef.current = onAllowed;
      setShowMatchModeGuard(true);
      return false;
    },
    [teamMode]
  );

  const runBattingGuardedAction = useCallback(
    (onAllowed: () => void) => {
      requireMatchMode('BATTING', onAllowed);
    },
    [requireMatchMode]
  );

  const handleSwitchToBattingAndContinue = useCallback(() => {
    const pendingAction = pendingMatchModeActionRef.current;
    pendingMatchModeActionRef.current = null;
    setShowMatchModeGuard(false);
    setTeamMode('BATTING');
    if (pendingAction) {
      requestAnimationFrame(() => pendingAction());
    }
  }, [setTeamMode]);

  const runCoachAgentAuto = useCallback(
    async (modeOverride?: TeamMode) => {
      setShowCoachInsights(true);
      primeCoachAutoScroll();
      return runAgent('auto', 'button_click', {
        teamMode: modeOverride || teamMode,
        focusRole,
        strainIndex: clampedStrainIndex,
      });
    },
    [clampedStrainIndex, focusRole, primeCoachAutoScroll, runAgent, teamMode]
  );

  const runCoachWithFallback = useCallback(async (): Promise<{ recommendation: SuggestedBowlerRecommendation | null; raw?: OrchestrateResponse }> => {
    if (import.meta.env.DEV) {
      console.log('[rotate-bowler] click');
    }

    const routeResult = await runCoachAgentAuto('BOWLING');
    const routeSuggestion =
      routeResult?.suggestedBowler
      || (routeResult?.response ? normalizeSuggestedBowler(routeResult.response, players, activePlayer?.id, 'BOWLING') : null);
    if (routeResult?.response && routeSuggestion) {
      return { recommendation: routeSuggestion, raw: routeResult.response };
    }

    if (import.meta.env.DEV) {
      console.log('[rotate-bowler] falling back to full analysis');
    }

    const fullResult = await runAgent('full', 'button_click', {
      teamMode: 'BOWLING',
      focusRole: 'BOWLER',
      strainIndex: clampedStrainIndex,
    });
    const fullSuggestion =
      fullResult?.suggestedBowler
      || (fullResult?.response ? normalizeSuggestedBowler(fullResult.response, players, activePlayer?.id, 'BOWLING') : null);
    if (fullResult?.response && fullSuggestion) {
      return { recommendation: fullSuggestion, raw: fullResult.response };
    }

    return { recommendation: null, raw: fullResult?.response || routeResult?.response };
  }, [activePlayer?.id, clampedStrainIndex, players, runAgent, runCoachAgentAuto]);

  const closeRotateBowlerConfirm = useCallback(() => {
    setShowRotateBowlerConfirm(false);
    setRotateBowlerSuggestion(null);
  }, []);

  const handleSwitchToSuggestedBowler = useCallback(() => {
    if (!rotateBowlerSuggestion) return;
    const suggestedIdKey = baselineKey(rotateBowlerSuggestion.bowlerId);
    const suggestedNameKey = baselineKey(rotateBowlerSuggestion.bowlerName);
    const resolvedPlayer =
      players.find((player) => baselineKey(player.id) === suggestedIdKey)
      || players.find((player) => baselineKey(player.name) === suggestedNameKey);
    const suggestedPlayer = resolvedPlayer && resolvedPlayer.inRoster !== false ? resolvedPlayer : null;

    if (!suggestedPlayer) {
      setRotateBowlerNotice('Suggested bowler not found in roster.');
      closeRotateBowlerConfirm();
      return;
    }

    if (activePlayer && baselineKey(activePlayer.id) === baselineKey(suggestedPlayer.id)) {
      setRotateBowlerNotice('Already selected.');
      closeRotateBowlerConfirm();
      return;
    }

    setTeamMode('BOWLING');
    setActivePlayerId(suggestedPlayer.id);
    setRotateBowlerNotice(`Switched to ${suggestedPlayer.name}.`);
    closeRotateBowlerConfirm();
  }, [activePlayer, closeRotateBowlerConfirm, players, rotateBowlerSuggestion, setActivePlayerId, setTeamMode]);

  const handleRotateBowler = useCallback(async () => {
    setRotateBowlerNotice(null);
    const rotationPool = players.filter(
      (player) => player.inRoster !== false && isEligibleForMode(player, 'BOWLING')
    );
    if (rotationPool.length < 2) {
      setRotateBowlerSuggestion(null);
      setShowRotateBowlerConfirm(false);
      setRotateBowlerNotice('No eligible replacement available for current mode.');
      return;
    }

    const coachResult = await runCoachWithFallback();
    let suggestion = coachResult.recommendation;
    if (suggestion) {
      const resolved = resolveSuggestionPlayer(suggestion, players);
      if (!resolved || !isEligibleForMode(resolved, 'BOWLING')) {
        suggestion = null;
      }
    }

    if (!suggestion) {
      const activeIdKey = baselineKey(activePlayer?.id || '');
      const fallbackCandidate = [...rotationPool]
        .filter((player) => baselineKey(player.id) !== activeIdKey)
        .sort((a, b) => {
          const fatigueDiff = safeNum(a.fatigue, 10) - safeNum(b.fatigue, 10);
          if (fatigueDiff !== 0) return fatigueDiff;
          const oversDiff = safeNum(a.overs, 999) - safeNum(b.overs, 999);
          if (oversDiff !== 0) return oversDiff;
          return a.name.localeCompare(b.name);
        })[0];

      if (fallbackCandidate) {
        suggestion = {
          bowlerId: fallbackCandidate.id,
          bowlerName: fallbackCandidate.name,
          reason: 'Fallback selection (router had no suggestion)',
        };
      }

      if (!coachResult.raw) {
        setRotateBowlerNotice('Coach analysis failed — check API response.');
      }
    }

    if (!suggestion) {
      setRotateBowlerSuggestion(null);
      setShowRotateBowlerConfirm(false);
      setRotateBowlerNotice('No eligible replacement available for current mode.');
      return;
    }

    setRotateBowlerSuggestion(suggestion);
    setShowRotateBowlerConfirm(true);
  }, [activePlayer?.id, players, runCoachWithFallback]);

  const handleRunCoachAuto = useCallback(() => {
    const execute = (modeOverride?: TeamMode) => {
      void runCoachAgentAuto(modeOverride);
    };

    if (focusRole === 'BATTER') {
      runBattingGuardedAction(() => execute('BATTING'));
      return;
    }

    execute();
  }, [focusRole, runBattingGuardedAction, runCoachAgentAuto]);

  const handleRunCoachFull = useCallback((event?: React.MouseEvent<HTMLButtonElement>) => {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    const execute = (modeOverride?: TeamMode) => {
      setShowCoachInsights(true);
      primeCoachAutoScroll();
      void runAgent('full', 'button_click', {
        teamMode: modeOverride || teamMode,
        focusRole,
        strainIndex: clampedStrainIndex,
      });
    };

    if (focusRole === 'BATTER') {
      runBattingGuardedAction(() => execute('BATTING'));
      return;
    }

    execute();
  }, [clampedStrainIndex, focusRole, primeCoachAutoScroll, runAgent, runBattingGuardedAction, teamMode]);

  // Auto-follow new analysis output while user is near the bottom.
  useEffect(() => {
    if (!isCoachOutputState) return;
    if (!stickToBottomRef.current) return;
    scrollCoachOutputToBottom('smooth');
  }, [agentState, aiAnalysis, riskAnalysis, tacticalAnalysis, strategicAnalysis, combinedAnalysis, combinedDecision, finalRecommendation, orchestrateMeta, agentWarning, substitutionRecommendation, isCoachOutputState]);

  return (
    <motion.div 
      initial={{ opacity: 0 }} 
      animate={{ opacity: 1 }}
      className="px-4 md:px-6 pt-5 pb-6 w-full flex flex-col flex-1 h-full min-h-0"
    >
      {/* Context Bar */}
      <div className="flex-none bg-[#0F172A] border border-white/5 rounded-xl px-3 py-4 flex flex-wrap items-center gap-6 mb-6">
        <GlowingBackButton onClick={onBack} label="Match Setup" />
        <div className="h-6 w-px bg-transparent hidden md:block" />
        <div className="flex items-center gap-6 text-xs font-bold tracking-wider text-slate-400">
           <span className="flex items-center gap-2"><Trophy className="w-3.5 h-3.5" /> {matchContext.format}</span>
           <span className="flex items-center gap-2 text-amber-400"><Zap className="w-3.5 h-3.5" /> {matchContext.phase}</span>
           <span className="flex items-center gap-2"><Activity className="w-3.5 h-3.5" /> {matchContext.pitch.toUpperCase()} INTENSITY</span>
           <span className="flex items-center gap-2 text-blue-400"><Thermometer className="w-3.5 h-3.5" /> {matchContext.weather.toUpperCase()}</span>
           <span className="flex items-center gap-1.5 text-emerald-400">
             SCORE
             <input
               type="number"
               min={0}
               value={matchState.runs}
               onChange={(e) => updateMatchState({ runs: Math.max(0, Number(e.target.value) || 0) })}
               className="w-14 bg-slate-900/40 border border-white/10 rounded px-1.5 py-0.5 font-mono text-emerald-300 focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
               aria-label="Current score"
             />
             /
             <input
               type="number"
               min={0}
               max={10}
               value={matchState.wickets}
               onChange={(e) => updateMatchState({ wickets: Math.min(10, Math.max(0, Number(e.target.value) || 0)) })}
               className="w-10 bg-slate-900/40 border border-white/10 rounded px-1.5 py-0.5 font-mono text-emerald-300 focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
               aria-label="Wickets"
             />
           </span>
           <span className="flex items-center gap-1.5">
             OVER
             <span className="w-14 bg-slate-900/40 border border-white/10 rounded px-1.5 py-0.5 font-mono text-slate-200 text-center">{overStr}</span>
             /
             <input
               type="number"
               min={1}
               step="1"
               value={matchState.totalOvers}
               onChange={(e) => updateMatchState({ totalOvers: Math.max(1, Number(e.target.value) || 1) })}
               className="w-12 bg-slate-900/40 border border-white/10 rounded px-1.5 py-0.5 font-mono text-slate-200 focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
               aria-label="Total overs"
             />
             <span className="text-slate-500">balls</span>
             <input
               type="number"
               min={0}
               max={isUnlimitedInningsFormat ? undefined : totalBalls}
               step="1"
               value={ballsBowled}
               onChange={(e) => {
                 const nextBalls = Math.max(0, Number(e.target.value) || 0);
                 updateMatchState({ ballsBowled: isUnlimitedInningsFormat ? nextBalls : Math.min(totalBalls, nextBalls) });
               }}
               className="w-14 bg-slate-900/40 border border-white/10 rounded px-1.5 py-0.5 font-mono text-slate-200 focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
               aria-label="Balls bowled"
             />
           </span>
           <span className="flex items-center gap-1.5 text-rose-400">
             TARGET
             <input
               type="number"
               min={0}
               value={matchState.target ?? ''}
               onChange={(e) => {
                 const value = e.target.value;
                 updateMatchState({ target: value === '' ? undefined : Math.max(0, Number(value) || 0) });
               }}
               className="w-14 bg-slate-900/40 border border-white/10 rounded px-1.5 py-0.5 font-mono text-rose-300 focus:outline-none focus:ring-2 focus:ring-rose-500/40"
               aria-label="Target runs"
             />
           </span>
           <span className="ml-auto flex items-center gap-2">
             MODE
             <span
               role="tablist"
               aria-label="Match mode"
               className="inline-flex items-center rounded-full border border-white/10 bg-slate-900/45 p-1"
             >
               <button
                 type="button"
                 role="tab"
                 aria-selected={isBatting}
                 aria-pressed={isBatting}
                 onClick={() => setTeamMode('BATTING')}
                 className="rounded-full border px-3 py-1 text-[10px] font-bold"
                 style={isBatting ? selectedModeStyle : unselectedModeStyle}
               >
                 BATTING
               </button>
               <button
                 type="button"
                 role="tab"
                 aria-selected={isBowling}
                 aria-pressed={isBowling}
                 onClick={() => setTeamMode('BOWLING')}
                 className="rounded-full border px-3 py-1 text-[10px] font-bold"
                 style={isBowling ? selectedModeStyle : unselectedModeStyle}
               >
                 BOWLING
               </button>
             </span>
           </span>
        </div>
      </div>

      <div className="w-full flex-1 min-h-0">
      <div data-testid="dashboard-grid" className="h-full min-h-0 grid lg:grid-cols-12 gap-6 mt-0 items-stretch">
        
        {/* LEFT: ROSTER (EDITABLE) */}
        <div className="lg:col-span-3 h-full flex flex-col gap-4 min-h-0">
          <div className="bg-[#0F172A] border border-white/5 rounded-2xl h-full min-h-0 flex-1 flex flex-col overflow-hidden">
            <div className="px-5 py-6 border-b border-white/5 bg-slate-900/50 flex items-center justify-between">
               <h3 className="text-sm dashboard-panel-title-tall font-bold text-slate-400 flex items-center gap-2">
                 <Users className="w-5 h-5 dashboard-icon-tall" /> Roster ({totalCount}/{MAX_ROSTER})
               </h3>
               {isRosterFull && (
                 <span className="text-[10px] bg-amber-500/10 text-amber-400 px-2 py-0.5 rounded border border-amber-500/20">
                   Full
                 </span>
               )}
            </div>
            
            <div className="px-4 py-5 space-y-3 flex-1 min-h-0 overflow-y-auto">
              {rosterMutationError && (
                <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-[11px] text-rose-200">
                  {rosterMutationError}
                </div>
              )}
              {hasRosterPlayers ? rosterPlayers.map((player: Player) => {
                const isSelected = activePlayer?.id === player.id;
                return (
                  <div key={player.id} className="relative group">
                    <button type="button"
                      onClick={() => setActivePlayerId(player.id)}
                      className={`w-full flex items-center gap-3 p-3 rounded-xl transition-all border text-left ${
                        isSelected
                          ? 'bg-emerald-500/10 border-emerald-500/50' 
                          : 'bg-transparent border-transparent hover:bg-white/5'
                      }`}
                    >
                      <div className={`w-8 h-8 dashboard-avatar-tall rounded-full flex items-center justify-center text-xs font-bold shadow-lg shrink-0 ${
                        isSelected ? 'bg-emerald-500 text-black' : 'bg-slate-800 text-slate-400 group-hover:bg-slate-700'
                      }`}>
                        {player.name.charAt(0)}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className={`font-semibold text-sm dashboard-roster-name-tall ${isSelected ? 'text-white' : 'text-slate-300'}`}>
                          <div className="flex items-center min-w-0">
                            <span className="truncate">{player.name}</span>
                            {player.isUnfit && <span className="ml-2 inline-block h-2.5 w-2.5 rounded-full bg-red-500 animate-pulse shadow-[0_0_10px_rgba(239,68,68,0.75)]" />}
                          </div>
                        </div>
                        <div className="text-[10px] dashboard-roster-role-tall uppercase font-bold text-slate-500 truncate">{player.role}</div>
                      </div>
                    </button>
                    
                    <RosterDeleteButton
                      playerName={player.name}
                      disabled={!player.id}
                      onDelete={() => removeFromRoster(player.id)}
                    />
                  </div>
                );
              }) : isLoadingRosterPlayers ? (
                <div className="rounded-xl border border-white/10 bg-slate-900/50 px-4 py-6 text-center flex-1 flex items-center justify-center">
                  <div className="flex flex-col items-center justify-center">
                    <p className="text-sm font-semibold text-slate-200/80">Loading players...</p>
                    <p className="mt-1 text-xs text-slate-400/70">
                      Fetching baseline players from the API.
                    </p>
                  </div>
                </div>
              ) : (
                <div className="flex-1" />
              )}

              {!isRosterEmpty && (
                <div className="mt-2 pt-2 border-t border-white/5">
                  <button type="button"
                    onClick={onGoToBaselines}
                    disabled={isRosterFull}
                    title={isRosterFull ? `Roster is full (${MAX_ROSTER}/${MAX_ROSTER}).` : 'Open baselines to add a player.'}
                    className="w-full py-3 rounded-xl border border-indigo-500/30 bg-indigo-500/10 text-indigo-200 hover:bg-indigo-500/20 transition-all text-sm font-medium disabled:opacity-60 disabled:cursor-not-allowed"
                  >
                    {isRosterFull ? `Roster Full (${MAX_ROSTER}/${MAX_ROSTER})` : 'Add Player'}
                  </button>
                  {isRosterFull && (
                    <p className="mb-2 text-[11px] text-amber-300 text-center">
                      Roster full. Deactivate a player in Baselines before adding another.
                    </p>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* CENTER: METRICS */}
        <div className="lg:col-span-6 h-full flex flex-col gap-4 min-h-0">
          <div className={`bg-[#0F172A] border rounded-2xl h-full min-h-0 flex-1 px-6 py-6 dashboard-center-panel-y relative flex flex-col overflow-hidden transition-all duration-500 ${
            (activePlayer && (activePlayer.status === 'EXCEEDED LIMIT' || activePlayer.injuryRisk === 'High' || activePlayer.injuryRisk === 'Critical'))
              ? 'border-rose-500/50 shadow-[0_0_30px_rgba(225,29,72,0.15)]' 
              : 'border-white/5'
          }`}>
            {/* Background Decor */}
             <div className="absolute top-0 right-0 w-64 h-64 bg-emerald-500/5 blur-[80px] rounded-full pointer-events-none" />

            <div className="flex justify-between items-start mb-8 relative z-10 shrink-0">
              <div>
                 <div className="flex items-center gap-2 mb-1">
                   <Activity className={`w-6 h-6 dashboard-icon-tall-lg ${activePlayer && (activePlayer.injuryRisk === 'High' || activePlayer.injuryRisk === 'Critical') ? 'text-rose-500 animate-pulse' : 'text-emerald-400'}`} />
                   <span className={`text-base font-bold uppercase tracking-widest ${activePlayer && (activePlayer.injuryRisk === 'High' || activePlayer.injuryRisk === 'Critical') ? 'text-rose-500' : 'text-emerald-400'}`}>
                     {telemetryView === 'batting' ? 'Batsman Live Telemetry' : 'Bowler Live Telemetry'}
                   </span>
                 </div>
                 <h2 className="text-3xl dashboard-main-heading-tall font-bold text-white">{activePlayer ? activePlayer.name : 'Select Player'}</h2>
              </div>
              {activePlayer && (
                <div className="flex flex-col items-end gap-2">
                  <div className="px-3 py-1 bg-slate-800 rounded border border-slate-700 text-xs font-mono text-slate-400">
                    ID: {activePlayer.id.toUpperCase()}
                  </div>
                  {telemetryView === 'batting' && (
                    <span className={`inline-flex rounded-full border px-3 py-1 text-[11px] font-semibold tracking-wide ${dismissalStatusClass}`}>
                      {dismissalStatusLabel}
                    </span>
                  )}
                </div>
              )}
            </div>

            {activePlayer?.role === 'All-rounder' && (
              <div className="relative z-10 mb-4">
                <div className="inline-flex rounded-lg border border-white/10 bg-slate-900/40 p-1">
                  <button
                    type="button"
                    onClick={() => setArTelemetryView('batting')}
                    className={`px-3 py-1.5 text-xs font-bold rounded-md transition-colors ${
                      arTelemetryView === 'batting' ? 'bg-emerald-500/20 text-emerald-300' : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    Batting View
                  </button>
                  <button
                    type="button"
                    onClick={() => setArTelemetryView('bowling')}
                    className={`px-3 py-1.5 text-xs font-bold rounded-md transition-colors ${
                      arTelemetryView === 'bowling' ? 'bg-emerald-500/20 text-emerald-300' : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    Bowling View
                  </button>
                </div>
              </div>
            )}

            {/* Main Stats Panels */}
            <div className="relative z-10 flex-1 min-h-0 overflow-y-auto overscroll-contain pr-2">
              {activePlayer ? (
              <AnimatePresence mode="wait" initial={false}>
                {telemetryView === 'batting' ? (
                  <motion.div
                    key="batsman-telemetry"
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -8 }}
                    transition={{ duration: 0.2 }}
                    className="mx-auto flex min-h-0 w-full max-w-[980px] flex-col px-4 md:px-6"
                  >
                  {(isInningsFinished || inningsLockNotice) && (
                    <div className="mb-3 rounded-lg border border-amber-300/30 bg-amber-500/10 px-3 py-2 text-xs font-medium text-amber-200">
                      {inningsLockNotice || 'Overs finished. Innings complete.'}
                    </div>
                  )}
                  <div className="grid grid-cols-1 gap-4 md:grid-cols-2 md:gap-5">
                    <MetricCard
                      label="Runs"
                      value={activePlayer.runs}
                      onIncrement={() => runBattingGuardedAction(() => handleScore(1))}
                      onDecrement={() => runBattingGuardedAction(() => handleScore(-1))}
                      incrementDisabled={isInningsFinished || !activePlayer || isActivePlayerOut}
                    />

                    <MetricCard
                      label="Balls Faced"
                      value={activePlayer.balls}
                      onIncrement={() => runBattingGuardedAction(() => handleScore(0))}
                      onDecrement={() => runBattingGuardedAction(() => handleScore(0, -1))}
                      incrementDisabled={isInningsFinished || !activePlayer || isActivePlayerOut}
                    />

                    <PanelCard className="p-4 md:p-5">
                      <div className="mb-3">
                        <div className="flex items-center justify-between relative overflow-visible">
                          <div className="flex items-center gap-3 relative overflow-visible">
                            <span className="text-sm font-semibold tracking-[0.18em] uppercase text-white/85">
                              STRIKE RATE
                            </span>

                            <span
                              style={{
                                display: "inline-block",
                                width: 8,
                                height: 8,
                                borderRadius: 9999,
                                background: "#ef4444",
                                boxShadow: "0 0 10px rgba(239,68,68,0.85)",
                                marginLeft: 10,
                                transform: "translateY(-1px)"
                              }}
                            />
                          </div>
                          <div className="rounded-xl border border-white/15 bg-slate-900/60 px-3 py-2">
                            <div className="text-[10px] uppercase tracking-[0.16em] text-white/40">SR</div>
                            <div className={`text-xl font-bold tabular-nums leading-none ${pressureToneClass}`}>
                              {batsmanStrikeRate.toFixed(1)}
                            </div>
                          </div>
                        </div>
                      </div>

                      <div className="mb-3 grid grid-cols-2 gap-2">
                        <div className="rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2">
                          <div className="text-[10px] uppercase tracking-[0.16em] text-white/50">Required SR</div>
                          <div className="mt-1 text-sm font-semibold tabular-nums text-white">{requiredStrikeRate.toFixed(1)}</div>
                        </div>
                        <div className="rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2">
                          <div className="text-[10px] uppercase tracking-[0.16em] text-white/50">Required RR</div>
                          <div className="mt-1 text-sm font-semibold tabular-nums text-white">{requiredRunRate.toFixed(2)}</div>
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center gap-2 text-sm text-white/80">
                        <span className="font-medium text-white/80">
                          Current RR: <span className="tabular-nums text-white/95">{currentRunRate.toFixed(2)}</span>
                        </span>
                        <span className="h-1 w-1 rounded-full bg-white/30" />
                        <span className="font-medium text-white/80">
                          Projection: <span className="tabular-nums text-white/95">{projectedScoreAtCurrentRR.toFixed(0)}</span>
                        </span>
                        <Pill className="ml-auto" tone={chaseStatus.tone}>{chaseStatus.label}</Pill>
                      </div>
                    </PanelCard>

                    <PanelCard className="p-4 md:p-5">
                      <div className="mb-3 flex items-center justify-between">
                        <label className="text-sm font-semibold tracking-[0.18em] uppercase text-white/85">Boundaries</label>
                        <span className="text-[10px] uppercase tracking-[0.16em] text-white/35">Tap to adjust</span>
                      </div>

                      <div className="space-y-2.5">
                        <div className="flex items-center justify-between rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2.5">
                          <div>
                            <div className="text-sm font-medium text-white/90">Four</div>
                            <div className="text-[10px] font-medium uppercase tracking-[0.14em] text-white/80">4 runs</div>
                          </div>
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => runBattingGuardedAction(() => handleRemoveBoundary('4'))}
                              aria-label="Remove four boundary"
                              disabled={foursCount <= 0 || !activePlayer || isActivePlayerOut}
                              className={stepButtonBaseClass}
                            >
                              <Minus className="h-3.5 w-3.5" />
                            </button>
                            <div className="min-w-[2.25rem] rounded-lg border border-white/15 bg-slate-900/70 px-2 py-1 text-center text-sm font-semibold tabular-nums text-white">
                              {foursCount}
                            </div>
                            <button
                              type="button"
                              onClick={() => runBattingGuardedAction(() => handleAddBoundary('4'))}
                              aria-label="Add four boundary"
                              disabled={!activePlayer || isActivePlayerOut || isInningsFinished}
                              className={`${stepButtonBaseClass} border-emerald-400/30 bg-emerald-500/20 text-emerald-100 hover:bg-emerald-500/30 hover:border-emerald-300/50`}
                            >
                              <Plus className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        </div>

                        <div className="flex items-center justify-between rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2.5">
                          <div>
                            <div className="text-sm font-medium text-white/90">Six</div>
                            <div className="text-[10px] font-medium uppercase tracking-[0.14em] text-white/80">6 runs</div>
                          </div>
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => runBattingGuardedAction(() => handleRemoveBoundary('6'))}
                              aria-label="Remove six boundary"
                              disabled={sixesCount <= 0 || !activePlayer || isActivePlayerOut}
                              className={stepButtonBaseClass}
                            >
                              <Minus className="h-3.5 w-3.5" />
                            </button>
                            <div className="min-w-[2.25rem] rounded-lg border border-white/15 bg-slate-900/70 px-2 py-1 text-center text-sm font-semibold tabular-nums text-white">
                              {sixesCount}
                            </div>
                            <button
                              type="button"
                              onClick={() => runBattingGuardedAction(() => handleAddBoundary('6'))}
                              aria-label="Add six boundary"
                              disabled={!activePlayer || isActivePlayerOut || isInningsFinished}
                              className={`${stepButtonBaseClass} border-emerald-400/30 bg-emerald-500/20 text-emerald-100 hover:bg-emerald-500/30 hover:border-emerald-300/50`}
                            >
                              <Plus className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        </div>
                      </div>
                    </PanelCard>

                    <PanelCard className="p-4 md:p-5 md:col-span-2 overflow-visible">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <div className="text-sm font-semibold text-white/90">Pressure Index</div>
                          {inningsComplete && (
                            <span className="inline-flex rounded-full border border-amber-300/35 bg-amber-500/12 px-2 py-0.5 text-[10px] font-semibold tracking-wide text-amber-200">
                              Overs finished
                            </span>
                          )}
                        </div>
                        <div className={`text-2xl font-bold tabular-nums ${pressureToneClass}`}>
                          {Math.max(0, Math.min(10, pressureIndex ?? 0)).toFixed(1)}
                        </div>
                      </div>
                      {(() => {
                        // use the SAME value used to display "6.2" on the right
                        const raw = pressureIndex ?? 0;
                        const clamped = Math.max(0, Math.min(10, raw));
                        const pct = (clamped / 10) * 100;

                        return (
                          <div className="mt-3">
                            {/* Rail wrapper ensures visibility above overlays */}
                            <div className="relative z-10 overflow-visible">
                              <div
                                className="relative h-3 w-full rounded-full"
                                style={{
                                  background: "linear-gradient(90deg, #34d399 0%, #fbbf24 40%, #fb923c 65%, #ef4444 100%)",
                                  boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.12), 0 0 18px rgba(255,255,255,0.06)",
                                }}
                              />

                              {/* knob */}
                              <div
                                className="absolute top-1/2"
                                style={{
                                  left: `${pct}%`,
                                  transform: "translate(-50%, -50%)",
                                  zIndex: 20,
                                  transition: "left 300ms ease-out",
                                }}
                              >
                                <div
                                  style={{
                                    width: 16,
                                    height: 16,
                                    borderRadius: 9999,
                                    background: "#fff7ed",
                                    border: "1px solid rgba(255,255,255,0.55)",
                                    boxShadow: "0 0 16px rgba(255,220,150,0.9)",
                                    position: "relative",
                                  }}
                                >
                                  <div
                                    style={{
                                      position: "absolute",
                                      left: "50%",
                                      top: "50%",
                                      width: 6,
                                      height: 6,
                                      borderRadius: 9999,
                                      transform: "translate(-50%, -50%)",
                                      background: "rgba(251,191,36,0.95)",
                                    }}
                                  />
                                </div>
                              </div>
                            </div>
                          </div>
                        );
                      })()}

                      <div className="mt-3 flex items-center justify-between text-xs font-medium">
                        <span className="text-emerald-300">LOW &lt;4</span>
                        <span className="text-amber-200">MODERATE 4–7</span>
                        <span className="text-red-300">HIGH &gt;7</span>
                      </div>
                    </PanelCard>

                    <PanelCard className="md:col-span-2">
                      <div className="mt-4 rounded-2xl border border-white/10 bg-white/[0.03] p-6 shadow-[0_10px_30px_rgba(0,0,0,0.35)]">
                        <div className="flex flex-col gap-4">
                          <div className="-mt-[10px] text-xs font-semibold tracking-[0.2em] uppercase text-white/60">
                            Dismissal Controls
                          </div>

                          {/* Prevent click flicker: controls stay as local React updates and use explicit button types (no implicit form submit/remount). */}
                          <div className="flex items-center justify-start gap-4">
                            <button
                              type="button"
                              onClick={() => runBattingGuardedAction(() => setBatterDismissalStatus('OUT'))}
                              className={`dismissal-pill ${pill}`}
                            >
                              Mark Out
                            </button>

                            <button
                              type="button"
                              onClick={() => runBattingGuardedAction(() => {
                                const correctedScore = Math.max(0, matchState.runs - activePlayer.runs);
                                const correctedBalls = Math.max(0, ballsBowled - activePlayer.balls);
                                const wasOut = activeDismissalStatus === 'OUT';
                                updatePlayer(activePlayer.id, {
                                  runs: 0,
                                  balls: 0,
                                  boundaryEvents: [],
                                  dismissalStatus: 'NOT_OUT',
                                  isDismissed: false,
                                  dismissalType: 'Not Out',
                                });
                                updateMatchState((prev) => ({
                                  runs: correctedScore,
                                  ballsBowled: correctedBalls,
                                  wickets: wasOut ? Math.max(0, prev.wickets - 1) : prev.wickets,
                                }));
                                persistDismissalStatusForPlayer(activePlayer.id, 'NOT_OUT', 'Not Out');
                              })}
                              className={`dismissal-pill ${pill}`}
                            >
                              Reset Innings
                            </button>
                          </div>
                        </div>
                      </div>
                    </PanelCard>

                    {showCoachInsights && (
                      <div className="md:col-span-2 mt-6">
                        <PressureForecastChart
                          currentPressure={pressureIndex}
                          requiredRunRate={requiredRunRate}
                          currentRunRate={currentRunRate}
                          wicketsDown={matchState.wickets}
                          phase={matchContext.phase}
                        />
                      </div>
                    )}
                  </div>
                  </motion.div>
                ) : (
                  <motion.div
                    key="bowler-telemetry"
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -8 }}
                    transition={{ duration: 0.2 }}
                    className="min-h-0 flex flex-col"
                  >
                  {showQuotaLockState && (
                    <div className="mb-6 bg-purple-500/10 border border-purple-500/30 rounded-xl p-4 flex items-center gap-4 animate-in fade-in slide-in-from-top-4 backdrop-blur-md shadow-2xl shadow-purple-900/10">
                      <div className="w-10 h-10 rounded-full bg-purple-500/20 flex items-center justify-center border border-purple-500/30 shrink-0">
                        <Shield className="w-5 h-5 text-purple-300" />
                      </div>
                      <div>
                        <h4 className="text-sm font-bold text-purple-300 uppercase tracking-wide">Overs quota completed</h4>
                        <p className="text-xs text-purple-200/75 mt-0.5">Overs quota completed - player cannot bowl further in this format.</p>
                      </div>
                    </div>
                  )}
                  {!showQuotaLockState && isMedicalCritical && (
                    <div className="mb-6 bg-rose-950/40 border border-rose-500/30 rounded-xl p-4 flex flex-col sm:flex-row items-center justify-between gap-4 animate-in fade-in slide-in-from-top-4 backdrop-blur-md shadow-2xl shadow-rose-900/10">
                      <div className="flex items-center gap-4 w-full sm:w-auto">
                        <div className="w-10 h-10 rounded-full bg-rose-500/20 flex items-center justify-center border border-rose-500/30 shrink-0 animate-pulse">
                          <AlertTriangle className="w-6 h-6 text-rose-400" />
                        </div>
                        <div>
                          <h4 className="text-sm font-bold text-rose-400 uppercase tracking-wide flex items-center gap-2">
                            High Injury Risk
                            <span className="px-1.5 py-0.5 rounded text-[9px] bg-rose-500/20 text-rose-300 border border-rose-500/20 animate-pulse">CRITICAL</span>
                          </h4>
                          <p className="text-xs text-rose-200/70 mt-0.5">Safety thresholds exceeded. Recommend immediate substitution.</p>
                        </div>
                      </div>
                      <button type="button"
                        onClick={handleRemoveActive}
                        className="w-full sm:w-auto px-4 py-2.5 bg-gradient-to-r from-rose-700 to-rose-600 hover:from-rose-600 hover:to-rose-500 text-white text-xs font-bold rounded-lg transition-all shadow-lg shadow-rose-900/30 hover:shadow-rose-900/50 flex items-center justify-center gap-2 whitespace-nowrap active:scale-95 border border-rose-500/30"
                      >
                        <LogOut className="w-4 h-4" /> Remove from Active Squad
                      </button>
                    </div>
                  )}

                  <div className="grid grid-cols-2 gap-4 mb-8">
                    <div data-testid="overs-bowled" className={`bg-[#162032] rounded-xl p-6 md:p-7 border text-center relative group transition-all h-full min-h-[13.5rem] flex flex-col ${showQuotaLockState ? 'border-purple-500/40 shadow-[0_0_15px_rgba(168,85,247,0.14)]' : isMedicalCritical ? 'border-rose-500/50 shadow-[0_0_15px_rgba(244,63,94,0.1)]' : 'border-white/5'}`}>
                      <div className="flex flex-1 w-full flex-col items-center justify-center gap-3">
                        <div className={`text-sm font-bold uppercase tracking-wide ${showQuotaLockState ? 'text-purple-300' : isMedicalCritical ? 'text-rose-400' : 'text-slate-500'}`}>Overs Bowled</div>
                        <div data-testid="overs-bowled-value" className={`${showQuotaLockState ? 'text-purple-300' : isMedicalCritical ? 'text-rose-500' : 'text-white'} text-5xl font-semibold leading-none`}>{activePlayer.overs}</div>
                        {hasFormatCap && (
                          <p className="text-sm text-slate-500">Max {formatMaxOvers} overs</p>
                        )}
                        <div className="flex items-center justify-center gap-6 mt-4">
                          <button type="button"
                            onClick={handleDecreaseOver}
                            disabled={activePlayer.isSub || activePlayer.isUnfit}
                            className={`w-12 h-12 rounded-full flex items-center justify-center border transition-all ${activePlayer.isSub || activePlayer.isUnfit ? 'bg-slate-800/50 text-slate-600 border-slate-800 cursor-not-allowed' : 'cursor-pointer bg-slate-800 hover:bg-slate-700 text-white border-slate-600'}`}
                          >
                            <Minus className="w-6 h-6" />
                          </button>
                          <button type="button"
                            onClick={handleAddOver}
                            disabled={isMedicalCritical || activePlayer.isSub || activePlayer.isUnfit || atOversCap}
                            className={`w-12 h-12 rounded-full flex items-center justify-center shadow-lg transition-all ${isMedicalCritical || activePlayer.isSub || activePlayer.isUnfit || atOversCap ? 'bg-slate-800/50 text-slate-600 cursor-not-allowed shadow-none opacity-40' : 'cursor-pointer bg-emerald-600 hover:bg-emerald-500 text-white shadow-emerald-500/20'}`}
                          >
                            <Plus className="w-6 h-6" />
                          </button>
                        </div>
                      </div>
                    </div>

                    <StrainIndexCard />
                  </div>

                  <div className="h-px bg-gradient-to-r from-transparent via-slate-700 to-transparent my-2" />

                  <div className="grid grid-cols-2 gap-x-8 gap-y-6 mt-6">
                    <div>
                      <div className="flex justify-between mb-2">
                        <label className={`text-[13px] font-bold flex items-center gap-2 ${(activePlayer.injuryRisk === 'High' || activePlayer.injuryRisk === 'Critical') ? 'text-rose-500' : 'text-slate-400'}`}>
                          <Activity className={`w-3 h-3 ${(activePlayer.injuryRisk === 'High' || activePlayer.injuryRisk === 'Critical') ? 'animate-pulse' : ''}`} /> Fatigue Index (0-10)
                        </label>
                        <span className={`text-base font-mono ${(activePlayer.injuryRisk === 'High' || activePlayer.injuryRisk === 'Critical') ? 'text-rose-500' : 'text-white'}`}>{activePlayer.fatigue.toFixed(1)}</span>
                      </div>
                      <div className="h-3 bg-slate-800 rounded-full overflow-hidden">
                        <motion.div
                          initial={false}
                          animate={{ width: `${(activePlayer.fatigue / 10) * 100}%` }}
                          className={`h-full rounded-full ${activePlayer.fatigue > 7 ? 'bg-rose-500' : activePlayer.fatigue > 4 ? 'bg-amber-400' : 'bg-emerald-500'}`}
                        />
                      </div>
                      <div className="mt-2">
                        <span className={`text-xs font-bold uppercase px-2 py-1 rounded border ${
                          activePlayer.status === 'EXCEEDED LIMIT'
                            ? 'text-rose-400 border-rose-500/40 bg-rose-500/10'
                            : activePlayer.status === 'APPROACHING LIMIT'
                              ? 'text-amber-400 border-amber-500/40 bg-amber-500/10'
                              : 'text-emerald-400 border-emerald-500/40 bg-emerald-500/10'
                        }`}>
                          {activePlayer.status}
                        </span>
                      </div>
                      <AnimatePresence>
                        {(activePlayer.isResting || (activePlayer.restElapsedSec || 0) > 0) && (
                          <motion.div
                            initial={{ opacity: 0, height: 0, marginTop: 0 }}
                            animate={{ opacity: 1, height: 'auto', marginTop: 12 }}
                            exit={{ opacity: 0, height: 0, marginTop: 0 }}
                            className="overflow-hidden"
                          >
                            <div className="flex justify-between items-center mb-1">
                              <span className="text-[10px] font-bold text-emerald-500 uppercase flex items-center gap-1">
                                <Wind className="w-3 h-3 animate-pulse" /> Time Rested
                              </span>
                              <span className="text-[10px] font-mono text-emerald-400">
                                {formatMMSS(activePlayer.restElapsedSec || 0)}
                              </span>
                            </div>
                            <div className="h-1.5 bg-slate-800 rounded-full overflow-hidden mb-1 border border-white/5">
                              <motion.div
                                className="h-full bg-emerald-500 shadow-[0_0_10px_rgba(16,185,129,0.5)]"
                                initial={{ width: 0 }}
                                animate={{ width: `${Math.min(100, ((activePlayer.restElapsedSec || 0) / ((activePlayer.recoveryTime || 45) * 60)) * 100)}%` }}
                                transition={{ type: 'tween', ease: 'linear' }}
                              />
                            </div>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>

                    <div>
                      <div className="mb-2 flex items-center justify-between">
                        <label className={`text-[13px] font-bold flex items-center gap-2 ${(activePlayer.injuryRisk === 'High' || activePlayer.injuryRisk === 'Critical') ? 'text-rose-500' : 'text-slate-400'}`}>
                          <AlertTriangle className={`w-3 h-3 ${(activePlayer.injuryRisk === 'High' || activePlayer.injuryRisk === 'Critical') ? 'animate-pulse' : ''}`} /> Heart Rate Recovery
                        </label>
                        <div className="inline-flex items-center rounded-md border border-slate-700 bg-[#162032] p-0.5">
                          <button
                            type="button"
                            onClick={() => setRecoveryMode('auto')}
                            className={`px-2 py-1 text-xs font-bold rounded ${recoveryMode === 'auto' ? 'bg-slate-700 text-white' : 'text-slate-400'}`}
                          >
                            Auto
                          </button>
                          <button
                            type="button"
                            onClick={() => setRecoveryMode('manual')}
                            className={`px-2 py-1 text-xs font-bold rounded ${recoveryMode === 'manual' ? 'bg-slate-700 text-white' : 'text-slate-400'}`}
                          >
                            Manual
                          </button>
                        </div>
                      </div>
                      <select
                        value={recoveryMode === 'manual' ? manualRecovery : activePlayer.hrRecovery}
                        onChange={(e) => setManualRecovery(e.target.value as RecoveryLevel)}
                        disabled={recoveryMode === 'auto'}
                        className={`w-full bg-[#162032] text-sm rounded-lg px-3 py-2.5 border focus:outline-none ${(activePlayer.injuryRisk === 'High' || activePlayer.injuryRisk === 'Critical') ? 'text-rose-500 border-rose-500/50 bg-rose-500/5' : 'text-white border-slate-700'} ${recoveryMode === 'auto' ? 'opacity-80 cursor-not-allowed' : ''}`}
                      >
                        <option value="Good">Good</option>
                        <option value="Moderate">Moderate</option>
                        <option value="Poor">Poor</option>
                      </select>
                    </div>

                    <div className={`bg-[#162032] p-3 rounded-lg flex items-center justify-between border transition-all duration-300 ${(activePlayer.injuryRisk === 'High' || activePlayer.injuryRisk === 'Critical') ? 'border-rose-500/50 bg-rose-500/10 shadow-[0_0_15px_rgba(244,63,94,0.15)]' : 'border-white/5'}`}>
                      <span className={`text-sm font-medium ${(activePlayer.injuryRisk === 'High' || activePlayer.injuryRisk === 'Critical') ? 'text-rose-500 font-bold' : 'text-slate-300'}`}>Injury Risk</span>
                      <span className={`text-sm font-bold text-right ${(activePlayer.injuryRisk === 'High' || activePlayer.injuryRisk === 'Critical') ? 'text-rose-500' : activePlayer.injuryRisk === 'Medium' ? 'text-amber-500' : 'text-emerald-500'}`}>
                        {activePlayer.injuryRisk.toUpperCase()}
                      </span>
                    </div>

                    <div className={`bg-[#162032] p-3 rounded-lg flex items-center justify-between border transition-all duration-300 ${activePlayer.noBallRisk === 'High' ? 'border-rose-500/50 bg-rose-500/10 shadow-[0_0_15px_rgba(244,63,94,0.15)]' : 'border-white/5'}`}>
                      <span className={`text-sm font-medium ${activePlayer.noBallRisk === 'High' ? 'text-rose-500 font-bold' : 'text-slate-300'}`}>No-Ball Risk</span>
                      <span className={`text-sm font-bold text-right ${activePlayer.noBallRisk === 'High' ? 'text-rose-500' : activePlayer.noBallRisk === 'Medium' ? 'text-amber-500' : 'text-emerald-500'}`}>
                        {activePlayer.noBallRisk.toUpperCase()}
                      </span>
                    </div>
                  </div>

                  <div className="mt-6">
                    <p className="text-xs font-bold text-slate-500 uppercase mb-2">Quick Actions</p>
                    <div className="grid grid-cols-3 gap-3">
                      <button type="button" onClick={handleMarkUnfit} className={`border p-4 rounded-lg transition-all flex flex-col items-center group shadow-lg ${activePlayer.isUnfit ? 'bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 border-emerald-500/30 shadow-emerald-900/10' : 'bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 border-rose-500/30 shadow-rose-900/10'}`}>
                        <Zap className="w-5 h-5 mb-0.5" />
                        <span className="text-sm font-bold">{activePlayer.isUnfit ? 'Mark Fit' : 'Mark Unfit'}</span>
                        <span className="text-[10px] opacity-70">{activePlayer.isUnfit ? 'Restore player state' : 'Force critical state'}</span>
                      </button>
                      <button
                        type="button"
                        onClick={handleRotateBowler}
                        disabled={activePlayer.isUnfit || agentState === 'thinking'}
                        className={`p-4 rounded-lg transition-colors flex flex-col items-center border ${
                          activePlayer.isUnfit || agentState === 'thinking'
                            ? 'bg-slate-800/50 text-slate-600 border-slate-800 cursor-not-allowed'
                            : 'bg-slate-800 hover:bg-slate-700 text-slate-300 border-slate-700'
                        }`}
                      >
                        <CheckCircle2 className="w-5 h-5 mb-0.5" />
                        <span className="text-sm font-bold">Rotate Bowler</span>
                        <span className="text-[10px] opacity-70">Coach suggestion</span>
                      </button>
                      <button type="button"
                        onClick={handleRest}
                        disabled={activePlayer.isUnfit}
                        className={`p-4 rounded-lg transition-all flex flex-col items-center border ${activePlayer.isUnfit ? 'bg-slate-800/50 text-slate-600 border-slate-800 cursor-not-allowed' : activePlayer.isResting ? 'bg-emerald-500/20 border-emerald-500/50 text-emerald-400 shadow-[0_0_15px_rgba(16,185,129,0.2)]' : 'bg-slate-800 hover:bg-slate-700 text-slate-300 border-slate-700'}`}
                      >
                        <Wind className={`w-5 h-5 mb-0.5 ${activePlayer.isResting ? 'animate-pulse' : ''}`} />
                        <span className="text-sm font-bold">{activePlayer.isResting ? 'Resting...' : 'Rest'}</span>
                        <span className="text-[10px] opacity-70">{activePlayer.isResting ? 'Click to Resume' : 'Start Recovery'}</span>
                      </button>
                    </div>
                    {rotateBowlerNotice && (
                      <p className="mt-2 text-[11px] text-amber-300">{rotateBowlerNotice}</p>
                    )}
                  </div>

                  {analysisActive && (
                    <div className="mt-6">
                      <FatigueForecastChart
                        currentFatigue={activePlayer.fatigue}
                        intensity={matchContext.pitch || matchContext.phase || 'Medium'}
                        consecutiveOvers={0}
                        heartRateRecovery={activePlayer.hrRecovery ?? 'Good'}
                      />
                    </div>
                  )}
                  </motion.div>
                )}
              </AnimatePresence>
              ) : isRosterEmpty ? (
                <div className="h-full w-full min-h-[420px] flex items-center justify-center">
                  <button type="button"
                    onClick={onGoToBaselines}
                    className="relative group inline-flex items-center justify-center px-10 py-4 rounded-2xl text-base font-semibold tracking-wide text-white bg-[#0E1625] border border-emerald-400/40 ring-1 ring-emerald-300/35 shadow-[0_18px_70px_rgba(0,0,0,0.6)] backdrop-blur neon-breathe transition hover:scale-[1.02] hover:ring-emerald-200/60 hover:border-white/20 active:scale-[0.98] focus:outline-none focus:ring-2 focus:ring-emerald-300/70"
                  >
                    <span className="pointer-events-none absolute -inset-2 rounded-3xl bg-emerald-400/20 blur-2xl opacity-80 animate-pulse" />
                    <span className="pointer-events-none absolute inset-0 rounded-2xl ring-1 ring-emerald-300/50 shadow-[0_0_25px_rgba(16,185,129,0.6)]" />
                    <span className="pointer-events-none absolute inset-0 rounded-2xl opacity-0 group-hover:opacity-100 transition overflow-hidden">
                      <span className="absolute -left-1/2 top-0 h-full w-[200%] bg-gradient-to-r from-transparent via-white/10 to-transparent translate-x-[-40%] group-hover:translate-x-[40%] transition duration-700" />
                    </span>
                    <span className="relative z-10">+ Add a Player</span>
                  </button>
                </div>
              ) : (
                <div className="flex-1 flex items-center justify-center text-center px-6">
                  <div>
                    <Users className="w-12 h-12 mx-auto mb-3 opacity-50 text-slate-500" />
                    <p className="text-slate-200/80 font-medium">Select a player from the roster to view telemetry.</p>
                    <p className="mt-2 text-xs text-slate-400/70">Telemetry controls are disabled until a player is selected.</p>
                  </div>
                </div>
              )}
            </div>

          </div>
        </div>

        {/* RIGHT: COACH AGENT */}
        <div className="lg:col-span-3 h-full flex flex-col gap-4 min-h-0">
          <div
            data-testid="coach-panel"
            className="h-full min-h-0 flex-1 flex flex-col rounded-2xl border border-white/5 bg-[#0F172A] overflow-hidden relative"
          >
            <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-indigo-500 via-purple-500 to-pink-500 opacity-50 rounded-t-2xl" />

            <div className="flex-none shrink-0 p-6 pb-3">
              <div className="w-full flex items-center justify-between">
                <span className="text-xl dashboard-panel-title-tall font-bold text-slate-300 flex items-center gap-2">
                  <Shield className="w-10 h-10 dashboard-title-icon-tall text-emerald-400 drop-shadow-[0_0_6px_rgba(16,185,129,0.6)]" /> Tactical Coach AI
                </span>
              </div>
            </div>

            <div className="flex-1 min-h-0 flex flex-col px-6 py-5">
              {activePlayer ? (
                <>
                  {!isCoachOutputState && (
                    <div className="flex-1 min-h-0 flex flex-col items-center justify-center">
                      <div className="w-full flex flex-col items-center gap-2">
                        <div className="w-24 h-24 dashboard-coach-shield-container-tall dashboard-coach-shift-up rounded-3xl flex items-center justify-center bg-gradient-to-br from-indigo-500/25 via-purple-500/20 to-blue-500/15 border border-white/10 shadow-[0_0_40px_rgba(99,102,241,0.25)] backdrop-blur-md">
                          <div className="relative">
                            <div
                              className="absolute inset-0 -z-10 rounded-full blur-xl"
                              style={{
                                width: 80,
                                height: 88,
                                left: '50%',
                                top: '50%',
                                transform: 'translate(-50%, -50%)',
                                background: 'rgba(16,185,129,0.18)',
                                boxShadow: '0 0 35px rgba(16,185,129,0.35)',
                              }}
                            />
                            <div
                              className="relative rounded-full p-4"
                              style={{
                                boxShadow: '0 0 18px rgba(16,185,129,0.25)',
                              }}
                            >
                              <Shield
                                className="w-14 h-14 dashboard-coach-shield-glyph-tall text-emerald-400"
                                style={{
                                  filter: 'drop-shadow(0 0 10px rgba(16,185,129,0.7))',
                                }}
                              />
                            </div>
                          </div>
                        </div>
                        <div className="w-full mt-6">
                          <button
                            type="button"
                            aria-label="Run Coach Analysis"
                            onClick={handleRunCoachAuto}
                            onMouseEnter={() => setIsRunCoachHovered(true)}
                            onMouseLeave={() => setIsRunCoachHovered(false)}
                            disabled={agentState === 'thinking'}
                            className="w-full rounded-full px-12 py-4 text-base font-semibold flex items-center justify-center gap-3 text-white shadow-[0_12px_40px_rgba(99,102,241,0.30)] hover:scale-[1.02] hover:shadow-[0_14px_50px_rgba(30,41,59,0.65)] active:scale-[0.99] transition-all duration-300 ease-out cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300/70 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0F172A] disabled:opacity-70 disabled:cursor-not-allowed"
                            style={{ backgroundColor: isRunCoachHovered ? '#4C1D95' : '#7C3AED' }}
                          >
                            <PlayCircle className="w-5 h-5 dashboard-icon-tall-lg shrink-0" /> Run Coach Analysis
                          </button>
                        </div>
                        {agentFailure && (
                          <div className="w-full mt-3">
                            <div className="rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-left">
                              <p className="text-[10px] uppercase tracking-wide font-semibold text-rose-100">Coach Agent failed</p>
                              <p className="mt-1 text-[11px] text-rose-200">{agentFailure.message}</p>
                              <p className="mt-1 text-[10px] text-rose-200/80">{`Status: ${String(agentFailure.status)}`}</p>
                              <p className="mt-1 text-[10px] font-mono text-rose-200/80 break-all">{agentFailure.url}</p>
                              {agentFailure.hint && (
                                <p className="mt-1 text-[11px] text-rose-200/90">{agentFailure.hint}</p>
                              )}
                              <a
                                href={apiHealthUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="mt-1 inline-block text-[11px] text-cyan-200 underline decoration-cyan-300/40 hover:text-cyan-100"
                              >
                                Check /health
                              </a>
                            </div>
                          </div>
                        )}
                        {!agentFailure && agentWarning && (
                          <div className="w-full mt-3">
                            <div className="rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-left">
                              <p className="text-[11px] text-rose-200">{agentWarning}</p>
                              <a
                                href={apiHealthUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="mt-1 inline-block text-[11px] text-cyan-200 underline decoration-cyan-300/40 hover:text-cyan-100"
                              >
                                Check /health
                              </a>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {isCoachOutputState && (
                    <div className="mt-4 rounded-xl border border-white/10 bg-white/[0.03] p-3">
                      <div
                        ref={scrollRef}
                        onScroll={handleTacticalScroll}
                        className="h-auto min-h-full overflow-hidden pr-1 coach-output"
                      >
                        <div className="space-y-5">
                        <div className="rounded-lg border border-indigo-400/25 bg-indigo-500/5 px-3 py-2 text-[11px] font-bold uppercase tracking-wide text-indigo-200">
                          {agentState === 'thinking' ? 'Analyzing...' : 'AI Strategic Analysis'}
                        </div>
                        {agentWarning && (
                          <div className="w-full">
                            <div className="text-[11px] text-amber-300 border border-amber-500/30 bg-amber-500/10 rounded-md px-3 py-2 text-left">
                              {agentWarning}
                            </div>
                          </div>
                        )}
                        {showBatsmanAiAlert && (
                          <motion.div
                            initial={{ opacity: 0, y: 10 }}
                            animate={{ opacity: 1, y: 0 }}
                            className="w-full"
                          >
                            <div className={`rounded-xl p-5 relative overflow-hidden border ${isPressureCritical ? 'bg-rose-950/20 border-rose-500/30' : 'bg-amber-950/20 border-amber-500/30'}`}>
                              <div className="flex items-start gap-3">
                                <div className={`w-9 h-9 rounded-lg flex items-center justify-center border shrink-0 ${isPressureCritical ? 'bg-rose-500/15 border-rose-500/40' : 'bg-amber-500/15 border-amber-500/40'}`}>
                                  <AlertTriangle className={`w-5 h-5 ${isPressureCritical ? 'text-rose-400' : 'text-amber-300'}`} />
                                </div>
                                <div className="text-left">
                                  <h4 className={`text-xs font-bold uppercase tracking-wide mb-2 ${isPressureCritical ? 'text-rose-300' : 'text-amber-200'}`}>
                                    {tacticalAlertTitle}
                                  </h4>
                                  <p className="text-xs text-slate-200 mb-2">{tacticalAlertText}</p>
                                  <p className="text-xs text-slate-300 mb-3">
                                    Pressure {pressureIndex.toFixed(1)}/10 | RR {currentRunRate.toFixed(2)} (Req {requiredRunRate.toFixed(2)}) | SR {batsmanStrikeRate.toFixed(1)} / Req {requiredStrikeRate.toFixed(1)}
                                  </p>
                                  <p className="text-[11px] text-slate-400 mb-3">
                                    {alertWhyLine}
                                  </p>
                                  <div className="space-y-1.5">
                                    {batsmanRecommendations.map((tip, index) => (
                                      <p key={index} className="text-xs text-slate-200 leading-relaxed">• {tip}</p>
                                    ))}
                                  </div>
                                </div>
                              </div>
                            </div>
                          </motion.div>
                        )}
                        {substitutionRecommendation && (
                          <motion.div
                            initial={{ opacity: 0, y: 10 }}
                            animate={{ opacity: 1, y: 0 }}
                            className="w-full"
                          >
                            <div className="bg-rose-950/20 border border-rose-500/20 rounded-xl p-6 relative overflow-hidden group">
                              <div className="absolute top-0 right-0 w-32 h-32 bg-rose-500/5 blur-[40px] rounded-full pointer-events-none group-hover:bg-rose-500/10 transition-colors" />
                              <div className="flex items-start gap-4 relative z-10">
                                <div className="w-10 h-10 rounded-lg bg-rose-500/10 flex items-center justify-center border border-rose-500/20 shrink-0">
                                  <AlertTriangle className="w-6 h-6 text-rose-400" />
                                </div>
                                <div>
                                  <h4 className="text-xs font-bold text-rose-400 uppercase tracking-wide mb-2 flex items-center gap-2">
                                    Strategic Intervention
                                    <span className="animate-pulse w-1.5 h-1.5 rounded-full bg-rose-500 shadow-[0_0_8px_#f43f5e]" />
                                  </h4>
                                  <p className="text-sm text-rose-100/90 leading-relaxed font-medium">
                                    {substitutionRecommendation}
                                  </p>
                                </div>
                              </div>
                            </div>
                          </motion.div>
                        )}
                        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="w-full text-left pr-1 space-y-4">
                          <div className="p-4 rounded-xl border border-indigo-400/35 bg-[#162032]">
                            <div className="flex items-center justify-between gap-3">
                              <div>
                                <h4 className="text-sm font-bold text-white">AI Match Intelligence</h4>
                                <p className="text-[11px] text-slate-400 mt-0.5">Real-time tactical decision support</p>
                              </div>
                              <div className="flex items-center gap-2">
                                <span className="text-[10px] px-2 py-0.5 rounded border border-indigo-400/40 text-indigo-200 bg-indigo-500/10 whitespace-nowrap">
                                  {analysisBadgeLabel}
                                </span>
                                {hasAnyAnalysis && (
                                  <button
                                    type="button"
                                    onClick={handleCopyBriefing}
                                    className="text-[10px] px-2 py-0.5 rounded border border-slate-600 text-slate-200 bg-slate-800 hover:bg-slate-700 transition-colors"
                                  >
                                    {briefCopied ? 'Copied' : 'Copy Briefing'}
                                  </button>
                                )}
                              </div>
                            </div>
                          </div>

                          {showAnalysisFailureInline && (
                            <div className="rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2">
                              <p className="text-[11px] text-amber-100">
                                Some signals were unavailable; showing best available guidance.
                              </p>
                            </div>
                          )}

                          <div className="p-4 rounded-xl border border-slate-700 bg-[#162032]">
                            <p className="text-xs font-bold text-slate-200 mb-2">Agent Execution</p>
                            <div className="space-y-2">
                              {agentStatusRows.map((row) => (
                                <div key={`agent-status-${row.agent}`} className="rounded-lg border border-slate-700/80 bg-slate-900/30 px-3 py-2">
                                  <div className="flex items-center justify-between gap-2">
                                    <span className="text-[11px] font-semibold text-slate-200">{row.label}</span>
                                    <span
                                      className={`text-[10px] px-2 py-0.5 rounded border ${
                                        row.state === 'SUCCESS'
                                          ? 'border-emerald-500/35 text-emerald-200 bg-emerald-500/10'
                                          : row.state === 'RUNNING'
                                            ? 'border-indigo-500/35 text-indigo-200 bg-indigo-500/10'
                                            : row.state === 'ERROR'
                                              ? 'border-rose-500/35 text-rose-200 bg-rose-500/10'
                                              : row.state === 'SKIPPED'
                                                ? 'border-slate-600 text-slate-300 bg-slate-800/60'
                                                : 'border-slate-700 text-slate-400 bg-slate-900/60'
                                      }`}
                                    >
                                      {row.state}
                                    </span>
                                  </div>
                                  <div className="mt-1 flex items-center justify-between gap-2">
                                    <p className="text-[11px] text-slate-400">{row.detail}</p>
                                    {row.state === 'ERROR' && (
                                      <button
                                        type="button"
                                        onClick={handleRunCoachAuto}
                                        disabled={agentState === 'thinking'}
                                        className="text-[10px] px-2 py-0.5 rounded border border-rose-400/45 text-rose-200 hover:text-white hover:bg-rose-500/20 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
                                      >
                                        Retry
                                      </button>
                                    )}
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>

                          {showAnalysisSkeleton ? (
                            <div className="space-y-3">
                              {[0, 1, 2, 3].map((idx) => (
                                <div key={`analysis-skeleton-${idx}`} className="rounded-xl border border-slate-700 bg-[#162032] p-4 animate-pulse">
                                  <div className="h-3 w-32 rounded bg-slate-700/70 mb-3" />
                                  <div className="h-2.5 w-full rounded bg-slate-700/50 mb-2" />
                                  <div className="h-2.5 w-10/12 rounded bg-slate-700/50" />
                                </div>
                              ))}
                            </div>
                          ) : (
                            <>
                              {matchSignalBullets.length > 0 && (
                                <div className="p-4 rounded-xl border border-slate-700 bg-[#162032]">
                                  <p className="text-xs font-bold text-slate-200 mb-2">Detected Match Signals</p>
                                  <ul className="space-y-1.5">
                                    {matchSignalBullets.map((signal, index) => (
                                      <li key={`${signal}-${index}`} className="text-xs text-slate-300 leading-relaxed">• {signal}</li>
                                    ))}
                                  </ul>
                                </div>
                              )}

                              {fatigueSectionVisible && (
                                <div className="p-4 rounded-xl border border-slate-700 bg-[#162032]">
                                  <div className="flex items-center justify-between mb-2">
                                    <p className="text-xs font-bold text-slate-200">Fatigue Analysis</p>
                                    <span className="text-[10px] px-2 py-0.5 rounded border border-slate-600 text-slate-300 bg-slate-800">
                                      Trend: {fatigueTrendLabel}
                                    </span>
                                  </div>
                                  <p className="text-xs text-slate-300 leading-relaxed">
                                    {activeStrategicAnalysis?.fatigueAnalysis || aiAnalysis?.headline || 'Fatigue model reviewed workload and recovery balance for this phase.'}
                                  </p>
                                  <p className="text-[11px] text-slate-400 mt-2 leading-relaxed">
                                    {aiAnalysis?.explanation || 'The current spell and recovery profile suggest monitoring exertion before extending intensity.'}
                                  </p>
                                  <ul className="space-y-1.5 mt-3">
                                    {[aiAnalysis?.recommendation, ...(aiAnalysis?.signals || []).slice(0, 3)]
                                      .filter((item): item is string => Boolean(item && item.trim()))
                                      .slice(0, 4)
                                      .map((item, idx) => (
                                        <li key={`fatigue-point-${idx}`} className="text-[11px] text-slate-300">• {item}</li>
                                      ))}
                                  </ul>
                                </div>
                              )}

                              {riskSectionVisible && (
                                <div className="p-4 rounded-xl border border-slate-700 bg-[#162032]">
                                  <p className="text-xs font-bold text-slate-200 mb-2">Injury Risk Analysis</p>
                                  <p className="text-xs text-slate-300 leading-relaxed">
                                    {activeStrategicAnalysis?.injuryRiskAnalysis || (riskAnalysis?.headline || 'Risk profile indicates workload-linked injury exposure should be managed proactively.')}
                                  </p>
                                  {likelyInjuries.length > 0 && (
                                    <p className="text-[11px] text-slate-300 mt-2 leading-relaxed">
                                      Likely injury types: {likelyInjuries.slice(0, 3).map((injury) => injury.type).join(', ')}.
                                    </p>
                                  )}
                                  <ul className="space-y-1.5 mt-3">
                                    {[
                                      likelyInjuries[0]?.reason ? `How it can occur: ${likelyInjuries[0].reason}` : null,
                                      riskAnalysis?.recommendation ? `Why AI flagged this: ${riskAnalysis.recommendation}` : null,
                                      ...(riskAnalysis?.signals || []).slice(0, 2).map((signal) => `Supporting signal: ${signal}`),
                                    ]
                                      .filter((item): item is string => Boolean(item && item.trim()))
                                      .slice(0, 4)
                                      .map((item, idx) => (
                                        <li key={`risk-point-${idx}`} className="text-[11px] text-slate-300">• {item}</li>
                                      ))}
                                  </ul>
                                </div>
                              )}

                              {hasAnyAnalysis && (
                                <div className="p-5 rounded-xl border border-indigo-400/35 bg-gradient-to-b from-indigo-500/12 to-[#162032] border-l-[3px] border-l-indigo-300/85 shadow-[0_0_26px_rgba(99,102,241,0.22)]">
                                  <p className="text-[11px] font-bold uppercase tracking-wide text-indigo-100 mb-2">Tactical Recommendation</p>
                                  <div className="space-y-3">
                                    <div>
                                      <p className="text-[10px] uppercase tracking-wide text-slate-400">Next Action</p>
                                      <p className="text-sm text-white mt-1">{tacticalNextAction}</p>
                                    </div>
                                    <div>
                                      <p className="text-[10px] uppercase tracking-wide text-slate-400">Why</p>
                                      <p className="text-xs text-slate-300 mt-1 leading-relaxed">{activeStrategicAnalysis?.tacticalRecommendation?.why || tacticalWhy}</p>
                                    </div>
                                    <div>
                                      <p className="text-[10px] uppercase tracking-wide text-slate-400">If Ignored</p>
                                      <p className="text-xs text-slate-300 mt-1 leading-relaxed">{activeStrategicAnalysis?.tacticalRecommendation?.ifIgnored || tacticalIfIgnored}</p>
                                    </div>
                                    <div>
                                      <p className="text-[10px] uppercase tracking-wide text-slate-400">Alternative</p>
                                      <p className="text-xs text-slate-300 mt-1 leading-relaxed">{activeStrategicAnalysis?.tacticalRecommendation?.alternatives?.[0] || modeScopedAlternative}</p>
                                    </div>
                                    {activeStrategicAnalysis?.coachNote && (
                                      <div>
                                        <p className="text-[10px] uppercase tracking-wide text-slate-400">Coach Note</p>
                                        <p className="text-xs text-indigo-100/90 mt-1 leading-relaxed">{activeStrategicAnalysis.coachNote}</p>
                                      </div>
                                    )}
                                  </div>
                                </div>
                              )}
                            </>
                          )}

                          {showAnalysisFailureCard && (
                            <div className="rounded-xl border border-rose-500/35 bg-rose-500/10 px-4 py-3">
                              <p className="text-xs text-rose-100">Analysis is temporarily unavailable. Please retry.</p>
                              <button
                                type="button"
                                onClick={isFullAnalysis ? () => handleRunCoachFull() : handleRunCoachAuto}
                                className="mt-2 text-[11px] px-2.5 py-1 rounded border border-rose-400/45 text-rose-200 hover:text-white hover:bg-rose-500/20 transition-colors"
                              >
                                Retry Analysis
                              </button>
                            </div>
                          )}

                          <div className="p-4 rounded-xl border border-slate-700 bg-[#162032]">
                            <button
                              type="button"
                              onClick={() =>
                                setShowRouterSignals((prev) => {
                                  const next = !prev;
                                  if (!next) setShowRawTelemetry(false);
                                  return next;
                                })
                              }
                              className="text-xs font-semibold text-slate-300 hover:text-white transition-colors"
                            >
                              Advanced View {showRouterSignals ? '▴' : '▾'}
                            </button>
                            {showRouterSignals && (
                              <div className="mt-3 space-y-4">
                                <div className="rounded-lg border border-indigo-500/25 bg-indigo-500/5 px-3 py-2">
                                  <p className="text-[10px] uppercase tracking-wide text-indigo-200/90">Intent</p>
                                  <p className="text-sm font-semibold text-indigo-100 mt-0.5">{routerIntentLabel}</p>
                                  <p className="text-[11px] text-slate-400 mt-1">
                                    {isFullAnalysis
                                      ? 'Full analysis mode bypasses router selection and forces fatigue, risk, and tactical agents in parallel.'
                                      : routerDecisionForView?.rationale || routerDecisionForView?.reason || 'Decision selected from current match signals.'}
                                  </p>
                                </div>

                                <div>
                                  <p className="text-[10px] uppercase tracking-wide text-slate-400 mb-1.5">Triggered by</p>
                                  <ul className="space-y-1.5">
                                    {matchSignalBullets.slice(0, 6).map((item, index) => (
                                      <li key={`advanced-trigger-${index}`} className="text-[11px] text-slate-300 leading-relaxed">• {item}</li>
                                    ))}
                                  </ul>
                                </div>

                                <div>
                                  <p className="text-[10px] uppercase tracking-wide text-slate-400 mb-1.5">Agents</p>
                                  <div className="flex flex-wrap gap-1.5">
                                    {(['fatigue', 'risk', 'tactical'] as const).map((agent) => {
                                      const selected = isFullAnalysis ? true : selectedAgentSet.has(agent);
                                      return (
                                        <span
                                          key={`advanced-chip-${agent}`}
                                          className={`text-[10px] px-2 py-0.5 rounded border ${
                                            selected
                                              ? 'border-emerald-500/35 text-emerald-200 bg-emerald-500/10'
                                              : 'border-slate-700 text-slate-400 bg-slate-900/40'
                                          }`}
                                        >
                                          {agent.toUpperCase()} {selected ? 'selected' : 'not needed'}
                                        </span>
                                      );
                                    })}
                                  </div>
                                </div>

                                <div className="rounded-lg border border-slate-700 bg-slate-900/30 px-3 py-2.5">
                                  <p className="text-[10px] uppercase tracking-wide text-slate-400 mb-2">Why this decision</p>
                                  <div className="space-y-2">
                                    {agentDecisionRows.map((row) => (
                                      <p key={`advanced-why-${row.agent}`} className="text-[11px] text-slate-300 leading-relaxed">
                                        <span className={(isFullAnalysis || row.selected) ? 'text-emerald-300' : 'text-slate-500'}>
                                          {(isFullAnalysis || row.selected) ? '✅' : '⛔'}
                                        </span>{' '}
                                        <span className="font-semibold text-slate-200">{row.agent === 'risk' ? 'Risk' : row.agent === 'fatigue' ? 'Fatigue' : 'Tactical'}</span>{' '}
                                        — {isFullAnalysis ? 'Forced in full combined analysis for maximum coverage.' : row.why}
                                      </p>
                                    ))}
                                  </div>
                                </div>

                                <button
                                  type="button"
                                  onClick={() => setShowRawTelemetry((v) => !v)}
                                  className="text-[11px] text-slate-400 hover:text-slate-200 underline decoration-slate-600/70"
                                >
                                  {showRawTelemetry ? 'Hide raw telemetry' : 'Show raw telemetry'}
                                </button>

                                {showRawTelemetry && rawSignalEntries.length > 0 && (
                                  <div className="grid grid-cols-2 gap-2 text-[10px] text-slate-400">
                                    {rawSignalEntries.map(({ key, value }) => (
                                      <div key={`signal-${key}`} className="flex justify-between gap-2 border border-slate-800 rounded px-2 py-1">
                                        <span>{key}</span>
                                        <span className="text-slate-200">{value}</span>
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </div>
                            )}
                          </div>

                          {(tacticalAnalysis?.status === 'fallback' || orchestrateMeta?.usedFallbackAgents.includes('tactical')) && (
                            <p className="text-[11px] text-slate-400 flex items-center gap-1.5">
                              Fallback mode active (Azure OpenAI not configured).
                              <Info className="w-3 h-3 text-slate-500" title="Set AOAI env vars in local settings or Azure App Service to enable Azure OpenAI." />
                            </p>
                          )}
                        </motion.div>
                          <div ref={bottomRef} />
                        </div>
                      </div>
                    </div>
                  )}
                </>
              ) : (
                <div className="flex-1 min-h-0 flex flex-col items-center justify-center text-center">
                  {!isRosterEmpty && (
                    <p className="text-sm text-slate-300 font-medium">
                      Select a player to analyze
                    </p>
                  )}
                  {!isRosterEmpty && (
                    <p className="mt-2 text-xs text-slate-500">
                      Run Coach Analysis will be enabled after player selection.
                    </p>
                  )}
                  <button
                    type="button"
                    disabled
                    className="mt-5 w-full rounded-full px-12 py-4 text-base font-semibold flex items-center justify-center gap-3 text-white bg-slate-700/70 opacity-70 cursor-not-allowed"
                  >
                    <PlayCircle className="w-5 h-5 dashboard-icon-tall-lg shrink-0" /> Run Coach Analysis
                  </button>
                </div>
              )}
            </div>

	            {activePlayer && isCoachOutputState && (
	              <div className="flex-none shrink-0 p-6 pt-3 border-t border-white/5 bg-[#0F172A]">
	                <div className="space-y-3">
	                  {isCoachOutputState && (
	                    <>
	                      <button type="button"
                        onClick={(event) => handleRunCoachFull(event)}
                        disabled={agentState === 'thinking'}
                        className={`w-full py-3 rounded-lg border text-sm transition-colors ${agentState === 'thinking' ? 'border-slate-700 text-slate-500 cursor-not-allowed' : 'border-indigo-400/30 text-indigo-200 hover:text-white hover:bg-indigo-500/10'}`}
                      >
                        {agentState === 'thinking' ? 'Running Full Combined Analysis...' : 'Run Full Combined Analysis'}
                      </button>

                      <button type="button"
                        onClick={handleDismissAnalysis}
                        className="w-full py-3 rounded-lg border border-slate-700 text-slate-400 text-sm hover:text-white hover:bg-slate-800 transition-colors"
                      >
                        Dismiss Analysis
                      </button>
                    </>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
      </div>
      <ConfirmSwitchOverlay
        open={showRotateBowlerConfirm && Boolean(rotateBowlerSuggestion)}
        suggestion={rotateBowlerSuggestion}
        onSwitch={handleSwitchToSuggestedBowler}
        onCancel={closeRotateBowlerConfirm}
      />
      <MatchModeGuardOverlay
        open={showMatchModeGuard}
        onSwitch={handleSwitchToBattingAndContinue}
        onCancel={closeMatchModeGuard}
      />
    </motion.div>
  );
}

interface BaselinesProps {
  baselineSource: 'cosmos' | 'fallback';
  baselineWarning: string | null;
  onBaselinesSynced: (
    baselines: Baseline[],
    source: 'cosmos' | 'fallback',
    warning?: string,
    options?: { persist?: boolean; addToRosterIds?: string[] }
  ) => void;
  matchRosterIds: string[];
  onMatchRosterIdsChange: (nextIds: string[]) => void;
  onBack: () => void;
}

interface BaselineDraftRow {
  _localId: string;
  _isDraft: boolean;
  id?: string;
  name: string;
  role: BaselineRole;
  active: boolean;
  inRoster: boolean;
  sleep: number;
  recovery: number;
  fatigueLimit: number;
  control: number;
  speed: number;
  power: number;
  orderIndex?: number;
  createdAt?: string;
  updatedAt?: string;
}

const createDraftRowKey = (): string => {
  const generator = globalThis.crypto?.randomUUID;
  if (typeof generator === 'function') {
    return generator.call(globalThis.crypto);
  }
  return `row-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
};

const baselineToDraftRow = (baseline: Baseline, rosterIdSet?: Set<string>): BaselineDraftRow => {
  const normalized = normalizeBaselineRecord(baseline);
  const name = String(normalized.name || normalized.playerId || normalized.id || '').trim();
  const persistedId = String(normalized.id || normalized.playerId || name).trim();
  const resolvedRosterKey = baselineKey(persistedId || name);
  return {
    _localId: persistedId || `draft-${createDraftRowKey()}`,
    _isDraft: false,
    id: persistedId || undefined,
    name,
    role: normalized.role,
    active: Boolean(normalized.isActive),
    inRoster: Boolean(rosterIdSet?.has(resolvedRosterKey)),
    sleep: clamp(safeNum(normalized.sleepHoursToday, 7), 0, 12),
    recovery: clamp(safeNum(normalized.recoveryMinutes, 45), 0, 240),
    fatigueLimit: clamp(safeNum(normalized.fatigueLimit, 6), 0, 10),
    control: clamp(safeNum(normalized.controlBaseline, 78), 0, 100),
    speed: clamp(safeNum(normalized.speed, 7), 0, 100),
    power: clamp(safeNum(normalized.power, 6), 0, 100),
    orderIndex: parseBaselineOrderIndex(normalized.orderIndex),
    createdAt: normalized.createdAt,
    updatedAt: normalized.updatedAt,
  };
};

const draftRowToBaseline = (row: BaselineDraftRow): Baseline | null => {
  const name = String(row.name || '').trim();
  if (!name) return null;
  const resolvedId = String(row.id || name).trim();

  return normalizeBaselineRecord({
    id: resolvedId,
    playerId: resolvedId,
    name,
    role: row.role,
    isActive: row.active,
    sleepHoursToday: clamp(safeNum(row.sleep, 7), 0, 12),
    recoveryMinutes: clamp(safeNum(row.recovery, 45), 0, 240),
    fatigueLimit: clamp(safeNum(row.fatigueLimit, 6), 0, 10),
    controlBaseline: clamp(safeNum(row.control, 78), 0, 100),
    speed: clamp(safeNum(row.speed, 7), 0, 100),
    power: clamp(safeNum(row.power, 6), 0, 100),
    orderIndex: parseBaselineOrderIndex(row.orderIndex),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
};

function Baselines({
  baselineSource,
  baselineWarning,
  onBaselinesSynced,
  matchRosterIds,
  onMatchRosterIdsChange,
  onBack,
}: BaselinesProps) {
  const [activeTooltip, setActiveTooltip] = useState<string | null>(null);
  const tooltipOpenTimerRef = useRef<number | null>(null);
  const rosterToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const nameInputRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const [savedBaselines, setSavedBaselines] = useState<BaselineDraftRow[]>([]);
  const [draftBaselines, setDraftBaselines] = useState<BaselineDraftRow[]>([]);
  const [pendingFocusLocalId, setPendingFocusLocalId] = useState<string | null>(null);
  const [isLoadingBaselines, setIsLoadingBaselines] = useState(true);
  const [baselineFetchFailed, setBaselineFetchFailed] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [rosterToastMessage, setRosterToastMessage] = useState<string | null>(null);
  const [runtimeSource, setRuntimeSource] = useState<'cosmos' | 'fallback'>(baselineSource);
  const [runtimeWarning, setRuntimeWarning] = useState<string | null>(baselineWarning);

  const sortedSignature = (rows: BaselineDraftRow[]): string =>
    JSON.stringify(
      rows
        .map((row) => ({
          name: String(row.name || ''),
          role: row.role,
          active: Boolean(row.active),
          sleep: clamp(safeNum(row.sleep, 7), 0, 12),
          recovery: clamp(safeNum(row.recovery, 45), 0, 240),
          fatigueLimit: clamp(safeNum(row.fatigueLimit, 6), 0, 10),
          control: clamp(safeNum(row.control, 78), 0, 100),
          speed: clamp(safeNum(row.speed, 7), 0, 100),
          power: clamp(safeNum(row.power, 6), 0, 100),
          orderIndex: parseBaselineOrderIndex(row.orderIndex),
        }))
        .map((row) => ({
          name: row.name,
          role: row.role,
          active: row.active,
          sleep: row.sleep,
          recovery: row.recovery,
          fatigueLimit: row.fatigueLimit,
          control: row.control,
          speed: row.speed,
          power: row.power,
          orderIndex: row.orderIndex,
        }))
    );

  const isDirty = sortedSignature(savedBaselines) !== sortedSignature(draftBaselines);
  const validateDraftBaselines = (rows: BaselineDraftRow[]): string | null => {
    const seen = new Set<string>();
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const playerName = String(row.name || '').trim();
      if (!playerName) {
        return `Row ${index + 1}: Player Name is required.`;
      }
      const key = playerName.toLowerCase();
      if (seen.has(key)) {
        return `Duplicate player name found: ${playerName}.`;
      }
      seen.add(key);

      const sleep = safeNum(row.sleep, Number.NaN);
      const recovery = safeNum(row.recovery, Number.NaN);
      const fatigueLimit = safeNum(row.fatigueLimit, Number.NaN);
      const control = safeNum(row.control, Number.NaN);
      const speed = safeNum(row.speed, Number.NaN);
      const power = safeNum(row.power, Number.NaN);
      if (!Number.isFinite(sleep) || sleep < 0 || sleep > 12) {
        return `Row ${index + 1}: Sleep must be between 0 and 12.`;
      }
      if (!Number.isFinite(recovery) || recovery < 0 || recovery > 240) {
        return `Row ${index + 1}: Recovery must be between 0 and 240.`;
      }
      if (!Number.isFinite(fatigueLimit) || fatigueLimit < 0 || fatigueLimit > 10) {
        return `Row ${index + 1}: Fatigue Limit must be between 0 and 10.`;
      }
      if (!Number.isFinite(control) || control < 0 || control > 100) {
        return `Row ${index + 1}: Control must be between 0 and 100.`;
      }
      if (!Number.isFinite(speed) || speed < 0 || speed > 100) {
        return `Row ${index + 1}: Speed must be between 0 and 100.`;
      }
      if (!Number.isFinite(power) || power < 0 || power > 100) {
        return `Row ${index + 1}: Power must be between 0 and 100.`;
      }
    }
    return null;
  };

  const draftRowsToBaselines = (rows: BaselineDraftRow[]): Baseline[] =>
    rows
      .map((row) => draftRowToBaseline(row))
      .filter((row): row is Baseline => Boolean(row));

  const syncDraftToRoster = (rows: BaselineDraftRow[]) => {
    onBaselinesSynced(
      draftRowsToBaselines(rows),
      runtimeSource,
      runtimeWarning || undefined,
      { persist: false }
    );
  };

  const showRosterToast = (message: string) => {
    if (rosterToastTimerRef.current) {
      clearTimeout(rosterToastTimerRef.current);
      rosterToastTimerRef.current = null;
    }
    setRosterToastMessage(message);
    rosterToastTimerRef.current = setTimeout(() => {
      setRosterToastMessage(null);
      rosterToastTimerRef.current = null;
    }, 2600);
  };

  const handleRosterToggle = (row: BaselineDraftRow, checked: boolean) => {
    if (row._isDraft) {
      showRosterToast('Save changes first to add this player to roster.');
      return;
    }

    const resolvedId = normalizeBaselineId(row.id || row.name);
    if (!resolvedId) {
      setErrorMessage('Enter player name before adding to roster.');
      return;
    }
    const currentCount = matchRosterIds.length;
    const alreadyInRoster = matchRosterIds.some((id) => baselineKey(id) === baselineKey(resolvedId));
    if (checked && !alreadyInRoster && currentCount >= MAX_ROSTER) {
      setErrorMessage(`Roster is full (${MAX_ROSTER}/${MAX_ROSTER}).`);
      return;
    }

    const nextRosterIds = checked
      ? [...matchRosterIds, resolvedId]
      : matchRosterIds.filter((id) => baselineKey(id) !== baselineKey(resolvedId));
    onMatchRosterIdsChange(nextRosterIds);

    setDraftBaselines((prev) =>
      prev.map((entry) =>
        entry._localId === row._localId ? { ...entry, inRoster: checked } : entry
      )
    );
    setSavedBaselines((prev) =>
      prev.map((entry) =>
        entry._localId === row._localId ? { ...entry, inRoster: checked } : entry
      )
    );
    if (import.meta.env.DEV) {
      console.log('[ACTIVATE BASELINE]', {
        id: resolvedId,
        inRoster: checked,
      });
    }
    setSuccessMessage(null);
  };

  const loadBaselines = async (showSuccess?: string) => {
    setIsLoadingBaselines(true);
    setBaselineFetchFailed(false);
    setErrorMessage(null);
    try {
      const response = await getBaselinesWithMeta();
      const sourceRows = orderBaselinesForDisplay(response.baselines);
      const rosterIdSet = new Set((matchRosterIds.length > 0 ? matchRosterIds : getRosterIds()).map((id) => baselineKey(id)));
      const normalized = sourceRows.map((row) => baselineToDraftRow(row, rosterIdSet));
      setSavedBaselines(normalized);
      setDraftBaselines(normalized.map((row) => ({ ...row })));
      if (import.meta.env.DEV) {
        console.log('[baselines] draft reloaded from backend', {
          source: response.source,
          count: normalized.length,
        });
      }
      setRuntimeSource(response.source);
      setRuntimeWarning(response.warning || null);
      onBaselinesSynced(draftRowsToBaselines(normalized), response.source, response.warning);
      setBaselineFetchFailed(false);
      if (showSuccess) setSuccessMessage(showSuccess);
    } catch (error) {
      const warning = 'Failed to load baselines from backend.';
      setRuntimeSource('cosmos');
      setRuntimeWarning(warning);
      setBaselineFetchFailed(true);
      setSavedBaselines([]);
      setDraftBaselines([]);
      setErrorMessage(error instanceof Error ? error.message : 'Failed to load baselines.');
    } finally {
      setIsLoadingBaselines(false);
    }
  };

  useEffect(() => {
    loadBaselines();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const rosterIdSet = new Set(matchRosterIds.map((id) => baselineKey(id)));
    const syncRow = (row: BaselineDraftRow): BaselineDraftRow => {
      const resolvedId = normalizeBaselineId(row.id || row.name);
      return {
        ...row,
        inRoster: Boolean(rosterIdSet.has(baselineKey(resolvedId))),
      };
    };
    setDraftBaselines((prev) => prev.map(syncRow));
    setSavedBaselines((prev) => prev.map(syncRow));
  }, [matchRosterIds]);

  useEffect(() => {
    setBaselineDraftCache(draftBaselines.map((row) => ({ ...row })));
  }, [draftBaselines]);

  useEffect(() => {
    const handlePointerDownOutside = (event: MouseEvent | TouchEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest('[data-baseline-tooltip-container="true"]')) return;
      setActiveTooltip(null);
    };

    document.addEventListener('mousedown', handlePointerDownOutside);
    document.addEventListener('touchstart', handlePointerDownOutside);
    return () => {
      document.removeEventListener('mousedown', handlePointerDownOutside);
      document.removeEventListener('touchstart', handlePointerDownOutside);
    };
  }, []);

  useEffect(() => {
    if (!pendingFocusLocalId) return;
    const focusTarget = pendingFocusLocalId;
    requestAnimationFrame(() => {
      const input = nameInputRefs.current[focusTarget];
      if (input) {
        input.focus();
      }
    });
    setPendingFocusLocalId(null);
  }, [pendingFocusLocalId, draftBaselines]);

  const updateDraft = (localId: string, updates: Partial<BaselineDraftRow>) => {
    // Keep name as raw editable text during typing; normalize only on save.
    setDraftBaselines((prev) =>
      {
        const nextRows = prev.map((row) => {
        if (row._localId !== localId) return row;
        const nextName = updates.name !== undefined ? String(updates.name) : row.name;
        const trimmedName = nextName.trim();
        const derivedDraftId = row._isDraft ? (trimmedName.length > 0 ? trimmedName : '') : row.id;
        return {
          ...row,
          ...updates,
          name: nextName,
          id: derivedDraftId,
          inRoster: updates.inRoster !== undefined ? Boolean(updates.inRoster) : row.inRoster,
        };
      });
        syncDraftToRoster(nextRows);
        return nextRows;
      }
    );
    setSuccessMessage(null);
  };

  const addDraftPlayer = () => {
    const localId = createDraftRowKey();
    const nowIso = new Date().toISOString();
    setDraftBaselines((prev) => {
      const nextOrderIndex =
        prev.reduce((max, row) => Math.max(max, parseBaselineOrderIndex(row.orderIndex)), 0) + 1;
      const nextRow: BaselineDraftRow = {
        _localId: localId,
        _isDraft: true,
        id: '',
        name: '',
        role: 'BAT',
        active: true,
        inRoster: false,
        sleep: 7,
        recovery: 45,
        fatigueLimit: 6,
        control: 78,
        speed: 7,
        power: 6,
        orderIndex: nextOrderIndex,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      const nextRows = [...prev, nextRow];
      syncDraftToRoster(nextRows);
      return nextRows;
    });
    setPendingFocusLocalId(localId);
    setSuccessMessage(null);
  };

  const handleSave = async () => {
    if (!isDirty || isSaving) return;
    setIsSaving(true);
    setErrorMessage(null);
    setSuccessMessage(null);
    try {
      const validationError = draftValidationError;
      if (validationError) {
        setErrorMessage(validationError);
        return;
      }
      const newlyAddedIds = draftBaselines
        .filter((row) => row._isDraft && row.inRoster === true)
        .map((row) => normalizeBaselineId(row.id || row.name))
        .filter((id) => id.length > 0);
      const payload = draftBaselines
        .map((row) => ({
          ...row,
          orderIndex: parseBaselineOrderIndex(row.orderIndex),
          updatedAt: new Date().toISOString(),
        }))
        .map((row) => draftRowToBaseline(row))
        .filter((row): row is Baseline => Boolean(row));
      const saved = await saveBaselines(payload);
      const orderedSaved = orderBaselinesForDisplay(saved);
      const rosterIdSet = new Set(draftBaselines.filter((row) => row.inRoster).map((row) => baselineKey(row.id || row.name)));
      const nextRows = orderedSaved.map((row) => baselineToDraftRow(row, rosterIdSet));
      setSavedBaselines(nextRows);
      setDraftBaselines(nextRows.map((row) => ({ ...row })));
      if (import.meta.env.DEV) {
        console.log('[baselines] draft replaced after save', { count: nextRows.length });
      }
      onBaselinesSynced(orderedSaved, runtimeSource, runtimeWarning || undefined, { addToRosterIds: newlyAddedIds });
      setSuccessMessage(
        runtimeSource === 'cosmos' ? 'Saved to Cosmos DB.' : 'Saved baseline changes to local fallback store.'
      );
    } catch (error) {
      const message = error instanceof ApiClientError
        ? error.message
        : error instanceof Error
          ? error.message
          : 'Failed to save baselines.';
      setErrorMessage(message);
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async (row: BaselineDraftRow) => {
    const playerName = row.name.trim() || row.id || 'this player';
    if (!window.confirm(`Delete baseline for ${playerName}?`)) return;
    setErrorMessage(null);
    setSuccessMessage(null);

    if (row._isDraft || !row.id) {
      setDraftBaselines((prev) => {
        const nextRows = prev.filter((entry) => entry._localId !== row._localId);
        syncDraftToRoster(nextRows);
        return nextRows;
      });
      const nextRosterIds = matchRosterIds.filter((id) => baselineKey(id) !== baselineKey(row.id || row.name));
      onMatchRosterIdsChange(nextRosterIds);
      return;
    }

    const previousSaved = savedBaselines;
    const previousDraft = draftBaselines;
    const optimisticSaved = previousSaved.filter((entry) => entry._localId !== row._localId);
    const optimisticDraft = previousDraft.filter((entry) => entry._localId !== row._localId);
    setSavedBaselines(optimisticSaved);
    setDraftBaselines(optimisticDraft);

    try {
      await deleteBaseline(row.id);
      const nextRosterIds = matchRosterIds.filter((id) => baselineKey(id) !== baselineKey(row.id || ''));
      onMatchRosterIdsChange(nextRosterIds);
      onBaselinesSynced(draftRowsToBaselines(optimisticSaved), runtimeSource, runtimeWarning || undefined);
      setSuccessMessage(`Deleted baseline for ${playerName}.`);
    } catch (error) {
      setSavedBaselines(previousSaved);
      setDraftBaselines(previousDraft);
      setErrorMessage(error instanceof Error ? error.message : 'Failed to delete baseline.');
    }
  };

  const handleReset = async () => {
    if (!window.confirm('This will delete ALL baseline players. Continue?')) return;
    setErrorMessage(null);
    setSuccessMessage(null);
    try {
      await resetBaselines();
      await loadBaselines('Baseline database reset complete.');
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to reset database.');
    }
  };

  const clearTooltipTimer = () => {
    if (tooltipOpenTimerRef.current !== null) {
      window.clearTimeout(tooltipOpenTimerRef.current);
      tooltipOpenTimerRef.current = null;
    }
  };

  useEffect(
    () => () => {
      if (tooltipOpenTimerRef.current !== null) {
        window.clearTimeout(tooltipOpenTimerRef.current);
      }
      if (rosterToastTimerRef.current !== null) {
        window.clearTimeout(rosterToastTimerRef.current);
      }
    },
    []
  );

  const openTooltipWithDelay = (field: string) => {
    clearTooltipTimer();
    tooltipOpenTimerRef.current = window.setTimeout(() => {
      setActiveTooltip(field);
      tooltipOpenTimerRef.current = null;
    }, 140);
  };

  const closeTooltip = () => {
    clearTooltipTimer();
    setActiveTooltip(null);
  };

  const toggleTooltip = (field: string) => {
    clearTooltipTimer();
    if (activeTooltip === field) {
      setActiveTooltip(null);
    } else {
      setActiveTooltip(field);
    }
  };

  const renderHeaderTooltip = (
    field: string,
    label: string,
    title: string,
    description: string,
    align: 'center' | 'right' = 'center',
    titleIcon?: React.ReactNode
  ) => {
    const tooltipPositionClass =
      align === 'right'
        ? 'right-0'
        : 'left-1/2 -translate-x-1/2';
    const arrowPositionClass =
      align === 'right'
        ? 'right-8'
        : 'left-1/2 -translate-x-1/2';

    return (
      <div
        data-baseline-tooltip-container="true"
        className="relative flex items-center justify-center gap-2"
        onMouseEnter={() => openTooltipWithDelay(field)}
        onMouseLeave={closeTooltip}
      >
        {label}
        <button type="button"
          onClick={() => toggleTooltip(field)}
          className="text-slate-500 hover:text-emerald-400 focus:outline-none transition-colors"
        >
          <Info size={14} />
        </button>
        {activeTooltip === field && (
          <div className={`absolute top-full mt-2 ${tooltipPositionClass} w-64 bg-[#020408] border border-emerald-500/30 text-xs text-slate-300 p-3 rounded-lg shadow-2xl z-[100] text-left pointer-events-none font-normal normal-case`}>
            <div className="font-bold text-emerald-400 mb-1 flex items-center gap-2">
              {titleIcon}
              <span>{title}</span>
            </div>
            <p className="leading-relaxed">{description}</p>
            <div className={`absolute -top-1 ${arrowPositionClass} w-2 h-2 bg-[#020408] border-l border-t border-emerald-500/30 rotate-45`} />
          </div>
        )}
      </div>
    );
  };

  const draftValidationError = validateDraftBaselines(draftBaselines);
  const disableSave = !isDirty || isSaving || isLoadingBaselines || Boolean(draftValidationError);

  return (
    <motion.div 
      initial={{ opacity: 0, x: 20 }} 
      animate={{ opacity: 1, x: 0 }} 
      exit={{ opacity: 0, x: -20 }}
      className="flex-1 p-6 md:p-8 max-w-[1600px] mx-auto w-full flex flex-col"
    >
      <div className="flex items-center justify-between mb-8">
        <div>
          <div className="mb-4">
            <GlowingBackButton onClick={onBack} />
          </div>
          <h2 className="text-3xl font-bold text-white">Player Baseline Models</h2>
          <p className="text-slate-400 mt-1">Roster selection is session-based (local to this device). Baseline metrics are saved to Cosmos DB when you click Save Changes.</p>
        </div>
        <div className="flex gap-4">
          <button type="button"
            onClick={handleReset}
            className="flex items-center gap-2 bg-rose-700/70 hover:bg-rose-600 text-white px-4 py-2.5 rounded-lg font-bold transition-colors"
          >
            Reset Database
          </button>
          <button type="button"
            onClick={handleSave}
            disabled={disableSave}
            className={`flex items-center gap-2 px-5 py-2.5 rounded-lg font-bold transition-all ${
              disableSave
                ? 'bg-slate-700 text-slate-400 cursor-not-allowed'
                : 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-lg shadow-emerald-900/40'
            }`}
          >
            <Save className="w-4 h-4" /> {isSaving ? 'Saving...' : 'Save Changes'}
          </button>
        </div>
      </div>

      {!isLoadingBaselines && runtimeWarning && !errorMessage && (
        <div className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-amber-200 text-sm">
          {runtimeWarning}
        </div>
      )}
      {errorMessage && (
        <div className="mb-4 rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-rose-200 text-sm flex items-center justify-between gap-3">
          <span>{errorMessage}</span>
          <button
            type="button"
            onClick={() => {
              void loadBaselines();
            }}
            className="rounded-md border border-rose-300/40 px-3 py-1 text-xs font-semibold text-rose-100 hover:bg-rose-500/20"
          >
            Retry
          </button>
        </div>
      )}
      {successMessage && (
        <div className="mb-4 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-emerald-200 text-sm">
          {successMessage}
        </div>
      )}
      {rosterToastMessage && (
        <div className="fixed bottom-6 right-6 z-[120] rounded-lg border border-slate-500/40 bg-[#0B1324]/95 px-4 py-2.5 text-sm text-slate-100 shadow-2xl backdrop-blur-sm">
          {rosterToastMessage}
        </div>
      )}

      <div className="flex-1 bg-[#0F172A] border border-white/5 rounded-2xl overflow-hidden shadow-2xl flex flex-col">
        {isLoadingBaselines ? (
          <div className="flex-1 min-h-[460px] flex items-center justify-center px-6">
            <div className="flex flex-col items-center justify-center text-center">
              <div className="h-12 w-12 rounded-full border-2 border-slate-500/35 border-t-emerald-400 animate-spin" />
              <p className="mt-4 text-sm text-slate-400">Loading players...</p>
            </div>
          </div>
        ) : (
         <div className="overflow-auto flex-1">
           <table className="w-full text-left border-collapse min-w-[1300px]">
             <thead>
               <tr className="bg-slate-900/80 border-b border-white/5 text-xs font-bold text-slate-400 uppercase tracking-wider sticky top-0 z-10 backdrop-blur-md">
                 <th className="px-4 py-5 w-[8%]">ID</th>
                 <th className="px-6 py-5 w-[16%]">Player Name</th>
                 <th className="px-4 py-5 text-center w-[9%]">Role</th>
                 <th className="px-4 py-5 text-center w-[8%]">Roster</th>
                 <th className="px-4 py-5 text-center w-[10%]">Sleep (Hrs)</th>
                 <th className="px-4 py-5 text-center w-[10%] relative group/th">
                   {renderHeaderTooltip(
                     'recovery',
                     'Recovery (Min)',
                     'Recovery Time',
                     'Minutes required for player to recover between spells.',
                     'right',
                     <Wind size={12} />
                   )}
                 </th>
                 <th className="px-4 py-5 text-center w-[10%] relative group/th">
                   {renderHeaderTooltip(
                     'fatigue',
                     'Fatigue Limit (0-10)',
                     'Fatigue Threshold',
                     'Baseline fatigue tolerance value. Higher values indicate greater capacity to handle match load before risk increases.',
                     'center',
                     <Activity size={12} />
                   )}
                 </th>
                 <th className="px-4 py-5 text-center w-[8%] relative group/th">
                   {renderHeaderTooltip(
                     'control',
                     'Control',
                     'Control Baseline',
                     'Higher control indicates better accuracy and consistency. Strong signal for spin bowlers and line-and-length discipline.'
                   )}
                 </th>
                 <th className="px-4 py-5 text-center w-[7%] relative group/th">
                   {renderHeaderTooltip(
                     'speed',
                     'Speed',
                     'Speed Baseline',
                     'Higher speed indicates fast-bowling pace and raw velocity. Key metric for fast bowlers.'
                   )}
                 </th>
                 <th className="px-4 py-5 text-center w-[7%] relative group/th">
                   {renderHeaderTooltip(
                     'power',
                     'Power',
                     'Power Baseline',
                     'Higher power indicates batting strength and boundary-hitting ability. Most relevant for batsmen and all-rounders.'
                   )}
                 </th>
                 <th className="px-6 py-5 text-right w-[15%]">Status</th>
                 <th className="px-4 py-5 w-[5%]"></th>
               </tr>
             </thead>
	             <tbody className="divide-y divide-white/5 text-sm">
		               {draftBaselines.length === 0 ? (
                 <tr>
                   <td colSpan={12} className="px-6 py-16">
                     <div className="flex flex-col items-center justify-center text-center">
                       <p className="text-lg font-semibold text-slate-200">No baseline players yet</p>
                       <p className="mt-2 text-sm text-slate-400">
                         Add a baseline player or Reset Database to restore defaults.
                       </p>
                     </div>
                   </td>
                 </tr>
	               ) : (
                 draftBaselines.map((p) => {
                  const isActive = p.inRoster === true;
                  const isPersisted = !p._isDraft;
                  const trimmedName = p.name.trim();
                  const idDisplay = p._isDraft
                    ? (trimmedName ? trimmedName : '—')
                    : (p.id || trimmedName || '—');
                  const rosterStatus = isActive
                    ? { label: 'In roster', color: 'text-indigo-200 bg-indigo-500/15 border-indigo-400/35' }
                    : { label: 'Not in roster', color: 'text-slate-300 bg-slate-700/30 border-slate-600/40' };

                  return (
                 <tr key={p._localId} className="group hover:bg-white/[0.02] transition-colors">
                   <td className="px-4 py-4 text-slate-400 font-mono text-xs">{idDisplay}</td>
                   <td className="px-6 py-4">
                       <input 
                         ref={(input) => {
                           nameInputRefs.current[p._localId] = input;
                         }}
                         type="text" 
                         placeholder="Enter player name..."
                         value={p.name}
                         readOnly={isPersisted}
                         onChange={(e) => updateDraft(p._localId, { name: e.target.value })}
                         className={`bg-transparent font-bold focus:outline-none border-b py-1 transition-colors w-full ${
                           isPersisted
                             ? 'text-slate-300 border-transparent cursor-not-allowed'
                             : 'text-white border-transparent focus:border-emerald-500'
                         }`}
                       />
                   </td>
                   <td className="px-4 py-4">
                      <select 
                        value={p.role}
                        onChange={(e) => updateDraft(p._localId, { role: e.target.value as BaselineRole })}
                        className="bg-slate-800 border border-slate-700 text-white text-xs rounded-lg px-2 py-1.5 focus:border-emerald-500 outline-none w-full text-center"
                      >
                        <option value="FAST">FAST</option>
                        <option value="SPIN">SPIN</option>
                        <option value="BAT">BAT</option>
                        <option value="AR">AR</option>
                      </select>
                   </td>
                   <td className="px-4 py-4 text-center">
                     <input
                       type="checkbox"
                       checked={isActive}
                       onChange={(e) => handleRosterToggle(p, e.target.checked)}
                       title="Toggle roster membership for this match."
                       className="w-4 h-4 accent-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed"
                     />
                   </td>
                   <td className="px-4 py-4 text-center bg-indigo-500/5">
                     <div className="flex items-center justify-center gap-2">
                       <input 
                         type="number" 
                         step="0.5"
                         min="0" max="12"
                         value={p.sleep}
                         onChange={(e) => updateDraft(p._localId, { sleep: Number(e.target.value) })}
                         className={`w-12 bg-transparent text-center font-mono focus:outline-none font-bold ${
                           p.sleep < 6 ? 'text-rose-400' : 'text-indigo-400'
                         }`}
                       />
                       <span className="text-xs text-slate-500">h</span>
                     </div>
                   </td>
                   <td className="px-4 py-4 text-center">
                     <div className="flex items-center justify-center gap-2 group-hover:bg-slate-800/50 rounded-lg py-1">
                       <input 
                         type="number" 
                         min="0"
                         value={p.recovery}
                         onChange={(e) => updateDraft(p._localId, { recovery: Number(e.target.value) })}
                         className="w-12 bg-transparent text-center text-white font-mono focus:text-emerald-400 focus:outline-none"
                       />
                       <span className="text-xs text-slate-500">min</span>
                     </div>
                   </td>
                   <td className="px-4 py-4 text-center">
                     <input 
                       type="number" 
                       min="0" max="10"
                       value={p.fatigueLimit}
                       onChange={(e) => updateDraft(p._localId, { fatigueLimit: Number(e.target.value) })}
                       className="w-14 bg-transparent text-center text-white font-mono focus:text-emerald-400 focus:outline-none"
                     />
                   </td>
                   <td className="px-4 py-4 text-center">
                     <input 
                       type="number" 
                       min="0" max="100"
                       value={p.control}
                       onChange={(e) => updateDraft(p._localId, { control: Number(e.target.value) })}
                       className="w-14 bg-transparent text-center text-white font-mono focus:text-emerald-400 focus:outline-none"
                     />
                   </td>
                   <td className="px-4 py-4 text-center">
                     <input 
                       type="number" 
                       min="0" max="100"
                       value={p.speed}
                       onChange={(e) => updateDraft(p._localId, { speed: Number(e.target.value) })}
                       className="w-12 bg-transparent text-center text-white font-mono focus:text-emerald-400 focus:outline-none"
                     />
                   </td>
                   <td className="px-4 py-4 text-center">
                     <input 
                       type="number" 
                       min="0" max="100"
                       value={p.power}
                       onChange={(e) => updateDraft(p._localId, { power: Number(e.target.value) })}
                       className="w-12 bg-transparent text-center text-white font-mono focus:text-emerald-400 focus:outline-none"
                     />
                   </td>
                   <td className="px-6 py-4 text-right">
                      <div className="flex items-center justify-end">
                        <span className={`inline-flex min-w-[120px] justify-center px-2.5 py-1 rounded-full text-[11px] font-medium border ${rosterStatus.color}`}>
                          {rosterStatus.label}
                        </span>
                      </div>
                   </td>
                   <td className="px-4 py-4 text-center">
                     <button type="button" 
                       onClick={() => handleDelete(p)}
                       className="p-2 text-slate-600 hover:text-rose-500 hover:bg-rose-500/10 rounded-lg transition-colors"
                       title="Remove Player from Baseline Model"
                     >
                       <Trash2 className="w-4 h-4" />
                     </button>
                   </td>
                 </tr>
               );
                 })
               )}
               
               {/* Add Player Row */}
               <tr>
                 <td colSpan={12} className="px-6 py-4 text-center border-t border-dashed border-white/10">
                   <button type="button" 
                     onClick={addDraftPlayer}
                     disabled={isLoadingBaselines}
                     className="flex items-center gap-2 mx-auto text-sm font-bold text-slate-500 hover:text-emerald-400 transition-colors py-4 w-full justify-center group"
                   >
                     <div className="w-8 h-8 rounded-full border border-slate-600 group-hover:border-emerald-500 flex items-center justify-center transition-colors">
                        <Plus className="w-4 h-4" />
                     </div>
                     Add New Player Baseline (Draft)
                   </button>
                 </td>
               </tr>
             </tbody>
           </table>
	         </div>
        )}
      </div>
    </motion.div>
  );
}

function BaselineInfoCard({ icon, title, desc }: { icon: React.ReactNode; title: string; desc: string }) {
  return (
    <div className="flex gap-3 p-3 rounded-lg bg-slate-900/50 border border-white/5">
      <div className="mt-0.5">{icon}</div>
      <div>
        <h4 className="text-xs font-bold text-white uppercase mb-1">{title}</h4>
        <p className="text-xs text-slate-500">{desc}</p>
      </div>
    </div>
  );
}

function ThinkingStep({ text, delay }: { text: string, delay: number }) {
  return (
    <motion.div 
      initial={{ opacity: 0, x: -10 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay }}
      className="flex items-center gap-3 text-sm text-slate-300"
    >
      <div className="w-4 h-4 rounded-full border-2 border-indigo-500 border-t-transparent animate-spin flex-shrink-0" />
      {text}
    </motion.div>
  );
}
