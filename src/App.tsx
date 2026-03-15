import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { 
  Activity, 
  Users, 
  Brain, 
  ChevronRight, 
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
  Hexagon,
  Trash2,
  UserMinus,
  Cpu,
  HelpCircle,
  Info,
  User
} from 'lucide-react';
import { motion, AnimatePresence, useMotionValue, useSpring, useTransform, useMotionTemplate } from 'motion/react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceArea,
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
  apiHealthUrl,
  apiOrchestrateUrl,
  checkHealth,
  deleteBaseline,
  ensureDemoSeedData,
  ensureCoachUserProfile,
  getAiStatus,
  getBaselineByPlayerId,
  getBaselinesWithMeta,
  postFatigueAgent,
  postOrchestrate,
  postRiskAgent,
  postTacticalAgent,
  resetBaselines,
  saveBaselines,
} from './lib/apiClient';
import CopilotChatPanel from './components/CopilotChatPanel';
import {
  DEMO_ROSTER_STORAGE_KEY,
  ensureDemoRoster,
  getDefaultDemoRosterIds,
  getRosterIds,
  removeFromRosterSession,
  ROSTER_STORAGE_KEY,
  setBaselineDraftCache,
  setRosterIds,
} from './lib/rosterStorage';
import { buildMatchContext, summarizeMatchContext } from './lib/buildMatchContext';
import { Baseline, BaselineRole } from './types/baseline';
import AuthPage from './pages/AuthPage';
import {
  getMicrosoftLoginUrl,
  getMicrosoftLogoutUrl,
  getUser,
  isDemoModeEnabled,
  setDemoModeEnabled,
} from './auth/swaAuth';
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
type AuthStatus = 'checking' | 'authenticated' | 'unauthenticated';
type SessionMode = 'demo' | 'authenticated' | 'guest';
type DemoStep = 'landing' | 'match-context' | 'dashboard';

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
  fatigueFloor?: number; // per-session baseline floor (fatigue must not drop below this)
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
  summary?: string;
  why?: string[];
  action?: string;
  projection?: string;
}

type AgentFeedState = 'IDLE' | 'RUNNING' | 'SUCCESS' | 'FALLBACK' | 'SKIPPED' | 'ERROR';
type AgentKey = 'fatigue' | 'risk' | 'tactical';

interface AgentFeedStatus {
  fatigue: AgentFeedState;
  risk: AgentFeedState;
  tactical: AgentFeedState;
}

interface OrchestrateMetaView {
  analysisId?: string;
  mode: 'auto' | 'full';
  responseMode?: 'demo' | 'live' | 'fallback';
  llmMode?: 'ai' | 'rules';
  routingMode?: 'ai' | 'fallback' | 'demo';
  reasons?: string[];
  fallbackReason?: string;
  azureAttempted?: boolean;
  agentAiFailures?: Partial<Record<'fatigue' | 'risk' | 'tactical', string>>;
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
  modelRouter?: Partial<
    Record<'fatigue' | 'risk' | 'tactical', { routedTo: 'llm' | 'rules'; reason?: string }>
  >;
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

interface CoachOutputView {
  summary: string;
  tacticalRecommendation: string;
  confidence: number;
  agentOutputs: Record<string, unknown>;
}

interface RouterDecisionView {
  mode?: 'auto' | 'full';
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
  agents?: {
    fatigue?: { routedTo: 'llm' | 'rules'; reason: string };
    risk?: { routedTo: 'llm' | 'rules'; reason: string };
    tactical?: { routedTo: 'llm' | 'rules'; reason: string };
  };
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

function AuthResolvingSplash() {
  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'linear-gradient(180deg, #061226 0%, #071a33 100%)',
        color: '#ffffff',
        fontFamily: 'inherit',
      }}
    >
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontSize: '28px', fontWeight: 700, marginBottom: '8px' }}>tactIQ</div>
        <div style={{ fontSize: '14px', opacity: 0.72 }}>Loading your workspace...</div>
      </div>
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

const cricketOverToBalls = (oversValue: number): number => {
  if (!Number.isFinite(oversValue)) return 0;
  const safeOvers = Math.max(0, oversValue);
  const wholeOvers = Math.floor(safeOvers);
  const ballPartRaw = Math.max(0, Math.round(((safeOvers - wholeOvers) + Number.EPSILON) * 10));
  const carryOvers = Math.floor(ballPartRaw / 6);
  const ballPart = ballPartRaw % 6;
  return ((wholeOvers + carryOvers) * 6) + ballPart;
};

const ballsToOvers = (balls: number): string => formatOverStr(balls);

const oversToBalls = (oversValue: string | number): number => {
  const parsed = typeof oversValue === 'number' ? oversValue : Number(String(oversValue || '').trim());
  return cricketOverToBalls(parsed);
};

const safeNum = (v: unknown, fallback: number): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
};

const toOptionalNumber = (value: unknown): number | undefined => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const FATIGUE_FLOOR_DEFAULT = 2.5;
const FATIGUE_K_OVERS = 0.9;
const FATIGUE_K_STRAIN = 0.25;
const FATIGUE_BUMP_NOBALL_MED = 0.1;
const FATIGUE_BUMP_NOBALL_HIGH = 0.2;
const FATIGUE_BUMP_INJURY_MED = 0.15;
const FATIGUE_BUMP_INJURY_HIGH = 0.3;

const calculateFatigueFloor = (player: Partial<Player>): number => {
  const baselineAware = player as Partial<Record<'baselineSleepHours' | 'baselineRecoveryMinutes' | 'typicalFatigueStart', unknown>>;
  const sleepHours = clamp(
    safeNum(baselineAware.baselineSleepHours ?? player.sleepHours, 7),
    0,
    12
  );
  const recoveryMinutes = clamp(
    safeNum(baselineAware.baselineRecoveryMinutes ?? player.recoveryTime, 45),
    0,
    240
  );
  const fatigueLimit = clamp(safeNum(player.baselineFatigue, 6), 0, 10);
  const typicalStart = toOptionalNumber(baselineAware.typicalFatigueStart);
  const baseStart = Number.isFinite(typicalStart)
    ? typicalStart!
    : Math.max(FATIGUE_FLOOR_DEFAULT, fatigueLimit * 0.35);
  const sleepAdjustment = clamp((7 - sleepHours) * 0.2, -0.4, 1.0);
  const recoveryAdjustment = clamp((45 - recoveryMinutes) / 90, -0.3, 0.8);
  const upperBound = fatigueLimit > 0 ? fatigueLimit : 10;
  return Number(clamp(baseStart + sleepAdjustment + recoveryAdjustment, 0, upperBound).toFixed(1));
};

const resolveFatigueFloor = (player: Partial<Player>): number => {
  const persisted = toOptionalNumber(player.fatigueFloor);
  if (Number.isFinite(persisted)) {
    return clamp(persisted!, 0, 10);
  }
  return calculateFatigueFloor(player);
};

const computeFatigueFromLoad = ({
  player,
  oversBowled,
  strainIndex,
  intensity,
  noBallRisk,
  injuryRisk,
}: {
  player: Partial<Player>;
  oversBowled: number;
  strainIndex: number;
  intensity?: string;
  noBallRisk?: unknown;
  injuryRisk?: unknown;
}): number => {
  const fatigueFloor = resolveFatigueFloor(player);
  const safeOvers = Math.max(0, safeNum(oversBowled, 0));
  const safeStrain = Math.max(0, safeNum(strainIndex, 0));
  const injuryToken = String(injuryRisk ?? player.injuryRisk ?? '').trim().toUpperCase();
  const noBallToken = String(noBallRisk ?? player.noBallRisk ?? '').trim().toUpperCase();
  const injuryBump =
    injuryToken === 'HIGH' || injuryToken === 'CRITICAL'
      ? FATIGUE_BUMP_INJURY_HIGH
      : injuryToken === 'MED' || injuryToken === 'MEDIUM'
        ? FATIGUE_BUMP_INJURY_MED
        : 0;
  const noBallBump =
    noBallToken === 'HIGH'
      ? FATIGUE_BUMP_NOBALL_HIGH
      : noBallToken === 'MED' || noBallToken === 'MEDIUM'
        ? FATIGUE_BUMP_NOBALL_MED
        : 0;
  const hasCriticalFlags =
    injuryToken === 'HIGH' || injuryToken === 'CRITICAL' || noBallToken === 'HIGH';
  if (safeOvers === 0 && safeStrain === 0 && !hasCriticalFlags) {
    return Number(clamp(fatigueFloor, 0, 10).toFixed(1));
  }
  const workloadDelta =
    safeOvers * (FATIGUE_K_OVERS * fatigueIntensityMultiplier(intensity)) +
    safeStrain * FATIGUE_K_STRAIN +
    injuryBump +
    noBallBump;
  // Baseline floor guard: fatigue can rise with workload but never drop below baselineToday.
  return Number(clamp(Math.max(fatigueFloor, fatigueFloor + workloadDelta), 0, 10).toFixed(1));
};

const getMaxOvers = (format: string): number => {
  const normalized = String(format || '').trim().toUpperCase();
  if (normalized === 'T20') return 4;
  if (normalized === 'ODI') return 10;
  return 12; // Session cap for Test format.
};

const getInningsTotalOvers = (format: string): number | null => {
  const normalized = String(format || '').trim().toUpperCase();
  if (normalized === 'T20') return 20;
  if (normalized === 'ODI') return 50;
  return null;
};

const getProjectionHorizon = (format: string): number => {
  const normalized = String(format || '').trim().toUpperCase();
  return normalized === 'T20' ? 4 : 5;
};

const clampOversBowled = (value: number, maxOvers: number): number => {
  const safeMax = Math.max(1, Math.floor(safeNum(maxOvers, 1)));
  return Math.max(0, Math.min(safeMax, Math.floor(safeNum(value, 0))));
};

const computeOversRemaining = (oversBowled: number, maxOvers: number): number =>
  Math.max(0, Math.floor(safeNum(maxOvers, 0)) - Math.floor(safeNum(oversBowled, 0)));

type SanitizedBowlerWorkload = Pick<Player, 'overs' | 'consecutiveOvers' | 'lastRestOvers' | 'fatigue' | 'fatigueFloor'> & {
  maxOvers: number;
  oversRemaining: number;
};

/**
 * Bowling workload invariants:
 * - 0 <= oversBowled <= format cap (T20=4, ODI=10, Test=12)
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
  const fatigueFloor = resolveFatigueFloor(player);
  const fatigue = clamp(Math.max(fatigueFloor, safeNum(player.fatigue, fatigueFloor)), 0, 10);
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
    fatigueFloor,
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

const BASELINE_METRIC_LIMITS = {
  sleep: { min: 0, max: 12 },
  recovery: { min: 0, max: 120 },
  fatigueLimit: { min: 0, max: 10 },
  control: { min: 0, max: 100 },
  speed: { min: 0, max: 15 },
  power: { min: 0, max: 10 },
} as const;

const normalizeBaselineRecord = (baseline: Partial<Baseline>): Baseline => ({
  id: normalizeBaselineId(baseline.id || baseline.playerId || baseline.baselineId || baseline.name),
  playerId: normalizeBaselineId(baseline.playerId || baseline.id || baseline.baselineId || baseline.name),
  name: String(baseline.name || baseline.id || baseline.playerId || 'Unknown Player').trim() || 'Unknown Player',
  role: baseline.role,
  isActive: baseline.isActive ?? baseline.active ?? true,
  inRoster: Boolean((baseline as Baseline).inRoster),
  sleepHoursToday: clamp(
    safeNum(baseline.sleepHoursToday ?? baseline.sleep, 7),
    BASELINE_METRIC_LIMITS.sleep.min,
    BASELINE_METRIC_LIMITS.sleep.max
  ),
  recoveryMinutes: clamp(
    safeNum(baseline.recoveryMinutes ?? baseline.recovery, 45),
    BASELINE_METRIC_LIMITS.recovery.min,
    BASELINE_METRIC_LIMITS.recovery.max
  ),
  fatigueLimit: clamp(
    safeNum(baseline.fatigueLimit, 6),
    BASELINE_METRIC_LIMITS.fatigueLimit.min,
    BASELINE_METRIC_LIMITS.fatigueLimit.max
  ),
  controlBaseline: clamp(
    safeNum(baseline.controlBaseline ?? baseline.control, 78),
    BASELINE_METRIC_LIMITS.control.min,
    BASELINE_METRIC_LIMITS.control.max
  ),
  speed: clamp(safeNum(baseline.speed, 7), BASELINE_METRIC_LIMITS.speed.min, BASELINE_METRIC_LIMITS.speed.max),
  power: clamp(safeNum(baseline.power, 6), BASELINE_METRIC_LIMITS.power.min, BASELINE_METRIC_LIMITS.power.max),
  sleep: clamp(
    safeNum(baseline.sleep ?? baseline.sleepHoursToday, 7),
    BASELINE_METRIC_LIMITS.sleep.min,
    BASELINE_METRIC_LIMITS.sleep.max
  ),
  recovery: clamp(
    safeNum(baseline.recovery ?? baseline.recoveryMinutes, 45),
    BASELINE_METRIC_LIMITS.recovery.min,
    BASELINE_METRIC_LIMITS.recovery.max
  ),
  control: clamp(
    safeNum(baseline.control ?? baseline.controlBaseline, 78),
    BASELINE_METRIC_LIMITS.control.min,
    BASELINE_METRIC_LIMITS.control.max
  ),
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

const isAuthPath = (value: unknown): boolean => {
  const path = String(value || '').toLowerCase();
  return path === '/auth' || path.startsWith('/auth/');
};

const isDemoPath = (value: unknown): boolean => {
  const path = String(value || '').toLowerCase();
  return path === '/demo' || path.startsWith('/demo/');
};

const toRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const hasAnyKeys = (value: unknown): boolean =>
  value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value as Record<string, unknown>).length > 0;

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
const deriveRoutingMetaFromSelectedAgents = (
  selectedAgents: AgentKey[],
  mode: 'auto' | 'full'
): {
  routeMode: 'auto' | 'full';
  dominantDriver: 'fatigue' | 'risk' | 'combined' | 'tactical';
  primaryReason: string;
  secondaryReason?: string;
} => {
  const selectedSet = new Set<AgentKey>(selectedAgents);
  if (mode === 'full') {
    return {
      routeMode: 'full',
      dominantDriver: 'combined',
      primaryReason: 'Full combined mode requested by user action.',
      secondaryReason: 'Combined mode keeps both supporting agents active by design.',
    };
  }
  if (selectedSet.has('risk') && !selectedSet.has('fatigue')) {
    return {
      routeMode: 'auto',
      dominantDriver: 'risk',
      primaryReason: 'Safety and strain exposure signals dominated this route selection.',
    };
  }
  if (selectedSet.has('fatigue') && !selectedSet.has('risk')) {
    return {
      routeMode: 'auto',
      dominantDriver: 'fatigue',
      primaryReason: 'Fatigue and workload accumulation signals dominated this route selection.',
    };
  }
  return {
    routeMode: 'auto',
    dominantDriver: 'tactical',
    primaryReason: 'Tactical continuity was prioritized from stable signals.',
  };
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
    const idKey = baselineKey(canonicalId);
    const nameKey = baselineKey(row.name);
    if (idKey && !activeIdByKey.has(idKey)) {
      activeIdByKey.set(idKey, canonicalId);
    }
    if (nameKey && !activeIdByKey.has(nameKey)) {
      activeIdByKey.set(nameKey, canonicalId);
    }
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

const idsFromRosterMarkedBaselines = (baselines: Baseline[]): string[] =>
  orderBaselinesForDisplay(baselines)
    .map((row) => normalizeBaselineRecord(row))
    .filter((row) => row.inRoster === true)
    .map((row) => normalizeBaselineId(row.id || row.playerId || row.name))
    .filter((id) => id.length > 0);

const idsFromAllBaselines = (baselines: Baseline[]): string[] =>
  orderBaselinesForDisplay(baselines)
    .map((row) => normalizeBaselineRecord(row))
    .map((row) => normalizeBaselineId(row.id || row.playerId || row.name))
    .filter((id) => id.length > 0);

const resolveDemoRosterIdsWithRepair = (
  candidateIds: string[],
  baselines: Baseline[]
): string[] => {
  const attempts = [
    candidateIds,
    getDefaultDemoRosterIds(),
    idsFromRosterMarkedBaselines(baselines),
    idsFromAllBaselines(baselines),
  ];

  for (const attempt of attempts) {
    const resolved = resolveRosterIdsFromBaselines(attempt, baselines);
    if (resolved.length > 0) return resolved;
  }
  return [];
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
  if (/(backend modules are not ready|backend modules unavailable|backend_not_ready|npm --prefix api run build|api\/dist)/i.test(trimmed)) {
    return 'Rules fallback (temporary backend build issue)';
  }
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
    if (candidate) {
      const normalizedCandidate = candidate.trim();
      if (/(backend modules are not ready|backend modules unavailable|backend_not_ready|npm --prefix api run build|api\/dist)/i.test(normalizedCandidate)) {
        return 'Rules fallback (temporary backend build issue)';
      }
      return traceId ? `${normalizedCandidate} (traceId: ${traceId})` : normalizedCandidate;
    }
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
const SWA_CLI_COMMAND = 'swa start http://localhost:5173 --api-location ./api';
const DEMO_SESSION_STORAGE_KEY = 'tactiq:demoSessionActive';
const COPILOT_ANALYSIS_ID_STORAGE_KEY = 'tactiq:lastAnalysisId';
const COPILOT_ANALYSIS_AT_STORAGE_KEY = 'tactiq:lastAnalysisAt';
const COPILOT_VISIBILITY_STORAGE_KEY = 'tactiq:copilotVisible';
const COPILOT_ANALYSIS_TTL_MS = 2 * 60 * 60 * 1000;

const readDemoSessionFlag = (): boolean => {
  if (typeof window === 'undefined') return false;
  const currentPath = String(window.location.pathname || '').trim();
  if (isDemoPath(currentPath)) return true;
  try {
    const raw = String(window.sessionStorage.getItem(DEMO_SESSION_STORAGE_KEY) || '').trim().toLowerCase();
    if (raw === 'true') return true;
    if (raw === 'false') return false;
  } catch {
    // Ignore storage read failures.
  }
  return isDemoModeEnabled();
};

const readDemoRosterIdsForBootstrap = (): string[] => {
  if (typeof window === 'undefined') return [];
  return ensureDemoRoster();
};

const persistDemoSessionFlag = (enabled: boolean): void => {
  if (typeof window === 'undefined') return;
  try {
    if (enabled) {
      window.sessionStorage.setItem(DEMO_SESSION_STORAGE_KEY, 'true');
      return;
    }
    window.sessionStorage.removeItem(DEMO_SESSION_STORAGE_KEY);
  } catch {
    // Ignore storage write failures.
  }
};

// --- Main App Component ---

export default function App() {
  const initialStoredMatchMode = useMemo(() => readStoredMatchMode(), []);
  const initialPath = useMemo(() => (typeof window === 'undefined' ? '/' : String(window.location.pathname || '')), []);
  const initialDemoMode = useMemo(() => readDemoSessionFlag(), []);
  const initialDemoBootstrap = useMemo(() => {
    if (!initialDemoMode) {
      return {
        baselines: [] as Baseline[],
        rosterIds: [] as string[],
        players: [] as Player[],
        activePlayerId: '',
      };
    }

    const seededData = ensureDemoSeedData();
    const seededBaselines = orderBaselinesForDisplay(seededData.baselines);
    const persistedRosterIds = seededData.rosterIds.length > 0
      ? seededData.rosterIds
      : readDemoRosterIdsForBootstrap();
    const resolvedRosterIds = resolveDemoRosterIdsWithRepair(persistedRosterIds, seededBaselines);
    if (resolvedRosterIds.length > 0) {
      setRosterIds(resolvedRosterIds);
    }
    const seededPlayers = hydrateDismissalStateFromSession(
      buildRosterPlayersFromBaselines([], seededBaselines, resolvedRosterIds)
    );
    const persistedActiveId = readStoredActivePlayerId();
    const activePlayerId = seededPlayers.find((player) => player.id === persistedActiveId)?.id
      || seededPlayers[0]?.id
      || '';
    return {
      baselines: seededBaselines,
      rosterIds: resolvedRosterIds,
      players: seededPlayers,
      activePlayerId,
    };
  }, [initialDemoMode]);
  const isAuthPathOnLoad = useMemo(() => {
    return isAuthPath(initialPath);
  }, [initialPath]);
  const [demoMode, setDemoMode] = useState<boolean>(() => initialDemoMode);
  const [authStatus, setAuthStatus] = useState<AuthStatus>(() => (initialDemoMode ? 'authenticated' : 'checking'));
  const [authUser, setAuthUser] = useState<{ userId: string; name?: string; email?: string } | null>(
    () =>
      initialDemoMode
        ? {
            userId: 'demo-local',
            name: 'Demo Coach',
            email: 'demo@local',
          }
        : null
  );
  const [authCheckResolved, setAuthCheckResolved] = useState<boolean>(() => initialDemoMode);
  const [, setCoachTeamId] = useState<string | null>(null);
  const [showSplash, setShowSplash] = useState(() => !isAuthPathOnLoad);
  const [authLocalHint, setAuthLocalHint] = useState<string | null>(null);
  const [copiedSwaCommand, setCopiedSwaCommand] = useState(false);
  const [aiAvailable, setAiAvailable] = useState<boolean>(false);
  const [aiStatusLoaded, setAiStatusLoaded] = useState<boolean>(false);
  const [page, setPage] = useState<Page>(() => 'landing');
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
  const [players, setPlayers] = useState<Player[]>(() => initialDemoBootstrap.players);
  const [activePlayerId, setActivePlayerId] = useState<string>(
    () => initialDemoBootstrap.activePlayerId || readStoredActivePlayerId()
  );
  const [agentState, setAgentState] = useState<'idle' | 'thinking' | 'done' | 'offline' | 'invalid'>('idle');
  const [runMode, setRunMode] = useState<RunMode>('auto');
  const [agentWarning, setAgentWarning] = useState<string | null>(null);
  const [agentFailure, setAgentFailure] = useState<AgentFailureDetail | null>(null);
  const [aiAnalysis, setAiAnalysis] = useState<AiAnalysis | null>(null);
  const [riskAnalysis, setRiskAnalysis] = useState<AiAnalysis | null>(null);
  const [tacticalAnalysis, setTacticalAnalysis] = useState<TacticalAgentResponse | null>(null);
  const [strategicAnalysis, setStrategicAnalysis] = useState<OrchestrateResponse['strategicAnalysis'] | null>(null);
  const [combinedAnalysis, setCombinedAnalysis] = useState<OrchestrateResponse['strategicAnalysis'] | null>(null);
  const [combinedBriefing, setCombinedBriefing] = useState<string | null>(null);
  const [combinedDecision, setCombinedDecision] = useState<TacticalCombinedDecision | null>(null);
  const [finalRecommendation, setFinalRecommendation] = useState<FinalRecommendation | null>(null);
  const [orchestrateMeta, setOrchestrateMeta] = useState<OrchestrateMetaView | null>(null);
  const [routerDecision, setRouterDecision] = useState<RouterDecisionView | null>(null);
  const [agentFeedStatus, setAgentFeedStatus] = useState<AgentFeedStatus>(() => getDefaultAgentFeedStatus());
  const [analysisActive, setAnalysisActive] = useState(false);
  const [analysisRequested, setAnalysisRequested] = useState(false);
  const [analysisBundleId, setAnalysisBundleId] = useState('');
  const [, setCopilotSessionAnalysisId] = useState<string>('');
  const [, setCopilotVerifiedAnalysisId] = useState<string>('');
  const [coachOutput, setCoachOutput] = useState<CoachOutputView | null>(null);
  const [recoveryMode, setRecoveryMode] = useState<RecoveryMode>('auto');
  const [manualRecovery, setManualRecovery] = useState<RecoveryLevel>('Moderate');
  const [baselineSource, setBaselineSource] = useState<'cosmos' | 'fallback'>('fallback');
  const [baselineWarning, setBaselineWarning] = useState<string | null>(null);
  const [rosterMutationError, setRosterMutationError] = useState<string | null>(null);
  const [workingBaselines, setWorkingBaselines] = useState<Baseline[]>(() => initialDemoBootstrap.baselines);
  const [matchRosterIds, setMatchRosterIds] = useState<string[]>(() => initialDemoBootstrap.rosterIds);
  const [isLoadingRosterPlayers, setIsLoadingRosterPlayers] = useState<boolean>(() => !initialDemoMode);
  const rosterLoadRequestIdRef = useRef(0);
  const rosterInitializedRef = useRef(false);
  const matchRosterIdsRef = useRef<string[]>([]);
  const teamModeLockedRef = useRef(Boolean(initialStoredMatchMode));
  const [isProfileOpen, setIsProfileOpen] = useState(false);
  const [isProfileTriggerHovered, setIsProfileTriggerHovered] = useState(false);
  const [isProfileActionHovered, setIsProfileActionHovered] = useState(false);
  const profileMenuRef = useRef<HTMLDivElement | null>(null);
  const fatigueRequestSeq = useRef(0);
  const fatigueAbortRef = useRef<AbortController | null>(null);
  const aiStatusInitRef = useRef(false);
  const recoveryIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const previousActivePlayerIdRef = useRef<string | null>(null);
  const baselineCacheRef = useRef<Map<string, Baseline>>(new Map());
  const sessionMode: SessionMode = useMemo(() => {
    if (demoMode) return 'demo';
    if (authStatus === 'authenticated' && Boolean(authUser?.userId)) return 'authenticated';
    return 'guest';
  }, [authStatus, authUser?.userId, demoMode]);
  const authResolving = !demoMode && (authStatus === 'checking' || !authCheckResolved);
  const isAppUnlocked = sessionMode !== 'guest';
  const isDemoSession = sessionMode === 'demo';
  const signedInEmail = useMemo(() => {
    const candidates = [authUser?.email, authUser?.name, authUser?.userId];
    for (const candidate of candidates) {
      const value = String(candidate || '').trim();
      if (!value) continue;
      if (value.includes('@')) return value;
    }
    return 'Signed in user';
  }, [authUser?.email, authUser?.name, authUser?.userId]);
  const demoStep: DemoStep = useMemo(() => {
    if (page === 'setup') return 'match-context';
    if (page === 'dashboard' || page === 'baselines') return 'dashboard';
    return 'landing';
  }, [page]);
  const isLocalAuthHost = useMemo(() => {
    if (typeof window === 'undefined') return false;
    const host = String(window.location.hostname || '').toLowerCase();
    return host === 'localhost' || host === '127.0.0.1';
  }, []);
  const aiEnabled = useMemo(() => {
    return aiStatusLoaded ? aiAvailable : true;
  }, [aiStatusLoaded, aiAvailable]);
  const logSessionDebug = useCallback((source: string, extra?: Record<string, unknown>) => {
    console.log('[session]', {
      source,
      userId: authUser?.userId || null,
      email: authUser?.email || null,
      demoMode,
      authStatus,
      sessionMode,
      ...(extra || {}),
    });
  }, [authStatus, authUser?.email, authUser?.userId, demoMode, sessionMode]);
  const setDemoSessionActive = useCallback((enabled: boolean, source: string) => {
    setDemoModeEnabled(enabled);
    persistDemoSessionFlag(enabled);
    setDemoMode(enabled);
    logSessionDebug(source, {
      nextDemoMode: enabled,
      nextSessionMode: enabled ? 'demo' : authStatus === 'authenticated' ? 'authenticated' : 'guest',
    });
  }, [authStatus, logSessionDebug]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    console.log('[view-state]', {
      route: String(window.location.pathname || ''),
      demoMode,
      sessionMode,
      demoStep,
      page,
      showSplash,
      isAppUnlocked,
      authStatus,
      isLoadingRosterPlayers,
    });
  }, [authStatus, demoMode, demoStep, isAppUnlocked, isLoadingRosterPlayers, page, sessionMode, showSplash]);

  useEffect(() => {
    if (aiStatusInitRef.current) return;
    aiStatusInitRef.current = true;
    let cancelled = false;
    const controller = new AbortController();
    void getAiStatus(controller.signal)
      .then((status) => {
        if (cancelled) return;
        const nextAiAvailable =
          Boolean(status?.aiEnabled) &&
          Boolean(status?.endpointConfigured) &&
          Boolean(status?.keyConfigured) &&
          Boolean(status?.deploymentConfigured);
        setAiAvailable(nextAiAvailable);
      })
      .catch((error) => {
        if (cancelled) return;
        if (import.meta.env.DEV) {
          console.warn('[ai][status] unavailable, defaulting to fallback', error);
        }
        setAiAvailable(false);
      })
      .finally(() => {
        if (cancelled) return;
        setAiStatusLoaded(true);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, []);

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
    if (!isProfileOpen) return;

    const handlePointerDown = (event: MouseEvent) => {
      if (!profileMenuRef.current?.contains(event.target as Node)) {
        setIsProfileOpen(false);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsProfileOpen(false);
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isProfileOpen]);

  useEffect(() => {
    if (isProfileOpen) return;
    setIsProfileTriggerHovered(false);
    setIsProfileActionHovered(false);
  }, [isProfileOpen]);

  useEffect(() => {
    logSessionDebug('state_change');
  }, [logSessionDebug]);

  useEffect(() => {
    if (typeof window === 'undefined' || showSplash) return;
    if (authResolving) return;
    const path = String(window.location.pathname || '');
    const onAuthPath = isAuthPath(path);
    const onDemoPath = isDemoPath(path);

    if (onDemoPath && sessionMode !== 'demo') {
      setDemoSessionActive(true, 'route_hydration:demo_path');
      setAuthStatus('authenticated');
      setAuthUser({
        userId: 'demo-local',
        name: 'Demo Coach',
        email: 'demo@local',
      });
      setPage('landing');
      logSessionDebug('route_hydration:enter_demo_landing', { path, page });
      return;
    }

    if (sessionMode === 'demo') {
      setDemoModeEnabled(true);
      persistDemoSessionFlag(true);
      ensureDemoSeedData();
      if (!onDemoPath) {
        window.history.replaceState(null, '', '/demo');
        logSessionDebug('route_redirect:force_demo_path', { path });
      }
      return;
    }

    if (sessionMode === 'authenticated') {
      if (onAuthPath || onDemoPath) {
        window.history.replaceState(null, '', '/');
        logSessionDebug('route_redirect:auth_to_home', { path });
      }
      return;
    }

    if (!onAuthPath) {
      window.history.replaceState(null, '', '/auth');
      logSessionDebug('route_redirect:guest_to_auth', { path });
    }
  }, [authResolving, logSessionDebug, page, sessionMode, setDemoSessionActive, showSplash]);

  useEffect(() => {
    if (isAppUnlocked) {
      setAuthLocalHint(null);
      setCopiedSwaCommand(false);
    }
  }, [isAppUnlocked]);

  useEffect(() => {
    let cancelled = false;
    if (demoMode) {
      console.log('[session]', {
        source: 'auth_hydration:demo_short_circuit',
        userId: authUser?.userId || null,
        email: authUser?.email || null,
        demoMode,
        authStatus,
        sessionMode: 'demo',
      });
      setAuthStatus('authenticated');
      setAuthUser({
        userId: 'demo-local',
        name: 'Demo Coach',
        email: 'demo@local',
      });
      setAuthCheckResolved(true);
      setCoachTeamId('demo-local-team');
      return () => {
        cancelled = true;
      };
    }
    setAuthCheckResolved(false);
    setAuthStatus('checking');
    setAuthUser(null);
    setCoachTeamId(null);
    console.log('[session]', {
      source: 'auth_hydration:start',
      userId: null,
      email: null,
      demoMode,
      authStatus: 'checking',
      sessionMode: 'guest',
      preserveAuthenticatedState: false,
    });
    void getUser()
      .then((user) => {
        if (cancelled) return;
        if (user.isAuthenticated && user.userId) {
          console.log('[session]', {
            source: 'auth_hydration:authenticated',
            userId: user.userId,
            email: user.email || null,
            demoMode: false,
            authStatus: 'authenticated',
            sessionMode: 'authenticated',
          });
          setAuthStatus('authenticated');
          setAuthUser({
            userId: user.userId,
            ...(user.name ? { name: user.name } : {}),
            ...(user.email ? { email: user.email } : {}),
          });
          return;
        }
        console.log('[session]', {
          source: 'auth_hydration:guest',
          userId: null,
          email: null,
          demoMode: false,
          authStatus: 'unauthenticated',
          sessionMode: 'guest',
        });
        setAuthStatus('unauthenticated');
        setAuthUser(null);
        setCoachTeamId(null);
      })
      .catch((error) => {
        if (cancelled) return;
        console.warn('[auth] getUser failed during hydration', error);
        setAuthStatus('unauthenticated');
        setAuthUser(null);
        setCoachTeamId(null);
      })
      .finally(() => {
        if (cancelled) return;
        setAuthCheckResolved(true);
      });
    return () => {
      cancelled = true;
    };
  }, [demoMode]);

  useEffect(() => {
    if (sessionMode === 'guest') {
      setCoachTeamId(null);
      return;
    }
    if (isDemoSession) {
      setCoachTeamId('demo-local-team');
      return;
    }
    if (!authUser?.userId) return;

    let cancelled = false;
    void ensureCoachUserProfile().then((profile) => {
      if (cancelled) return;
      setCoachTeamId(profile.teamId);
    }).catch((error) => {
      if (cancelled) return;
      const isAuthError = error instanceof ApiClientError && (error.status === 401 || error.status === 403);
      if (isAuthError) {
        console.warn('[auth] profile ensure blocked', { status: error.status, url: error.url });
        setBaselineWarning('Sign in again to load your team workspace.');
      } else {
        console.error('[auth] profile ensure failed', error);
        setBaselineWarning('Could not load coach workspace. Team data may be unavailable.');
      }
      setCoachTeamId(null);
    });
    return () => {
      cancelled = true;
    };
  }, [authUser?.userId, isDemoSession, sessionMode]);

  const handleContinueWithMicrosoft = useCallback(() => {
    setDemoSessionActive(false, 'action:continue_with_microsoft');
    setCopiedSwaCommand(false);
    if (isLocalAuthHost) {
      setAuthLocalHint(
        'Microsoft sign-in works on the deployed site or when running locally with the Azure SWA CLI. Use Demo locally, or run `swa start`.'
      );
      return;
    }
    setAuthLocalHint(null);
    if (typeof window !== 'undefined') {
      window.location.assign(getMicrosoftLoginUrl());
    }
  }, [isLocalAuthHost, setDemoSessionActive]);

  const handleTryDemoMode = useCallback(() => {
    setAuthLocalHint(null);
    setCopiedSwaCommand(false);
    setDemoSessionActive(true, 'action:try_demo');
    setCoachTeamId('demo-local-team');
    setPage('landing');
    if (typeof window !== 'undefined') {
      try {
        window.history.pushState(null, '', '/demo');
      } catch {
        window.location.assign('/demo');
      }
    }
  }, [setDemoSessionActive]);

  const handleExitDemo = useCallback(() => {
    setDemoSessionActive(false, 'action:exit_demo');
    setIsProfileOpen(false);
    if (typeof window !== 'undefined') {
      const path = String(window.location.pathname || '');
      if (isDemoPath(path)) {
        window.history.replaceState(null, '', '/');
      }
    }
  }, [setDemoSessionActive]);

  const handleSignOut = useCallback(() => {
    setDemoSessionActive(false, 'action:sign_out');
    setAuthStatus('unauthenticated');
    setAuthUser(null);
    setCoachTeamId(null);
    if (typeof window !== 'undefined') {
      window.location.assign(getMicrosoftLogoutUrl());
    }
  }, [setDemoSessionActive]);

  const handleProfilePrimaryAction = useCallback(() => {
    if (sessionMode === 'demo') {
      handleExitDemo();
      return;
    }
    handleSignOut();
  }, [handleExitDemo, handleSignOut, sessionMode]);

  const handleCopySwaCommand = useCallback(async () => {
    if (typeof window === 'undefined') return;
    try {
      await window.navigator.clipboard.writeText(SWA_CLI_COMMAND);
      setCopiedSwaCommand(true);
      return;
    } catch {
      try {
        const tempInput = document.createElement('textarea');
        tempInput.value = SWA_CLI_COMMAND;
        tempInput.setAttribute('readonly', 'true');
        tempInput.style.position = 'fixed';
        tempInput.style.opacity = '0';
        document.body.appendChild(tempInput);
        tempInput.focus();
        tempInput.select();
        document.execCommand('copy');
        document.body.removeChild(tempInput);
        setCopiedSwaCommand(true);
      } catch {
        setCopiedSwaCommand(false);
      }
    }
  }, []);

  useEffect(() => {
    if (!isAppUnlocked) {
      setIsLoadingRosterPlayers(false);
      return;
    }
    const applyBaselinesToRoster = (rows: Baseline[], reason: 'mount' | 'event') => {
      const orderedRows = orderBaselinesForDisplay(rows);
      const previousRosterIds = matchRosterIdsRef.current;
      const baseRosterIds = rosterInitializedRef.current
        ? previousRosterIds
        : getRosterIds();
      const resolvedIds = isDemoSession
        ? resolveDemoRosterIdsWithRepair(baseRosterIds, orderedRows)
        : resolveRosterIdsFromBaselines(baseRosterIds, orderedRows);
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
      setRosterIds(resolvedIds);
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
      if (!isDemoSession) {
        setIsLoadingRosterPlayers(true);
      }
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
        if (error instanceof ApiClientError && (error.status === 401 || error.status === 403)) {
          setBaselineWarning('Sign in with Microsoft to load player baselines.');
        } else if (error instanceof ApiClientError && error.status === 500) {
          setBaselineWarning('Baselines service is unavailable. Check Functions env configuration.');
        } else {
          setBaselineWarning('Failed to load baseline players from backend.');
        }
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
  }, [isAppUnlocked, isDemoSession]);

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
  useEffect(() => {
    if (!selectedPlayer) return;
    const nextFloor = calculateFatigueFloor(selectedPlayer);
    setPlayers((prev) =>
      prev.map((player) => {
        if (player.id !== selectedPlayer.id) return player;
        const currentFloor = toOptionalNumber(player.fatigueFloor);
        const nextFatigue = clamp(Math.max(nextFloor, safeNum(player.fatigue, nextFloor)), 0, 10);
        const floorChanged =
          !Number.isFinite(currentFloor) || Math.abs((currentFloor as number) - nextFloor) > 0.01;
        const fatigueChanged = Math.abs(safeNum(player.fatigue, nextFloor) - nextFatigue) > 0.01;
        if (!floorChanged && !fatigueChanged) return player;
        return {
          ...player,
          fatigueFloor: nextFloor,
          fatigue: nextFatigue,
        };
      })
    );
  }, [
    selectedPlayer?.id,
    selectedPlayer?.sleepHours,
    selectedPlayer?.recoveryTime,
    selectedPlayer?.baselineFatigue,
  ]);
  const normalizedPhase = normalizePhase(matchContext.phase);
  const activeDerived = React.useMemo(() => {
    if (!selectedPlayer) return null;
    const workload = sanitizeBowlerWorkload(selectedPlayer, matchContext.format);
    const oversBowled = workload.overs;
    const maxOvers = workload.maxOvers;
    const oversRemaining = workload.oversRemaining;
    const quotaComplete = oversBowled >= maxOvers;
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
      const fixedInningsOvers = getInningsTotalOvers(matchContext.format);
      if (fixedInningsOvers != null) {
        next.totalOvers = fixedInningsOvers;
      }
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
      const fixedInningsOvers = getInningsTotalOvers(matchContext.format);
      const nextTotalOvers = fixedInningsOvers ?? prev.totalOvers;

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
          workload.fatigue === safeNum(p.fatigue, workload.fatigueFloor)
        ) {
          return p;
        }
        return {
          ...p,
          overs: workload.overs,
          lastRestOvers: nextLastRest,
          consecutiveOvers: 0,
          fatigueFloor: workload.fatigueFloor,
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
          const nextFatigue = clamp(Math.max(workload.fatigueFloor, workload.fatigue - recoveryRate), 0, 10);

          return {
            ...p,
            overs: workload.overs,
            lastRestOvers: workload.lastRestOvers,
            consecutiveOvers: workload.consecutiveOvers,
            fatigueFloor: workload.fatigueFloor,
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
    setRosterIds(resolvedIds);
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
    return applyRosterIdsToState(nextIdsInput, 'explicit_user_action');
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
    const nextIds = isDemoSession
      ? removeFromRosterSession(normalizedId, previousRosterIds)
      : previousRosterIds.filter((id) => baselineKey(id) !== normalizedKey);
    const nextResolvedIds = applyRosterIdsToState(nextIds, 'roster_remove');
    const nextKeys = nextIds.map((id) => baselineKey(id));
    const resolvedKeys = nextResolvedIds.map((id) => baselineKey(id));
    if (
      isDemoSession &&
      (
        nextKeys.length !== resolvedKeys.length ||
        nextKeys.some((key, index) => key !== resolvedKeys[index])
      )
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
    if (!isDemoSession) return;
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
      if (event.key && event.key !== ROSTER_STORAGE_KEY && event.key !== DEMO_ROSTER_STORAGE_KEY) return;
      syncRosterFromLocalStorage();
    };

    window.addEventListener('storage', handleStorage);
    window.addEventListener('focus', syncRosterFromLocalStorage);
    return () => {
      window.removeEventListener('storage', handleStorage);
      window.removeEventListener('focus', syncRosterFromLocalStorage);
    };
  }, [applyMatchRosterIds, isDemoSession]);

  const handleAddOver = () => {
    if (!activePlayer) return;
    if ((activePlayer.injuryRisk === 'High' || activePlayer.injuryRisk === 'Critical') || activePlayer.isSub || activePlayer.isUnfit) return;
    const inningsLimitOvers = getInningsTotalOvers(matchContext.format) ?? Math.max(1, Math.floor(matchState.totalOvers));
    const inningsMaxBalls = totalBallsFromOvers(inningsLimitOvers);
    const currentInningsBalls = Math.max(0, Math.floor(matchState.ballsBowled));
    if (currentInningsBalls >= inningsMaxBalls) return;
    const cap = getMaxOvers(matchContext.format);
    const currentWorkload = sanitizeBowlerWorkload(activePlayer, matchContext.format);
    if (currentWorkload.overs >= cap) return;
    updatePlayer(activePlayer.id, (p) => {
      const workload = sanitizeBowlerWorkload(p, matchContext.format);
      if (workload.overs >= cap) return {};
      const nextOvers = workload.overs + 1;
      const nextFatigue = computeFatigueFromLoad({
        player: p,
        oversBowled: nextOvers,
        strainIndex: safeNum(p.strainIndex, 0),
        intensity: matchContext.pitch || 'Medium',
      });
      return {
        overs: nextOvers,
        fatigue: nextFatigue,
        fatigueFloor: workload.fatigueFloor,
        isResting: false,
      };
    });
    updateMatchState({ ballsBowled: Math.min(inningsMaxBalls, currentInningsBalls + 6) });
  };

  const handleDecreaseOver = () => {
    if (!activePlayer) return;
    const currentWorkload = sanitizeBowlerWorkload(activePlayer, matchContext.format);
    if (currentWorkload.overs <= 0) return;
    updatePlayer(activePlayer.id, (p) => {
      const workload = sanitizeBowlerWorkload(p, matchContext.format);
      const nextOvers = Math.max(0, workload.overs - 1);
      const nextFatigue = computeFatigueFromLoad({
        player: p,
        oversBowled: nextOvers,
        strainIndex: safeNum(p.strainIndex, 0),
        intensity: matchContext.pitch || 'Medium',
      });
      return {
        overs: nextOvers,
        fatigue: nextFatigue,
        fatigueFloor: workload.fatigueFloor,
      };
    });
    updateMatchState((prev) => ({ ballsBowled: Math.max(0, prev.ballsBowled - 6) }));
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
    const fatigueResult = agentType === 'fatigue' ? (result as FatigueAgentResponse) : null;
    const summary =
      fatigueResult && typeof fatigueResult.summary === 'string' && fatigueResult.summary.trim().length > 0
        ? fatigueResult.summary.trim()
        : result.explanation.trim();
    const why =
      fatigueResult && Array.isArray(fatigueResult.why)
        ? fatigueResult.why
            .map((entry) => String(entry || '').trim())
            .filter(Boolean)
            .slice(0, 3)
        : [];
    const action =
      fatigueResult && typeof fatigueResult.action === 'string' && fatigueResult.action.trim().length > 0
        ? fatigueResult.action.trim()
        : result.recommendation.trim();
    const projection =
      fatigueResult && typeof fatigueResult.projection === 'string' && fatigueResult.projection.trim().length > 0
        ? fatigueResult.projection.trim()
        : '';

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
      summary,
      why,
      action,
      projection,
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
    const orchestrateRequestUrl = apiOrchestrateUrl;

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
    const preserveExistingAnalysisShell = mode === 'full';
    setAnalysisRequested(true);
    if (!preserveExistingAnalysisShell) {
      setAnalysisActive(false);
    }

    fatigueAbortRef.current?.abort();
    const controller = new AbortController();
    fatigueAbortRef.current = controller;
    const requestId = ++fatigueRequestSeq.current;

    if (!preserveExistingAnalysisShell) {
      setAiAnalysis(null);
      setRiskAnalysis(null);
      setTacticalAnalysis(null);
      setStrategicAnalysis(null);
      setCombinedAnalysis(null);
      setCombinedBriefing(null);
      setCombinedDecision(null);
      setFinalRecommendation(null);
      setOrchestrateMeta(null);
      setRouterDecision(null);
      setAnalysisBundleId('');
      setCoachOutput(null);
    }
    let requestInFlight = false;
    const startRequest = () => {
      if (requestInFlight) return;
      requestInFlight = true;
      setAgentFeedStatus(
        mode === 'full'
          ? { fatigue: 'RUNNING', risk: 'RUNNING', tactical: 'RUNNING' }
          : { fatigue: 'IDLE', risk: 'IDLE', tactical: 'RUNNING' }
      );
      setAgentWarning(null);
      setAgentFailure(null);
      setAgentState('thinking');
    };
    if (preserveExistingAnalysisShell) {
      // Full mode should transition into visible running state immediately.
      startRequest();
    }

    const requestMode: 'auto' | 'full' = mode === 'full' ? 'full' : 'auto';
    const maxOvers = Math.max(1, safeNum(currentTelemetry.maxOvers, getMaxOvers(matchContext.format)));
    const oversBowled = clampOversBowled(safeNum(currentTelemetry.oversBowled, 0), maxOvers);
    const oversRemaining = computeOversRemaining(oversBowled, maxOvers);
    const quotaComplete = Boolean(currentTelemetry.quotaComplete) || oversBowled >= maxOvers;
    const oversQuotaReached = oversBowled >= maxOvers;
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
    const runRatePressureGap =
      Number.isFinite(requiredRunRate) && Number.isFinite(currentRunRate)
        ? Number((requiredRunRate - currentRunRate).toFixed(2))
        : 0;
    const recoveryToken = String(currentTelemetry.heartRateRecovery || '').trim().toUpperCase();
    const normalizedRecoveryPenalty = recoveryToken === 'POOR' ? 0.2 : recoveryToken === 'MODERATE' ? 0.1 : 0.04;
    const dismissalRiskScore = clamp(
      (fatigue / 10) * 0.38 +
        (strainIndex / 10) * 0.24 +
        Math.max(0, runRatePressureGap) * 0.16 +
        (injuryLabel === 'CRITICAL' || injuryLabel === 'HIGH'
          ? 0.2
          : injuryLabel === 'MEDIUM'
            ? 0.1
            : 0.03) +
        normalizedRecoveryPenalty,
      0,
      1
    );
    const controlExecutionRiskScore = clamp(
      (fatigue / 10) * 0.24 +
        (strainIndex / 10) * 0.24 +
        (noBallRiskLabel === 'HIGH' ? 0.26 : noBallRiskLabel === 'MEDIUM' ? 0.13 : 0.04) +
        normalizedRecoveryPenalty +
        Math.max(0, runRatePressureGap) * 0.14,
      0,
      1
    );
    const dismissalRiskEstimate =
      focusRole === 'BATTER'
        ? dismissalRiskScore >= 0.67
          ? 'HIGH'
          : dismissalRiskScore >= 0.36
            ? 'MODERATE'
            : 'LOW'
        : undefined;
    const controlExecutionRiskEstimate =
      focusRole === 'BOWLER'
        ? controlExecutionRiskScore >= 0.67
          ? 'HIGH'
          : controlExecutionRiskScore >= 0.36
            ? 'MODERATE'
            : 'LOW'
        : undefined;
    const ballsInOver = ballsBowled % 6;
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
    let selectedPlayerBaseline = localSelectedBaseline;
    try {
      selectedPlayerBaseline =
        await getBaselineForPlayer(activePlayer?.id || currentTelemetry.playerId, controller.signal) || localSelectedBaseline;
    } catch (baselineError) {
      if (import.meta.env.DEV) {
        console.warn('[orchestrate] baseline lookup failed, using local baseline fallback', baselineError);
      }
      selectedPlayerBaseline = localSelectedBaseline;
    }
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
    const resolvePlayerType = (role: unknown): 'PACE' | 'SPIN' | 'ALL_ROUND' | 'BATTER' | 'BOWLER' => {
      const token = String(role || '').trim().toLowerCase();
      if (token.includes('spin')) return 'SPIN';
      if (token.includes('fast') || token.includes('pace') || token.includes('seam')) return 'PACE';
      if (token.includes('all-round')) return 'ALL_ROUND';
      if (token.includes('bat')) return 'BATTER';
      return 'BOWLER';
    };
    const normalizedInjuryRiskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' =
      injuryLabelRaw === 'CRITICAL'
        ? 'CRITICAL'
        : injuryLabelRaw === 'HIGH'
          ? 'HIGH'
          : injuryLabelRaw === 'MED' || injuryLabelRaw === 'MEDIUM'
            ? 'MEDIUM'
            : 'LOW';
    const normalizedNoBallRiskLevel: 'LOW' | 'MEDIUM' | 'HIGH' =
      noBallRiskLabelRaw === 'HIGH'
        ? 'HIGH'
        : noBallRiskLabelRaw === 'MED' || noBallRiskLabelRaw === 'MEDIUM'
          ? 'MEDIUM'
          : 'LOW';
    const markedFitStatus: 'FIT' | 'UNFIT' = isUnfit ? 'UNFIT' : 'FIT';
    // Match-law constraint has highest priority: quota reached means bowler is unavailable.
    const availabilityStatus: 'AVAILABLE' | 'LIMITED' | 'TACTICAL_RISK' | 'UNAVAILABLE' =
      oversQuotaReached
        ? 'UNAVAILABLE'
        : normalizedInjuryRiskLevel === 'CRITICAL' || markedFitStatus === 'UNFIT'
        ? 'UNAVAILABLE'
        : fatigue > baselineFatigueLimit && strainIndex >= 4
          ? 'LIMITED'
          : normalizedNoBallRiskLevel === 'HIGH'
            ? 'TACTICAL_RISK'
            : 'AVAILABLE';
    const substitutionRequired = availabilityStatus === 'UNAVAILABLE';
    const heartRateRecoveryToken = String(currentTelemetry.heartRateRecovery || '').trim().toUpperCase();
    const dominantRiskDriver:
      | 'overs_quota_reached'
      | 'injury'
      | 'fatigue'
      | 'recovery'
      | 'control'
      | 'matchup'
      | 'pressure_phase'
      | 'mixed' =
      oversQuotaReached
        ? 'overs_quota_reached'
        : availabilityStatus === 'UNAVAILABLE'
        ? 'injury'
        : fatigue > baselineFatigueLimit && strainIndex >= 4
          ? 'fatigue'
          : heartRateRecoveryToken === 'POOR' || baselineRecoveryMinutes < 35
            ? 'recovery'
            : normalizedNoBallRiskLevel === 'HIGH' || baselineControl < 70
              ? 'control'
              : normalizedPhase === 'death' || ballsRemaining <= 12
                ? 'pressure_phase'
                : 'mixed';
    const defendingOrChasing =
      teamMode === 'BOWLING'
        ? typeof matchState.target === 'number' && matchState.target > 0
          ? 'defending'
          : 'bowling_first'
        : typeof matchState.target === 'number' && matchState.target > 0
          ? 'chasing'
          : 'batting_first';
    const scoreContext = `${Math.max(0, matchState.runs)}/${Math.max(0, matchState.wickets)} after ${formatOverStr(matchState.ballsBowled)} overs`;
    const wicketContext = `${Math.max(0, 10 - matchState.wickets)} wickets in hand`;
    const suggestedBenchOptions = players
      .filter((p) => {
        if (p.id === activePlayer?.id) return false;
        if (p.inRoster === false || p.isSub || p.isUnfit || p.isInjured) return false;
        if (resolveDismissalStatus(p) === 'OUT') return false;
        return true;
      })
      .map((p) => ({
        playerId: p.id,
        name: p.name,
        role: p.role,
        playerType: resolvePlayerType(p.role),
      }))
      .slice(0, 5);
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
      dataMode: demoMode ? 'demo' : 'live',
      llmMode: 'ai',
      context: fullMatchContext,
      teamMode,
      focusRole,
      matchState: teamMode,
      selectedPlayerRole: focusRole,
      userAction: 'RUN_COACH',
      analysisState: {
        playerName: currentTelemetry.playerName,
        role: currentTelemetry.role,
        bowlingStyle: resolvePlayerType(currentTelemetry.role),
        playerType: resolvePlayerType(currentTelemetry.role),
        oversBowled,
        maxOvers,
        strainIndex,
        fatigueIndex: fatigue,
        heartRateRecovery: currentTelemetry.heartRateRecovery,
        injuryRiskLevel: normalizedInjuryRiskLevel,
        controlRisk: normalizedNoBallRiskLevel,
        noBallRisk: normalizedNoBallRiskLevel,
        markedFitStatus,
        availabilityStatus,
        substitutionRequired,
        dominantRiskDriver,
        matchMode: teamMode,
        defendingOrChasing,
        phaseOfPlay: normalizedPhase,
        scoreContext,
        scoreRuns: matchState.runs,
        wickets: matchState.wickets,
        overs: Number(formatOverStr(matchState.ballsBowled)),
        balls: ballsInOver,
        target: typeof matchState.target === 'number' ? matchState.target : undefined,
        targetRuns: typeof matchState.target === 'number' ? matchState.target : undefined,
        wicketContext,
        runRatePressure: runRatePressureGap,
        dismissalRiskEstimate,
        controlExecutionRiskEstimate,
        suggestedBenchOptions,
      },
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
        availabilityStatus,
        substitutionRequired,
        dominantRiskDriver,
        intensity: matchContext.pitch || 'Medium',
        runRatePressure: runRatePressureGap,
        dismissalRiskEstimate,
        controlExecutionRiskEstimate,
        scoreRuns: matchState.runs,
        wickets: matchState.wickets,
        over: Number(formatOverStr(matchState.ballsBowled)),
        ballsInOver,
        targetRuns: typeof matchState.target === 'number' ? matchState.target : undefined,
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
        markedFitStatus,
        availabilityStatus,
        substitutionRequired,
        dominantRiskDriver,
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
        balls: ballsInOver,
        ballsInOver,
        runRatePressure: runRatePressureGap,
        dismissalRiskEstimate,
        controlExecutionRiskEstimate,
        scoreboardPressure:
          runRatePressureGap >= 1.2 ? 'HIGH' : runRatePressureGap >= 0.45 ? 'MODERATE' : 'LOW',
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
      console.log('[agent] calling', orchestrateRequestUrl, { mode: requestMode });
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
      setCombinedBriefing(typeof result.combinedBriefing === 'string' && result.combinedBriefing.trim().length > 0 ? result.combinedBriefing.trim() : null);
      setCombinedDecision((result.finalDecision || result.combinedDecision) || null);
      setFinalRecommendation(result.finalRecommendation || null);
      const buildModelRouterEntry = (
        agent: AgentKey
      ): { routedTo: 'llm' | 'rules'; reason?: string } | undefined => {
        const decisionEntry = result.routerDecision?.agents?.[agent];
        if (decisionEntry && (decisionEntry.routedTo === 'llm' || decisionEntry.routedTo === 'rules')) {
          return {
            routedTo: decisionEntry.routedTo,
            reason: String(decisionEntry.reason || '').trim() || undefined,
          };
        }
        const resultEntry = result.agentResults?.[agent];
        const routeToken = String(resultEntry?.routedTo || '').trim().toLowerCase();
        const statusToken = String(resultEntry?.status || '').trim().toLowerCase();
        const routedTo: 'llm' | 'rules' =
          routeToken === 'llm' || routeToken === 'rules'
            ? routeToken
            : statusToken === 'fallback'
              ? 'rules'
              : 'llm';
        const reason =
          typeof resultEntry?.reason === 'string' && resultEntry.reason.trim().length > 0
            ? resultEntry.reason.trim()
            : typeof resultEntry?.error === 'string' && resultEntry.error.trim().length > 0
              ? resultEntry.error.trim()
            : undefined;
        return { routedTo, reason };
      };
      const modelRouter = {
        fatigue: buildModelRouterEntry('fatigue'),
        risk: buildModelRouterEntry('risk'),
        tactical: buildModelRouterEntry('tactical'),
      };
      const resultMetaRecord = toRecord(result.meta as unknown);
      const normalizeAgentList = (value: unknown): AgentKey[] => {
        if (!Array.isArray(value)) return [];
        const normalized: AgentKey[] = [];
        value.forEach((entry) => {
          const key = toAgentKey(entry);
          if (key) normalized.push(key);
        });
        return normalized;
      };
      const metaMode: 'auto' | 'full' =
        String(resultMetaRecord.mode || mode || 'auto').trim().toLowerCase() === 'full'
          ? 'full'
          : 'auto';
      const metaExecutedAgents = normalizeAgentList(resultMetaRecord.executedAgents);
      const metaUsedFallbackAgents = normalizeAgentList(resultMetaRecord.usedFallbackAgents);
      const metaRouterFallbackMessage =
        typeof resultMetaRecord.routerFallbackMessage === 'string'
          ? resultMetaRecord.routerFallbackMessage
          : undefined;
      const metaModelRoutingRecord = toRecord(resultMetaRecord.modelRouting);
      const metaFallbacksUsed = Array.isArray(metaModelRoutingRecord.fallbacksUsed)
        ? metaModelRoutingRecord.fallbacksUsed
            .map((entry) => String(entry || '').trim())
            .filter((entry) => entry.length > 0)
        : [];
      const hasAnyImmediateOutput = Boolean(
        fatigueMapped ||
        riskMapped ||
        tacticalMapped ||
        result.strategicAnalysis ||
        result.combinedDecision ||
        result.combinedBriefing
      );
      const fallbackPlayerToken =
        String(selectedPlayer?.name || activePlayer?.name || 'session')
          .trim()
          .replace(/\s+/g, '-')
          .toLowerCase() || 'session';
      const localFallbackAnalysisId = `local-${fallbackPlayerToken}-${Date.now()}`;
      const metaAnalysisId = String(resultMetaRecord.analysisId || '').trim();
      const metaCopilotAnalysisId = String(resultMetaRecord.copilotAnalysisId || '').trim();
      const resolvedAnalysisId =
        String(
          metaAnalysisId ||
          metaCopilotAnalysisId ||
          result.analysisBundleId ||
          result.analysisId ||
          localFallbackAnalysisId
        ).trim() || localFallbackAnalysisId;
      if (!metaAnalysisId && !metaCopilotAnalysisId) {
        console.warn('[copilot] meta analysis id missing; using local fallback id', {
          analysisId: resolvedAnalysisId,
          requestId: String(resultMetaRecord.requestId || result.traceId || '').trim() || undefined,
        });
      }
      if (typeof window !== 'undefined') {
        try {
          window.localStorage.setItem(COPILOT_ANALYSIS_ID_STORAGE_KEY, resolvedAnalysisId);
          window.localStorage.setItem(COPILOT_ANALYSIS_AT_STORAGE_KEY, String(Date.now()));
        } catch {
          // Ignore local storage failures in restricted browser modes.
        }
      }
      setCopilotSessionAnalysisId(resolvedAnalysisId);
      setCopilotVerifiedAnalysisId(resolvedAnalysisId);
      setAnalysisBundleId(resolvedAnalysisId);
      const summaryText = [
        typeof result.summary === 'string' ? result.summary : '',
        typeof result.combinedBriefing === 'string' ? result.combinedBriefing : '',
        typeof result.strategicAnalysis?.fatigueAnalysis === 'string' ? result.strategicAnalysis.fatigueAnalysis : '',
        typeof result.tactical?.rationale === 'string' ? result.tactical.rationale : '',
        typeof result.combinedDecision?.rationale === 'string' ? result.combinedDecision.rationale : '',
      ].map((value) => value.trim()).find((value) => value.length > 0) || '';
      const tacticalRecommendationText = [
        typeof result.tacticalRecommendation === 'string' ? result.tacticalRecommendation : '',
        typeof result.strategicAnalysis?.tacticalRecommendation?.nextAction === 'string'
          ? result.strategicAnalysis.tacticalRecommendation.nextAction
          : '',
        typeof result.tactical?.immediateAction === 'string' ? result.tactical.immediateAction : '',
        typeof result.combinedDecision?.immediateAction === 'string' ? result.combinedDecision.immediateAction : '',
      ].map((value) => value.trim()).find((value) => value.length > 0) || '';
      const confidence = (() => {
        const candidates = [result.confidence, result.combinedDecision?.confidence, result.tactical?.confidence];
        for (const candidate of candidates) {
          const parsed = Number(candidate);
          if (!Number.isFinite(parsed)) continue;
          const normalized = parsed > 1 && parsed <= 100 ? parsed / 100 : parsed;
          return Math.max(0, Math.min(1, normalized));
        }
        return 0.62;
      })();
      const outputsRecord = toRecord(result.agentOutputs as unknown);
      const resolvedAgentOutputs = {
        ...(hasAnyKeys(outputsRecord) ? outputsRecord : {}),
        ...(!hasAnyKeys(outputsRecord.fatigue) && result.fatigue ? { fatigue: result.fatigue } : {}),
        ...(!hasAnyKeys(outputsRecord.risk) && result.risk ? { risk: result.risk } : {}),
        ...(!hasAnyKeys(outputsRecord.tactical) && result.tactical ? { tactical: result.tactical } : {}),
      };
      setCoachOutput({
        summary: summaryText,
        tacticalRecommendation: tacticalRecommendationText,
        confidence,
        agentOutputs: resolvedAgentOutputs,
      });
      const routingModeToken = String((result as unknown as Record<string, unknown>).routingMode || '').trim().toLowerCase();
      const responseModeToken = routingModeToken || String((result as unknown as Record<string, unknown>).mode || '').trim().toLowerCase();
      const responseMode: 'demo' | 'live' | 'fallback' | undefined =
        responseModeToken === 'demo' || responseModeToken === 'live' || responseModeToken === 'fallback'
          ? responseModeToken
          : responseModeToken === 'ai'
            ? 'live'
          : undefined;
      const normalizedLlmMode: 'ai' | 'rules' =
        String((result as unknown as Record<string, unknown>).llmMode || '').trim().toLowerCase() === 'rules'
          ? 'rules'
          : 'ai';
      const normalizedRoutingMode: 'ai' | 'fallback' | 'demo' =
        routingModeToken === 'fallback' || responseMode === 'fallback'
          ? 'fallback'
          : routingModeToken === 'demo' || responseMode === 'demo'
            ? 'demo'
            : 'ai';
      const routingReasons = Array.isArray(result.reasons)
        ? result.reasons.map((entry) => String(entry || '').trim()).filter(Boolean)
        : [];
      const routingDebugRecord = toRecord(resultMetaRecord.routingDebug);
      const azureAttempted =
        typeof result.azureAttempted === 'boolean'
          ? result.azureAttempted
          : typeof routingDebugRecord.azureAttempted === 'boolean'
            ? Boolean(routingDebugRecord.azureAttempted)
            : normalizedLlmMode === 'ai';
      const agentAiFailures = (() => {
        const explicitFailures = toRecord((result as unknown as Record<string, unknown>).agentAiFailures);
        const fromExplicit: Partial<Record<AgentKey, string>> = {};
        (['fatigue', 'risk', 'tactical'] as const).forEach((agent) => {
          const detail = String(explicitFailures[agent] || '').trim();
          if (detail) fromExplicit[agent] = detail;
        });
        if (Object.keys(fromExplicit).length > 0) return fromExplicit;
        const computed: Partial<Record<AgentKey, string>> = {};
        (['fatigue', 'risk', 'tactical'] as const).forEach((agent) => {
          const resultEntry = result.agentResults?.[agent];
          const routedTo = String(resultEntry?.routedTo || '').trim().toLowerCase();
          const status = String(resultEntry?.status || '').trim().toLowerCase();
          const reason = String(resultEntry?.reason || resultEntry?.error || '').trim();
          if (!reason) return;
          if (routedTo === 'rules' && (status === 'fallback' || status === 'error')) {
            computed[agent] = reason;
          }
        });
        return computed;
      })();
      const fallbackReason = String(
        (result as unknown as Record<string, unknown>).fallbackReason ||
        routingReasons[0] ||
        metaRouterFallbackMessage ||
        ''
      ).trim() || undefined;
      setOrchestrateMeta({
        analysisId: resolvedAnalysisId || undefined,
        mode: metaMode,
        responseMode,
        llmMode: normalizedLlmMode,
        routingMode: normalizedRoutingMode,
        reasons: routingReasons,
        fallbackReason,
        azureAttempted,
        agentAiFailures,
        executedAgents: metaExecutedAgents,
        usedFallbackAgents: metaUsedFallbackAgents,
        routerFallbackMessage: metaRouterFallbackMessage,
        traceId: result.traceId || result.responseHeaders?.traceId,
        source: result.source || result.responseHeaders?.source,
        azureRequestId: result.azureRequestId,
        timingsMs: result.timingsMs,
        agentStatuses: {
          fatigue: result.agents?.fatigue?.status,
          risk: result.agents?.risk?.status,
          tactical: result.agents?.tactical?.status,
        },
        modelRouter,
      });
      setRouterDecision(mode === 'auto' ? (result.routerDecision || null) : null);

      const selectedAgentSet = new Set<AgentKey>();
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
      metaExecutedAgents.forEach((agent) => selectedAgentSet.add(agent));
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
      const hasFallbackPayload = Boolean(
        hasAnyImmediateOutput ||
        result.strategicAnalysis ||
        result.combinedDecision ||
        (typeof result.combinedBriefing === 'string' && result.combinedBriefing.trim().length > 0)
      );
      const fallbackReasonRegex =
        /(fallback|rules|orchestrate_exception|openai_error|agent_http_error|missing[_\s-]?config|missing env|azure env missing|model unavailable|backend_not_ready|temporary issue)/i;
      const deriveFeedStatus = (agent: AgentKey): AgentFeedState => {
        const agentResult = result.agentResults?.[agent];
        const serverStatus = normalizeAgentStatusToken(result.agents?.[agent]?.status);
        const routeStatus = String(agentResult?.status || '').trim().toLowerCase();
        const routeReason = String(agentResult?.reason || agentResult?.error || '').trim().toLowerCase();
        const routerReason = String(result.routerDecision?.reason || metaRouterFallbackMessage || '').trim().toLowerCase();
        const routeChoice = String(agentResult?.routedTo || '').trim().toLowerCase();
        const errored = result.errors.some((entry) => entry.agent === agent);
        const hasFallbackSignal = metaUsedFallbackAgents.includes(agent);
        const fallbackRoutingActive =
          hasFallbackSignal ||
          routeChoice === 'rules' ||
          serverStatus === 'FALLBACK' ||
          routeStatus === 'fallback' ||
          Boolean(metaRouterFallbackMessage) ||
          metaFallbacksUsed.length > 0 ||
          fallbackReasonRegex.test(routeReason) ||
          fallbackReasonRegex.test(routerReason);
        if (routeReason.includes('not_selected_by_auto_router') || routeReason.includes('disabled_by_request')) {
          return 'SKIPPED';
        }
        if (serverStatus === 'FALLBACK' || routeStatus === 'fallback') return 'FALLBACK';
        if (routeChoice === 'rules' && (hasAgentOutput(agent) || hasFallbackPayload)) return 'FALLBACK';
        if (hasAgentOutput(agent) || serverStatus === 'OK' || serverStatus === 'SUCCESS' || routeStatus === 'success') {
          return 'SUCCESS';
        }
        if (!selectedAgentSet.has(agent)) {
          return 'SKIPPED';
        }
        if (errored || serverStatus === 'ERROR' || routeStatus === 'error') {
          if (fallbackRoutingActive && hasFallbackPayload) return 'FALLBACK';
          return 'ERROR';
        }
        if (fallbackRoutingActive && hasFallbackPayload) {
          return 'FALLBACK';
        }
        if (demoMode && hasFallbackPayload) return 'FALLBACK';
        return 'ERROR';
      };
      setAgentFeedStatus({
        fatigue: deriveFeedStatus('fatigue'),
        risk: deriveFeedStatus('risk'),
        tactical: deriveFeedStatus('tactical'),
      });

      const visibleErrors = result.errors.filter((e) => !(e.agent === 'tactical' && tacticalMapped));

      const sanitizeUiNotice = (value: unknown): string => {
        const normalized = String(value || '').replace(/\s+/g, ' ').trim();
        if (!normalized) return '';
        if (/(backend modules are not ready|backend modules unavailable|backend_not_ready|npm --prefix api run build|api\/dist)/i.test(normalized)) {
          return 'Rules fallback (temporary backend build issue)';
        }
        const withoutCommands = normalized.replace(/\b(npm|pnpm|yarn|node|curl)\b[^|]*/gi, 'temporary issue');
        const withoutJson = withoutCommands.replace(/[\{\}\[\]`]/g, '').replace(/https?:\/\/\S+/gi, '').trim();
        return withoutJson.length > 180 ? `${withoutJson.slice(0, 179).trim()}…` : withoutJson;
      };
      const errorNotice = visibleErrors.length > 0
        ? visibleErrors
            .map((e) => `${e.agent}: ${sanitizeUiNotice(e.message)}`)
            .filter((entry) => entry.trim().length > 0)
            .join(' | ')
        : null;
      const responseWarnings = Array.isArray(result.warnings)
        ? result.warnings.map((entry) => sanitizeUiNotice(entry)).filter(Boolean).join(' | ')
        : null;
      const routingReasonsLower = Array.isArray(result.reasons)
        ? result.reasons.map((entry) => String(entry || '').trim().toLowerCase()).filter(Boolean)
        : [];
      const llmFallbackWarning = routingReasonsLower.includes('missing_aoai_config')
        ? 'Azure OpenAI is not configured; showing fallback analysis.'
        : routingReasonsLower.includes('upstream_unavailable')
          ? 'Azure OpenAI is temporarily unavailable; showing fallback analysis.'
          : null;
      const warning = [llmFallbackWarning, responseWarnings, errorNotice, sanitizeUiNotice(options?.extraWarning)]
        .filter(Boolean)
        .join(' | ') || null;
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

    type AgentRouteChoice = 'llm' | 'rules';
    type AgentRouteStatus = 'success' | 'error' | 'fallback';
    interface AgentRouteResult<TOutput> {
      status: AgentRouteStatus;
      routedTo: AgentRouteChoice;
      output?: TOutput;
      error?: string;
    }

    const normalizeRiskToken = (value: unknown): 'LOW' | 'MEDIUM' | 'HIGH' => {
      const token = String(value || '').trim().toUpperCase();
      if (token === 'HIGH' || token === 'CRITICAL') return 'HIGH';
      if (token === 'MED' || token === 'MEDIUM') return 'MEDIUM';
      return 'LOW';
    };
    const toAgentCode = (agent: AgentKey): 'FATIGUE' | 'RISK' | 'TACTICAL' =>
      agent === 'fatigue' ? 'FATIGUE' : agent === 'risk' ? 'RISK' : 'TACTICAL';
    const deriveAutoFallbackSelection = (): { selectedAgents: AgentKey[]; critical: boolean; reason: string } => {
      const fatigueIndex = safeNum(payload.telemetry?.fatigueIndex, 0);
      const strainIndex = safeNum(payload.telemetry?.strainIndex, 0);
      const injuryRisk = normalizeRiskToken(payload.telemetry?.injuryRisk);
      const noBallRisk = normalizeRiskToken(payload.telemetry?.noBallRisk);
      const heartRateRecoveryToken = String(payload.telemetry?.heartRateRecovery || '').trim().toUpperCase();
      const availabilityToken = String(payload.telemetry?.availabilityStatus || payload.analysisState?.availabilityStatus || '').trim().toUpperCase();
      const substitutionRequiredSignal = Boolean(payload.telemetry?.substitutionRequired) || Boolean(payload.analysisState?.substitutionRequired);
      const decisionToken = String(payload.analysisState?.decisionMode || payload.analysisState?.decision || '').trim().toUpperCase();
      const recoveryPoor = heartRateRecoveryToken === 'POOR' || heartRateRecoveryToken === 'VERY POOR';
      const fatigueCritical = fatigueIndex >= 7.5;
      const strainCritical = strainIndex >= 7;
      const availabilityEscalated = availabilityToken === 'LIMITED' || availabilityToken === 'UNAVAILABLE';
      const severeDecisionSignal = /IMMEDIATE_SUBSTITUTION|REMOVE_FROM_ACTIVE|MARK_UNFIT|UNSAFE_TO_CONTINUE/.test(decisionToken);
      const critical =
        injuryRisk === 'HIGH' ||
        noBallRisk === 'HIGH' ||
        fatigueCritical ||
        strainCritical ||
        recoveryPoor ||
        availabilityEscalated ||
        substitutionRequiredSignal ||
        severeDecisionSignal;
      if (critical) {
        return {
          selectedAgents: ['risk', 'tactical'],
          critical: true,
          reason: 'critical_risk_dominant',
        };
      }

      const routineFatigueScore =
        (fatigueIndex >= 5.5 ? 2 : fatigueIndex >= 4 ? 1 : 0) +
        (strainIndex >= 3 ? 1 : 0) +
        (safeNum(payload.telemetry?.oversBowled, 0) >= 2 ? 1 : 0);
      const routineRiskScore =
        (injuryRisk === 'MEDIUM' ? 2 : 0) +
        (noBallRisk === 'MEDIUM' ? 2 : 0) +
        (heartRateRecoveryToken === 'MODERATE' ? 1 : 0);
      const preferRiskSupport =
        routineRiskScore > routineFatigueScore ||
        (routineRiskScore === routineFatigueScore && (injuryRisk === 'MEDIUM' || noBallRisk === 'MEDIUM'));

      return {
        selectedAgents: preferRiskSupport ? ['risk', 'tactical'] : ['fatigue', 'tactical'],
        critical: false,
        reason: preferRiskSupport ? 'routine_risk_dominant' : 'routine_fatigue_dominant',
      };
    };

    const toAgentErrorMessage = (error: unknown): string => {
      if (error instanceof ApiClientError) {
        return String(error.message || `API ${error.status || error.kind}`);
      }
      return error instanceof Error ? error.message : String(error);
    };

    const toErrorReason = (error: unknown): string => {
      if (error instanceof Error && error.message === 'ai_disabled_by_policy') return 'ai_disabled_by_policy';
      if (error instanceof Error && error.message === 'ai_not_configured') return 'missing_config';
      if (error instanceof ApiClientError) {
        if (error.kind === 'timeout' || error.kind === 'network' || error.kind === 'cors') return 'openai_error';
        if (error.kind === 'http' || error.kind === 'parse') return 'agent_http_error';
      }
      return 'openai_error';
    };

    const throwIfAborted = (error: unknown): void => {
      if ((error as Error)?.name === 'AbortError') throw error;
    };

    const logAgentRouteChoice = (agent: AgentKey, routedTo: AgentRouteChoice, reason: string): void => {
      console.log(`[router] ${agent} -> ${routedTo} (reason: ${reason})`);
    };

    const buildRulesFatigueFallback = (): FatigueAgentResponse => {
      const signalRecord = toRecord(payload.signals);
      const previousFatigue = safeNum(payload.telemetry?.fatigueIndex, 0);
      const strainIndex = safeNum(payload.telemetry?.strainIndex, 0);
      const ballsInSpell = Math.max(0, safeNum(payload.telemetry?.consecutiveOvers, 0) * 6);
      const boundariesRelief = safeNum(signalRecord.boundariesRelief, 0);
      const fatigueIndex = clamp(previousFatigue + strainIndex * 0.15 + ballsInSpell * 0.05 - boundariesRelief, 0, 100);
      const severity: FatigueAgentResponse['severity'] = fatigueIndex >= 70 ? 'HIGH' : fatigueIndex >= 40 ? 'MED' : 'LOW';
      return {
        status: 'fallback',
        severity,
        headline: 'Rules-based fatigue fallback',
        explanation: `Estimated fatigue ${fatigueIndex.toFixed(1)} from prior fatigue, strain, and spell workload.`,
        recommendation:
          fatigueIndex >= 70
            ? 'Reduce workload immediately and add recovery interval.'
            : fatigueIndex >= 40
              ? 'Monitor fatigue trend and avoid back-to-back high-intensity effort.'
              : 'Workload is manageable; continue with normal monitoring.',
        signals: [
          `fatigueIndex:${fatigueIndex.toFixed(1)}`,
          `strainIndex:${strainIndex.toFixed(1)}`,
          `ballsInSpell:${ballsInSpell.toFixed(0)}`,
          'rules:fallback',
        ],
        echo: {
          playerId: String(payload.telemetry?.playerId || ''),
          fatigueIndex,
          injuryRisk: normalizeRiskToken(payload.telemetry?.injuryRisk),
          noBallRisk: normalizeRiskToken(payload.telemetry?.noBallRisk),
          oversBowled: safeNum(payload.telemetry?.oversBowled, 0),
          consecutiveOvers: safeNum(payload.telemetry?.consecutiveOvers, 0),
          oversRemaining: safeNum(payload.telemetry?.oversRemaining, 0),
          maxOvers: safeNum(payload.telemetry?.maxOvers, 0),
          heartRateRecovery: String(payload.telemetry?.heartRateRecovery || 'Moderate'),
        },
      };
    };

    const buildRulesRiskFallback = (fatigueIndex: number): RiskAgentResponse => {
      const strainIndex = safeNum(payload.telemetry?.strainIndex, 0);
      const riskScore = clamp(fatigueIndex * 0.6 + strainIndex * 0.4, 0, 100);
      const severity: RiskAgentResponse['severity'] =
        riskScore >= 80 ? 'CRITICAL' : riskScore >= 60 ? 'HIGH' : riskScore >= 35 ? 'MED' : 'LOW';
      return {
        status: 'fallback',
        agent: 'risk',
        severity,
        riskScore,
        headline: 'Rules-based injury risk fallback',
        explanation: `Estimated risk ${riskScore.toFixed(1)} using fatigue (${fatigueIndex.toFixed(1)}) and strain (${strainIndex.toFixed(1)}).`,
        recommendation:
          riskScore >= 80
            ? 'Immediate intervention required; substitute or enforce strict workload cap.'
            : riskScore >= 60
              ? 'Reduce intensity and monitor closely over the next over.'
              : riskScore >= 35
                ? 'Maintain control-focused plan and reassess after one over.'
                : 'Risk remains manageable; continue routine monitoring.',
        signals: [
          `riskScore:${riskScore.toFixed(1)}`,
          `fatigueIndex:${fatigueIndex.toFixed(1)}`,
          `strainIndex:${strainIndex.toFixed(1)}`,
          'rules:fallback',
        ],
        echo: {
          playerId: String(payload.telemetry?.playerId || ''),
          fatigueIndex,
          injuryRisk: riskScore >= 60 ? 'HIGH' : riskScore >= 35 ? 'MEDIUM' : 'LOW',
          noBallRisk: normalizeRiskToken(payload.telemetry?.noBallRisk),
          oversBowled: safeNum(payload.telemetry?.oversBowled, 0),
          consecutiveOvers: safeNum(payload.telemetry?.consecutiveOvers, 0),
          oversRemaining: safeNum(payload.telemetry?.oversRemaining, 0),
          maxOvers: safeNum(payload.telemetry?.maxOvers, 0),
          heartRateRecovery: String(payload.telemetry?.heartRateRecovery || 'Moderate'),
          format: String(payload.matchContext?.format || ''),
          phase: String(payload.matchContext?.phase || ''),
          intensity: String(payload.matchContext?.intensity || ''),
          conditions: String(payload.matchContext?.conditions || ''),
          target: safeNum(payload.matchContext?.target, Number.NaN),
          score: safeNum(payload.matchContext?.score, Number.NaN),
          over: safeNum(payload.matchContext?.over, Number.NaN),
          balls: safeNum(payload.matchContext?.balls, Number.NaN),
        },
      };
    };

    const buildRulesTacticalFallback = (
      fatigue: FatigueAgentResponse,
      risk: RiskAgentResponse,
      fallbackMessage: string
    ): TacticalAgentResponse => {
      const fatigueIndex = safeNum(fatigue.echo?.fatigueIndex, safeNum(payload.telemetry?.fatigueIndex, 0));
      const riskScore = safeNum(risk.riskScore, 0);
      const immediateAction =
        riskScore >= 70 || fatigueIndex >= 70
          ? 'Reduce intensity immediately and rotate at first safe break.'
          : 'Continue with control-first plan and reassess next over.';
      const suggestedAdjustments =
        riskScore >= 70 || fatigueIndex >= 70
          ? [
              'Shorten current spell and prioritize recovery.',
              'Deploy lower-risk tactical field and line plan.',
              'Prepare immediate replacement if trend rises further.',
            ]
          : [
              'Maintain line-length control and monitor trend every over.',
              'Keep replacement option warm in case risk rises.',
              'Re-run analysis after one over.',
            ];
      const why = [
        riskScore >= 70 ? 'Risk score is elevated for current spell.' : 'Risk remains manageable but needs monitoring.',
        fatigueIndex >= 70 ? 'Fatigue trend is high and requires immediate control.' : 'Use one-over control plan and reassess.',
      ];
      return {
        status: 'fallback',
        immediateAction,
        nextAction: immediateAction,
        why,
        rationale: `${fallbackMessage}. Tactical fallback used combined fatigue/risk outputs.`,
        suggestedAdjustments,
        ifIgnored: 'Execution quality may drop and risk can rise in the next over.',
        coachNote: 'Fallback plan is active for one over; rerun coach analysis after reassessment.',
        confidence: riskScore >= 70 ? 0.72 : 0.66,
        keySignalsUsed: Array.from(new Set([...(fatigue.signals || []), ...(risk.signals || []), 'rules:tactical-fallback'])).slice(0, 7),
      };
    };

    const runIndependentAutoFallback = async (fallbackMessage: string): Promise<OrchestrateResponse> => {
      const fallbackSelection = deriveAutoFallbackSelection();
      const selectedAgents = fallbackSelection.selectedAgents;
      const selectedSet = new Set<AgentKey>(selectedAgents);
      const runFatigue = selectedSet.has('fatigue');
      const runRisk = selectedSet.has('risk');
      const runTactical = selectedSet.has('tactical');
      const fatigueRequest = {
        dataMode: payload.dataMode,
        llmMode: payload.llmMode,
        playerId: String(payload.telemetry?.playerId || 'UNKNOWN'),
        playerName: String(payload.telemetry?.playerName || 'Unknown Player'),
        role: String(payload.telemetry?.role || 'Unknown Role'),
        oversBowled: safeNum(payload.telemetry?.oversBowled, 0),
        consecutiveOvers: safeNum(payload.telemetry?.consecutiveOvers, 0),
        oversRemaining: safeNum(payload.telemetry?.oversRemaining, 0),
        maxOvers: safeNum(payload.telemetry?.maxOvers, 0),
        fatigueIndex: safeNum(payload.telemetry?.fatigueIndex, 0),
        injuryRisk: normalizeRiskToken(payload.telemetry?.injuryRisk),
        noBallRisk: normalizeRiskToken(payload.telemetry?.noBallRisk),
        heartRateRecovery: String(payload.telemetry?.heartRateRecovery || 'Moderate'),
        fatigueLimit: safeNum(payload.telemetry?.fatigueLimit, 6),
        sleepHours: safeNum(payload.telemetry?.sleepHours, 7),
        recoveryMinutes: safeNum(payload.telemetry?.recoveryMinutes, 45),
        snapshotId: `coach-auto-fatigue-${Date.now()}`,
        matchContext: {
          format: String(payload.matchContext?.format || 'T20'),
          phase: String(payload.matchContext?.phase || 'middle'),
          over: safeNum(payload.matchContext?.over, 0),
          intensity: String(payload.matchContext?.intensity || 'Medium'),
        },
      };

      const tacticalRequest = {
        dataMode: payload.dataMode,
        llmMode: payload.llmMode,
        requestId: `coach-auto-tactical-${Date.now()}`,
        intent: payload.intent,
        teamMode: payload.teamMode,
        focusRole: payload.focusRole,
        telemetry: payload.telemetry,
        matchContext: payload.matchContext,
        players: payload.players,
        context: payload.context,
      };

      let fatigueResult: AgentRouteResult<FatigueAgentResponse>;
      if (runFatigue) {
        try {
          const fatigueOutput = await postFatigueAgent(fatigueRequest, controller.signal);
          const routedTo: AgentRouteChoice = String(fatigueOutput.status || '').toLowerCase() === 'fallback' ? 'rules' : 'llm';
          fatigueResult = {
            status: routedTo === 'rules' ? 'fallback' : 'success',
            routedTo,
            output: fatigueOutput,
          };
          logAgentRouteChoice('fatigue', routedTo, routedTo === 'rules' ? 'agent_reported_fallback' : 'agent_success');
        } catch (error) {
          throwIfAborted(error);
          fatigueResult = {
            status: 'fallback',
            routedTo: 'rules',
            output: buildRulesFatigueFallback(),
            error: toAgentErrorMessage(error),
          };
          logAgentRouteChoice('fatigue', 'rules', toErrorReason(error));
        }
      } else {
        fatigueResult = {
          status: 'error',
          routedTo: 'rules',
          error: 'not_selected_by_auto_router',
        };
        logAgentRouteChoice('fatigue', 'rules', 'not_selected_by_auto_router');
      }
      const fatigueOutput = fatigueResult.output || buildRulesFatigueFallback();

      const riskRequest = {
        dataMode: payload.dataMode,
        llmMode: payload.llmMode,
        playerId: String(payload.telemetry?.playerId || 'UNKNOWN'),
        fatigueIndex: safeNum(fatigueOutput.echo?.fatigueIndex, safeNum(payload.telemetry?.fatigueIndex, 0)),
        injuryRisk: normalizeRiskToken(payload.telemetry?.injuryRisk),
        noBallRisk: normalizeRiskToken(payload.telemetry?.noBallRisk),
        oversBowled: safeNum(payload.telemetry?.oversBowled, 0),
        consecutiveOvers: safeNum(payload.telemetry?.consecutiveOvers, 0),
        oversRemaining: safeNum(payload.telemetry?.oversRemaining, 0),
        maxOvers: safeNum(payload.telemetry?.maxOvers, 0),
        heartRateRecovery: String(payload.telemetry?.heartRateRecovery || 'Moderate'),
        format: String(payload.matchContext?.format || 'T20'),
        phase: String(payload.matchContext?.phase || 'middle'),
        intensity: String(payload.matchContext?.intensity || 'Medium'),
        conditions: String(payload.matchContext?.conditions || payload.matchContext?.weather || ''),
        target: safeNum(payload.matchContext?.target, Number.NaN),
        score: safeNum(payload.matchContext?.score, Number.NaN),
        over: safeNum(payload.matchContext?.over, Number.NaN),
        balls: safeNum(payload.matchContext?.balls, Number.NaN),
      };

      let riskResult: AgentRouteResult<RiskAgentResponse>;
      if (runRisk) {
        try {
          const riskOutput = await postRiskAgent(riskRequest, controller.signal);
          const routedTo: AgentRouteChoice = String(riskOutput.status || '').toLowerCase() === 'fallback' ? 'rules' : 'llm';
          riskResult = {
            status: routedTo === 'rules' ? 'fallback' : 'success',
            routedTo,
            output: riskOutput,
          };
          logAgentRouteChoice('risk', routedTo, routedTo === 'rules' ? 'agent_reported_fallback' : 'agent_success');
        } catch (error) {
          throwIfAborted(error);
          riskResult = {
            status: 'fallback',
            routedTo: 'rules',
            output: buildRulesRiskFallback(safeNum(fatigueOutput.echo?.fatigueIndex, safeNum(payload.telemetry?.fatigueIndex, 0))),
            error: toAgentErrorMessage(error),
          };
          logAgentRouteChoice('risk', 'rules', toErrorReason(error));
        }
      } else {
        riskResult = {
          status: 'error',
          routedTo: 'rules',
          error: 'not_selected_by_auto_router',
        };
        logAgentRouteChoice('risk', 'rules', 'not_selected_by_auto_router');
      }
      const riskOutput = riskResult.output || buildRulesRiskFallback(safeNum(fatigueOutput.echo?.fatigueIndex, safeNum(payload.telemetry?.fatigueIndex, 0)));

      let tacticalResult: AgentRouteResult<TacticalAgentResponse>;
      if (runTactical) {
        try {
          const tacticalOutput = await postTacticalAgent(tacticalRequest, controller.signal);
          const routedTo: AgentRouteChoice = String(tacticalOutput.status || '').toLowerCase() === 'fallback' ? 'rules' : 'llm';
          tacticalResult = {
            status: routedTo === 'rules' ? 'fallback' : 'success',
            routedTo,
            output: tacticalOutput,
          };
          logAgentRouteChoice('tactical', routedTo, routedTo === 'rules' ? 'agent_reported_fallback' : 'agent_success');
        } catch (error) {
          throwIfAborted(error);
          tacticalResult = {
            status: 'fallback',
            routedTo: 'rules',
            output: buildRulesTacticalFallback(fatigueOutput, riskOutput, fallbackMessage),
            error: toAgentErrorMessage(error),
          };
          logAgentRouteChoice('tactical', 'rules', toErrorReason(error));
        }
      } else {
        tacticalResult = {
          status: 'error',
          routedTo: 'rules',
          error: 'not_selected_by_auto_router',
        };
        logAgentRouteChoice('tactical', 'rules', 'not_selected_by_auto_router');
      }
      const tacticalOutput = tacticalResult.output || buildRulesTacticalFallback(fatigueOutput, riskOutput, fallbackMessage);

      const tacticalAdjustments = Array.isArray(tacticalOutput.suggestedAdjustments)
        ? tacticalOutput.suggestedAdjustments.map((entry) => String(entry)).filter(Boolean)
        : [];
      const signals = Array.from(
        new Set([
          ...(runFatigue ? (fatigueOutput.signals || []).map((entry) => String(entry)) : []),
          ...(runRisk ? (riskOutput.signals || []).map((entry) => String(entry)) : []),
          ...(runTactical ? (tacticalOutput.keySignalsUsed || []).map((entry) => String(entry)) : []),
          'routerFallback:independentAgents',
        ])
      )
        .map((entry) => entry.trim())
        .filter(Boolean)
        .slice(0, 7);

      const combinedDecision: TacticalCombinedDecision = {
        immediateAction: String(tacticalOutput.immediateAction || 'Continue with monitored plan'),
        ...(tacticalOutput.substitutionAdvice
          ? { substitutionAdvice: tacticalOutput.substitutionAdvice }
          : {}),
        suggestedAdjustments: tacticalAdjustments.slice(0, 4),
        confidence: Number.isFinite(Number(tacticalOutput.confidence)) ? Number(tacticalOutput.confidence) : 0.62,
        rationale: String(tacticalOutput.rationale || fallbackMessage),
      };

      const fallbackAgents = ([
        { key: 'fatigue' as const, value: fatigueResult },
        { key: 'risk' as const, value: riskResult },
        { key: 'tactical' as const, value: tacticalResult },
      ])
        .filter((entry) => selectedSet.has(entry.key) && entry.value.routedTo === 'rules')
        .map((entry) => entry.key);

      const fallbackRequestId = `coach-auto-fallback-${Date.now()}`;
      return {
        ok: true,
        analysisId: fallbackRequestId,
        ...(runFatigue ? { fatigue: fatigueOutput } : {}),
        ...(runRisk ? { risk: riskOutput } : {}),
        ...(runTactical ? { tactical: tacticalOutput } : {}),
        strategicAnalysis: {
          signals,
          fatigueAnalysis: runFatigue
            ? String(fatigueOutput.recommendation || fatigueOutput.explanation || 'Fatigue signal reviewed.')
            : 'Fatigue analysis not selected in auto route.',
          injuryRiskAnalysis: runRisk
            ? String(riskOutput.recommendation || riskOutput.explanation || 'Risk signal reviewed.')
            : 'Risk analysis not selected in auto route.',
          tacticalRecommendation: {
            nextAction: String(tacticalOutput.immediateAction || 'Continue with monitored plan'),
            why: String(tacticalOutput.rationale || fallbackMessage),
            ifIgnored: tacticalAdjustments[0] || 'Execution risk may increase if current plan is left unchanged.',
            alternatives: tacticalAdjustments.slice(0, 3),
          },
          coachNote: 'Agent routing executed independently; rules fallback applied only where required.',
        },
        finalDecision: combinedDecision,
        combinedDecision,
        errors: [],
        agents: {
          fatigue: { status: runFatigue ? (fatigueResult.status === 'fallback' ? 'FALLBACK' : 'OK') : 'SKIPPED' },
          risk: { status: runRisk ? (riskResult.status === 'fallback' ? 'FALLBACK' : 'OK') : 'SKIPPED' },
          tactical: { status: runTactical ? (tacticalResult.status === 'fallback' ? 'FALLBACK' : 'OK') : 'SKIPPED' },
        },
        agentResults: {
          fatigue: runFatigue ? fatigueResult : { status: 'error', routedTo: 'rules', reason: 'not_selected_by_auto_router' },
          risk: runRisk ? riskResult : { status: 'error', routedTo: 'rules', reason: 'not_selected_by_auto_router' },
          tactical: runTactical ? tacticalResult : { status: 'error', routedTo: 'rules', reason: 'not_selected_by_auto_router' },
        },
        outputs: {
          fatigue: runFatigue
            ? { ok: true, data: fatigueOutput, text: String(fatigueOutput.recommendation || fatigueOutput.headline || '') }
            : { ok: false, data: {}, text: 'Not selected by auto router' },
          risk: runRisk
            ? { ok: true, data: riskOutput, text: String(riskOutput.recommendation || riskOutput.headline || '') }
            : { ok: false, data: {}, text: 'Not selected by auto router' },
          tactical: {
            ok: true,
            data: tacticalOutput,
            recommendation: {
              nextAction: String(tacticalOutput.immediateAction || ''),
              why: String(tacticalOutput.rationale || ''),
              ifIgnored: tacticalAdjustments[0] || '',
              alternatives: tacticalAdjustments.slice(0, 3),
            },
          },
        },
        routerDecision: {
          intent: 'General',
          agentsToRun: selectedAgents.map((agent) => toAgentCode(agent)),
          selectedAgents,
          routingMeta: deriveRoutingMetaFromSelectedAgents(selectedAgents, 'auto'),
          signalSummaryBullets: signals,
          rationale: fallbackMessage,
          rulesFired: ['routerFallback:independentAgents', fallbackSelection.reason],
          inputsUsed: {
            activePlayerId: String(payload.telemetry?.playerId || ''),
            active: {
              fatigueIndex: safeNum(fatigueOutput.echo?.fatigueIndex, safeNum(payload.telemetry?.fatigueIndex, 0)),
              strainIndex: safeNum(payload.telemetry?.strainIndex, 0),
              injuryRisk: String(riskOutput.echo?.injuryRisk || payload.telemetry?.injuryRisk || ''),
              noBallRisk: String(riskOutput.echo?.noBallRisk || payload.telemetry?.noBallRisk || ''),
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
            fatigueIndex: safeNum(fatigueOutput.echo?.fatigueIndex, safeNum(payload.telemetry?.fatigueIndex, 0)),
            strainIndex: safeNum(payload.telemetry?.strainIndex, 0),
            noBallRisk: String(riskOutput.echo?.noBallRisk || payload.telemetry?.noBallRisk || ''),
            injuryRisk: String(riskOutput.echo?.injuryRisk || payload.telemetry?.injuryRisk || ''),
          },
        },
        meta: {
          requestId: fallbackRequestId,
          mode: 'auto',
          executedAgents: selectedAgents,
          modelRouting: {
            fatigueModel: runFatigue ? (fatigueResult.routedTo === 'llm' ? 'llm' : 'rules-based-fallback') : 'skipped',
            riskModel: runRisk ? (riskResult.routedTo === 'llm' ? 'llm' : 'rules-based-fallback') : 'skipped',
            tacticalModel: runTactical ? (tacticalResult.routedTo === 'llm' ? 'llm' : 'rules-based-fallback') : 'skipped',
            fallbacksUsed: [
              'router-unavailable',
              ...(fallbackSelection.critical ? ['critical_signals'] : ['auto_cap=max2']),
              ...fallbackAgents.map((agent) => `${agent}:rules`),
            ],
          },
          usedFallbackAgents: fallbackAgents,
          routerFallbackMessage: fallbackMessage,
          timingsMs: { total: 0 },
        },
      };
    };

    try {
      startRequest();
      try {
        await checkHealth(controller.signal);
      } catch (healthError) {
        if (import.meta.env.DEV) {
          console.warn('COACH_ANALYSIS_HEALTH_CHECK_FAILED', healthError);
        }
      }

      if (!aiEnabled) {
        throw new Error('ai_not_configured');
      }

      if (mode === 'full') {
        const fullResult = await postOrchestrate({ ...payload, mode: 'full' }, controller.signal);
        if (requestId !== fatigueRequestSeq.current) return null;
        return applyCoachResult(fullResult);
      }

      const autoFallbackMessage = 'Routing: rules-based (safe fallback)';
      let autoResult: OrchestrateResponse | null = null;

      try {
        autoResult = await postOrchestrate({ ...payload, mode: 'auto' }, controller.signal);
      } catch (primaryAutoError) {
        logCoachAnalysisFailure('COACH_ANALYSIS_ROUTER_FAILED', primaryAutoError, orchestrateRequestUrl);

        if (!autoResult) {
          try {
            autoResult = await runIndependentAutoFallback(autoFallbackMessage);
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
          autoResult = await runIndependentAutoFallback(autoFallbackMessage);
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
      const fallbackCode = error instanceof Error ? error.message : '';
      const fallbackMessage =
        fallbackCode === 'ai_disabled_by_policy'
          ? 'Routing: rules-based (demo fallback)'
          : fallbackCode === 'ai_not_configured'
            ? 'Routing: rules-based (Azure OpenAI not configured)'
            : 'Routing: rules-based (safe fallback)';
      const fallbackFatigue = buildRulesFatigueFallback();
      const fallbackRisk = buildRulesRiskFallback(
        safeNum(fallbackFatigue.echo?.fatigueIndex, safeNum(payload.telemetry?.fatigueIndex, 0))
      );
      const fallbackTactical = buildRulesTacticalFallback(fallbackFatigue, fallbackRisk, fallbackMessage);
      const fallbackSelection = mode === 'full'
        ? { selectedAgents: (['fatigue', 'risk', 'tactical'] as AgentKey[]), critical: true, reason: 'full_mode_all_agents' }
        : deriveAutoFallbackSelection();
      const fallbackSelectedAgents = fallbackSelection.selectedAgents;
      const fallbackSelectedSet = new Set<AgentKey>(fallbackSelectedAgents);
      const includeFatigue = fallbackSelectedSet.has('fatigue');
      const includeRisk = fallbackSelectedSet.has('risk');
      const fallbackAnalysisId = `local-fallback-${Date.now()}`;
      const fallbackSignals = Array.from(
        new Set([
          ...(fallbackFatigue.signals || []),
          ...(fallbackRisk.signals || []),
          ...(fallbackTactical.keySignalsUsed || []),
          `fallback_reason:${toErrorReason(error)}`,
        ])
      ).slice(0, 8);
      const fallbackCombinedDecision: TacticalCombinedDecision = {
        immediateAction: String(fallbackTactical.immediateAction || 'Continue with monitored plan'),
        suggestedAdjustments: Array.isArray(fallbackTactical.suggestedAdjustments)
          ? fallbackTactical.suggestedAdjustments.map((entry) => String(entry)).filter(Boolean).slice(0, 4)
          : [],
        confidence: Number.isFinite(Number(fallbackTactical.confidence)) ? Number(fallbackTactical.confidence) : 0.62,
        rationale: String(fallbackTactical.rationale || fallbackMessage),
      };
      const fallbackStrategicAnalysis: NonNullable<OrchestrateResponse['strategicAnalysis']> = {
        signals: fallbackSignals,
        fatigueAnalysis: includeFatigue
          ? String(
              fallbackFatigue.recommendation || fallbackFatigue.explanation || 'Fatigue signal reviewed via rules fallback.'
            )
          : 'Fatigue agent not selected in this auto route.',
        injuryRiskAnalysis: includeRisk
          ? String(
              fallbackRisk.recommendation || fallbackRisk.explanation || 'Risk signal reviewed via rules fallback.'
            )
          : 'Risk agent not selected in this auto route.',
        tacticalRecommendation: {
          nextAction: String(fallbackTactical.nextAction || fallbackTactical.immediateAction || 'Continue with monitored plan'),
          why: String(fallbackTactical.rationale || fallbackMessage),
          ifIgnored: String(fallbackTactical.ifIgnored || 'Execution risk may increase if no adjustment is made.'),
          alternatives: Array.isArray(fallbackTactical.suggestedAdjustments)
            ? fallbackTactical.suggestedAdjustments.map((entry) => String(entry)).filter(Boolean).slice(0, 3)
            : [],
        },
        coachNote: 'Rules fallback active: model response unavailable.',
      };
      const fallbackResponse: OrchestrateResponse = {
        ok: true,
        analysisId: fallbackAnalysisId,
        ...(includeFatigue ? { fatigue: fallbackFatigue } : {}),
        ...(includeRisk ? { risk: fallbackRisk } : {}),
        tactical: fallbackTactical,
        strategicAnalysis: fallbackStrategicAnalysis,
        combinedBriefing:
          `${fallbackCombinedDecision.immediateAction} ${fallbackCombinedDecision.rationale}`.trim(),
        finalDecision: fallbackCombinedDecision,
        combinedDecision: fallbackCombinedDecision,
        errors: [],
        agents: {
          fatigue: { status: includeFatigue ? 'FALLBACK' : 'SKIPPED' },
          risk: { status: includeRisk ? 'FALLBACK' : 'SKIPPED' },
          tactical: { status: 'FALLBACK' },
        },
        agentResults: {
          fatigue: includeFatigue
            ? { status: 'fallback', routedTo: 'rules', output: fallbackFatigue, reason: 'rules_fallback' }
            : { status: 'error', routedTo: 'rules', reason: 'not_selected_by_auto_router' },
          risk: includeRisk
            ? { status: 'fallback', routedTo: 'rules', output: fallbackRisk, reason: 'rules_fallback' }
            : { status: 'error', routedTo: 'rules', reason: 'not_selected_by_auto_router' },
          tactical: { status: 'fallback', routedTo: 'rules', output: fallbackTactical, reason: 'rules_fallback' },
        },
        routerDecision: {
          mode: requestMode,
          intent: 'General',
          reason: fallbackMessage,
          rationale: fallbackMessage,
          selectedAgents: fallbackSelectedAgents,
          routingMeta: deriveRoutingMetaFromSelectedAgents(fallbackSelectedAgents, requestMode),
          agentsToRun: fallbackSelectedAgents.map((agent) => toAgentCode(agent)),
          rulesFired: ['rules_fallback', `error:${toErrorReason(error)}`],
          signalSummaryBullets: fallbackSignals,
          inputsUsed: {
            activePlayerId: String(payload.telemetry?.playerId || ''),
            active: {
              fatigueIndex: safeNum(fallbackFatigue.echo?.fatigueIndex, safeNum(payload.telemetry?.fatigueIndex, 0)),
              strainIndex: safeNum(payload.telemetry?.strainIndex, 0),
              injuryRisk: String(fallbackRisk.echo?.injuryRisk || payload.telemetry?.injuryRisk || ''),
              noBallRisk: String(fallbackRisk.echo?.noBallRisk || payload.telemetry?.noBallRisk || ''),
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
          agents: {
            fatigue: { routedTo: 'rules', reason: includeFatigue ? 'rules_fallback' : 'not_selected_by_auto_router' },
            risk: { routedTo: 'rules', reason: includeRisk ? 'rules_fallback' : 'not_selected_by_auto_router' },
            tactical: { routedTo: 'rules', reason: 'rules_fallback' },
          },
          signals: {
            fatigueIndex: safeNum(fallbackFatigue.echo?.fatigueIndex, safeNum(payload.telemetry?.fatigueIndex, 0)),
            strainIndex: safeNum(payload.telemetry?.strainIndex, 0),
            noBallRisk: String(fallbackRisk.echo?.noBallRisk || payload.telemetry?.noBallRisk || ''),
            injuryRisk: String(fallbackRisk.echo?.injuryRisk || payload.telemetry?.injuryRisk || ''),
          },
        },
        meta: {
          requestId: fallbackAnalysisId,
          analysisId: fallbackAnalysisId,
          mode: requestMode,
          executedAgents: fallbackSelectedAgents,
          modelRouting: {
            fatigueModel: includeFatigue ? 'rules-based-fallback' : 'skipped',
            riskModel: includeRisk ? 'rules-based-fallback' : 'skipped',
            tacticalModel: 'rules-based-fallback',
            fallbacksUsed: ['rules_fallback', toErrorReason(error)],
          },
          usedFallbackAgents: fallbackSelectedAgents,
          routerFallbackMessage: fallbackMessage,
          timingsMs: { total: 0 },
        },
      };
      return applyCoachResult(fallbackResponse, {
        extraWarning:
          fallbackCode === 'ai_disabled_by_policy'
            ? 'Demo route fallback is active. Rules-based output ready.'
            : fallbackCode === 'ai_not_configured'
              ? 'Azure OpenAI is not configured. Rules-based output ready.'
              : 'Model unavailable — using rules-based fallback output.',
      });
    } finally {
      if (requestInFlight && requestId === fatigueRequestSeq.current) {
        setAgentState((prev) => (prev === 'thinking' ? 'idle' : prev));
      }
    }
  };

  useEffect(() => {
    if (page !== 'dashboard') return;
    fatigueAbortRef.current?.abort();
    if (!analysisRequested && !analysisActive) {
      setAiAnalysis(null);
      setRiskAnalysis(null);
      setTacticalAnalysis(null);
      setStrategicAnalysis(null);
      setCombinedAnalysis(null);
      setCombinedBriefing(null);
      setCombinedDecision(null);
      setFinalRecommendation(null);
      setOrchestrateMeta(null);
      setRouterDecision(null);
      setAnalysisBundleId('');
      setCoachOutput(null);
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
  }, [analysisActive, activePlayerId, page]);

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
    setCombinedBriefing(null);
    setCombinedDecision(null);
    setFinalRecommendation(null);
    setOrchestrateMeta(null);
    setRouterDecision(null);
    setAnalysisBundleId('');
    setCoachOutput(null);
    setRunMode('auto');
    setAgentFeedStatus(getDefaultAgentFeedStatus());
  };

  const navigateTo = (p: Page, source = 'ui:navigate') => {
    if (typeof window !== 'undefined') {
      console.log('[nav]', {
        source,
        route: String(window.location.pathname || ''),
        demoMode,
        sessionMode,
        demoStep,
        from: page,
        to: p,
      });
    }
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
    const resolvedRosterIds = isDemoSession
      ? resolveDemoRosterIdsWithRepair([...baseRosterIds, ...additions], orderedBaselines)
      : resolveRosterIdsFromBaselines([...baseRosterIds, ...additions], orderedBaselines);
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
    if (options?.persist !== false) {
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
          {isAppUnlocked && (
            <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-transparent via-emerald-500/50 to-transparent opacity-50"></div>
          )}
        </div>
      )}

      {/* Navigation Bar */}
      <nav className="border-b border-white/10 bg-[#060B16]/90 backdrop-blur-md sticky top-0 z-50 shrink-0">
        <div className="w-full px-3 sm:px-4">
          <div className="flex items-center justify-between h-20">
            <div className="flex items-center gap-3 cursor-pointer group" onClick={() => navigateTo('landing', 'nav:logo')}>
              <div className="w-10 h-10 border border-emerald-500 rounded-xl flex items-center justify-center transform group-hover:rotate-6 transition-transform">
                <Shield className="text-emerald-500 w-5 h-5 fill-emerald-500/20" />
              </div>
              <span className="text-xl font-bold tracking-tight text-white">tactIQ</span>
            </div>
            
            <div className="flex items-center gap-6 relative">
              {isAppUnlocked && page !== 'landing' && (
                <>
                  <button type="button" 
                    onClick={() => navigateTo('dashboard', 'nav:dashboard')}
                    className={`text-sm font-medium transition-colors px-3 py-1.5 rounded-md ${page === 'dashboard' ? 'bg-emerald-500/10 text-emerald-400' : 'text-slate-400 hover:text-white'}`}
                  >
                    Dashboard
                  </button>
                  <button type="button" 
                    onClick={() => navigateTo('baselines', 'nav:baselines')}
                    className={`text-sm font-medium transition-colors px-3 py-1.5 rounded-md ${page === 'baselines' ? 'bg-emerald-500/10 text-emerald-400' : 'text-slate-400 hover:text-white'}`}
                  >
                    Player Baselines
                  </button>
                </>
              )}
              
              {/* Profile Dropdown */}
              <div
                ref={profileMenuRef}
                style={{
                  position: 'relative',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                }}
              >
                <button
                  type="button"
                  onClick={() => setIsProfileOpen(!isProfileOpen)}
                  onMouseEnter={() => setIsProfileTriggerHovered(true)}
                  onMouseLeave={() => setIsProfileTriggerHovered(false)}
                  onFocus={() => setIsProfileTriggerHovered(true)}
                  onBlur={() => setIsProfileTriggerHovered(false)}
                  aria-label="Open profile menu"
                  aria-haspopup="menu"
                  aria-expanded={isProfileOpen}
                  style={{
                    width: '40px',
                    height: '40px',
                    borderRadius: '999px',
                    border: isProfileOpen || isProfileTriggerHovered
                      ? '1px solid rgba(45, 212, 191, 0.5)'
                      : '1px solid rgba(100, 116, 139, 0.72)',
                    background: isProfileOpen || isProfileTriggerHovered
                      ? 'linear-gradient(180deg, rgba(22, 45, 73, 0.97) 0%, rgba(15, 34, 57, 0.97) 100%)'
                      : 'linear-gradient(180deg, rgba(17, 28, 48, 0.97) 0%, rgba(12, 21, 37, 0.97) 100%)',
                    color: isProfileOpen || isProfileTriggerHovered ? '#d7fff4' : '#c6d3e8',
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    cursor: 'pointer',
                    boxShadow: isProfileOpen || isProfileTriggerHovered
                      ? '0 10px 24px rgba(5, 18, 37, 0.5), 0 0 0 1px rgba(45, 212, 191, 0.16)'
                      : '0 6px 18px rgba(2, 6, 23, 0.35)',
                    transition: 'all 180ms ease',
                  }}
                >
                  <User size={24} strokeWidth={2} />
                </button>

                <AnimatePresence>
                  {isProfileOpen && (
                    <motion.div
                      initial={{ opacity: 0, y: 10, scale: 0.96 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      exit={{ opacity: 0, y: 10, scale: 0.96 }}
                      style={{
                        position: 'absolute',
                        top: 'calc(100% + 10px)',
                        right: 0,
                        width: '260px',
                        maxWidth: 'calc(100vw - 16px)',
                        padding: '17px',
                        borderRadius: '14px',
                        border: '1px solid rgba(125, 147, 178, 0.25)',
                        background:
                          'linear-gradient(180deg, rgba(15, 27, 46, 0.985) 0%, rgba(11, 22, 39, 0.985) 100%)',
                        boxShadow:
                          '0 16px 34px rgba(2, 8, 23, 0.52), 0 0 0 1px rgba(15, 23, 42, 0.42), inset 0 1px 0 rgba(255,255,255,0.03)',
                        backdropFilter: 'blur(10px)',
                        zIndex: 220,
                        overflow: 'hidden',
                      }}
                    >
                      <div
                        style={{
                          display: 'flex',
                          flexDirection: 'column',
                          gap: '6px',
                          minWidth: 0,
                        }}
                      >
                        <p
                          style={{
                            margin: 0,
                            color: '#f8fafc',
                            fontSize: '16px',
                            fontWeight: 650,
                            lineHeight: 1.2,
                            whiteSpace: 'normal',
                            wordBreak: 'normal',
                            overflowWrap: 'normal',
                            hyphens: 'none',
                          }}
                        >
                          tactIQ Coach Assist
                        </p>
                        <p
                          style={{
                            margin: 0,
                            color: 'rgba(226, 232, 240, 0.88)',
                            fontSize: '12.5px',
                            lineHeight: 1.45,
                            whiteSpace: 'normal',
                            wordBreak: 'normal',
                            overflowWrap: 'normal',
                            hyphens: 'none',
                          }}
                        >
                          Multi-agent tactical AI for match-state, fatigue, and risk-aware coaching.
                        </p>
                      </div>

                      <div style={{ marginTop: '10px', marginBottom: '12px' }}>
                        <div
                          style={{
                            fontSize: '11px',
                            color: 'rgba(255,255,255,0.55)',
                            letterSpacing: '0.5px',
                          }}
                        >
                          Signed in as
                        </div>

                        <div
                          style={{
                            fontSize: '13px',
                            color: '#ffffff',
                            fontWeight: '500',
                            marginTop: '2px',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                            maxWidth: '220px',
                          }}
                        >
                          {signedInEmail}
                        </div>
                      </div>

                      <div
                        style={{
                          marginTop: '12px',
                          marginBottom: '10px',
                          height: '1px',
                          background: 'rgba(148, 163, 184, 0.18)',
                        }}
                      />

                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          gap: '10px',
                        }}
                      >
                        <span
                          style={{
                            color: 'rgba(148, 163, 184, 0.9)',
                            fontSize: '11px',
                            letterSpacing: '0.08em',
                            textTransform: 'uppercase',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          MODE
                        </span>
                        <span
                          style={{
                            color:
                              sessionMode === 'demo'
                                ? '#d6fff3'
                                : sessionMode === 'authenticated'
                                  ? '#cff8ee'
                                  : '#e2e8f0',
                            background:
                              sessionMode === 'demo'
                                ? 'rgba(45, 212, 191, 0.14)'
                                : sessionMode === 'authenticated'
                                  ? 'rgba(20, 184, 166, 0.14)'
                                  : 'rgba(100, 116, 139, 0.18)',
                            border:
                              sessionMode === 'demo'
                                ? '1px solid rgba(45, 212, 191, 0.34)'
                                : sessionMode === 'authenticated'
                                  ? '1px solid rgba(20, 184, 166, 0.34)'
                                  : '1px solid rgba(148, 163, 184, 0.28)',
                            borderRadius: '999px',
                            padding: '4px 10px',
                            fontSize: '10px',
                            fontWeight: 600,
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {sessionMode === 'demo' ? 'Demo Mode' : sessionMode === 'authenticated' ? 'Signed in' : 'Guest'}
                        </span>
                      </div>

                      <div
                        style={{
                          marginTop: '10px',
                          marginBottom: '10px',
                          height: '1px',
                          background: 'rgba(148, 163, 184, 0.18)',
                        }}
                      />

                      {isAppUnlocked && (
                        <button
                          type="button"
                          onClick={handleProfilePrimaryAction}
                          onMouseEnter={() => setIsProfileActionHovered(true)}
                          onMouseLeave={() => setIsProfileActionHovered(false)}
                          onFocus={() => setIsProfileActionHovered(true)}
                          onBlur={() => setIsProfileActionHovered(false)}
                          style={{
                            width: '100%',
                            minHeight: '40px',
                            marginTop: '2px',
                            padding: '10px 12px',
                            borderRadius: '12px',
                            border:
                              sessionMode === 'demo'
                                ? '1px solid rgba(45, 212, 191, 0.42)'
                                : '1px solid rgba(56, 189, 248, 0.4)',
                            background:
                              sessionMode === 'demo'
                                ? isProfileActionHovered
                                  ? 'linear-gradient(180deg, rgba(20, 116, 106, 0.52) 0%, rgba(13, 53, 67, 0.7) 100%)'
                                  : 'linear-gradient(180deg, rgba(18, 72, 89, 0.5) 0%, rgba(13, 49, 64, 0.65) 100%)'
                                : isProfileActionHovered
                                  ? 'linear-gradient(180deg, rgba(14, 77, 112, 0.52) 0%, rgba(10, 54, 84, 0.72) 100%)'
                                  : 'linear-gradient(180deg, rgba(13, 59, 92, 0.48) 0%, rgba(10, 47, 74, 0.68) 100%)',
                            color: sessionMode === 'demo' ? '#ddfff6' : '#e2f3ff',
                            fontSize: '13px',
                            fontWeight: 650,
                            display: 'inline-flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            gap: '8px',
                            cursor: 'pointer',
                            boxShadow:
                              sessionMode === 'demo'
                                ? isProfileActionHovered
                                  ? '0 12px 24px rgba(8, 42, 50, 0.35), 0 0 0 1px rgba(45, 212, 191, 0.18)'
                                  : '0 10px 22px rgba(8, 34, 44, 0.28)'
                                : isProfileActionHovered
                                  ? '0 12px 24px rgba(7, 37, 61, 0.35), 0 0 0 1px rgba(56, 189, 248, 0.18)'
                                  : '0 10px 22px rgba(6, 29, 49, 0.28)',
                            transition: 'all 180ms ease',
                          }}
                        >
                          <LogOut size={14} />
                          {sessionMode === 'demo' ? 'Exit Demo' : 'Sign Out'}
                        </button>
                      )}
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
        {!showSplash && !isAppUnlocked ? (
          authResolving ? (
            <AuthResolvingSplash />
          ) : (
            <AuthPage
              isChecking={authStatus === 'checking'}
              onContinueWithMicrosoft={handleContinueWithMicrosoft}
              onTryDemo={handleTryDemoMode}
              isLocalDev={isLocalAuthHost}
              localHint={authLocalHint}
              onCopySwaCommand={handleCopySwaCommand}
              copiedSwaCommand={copiedSwaCommand}
            />
          )
        ) : (
          <AnimatePresence mode="wait">
            {page === 'landing' && (
              <LandingPage key="landing" onStart={() => navigateTo('setup', 'landing:start_match')} />
            )}
            {page === 'setup' && (
              <MatchSetup 
                key="setup" 
                context={matchContext} 
                setContext={setMatchContext} 
                inningsOvers={matchState.totalOvers}
                setInningsOvers={(overs) => updateMatchState({ totalOvers: Math.max(1, Math.floor(safeNum(overs, 1))) })}
                onNext={() => navigateTo('dashboard', 'setup:load_team_dashboard')} 
                onBack={() => navigateTo('landing', 'setup:back_to_landing')}
              />
            )}
            {page === 'dashboard' && (
              <Dashboard 
                key="dashboard"
                aiEnabled={aiEnabled}
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
                setAgentWarning={setAgentWarning}
                setAgentFailure={setAgentFailure}
                aiAnalysis={aiAnalysis}
                riskAnalysis={riskAnalysis}
                tacticalAnalysis={tacticalAnalysis}
                strategicAnalysis={strategicAnalysis}
                combinedAnalysis={combinedAnalysis}
                combinedBriefing={combinedBriefing}
                combinedDecision={combinedDecision}
                finalRecommendation={finalRecommendation}
                orchestrateMeta={orchestrateMeta}
                routerDecision={routerDecision}
                agentFeedStatus={agentFeedStatus}
                analysisBundleId={analysisBundleId}
                coachOutput={coachOutput}
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
                onGoToBaselines={() => navigateTo('baselines', 'dashboard:open_baselines')}
                onBack={() => navigateTo('setup', 'dashboard:back_to_setup')}
              />
            )}
            {page === 'baselines' && (
              <Baselines 
                key="baselines"
                baselineSource={baselineSource}
                baselineWarning={baselineWarning}
                demoMode={isDemoSession}
                onBaselinesSynced={handleBaselinesSynced}
                matchRosterIds={matchRosterIds}
                onMatchRosterIdsChange={applyMatchRosterIds}
                onBack={() => navigateTo('dashboard', 'baselines:back_to_dashboard')}
              />
            )}
          </AnimatePresence>
        )}
      </main>
      
      {isAppUnlocked && page !== 'landing' && (
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

function MatchSetup({ context, setContext, inningsOvers, setInningsOvers, onNext, onBack }: { 
  context: MatchContext, 
  setContext: (c: MatchContext) => void, 
  inningsOvers: number;
  setInningsOvers: (overs: number) => void;
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

          {String(context.format || '').trim().toUpperCase() === 'TEST' && (
            <div>
              <label className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-3 block">Test Overs Limit</label>
              <input
                type="number"
                min={1}
                step="1"
                value={Math.max(1, Math.floor(safeNum(inningsOvers, 1)))}
                onChange={(e) => {
                  const next = Math.max(1, Math.floor(Number(e.target.value) || 1));
                  setInningsOvers(next);
                }}
                className="w-full bg-slate-800 border border-slate-700 text-white rounded-lg px-4 py-3 focus:border-indigo-500 focus:outline-none"
                aria-label="Test overs limit"
              />
            </div>
          )}

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
  injuryRiskPct: number;
  reason: string;
}

interface PressureForecastPoint {
  overAhead: number;
  pressure: number;
}

const FORECAST_OVERS = [0, 1, 2, 3, 4, 5];
const FORECAST_Y_TICKS = [0, 2.5, 5, 7.5, 10];
const FORECAST_RISK_TICKS = [0, 20, 40, 60, 80, 100];
const LOW_RISK_THRESHOLD_PCT = 35;
const HIGH_RISK_THRESHOLD_PCT = 65;
const RISK_ACCELERATION_THRESHOLD = 12;

const fatigueIntensityMultiplier = (intensity?: string): number => {
  const normalized = String(intensity || '').trim().toUpperCase();
  if (normalized === 'COOL' || normalized === 'LOW') return 0.85;
  if (normalized === 'MEDIUM') return 1.0;
  if (normalized === 'POWERPLAY' || normalized === 'HIGH') return 1.15;
  return 1.0;
};

const normalizeRiskToken = (value: unknown): 'LOW' | 'MEDIUM' | 'HIGH' => {
  const token = String(value || '').trim().toUpperCase();
  if (token === 'HIGH' || token === 'CRITICAL') return 'HIGH';
  if (token === 'MED' || token === 'MEDIUM') return 'MEDIUM';
  return 'LOW';
};

const toRecoveryNormalized = (heartRateRecovery?: Player['hrRecovery'] | 'OK' | 'Ok'): number => {
  const normalized = String(heartRateRecovery || '').trim().toUpperCase();
  if (normalized === 'GOOD') return 0.95;
  if (normalized === 'OK' || normalized === 'MODERATE') return 0.62;
  if (normalized === 'POOR') return 0.28;
  return 0.62;
};

const riskTierFromPct = (riskPct: number): 'Low' | 'Medium' | 'High' => {
  if (riskPct >= HIGH_RISK_THRESHOLD_PCT) return 'High';
  if (riskPct >= LOW_RISK_THRESHOLD_PCT) return 'Medium';
  return 'Low';
};

const riskContextWeight = (
  risk: unknown,
  weights: { low: number; medium: number; high: number }
): number => {
  const token = normalizeRiskToken(risk);
  if (token === 'HIGH') return weights.high;
  if (token === 'MEDIUM') return weights.medium;
  return weights.low;
};

const computeOverloadIndex = ({
  currentFatigue,
  strainIndex,
  oversBowled,
  recoveryNormalized,
}: {
  currentFatigue: number;
  strainIndex: number;
  oversBowled: number;
  recoveryNormalized: number;
}): number => {
  const fatigueLoad = clamp(currentFatigue, 0, 10) / 10;
  const strainLoad = clamp(strainIndex, 0, 10) / 10;
  const spellLoad = clamp(oversBowled, 0, 6) / 6;
  return clamp(
    fatigueLoad * 0.35 +
      strainLoad * 0.30 +
      spellLoad * 0.20 +
      (1 - clamp(recoveryNormalized, 0, 1)) * 0.15,
    0,
    1.2
  );
};

const isSevereRiskEdge = ({
  fatigue,
  strainIndex,
  oversBowled,
  recoveryNormalized,
  injuryRisk,
  noBallRisk,
}: {
  fatigue: number;
  strainIndex: number;
  oversBowled: number;
  recoveryNormalized: number;
  injuryRisk?: string;
  noBallRisk?: string;
}): boolean => {
  const injuryToken = normalizeRiskToken(injuryRisk);
  const noBallToken = normalizeRiskToken(noBallRisk);
  return (
    fatigue >= 9.6 &&
    strainIndex >= 8 &&
    oversBowled >= 4 &&
    recoveryNormalized <= 0.35 &&
    (injuryToken === 'HIGH' || noBallToken === 'HIGH')
  );
};

const baselineInjuryRiskPct = ({
  injuryRisk,
  noBallRisk,
  currentFatigue,
  strainIndex,
  oversBowled,
  heartRateRecovery,
}: {
  injuryRisk?: string;
  noBallRisk?: string;
  currentFatigue: number;
  strainIndex: number;
  oversBowled: number;
  heartRateRecovery?: Player['hrRecovery'] | 'OK' | 'Ok';
}): number => {
  const safeFatigue = clamp(currentFatigue, 0, 10);
  const safeStrain = clamp(strainIndex, 0, 10);
  const safeOvers = Math.max(0, oversBowled);
  const recoveryNormalized = toRecoveryNormalized(heartRateRecovery);
  const fatigueComponent = Math.pow(safeFatigue / 10, 1.25) * 38;
  const strainComponent = Math.pow(safeStrain / 10, 1.15) * 18;
  const workloadComponent = Math.min(1.5, safeOvers / 4) * 10.5;
  const recoveryComponent = (1 - recoveryNormalized) * 12;
  const injuryContextComponent = riskContextWeight(injuryRisk, { low: 2, medium: 8, high: 15 });
  const noBallContextComponent = riskContextWeight(noBallRisk, { low: 0, medium: 3, high: 6 });
  const lateFatigueBump = Math.max(0, safeFatigue - 6.5) * 1.6;
  const severeEdge = isSevereRiskEdge({
    fatigue: safeFatigue,
    strainIndex: safeStrain,
    oversBowled: safeOvers,
    recoveryNormalized,
    injuryRisk,
    noBallRisk,
  });
  const riskCap = severeEdge ? 100 : 99;
  return Math.round(
    clamp(
      fatigueComponent +
        strainComponent +
        workloadComponent +
        recoveryComponent +
        injuryContextComponent +
        noBallContextComponent +
        lateFatigueBump,
      0,
      riskCap
    )
  );
};

const buildRiskReason = ({
  fatigue,
  injuryRiskPct,
  strainIndex,
  overAhead,
  heartRateRecovery,
}: {
  fatigue: number;
  injuryRiskPct: number;
  strainIndex: number;
  overAhead: number;
  heartRateRecovery?: Player['hrRecovery'] | 'OK' | 'Ok';
}): string => {
  const tier = riskTierFromPct(injuryRiskPct);
  const recoveryNormalized = toRecoveryNormalized(heartRateRecovery);
  const reasons: string[] = [];
  if (strainIndex >= 6 || overAhead >= 3) {
    reasons.push('workload pressure is compounding');
  }
  if (recoveryNormalized < 0.45) {
    reasons.push('recovery is lagging');
  }
  if (fatigue >= 8.5) {
    reasons.push('fatigue is nearing max');
  } else if (fatigue >= 6.5) {
    reasons.push('fatigue is building');
  }
  if (reasons.length === 0) {
    return `${tier} risk. Workload trend remains manageable.`;
  }
  return `${tier} risk because ${reasons.join(' + ')}.`;
};

const buildFatigueForecast = ({
  currentFatigue,
  currentRiskPct,
  injuryRisk,
  noBallRisk,
  strainIndex,
  oversBowled,
  projectionHorizon,
  intensity,
  heartRateRecovery,
}: {
  currentFatigue: number;
  currentRiskPct: number;
  injuryRisk?: string;
  noBallRisk?: string;
  strainIndex: number;
  oversBowled: number;
  projectionHorizon: number;
  intensity?: string;
  heartRateRecovery?: Player['hrRecovery'] | 'OK' | 'Ok';
}): FatigueForecastPoint[] => {
  // Deterministic weighted projection so fatigue/risk trends are smooth and reproducible.
  const startFatigue = clamp(currentFatigue, 0, 10);
  const safeStrain = clamp(strainIndex, 0, 10);
  const safeOvers = Math.max(0, oversBowled);
  const recoveryNormalized = toRecoveryNormalized(heartRateRecovery);
  const overloadIndex = computeOverloadIndex({
    currentFatigue: startFatigue,
    strainIndex: safeStrain,
    oversBowled: safeOvers,
    recoveryNormalized,
  });
  const baseIncrementPerOver =
    0.14 +
    0.19 * fatigueIntensityMultiplier(intensity) +
    0.16 * overloadIndex +
    0.03 * Math.max(0, Math.min(6, safeOvers) - 1);
  const oversAhead = Array.from({ length: projectionHorizon + 1 }, (_, index) => index);
  let previousFatigue = startFatigue;
  let previousRisk = clamp(currentRiskPct, 0, 100);

  return oversAhead.map((overAhead) => {
    const fatigue =
      overAhead === 0
        ? Number(startFatigue.toFixed(1))
        : (() => {
            const progressionFactor = 1 + (overAhead - 1) * (0.05 + overloadIndex * 0.05);
            const capDamping =
              previousFatigue >= 9.6
                ? 0.40
                : previousFatigue >= 8.8
                  ? 0.55
                  : previousFatigue >= 8
                    ? 0.78
                    : 1.0;
            const fatigueStep = baseIncrementPerOver * progressionFactor * capDamping;
            previousFatigue = Number(clamp(previousFatigue + fatigueStep, 0, 10).toFixed(1));
            return previousFatigue;
          })();

    const projectedOvers = safeOvers + overAhead;
    const fatigueComponent = Math.pow(fatigue / 10, 1.25) * 38;
    const strainComponent = Math.pow(safeStrain / 10, 1.15) * 18;
    const workloadComponent = Math.min(1.7, projectedOvers / 4) * 10.5;
    const recoveryComponent = (1 - recoveryNormalized) * 12;
    const injuryContextComponent = riskContextWeight(injuryRisk, { low: 2, medium: 8, high: 15 });
    const noBallContextComponent = riskContextWeight(noBallRisk, { low: 0, medium: 3, high: 6 });
    const progressiveLoad = overAhead * (0.8 + overloadIndex * 1.5);
    const lateFatigueBump = Math.max(0, fatigue - 6.5) * (1.6 + overloadIndex * 0.5);
    const severeEdge = isSevereRiskEdge({
      fatigue,
      strainIndex: safeStrain,
      oversBowled: projectedOvers,
      recoveryNormalized,
      injuryRisk,
      noBallRisk,
    });
    const riskCap = severeEdge ? 100 : 99;
    const riskTarget = clamp(
      fatigueComponent +
        strainComponent +
        workloadComponent +
        recoveryComponent +
        injuryContextComponent +
        noBallContextComponent +
        progressiveLoad +
        lateFatigueBump,
      0,
      riskCap
    );
    let injuryRiskPct =
      overAhead === 0
        ? Math.round(clamp(currentRiskPct, 0, riskCap))
        : (() => {
            const smoothingFactor = clamp(0.44 + overloadIndex * 0.08, 0.42, 0.56);
            const blendedRisk = previousRisk + (riskTarget - previousRisk) * smoothingFactor;
            const maxRiskStep = severeEdge ? 10 : overloadIndex >= 0.85 ? 8 : overloadIndex >= 0.60 ? 7 : 6;
            // Cap per-over jumps so high-risk states climb progressively instead of instant flatline.
            const boundedRisk = clamp(blendedRisk, previousRisk - 2, previousRisk + maxRiskStep);
            const minStepIfRising = overloadIndex >= 0.75 ? 2 : overloadIndex >= 0.45 ? 1 : 0;
            let nextRisk = Math.round(clamp(boundedRisk, 0, riskCap));
            if (riskTarget > previousRisk && minStepIfRising > 0) {
              nextRisk = Math.max(nextRisk, Math.round(previousRisk + minStepIfRising));
            }
            return nextRisk;
          })();
    injuryRiskPct = Math.round(clamp(injuryRiskPct, 0, riskCap));
    previousRisk = injuryRiskPct;
    return {
      overAhead,
      fatigue,
      injuryRiskPct,
      reason: buildRiskReason({
        fatigue,
        injuryRiskPct,
        strainIndex: safeStrain,
        overAhead,
        heartRateRecovery,
      }),
    };
  });
};

function FatigueForecastChart({
  currentFatigue,
  strainIndex,
  oversBowled,
  currentInjuryRisk,
  currentNoBallRisk,
  playerStatus,
  matchFormat,
  intensity,
  heartRateRecovery,
}: {
  currentFatigue: number;
  strainIndex: number;
  oversBowled: number;
  currentInjuryRisk?: string;
  currentNoBallRisk?: string;
  playerStatus?: string;
  matchFormat: string;
  intensity?: string;
  heartRateRecovery?: Player['hrRecovery'] | 'OK' | 'Ok';
}) {
  const normalizedInjuryRisk = React.useMemo(
    () => String(currentInjuryRisk || '').trim().toUpperCase(),
    [currentInjuryRisk]
  );
  const normalizedPlayerStatus = React.useMemo(
    () => String(playerStatus || '').trim().toUpperCase(),
    [playerStatus]
  );
  const isTerminalRiskState = React.useMemo(
    () =>
      normalizedInjuryRisk === 'CRITICAL' ||
      normalizedPlayerStatus === 'UNFIT' ||
      safeNum(currentFatigue, 0) >= 10,
    [normalizedInjuryRisk, normalizedPlayerStatus, currentFatigue]
  );
  const projectionHorizon = React.useMemo(
    () => getProjectionHorizon(matchFormat),
    [matchFormat]
  );
  const oversTicks = React.useMemo(
    () => (isTerminalRiskState ? [0, 1] : Array.from({ length: projectionHorizon + 1 }, (_, index) => index)),
    [isTerminalRiskState, projectionHorizon]
  );
  const currentRiskPct = React.useMemo(
    () =>
      baselineInjuryRiskPct({
        injuryRisk: currentInjuryRisk,
        noBallRisk: currentNoBallRisk,
        currentFatigue,
        strainIndex,
        oversBowled,
        heartRateRecovery,
      }),
    [currentInjuryRisk, currentNoBallRisk, currentFatigue, strainIndex, oversBowled, heartRateRecovery]
  );
  const points: FatigueForecastPoint[] = React.useMemo(() => {
    if (isTerminalRiskState) {
      const saturatedFatigue = Number(clamp(currentFatigue, 0, 10).toFixed(1));
      const saturatedRisk = Math.round(clamp(currentRiskPct, 0, 100));
      return [
        {
          overAhead: 0,
          fatigue: saturatedFatigue,
          injuryRiskPct: saturatedRisk,
          reason: 'Risk saturated. Player marked unfit for continued workload.',
        },
        {
          overAhead: 1,
          fatigue: saturatedFatigue,
          injuryRiskPct: saturatedRisk,
          reason: 'Risk saturated. Continue with substitution-only plan.',
        },
      ];
    }
    return buildFatigueForecast({
      currentFatigue,
      currentRiskPct,
      injuryRisk: currentInjuryRisk,
      noBallRisk: currentNoBallRisk,
      strainIndex,
      oversBowled,
      projectionHorizon,
      intensity,
      heartRateRecovery,
    });
  }, [
    isTerminalRiskState,
    currentFatigue,
    currentRiskPct,
    currentInjuryRisk,
    currentNoBallRisk,
    strainIndex,
    oversBowled,
    projectionHorizon,
    intensity,
    heartRateRecovery,
  ]);
  const riskAtTwo = points.find((point) => point.overAhead === 2)?.injuryRiskPct ?? points[Math.min(2, points.length - 1)]?.injuryRiskPct ?? currentRiskPct;
  const terminalOver = projectionHorizon >= 5 ? 5 : 4;
  const riskAtTerminal = points.find((point) => point.overAhead === terminalOver)?.injuryRiskPct ?? points[points.length - 1]?.injuryRiskPct ?? currentRiskPct;
  const riskAcceleration = Number((riskAtTerminal - riskAtTwo).toFixed(1));
  const riskCrossPoint = points.find((point, index) => {
    if (point.injuryRiskPct < HIGH_RISK_THRESHOLD_PCT) return false;
    if (index === 0) return true;
    return points[index - 1].injuryRiskPct < HIGH_RISK_THRESHOLD_PCT;
  });
  const emphasizeHighRisk = Boolean(riskCrossPoint) || riskAcceleration >= RISK_ACCELERATION_THRESHOLD;
  const forecastGridColsClass = points.length === 5 ? 'grid-cols-3 sm:grid-cols-5' : 'grid-cols-3 sm:grid-cols-6';

  return (
    <div
      className="relative rounded-2xl border border-white/10 bg-white/[0.04] backdrop-blur-xl shadow-[inset_0_1px_0_rgba(255,255,255,0.08)] p-4 overflow-hidden"
      style={{ position: 'relative' }}
    >
      <div className="absolute inset-0 rounded-2xl bg-gradient-to-br from-emerald-500/10 via-cyan-500/5 to-transparent pointer-events-none" />
      <div className="relative z-10">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-bold text-white">Fatigue Forecast</h3>
            <p className="text-xs text-slate-400">{`Next ${isTerminalRiskState ? 1 : projectionHorizon} overs • AI projection`}</p>
          </div>
          <div className="flex flex-col items-end gap-1.5">
            <span className="rounded-full border border-cyan-400/35 bg-cyan-500/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-cyan-200">
              AI
            </span>
            <div className="flex flex-col items-end gap-0.5 text-[10px] leading-tight text-slate-300">
              <span className="inline-flex items-center gap-1">
                <span className="text-[11px] leading-none" style={{ color: '#22d3ee' }}>
                  ●
                </span>
                Fatigue (0–10)
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="text-[11px] leading-none" style={{ color: '#f59e0b' }}>
                  ●
                </span>
                Injury Risk (%)
              </span>
            </div>
          </div>
        </div>
        <div className="mt-4 h-[240px] w-full" style={{ height: 240, position: 'relative' }}>
          {isTerminalRiskState && (
            <>
              <div
                style={{
                  position: 'absolute',
                  left: 0,
                  right: 0,
                  top: '10%',
                  height: '25%',
                  background: 'linear-gradient(180deg, rgba(220,38,38,0.18), rgba(220,38,38,0.05))',
                  pointerEvents: 'none',
                  zIndex: 3,
                }}
              />
              <div
                style={{
                  position: 'absolute',
                  top: '12px',
                  right: '16px',
                  background: 'rgba(220,38,38,0.18)',
                  border: '1px solid rgba(220,38,38,0.45)',
                  color: '#ff6b6b',
                  padding: '6px 12px',
                  borderRadius: '8px',
                  fontSize: '12px',
                  fontWeight: 600,
                  letterSpacing: '0.4px',
                  backdropFilter: 'blur(4px)',
                  pointerEvents: 'none',
                  zIndex: 4,
                }}
              >
                Risk Saturated • Player marked UNFIT
              </div>
            </>
          )}
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={points} margin={{ top: 10, right: 90, bottom: 30, left: 48 }}>
              <defs>
                <linearGradient id="fatigueLine" x1="0%" y1="0%" x2="100%" y2="0%">
                  <stop offset="0%" stopColor="rgba(34,211,238,0.95)" />
                  <stop offset="100%" stopColor="rgba(16,185,129,0.95)" />
                </linearGradient>
                <linearGradient id="riskLine" x1="0%" y1="0%" x2="100%" y2="0%">
                  <stop offset="0%" stopColor="rgba(251,191,36,0.95)" />
                  <stop offset="100%" stopColor="rgba(244,114,182,0.92)" />
                </linearGradient>
              </defs>
              <ReferenceArea yAxisId="risk" y1={0} y2={LOW_RISK_THRESHOLD_PCT} fill="rgba(16,185,129,0.08)" strokeOpacity={0} />
              <ReferenceArea yAxisId="risk" y1={LOW_RISK_THRESHOLD_PCT} y2={HIGH_RISK_THRESHOLD_PCT} fill="rgba(245,158,11,0.08)" strokeOpacity={0} />
              <ReferenceArea yAxisId="risk" y1={HIGH_RISK_THRESHOLD_PCT} y2={100} fill="rgba(244,63,94,0.08)" strokeOpacity={0} />
              <CartesianGrid strokeDasharray="4 6" vertical={false} stroke="rgba(255,255,255,0.08)" />
              <XAxis
                dataKey="overAhead"
                ticks={oversTicks}
                tickFormatter={(value) => (value === 0 ? 'Now' : `+${value}`)}
                tickLine={false}
                axisLine={{ stroke: 'rgba(255,255,255,0.10)' }}
                tick={{ fill: 'rgba(255,255,255,0.55)', fontSize: 12 }}
                label={{ value: 'Overs Ahead', position: 'bottom', offset: 8, fill: 'rgba(255,255,255,0.55)' }}
              />
              <YAxis
                yAxisId="fatigue"
                domain={[0, 10]}
                ticks={FORECAST_Y_TICKS}
                tickLine={false}
                axisLine={false}
                width={62}
                tick={{ fill: 'rgba(255,255,255,0.55)', fontSize: 12 }}
                label={{ value: 'Fatigue (0–10)', angle: -90, position: 'insideLeft', dx: -22, dy: 18, fill: 'rgba(255,255,255,0.55)' }}
              />
              <YAxis
                yAxisId="risk"
                orientation="right"
                domain={[0, 100]}
                ticks={FORECAST_RISK_TICKS}
                tickLine={false}
                axisLine={false}
                width={48}
                tickFormatter={(value) => `${value}%`}
                tick={{ fill: 'rgba(255,255,255,0.52)', fontSize: 11 }}
                label={{ value: 'Injury Risk (0–100%)', angle: 90, position: 'right', offset: 28, dy: -25, fill: 'rgba(255,255,255,0.52)' }}
              />
              <Tooltip
                cursor={{ stroke: 'rgba(255,255,255,0.15)', strokeDasharray: '3 3' }}
                content={({ active, payload }) => {
                  if (!active || !payload || payload.length === 0) return null;
                  const point = payload[0]?.payload as FatigueForecastPoint | undefined;
                  if (!point) return null;
                  const overLabel = point.overAhead === 0 ? 'Now' : `+${point.overAhead}`;
                  return (
                    <div
                      className="rounded-xl border border-white/10 bg-[#0f172a] px-3 py-2 shadow-xl"
                      style={{ minWidth: 220 }}
                    >
                      <p className="text-[11px] font-semibold text-slate-200">Over: {overLabel}</p>
                      <p className="mt-1 text-[11px] text-cyan-200">Fatigue: {point.fatigue.toFixed(1)} / 10</p>
                      <p className="text-[11px] text-amber-200">Injury Risk: {point.injuryRiskPct.toFixed(0)}%</p>
                      <p className="mt-1 text-[10px] leading-relaxed text-slate-300">{point.reason}</p>
                    </div>
                  );
                }}
              />
              {emphasizeHighRisk && (
                <ReferenceLine
                  yAxisId="risk"
                  y={HIGH_RISK_THRESHOLD_PCT}
                  stroke="rgba(251,113,133,0.42)"
                  strokeDasharray="6 6"
                  label={{ value: 'High risk ≥ 65%', position: 'insideTopRight', fill: 'rgba(255,255,255,0.42)' }}
                />
              )}
              {riskCrossPoint && (
                <ReferenceLine
                  yAxisId="risk"
                  x={riskCrossPoint.overAhead}
                  stroke="rgba(251,191,36,0.35)"
                  strokeDasharray="4 4"
                />
              )}
              <Line
                type="monotone"
                yAxisId="fatigue"
                dataKey="fatigue"
                stroke="url(#fatigueLine)"
                strokeWidth={3}
                dot={{ r: 4, fill: '#22d3ee', stroke: '#a5f3fc', strokeWidth: 1 }}
                activeDot={{ r: 6, fill: '#06b6d4' }}
              />
              <Line
                type="monotone"
                yAxisId="risk"
                dataKey="injuryRiskPct"
                stroke="url(#riskLine)"
                strokeWidth={2.5}
                dot={{ r: 4, fill: '#f59e0b', stroke: '#fde68a', strokeWidth: 1 }}
                activeDot={{ r: 6, fill: '#f59e0b' }}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>

        <div className="mt-4 border-t border-white/10" />

        <div className={`mt-4 grid gap-2 ${forecastGridColsClass}`}>
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
                <p className="text-[10px] text-slate-400 mt-1">
                  Risk {point.injuryRiskPct.toFixed(0)}%
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
                label={{ value: 'Pressure (0–10)', angle: -90, position: 'insideLeft', dy: 15, fill: 'rgba(255,255,255,0.55)' }}
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
  aiEnabled: boolean;
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
  combinedBriefing: string | null;
  combinedDecision: TacticalCombinedDecision | null;
  finalRecommendation: FinalRecommendation | null;
  orchestrateMeta: OrchestrateMetaView | null;
  routerDecision: RouterDecisionView | null;
  agentFeedStatus: AgentFeedStatus;
  analysisBundleId: string;
  coachOutput: CoachOutputView | null;
  agentWarning: string | null;
  agentFailure: AgentFailureDetail | null;
  setAgentWarning: React.Dispatch<React.SetStateAction<string | null>>;
  setAgentFailure: React.Dispatch<React.SetStateAction<AgentFailureDetail | null>>;
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

interface CoachAnalysisInputSnapshot {
  selectedPlayerId: string;
  oversBowled: number;
  fatigueIndex: number;
  strainIndex: number;
  heartRateRecovery: string;
  scoreRuns: number;
  wickets: number;
  ballsBowled: number;
  totalOvers: number;
  targetRuns: number;
  matchMode: string;
  phase: string;
  intensity: string;
  weather: string;
  format: string;
}

const normalizeAnalysisInputToken = (value: unknown, fallback: string): string => {
  const token = String(value || '').trim().toUpperCase();
  return token || fallback;
};

const normalizeAnalysisInputValue = (value: unknown, fallback = 0, precision = 2): number =>
  Number(safeNum(value, fallback).toFixed(precision));

// Dirty-state must only track normalized analysis-driving inputs (not transient UI/runtime metadata).
const normalizeAnalysisInputs = (
  snapshot: Partial<CoachAnalysisInputSnapshot>
): CoachAnalysisInputSnapshot => ({
  selectedPlayerId: String(snapshot.selectedPlayerId || '').trim(),
  oversBowled: normalizeAnalysisInputValue(snapshot.oversBowled, 0),
  fatigueIndex: normalizeAnalysisInputValue(snapshot.fatigueIndex, 0),
  strainIndex: normalizeAnalysisInputValue(snapshot.strainIndex, 0),
  heartRateRecovery: normalizeAnalysisInputToken(snapshot.heartRateRecovery, 'GOOD'),
  scoreRuns: normalizeAnalysisInputValue(snapshot.scoreRuns, 0, 0),
  wickets: normalizeAnalysisInputValue(snapshot.wickets, 0, 0),
  ballsBowled: normalizeAnalysisInputValue(snapshot.ballsBowled, 0, 0),
  totalOvers: normalizeAnalysisInputValue(snapshot.totalOvers, 20, 0),
  targetRuns: normalizeAnalysisInputValue(snapshot.targetRuns, -1, 0),
  matchMode: normalizeAnalysisInputToken(snapshot.matchMode, 'BOWLING'),
  phase: normalizeAnalysisInputToken(snapshot.phase, 'MIDDLE'),
  intensity: normalizeAnalysisInputToken(snapshot.intensity, 'MEDIUM'),
  weather: normalizeAnalysisInputToken(snapshot.weather, 'COOL'),
  format: normalizeAnalysisInputToken(snapshot.format, 'T20'),
});

const haveAnalysisInputsChanged = (
  current: CoachAnalysisInputSnapshot,
  baseline: CoachAnalysisInputSnapshot
): { changed: boolean; changedFields: Array<keyof CoachAnalysisInputSnapshot> } => {
  const changedFields = (Object.keys(current) as Array<keyof CoachAnalysisInputSnapshot>).filter(
    (field) => baseline[field] !== current[field]
  );
  return { changed: changedFields.length > 0, changedFields };
};

interface ConfirmSwitchOverlayProps {
  open: boolean;
  suggestion: SuggestedBowlerRecommendation | null;
  onSwitch: () => void;
  onCancel: () => void;
  title?: string;
  prompt?: string;
  confirmLabel?: string;
  cancelLabel?: string;
}

function ConfirmSwitchOverlay({
  open,
  suggestion,
  onSwitch,
  onCancel,
  title,
  prompt,
  confirmLabel = 'Switch',
  cancelLabel = 'Cancel',
}: ConfirmSwitchOverlayProps) {
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
            {title || `Coach suggests switching to: ${suggestion.bowlerName}`}
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
        {prompt && (
          <p
            style={{
              margin: '0 0 14px',
              fontSize: '12px',
              lineHeight: 1.4,
              color: '#E2E8F0',
            }}
          >
            {prompt}
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
            {cancelLabel}
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
            {confirmLabel}
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
  title?: string;
  message?: string;
  confirmLabel?: string;
}

function MatchModeGuardOverlay({
  open,
  onSwitch,
  onCancel,
  title = 'Batting actions locked',
  message = 'Batting actions are locked while match state is Bowling. Switch match state to Batting to continue.',
  confirmLabel = 'Switch to Batting',
}: MatchModeGuardOverlayProps) {
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
              {title}
            </h3>
            <p
              style={{
                margin: '8px 0 0',
                fontSize: '13px',
                lineHeight: 1.45,
                color: '#94A3B8',
              }}
            >
              {message}
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
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

function Dashboard({
  aiEnabled, matchContext, runMode, teamMode, setTeamMode, matchState, players, activePlayer, setActivePlayerId, updatePlayer, updateMatchState, deleteRosterPlayer, movePlayerToSub,
  agentState, aiAnalysis, riskAnalysis, tacticalAnalysis, strategicAnalysis, combinedAnalysis, combinedBriefing, combinedDecision, finalRecommendation, orchestrateMeta, routerDecision, agentFeedStatus, analysisBundleId, coachOutput, agentWarning, agentFailure, setAgentWarning, setAgentFailure, analysisActive, runAgent, onDismissAnalysis, handleAddOver, handleDecreaseOver, handleRest, handleMarkUnfit,
  recoveryMode, setRecoveryMode, manualRecovery, setManualRecovery, isLoadingRosterPlayers, rosterMutationError, onGoToBaselines, onBack
}: DashboardProps) {
  const [arTelemetryView, setArTelemetryView] = useState<'batting' | 'bowling'>('batting');
  const [strainIndex, setStrainIndex] = useState(0);
  const [isResettingBaselines, setIsResettingBaselines] = useState(false);
  const [rosterEmptyError, setRosterEmptyError] = useState<string | null>(null);
  const [substitutionRecommendation, setSubstitutionRecommendation] = useState<string | null>(null);
  const [isRunCoachHovered, setIsRunCoachHovered] = useState(false);
  const [showCoachInsights, setShowCoachInsights] = useState(false);
  const [isCoachPanelSuppressedForSelection, setIsCoachPanelSuppressedForSelection] = useState(false);
  const [showCopilotChat, setShowCopilotChat] = useState(() => {
    if (typeof window === 'undefined') return false;
    try {
      return String(window.sessionStorage.getItem(COPILOT_VISIBILITY_STORAGE_KEY) || '').trim() === 'true';
    } catch {
      return false;
    }
  });
  const [copilotSessionAnalysisId, setCopilotSessionAnalysisId] = useState(() => {
    if (typeof window === 'undefined') return '';
    try {
      const storedId = String(window.localStorage.getItem(COPILOT_ANALYSIS_ID_STORAGE_KEY) || '').trim();
      const storedAt = Number(window.localStorage.getItem(COPILOT_ANALYSIS_AT_STORAGE_KEY) || 0);
      if (!storedId) return '';
      if (!Number.isFinite(storedAt) || storedAt <= 0) {
        window.localStorage.removeItem(COPILOT_ANALYSIS_ID_STORAGE_KEY);
        window.localStorage.removeItem(COPILOT_ANALYSIS_AT_STORAGE_KEY);
        return '';
      }
      if (Date.now() - storedAt > COPILOT_ANALYSIS_TTL_MS) {
        window.localStorage.removeItem(COPILOT_ANALYSIS_ID_STORAGE_KEY);
        window.localStorage.removeItem(COPILOT_ANALYSIS_AT_STORAGE_KEY);
        return '';
      }
      return storedId;
    } catch {
      return '';
    }
  });
  const [copilotVerifiedAnalysisId, setCopilotVerifiedAnalysisId] = useState('');
  const [copilotResetToken, setCopilotResetToken] = useState(0);
  const [showRouterSignals, setShowRouterSignals] = useState(false);
  const [showRawTelemetry, setShowRawTelemetry] = useState(false);
  const [briefCopied, setBriefCopied] = useState(false);
  const [showMatchModeGuard, setShowMatchModeGuard] = useState(false);
  const [showBowlingCoachModeGuard, setShowBowlingCoachModeGuard] = useState(false);
  const [matchModeGuardContent, setMatchModeGuardContent] = useState<{
    title: string;
    message: string;
    confirmLabel: string;
  } | null>(null);
  const [bowlingCoachModeGuardContent, setBowlingCoachModeGuardContent] = useState<{
    title: string;
    message: string;
    confirmLabel: string;
  } | null>(null);
  const [inningsLockNotice, setInningsLockNotice] = useState<string | null>(null);
  const [showRotateBowlerConfirm, setShowRotateBowlerConfirm] = useState(false);
  const [rotateBowlerSuggestion, setRotateBowlerSuggestion] = useState<SuggestedBowlerRecommendation | null>(null);
  const [rotateBowlerNotice, setRotateBowlerNotice] = useState<string | null>(null);
  const [showNextBatterConfirm, setShowNextBatterConfirm] = useState(false);
  const [recommendedNextBatter, setRecommendedNextBatter] = useState<SuggestedBowlerRecommendation | null>(null);
  const [nextBatterNotice, setNextBatterNotice] = useState<string | null>(null);
  const [isSuggestingNextBatter, setIsSuggestingNextBatter] = useState(false);
  const [fullAnalysisRunPending, setFullAnalysisRunPending] = useState(false);
  const [fullAnalysisExecuted, setFullAnalysisExecuted] = useState(false);
  const [analysisExecuted, setAnalysisExecuted] = useState(false);
  const [analysisStale, setAnalysisStale] = useState(false);
  const [analysisSnapshot, setAnalysisSnapshot] = useState<CoachAnalysisInputSnapshot | null>(null);
  const [showFullAnalysisInfo, setShowFullAnalysisInfo] = useState(false);
  const [showDismissAnalysisInfo, setShowDismissAnalysisInfo] = useState(false);
  const [pressureStateByPlayer, setPressureStateByPlayer] = useState<{ playerId: string; base: number; eventDelta: number } | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);
  const pendingMatchModeActionRef = useRef<(() => void) | null>(null);
  const pendingMatchModeRequiredRef = useRef<TeamMode>('BATTING');
  const pendingBowlingCoachActionRef = useRef<(() => void) | null>(null);
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
  const lastCapturedAnalysisBundleIdRef = useRef<string>('');
  const pendingAnalysisSnapshotRef = useRef<CoachAnalysisInputSnapshot | null>(null);
  const previousSelectedPlayerIdRef = useRef<string>(String(activePlayer?.id || ''));
  const playerSwitchResetRef = useRef<boolean>(false);

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
    const nextSelectedId = String(activePlayer?.id || '');
    const previousSelectedId = previousSelectedPlayerIdRef.current;
    const didSwitchPlayer =
      previousSelectedId.length > 0 &&
      nextSelectedId.length > 0 &&
      previousSelectedId !== nextSelectedId;
    playerSwitchResetRef.current = didSwitchPlayer;

    if (didSwitchPlayer) {
      const hadOpenAnalysis =
        analysisActive ||
        showCoachInsights ||
        fullAnalysisRunPending ||
        fullAnalysisExecuted ||
        analysisExecuted;

      if (hadOpenAnalysis) {
        onDismissAnalysis?.();
      }

      setSubstitutionRecommendation(null);
      setShowCoachInsights(false);
      setShowCopilotChat(false);
      setCopilotSessionAnalysisId('');
      setCopilotVerifiedAnalysisId('');
      setCopilotResetToken((value) => value + 1);
      setShowRouterSignals(false);
      setShowRawTelemetry(false);
      setShowRotateBowlerConfirm(false);
      setRotateBowlerSuggestion(null);
      setShowNextBatterConfirm(false);
      setRecommendedNextBatter(null);
      setNextBatterNotice(null);
      setIsSuggestingNextBatter(false);
      setFullAnalysisRunPending(false);
      setFullAnalysisExecuted(false);
      setAnalysisExecuted(false);
      setAnalysisStale(false);
      setAnalysisSnapshot(null);
      pendingAnalysisSnapshotRef.current = null;
      setShowFullAnalysisInfo(false);
      setShowDismissAnalysisInfo(false);
      lastCapturedAnalysisBundleIdRef.current = String(analysisBundleId || '').trim();
    }

    setIsCoachPanelSuppressedForSelection(false);
    previousSelectedPlayerIdRef.current = nextSelectedId;
  }, [activePlayer?.id]);

  useEffect(() => {
    if (!isCoachPanelSuppressedForSelection) return;
    setIsCoachPanelSuppressedForSelection(false);
  }, [isCoachPanelSuppressedForSelection]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      if (showCopilotChat) {
        window.sessionStorage.setItem(COPILOT_VISIBILITY_STORAGE_KEY, 'true');
      } else {
        window.sessionStorage.removeItem(COPILOT_VISIBILITY_STORAGE_KEY);
      }
    } catch {
      // Ignore storage failures in restricted browser modes.
    }
  }, [showCopilotChat]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      if (copilotSessionAnalysisId) {
        window.localStorage.setItem(COPILOT_ANALYSIS_ID_STORAGE_KEY, copilotSessionAnalysisId);
        window.localStorage.setItem(COPILOT_ANALYSIS_AT_STORAGE_KEY, String(Date.now()));
      } else {
        window.localStorage.removeItem(COPILOT_ANALYSIS_ID_STORAGE_KEY);
        window.localStorage.removeItem(COPILOT_ANALYSIS_AT_STORAGE_KEY);
      }
    } catch {
      // Ignore local storage failures in restricted browser modes.
    }
  }, [copilotSessionAnalysisId]);

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
    setShowCopilotChat(false);
    setShowFullAnalysisInfo(false);
    setShowDismissAnalysisInfo(false);
    setShowNextBatterConfirm(false);
    setRecommendedNextBatter(null);
    setNextBatterNotice(null);
    setIsSuggestingNextBatter(false);
    setFullAnalysisRunPending(false);
    setFullAnalysisExecuted(false);
    setAnalysisExecuted(false);
    setAnalysisStale(false);
    setAnalysisSnapshot(null);
    pendingAnalysisSnapshotRef.current = null;
    lastCapturedAnalysisBundleIdRef.current = '';
    setCopilotSessionAnalysisId('');
    setCopilotVerifiedAnalysisId('');
    setCopilotResetToken((value) => value + 1);
    onDismissAnalysis?.();
  };

  const telemetryView: 'batting' | 'bowling' = activePlayer?.role === 'Batsman'
    ? 'batting'
    : activePlayer?.role === 'All-rounder'
      ? arTelemetryView
      : 'bowling';
  const isBatsmanActive = telemetryView === 'batting';
  const focusRole: 'BOWLER' | 'BATTER' = telemetryView === 'bowling' ? 'BOWLER' : 'BATTER';
  const currentTelemetry = activePlayer
    ? {
        playerId: activePlayer.id,
        playerName: activePlayer.name,
        role: activePlayer.role,
        fatigueIndex: safeNum(activePlayer.fatigue, 0),
        strainIndex: safeNum(activePlayer.strainIndex, 0),
      }
    : {
        playerId: '',
        playerName: '',
        role: '',
        fatigueIndex: 0,
        strainIndex: 0,
      };
  const analysisInputSnapshot = useMemo<CoachAnalysisInputSnapshot>(
    () => {
      const normalized = normalizeAnalysisInputs({
        selectedPlayerId: String(activePlayer?.id || currentTelemetry.playerId || ''),
        oversBowled: safeNum(activePlayer?.overs, 0),
        fatigueIndex: safeNum(activePlayer?.fatigue, currentTelemetry.fatigueIndex),
        strainIndex: safeNum(strainIndex, currentTelemetry.strainIndex),
        heartRateRecovery: recoveryMode === 'manual' ? manualRecovery : activePlayer?.hrRecovery || 'Good',
        scoreRuns: safeNum(matchState.runs, 0),
        wickets: safeNum(matchState.wickets, 0),
        ballsBowled: safeNum(matchState.ballsBowled, 0),
        totalOvers: safeNum(matchState.totalOvers, 20),
        targetRuns: typeof matchState.target === 'number' ? safeNum(matchState.target, -1) : -1,
        matchMode: matchContext.matchMode,
        phase: matchContext.phase,
        intensity: matchContext.pitch,
        weather: matchContext.weather,
        format: matchContext.format,
      });
      return normalized;
    },
    [
      activePlayer?.fatigue,
      activePlayer?.hrRecovery,
      activePlayer?.id,
      activePlayer?.overs,
      currentTelemetry.fatigueIndex,
      currentTelemetry.playerId,
      currentTelemetry.strainIndex,
      manualRecovery,
      matchState.ballsBowled,
      matchState.runs,
      matchState.target,
      matchState.totalOvers,
      matchState.wickets,
      matchContext.format,
      matchContext.matchMode,
      matchContext.phase,
      matchContext.pitch,
      matchContext.weather,
      recoveryMode,
      strainIndex,
    ]
  );

  useEffect(() => {
    if (!fullAnalysisRunPending) return;
    if (playerSwitchResetRef.current) {
      pendingAnalysisSnapshotRef.current = null;
      setFullAnalysisRunPending(false);
      return;
    }
    if (agentState === 'thinking') return;
    if (agentState === 'done') {
      if (import.meta.env.DEV) {
        console.log('[dashboard] analysis_executed', {
          selectedPlayerId: analysisInputSnapshot.selectedPlayerId || null,
        });
      }
      const normalizedAnalysisSnapshot = normalizeAnalysisInputs(
        pendingAnalysisSnapshotRef.current || analysisInputSnapshot
      );
      setFullAnalysisExecuted(true);
      setAnalysisExecuted(true);
      setAnalysisStale(false);
      setAnalysisSnapshot(normalizedAnalysisSnapshot);
      setShowFullAnalysisInfo(false);
      setShowDismissAnalysisInfo(false);
      lastCapturedAnalysisBundleIdRef.current = String(analysisBundleId || '').trim();
      pendingAnalysisSnapshotRef.current = null;
      if (import.meta.env.DEV) {
        console.log('[dashboard] analysis_snapshot_stored', normalizedAnalysisSnapshot);
      }
    }
    if (agentState !== 'thinking' && agentState !== 'done') {
      pendingAnalysisSnapshotRef.current = null;
    }
    setFullAnalysisRunPending(false);
  }, [agentState, analysisBundleId, analysisInputSnapshot, fullAnalysisRunPending]);

  useEffect(() => {
    if (playerSwitchResetRef.current) return;
    if (agentState !== 'done' || !analysisActive) return;
    const completedBundleId = String(analysisBundleId || '').trim();
    if (!completedBundleId) return;
    if (lastCapturedAnalysisBundleIdRef.current === completedBundleId) return;
    lastCapturedAnalysisBundleIdRef.current = completedBundleId;
    const normalizedAnalysisSnapshot = normalizeAnalysisInputs(
      pendingAnalysisSnapshotRef.current || analysisInputSnapshot
    );
    setAnalysisExecuted(true);
    setAnalysisStale(false);
    setAnalysisSnapshot(normalizedAnalysisSnapshot);
    pendingAnalysisSnapshotRef.current = null;
    if (import.meta.env.DEV) {
      console.log('[dashboard] analysis_executed', {
        selectedPlayerId: analysisInputSnapshot.selectedPlayerId || null,
        analysisBundleId: completedBundleId,
      });
      console.log('[dashboard] analysis_snapshot_stored', normalizedAnalysisSnapshot);
    }
  }, [agentState, analysisActive, analysisBundleId, analysisInputSnapshot]);

  useEffect(() => {
    if (playerSwitchResetRef.current) return;
    if (!analysisExecuted) return;
    if (fullAnalysisRunPending) return;
    const baseline = analysisSnapshot;
    if (!baseline) return;
    if (
      baseline.selectedPlayerId &&
      analysisInputSnapshot.selectedPlayerId &&
      baseline.selectedPlayerId !== analysisInputSnapshot.selectedPlayerId
    ) {
      return;
    }
    const normalizedCurrentInputs = normalizeAnalysisInputs(analysisInputSnapshot);
    const normalizedLastAnalyzedInputs = normalizeAnalysisInputs(baseline);
    const { changed, changedFields } = haveAnalysisInputsChanged(normalizedCurrentInputs, normalizedLastAnalyzedInputs);
    if (import.meta.env.DEV) {
      console.log('[dashboard] analysis_dirty_check', {
        currentNormalizedInputs: normalizedCurrentInputs,
        lastAnalyzedNormalizedInputs: normalizedLastAnalyzedInputs,
        dirty: changed,
        changedFields,
      });
    }
    if (!changed) return;
    if (import.meta.env.DEV) {
      console.log('[dashboard] analysis_input_changed', {
        changedFields,
        before: normalizedLastAnalyzedInputs,
        after: normalizedCurrentInputs,
      });
    }
    if (analysisStale) return;
    if (import.meta.env.DEV) {
      console.log('[dashboard] analysis_stale_true', {
        selectedPlayerId: normalizedCurrentInputs.selectedPlayerId || null,
        changedFields,
      });
    }
    setAnalysisStale(true);
  }, [analysisExecuted, analysisInputSnapshot, analysisSnapshot, analysisStale, fullAnalysisRunPending]);

  const fixedInningsOvers = getInningsTotalOvers(matchContext.format);
  const resolvedTotalOvers = fixedInningsOvers ?? Math.max(1, Math.floor(matchState.totalOvers));
  const totalBalls = totalBallsFromOvers(resolvedTotalOvers);
  const ballsBowled = Math.min(totalBalls, Math.max(0, matchState.ballsBowled));
  const ballsRemaining = Math.max(totalBalls - ballsBowled, 0);
  // Shared innings cap for setup + batting controls.
  const isInningsFinished = ballsBowled >= totalBalls;
  const inningsComplete = isInningsFinished;
  const formatMaxOvers = activePlayer?.maxOvers ?? getMaxOvers(matchContext.format);
  const hasFormatCap = Number.isFinite(formatMaxOvers);
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
  const applyStrainDelta = (strainDelta: number, _baseFatigueDelta: number) => {
    if (!activePlayer) return;
    setStrainIndex((prev) => Math.max(0, Math.min(5, prev + strainDelta)));
    // Keep fatigue source-of-truth on player state so telemetry + AI read the same updated value.
    updatePlayer(activePlayer.id, (player) => {
      const nextStrain = Math.max(0, Math.min(5, safeNum(player.strainIndex, 0) + strainDelta));
      const oversBowled = Math.max(0, safeNum(player.overs, 0));
      const nextFatigue = computeFatigueFromLoad({
        player,
        oversBowled,
        strainIndex: nextStrain,
        intensity: matchContext.pitch || 'Medium',
        noBallRisk: player.noBallRisk,
        injuryRisk: player.injuryRisk,
      });
      return {
        strainIndex: nextStrain,
        fatigue: nextFatigue,
      };
    });
  };
  const handleResetStrain = () => {
    if (!activePlayer) {
      setStrainIndex(0);
      return;
    }
    setStrainIndex(0);
    updatePlayer(activePlayer.id, (player) => {
      const oversBowled = Math.max(0, safeNum(player.overs, 0));
      const nextFatigue = computeFatigueFromLoad({
        player,
        oversBowled,
        strainIndex: 0,
        intensity: matchContext.pitch || 'Medium',
        noBallRisk: player.noBallRisk,
        injuryRisk: player.injuryRisk,
      });
      return {
        strainIndex: 0,
        fatigue: nextFatigue,
      };
    });
  };
  const overStr = ballsToOvers(ballsBowled);
  const currentOverDisplay = (() => {
    const wholeOvers = Math.floor(ballsBowled / 6);
    const ballPart = ballsBowled % 6;
    return ballPart === 0 ? String(wholeOvers) : `${wholeOvers}.${ballPart}`;
  })();
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
  const copilotSuggestedQuestions = useMemo(
    () => [
      'How do we lower no-ball risk immediately?',
      'Safest plan for next over?',
      'Plan the next 2 overs',
      'Compare Archer vs Starc next 2 overs with fatigue trend',
    ],
    []
  );
  const selectedBatterForCopilot = useMemo(() => {
    if (activePlayer && (telemetryView === 'batting' || isBattingRole(activePlayer.role))) {
      return activePlayer.name;
    }
    const candidate = rosterPlayers.find((player) =>
      isBattingRole(player.role)
      && resolveDismissalStatus(player) !== 'OUT'
      && !player.isSub
      && !player.isUnfit
    );
    return candidate?.name || '';
  }, [activePlayer, rosterPlayers, telemetryView]);
  const selectedBowlerForCopilot = useMemo(() => {
    if (activePlayer && (telemetryView === 'bowling' || isBowlingRole(activePlayer.role))) {
      return activePlayer.name;
    }
    const candidate = rosterPlayers.find((player) =>
      isBowlingRole(player.role)
      && !player.isSub
      && !player.isUnfit
    );
    return candidate?.name || '';
  }, [activePlayer, rosterPlayers, telemetryView]);
  const copilotRosterMetrics = useMemo(
    () =>
      rosterPlayers.map((player) => ({
        id: String(player.id || ''),
        name: String(player.name || ''),
        role: String(player.role || ''),
        inRoster: player.inRoster !== false,
        active: Boolean(player.id && activePlayer?.id === player.id),
        fatigueIndex: safeNum(player.fatigue, 0),
        strainIndex: safeNum(player.strainIndex, 0),
        fatigueLimit: safeNum(player.baselineFatigue, 6),
        sleepHours: safeNum(player.sleepHours, 7),
        recoveryMinutes: safeNum(player.recoveryTime, 45),
        heartRateRecovery: String(player.hrRecovery || 'Moderate'),
        injuryRisk: String(player.injuryRisk || 'Low').toUpperCase(),
        noBallRisk: String(player.noBallRisk || 'Low').toUpperCase(),
        control: safeNum(player.controlBaseline, 75),
        speed: safeNum(player.speed, 7),
        power: safeNum(player.power, 6),
        oversBowled: safeNum(player.overs, 0),
        maxOvers: safeNum((player as Player & { maxOvers?: number }).maxOvers, getMaxOvers(matchContext.format)),
        isSub: Boolean(player.isSub),
        isUnfit: Boolean(player.isUnfit || player.isManuallyUnfit || player.isInjured),
        isInjured: Boolean(player.isInjured),
      })),
    [activePlayer?.id, matchContext.format, rosterPlayers]
  );
  const copilotFallbackContext = useMemo(
    () => ({
      matchContextSnapshot: {
        telemetry: {
          playerId: String(activePlayer?.id || currentTelemetry.playerId || ''),
          playerName: String(activePlayer?.name || currentTelemetry.playerName || ''),
          role: String(activePlayer?.role || currentTelemetry.role || ''),
          fatigueIndex: safeNum(activePlayer?.fatigue, currentTelemetry.fatigueIndex),
          strainIndex: safeNum(activePlayer?.strainIndex, currentTelemetry.strainIndex),
          injuryRisk: String(activePlayer?.injuryRisk || 'Low').toUpperCase(),
          noBallRisk: String(activePlayer?.noBallRisk || 'Low').toUpperCase(),
          oversBowled: safeNum(activePlayer?.overs, 0),
          heartRateRecovery: String(activePlayer?.hrRecovery || 'Good'),
        },
        matchContext: {
          matchMode: matchContext.matchMode,
          format: matchContext.format,
          phase: matchContext.phase,
          score: matchState.runs,
          scoreRuns: matchState.runs,
          wickets: matchState.wickets,
          wicketsInHand: Math.max(0, 10 - safeNum(matchState.wickets, 0)),
          overs: formatOverStr(matchState.ballsBowled),
          ballsBowled: matchState.ballsBowled,
          totalOvers: matchState.totalOvers,
          target: typeof matchState.target === 'number' ? matchState.target : undefined,
          currentSituation: typeof matchState.target === 'number' ? 'chasing' : 'setting',
          intensity: matchContext.pitch,
          weather: matchContext.weather,
          oversRemaining: Number((Math.max(0, totalBallsFromOvers(matchState.totalOvers) - Math.max(0, matchState.ballsBowled)) / 6).toFixed(1)),
          ballsRemaining: Math.max(0, totalBallsFromOvers(matchState.totalOvers) - Math.max(0, matchState.ballsBowled)),
          currentRunRate,
          requiredRunRate,
          pressure: pressureIndex,
        },
        players: {
          selectedBatter: selectedBatterForCopilot || undefined,
          selectedBowler: selectedBowlerForCopilot || undefined,
          striker: selectedBatterForCopilot || undefined,
          bowler: selectedBowlerForCopilot || String(activePlayer?.name || currentTelemetry.playerName || ''),
          bench: rosterPlayers.map((player) => player.name).slice(0, 8),
          rosterMetrics: copilotRosterMetrics,
        },
      },
      telemetry: {
        playerId: String(activePlayer?.id || currentTelemetry.playerId || ''),
        playerName: String(activePlayer?.name || currentTelemetry.playerName || ''),
        role: String(activePlayer?.role || currentTelemetry.role || ''),
        fatigueIndex: safeNum(activePlayer?.fatigue, currentTelemetry.fatigueIndex),
        strainIndex: safeNum(activePlayer?.strainIndex, currentTelemetry.strainIndex),
        injuryRisk: String(activePlayer?.injuryRisk || 'Low').toUpperCase(),
        noBallRisk: String(activePlayer?.noBallRisk || 'Low').toUpperCase(),
        oversBowled: safeNum(activePlayer?.overs, 0),
      },
      matchContext: {
        matchMode: matchContext.matchMode,
        format: matchContext.format,
        phase: matchContext.phase,
        score: matchState.runs,
        scoreRuns: matchState.runs,
        wickets: matchState.wickets,
        wicketsInHand: Math.max(0, 10 - safeNum(matchState.wickets, 0)),
        overs: formatOverStr(matchState.ballsBowled),
        ballsBowled: matchState.ballsBowled,
        totalOvers: matchState.totalOvers,
        target: typeof matchState.target === 'number' ? matchState.target : undefined,
        currentSituation: typeof matchState.target === 'number' ? 'chasing' : 'setting',
        intensity: matchContext.pitch,
        weather: matchContext.weather,
        currentRunRate,
        requiredRunRate,
        ballsRemaining: Math.max(0, totalBallsFromOvers(matchState.totalOvers) - Math.max(0, matchState.ballsBowled)),
        pressure: pressureIndex,
      },
      players: {
        selectedBatter: selectedBatterForCopilot || undefined,
        selectedBowler: selectedBowlerForCopilot || undefined,
        striker: selectedBatterForCopilot || undefined,
        bowler: selectedBowlerForCopilot || String(activePlayer?.name || currentTelemetry.playerName || ''),
        bench: rosterPlayers.map((player) => player.name).slice(0, 8),
        rosterMetrics: copilotRosterMetrics,
      },
      coachOutput: {
        strategicAnalysis: strategicAnalysis || combinedAnalysis || {},
        tacticalRecommendation: tacticalAnalysis || strategicAnalysis?.tacticalRecommendation || {},
        combinedDecision: combinedDecision || {},
        combinedBriefing: combinedBriefing || '',
        agentsRun: orchestrateMeta?.executedAgents || [],
        usedFallbackAgents: orchestrateMeta?.usedFallbackAgents || [],
        routingMode: orchestrateMeta?.routingMode || '',
        llmMode: orchestrateMeta?.llmMode || '',
        agentStatuses: {
          fatigue: agentFeedStatus.fatigue,
          risk: agentFeedStatus.risk,
          tactical: agentFeedStatus.tactical,
        },
      },
    }),
    [
      activePlayer?.fatigue,
      activePlayer?.hrRecovery,
      activePlayer?.id,
      activePlayer?.injuryRisk,
      activePlayer?.name,
      activePlayer?.noBallRisk,
      activePlayer?.overs,
      activePlayer?.role,
      activePlayer?.strainIndex,
      copilotRosterMetrics,
      combinedAnalysis,
      combinedBriefing,
      combinedDecision,
      currentRunRate,
      currentTelemetry.fatigueIndex,
      currentTelemetry.playerId,
      currentTelemetry.playerName,
      currentTelemetry.role,
      currentTelemetry.strainIndex,
      matchContext.weather,
      orchestrateMeta?.executedAgents,
      orchestrateMeta?.llmMode,
      orchestrateMeta?.routingMode,
      orchestrateMeta?.usedFallbackAgents,
      matchContext.format,
      matchContext.matchMode,
      matchContext.phase,
      matchContext.pitch,
      matchState.ballsBowled,
      matchState.runs,
      matchState.target,
      matchState.totalOvers,
      matchState.wickets,
      pressureIndex,
      requiredRunRate,
      rosterPlayers,
      selectedBatterForCopilot,
      selectedBowlerForCopilot,
      strategicAnalysis,
      tacticalAnalysis,
      agentFeedStatus.fatigue,
      agentFeedStatus.risk,
      agentFeedStatus.tactical,
    ]
  );
  const metaCopilotAnalysisId = useMemo(() => {
    const metaRecord = (orchestrateMeta && typeof orchestrateMeta === 'object'
      ? (orchestrateMeta as unknown as Record<string, unknown>)
      : null);
    return String(metaRecord?.analysisId || '').trim();
  }, [orchestrateMeta]);
  const effectiveCopilotAnalysisId = useMemo(() => {
    const candidates = [metaCopilotAnalysisId, copilotVerifiedAnalysisId];
    for (const candidate of candidates) {
      const value = String(candidate || '').trim();
      if (value.length > 0) return value;
    }
    return '';
  }, [copilotVerifiedAnalysisId, metaCopilotAnalysisId]);
  const copilotAnalysisReady = effectiveCopilotAnalysisId.length > 0;
  const copilotResetKey = `${activePlayer?.id || 'none'}-${copilotResetToken}`;

  useEffect(() => {
    if (!(analysisActive || showCoachInsights)) return;
    const fromMeta = String(
      (orchestrateMeta && typeof orchestrateMeta === 'object'
        ? (orchestrateMeta as unknown as Record<string, unknown>).analysisId
        : '') ||
      ''
    ).trim();
    if (fromMeta.length > 0) {
      setCopilotSessionAnalysisId((prev) => (prev === fromMeta ? prev : fromMeta));
      setCopilotVerifiedAnalysisId((prev) => (prev === fromMeta ? prev : fromMeta));
      return;
    }
    const generatedId =
      `local-${String(activePlayer?.name || activePlayer?.id || 'session')
        .trim()
        .replace(/\s+/g, '-')
        .toLowerCase() || 'session'}-${Date.now()}`;
    console.warn('[copilot] meta analysis id missing in dashboard state; using generated local id', {
      analysisId: generatedId,
    });
    setCopilotSessionAnalysisId((prev) => prev || generatedId);
    setCopilotVerifiedAnalysisId((prev) => prev || generatedId);
  }, [analysisActive, orchestrateMeta, showCoachInsights, activePlayer?.id, activePlayer?.name]);

  useEffect(() => {
    const candidateId = String(copilotSessionAnalysisId || '').trim();
    if (!candidateId) {
      setCopilotVerifiedAnalysisId('');
      return;
    }
    if (candidateId === metaCopilotAnalysisId) {
      setCopilotVerifiedAnalysisId(candidateId);
      return;
    }
    // Keep locally cached analysis id without probing /api/analysis/:id/exists.
    // Azure Functions backend does not expose that endpoint.
    setCopilotVerifiedAnalysisId(candidateId);
  }, [copilotSessionAnalysisId, metaCopilotAnalysisId]);

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    console.log('[copilot][gate]', {
      analysisActive,
      showCoachInsights,
      telemetryView,
      metaCopilotAnalysisId,
      copilotVerifiedAnalysisId,
      effectiveCopilotAnalysisId,
    });
  }, [analysisActive, showCoachInsights, telemetryView, metaCopilotAnalysisId, copilotVerifiedAnalysisId, effectiveCopilotAnalysisId]);

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
  const modelRouterForView = {
    fatigue: orchestrateMeta?.modelRouter?.fatigue || routerDecisionForView?.agents?.fatigue,
    risk: orchestrateMeta?.modelRouter?.risk || routerDecisionForView?.agents?.risk,
    tactical: orchestrateMeta?.modelRouter?.tactical || routerDecisionForView?.agents?.tactical,
  };
  const debugRouterEnabled = useMemo(() => {
    if (typeof window === 'undefined') return false;
    const params = new URLSearchParams(window.location.search || '');
    return params.get('debugRouter') === '1';
  }, []);
  const showRouterTechnicalDetails = import.meta.env.DEV || debugRouterEnabled;
  const isBackendBuildIssueText = (value: unknown): boolean =>
    /(backend modules are not ready|backend modules unavailable|backend_not_ready|npm --prefix api run build|api\/dist|cannot find module.*api\/dist|module not found.*api\/dist)/i.test(
      String(value || '')
    );
  const sanitizeRouterReason = (value: unknown): string => {
    const raw = String(value || '').replace(/\s+/g, ' ').trim();
    if (!raw) return '';
    if (isBackendBuildIssueText(raw)) {
      return 'Rules fallback (temporary backend build issue)';
    }
    if (/(disabled_by_request|not_selected_by_auto_router|not_selected|skipped)/i.test(raw)) {
      return 'Not selected for this run.';
    }
    if (/(llm_success|openai_success|ai_success|azure)/i.test(raw)) {
      return 'AI response received.';
    }
    if (/(fallback|timeout|http|5\d\d|429|invalid json|json parse|parse|failed|error)/i.test(raw)) {
      return 'Temporary issue, fallback applied.';
    }
    const withoutDangerousParens = raw.replace(
      /\(([^)]*(http|trace|stack|failed|error|npm|pnpm|yarn|node|curl|json|[\{\[])[^)]*)\)/gi,
      '(temporary issue)'
    );
    const withoutCommands = withoutDangerousParens.replace(
      /\b(npm|pnpm|yarn|node|curl)\b[^,;]*/gi,
      'temporary issue'
    );
    const withoutJson = withoutCommands
      .replace(/https?:\/\/\S+/gi, '')
      .replace(/[\{\}\[\]`]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    return withoutJson.length > 88 ? `${withoutJson.slice(0, 87).trim()}…` : withoutJson;
  };
  const routerSelectedAgents = (() => {
    const rawAgents =
      routerDecisionForView?.selectedAgents && routerDecisionForView.selectedAgents.length > 0
        ? routerDecisionForView.selectedAgents
        : (routerDecisionForView?.agentsToRun || []);
    const normalized: Array<'fatigue' | 'risk' | 'tactical'> = [];
    rawAgents.forEach((agent) => {
      const key = toAgentKey(agent);
      if (!key || normalized.includes(key)) return;
      normalized.push(key);
    });
    return normalized;
  })();
  const orchestratorExecutedAgents = (() => {
    const source = Array.isArray(orchestrateMeta?.executedAgents) ? orchestrateMeta.executedAgents : [];
    const normalized: Array<'fatigue' | 'risk' | 'tactical'> = [];
    source.forEach((agent) => {
      const key = toAgentKey(agent);
      if (!key || normalized.includes(key)) return;
      normalized.push(key);
    });
    return normalized;
  })();
  const statusSelectedAgents = AGENT_KEYS.filter((agent) => {
    const status = agentFeedStatus[agent];
    return status !== 'IDLE' && status !== 'SKIPPED';
  });
  const fallbackSelectedAgents = Array.from(
    new Set<('fatigue' | 'risk' | 'tactical')>([
      ...statusSelectedAgents,
    ])
  );
  const selectedAgents: Array<'fatigue' | 'risk' | 'tactical'> =
    routerSelectedAgents.length > 0
      ? routerSelectedAgents
      : orchestratorExecutedAgents.length > 0
        ? orchestratorExecutedAgents
        : fallbackSelectedAgents.length > 0
          ? fallbackSelectedAgents
          : ['tactical'];
  const selectedAgentRoutingMeta = (() => {
    const raw = routerDecisionForView?.routingMeta;
    const rawDriver = String(raw?.dominantDriver || '').trim().toLowerCase();
    const normalizedDriver =
      rawDriver === 'fatigue' || rawDriver === 'risk' || rawDriver === 'combined' || rawDriver === 'tactical'
        ? (rawDriver as 'fatigue' | 'risk' | 'combined' | 'tactical')
        : null;
    if (!normalizedDriver) {
      return deriveRoutingMetaFromSelectedAgents(selectedAgents, runMode === 'full' ? 'full' : 'auto');
    }
    const rawMode = String(raw?.routeMode || '').trim().toLowerCase();
    return {
      routeMode: rawMode === 'full' ? ('full' as const) : ('auto' as const),
      dominantDriver: normalizedDriver,
      primaryReason: String(raw?.primaryReason || '').trim(),
      ...(String(raw?.secondaryReason || '').trim()
        ? { secondaryReason: String(raw?.secondaryReason || '').trim() }
        : {}),
    };
  })();
  const routingDriverSignalLine = (() => {
    if (runMode !== 'auto') return '';
    if (selectedAgentRoutingMeta.dominantDriver === 'risk') {
      return 'Routing focus: safety and strain exposure are the primary driver for this run.';
    }
    if (selectedAgentRoutingMeta.dominantDriver === 'fatigue') {
      return 'Routing focus: fatigue and workload accumulation are the primary driver for this run.';
    }
    return '';
  })();
  const selectedAgentSet = new Set(selectedAgents);
  const formatAgentList = (agents: AgentKey[]): string => {
    const labels = agents.map((agent) => {
      if (agent === 'fatigue') return 'Fatigue';
      if (agent === 'risk') return 'Risk';
      return 'Tactical';
    });
    if (labels.length === 0) return 'None';
    if (labels.length === 1) return `${labels[0]} only`;
    return labels.join(' + ');
  };
  const routerDetailRows = (['fatigue', 'risk', 'tactical'] as const).map((agent) => {
    const entry = modelRouterForView[agent];
    const status = agentFeedStatus[agent];
    const engaged = selectedAgentSet.has(agent) || status === 'RUNNING';
    const routedTo: 'llm' | 'rules' = entry?.routedTo
      ? entry.routedTo
      : status === 'FALLBACK' || status === 'SKIPPED'
        ? 'rules'
        : 'llm';
    const reason = sanitizeRouterReason(
      String(entry?.reason || '').trim() || (!engaged ? 'not_selected_by_auto_router' : '')
    );
    const statusLabel =
      status === 'SUCCESS'
        ? 'Success'
        : status === 'FALLBACK'
          ? 'Fallback'
          : status === 'RUNNING'
            ? 'Running'
            : status === 'SKIPPED'
              ? 'Skipped'
              : status === 'ERROR'
                ? 'Error'
                : 'Idle';
    const routeLabel = routedTo === 'llm' ? 'AI' : 'Rules';
    return {
      agent,
      engaged,
      routedTo,
      statusLabel,
      routeLabel,
      reason,
      backendBuildIssue: isBackendBuildIssueText(entry?.reason || ''),
    };
  });
  const routerStatusHint = (() => {
    const engagedRows = routerDetailRows.filter((row) => row.engaged);
    if (engagedRows.length === 0) return null;
    const isFullMode = runMode === 'full';
    const hasBackendBuildIssue = engagedRows.some((row) => row.backendBuildIssue);
    const hasSkipped = routerDetailRows.some((row) => row.statusLabel === 'Skipped');
    const allRules = engagedRows.every((row) => row.routedTo === 'rules');
    const anyRules = engagedRows.some((row) => row.routedTo === 'rules');
    const allAi = engagedRows.every((row) => row.routedTo === 'llm');
    if (hasBackendBuildIssue) {
      return {
        label: 'Rules fallback (temporary backend build issue)',
        toneClass: 'border-slate-500/35 text-slate-200 bg-slate-500/10',
        dotClass: 'bg-slate-300',
        engagedLine: `Agents engaged: ${formatAgentList(engagedRows.map((row) => row.agent))}`,
      };
    }
    if (allRules) {
      return {
        label: isFullMode ? 'Full Analysis: Fallback' : 'Routing: Rules fallback',
        toneClass: 'border-slate-500/35 text-slate-200 bg-slate-500/10',
        dotClass: 'bg-slate-300',
        engagedLine: `Agents engaged: ${formatAgentList(engagedRows.map((row) => row.agent))}`,
      };
    }
    if (allAi && !hasSkipped && !anyRules) {
      return {
        label: isFullMode ? 'Full Analysis: AI' : 'Routing: AI',
        toneClass: 'border-emerald-500/35 text-emerald-200 bg-emerald-500/10',
        dotClass: 'bg-emerald-400',
        engagedLine: `Agents engaged: ${formatAgentList(engagedRows.map((row) => row.agent))}`,
      };
    }
    return {
      label: isFullMode ? 'Full Analysis: Hybrid' : 'Routing: Hybrid AI',
      toneClass: 'border-amber-500/35 text-amber-200 bg-amber-500/10',
      dotClass: 'bg-amber-300',
      engagedLine: `Agents engaged: ${formatAgentList(engagedRows.map((row) => row.agent))}`,
    };
  })();
  const routerAgentChips = (['tactical', 'fatigue', 'risk'] as const).map((agent) => {
    const row = routerDetailRows.find((entry) => entry.agent === agent);
    const agentLabel = agent === 'tactical' ? 'Tactical' : agent === 'fatigue' ? 'Fatigue' : 'Risk';
    if (!row || !row.engaged) {
      return {
        key: `router-chip-${agent}`,
        label: `${agentLabel}: Skipped`,
        className: 'border-slate-700 text-slate-300 bg-slate-900/40',
      };
    }
    const isFallback = row.routedTo === 'rules' || row.statusLabel === 'Fallback' || row.statusLabel === 'Error';
    if (isFallback) {
      return {
        key: `router-chip-${agent}`,
        label: `${agentLabel}: Fallback`,
        className: 'border-amber-500/35 text-amber-200 bg-amber-500/10',
      };
    }
    return {
      key: `router-chip-${agent}`,
      label: `${agentLabel}: AI`,
      className: 'border-emerald-500/35 text-emerald-200 bg-emerald-500/10',
    };
  });
  const modelRouterLabel = 'Microsoft Foundry';
  const modelSelectedLabel = useMemo(() => {
    const sanitizeCandidate = (value: unknown): string => {
      const token = String(value || '').trim();
      if (!token) return '';
      const lowered = token.toLowerCase();
      if (lowered === 'llm' || lowered === 'ai') return '';
      if (lowered === 'skipped') return '';
      if (lowered.includes('rules') || lowered.includes('fallback')) return '';
      return token;
    };
    const metaRecord = toRecord(orchestrateMeta as unknown);
    const modelRoutingRecord = toRecord(metaRecord.modelRouting);
    const routerDecisionRecord = toRecord(routerDecisionForView as unknown);
    const candidateValues: unknown[] = [
      metaRecord.modelSelected,
      metaRecord.selectedModel,
      metaRecord.model,
      toRecord(metaRecord.modelInfo).selected,
      toRecord(metaRecord.modelInfo).name,
      toRecord(metaRecord.aoai).model,
      toRecord(metaRecord.aoai).deployment,
      modelRoutingRecord.model,
      modelRoutingRecord.selectedModel,
      modelRoutingRecord.deployment,
      modelRoutingRecord.tacticalModel,
      modelRoutingRecord.fatigueModel,
      modelRoutingRecord.riskModel,
      toRecord(routerDecisionRecord.meta).model,
      toRecord(routerDecisionRecord.meta).deployment,
    ];
    for (const candidate of candidateValues) {
      const sanitized = sanitizeCandidate(candidate);
      if (!sanitized) continue;
      if (/gpt[-\s]?5/i.test(sanitized)) return 'GPT-5-mini';
      return sanitized;
    }
    return 'GPT-5-mini';
  }, [orchestrateMeta, routerDecisionForView]);
  const routerDiagnosticsModeLabel = useMemo(() => {
    const routingToken = String(orchestrateMeta?.routingMode || '').trim().toLowerCase();
    if (routingToken === 'fallback') return 'Fallback';
    if (routingToken === 'demo') return 'Demo';
    const modeToken = String(orchestrateMeta?.mode || runMode || '').trim().toLowerCase();
    if (modeToken === 'full') return 'Full';
    return 'Balanced';
  }, [orchestrateMeta?.mode, orchestrateMeta?.routingMode, runMode]);
  const routerNarrative =
    sanitizeRouterReason(routerDecisionForView?.rationale || routerDecisionForView?.reason || '') ||
    'Decision selected from current match signals.';
  const combinedAnalysisActive = Boolean(
    showCoachInsights || analysisActive || analysisExecuted || fullAnalysisRunPending || fullAnalysisExecuted
  );
  const isCoachOutputState = !isCoachPanelSuppressedForSelection && combinedAnalysisActive;
  const shouldShowTelemetryGraph = combinedAnalysisActive;
  const isFullAnalysis = runMode === 'full';
  const analysisRunModeLine = (() => {
    if (!isFullAnalysis) return '';
    const modeToken = String(orchestrateMeta?.routingMode || '').trim().toLowerCase();
    if (!modeToken) return '';
    const fallbackReason = sanitizeRouterReason(orchestrateMeta?.fallbackReason || orchestrateMeta?.routerFallbackMessage || '');
    const azureAttempted =
      typeof orchestrateMeta?.azureAttempted === 'boolean'
        ? orchestrateMeta.azureAttempted
        : String(orchestrateMeta?.llmMode || '').trim().toLowerCase() === 'ai';
    if (modeToken === 'fallback') {
      return `Full analysis ran in fallback mode (${fallbackReason || 'upstream_unavailable'}). Azure attempted: ${azureAttempted ? 'yes' : 'no'}.`;
    }
    return 'Full analysis ran with AI.';
  })();
  const analysisAgentFailureLine = (() => {
    if (!isFullAnalysis) return '';
    const failureRecord = toRecord(orchestrateMeta?.agentAiFailures as unknown);
    const entries = (['fatigue', 'risk', 'tactical'] as const)
      .map((agent) => {
        const reason = sanitizeRouterReason(failureRecord[agent]);
        if (!reason) return '';
        const label = agent === 'fatigue' ? 'Fatigue' : agent === 'risk' ? 'Risk' : 'Tactical';
        return `${label}: ${reason}`;
      })
      .filter(Boolean);
    if (entries.length === 0) return '';
    return `Agent AI failures: ${entries.join(' | ')}`;
  })();
  const activeStrategicAnalysis = isFullAnalysis ? combinedAnalysis : strategicAnalysis;
  const analysisBadgeLabel = isFullAnalysis ? 'FULL ANALYSIS' : 'AUTO ROUTING';
  const hasAnyAnalysis = Boolean(
    activeStrategicAnalysis || finalRecommendation || combinedDecision || tacticalAnalysis || aiAnalysis || riskAnalysis
  );
  const tacticalRecommendationSignal = Boolean(
    activeStrategicAnalysis?.tacticalRecommendation?.nextAction ||
    activeStrategicAnalysis?.tacticalRecommendation?.why ||
    tacticalAnalysis?.immediateAction ||
    tacticalAnalysis?.rationale ||
    combinedDecision?.immediateAction ||
    combinedDecision?.rationale ||
    finalRecommendation?.statement
  );
  const hasTacticalGuidance = Boolean(
    activeStrategicAnalysis?.tacticalRecommendation?.nextAction ||
    tacticalAnalysis?.immediateAction ||
    combinedDecision?.immediateAction
  );
  const hasUsableAgentOutput: Record<AgentKey, boolean> = {
    fatigue: Boolean(aiAnalysis),
    risk: Boolean(riskAnalysis),
    tactical: Boolean(
      tacticalAnalysis ||
      combinedDecision?.immediateAction ||
      activeStrategicAnalysis?.tacticalRecommendation?.nextAction ||
      activeStrategicAnalysis?.tacticalRecommendation?.why
    ),
  };
  const isAgentCompleteForCoverage = (agent: AgentKey): boolean => {
    const status = agentFeedStatus[agent];
    const completedStatus = status === 'SUCCESS' || status === 'FALLBACK';
    if (!completedStatus) return false;
    return hasUsableAgentOutput[agent];
  };
  const requiredAgentSet = new Set<AgentKey>(selectedAgents.length > 0 ? selectedAgents : ['tactical']);
  requiredAgentSet.add('tactical');
  const completedRequiredAgents = Array.from(requiredAgentSet).filter((agent) => isAgentCompleteForCoverage(agent));
  const hasCompleteAnalysis = completedRequiredAgents.length === requiredAgentSet.size;
  const hasCompleteFullCombinedAnalysis = AGENT_KEYS.every((agent) => isAgentCompleteForCoverage(agent));
  const hasPartialAnalysis = hasAnyAnalysis && completedRequiredAgents.length > 0 && !hasCompleteAnalysis;
  const hasCoachOutputText = Boolean(
    (typeof coachOutput?.summary === 'string' && coachOutput.summary.trim().length > 0) ||
    (typeof coachOutput?.tacticalRecommendation === 'string' && coachOutput.tacticalRecommendation.trim().length > 0) ||
    (typeof combinedBriefing === 'string' && combinedBriefing.trim().length > 0) ||
    (typeof finalRecommendation?.statement === 'string' && finalRecommendation.statement.trim().length > 0) ||
    (typeof tacticalAnalysis?.immediateAction === 'string' && tacticalAnalysis.immediateAction.trim().length > 0) ||
    (typeof tacticalAnalysis?.rationale === 'string' && tacticalAnalysis.rationale.trim().length > 0) ||
    (typeof activeStrategicAnalysis?.tacticalRecommendation?.nextAction === 'string' &&
      activeStrategicAnalysis.tacticalRecommendation.nextAction.trim().length > 0) ||
    (typeof activeStrategicAnalysis?.tacticalRecommendation?.why === 'string' &&
      activeStrategicAnalysis.tacticalRecommendation.why.trim().length > 0)
  );
  const hasCopilotRenderableOutput = Boolean(
    analysisBundleId.length > 0 ||
    Boolean(coachOutput) ||
    hasCoachOutputText
  );
  const hasCopilotActivationSignal = Boolean(
    hasCopilotRenderableOutput ||
    tacticalRecommendationSignal ||
    hasAnyAnalysis ||
    effectiveCopilotAnalysisId.length > 0 ||
    (showCoachInsights && (analysisActive || agentState === 'done' || agentState === 'offline'))
  );
  const showAnalysisFailureCard = Boolean(agentFailure && !hasAnyAnalysis && !hasTacticalGuidance);
  const showAnalysisFailureInline = Boolean(agentFailure && hasAnyAnalysis);
  const showCompactRunningState = agentState === 'thinking';
  const showAnalysisSkeleton = showCompactRunningState;
  useEffect(() => {
    if (hasCopilotActivationSignal) {
      setShowCopilotChat(true);
    }
  }, [hasCopilotActivationSignal]);
  // Keep Copilot visible whenever the analysis/forecast section is visible.
  // This avoids transient refresh states unmounting chat while the forecast remains rendered.
  useEffect(() => {
    if (!shouldShowTelemetryGraph) return;
    setShowCopilotChat(true);
  }, [shouldShowTelemetryGraph]);
  useEffect(() => {
    if (!hasCopilotActivationSignal) return;
    if (effectiveCopilotAnalysisId.length > 0) return;
    const generatedId =
      `local-${String(activePlayer?.name || activePlayer?.id || 'coach')
        .trim()
        .replace(/\s+/g, '-')
        .toLowerCase() || 'coach'}-${Date.now()}`;
    console.warn('[copilot] missing analysis id after coach completion; using generated local id', {
      analysisId: generatedId,
    });
    setCopilotSessionAnalysisId((prev) => prev || generatedId);
    setCopilotVerifiedAnalysisId((prev) => prev || generatedId);
  }, [hasCopilotActivationSignal, effectiveCopilotAnalysisId, activePlayer?.id, activePlayer?.name]);
  const shouldRenderCopilotUnderGraph = shouldShowTelemetryGraph;
  useEffect(() => {
    if (!hasCopilotActivationSignal || !showCopilotChat) return;
    if (shouldRenderCopilotUnderGraph) return;
    console.error('[copilot] render suppressed', {
      shouldShowTelemetryGraph,
      hasAnyAnalysis,
      analysisId: effectiveCopilotAnalysisId,
    });
  }, [hasCopilotActivationSignal, showCopilotChat, shouldRenderCopilotUnderGraph, shouldShowTelemetryGraph, hasAnyAnalysis, effectiveCopilotAnalysisId]);
  const agentStatusRows: Array<{ agent: AgentKey; label: string; state: AgentFeedState; detail: string }> = [
    { agent: 'fatigue', label: 'Fatigue Agent', state: agentFeedStatus.fatigue, detail: '' },
    { agent: 'risk', label: 'Risk Agent', state: agentFeedStatus.risk, detail: '' },
    { agent: 'tactical', label: 'Tactical Agent', state: agentFeedStatus.tactical, detail: '' },
  ].map((entry) => {
    let detail = 'Waiting to run';
    if (entry.state === 'RUNNING') detail = 'Running...';
    if (entry.state === 'SUCCESS') detail = 'Output ready';
    if (entry.state === 'FALLBACK') detail = 'Fallback output ready';
    if (entry.state === 'SKIPPED') detail = 'Skipped by router';
    if (entry.state === 'ERROR') detail = 'No output';
    if (entry.agent === 'risk' && entry.state === 'SUCCESS' && !riskAnalysis) {
      detail = 'Threshold-based output ready';
    }
    return { ...entry, detail };
  });
  const copilotRoutingHints = `${orchestrateMeta?.routerFallbackMessage || ''} ${routerDecisionForView?.reason || ''} ${orchestrateMeta?.responseMode || ''} ${orchestrateMeta?.llmMode || ''}`;
  const copilotConfigFallback = Boolean(
    !aiEnabled ||
    /(missing[_\s-]?config|azure env missing|ai_enabled=false|missing_aoai_config|llm_mode_rules|not configured)/i.test(copilotRoutingHints)
  );
  const copilotUpstreamFailure = /(openai_error|agent_http_error|openai_call_failed|ai_upstream_failed|openai_http_|llm-error:|upstream_error|status[:= ](?:401|403|429|5\d\d))/i.test(
    copilotRoutingHints
  );
  const copilotFallbackMode = Boolean(copilotConfigFallback || copilotUpstreamFailure);
  const isExplicitFallbackMode = orchestrateMeta?.responseMode === 'fallback';
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    console.log('[copilot][chat-mode]', {
      aiEnabled,
      forceFallbackMode: copilotFallbackMode,
      configFallback: copilotConfigFallback,
      upstreamFailure: copilotUpstreamFailure,
      responseMode: orchestrateMeta?.responseMode || null,
      llmMode: orchestrateMeta?.llmMode || null,
      routerReason: routerDecisionForView?.reason || null,
    });
  }, [aiEnabled, copilotConfigFallback, copilotFallbackMode, copilotUpstreamFailure, orchestrateMeta?.llmMode, orchestrateMeta?.responseMode, routerDecisionForView?.reason]);
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const analysisPayloadPresent = Boolean(hasAnyAnalysis || routerDecisionForView || orchestrateMeta);
    if (!analysisPayloadPresent) return;
    console.log('[agent-routing][ui-sync]', {
      analysisPayloadPresent,
      orchestratorSelectedAgents: routerSelectedAgents,
      orchestratorExecutedAgents,
      frontendDisplayedAgents: selectedAgents,
    });
  }, [
    hasAnyAnalysis,
    routerDecisionForView,
    orchestrateMeta,
    routerSelectedAgents.join('|'),
    orchestratorExecutedAgents.join('|'),
    selectedAgents.join('|'),
  ]);
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
    const withRoutingSignal = (items: string[]): string[] =>
      sanitizeSignals(
        routingDriverSignalLine && !items.some((entry) => entry.toLowerCase() === routingDriverSignalLine.toLowerCase())
          ? [routingDriverSignalLine, ...items]
          : items
      );

    if (Array.isArray(activeStrategicAnalysis?.signals) && activeStrategicAnalysis.signals.length > 0) {
      return withRoutingSignal(activeStrategicAnalysis.signals);
    }
    if (Array.isArray(routerDecisionForView?.signalSummaryBullets) && routerDecisionForView.signalSummaryBullets.length > 0) {
      return withRoutingSignal(routerDecisionForView.signalSummaryBullets);
    }
    if (Array.isArray((tacticalAnalysis as unknown as Record<string, unknown>)?.signalSummaryBullets)) {
      return withRoutingSignal(
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
    return withRoutingSignal(Array.from(new Set(bullets)));
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
  const isBattingNoTelemetry = (focusRole === 'BATTER' || teamMode === 'BATTING') && ballsFaced === 0;
  const fatigueTrendDisplayLabel: 'Up' | 'Down' | 'Stable' | 'Baseline' =
    isBattingNoTelemetry ? 'Baseline' : fatigueTrendLabel;
  const shortText = (value: unknown, fallback: string, maxChars = 110): string => {
    const normalized = String(value || '').replace(/\s+/g, ' ').trim();
    if (!normalized) return fallback;
    if (normalized.length <= maxChars) return normalized;
    return `${normalized.slice(0, Math.max(0, maxChars - 1)).trim()}…`;
  };
  const trimToSentenceBoundary = (value: string, maxChars: number): string => {
    const normalized = String(value || '').replace(/\s+/g, ' ').trim();
    if (!normalized || normalized.length <= maxChars) return normalized;
    const clipped = normalized.slice(0, Math.max(0, maxChars)).trim();
    const punctuationIndex = Math.max(clipped.lastIndexOf('.'), clipped.lastIndexOf('!'), clipped.lastIndexOf('?'));
    if (punctuationIndex >= Math.floor(maxChars * 0.45)) {
      return clipped.slice(0, punctuationIndex + 1).trim();
    }
    const lastSpace = clipped.lastIndexOf(' ');
    if (lastSpace >= Math.floor(maxChars * 0.55)) {
      return clipped.slice(0, lastSpace).trim();
    }
    return clipped;
  };
  const sanitizeSentenceTail = (value: string): string =>
    String(value || '')
      .replace(/(?:\.\.\.|…)+\s*$/g, '')
      .replace(/[,:;/-]\s*$/g, '')
      .replace(/\b(?:based on|instead of|if|because|while|with)\s*$/i, '')
      .replace(/\s+/g, ' ')
      .trim();
  const isIncompleteCoachSentence = (value: string): boolean => {
    const normalized = String(value || '').trim();
    if (!normalized) return true;
    if (/(?:\.\.\.|…)\s*$/.test(normalized)) return true;
    if (/\b(?:based on|instead of|if|because|while|with)\.?\s*$/i.test(normalized)) return true;
    if (/\b(?:based|instead|after|before|during|for|to|with|if|because|while|the|a|an)\.?\s*$/i.test(normalized)) return true;
    if (/[,:;/-]\.?\s*$/.test(normalized)) return true;
    if (/\b(?:to|and|or)\.?\s*$/i.test(normalized)) return true;
    return false;
  };
  const finalizeCoachSentence = (value: unknown, fallback: string, maxChars = 140): string => {
    const normalizeCandidate = (candidate: unknown): string => {
      const bounded = trimToSentenceBoundary(String(candidate || ''), maxChars);
      const cleaned = sanitizeSentenceTail(
        String(bounded || '')
          .replace(/\s+([,.;:!?])/g, '$1')
      );
      if (!cleaned) return '';
      return /[.!?]$/.test(cleaned) ? cleaned : `${cleaned}.`;
    };
    const primary = normalizeCandidate(value);
    if (primary && !isIncompleteCoachSentence(primary)) return primary;
    const fallbackText = normalizeCandidate(fallback);
    if (fallbackText && !isIncompleteCoachSentence(fallbackText)) return fallbackText;
    return 'Tactical recommendation updated.';
  };
  const dedupeBullets = (items: Array<unknown>, max = 3): string[] => {
    const seen = new Set<string>();
    const output: string[] = [];
    for (const entry of items) {
      const normalized = String(entry || '').replace(/\s+/g, ' ').trim();
      if (!normalized) continue;
      const key = normalized.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      output.push(normalized);
      if (output.length >= max) break;
    }
    return output;
  };
  const normalizeRiskBand = (value: unknown): 'LOW' | 'MED' | 'HIGH' => {
    const token = String(value || '').trim().toUpperCase();
    if (token === 'HIGH' || token === 'CRITICAL') return 'HIGH';
    if (token === 'MED' || token === 'MEDIUM') return 'MED';
    return 'LOW';
  };
  const severityToRiskLabel = (value: unknown): 'Low' | 'Medium' | 'High' => {
    const token = String(value || '').trim().toUpperCase();
    if (token === 'HIGH' || token === 'CRITICAL') return 'High';
    if (token === 'MED' || token === 'MEDIUM') return 'Medium';
    return 'Low';
  };
  const extractSectionValue = (text: string, sectionLabel: string): string => {
    const pattern = new RegExp(`${sectionLabel}:\\s*([^\\n]+)`, 'i');
    const match = text.match(pattern);
    return match ? String(match[1] || '').trim() : '';
  };
  const parseConfidenceLabel = (text: string): 'Low' | 'Medium' | 'High' | null => {
    const match = text.match(/Confidence:\s*(Low|Med|Medium|High)/i);
    if (!match) return null;
    const token = String(match[1] || '').trim().toLowerCase();
    if (token === 'high') return 'High';
    if (token === 'med' || token === 'medium') return 'Medium';
    return 'Low';
  };
  const rosterNameLookup = new Map(
    players.flatMap((player) => {
      const idToken = String(player.id || '').trim().toLowerCase();
      const nameToken = String(player.name || '').trim().toLowerCase();
      return [
        [idToken, player.name],
        [nameToken, player.name],
      ] as Array<[string, string]>;
    })
  );
  const normalizeRecommendationText = (value: unknown): string =>
    String(value || '').replace(/\s+/g, ' ').trim();
  const isInitialOnlyName = (value: unknown): boolean => {
    const normalized = normalizeRecommendationText(value);
    if (!normalized) return true;
    const segments = normalized.split(' ').filter(Boolean);
    return segments.length > 0 && segments.every((segment) => /^[A-Za-z]\.?$/.test(segment));
  };
  const resolveRosterName = (value: unknown, fallback = ''): string => {
    const token = normalizeRecommendationText(value);
    if (!token) return normalizeRecommendationText(fallback);
    const resolved = rosterNameLookup.get(token.toLowerCase()) || token;
    if (isInitialOnlyName(resolved)) return normalizeRecommendationText(fallback);
    return resolved;
  };
  const formatFatigueCopy = (
    inputTelemetry: {
      role: string;
      fatigueIndex: number;
      strainIndex: number;
      ballsFaced: number;
      injuryRisk: 'LOW' | 'MED' | 'HIGH';
      noBallRisk: 'LOW' | 'MED' | 'HIGH';
      trend: 'Up' | 'Down' | 'Stable';
      matchPhase: string;
    },
    baseline: { recoveryMinutes?: number }
  ): {
    title: string;
    bullets: string[];
    nextOverRiskLabel: 'Low' | 'Medium' | 'High' | 'None';
  } => {
    const roleToken = String(inputTelemetry.role || '').toLowerCase();
    const isBowler = roleToken.includes('bowl') || roleToken.includes('spin') || roleToken.includes('fast');
    const isBattingContext =
      String(teamMode || '').toUpperCase() === 'BATTING' ||
      (roleToken.includes('bat') && !isBowler);
    const battingBallsFaced = Math.max(0, safeNum(inputTelemetry.ballsFaced, 0));
    if (isBattingContext && battingBallsFaced === 0) {
      return {
        title: 'Batting workload has not started.',
        bullets: [
          'No batting workload recorded yet.',
          'Player is currently at baseline readiness.',
          'Fatigue evaluation will begin once batting workload starts.',
        ],
        nextOverRiskLabel: 'None',
      };
    }
    const highLoad = inputTelemetry.fatigueIndex >= 7 || inputTelemetry.strainIndex >= 4;
    const elevatedLoad = inputTelemetry.fatigueIndex >= 5.8 || inputTelemetry.strainIndex >= 2.8;
    const poorRecovery = Number.isFinite(Number(baseline.recoveryMinutes)) && Number(baseline.recoveryMinutes) < 35;
    const riskLabel: 'Low' | 'Medium' | 'High' =
      inputTelemetry.injuryRisk === 'HIGH' || inputTelemetry.noBallRisk === 'HIGH' || highLoad
        ? 'High'
        : inputTelemetry.injuryRisk === 'MED' || inputTelemetry.noBallRisk === 'MED' || elevatedLoad
          ? 'Medium'
          : 'Low';
    const title = isBattingContext
      ? riskLabel === 'High'
        ? 'Batting workload trend is elevated.'
        : riskLabel === 'Medium'
          ? 'Batting workload trend is manageable.'
          : 'Stable workload trend.'
      : riskLabel === 'High'
        ? 'Control may dip next over'
        : riskLabel === 'Medium'
          ? 'Stable for now — watch late spell'
          : inputTelemetry.trend === 'Up'
            ? 'Stable now — monitor workload trend'
            : 'Stable for now — keep rhythm tight';
    const phaseToken = String(inputTelemetry.matchPhase || '').toLowerCase();
    const nextOverMeaning =
      phaseToken.includes('death')
        ? 'In the death phase, execution can fade quickly over the next two overs if load is not managed.'
        : phaseToken.includes('middle')
          ? 'Across the next over or two, rhythm can flatten and control errors usually increase.'
          : 'In this phase, overextending now can reduce sharpness before the spell settles.';
    const happening =
      isBowler
        ? 'Workload is accumulating and bowling execution is beginning to soften, especially on pace, length control, and no-ball discipline.'
        : 'Workload is accumulating and movement sharpness is beginning to fade, affecting timing and control.';
    const action =
      riskLabel === 'High'
        ? 'Rotate or shorten the spell now, use a micro-rest, and return with a control-first plan.'
        : riskLabel === 'Medium'
          ? 'Trim the next spell segment, add a short reset, and keep the tactical plan conservative.'
          : 'Continue for one controlled over, apply a micro-reset, and reassess before extending.';
    const battingReassessmentWindow =
      riskLabel === 'High' ? '~4-6' : riskLabel === 'Medium' ? '~6-8' : '~8-10';
    const battingBaselineLine =
      riskLabel === 'High'
        ? 'Batting workload is above baseline tolerance.'
        : riskLabel === 'Medium'
          ? 'Batting workload is approaching baseline tolerance.'
          : 'Batting workload remains within baseline tolerance.';
    const battingStabilityLine =
      riskLabel === 'High'
        ? 'Reaction stability is declining, and timing precision can drop quickly if exertion stays high.'
        : 'Reaction stability is slightly declining as workload accumulates, and timing precision may begin dropping if exertion continues.';
    const battingReassessmentLine = `Reassessment recommended in ${battingReassessmentWindow} balls if exertion continues.`;
    const recoveryNote = poorRecovery ? 'Recovery quality is limited, so avoid extending this spell aggressively.' : '';
    return {
      title,
      bullets: isBattingContext
        ? dedupeBullets([battingBaselineLine, battingStabilityLine, battingReassessmentLine], 3)
        : dedupeBullets([happening, nextOverMeaning, action, recoveryNote], 3),
      nextOverRiskLabel: riskLabel,
    };
  };
  const formatInjuryCopy = (
    inputTelemetry: {
      playerName: string;
      role: string;
      injuryRisk: 'LOW' | 'MED' | 'HIGH';
      noBallRisk: 'LOW' | 'MED' | 'HIGH';
      strainIndex: number;
      fatigueIndex: number;
      matchPhase: string;
      recoveryTrend: 'stable' | 'declining' | 'poor';
    },
    baseline: { recoveryMinutes?: number },
    existingReport: { explanation?: string; recommendation?: string; severity?: string; signals?: string[] }
  ): {
    title: string;
    likelyInjury: string;
    bullets: string[];
    riskDriver: string;
    confidenceLabel: 'Low' | 'Medium' | 'High';
  } => {
    const roleToken = String(inputTelemetry.role || '').toLowerCase();
    const isFast = roleToken.includes('fast');
    const isSpinner = roleToken.includes('spin');
    const isBatter = roleToken.includes('bat');
    const isAllRounder = roleToken.includes('all-rounder') || roleToken.includes('all rounder');
    const phaseToken = String(inputTelemetry.matchPhase || '').toLowerCase();
    const severityLabel = severityToRiskLabel(existingReport.severity || inputTelemetry.injuryRisk);
    const structuredText = `${existingReport.explanation || ''}\n${existingReport.recommendation || ''}`;
    const parsedPrimaryRisk = extractSectionValue(structuredText, 'Primary Risk Type');
    const likelyInjury =
      severityLabel === 'Low'
        ? 'No immediate injury threat detected'
        : parsedPrimaryRisk ||
          (isFast
            ? inputTelemetry.noBallRisk === 'HIGH' || phaseToken.includes('death')
              ? 'Groin strain'
              : 'Lower back stress'
            : isSpinner
              ? 'Shoulder overload'
              : isAllRounder
                ? 'Hamstring tightness'
                : isBatter
                  ? 'Calf/Achilles risk'
                  : 'Lower back stress');
    const lowRecovery = Number.isFinite(Number(baseline.recoveryMinutes)) && Number(baseline.recoveryMinutes) < 35;
    const trigger =
      severityLabel === 'Low'
        ? 'Primary trigger is controlled workload with acceptable recovery, but keep monitoring cumulative stress.'
        : lowRecovery || inputTelemetry.recoveryTrend !== 'stable'
          ? 'Primary trigger is overload building against reduced recovery between efforts.'
          : 'Primary trigger is cumulative spell load with rising strain through the phase.';
    const warningSign =
      isBatter
        ? 'Watch for heavy first movement, late transfer, or visible discomfort between runs.'
        : 'Watch for slower run-up, loss of rhythm, grimacing, or a sudden drop in control.';
    const prevention =
      severityLabel === 'High'
        ? 'Rotate now, reduce intensity on return, and avoid back-to-back overs in the next spell.'
        : severityLabel === 'Medium'
          ? 'Plan proactive rotation, avoid consecutive overs, and lengthen recovery before the next spell.'
          : 'Continue with monitoring and avoid sudden workload spikes in the next two overs.';
    const riskDriver =
      severityLabel === 'Low'
        ? 'Driver: managed load + acceptable recovery'
        : lowRecovery || inputTelemetry.recoveryTrend !== 'stable'
          ? 'Driver: overload + reduced recovery'
          : inputTelemetry.noBallRisk !== 'LOW'
            ? 'Driver: control drift + cumulative load'
            : 'Driver: cumulative load + phase pressure';
    const parsedConfidence = parseConfidenceLabel(structuredText);
    const confidenceLabel: 'Low' | 'Medium' | 'High' =
      parsedConfidence ||
      (severityLabel === 'High' ? 'High' : severityLabel === 'Medium' ? 'Medium' : 'Low');
    return {
      title: severityLabel === 'High' ? 'Injury exposure needs immediate prevention' : 'Injury exposure can be managed with proactive control',
      likelyInjury,
      bullets: dedupeBullets([trigger, warningSign, prevention], 3),
      riskDriver,
      confidenceLabel,
    };
  };
  const fatigueCoachCopy = formatFatigueCopy(
    {
      role: String(activePlayer?.role || currentTelemetry.role || ''),
      fatigueIndex: safeNum(activePlayer?.fatigue, currentTelemetry.fatigueIndex),
      strainIndex: clampedStrainIndex,
      ballsFaced,
      injuryRisk: normalizeRiskBand(activePlayer?.injuryRisk || riskAnalysis?.injuryRisk),
      noBallRisk: normalizeRiskBand(activePlayer?.noBallRisk || riskAnalysis?.noBallRisk),
      trend: fatigueTrendLabel,
      matchPhase: String(matchContext.phase || ''),
    },
    {
      recoveryMinutes: activePlayer?.recoveryTime,
    }
  );
  const injuryCoachCopy = formatInjuryCopy(
    {
      playerName: String(activePlayer?.name || currentTelemetry.playerName || 'Current player'),
      role: String(activePlayer?.role || currentTelemetry.role || ''),
      injuryRisk: normalizeRiskBand(activePlayer?.injuryRisk || riskAnalysis?.injuryRisk),
      noBallRisk: normalizeRiskBand(activePlayer?.noBallRisk || riskAnalysis?.noBallRisk),
      strainIndex: clampedStrainIndex,
      fatigueIndex: safeNum(activePlayer?.fatigue, currentTelemetry.fatigueIndex),
      matchPhase: String(matchContext.phase || ''),
      recoveryTrend:
        String(activePlayer?.hrRecovery || '').toLowerCase() === 'poor'
          ? 'poor'
          : String(activePlayer?.hrRecovery || '').toLowerCase() === 'moderate'
            ? 'declining'
            : 'stable',
    },
    {
      recoveryMinutes: activePlayer?.recoveryTime,
    },
    {
      explanation: riskAnalysis?.explanation,
      recommendation: riskAnalysis?.recommendation,
      severity: riskAnalysis?.severity,
      signals: riskAnalysis?.signals,
    }
  );
  const formatTacticalRecommendation = (
    inputMatchContext: MatchContext,
    telemetry: {
      playerId: string;
      playerName: string;
      fatigueIndex: number;
      strainIndex: number;
      oversBowled: number;
      injuryRisk: string;
      noBallRisk: string;
    },
    baseline: {
      sleepHours?: number;
      recoveryMinutes?: number;
      fatigueLimit?: number;
      baselineToday?: number;
    },
    roster: Player[]
  ): {
    matchSituation: [string, string?];
    assessment: [string, string?];
    recommendedMove: string;
    whyThisIsSmart: string[];
    ifYouIgnore: string;
    confidence: 'Low' | 'Moderate' | 'High';
    priority: 'Stable' | 'Monitor' | 'Immediate';
    availabilityStatus: 'AVAILABLE' | 'LIMITED' | 'TACTICAL_RISK' | 'UNAVAILABLE';
    dominantRiskDriver:
      | 'overs_quota_reached'
      | 'injury'
      | 'fatigue'
      | 'recovery'
      | 'control'
      | 'matchup'
      | 'pressure_phase'
      | 'mixed';
    decisionMode:
      | 'IMMEDIATE_SUBSTITUTION'
      | 'ROTATE_NEXT_OVER'
      | 'SHORTEN_SPELL'
      | 'KEEP_BOWLING_WITH_ADJUSTMENT'
      | 'MATCHUP_CHANGE'
      | 'RECOVERY_ONLY'
      | 'KEEP_BATTING'
      | 'KEEP_BATTING_WITH_ADJUSTMENT'
      | 'ROTATE_STRIKE'
      | 'ATTACK_SPIN'
      | 'STABILIZE_INNINGS'
      | 'ROLE_CONTEXT_MISMATCH';
    substitutionRequired: boolean;
    primaryPlayerName: string;
    recommendedReplacement: string;
    swap: { out: string; in: string; reason: string };
    suggestedBenchOptions: Array<{ name: string; roleTag: string; reason: string }>;
  } => {
    const roleToken = (value: unknown): string => String(value || '').trim().toLowerCase();
    const resolvePlayerTypeTag = (role: unknown): 'PACE' | 'SPIN' | 'ALL_ROUND' | 'BATTER' | 'BOWLER' => {
      const token = roleToken(role);
      if (token.includes('spin')) return 'SPIN';
      if (token.includes('fast') || token.includes('pace') || token.includes('seam')) return 'PACE';
      if (token.includes('all-round')) return 'ALL_ROUND';
      if (token.includes('bat')) return 'BATTER';
      return 'BOWLER';
    };
    const isBowlingCompatible = (role: unknown): boolean => {
      const token = roleToken(role);
      return token.includes('bowler') || token.includes('spinner') || token.includes('fast') || token.includes('all-rounder');
    };
    const sanitizeCoachLine = (value: unknown, fallback: string, maxChars = 110): string =>
      finalizeCoachSentence(
        normalizeRecommendationText(value)
          .replace(/\b([a-z]+)(?:\s*,\s*\1\b)+/gi, '$1')
          .replace(/\b([a-z]+)(?:\s+\1\b){1,}/gi, '$1')
          .replace(/\s+/g, ' ')
          .replace(/\s+([,.;:!?])/g, '$1')
          .trim(),
        fallback,
        maxChars
      );
    const toConfidenceLabel = (score: number): 'Low' | 'Moderate' | 'High' =>
      score >= 0.75 ? 'High' : score >= 0.5 ? 'Moderate' : 'Low';
    const modeLabel = String(inputMatchContext.matchMode || teamMode || 'BOWLING').toUpperCase();
    const formatLabel = normalizeRecommendationText(inputMatchContext.format || 'T20') || 'T20';
    const targetRuns = Number.isFinite(matchState.target) ? Math.max(0, Number(matchState.target)) : null;
    const inningsOversLimit = Math.max(
      1,
      safeNum(getInningsTotalOvers(inputMatchContext.format), safeNum(matchState.totalOvers, getMaxOvers(inputMatchContext.format)))
    );
    const inningsBallsLimit = totalBallsFromOvers(inningsOversLimit);
    const scoreboardBallsRaw = Math.max(0, Math.floor(matchState.ballsBowled));
    const scoreboardBalls = Math.min(scoreboardBallsRaw, inningsBallsLimit);
    const ballsRemainingInInnings = Math.max(0, inningsBallsLimit - scoreboardBalls);
    const hasNextOverAvailable = ballsRemainingInInnings > 0;
    const hasFollowingOverPlan = ballsRemainingInInnings > 6;
    const isFinalOverWindow = ballsRemainingInInnings > 0 && ballsRemainingInInnings <= 6;
    const overProgressValue = scoreboardBalls / 6;
    const derivePhaseFromOvers = (): { token: 'powerplay' | 'middle' | 'death'; label: 'Powerplay' | 'Middle' | 'Death' } => {
      const formatToken = formatLabel.toLowerCase();
      const deathThreshold = formatToken.includes('t20')
        ? 16
        : formatToken.includes('odi')
          ? 40
          : Math.max(6, inningsOversLimit - Math.max(4, Math.round(inningsOversLimit * 0.2)));
      if (overProgressValue < 6) return { token: 'powerplay', label: 'Powerplay' };
      if (overProgressValue >= deathThreshold) return { token: 'death', label: 'Death' };
      return { token: 'middle', label: 'Middle' };
    };
    const derivedPhase = derivePhaseFromOvers();
    const phaseLabel = derivedPhase.label;
    const phaseToken = derivedPhase.token;
    const phaseDescriptor = isFinalOverWindow
      ? 'Death-over closeout phase.'
      : phaseToken === 'death'
        ? 'Death-over phase.'
        : phaseToken === 'powerplay'
          ? 'Powerplay phase.'
          : 'Middle-overs phase.';
    const pressureCue =
      modeLabel === 'BATTING'
        ? targetRuns != null
          ? requiredRunRate > currentRunRate + 0.75
            ? 'chase pressure is climbing'
            : requiredRunRate > currentRunRate - 0.25
              ? 'the chase is finely balanced'
              : 'batting momentum is under control'
          : 'the innings rhythm is building'
        : isFinalOverWindow
          ? 'final-over execution is decisive'
          : phaseToken === 'death'
            ? 'death-over timing is critical'
            : matchState.wickets >= 5
              ? 'pressure is on the batting side'
              : 'control in this spell will shape momentum';
    const matchSituationLine =
      modeLabel === 'BOWLING'
        ? targetRuns != null
          ? isFinalOverWindow
            ? `Final over defending ${targetRuns}.`
            : `Defending ${targetRuns}.`
          : isFinalOverWindow
            ? 'Final over in progress.'
            : 'Bowling innings in progress.'
        : targetRuns != null
          ? `Chasing ${targetRuns}.`
          : 'Setting a first-innings total.';
    const scoreLine =
      modeLabel === 'BOWLING'
        ? `Opposition ${Math.max(0, matchState.runs)}/${Math.max(0, matchState.wickets)} after ${formatOverStr(scoreboardBalls)} overs${targetRuns != null ? `, target ${targetRuns}` : ''}. ${phaseDescriptor} ${finalizeCoachSentence(pressureCue, 'control remains critical in this phase', 70)}`
        : `Score ${Math.max(0, matchState.runs)}/${Math.max(0, matchState.wickets)} after ${formatOverStr(scoreboardBalls)} overs${targetRuns != null ? `, chasing ${targetRuns}.` : '.'} ${phaseDescriptor} ${finalizeCoachSentence(pressureCue, 'the innings rhythm is building', 70)}`;
    const unresolvedActiveName = resolveRosterName(
      telemetry.playerId || telemetry.playerName,
      activePlayer?.name || telemetry.playerName || 'Current player'
    ) || 'Current player';
    const activeName = isInitialOnlyName(unresolvedActiveName)
      ? normalizeRecommendationText(activePlayer?.name || '') || 'Current player'
      : unresolvedActiveName;
    const activeRoleTag = resolvePlayerTypeTag(activePlayer?.role || 'Bowler');
    const replacementPool = roster.filter(
      (player) =>
        player.inRoster !== false &&
        !player.isSub &&
        !player.isUnfit &&
        !player.isInjured &&
        baselineKey(player.id) !== baselineKey(telemetry.playerId) &&
        baselineKey(player.name) !== baselineKey(activeName)
    );
    const compatibleBowlers = replacementPool.filter((player) => isBowlingCompatible(player.role));
    const normalizeRiskToken = (value: unknown): 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | 'UNKNOWN' => {
      const token = String(value || '').trim().toUpperCase();
      if (token === 'LOW') return 'LOW';
      if (token === 'MED' || token === 'MEDIUM') return 'MEDIUM';
      if (token === 'HIGH') return 'HIGH';
      if (token === 'CRITICAL') return 'CRITICAL';
      return 'UNKNOWN';
    };
    const fatigue = Math.max(0, safeNum(telemetry.fatigueIndex, 0));
    const strain = Math.max(0, safeNum(telemetry.strainIndex, 0));
    const oversBowled = Math.max(0, safeNum(telemetry.oversBowled, safeNum(activePlayer?.overs, 0)));
    const maxOvers = Math.max(1, safeNum(activePlayer?.maxOvers, getMaxOvers(inputMatchContext.format)));
    const oversQuotaReached = oversBowled >= maxOvers;
    const injuryRiskToken = String(telemetry.injuryRisk || 'LOW').toUpperCase();
    const noBallRiskToken = String(telemetry.noBallRisk || 'LOW').toUpperCase();
    const activeRoleToken = roleToken(activePlayer?.role || currentTelemetry.role || '');
    const activeIsAllRounder = activeRoleToken.includes('all-rounder') || activeRoleToken.includes('all rounder');
    const activeIsBatter = activeRoleToken.includes('bat');
    const activeIsBowler =
      activeRoleToken.includes('bowl') ||
      activeRoleToken.includes('spin') ||
      activeRoleToken.includes('fast') ||
      activeRoleToken.includes('pace') ||
      activeRoleToken.includes('seam');
    const isBattingContext = modeLabel === 'BATTING' && (activeIsBatter || activeIsAllRounder);
    const isBowlingContext = modeLabel === 'BOWLING' && (activeIsBowler || activeIsAllRounder);
    const buildBattingContinuationInsights = (): {
      dismissalRisk: 'LOW' | 'MODERATE' | 'HIGH';
      dismissalRiskReason: string;
      safeContinuationText: string;
      thresholdBreachText: string;
      baselineComparisonText: string;
      decisionMode: 'KEEP_BATTING' | 'KEEP_BATTING_WITH_ADJUSTMENT' | 'STABILIZE_INNINGS';
      priority: 'Stable' | 'Monitor' | 'Immediate';
      availabilityStatus: 'AVAILABLE' | 'LIMITED' | 'TACTICAL_RISK';
      dominantRiskDriver: 'fatigue' | 'recovery' | 'pressure_phase' | 'mixed';
      confidenceScore: number;
    } => {
      const fatigueLimit = Math.max(1, safeNum(baseline.fatigueLimit, safeNum(activePlayer?.baselineFatigue, 6)));
      const baselineToday = clamp(safeNum(baseline.baselineToday, fatigueLimit), 0, 10);
      const recoveryToken = String(activePlayer?.hrRecovery || 'GOOD').trim().toUpperCase();
      const normalizedInjuryRisk = normalizeRiskToken(injuryRiskToken);
      const chasePressureGap =
        targetRuns != null &&
        Number.isFinite(requiredRunRate) &&
        Number.isFinite(currentRunRate)
          ? Math.max(0, requiredRunRate - currentRunRate)
          : 0;
      const fatigueDelta = fatigue - fatigueLimit;
      const fatigueDriftToday = fatigue - baselineToday;
      const fatiguePenalty = clamp(Math.max(0, fatigueDelta * 0.09 + fatigueDriftToday * 0.06), 0, 0.34);
      const strainPenalty = clamp((strain / 10) * 0.26, 0, 0.26);
      const pressurePenalty = clamp((chasePressureGap / 2.6) * 0.2, 0, 0.2);
      const wicketPenalty = clamp((Math.max(0, safeNum(matchState.wickets, 0) - 3) / 7) * 0.16, 0, 0.16);
      const recoveryPenalty = recoveryToken === 'POOR' ? 0.2 : recoveryToken === 'MODERATE' ? 0.11 : 0.03;
      const injuryPenalty =
        normalizedInjuryRisk === 'CRITICAL' ? 0.25 : normalizedInjuryRisk === 'HIGH' ? 0.18 : normalizedInjuryRisk === 'MEDIUM' ? 0.08 : 0;
      const dismissalScore = clamp(
        fatiguePenalty + strainPenalty + pressurePenalty + wicketPenalty + recoveryPenalty + injuryPenalty,
        0,
        1
      );
      const dismissalRisk: 'LOW' | 'MODERATE' | 'HIGH' =
        dismissalScore >= 0.62 ? 'HIGH' : dismissalScore >= 0.36 ? 'MODERATE' : 'LOW';
      const reactionDrift = clamp((strain / 10) * 0.58 + Math.max(0, fatigueDriftToday / 3.2) * 0.42, 0, 1);
      const reactionDriftPct = Math.round(reactionDrift * 100);
      const recoveryDescriptor =
        recoveryToken === 'POOR'
          ? 'recovery profile'
          : recoveryToken === 'MODERATE'
            ? 'recovery trend'
            : 'fatigue drift';
      const dismissalRiskReason = `Dismissal risk is ${dismissalRisk} due to elevated ${recoveryDescriptor} and a ${reactionDriftPct}% reaction-stability drift indicator.`;
      const meaningfulThreshold = clamp(fatigueLimit + 0.9, 0, 10);
      const perBallFatigueDrift = clamp(
        0.045 +
          strain * 0.008 +
          (recoveryToken === 'POOR' ? 0.028 : recoveryToken === 'MODERATE' ? 0.014 : 0.007) +
          pressurePenalty * 0.06,
        0.04,
        0.16
      );
      const rawBallsToBreach =
        fatigue >= meaningfulThreshold ? 0 : Math.floor((meaningfulThreshold - fatigue) / Math.max(0.01, perBallFatigueDrift));
      const estimatedBallsToBreach = clamp(rawBallsToBreach, 0, Math.max(0, ballsRemainingInInnings));
      const safeWindowMin = Math.max(1, estimatedBallsToBreach - 2);
      const safeWindowMax = Math.max(safeWindowMin, Math.min(ballsRemainingInInnings, estimatedBallsToBreach + 2));
      const safeContinuationText =
        estimatedBallsToBreach <= 2
          ? `Safe continuation window is narrowing: ~${estimatedBallsToBreach} more balls at current exertion.`
          : safeWindowMin === safeWindowMax
            ? `Projected safe continuation window: ~${safeWindowMin} more balls if intensity remains stable.`
            : `Projected safe continuation window: ${safeWindowMin}-${safeWindowMax} balls if intensity remains stable.`;
      const thresholdBreachText =
        estimatedBallsToBreach <= 2
          ? `Estimated balls before fatigue exceeds baseline threshold: ${estimatedBallsToBreach}.`
          : safeWindowMin === safeWindowMax
            ? `Projected threshold breach in ~${safeWindowMin} balls at current exertion.`
            : `Projected threshold breach in ${safeWindowMin}-${safeWindowMax} balls at current exertion.`;
      const fatigueDeviationPercent = Math.round(((fatigue - fatigueLimit) / Math.max(1, fatigueLimit)) * 100);
      const baselineComparisonText =
        fatigueDeviationPercent >= 6
          ? `Baseline comparison: current batting load is ${fatigueDeviationPercent}% above expected threshold.`
          : fatigueDeviationPercent <= -6
            ? `Baseline comparison: current batting load is ${Math.abs(fatigueDeviationPercent)}% below expected threshold.`
            : 'Baseline comparison: current batting load is within expected threshold range.';
      const dominantRiskDriver: 'fatigue' | 'recovery' | 'pressure_phase' | 'mixed' =
        recoveryToken === 'POOR' ? 'recovery' : chasePressureGap > 0.9 ? 'pressure_phase' : dismissalRisk === 'LOW' ? 'mixed' : 'fatigue';
      const availabilityStatus: 'AVAILABLE' | 'LIMITED' | 'TACTICAL_RISK' =
        dismissalRisk === 'HIGH' ? 'TACTICAL_RISK' : dismissalRisk === 'MODERATE' ? 'LIMITED' : 'AVAILABLE';
      const decisionMode: 'KEEP_BATTING' | 'KEEP_BATTING_WITH_ADJUSTMENT' | 'STABILIZE_INNINGS' =
        dismissalRisk === 'HIGH' ? 'STABILIZE_INNINGS' : dismissalRisk === 'MODERATE' ? 'KEEP_BATTING_WITH_ADJUSTMENT' : 'KEEP_BATTING';
      const priority: 'Stable' | 'Monitor' | 'Immediate' =
        dismissalRisk === 'HIGH' ? 'Immediate' : dismissalRisk === 'MODERATE' ? 'Monitor' : 'Stable';
      const confidenceScore = dismissalRisk === 'HIGH' ? 0.81 : dismissalRisk === 'MODERATE' ? 0.72 : 0.64;
      return {
        dismissalRisk,
        dismissalRiskReason,
        safeContinuationText,
        thresholdBreachText,
        baselineComparisonText,
        decisionMode,
        priority,
        availabilityStatus,
        dominantRiskDriver,
        confidenceScore,
      };
    };
    if (!isBattingContext && !isBowlingContext) {
      const neutralMessage = 'Awaiting role-consistent tactical recommendation';
      return {
        matchSituation: [matchSituationLine, scoreLine] as [string, string],
        assessment: [
          'Selected player role is not aligned with the current match state.',
          neutralMessage,
        ] as [string, string],
        recommendedMove: neutralMessage,
        whyThisIsSmart: dedupeBullets(
          [
            'It prevents incorrect tactical actions from being shown for the active role.',
            'Switching to a role-consistent player or match state restores full tactical guidance.',
          ],
          3
        ),
        ifYouIgnore: 'If ignored, tactical guidance may not match the current player context.',
        confidence: 'Moderate',
        priority: 'Monitor',
        availabilityStatus: 'TACTICAL_RISK',
        dominantRiskDriver: 'mixed',
        decisionMode: 'ROLE_CONTEXT_MISMATCH',
        substitutionRequired: false,
        primaryPlayerName: activeName,
        recommendedReplacement: activeName,
        swap: {
          out: activeName,
          in: activeName,
          reason: neutralMessage,
        },
        suggestedBenchOptions: [],
      };
    }
    if (isBattingContext) {
      const battingBallsFaced = Math.max(0, safeNum(activePlayer?.balls, 0));
      const batterIsOut = activeDismissalStatus === 'OUT';
      if (batterIsOut || battingBallsFaced === 0) {
        const noTelemetryAssessment = batterIsOut
          ? 'Batting analysis unavailable. Player has already been dismissed. Tactical evaluation will apply to the next active batter.'
          : 'No batting telemetry yet. Player has not faced a delivery in this innings.';
        const dismissalRiskLine = batterIsOut
          ? 'Dismissal risk: N/A - player already dismissed.'
          : 'Dismissal risk: N/A - insufficient batting data.';
        const stableSwapName = isInitialOnlyName(activeName) ? 'Current player' : activeName;
        return {
          matchSituation: [matchSituationLine, scoreLine] as [string, string],
          assessment: [noTelemetryAssessment, dismissalRiskLine] as [string, string?],
          recommendedMove: noTelemetryAssessment,
          whyThisIsSmart: dedupeBullets(
            [
              batterIsOut
                ? 'Dismissed batters are excluded from live continuity projection until the next active batter is selected.'
                : 'Batting continuity projections start after the player records live ball-by-ball telemetry.',
            ],
            3
          ),
          ifYouIgnore: noTelemetryAssessment,
          confidence: 'Low',
          priority: 'Monitor',
          availabilityStatus: 'AVAILABLE',
          dominantRiskDriver: 'mixed',
          decisionMode: 'KEEP_BATTING',
          substitutionRequired: false,
          primaryPlayerName: activeName,
          recommendedReplacement: 'No recommendation available.',
          swap: {
            out: stableSwapName,
            in: stableSwapName,
            reason: noTelemetryAssessment,
          },
          suggestedBenchOptions: [],
        };
      }
      const battingInsights = buildBattingContinuationInsights();
      const stableSwapName = isInitialOnlyName(activeName) ? 'Current player' : activeName;
      return {
        matchSituation: [matchSituationLine, scoreLine] as [string, string],
        assessment: [
          battingInsights.dismissalRiskReason,
          battingInsights.safeContinuationText,
        ] as [string, string],
        recommendedMove: battingInsights.thresholdBreachText,
        whyThisIsSmart: dedupeBullets(
          [
            'It frames batting continuity as probabilistic risk support instead of deterministic instructions.',
            battingInsights.baselineComparisonText,
          ],
          3
        ),
        ifYouIgnore: 'If ignored, fatigue drift can tighten the continuation window and increase dismissal exposure in this phase.',
        confidence: toConfidenceLabel(battingInsights.confidenceScore),
        priority: battingInsights.priority,
        availabilityStatus: battingInsights.availabilityStatus,
        dominantRiskDriver: battingInsights.dominantRiskDriver,
        decisionMode: battingInsights.decisionMode,
        substitutionRequired: false,
        primaryPlayerName: activeName,
        recommendedReplacement: 'Not applicable while batter is active',
        swap: {
          out: stableSwapName,
          in: stableSwapName,
          reason: battingInsights.baselineComparisonText,
        },
        suggestedBenchOptions: [],
      };
    }
    const scoreBowlingCandidate = (player: Player) => {
      const fatigueValue = clamp(safeNum(player.fatigue, 5), 0, 10);
      const strainValue = clamp(safeNum(player.strainIndex, 3), 0, 10);
      const oversValue = Math.max(0, safeNum(player.overs, 0));
      const fatigueLimitValue = Math.max(1, safeNum(player.baselineFatigue, 6));
      const fatigueHeadroom = clamp((fatigueLimitValue - fatigueValue) / fatigueLimitValue, -1, 1);
      const recoveryValue = clamp(safeNum(player.recoveryTime, 45), 0, 120);
      const sleepValue = clamp(safeNum(player.sleepHours, 7), 0, 12);
      const controlValue = clamp(safeNum(player.controlBaseline, 75), 0, 100);
      const speedValue = clamp(safeNum(player.speed, 7), 0, 15);
      const powerValue = clamp(safeNum(player.power, 6), 0, 10);
      const injuryToken = normalizeRiskToken(player.injuryRisk);
      const noBallToken = normalizeRiskToken(player.noBallRisk);
      const role = roleToken(player.role);
      const playerRoleTag = resolvePlayerTypeTag(player.role);

      let score = 0;
      score += Math.max(0, 10 - fatigueValue) * 3;
      score += Math.max(0, 10 - strainValue) * 2;
      score += Math.max(0, 4 - oversValue) * 2;
      score += fatigueHeadroom * 5;
      score += controlValue * 0.08;
      score += recoveryValue * 0.05;
      score += sleepValue * 0.5;
      score += speedValue * 0.25;
      score += powerValue * 0.15;

      if (injuryToken === 'LOW') score += 4;
      else if (injuryToken === 'MEDIUM') score += 1;
      else if (injuryToken === 'HIGH') score -= 2.5;
      else if (injuryToken === 'CRITICAL') score -= 5;

      if (noBallToken === 'LOW') score += 3;
      else if (noBallToken === 'MEDIUM') score += 1;
      else if (noBallToken === 'HIGH') score -= 2;

      if (modeLabel === 'BOWLING') score += 2;
      if (phaseToken.includes('death')) score += controlValue >= 80 ? 2 : 0;
      if (phaseToken.includes('powerplay')) score += speedValue >= 11 ? 1.5 : 0;
      if (phaseToken.includes('middle') && role.includes('spinner')) score += 1.5;
      if (playerRoleTag === activeRoleTag) score += 2.2;

      return {
        player,
        score: Number(score.toFixed(2)),
        fatigueValue,
        fatigueLimitValue,
        strainValue,
        oversValue,
        recoveryValue,
        sleepValue,
        controlValue,
        injuryToken,
        noBallToken,
        roleTag: playerRoleTag,
      };
    };
    const rankedBowlingCandidates = [...compatibleBowlers]
      .filter((player) => !isInitialOnlyName(player.name))
      .map(scoreBowlingCandidate)
      .sort((a, b) => (b.score !== a.score ? b.score - a.score : a.player.name.localeCompare(b.player.name)));
    const selectedCandidateSummary = rankedBowlingCandidates[0] || null;
    const backupCandidateSummary = rankedBowlingCandidates[1] || null;
    const selectedReplacementPlayer =
      selectedCandidateSummary?.player ||
      [...compatibleBowlers].map(scoreBowlingCandidate).sort((a, b) => b.score - a.score)[0]?.player ||
      null;
    const replacementName = resolveRosterName(
      selectedReplacementPlayer?.id || selectedReplacementPlayer?.name,
      activeName
    ) || activeName;
    const hasReplacementOption =
      Boolean(selectedCandidateSummary) && baselineKey(replacementName) !== baselineKey(activeName);
    const alternatives = dedupeBullets(
      rankedBowlingCandidates
        .slice(1, 4)
        .map((entry) => resolveRosterName(entry.player.id || entry.player.name, entry.player.name)),
      3
    );
    const suggestedBenchOptions = rankedBowlingCandidates.slice(0, 3).map((entry) => ({
      name: resolveRosterName(entry.player.id || entry.player.name, entry.player.name) || entry.player.name,
      roleTag: entry.roleTag,
      reason:
        entry.roleTag === 'SPIN'
          ? 'Offers control-focused spin variation for pressure containment.'
          : entry.roleTag === 'PACE'
            ? 'Provides pace threat while maintaining line discipline.'
            : 'Provides balanced control and adaptability.',
    }));
    if (oversQuotaReached) {
      const replacementOrFallback = hasReplacementOption ? replacementName : 'No eligible replacement';
      return {
        matchSituation: [matchSituationLine, scoreLine] as [string, string],
        assessment: [
          `${activeName} has reached the overs quota (${oversBowled}/${maxOvers}) and cannot bowl again in this format.`,
          'Match rule constraint overrides fatigue and tactical continuation logic.',
        ] as [string, string],
        recommendedMove: hasReplacementOption
          ? `Select replacement bowler: bring in ${replacementName} next over.`
          : 'Select replacement bowler: no eligible replacement is currently available from the active roster.',
        whyThisIsSmart: dedupeBullets(
          [
            'It keeps the bowling decision legally valid for the format.',
            hasReplacementOption
              ? `${replacementName} is the best available replacement option for immediate rotation.`
              : 'Current roster has no eligible replacement, so bench substitution support is required.',
            'This avoids avoidable penalties and keeps the phase plan executable.',
          ],
          3
        ),
        ifYouIgnore: 'If ignored, the bowling plan breaches overs quota rules and cannot continue as-is.',
        confidence: 'High',
        priority: 'Immediate',
        availabilityStatus: 'UNAVAILABLE',
        dominantRiskDriver: 'overs_quota_reached',
        decisionMode: 'IMMEDIATE_SUBSTITUTION',
        substitutionRequired: true,
        primaryPlayerName: activeName,
        recommendedReplacement: replacementOrFallback,
        swap: {
          out: activeName,
          in: replacementOrFallback,
          reason: hasReplacementOption
            ? `Tactical plan: Overs quota reached. Next over: ${replacementName}.`
            : 'Tactical plan: Overs quota reached. Trigger replacement workflow before the next over.',
        },
        suggestedBenchOptions,
      };
    }
    const elevatedControlRisk = noBallRiskToken === 'HIGH' || noBallRiskToken === 'MED' || noBallRiskToken === 'MEDIUM';
    const elevatedInjuryRisk = injuryRiskToken === 'HIGH' || injuryRiskToken === 'CRITICAL' || injuryRiskToken === 'MED' || injuryRiskToken === 'MEDIUM';
    const safeContinue = oversBowled === 0 || (fatigue <= 4 && injuryRiskToken === 'LOW');
    const constrainedRecoveryProfile =
      (Number.isFinite(Number(baseline.sleepHours)) && Number(baseline.sleepHours) < 7) ||
      (Number.isFinite(Number(baseline.recoveryMinutes)) && Number(baseline.recoveryMinutes) < 50);
    const phaseLeverageLine = phaseToken.includes('death')
      ? 'This is a leverage phase, so one loose over can swing momentum quickly.'
      : phaseToken.includes('powerplay')
        ? 'Fielding restrictions make control and intent shifts more visible in this phase.'
        : 'Middle-overs tempo control now determines how much pressure carries forward.';
    const composeTacticalPlan = (nextOverPlan: string, followingOverPlan?: string): string => {
      if (!hasNextOverAvailable) {
        return 'Tactical plan: Innings complete — no further overs remain.';
      }
      if (!hasFollowingOverPlan || !followingOverPlan) {
        return `Tactical plan: ${nextOverPlan} Reassess at over end.`;
      }
      return `Tactical plan: ${nextOverPlan} ${followingOverPlan}`;
    };
    const baseAssessmentLine1 = safeContinue
      ? `${activeName} can continue, but this over should be used as a control checkpoint.`
      : elevatedControlRisk && elevatedInjuryRisk
        ? `${activeName}'s spell is approaching a rhythm-drop window where pressure can release quickly.`
        : elevatedInjuryRisk
          ? `${activeName} is carrying workload stress that can reduce execution quality in the next spell.`
          : elevatedControlRisk
            ? `${activeName} is showing early control drift; proactive rotation is tactically cleaner than reactive change.`
            : `${activeName} is competing well, but the phase timing favors a proactive reset now.`;
    const baseAssessmentLine2 = safeContinue
      ? hasFollowingOverPlan
        ? `${phaseLeverageLine} Keep a prepared change option for the following over.`
        : `${phaseLeverageLine} This is the closeout window, so keep execution control-first through the over.`
      : constrainedRecoveryProfile
        ? 'Recovery profile suggests shorter bursts are safer, so rotate before control quality dips.'
        : `${phaseLeverageLine} Rotating now protects execution quality before momentum flips.`;
    const confidenceScore = clamp(safeNum(tacticalAnalysis?.confidence, safeNum(combinedDecision?.confidence, 0.62)), 0, 1);
    const confidence = toConfidenceLabel(confidenceScore);
    const optionsLine = alternatives.length > 0
      ? `Other options: ${alternatives.slice(0, 3).join(', ')}.`
      : '';
    const backupCandidateName = backupCandidateSummary
      ? resolveRosterName(
          backupCandidateSummary.player.id || backupCandidateSummary.player.name,
          backupCandidateSummary.player.name
        )
      : '';
    const shouldRotateNow = !safeContinue && hasReplacementOption;
    const noEligibleReplacement = !safeContinue && !hasReplacementOption;
    const continuePlan = composeTacticalPlan(
      `Next over: stay with ${activeName}.`,
      `Following over: ${backupCandidateName || replacementName} if pressure rises.`
    );
    const rotatePlan = composeTacticalPlan(
      `Next over: ${replacementName} to reset pressure.`,
      `Following over: ${backupCandidateName || activeName} based on control quality.`
    );
    const noEligiblePlan = hasNextOverAvailable
      ? 'Tactical plan: No eligible bowling replacement is available. Use a strict one-over leash and reassess.'
      : 'Tactical plan: Innings complete — no further overs remain.';
    const swap = {
      out: activeName,
      in: replacementName,
      reason: sanitizeCoachLine(
        safeContinue
          ? continuePlan
          : shouldRotateNow
            ? rotatePlan
            : noEligiblePlan,
        safeContinue
          ? continuePlan
          : shouldRotateNow
            ? rotatePlan
            : noEligiblePlan,
        180
      ),
    };
    const baseRecommendedMove = !hasNextOverAvailable
      ? 'Innings complete — no next over remains for a bowling change.'
      : safeContinue
        ? hasFollowingOverPlan
          ? `Continue with ${activeName} for one controlled over, then reassess before locking the next spell.`
          : `Continue with ${activeName} for this closeout over with a strict control-first plan.`
        : noEligibleReplacement
          ? hasFollowingOverPlan
            ? `No eligible replacement available — keep ${activeName} for one controlled over, then reassess.`
            : `No eligible replacement available — keep ${activeName} for the closeout over and reassess at over end.`
          : `Bring in ${swap.in} for ${swap.out} next over to reset control before pressure compounds.`;
    const baseWhyThisIsSmart = safeContinue
      ? dedupeBullets([
          `This avoids an unnecessary early change while preserving match rhythm.`,
          `You keep a prepared fallback so the next decision stays proactive, not reactive.`,
          backupCandidateName && hasFollowingOverPlan
            ? `Backup option remains ${backupCandidateName} if pressure spikes after this over.`
            : hasFollowingOverPlan
              ? 'You preserve flexibility for the next tactical window.'
              : 'This keeps the closeout over simple and execution-first.',
        ], 3)
      : shouldRotateNow && selectedCandidateSummary
        ? dedupeBullets([
            sanitizeCoachLine(
              `${replacementName} gives the best immediate reset for this phase and pressure profile.`,
              `${replacementName} gives the best immediate reset for this phase.`,
              90
            ),
            sanitizeCoachLine(
              hasFollowingOverPlan
                ? 'Rotating now protects control in the following spell instead of waiting for execution to drift.'
                : 'Rotating now protects control through the closeout over instead of waiting for execution to drift.',
              hasFollowingOverPlan
                ? 'Rotating now protects control in the following spell.'
                : 'Rotating now protects control through the closeout over.',
              90
            ),
            sanitizeCoachLine(
              backupCandidateName && hasFollowingOverPlan
                ? `Secondary option: ${backupCandidateName} if scoring pressure changes after the next over.`
                : 'This timing keeps the closeout plan simple and avoids forced reactive changes.',
              backupCandidateName && hasFollowingOverPlan
                ? `Secondary option: ${backupCandidateName}.`
                : 'This timing keeps the closeout plan simple.',
              90
            ),
          ], 3)
        : dedupeBullets([
            'No eligible replacement is available from the current bowling roster.',
            `Use ${activeName} on a strict one-over leash with control-first fields.`,
            hasFollowingOverPlan
              ? 'Reassess execution quality immediately before committing the following over.'
              : 'Reassess execution quality ball-by-ball through this closeout over.',
          ], 3);
    const baseIfYouIgnore = safeContinue
      ? hasFollowingOverPlan
        ? 'If control slips without a preplanned backup, the next over can force a rushed tactical change.'
        : 'If control slips now, the closeout over can leak pressure quickly.'
      : sanitizeCoachLine(
          tacticalAnalysis?.ifIgnored ||
          finalRecommendation?.ifContinues?.riskSummary ||
          activeStrategicAnalysis?.tacticalRecommendation?.ifIgnored ||
          (hasFollowingOverPlan
            ? 'If the change is delayed, control drop and pressure release are more likely over the next one to two overs.'
            : 'If the change is delayed, control drop and pressure release are more likely in the remaining deliveries.'),
          hasFollowingOverPlan
            ? 'If the change is delayed, control drop and pressure release are more likely over the next one to two overs.'
            : 'If the change is delayed, control drop and pressure release are more likely in the remaining deliveries.',
          110
        );
    const fatigueLimit = Math.max(1, safeNum(baseline.fatigueLimit, safeNum(activePlayer?.baselineFatigue, 6)));
    const heartRateRecoveryToken = String(activePlayer?.hrRecovery || 'MODERATE').trim().toUpperCase();
    const injuryRiskNormalized: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' =
      injuryRiskToken === 'CRITICAL'
        ? 'CRITICAL'
        : injuryRiskToken === 'HIGH'
          ? 'HIGH'
          : injuryRiskToken === 'MED' || injuryRiskToken === 'MEDIUM'
            ? 'MEDIUM'
            : 'LOW';
    const noBallRiskNormalized: 'LOW' | 'MEDIUM' | 'HIGH' =
      noBallRiskToken === 'HIGH'
        ? 'HIGH'
        : noBallRiskToken === 'MED' || noBallRiskToken === 'MEDIUM'
          ? 'MEDIUM'
          : 'LOW';
    const markedFitStatus: 'FIT' | 'UNFIT' = activePlayer?.isUnfit ? 'UNFIT' : 'FIT';
    const availabilityStatus: 'AVAILABLE' | 'LIMITED' | 'TACTICAL_RISK' | 'UNAVAILABLE' =
      markedFitStatus === 'UNFIT' || injuryRiskNormalized === 'CRITICAL'
        ? 'UNAVAILABLE'
        : fatigue > fatigueLimit && strain >= 4
          ? 'LIMITED'
          : noBallRiskNormalized === 'HIGH'
            ? 'TACTICAL_RISK'
            : 'AVAILABLE';
    const substitutionRequired = availabilityStatus === 'UNAVAILABLE';
    const dominantRiskDriver: 'injury' | 'fatigue' | 'recovery' | 'control' | 'matchup' | 'pressure_phase' | 'mixed' =
      availabilityStatus === 'UNAVAILABLE'
        ? 'injury'
        : availabilityStatus === 'LIMITED'
          ? 'fatigue'
          : constrainedRecoveryProfile || heartRateRecoveryToken === 'POOR'
            ? 'recovery'
            : availabilityStatus === 'TACTICAL_RISK'
              ? 'control'
              : hasReplacementOption && selectedCandidateSummary && phaseToken !== 'powerplay'
                ? 'matchup'
                : phaseToken === 'death' || isFinalOverWindow
                  ? 'pressure_phase'
                  : 'mixed';
    const replacementRoleTag = selectedCandidateSummary?.roleTag || resolvePlayerTypeTag(selectedReplacementPlayer?.role || '');
    const roleTagText =
      replacementRoleTag === 'SPIN'
        ? 'spin control option'
        : replacementRoleTag === 'PACE'
          ? 'pace control option'
          : replacementRoleTag === 'ALL_ROUND'
            ? 'all-round balance option'
            : 'control-first option';
    const replacementPlanReason = hasReplacementOption
      ? `${replacementName} offers the safest ${roleTagText} for the ${phaseLabel.toLowerCase()} phase.`
      : 'No role-compatible replacement is currently available from the active roster.';
    const replacementContrastLine =
      backupCandidateSummary && selectedCandidateSummary && backupCandidateSummary.controlValue + 6 < selectedCandidateSummary.controlValue
        ? `${backupCandidateName || resolveRosterName(backupCandidateSummary.player.id || backupCandidateSummary.player.name, backupCandidateSummary.player.name)} is less suitable here because the immediate need is control stability, not extra pace.`
        : '';
    let decisionMode:
      | 'IMMEDIATE_SUBSTITUTION'
      | 'ROTATE_NEXT_OVER'
      | 'SHORTEN_SPELL'
      | 'KEEP_BOWLING_WITH_ADJUSTMENT'
      | 'MATCHUP_CHANGE'
      | 'RECOVERY_ONLY' = 'KEEP_BOWLING_WITH_ADJUSTMENT';
    if (!hasNextOverAvailable) {
      decisionMode = 'RECOVERY_ONLY';
    } else if (availabilityStatus === 'UNAVAILABLE') {
      decisionMode = 'IMMEDIATE_SUBSTITUTION';
    } else if (availabilityStatus === 'LIMITED') {
      decisionMode = hasReplacementOption ? 'ROTATE_NEXT_OVER' : 'SHORTEN_SPELL';
    } else if (availabilityStatus === 'TACTICAL_RISK') {
      decisionMode = hasReplacementOption ? 'MATCHUP_CHANGE' : 'KEEP_BOWLING_WITH_ADJUSTMENT';
    } else if (hasReplacementOption && selectedCandidateSummary && phaseToken !== 'powerplay' && !safeContinue) {
      decisionMode = 'MATCHUP_CHANGE';
    }
    const priority: 'Stable' | 'Monitor' | 'Immediate' =
      decisionMode === 'IMMEDIATE_SUBSTITUTION'
        ? 'Immediate'
        : decisionMode === 'ROTATE_NEXT_OVER' || decisionMode === 'SHORTEN_SPELL' || decisionMode === 'MATCHUP_CHANGE'
          ? 'Monitor'
          : 'Stable';
    let assessmentLine1 = baseAssessmentLine1;
    let assessmentLine2 = baseAssessmentLine2;
    let recommendedMove = baseRecommendedMove;
    let swapReason = swap.reason;
    let whyThisIsSmart = [...(baseWhyThisIsSmart || [])];
    let ifYouIgnore = baseIfYouIgnore;

    if (decisionMode === 'IMMEDIATE_SUBSTITUTION') {
      assessmentLine1 = `${activeName} is not fit to continue. Risk state exceeds continuation threshold.`;
      assessmentLine2 = 'Immediate substitution is required to prevent avoidable exposure in this phase.';
      recommendedMove = hasReplacementOption
        ? `Immediate substitution required: replace ${activeName} with ${replacementName} now.`
        : `Immediate substitution required: ${activeName} should not continue current spell, and no eligible replacement is available.`;
      swapReason = hasReplacementOption
        ? `Tactical plan: Immediate substitution required. Next over: ${replacementName}.`
        : 'Tactical plan: Stop current spell immediately and trigger emergency roster substitution support.';
      whyThisIsSmart = dedupeBullets(
        [
          'Player should not continue current spell under a critical/unfit state.',
          replacementPlanReason,
          replacementContrastLine || 'Early substitution protects both player safety and control integrity for remaining overs.',
        ],
        3
      );
      ifYouIgnore = 'If this is ignored, injury exposure and execution instability can escalate immediately.';
    } else if (decisionMode === 'ROTATE_NEXT_OVER' || decisionMode === 'SHORTEN_SPELL') {
      assessmentLine1 = `${activeName} is in a limited workload state driven by fatigue accumulation.`;
      assessmentLine2 = 'The risk is not this ball; it is the next over where control quality can decay.';
      recommendedMove = decisionMode === 'ROTATE_NEXT_OVER' && hasReplacementOption
        ? `Rotate ${activeName} next over and bring in ${replacementName} to protect control quality.`
        : `Shorten ${activeName}'s spell now and enforce a one-over leash before reassessment.`;
      swapReason = decisionMode === 'ROTATE_NEXT_OVER' && hasReplacementOption
        ? composeTacticalPlan(`Next over: ${replacementName} to reset pressure.`, hasFollowingOverPlan ? `Following over: reassess ${activeName} only if control signals stabilize.` : '')
        : composeTacticalPlan(`Next over: keep ${activeName} with strict control-first execution.`, 'Following over: mandatory reassessment before extension.');
      whyThisIsSmart = dedupeBullets(
        [
          'This prevents cumulative fatigue from turning into late-spell execution loss.',
          replacementPlanReason,
          'It keeps the rotation proactive instead of waiting for a forced reactive switch.',
        ],
        3
      );
      ifYouIgnore = 'If ignored, workload compounding is likely to reduce control consistency over the next over.';
    } else if (decisionMode === 'MATCHUP_CHANGE') {
      assessmentLine1 = `${activeName} is available, but the current phase demands a sharper matchup profile.`;
      assessmentLine2 = phaseToken === 'death'
        ? 'Death-over run control is the dominant priority right now.'
        : 'Current pressure profile favors control-first matchup timing over continuity.';
      recommendedMove = hasReplacementOption
        ? `Matchup change: bring in ${replacementName} for ${activeName} next over.`
        : `Matchup adjustment needed, but no eligible replacement is available — keep ${activeName} with strict control settings.`;
      swapReason = hasReplacementOption
        ? composeTacticalPlan(`Next over: ${replacementName} as the matchup change.`, hasFollowingOverPlan ? `Following over: ${backupCandidateName || activeName} if pressure pattern shifts.` : '')
        : composeTacticalPlan(`Next over: ${activeName} with field + length adjustment only.`, '');
      whyThisIsSmart = dedupeBullets(
        [
          replacementPlanReason,
          replacementContrastLine || 'This matchup improves phase-specific control without overexposing the current bowler.',
          'The change targets pressure containment rather than generic rotation.',
        ],
        3
      );
      ifYouIgnore = 'If ignored, matchup inefficiency can leak pressure and reduce tactical flexibility in the following over.';
    } else if (decisionMode === 'KEEP_BOWLING_WITH_ADJUSTMENT') {
      assessmentLine1 = `${activeName} remains available, but execution adjustments are required this over.`;
      assessmentLine2 = noBallRiskNormalized === 'HIGH'
        ? 'Primary issue is control drift, not raw workload capacity.'
        : 'Keep the spell short and control-first to maintain phase stability.';
      recommendedMove = `Keep ${activeName} for this over with a control-first adjustment plan.`;
      swapReason = composeTacticalPlan(
        `Next over: ${activeName} with simplified run-up and tighter line discipline.`,
        hasFollowingOverPlan ? `Following over: reassess between ${activeName} and ${replacementName}.` : ''
      );
      whyThisIsSmart = dedupeBullets(
        [
          'You preserve continuity while actively reducing execution variance.',
          hasReplacementOption ? `Replacement option ${replacementName} remains ready if control slips.` : 'No stronger replacement signal is currently available.',
          'This avoids premature change while keeping risk triggers explicit.',
        ],
        3
      );
      ifYouIgnore = 'If ignored, small control errors can compound into wides/no-balls and momentum release.';
    }
    const resolvedSwap = {
      ...swap,
      reason: sanitizeCoachLine(swapReason, swapReason, 180),
    };
    const hasShortOrInitialSection = (value: string): boolean => {
      const normalized = normalizeRecommendationText(value);
      return normalized.length < 8 || isInitialOnlyName(normalized);
    };
    const deterministicFallback = (() => {
      const shouldRotate = injuryRiskToken === 'HIGH' || noBallRiskToken === 'HIGH' || fatigue >= 6.5 || strain >= 3.5;
      const canFallbackRotate = shouldRotate && hasReplacementOption;
      const fallbackSwap = {
        out: activeName,
        in: replacementName,
        reason: safeContinue
          ? continuePlan
          : canFallbackRotate
            ? rotatePlan
            : noEligiblePlan,
      };
      return {
        matchSituation: [matchSituationLine, scoreLine] as [string, string],
        assessment: [assessmentLine1, assessmentLine2] as [string, string],
        recommendedMove: !hasNextOverAvailable
          ? 'Innings complete — no next over remains for a bowling change.'
          : safeContinue
            ? hasFollowingOverPlan
              ? `Continue with ${activeName} for one controlled over, then reassess before locking the next spell.`
              : `Continue with ${activeName} for this closeout over with a strict control-first plan.`
            : canFallbackRotate
              ? `Bring in ${fallbackSwap.in} for ${fallbackSwap.out} next over to reset control before pressure compounds.`
              : hasFollowingOverPlan
                ? `No eligible replacement available — keep ${activeName} for one controlled over, then reassess.`
                : `No eligible replacement available — keep ${activeName} for the closeout over and reassess at over end.`,
        whyThisIsSmart: safeContinue
          ? dedupeBullets([
              `This avoids an unnecessary early change while preserving match rhythm.`,
              `You keep a prepared fallback so the next decision stays proactive, not reactive.`,
              backupCandidateName && hasFollowingOverPlan
                ? `Backup option remains ${backupCandidateName} if pressure spikes after this over.`
                : hasFollowingOverPlan
                  ? 'You preserve flexibility for the next tactical window.'
                  : 'This keeps the closeout over simple and execution-first.',
            ], 3)
          : canFallbackRotate
            ? dedupeBullets([
                `${fallbackSwap.in} changes the pressure profile at the right phase timing.`,
                'The timing of this change helps prevent control slippage under pressure.',
                hasFollowingOverPlan
                  ? 'You keep a safer path now while preserving options for the next tactical window.'
                  : 'You keep a safer path now while simplifying the closeout execution.',
              ], 3)
            : dedupeBullets([
                'No eligible replacement is available from the current bowling roster.',
                `Use ${activeName} on a strict one-over leash with control-first fields.`,
                hasFollowingOverPlan
                  ? 'Reassess execution quality immediately before committing the following over.'
                  : 'Reassess execution quality ball-by-ball through this closeout over.',
              ], 3),
        ifYouIgnore: safeContinue
          ? hasFollowingOverPlan
            ? 'If control slips without a preplanned backup, the next over can force a rushed tactical change.'
            : 'If control slips now, the closeout over can leak pressure quickly.'
          : hasFollowingOverPlan
            ? 'If the change is delayed, control drop and pressure release are more likely over the next one to two overs.'
            : 'If the change is delayed, control drop and pressure release are more likely in the remaining deliveries.',
        confidence,
        priority,
        availabilityStatus,
        dominantRiskDriver,
        decisionMode,
        substitutionRequired,
        primaryPlayerName: activeName,
        recommendedReplacement: fallbackSwap.in,
        swap: fallbackSwap,
        suggestedBenchOptions,
      };
    })();
    const candidate = {
      matchSituation: [matchSituationLine, scoreLine] as [string, string],
      assessment: [assessmentLine1, assessmentLine2] as [string, string],
      recommendedMove,
      whyThisIsSmart: whyThisIsSmart.length > 0 ? whyThisIsSmart : deterministicFallback.whyThisIsSmart,
      ifYouIgnore: ifYouIgnore || deterministicFallback.ifYouIgnore,
      confidence,
      priority,
      availabilityStatus,
      dominantRiskDriver,
      decisionMode,
      substitutionRequired,
      primaryPlayerName: activeName,
      recommendedReplacement: replacementName,
      swap: resolvedSwap,
      suggestedBenchOptions,
    };
    const hasInvalidSections =
      hasShortOrInitialSection(candidate.matchSituation[0]) ||
      hasShortOrInitialSection(candidate.assessment[0]) ||
      hasShortOrInitialSection(candidate.recommendedMove) ||
      hasShortOrInitialSection(candidate.ifYouIgnore) ||
      candidate.whyThisIsSmart.length === 0 ||
      candidate.whyThisIsSmart.some((line) => hasShortOrInitialSection(line)) ||
      isInitialOnlyName(candidate.swap.out) ||
      isInitialOnlyName(candidate.swap.in);
    return hasInvalidSections ? deterministicFallback : candidate;
  };
  const tacticalRecommendation = formatTacticalRecommendation(
    matchContext,
    {
      playerId: currentTelemetry.playerId,
      playerName: currentTelemetry.playerName,
      fatigueIndex: safeNum(activePlayer?.fatigue, currentTelemetry.fatigueIndex),
      strainIndex: clampedStrainIndex,
      oversBowled: safeNum(activePlayer?.overs, 0),
      injuryRisk: String(activePlayer?.injuryRisk || riskAnalysis?.injuryRisk || 'LOW'),
      noBallRisk: String(activePlayer?.noBallRisk || riskAnalysis?.noBallRisk || 'LOW'),
    },
    {
      sleepHours: activePlayer?.sleepHours,
      recoveryMinutes: activePlayer?.recoveryTime,
      fatigueLimit: activePlayer?.baselineFatigue,
      baselineToday: activePlayer ? resolveFatigueFloor(activePlayer) : undefined,
    },
    players
  );
  const isBrokenTacticalText = (value: unknown): boolean => {
    const text = normalizeRecommendationText(value);
    return !text || /(?:\bof\.?$|\bof$| of and )/i.test(text) || isIncompleteCoachSentence(text);
  };
  const toCleanTacticalLines = (values: Array<unknown>, max = 3, fallback = 'Tactical recommendation updated.'): string[] =>
    values
      .map((entry) => finalizeCoachSentence(entry, fallback, 160))
      .filter((entry) => !isBrokenTacticalText(entry))
      .slice(0, max);
  const tacticalMatchSituationLines = toCleanTacticalLines(
    tacticalRecommendation.matchSituation,
    2,
    'Current phase is balanced; this over should be managed proactively.'
  );
  const tacticalAssessmentLines = toCleanTacticalLines(
    tacticalRecommendation.assessment,
    2,
    'Control can dip if workload pressure is not managed early in the phase.'
  );
  const tacticalAiAssessmentLine = finalizeCoachSentence(tacticalAnalysis?.assessment, '', 160);
  const tacticalAssessmentDisplayLines = (() => {
    const baseLines = tacticalAiAssessmentLine
      ? [tacticalAiAssessmentLine, ...tacticalAssessmentLines.filter((line) => line.toLowerCase() !== tacticalAiAssessmentLine.toLowerCase())]
      : tacticalAssessmentLines;
    if (runMode !== 'auto') return baseLines.slice(0, 2);
    const routingReason = finalizeCoachSentence(
      selectedAgentRoutingMeta.primaryReason,
      selectedAgentRoutingMeta.dominantDriver === 'risk'
        ? 'Safety and strain exposure are the dominant route driver in this run.'
        : selectedAgentRoutingMeta.dominantDriver === 'fatigue'
          ? 'Fatigue and workload accumulation are the dominant route driver in this run.'
          : 'Tactical continuity is the dominant route driver in this run.',
      150
    );
    if (!routingReason) return baseLines.slice(0, 2);
    const merged = [routingReason, ...baseLines.filter((line) => line.toLowerCase() !== routingReason.toLowerCase())];
    return merged.slice(0, 2);
  })();
  const tacticalWhyLines = toCleanTacticalLines(
    [
      ...(Array.isArray(tacticalAnalysis?.why) ? tacticalAnalysis.why : []),
      tacticalAnalysis?.rationale,
      ...tacticalRecommendation.whyThisIsSmart,
    ],
    3,
    'This move protects control and reduces the chance of workload escalation.'
  );
  const isBattingTacticalContext = focusRole === 'BATTER' || teamMode === 'BATTING';
  const tacticalAiDecision = finalizeCoachSentence(
    tacticalAnalysis?.decision || tacticalAnalysis?.nextAction,
    '',
    170
  );
  const tacticalRecommendedMove = finalizeCoachSentence(
    tacticalAiDecision || tacticalRecommendation.recommendedMove,
    isBattingTacticalContext
      ? 'Projected threshold-breach estimate unavailable; continue monitoring batting load versus baseline.'
      : 'Bring in the top-ranked fresh option for the next over.',
    160
  );
  const tacticalSwapReason = finalizeCoachSentence(
    tacticalAnalysis?.decisionRationale || tacticalRecommendation.swap.reason,
    isBattingTacticalContext
      ? 'Baseline comparison is currently limited; reassess batting continuation signals at over end.'
      : 'Next over: rotate to the recommended bowler and reassess immediately after.',
    160
  );
  const tacticalIfIgnored = finalizeCoachSentence(
    tacticalRecommendation.ifYouIgnore,
    isBattingTacticalContext
      ? 'Ignoring this adjustment may increase pressure and dismissal risk in the current phase.'
      : 'Continuing the current spell may increase fatigue-related performance drop.',
    160
  );
  const tacticalPriority: 'Stable' | 'Monitor' | 'Immediate' =
    tacticalRecommendation.priority || 'Monitor';
  const tacticalAvailabilityStatus:
    | 'AVAILABLE'
    | 'LIMITED'
    | 'TACTICAL_RISK'
    | 'UNAVAILABLE' = tacticalRecommendation.availabilityStatus || 'AVAILABLE';
  const tacticalDominantDriverFromRoute =
    runMode === 'auto' && tacticalRecommendation.dominantRiskDriver !== 'overs_quota_reached'
      ? selectedAgentRoutingMeta.dominantDriver === 'risk'
        ? 'injury'
        : selectedAgentRoutingMeta.dominantDriver === 'fatigue'
          ? 'fatigue'
          : null
      : null;
  const tacticalDominantDriver:
    | 'overs_quota_reached'
    | 'injury'
    | 'fatigue'
    | 'recovery'
    | 'control'
    | 'matchup'
    | 'pressure_phase'
    | 'mixed' = tacticalDominantDriverFromRoute || tacticalRecommendation.dominantRiskDriver || 'mixed';
  const tacticalDecisionMode:
    | 'IMMEDIATE_SUBSTITUTION'
    | 'ROTATE_NEXT_OVER'
    | 'SHORTEN_SPELL'
    | 'KEEP_BOWLING_WITH_ADJUSTMENT'
    | 'MATCHUP_CHANGE'
    | 'RECOVERY_ONLY'
    | 'KEEP_BATTING'
    | 'KEEP_BATTING_WITH_ADJUSTMENT'
    | 'ROTATE_STRIKE'
    | 'ATTACK_SPIN'
    | 'STABILIZE_INNINGS'
    | 'ROLE_CONTEXT_MISMATCH' =
      tacticalRecommendation.decisionMode || (focusRole === 'BATTER' ? 'KEEP_BATTING_WITH_ADJUSTMENT' : 'KEEP_BOWLING_WITH_ADJUSTMENT');
  const battingNextBatterInsight = isBattingTacticalContext
    ? (() => {
        const roleToken = (value: unknown): string => String(value || '').trim().toLowerCase();
        const activeKey = baselineKey(activePlayer?.id || activePlayer?.name || currentTelemetry.playerId || currentTelemetry.playerName);
        const phaseToken = String(matchContext.phase || '')
          .trim()
          .toLowerCase();
        const pressureGap =
          Number.isFinite(requiredRunRate) && Number.isFinite(currentRunRate)
            ? Math.max(0, Number(requiredRunRate) - Number(currentRunRate))
            : 0;
        const candidates = players.filter((player) => {
          const playerKey = baselineKey(player.id || player.name);
          const role = roleToken(player.role);
          const battingRole = role.includes('bat') || role.includes('all-round');
          return (
            battingRole &&
            player.inRoster !== false &&
            !player.isSub &&
            !player.isUnfit &&
            !player.isInjured &&
            playerKey !== activeKey
          );
        });
        if (candidates.length === 0) return null;
        const ranked = [...candidates]
          .map((player) => {
            const fatigueValue = clamp(safeNum(player.fatigue, 5), 0, 10);
            const strainValue = clamp(safeNum(player.strainIndex, 3), 0, 10);
            const powerValue = clamp(safeNum(player.power, 6), 0, 10);
            const controlValue = clamp(safeNum(player.controlBaseline, 72), 0, 100);
            const recoveryValue = clamp(safeNum(player.recoveryTime, 45), 0, 120);
            const baselineFatigue = Math.max(1, safeNum(player.baselineFatigue, 6));
            const fatigueHeadroom = clamp((baselineFatigue - fatigueValue) / baselineFatigue, -1, 1);
            const role = roleToken(player.role);
            const accelerationBoost =
              phaseToken.includes('death') || pressureGap >= 0.8
                ? powerValue * 0.95
                : phaseToken.includes('middle')
                  ? powerValue * 0.62
                  : controlValue * 0.14;
            const score =
              (10 - fatigueValue) * 2.3 +
              (10 - strainValue) * 1.6 +
              fatigueHeadroom * 4 +
              controlValue * 0.05 +
              recoveryValue * 0.03 +
              accelerationBoost +
              (role.includes('all-round') ? 0.8 : 0);
            return { player, score, powerValue, fatigueHeadroom };
          })
          .sort((a, b) => (b.score !== a.score ? b.score - a.score : a.player.name.localeCompare(b.player.name)));
        const top = ranked[0];
        if (!top) return null;
        const nextBatterName =
          resolveRosterName(top.player.id || top.player.name, top.player.name) || normalizeRecommendationText(top.player.name) || '';
        if (!nextBatterName) return null;
        const phaseReason = phaseToken.includes('death')
          ? 'death-overs acceleration'
          : phaseToken.includes('middle')
            ? 'middle-overs acceleration'
            : 'powerplay stability';
        const pressureReason = pressureGap >= 0.8 ? 'current run-rate pressure' : 'current run-rate demand';
        const headroomReason = top.fatigueHeadroom >= 0 ? 'better fatigue headroom' : 'manageable workload profile';
        const reason = `Best matchup for this phase with strong ${phaseReason}, ${headroomReason}, and support for ${pressureReason}.`;
        return { name: nextBatterName, reason };
      })()
    : null;
  const tacticalRecommendedReplacement = isBattingTacticalContext
    ? battingNextBatterInsight?.name || 'No recommendation available.'
    : finalizeCoachSentence(
        tacticalRecommendation.recommendedReplacement,
        tacticalRecommendation.swap?.in || 'No eligible replacement',
        120
      );
  const tacticalReplacementReason = isBattingTacticalContext ? battingNextBatterInsight?.reason || '' : '';
  const tacticalReplacementLabel = isBattingTacticalContext ? 'Next Batter If Wicket Falls' : 'Recommended Replacement';
  const tacticalNotFitToContinue = tacticalAvailabilityStatus === 'UNAVAILABLE';
  const tacticalSuggestedBenchOptions = Array.isArray(tacticalRecommendation.suggestedBenchOptions)
    ? tacticalRecommendation.suggestedBenchOptions.slice(0, 3)
    : [];
  const tacticalDecisionLabel = tacticalDominantDriver === 'overs_quota_reached'
    ? 'Select replacement bowler'
    : tacticalDecisionMode === 'ROLE_CONTEXT_MISMATCH'
      ? 'Awaiting role-consistent tactical recommendation'
      : tacticalDecisionMode.replace(/_/g, ' ');
  const tacticalDominantDriverLabel = tacticalDominantDriver === 'overs_quota_reached'
    ? 'Overs quota reached'
    : tacticalDominantDriver.replace(/_/g, ' ');
  const tacticalTradeoffLine = (() => {
    const aiTradeoff = finalizeCoachSentence(tacticalAnalysis?.tradeoff, '', 200);
    if (aiTradeoff) return aiTradeoff;
    const fallback = 'Tradeoff: decision primarily guided by current match phase and baseline performance signals.';
    const phaseToken = String(matchContext.phase || '').trim().toLowerCase();
    const phaseContext = phaseToken ? `${phaseToken} phase` : 'current phase';
    const fatigueValue = safeNum(activePlayer?.fatigue, currentTelemetry.fatigueIndex);
    const fatigueBaseline = safeNum(activePlayer?.baselineFatigue, Number.NaN);
    const hasBaseline = Number.isFinite(fatigueBaseline) && fatigueBaseline > 0;
    const fatigueDelta = hasBaseline ? fatigueValue - fatigueBaseline : Number.NaN;
    const runRateGap =
      Number.isFinite(requiredRunRate) && Number.isFinite(currentRunRate)
        ? Number(requiredRunRate) - Number(currentRunRate)
        : Number.NaN;
    const chasePressureHigh = Number.isFinite(runRateGap) && runRateGap > 0.8;
    if (!hasBaseline && !Number.isFinite(runRateGap)) return fallback;

    if (isBattingTacticalContext) {
      if (activeDismissalStatus === 'OUT' || ballsFaced === 0) return fallback;
      if (tacticalPriority === 'Immediate' || tacticalAvailabilityStatus === 'TACTICAL_RISK') {
        return finalizeCoachSentence(
          `Tradeoff: fatigue drift is challenging batting continuity, but in the ${phaseContext} exposing a new batter under ${chasePressureHigh ? 'high' : 'current'} run-rate pressure may carry greater dismissal risk.`,
          fallback,
          200
        );
      }
      if (chasePressureHigh) {
        return finalizeCoachSentence(
          `Tradeoff: acceleration is needed in the ${phaseContext}, but wicket context still favors keeping the current batter while fatigue remains near baseline limits.`,
          fallback,
          200
        );
      }
      return finalizeCoachSentence(
        `Tradeoff: reaction stability is drifting mildly, yet retaining current batting continuity in the ${phaseContext} offers better value than forcing a change before baseline limits are approached.`,
        fallback,
        200
      );
    }

    if (tacticalPriority === 'Immediate' || tacticalDominantDriver === 'fatigue' || tacticalDominantDriver === 'recovery') {
      return finalizeCoachSentence(
        'Tradeoff: fatigue and control drift now outweigh matchup upside, so rotation is the safer choice for maintaining execution quality.',
        fallback,
        200
      );
    }
    if (phaseToken.includes('death') && tacticalPriority !== 'Immediate') {
      return finalizeCoachSentence(
        'Tradeoff: fatigue risk is rising, but death-phase leverage and baseline control still justify one controlled continuation.',
        fallback,
        200
      );
    }
    return fallback;
  })();
  const copilotTacticalRecommendationState = useMemo(() => {
    const outgoing = String(tacticalRecommendation.swap?.out || activePlayer?.name || currentTelemetry.playerName || '').trim();
    const incoming = String(tacticalRecommendation.swap?.in || '').trim();
    const state: Record<string, unknown> = {
      recommendedOutgoingPlayer: outgoing || undefined,
      recommendedReplacementPlayer: outgoing || undefined,
      recommendedIncomingPlayer: incoming || undefined,
      recommendedMove: tacticalRecommendedMove,
      tacticalPlan: tacticalSwapReason,
      assessment: tacticalAssessmentDisplayLines.join(' '),
      tradeoff: tacticalTradeoffLine,
      whyThisIsSmart: tacticalWhyLines.join(' '),
      riskIfIgnored: tacticalIfIgnored,
      confidence: tacticalRecommendation.confidence,
      matchSituation: tacticalMatchSituationLines.join(' '),
      priority: tacticalPriority,
      availabilityStatus: tacticalAvailabilityStatus,
      dominantRiskDriver: tacticalDominantDriver,
      decisionMode: tacticalDecisionMode,
      substitutionRequired: tacticalRecommendation.substitutionRequired === true,
      recommendedReplacement: tacticalRecommendedReplacement,
      suggestedBenchOptions: tacticalSuggestedBenchOptions,
      reason: tacticalWhyLines[0] || tacticalAssessmentDisplayLines[0] || tacticalRecommendedMove,
      fatigueIndex: safeNum(activePlayer?.fatigue, currentTelemetry.fatigueIndex),
      riskLevel:
        tacticalPriority === 'Immediate'
          ? 'High'
          : tacticalPriority === 'Monitor'
            ? 'Moderate'
            : 'Low',
    };
    return state;
  }, [
    activePlayer?.fatigue,
    activePlayer?.name,
    currentTelemetry.fatigueIndex,
    currentTelemetry.playerName,
    tacticalAssessmentDisplayLines,
    tacticalIfIgnored,
    tacticalMatchSituationLines,
    tacticalAvailabilityStatus,
    tacticalDecisionMode,
    tacticalDominantDriver,
    tacticalPriority,
    tacticalSuggestedBenchOptions,
    tacticalRecommendation.confidence,
    tacticalRecommendation.substitutionRequired,
    tacticalRecommendedReplacement,
    tacticalRecommendation.swap?.in,
    tacticalRecommendation.swap?.out,
    tacticalRecommendedMove,
    tacticalSwapReason,
    tacticalTradeoffLine,
    tacticalWhyLines,
  ]);
  const tacticalPriorityBadgeClass =
    tacticalPriority === 'Immediate'
      ? 'border-rose-400/45 bg-rose-500/15 text-rose-100'
      : tacticalPriority === 'Monitor'
        ? 'border-amber-400/45 bg-amber-500/15 text-amber-100'
        : 'border-emerald-400/45 bg-emerald-500/15 text-emerald-100';
  const tacticalCardGlowTarget =
    tacticalPriority === 'Immediate'
      ? '0 0 0 1px rgba(45,212,191,0.40), 0 0 22px rgba(45,212,191,0.28), 0 10px 28px rgba(8,47,73,0.38)'
      : tacticalPriority === 'Monitor'
        ? '0 0 0 1px rgba(45,212,191,0.32), 0 0 18px rgba(45,212,191,0.22), 0 10px 24px rgba(8,47,73,0.34)'
        : '0 0 0 1px rgba(45,212,191,0.24), 0 0 14px rgba(45,212,191,0.16), 0 10px 20px rgba(8,47,73,0.30)';
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
  const showWhyThisDecision = !isFullAnalysis && routerDecisionForView?.mode !== 'full';
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
  const briefingText = [
    'AI Strategic Analysis',
    '',
    ...(isFullAnalysis && combinedBriefing
      ? ['Coach Briefing:', combinedBriefing, '']
      : []),
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
    `MATCH SITUATION: ${tacticalMatchSituationLines.join(' ')}`,
    `ASSESSMENT: ${tacticalAssessmentDisplayLines.join(' ')}`,
    `RECOMMENDED MOVE: ${tacticalRecommendedMove || `Bring in ${tacticalRecommendation.swap.in} for ${tacticalRecommendation.swap.out}.`}`,
    'WHY THIS WORKS:',
    ...(tacticalWhyLines.map((item) => `- ${item}`)),
    `IF YOU IGNORE: ${tacticalIfIgnored || 'Tactical output unavailable. Please rerun analysis.'}`,
    `CONFIDENCE: ${tacticalRecommendation.confidence}`,
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
  const copilotSectionStyle: React.CSSProperties = {
    marginTop: '28px',
    borderRadius: '20px',
    background: 'linear-gradient(180deg, rgba(10,24,52,0.96) 0%, rgba(9,22,46,0.98) 100%)',
    border: '1px solid rgba(110, 160, 255, 0.10)',
    boxShadow: '0 16px 40px rgba(0,0,0,0.34), 0 0 0 1px rgba(110,160,255,0.05), inset 0 1px 0 rgba(255,255,255,0.02)',
    padding: '28px',
    overflow: 'hidden',
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
  useEffect(() => {
    if (!nextBatterNotice) return;
    const timeoutId = window.setTimeout(() => setNextBatterNotice(null), 2600);
    return () => window.clearTimeout(timeoutId);
  }, [nextBatterNotice]);
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
              onClick={() => runBowlingGuardedAction(() => applyStrainDelta(1, 0.3))}
              disabled={isStrainMax}
              className={`${strainButtonBase} bg-emerald-500/10 border border-emerald-400/30 text-emerald-200 hover:bg-emerald-500/20 hover:border-emerald-400/60 hover:shadow-[0_0_18px_rgba(16,185,129,0.25)] focus-visible:ring-emerald-400/45`}
            >
              Minor
            </button>
            <button
              type="button"
              onClick={() => runBowlingGuardedAction(() => applyStrainDelta(2, 0.8))}
              disabled={isStrainMax}
              className={`${strainButtonBase} bg-emerald-500/15 border border-emerald-400/40 text-white hover:bg-emerald-500/25 hover:shadow-[0_0_22px_rgba(16,185,129,0.35)] focus-visible:ring-emerald-400/45`}
            >
              Heavy
            </button>
            <button
              type="button"
              onClick={() => runBowlingGuardedAction(handleResetStrain)}
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
    pendingMatchModeRequiredRef.current = 'BATTING';
    setMatchModeGuardContent(null);
    setShowMatchModeGuard(false);
  }, []);

  const closeBowlingCoachModeGuard = useCallback(() => {
    pendingBowlingCoachActionRef.current = null;
    setBowlingCoachModeGuardContent(null);
    setShowBowlingCoachModeGuard(false);
  }, []);

  const requireMatchMode = useCallback(
    (requiredMode: TeamMode, onAllowed: () => void) => {
      if (teamMode === requiredMode) {
        onAllowed();
        return true;
      }
      pendingMatchModeActionRef.current = onAllowed;
      pendingMatchModeRequiredRef.current = requiredMode;
      if (requiredMode === 'BOWLING') {
        setMatchModeGuardContent({
          title: 'Bowling actions locked',
          message: 'Bowling actions are locked while match state is Batting. Switch match state to Bowling to continue.',
          confirmLabel: 'Switch to Bowling',
        });
      } else {
        setMatchModeGuardContent({
          title: 'Batting actions locked',
          message: 'Batting actions are locked while match state is Bowling. Switch match state to Batting to continue.',
          confirmLabel: 'Switch to Batting',
        });
      }
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

  const runBowlingGuardedAction = useCallback(
    (onAllowed: () => void) => {
      requireMatchMode('BOWLING', onAllowed);
    },
    [requireMatchMode]
  );

  const handleSwitchToBattingAndContinue = useCallback(() => {
    const pendingAction = pendingMatchModeActionRef.current;
    const requiredMode = pendingMatchModeRequiredRef.current;
    pendingMatchModeActionRef.current = null;
    pendingMatchModeRequiredRef.current = 'BATTING';
    setMatchModeGuardContent(null);
    setShowMatchModeGuard(false);
    setTeamMode(requiredMode);
    if (pendingAction) {
      requestAnimationFrame(() => pendingAction());
    }
  }, [setTeamMode]);

  const handleSwitchToBowlingAndRunCoach = useCallback(() => {
    const pendingAction = pendingBowlingCoachActionRef.current;
    pendingBowlingCoachActionRef.current = null;
    setBowlingCoachModeGuardContent(null);
    setShowBowlingCoachModeGuard(false);
    setTeamMode('BOWLING');
    if (pendingAction) {
      requestAnimationFrame(() => pendingAction());
    }
  }, [setTeamMode]);

  // Shared mode gate for coach runs: enforce panel-required mode, prompt switch, then run once on confirm.
  const guardModeAndRun = useCallback(
    ({
      requiredMode,
      sourcePanel,
      runFn,
    }: {
      requiredMode: TeamMode;
      sourcePanel: 'Batters UI' | 'Bowlers UI';
      runFn: () => void;
    }): boolean => {
      if (agentState === 'thinking') return false;
      if (showMatchModeGuard || showBowlingCoachModeGuard) return false;
      if (pendingMatchModeActionRef.current || pendingBowlingCoachActionRef.current) return false;

      if (teamMode === requiredMode) {
        runFn();
        return true;
      }

      const title = requiredMode === 'BATTING' ? 'Switch to Batting Mode?' : 'Switch to Bowling Mode?';
      const message = `You’re currently in ${teamMode}. To run this analysis from the ${sourcePanel}, switch to ${requiredMode}.`;

      if (requiredMode === 'BATTING') {
        pendingMatchModeActionRef.current = runFn;
        setMatchModeGuardContent({ title, message, confirmLabel: 'Switch & Run' });
        setShowMatchModeGuard(true);
      } else {
        pendingBowlingCoachActionRef.current = runFn;
        setBowlingCoachModeGuardContent({ title, message, confirmLabel: 'Switch & Run' });
        setShowBowlingCoachModeGuard(true);
      }
      return false;
    },
    [agentState, showMatchModeGuard, showBowlingCoachModeGuard, teamMode]
  );

  const runCoachAgentAuto = useCallback(
    async (modeOverride?: TeamMode) => {
      playerSwitchResetRef.current = false;
      const resolvedMode = modeOverride || teamMode;
      const resolvedFocusRole: 'BOWLER' | 'BATTER' = resolvedMode === 'BATTING' ? 'BATTER' : 'BOWLER';
      pendingAnalysisSnapshotRef.current = normalizeAnalysisInputs({
        ...analysisInputSnapshot,
        matchMode: resolvedMode,
      });
      setShowCoachInsights(true);
      primeCoachAutoScroll();
      return runAgent('auto', 'button_click', {
        teamMode: resolvedMode,
        focusRole: resolvedFocusRole,
        strainIndex: clampedStrainIndex,
      });
    },
    [analysisInputSnapshot, clampedStrainIndex, primeCoachAutoScroll, runAgent, teamMode]
  );

  const eligibleReplacementBatters = useMemo(
    () => {
      const activeIdKey = baselineKey(activePlayer?.id || '');
      return players.filter((player) => {
        if (player.inRoster === false) return false;
        if (!isEligibleForMode(player, 'BATTING')) return false;
        if (baselineKey(player.id) === activeIdKey) return false;
        if (resolveDismissalStatus(player) === 'OUT') return false;
        if (player.isUnfit || player.isManuallyUnfit || player.isInjured) return false;
        return true;
      });
    },
    [activePlayer?.id, players]
  );

  const rankFallbackNextBatter = useCallback((candidates: Player[]): SuggestedBowlerRecommendation | null => {
    if (candidates.length === 0) return null;
    const normalizeSkillScore = (value: unknown, fallback: number): number => {
      const metric = Math.max(0, safeNum(value, fallback));
      return metric > 10 ? clamp(metric / 100, 0, 1) : clamp(metric / 10, 0, 1);
    };
    const pressureGap = Math.max(0, requiredRunRate - currentRunRate);
    const needsAcceleration =
      pressureGap > 0.6 || pressureIndex >= 6 || matchContext.phase === 'Death';
    const wicketsUnderPressure = matchState.wickets >= 5;

    const scored = candidates
      .map((player) => {
        const fatigueScore = 1 - clamp(safeNum(player.fatigue, 5) / 10, 0, 1);
        const recoveryScore =
          player.hrRecovery === 'Good' ? 1 : player.hrRecovery === 'Moderate' ? 0.6 : 0.35;
        const controlScore = normalizeSkillScore(player.controlBaseline, 76);
        const powerScore = normalizeSkillScore(player.power, 6);
        const speedScore = normalizeSkillScore(player.speed, 6);
        const riskPenalty =
          player.injuryRisk === 'Critical' || player.injuryRisk === 'High'
            ? 0.2
            : player.injuryRisk === 'Medium'
              ? 0.08
              : 0;
        const accelerationScore = (powerScore * 0.58) + (speedScore * 0.22) + (controlScore * 0.2);
        const stabilityScore = (controlScore * 0.5) + (fatigueScore * 0.35) + (recoveryScore * 0.15);
        const styleScore = needsAcceleration
          ? (accelerationScore * 0.62) + (stabilityScore * 0.38)
          : wicketsUnderPressure
            ? (stabilityScore * 0.72) + (accelerationScore * 0.28)
            : (stabilityScore * 0.56) + (accelerationScore * 0.44);
        const readinessScore = (fatigueScore * 0.6) + (recoveryScore * 0.4);
        const totalScore = styleScore + (readinessScore * 0.35) - riskPenalty;
        return { player, totalScore };
      })
      .sort((a, b) => {
        if (b.totalScore !== a.totalScore) return b.totalScore - a.totalScore;
        return a.player.name.localeCompare(b.player.name);
      });

    const best = scored[0]?.player;
    if (!best) return null;
    const reason = needsAcceleration
      ? `Best fit for the ${matchContext.phase.toLowerCase()} phase and target pace.`
      : wicketsUnderPressure
        ? 'Best fit to stabilize scoring while preserving wickets.'
        : 'Best fit for current pressure and tactical batting continuity.';
    return {
      bowlerId: best.id,
      bowlerName: best.name,
      reason,
    };
  }, [currentRunRate, matchContext.phase, matchState.wickets, pressureIndex, requiredRunRate]);

  const runCoachWithFallback = useCallback(async (
    mode: TeamMode = 'BOWLING'
  ): Promise<{ recommendation: SuggestedBowlerRecommendation | null; raw?: OrchestrateResponse }> => {
    const logPrefix = mode === 'BATTING' ? 'next-batter' : 'rotate-bowler';
    if (import.meta.env.DEV) {
      console.log(`[${logPrefix}] click`);
    }

    const routeResult = await runCoachAgentAuto(mode);
    const routeSuggestion =
      routeResult?.suggestedBowler
      || (routeResult?.response ? normalizeSuggestedBowler(routeResult.response, players, activePlayer?.id, mode) : null);
    if (routeResult?.response && routeSuggestion) {
      return { recommendation: routeSuggestion, raw: routeResult.response };
    }

    if (import.meta.env.DEV) {
      console.log(`[${logPrefix}] falling back to full analysis`);
    }

    pendingAnalysisSnapshotRef.current = normalizeAnalysisInputs({
      ...analysisInputSnapshot,
      matchMode: mode,
    });
    const fullResult = await runAgent('full', 'button_click', {
      teamMode: mode,
      focusRole: mode === 'BATTING' ? 'BATTER' : 'BOWLER',
      strainIndex: clampedStrainIndex,
    });
    const fullSuggestion =
      fullResult?.suggestedBowler
      || (fullResult?.response ? normalizeSuggestedBowler(fullResult.response, players, activePlayer?.id, mode) : null);
    if (fullResult?.response && fullSuggestion) {
      return { recommendation: fullSuggestion, raw: fullResult.response };
    }

    return { recommendation: null, raw: fullResult?.response || routeResult?.response };
  }, [activePlayer?.id, analysisInputSnapshot, clampedStrainIndex, players, runAgent, runCoachAgentAuto]);

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

  const closeNextBatterConfirm = useCallback(() => {
    setShowNextBatterConfirm(false);
    setRecommendedNextBatter(null);
  }, []);

  const confirmNextBatterSwitch = useCallback(() => {
    if (!recommendedNextBatter) return;
    const suggestedIdKey = baselineKey(recommendedNextBatter.bowlerId);
    const suggestedNameKey = baselineKey(recommendedNextBatter.bowlerName);
    const resolvedPlayer =
      players.find((player) => baselineKey(player.id) === suggestedIdKey)
      || players.find((player) => baselineKey(player.name) === suggestedNameKey);
    const suggestedPlayer =
      resolvedPlayer &&
      eligibleReplacementBatters.some((candidate) => baselineKey(candidate.id) === baselineKey(resolvedPlayer.id))
        ? resolvedPlayer
        : null;

    if (!suggestedPlayer) {
      setNextBatterNotice('No eligible replacement batter available.');
      closeNextBatterConfirm();
      return;
    }

    if (activePlayer && baselineKey(activePlayer.id) === baselineKey(suggestedPlayer.id)) {
      setNextBatterNotice('Already selected.');
      closeNextBatterConfirm();
      return;
    }

    setTeamMode('BATTING');
    setActivePlayerId(suggestedPlayer.id);
    setNextBatterNotice(`Switched to ${suggestedPlayer.name}.`);
    closeNextBatterConfirm();
  }, [
    activePlayer,
    closeNextBatterConfirm,
    eligibleReplacementBatters,
    players,
    recommendedNextBatter,
    setActivePlayerId,
    setTeamMode,
  ]);

  const handleSuggestNextBatter = useCallback(async () => {
    if (isSuggestingNextBatter || agentState === 'thinking') return;
    setNextBatterNotice(null);
    setShowNextBatterConfirm(false);
    setRecommendedNextBatter(null);

    if (eligibleReplacementBatters.length === 0) {
      setNextBatterNotice('No eligible replacement batter available.');
      return;
    }

    setIsSuggestingNextBatter(true);
    try {
      const coachResult = await runCoachWithFallback('BATTING');
      const eligibleIdKeys = new Set(eligibleReplacementBatters.map((player) => baselineKey(player.id)));
      let suggestion = coachResult.recommendation;

      if (suggestion) {
        const resolved = resolveSuggestionPlayer(suggestion, players);
        const resolvedIdKey = baselineKey(resolved?.id || '');
        if (!resolved || !eligibleIdKeys.has(resolvedIdKey)) {
          suggestion = null;
        }
      }

      if (!suggestion) {
        suggestion = rankFallbackNextBatter(eligibleReplacementBatters);
      }

      if (!suggestion) {
        setNextBatterNotice('No eligible replacement batter available.');
        return;
      }

      setRecommendedNextBatter(suggestion);
      setShowNextBatterConfirm(true);
    } catch (error) {
      if (import.meta.env.DEV) {
        console.error('[next-batter] suggest failed', error);
      }
      setNextBatterNotice('Unable to generate next batter recommendation right now.');
    } finally {
      setIsSuggestingNextBatter(false);
    }
  }, [
    agentState,
    eligibleReplacementBatters,
    isSuggestingNextBatter,
    players,
    rankFallbackNextBatter,
    runCoachWithFallback,
  ]);

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

    const coachResult = await runCoachWithFallback('BOWLING');
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

  const blockCoachForModeMismatch = useCallback((): boolean => {
    const selectedRole = String(activePlayer?.role || currentTelemetry.role || '').trim().toLowerCase();
    const isAllRounder = selectedRole.includes('all-rounder') || selectedRole.includes('all rounder');
    const isBowlerRole = selectedRole.includes('bowler') || selectedRole.includes('spinner') || selectedRole.includes('fast');
    const isBatterRole = selectedRole.includes('batter') || selectedRole.includes('batsman');
    if (!isAllRounder && teamMode === 'BATTING' && isBowlerRole) {
      setShowCoachInsights(true);
      setAgentFailure(null);
      setAgentWarning('Switch to BOWLING to run Bowler Coach Analysis.');
      return true;
    }
    if (!isAllRounder && teamMode === 'BOWLING' && isBatterRole) {
      setShowCoachInsights(true);
      setAgentFailure(null);
      setAgentWarning('Switch to BATTING to run Batter Coach Analysis.');
      return true;
    }
    return false;
  }, [activePlayer?.role, currentTelemetry.role, teamMode]);

  const handleRunCoachAuto = useCallback(() => {
    try {
      const selectedPlayerId = activePlayer?.id || currentTelemetry.playerId;
      // console.log('[coach] click', { matchState: teamMode, selectedPlayerId, selectedRole: String(activePlayer?.role || currentTelemetry.role || '') });
      if (!selectedPlayerId) {
        setShowCoachInsights(true);
        setAgentFailure(null);
        setAgentWarning('Select a player to run analysis.');
        return;
      }
      pendingBowlingCoachActionRef.current = null;
      setShowBowlingCoachModeGuard(false);
      setAgentWarning(null);
      setAgentFailure(null);
      const requiredMode: TeamMode = focusRole === 'BATTER' ? 'BATTING' : 'BOWLING';
      const sourcePanel: 'Batters UI' | 'Bowlers UI' = requiredMode === 'BATTING' ? 'Batters UI' : 'Bowlers UI';
      guardModeAndRun({
        requiredMode,
        sourcePanel,
        runFn: () => {
          void runCoachAgentAuto(requiredMode);
        },
      });
    } catch {
      setShowCoachInsights(true);
      setAgentFailure(null);
      setAgentWarning('Unable to run analysis right now. Please try again.');
    }
  }, [activePlayer?.id, currentTelemetry.playerId, focusRole, guardModeAndRun, runCoachAgentAuto, setAgentFailure, setAgentWarning, teamMode]);

  const handleRunCoachFull = useCallback((event?: React.MouseEvent<HTMLButtonElement>) => {
    const selectedPlayerId = activePlayer?.id || currentTelemetry.playerId;
    const isRunning = agentState === 'thinking';
    console.log('[coach] click', { mode: 'full', matchState: teamMode, selectedPlayerId, isRunning });
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    if (!selectedPlayerId) {
      setShowCoachInsights(true);
      setAgentFailure(null);
      setAgentWarning('Select a player to run analysis.');
      return;
    }
    const execute = (modeOverride: TeamMode) => {
      playerSwitchResetRef.current = false;
      const resolvedFocusRole: 'BOWLER' | 'BATTER' = modeOverride === 'BATTING' ? 'BATTER' : 'BOWLER';
      pendingAnalysisSnapshotRef.current = normalizeAnalysisInputs({
        ...analysisInputSnapshot,
        matchMode: modeOverride,
      });
      setShowCoachInsights(true);
      setShowFullAnalysisInfo(false);
      setShowDismissAnalysisInfo(false);
      setFullAnalysisRunPending(true);
      primeCoachAutoScroll();
      void runAgent('full', 'button_click', {
        teamMode: modeOverride,
        focusRole: resolvedFocusRole,
        strainIndex: clampedStrainIndex,
      });
    };
    const requiredMode: TeamMode = focusRole === 'BATTER' ? 'BATTING' : 'BOWLING';
    const sourcePanel: 'Batters UI' | 'Bowlers UI' = requiredMode === 'BATTING' ? 'Batters UI' : 'Bowlers UI';
    guardModeAndRun({
      requiredMode,
      sourcePanel,
      runFn: () => execute(requiredMode),
    });
  }, [activePlayer?.id, agentState, analysisInputSnapshot, clampedStrainIndex, currentTelemetry.playerId, focusRole, guardModeAndRun, primeCoachAutoScroll, runAgent, teamMode]);

  // Auto-follow new analysis output while user is near the bottom.
  useEffect(() => {
    if (!isCoachOutputState) return;
    if (!stickToBottomRef.current) return;
    scrollCoachOutputToBottom('smooth');
  }, [agentState, aiAnalysis, riskAnalysis, tacticalAnalysis, strategicAnalysis, combinedAnalysis, combinedDecision, finalRecommendation, orchestrateMeta, agentWarning, substitutionRecommendation, isCoachOutputState]);

  // CTA state machine: run -> current -> stale refresh.
  const fullAnalysisIsRunning = agentState === 'thinking' || fullAnalysisRunPending;
  const shouldShowRunFullAnalysis =
    !fullAnalysisIsRunning && (!fullAnalysisExecuted || !hasCompleteFullCombinedAnalysis);
  const fullAnalysisNeedsRefresh = fullAnalysisExecuted && analysisStale;
  const fullAnalysisUpToDate =
    fullAnalysisExecuted && !analysisStale && !fullAnalysisIsRunning && hasCompleteFullCombinedAnalysis;
  const fullAnalysisCtaLabel = fullAnalysisIsRunning
    ? 'Refreshing Analysis...'
    : shouldShowRunFullAnalysis
      ? 'Run Full Combined Analysis'
      : fullAnalysisNeedsRefresh
        ? 'Refresh Combined Analysis'
        : 'Analysis Up to Date';
  const fullAnalysisCtaDisabled = fullAnalysisIsRunning || fullAnalysisUpToDate;
  const fullAnalysisCtaStyle: React.CSSProperties = fullAnalysisIsRunning
    ? {
        background: 'rgba(15, 23, 42, 0.7)',
        border: '1px solid rgba(100, 116, 139, 0.55)',
        color: 'rgba(148, 163, 184, 0.9)',
        boxShadow: 'none',
        backdropFilter: 'blur(6px)',
      }
    : fullAnalysisUpToDate
      ? {
          background: 'rgba(30, 41, 59, 0.6)',
          border: '1px solid rgba(100, 116, 139, 0.45)',
          color: 'rgba(203, 213, 225, 0.9)',
          boxShadow: 'none',
          backdropFilter: 'blur(6px)',
        }
      : {
          background: 'linear-gradient(135deg, rgba(160,60,72,0.42), rgba(138,48,66,0.48))',
          border: '1px solid rgba(220,120,140,0.38)',
          color: '#ffffff',
          boxShadow: '0 8px 20px rgba(120,40,60,0.18)',
          backdropFilter: 'blur(6px)',
        };

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
           <span
             className="flex items-center gap-1.5"
             style={{ marginLeft: '-6px', marginRight: '10px' }}
           >
             OVER
             <input
               type="number"
               min={0}
               max={resolvedTotalOvers}
               step="0.1"
               value={currentOverDisplay}
               onChange={(e) => {
                 const nextBalls = Math.min(totalBalls, oversToBalls(e.target.value));
                 updateMatchState({ ballsBowled: nextBalls });
               }}
               className="over-input w-[90px] min-w-[90px] bg-slate-900/40 border border-white/10 rounded px-1.5 py-0.5 font-mono text-slate-200 text-center focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
               aria-label="Current over"
             />
             /
             <span className="w-12 bg-slate-900/40 border border-white/10 rounded px-1.5 py-0.5 font-mono text-slate-200 text-center">{resolvedTotalOvers}</span>
             <span className="text-slate-500 ml-3">balls</span>
             <input
               type="number"
               min={0}
               max={totalBalls}
               step="1"
               value={ballsBowled}
               onChange={(e) => {
                 const nextBalls = Math.max(0, Number(e.target.value) || 0);
                 updateMatchState({ ballsBowled: Math.min(totalBalls, nextBalls) });
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
                          <div className="flex flex-wrap items-center justify-start gap-4">
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

                            <button
                              type="button"
                              onClick={() => runBattingGuardedAction(() => {
                                void handleSuggestNextBatter();
                              })}
                              disabled={isSuggestingNextBatter || agentState === 'thinking'}
                              className={`dismissal-pill ${pill} ${isSuggestingNextBatter || agentState === 'thinking' ? 'opacity-60 cursor-not-allowed' : ''}`}
                            >
                              {isSuggestingNextBatter ? 'Analyzing...' : 'AI Suggest Next Batter'}
                            </button>
                          </div>
                          {nextBatterNotice && (
                            <p className="text-[11px] text-amber-300">{nextBatterNotice}</p>
                          )}
                        </div>
                      </div>
                    </PanelCard>

                    {shouldShowTelemetryGraph && (
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
                    {shouldRenderCopilotUnderGraph && (
                      <div className="md:col-span-2" style={copilotSectionStyle}>
                        <CopilotChatPanel
                          analysisReady={combinedAnalysisActive}
                          analysisId={effectiveCopilotAnalysisId || analysisBundleId}
                          analysisExecuted={analysisExecuted}
                          analysisStale={analysisStale}
                          resetKey={copilotResetKey}
                          suggestedQuestions={copilotSuggestedQuestions}
                          fallbackContext={copilotFallbackContext}
                          tacticalRecommendationState={copilotTacticalRecommendationState}
                          forceFallbackMode={copilotFallbackMode}
                          onAnalysisIdSync={(analysisId) => {
                            setCopilotSessionAnalysisId(analysisId);
                            setCopilotVerifiedAnalysisId(String(analysisId || '').trim());
                          }}
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
                            onClick={() => runBowlingGuardedAction(handleDecreaseOver)}
                            disabled={activePlayer.isSub || activePlayer.isUnfit}
                            className={`w-12 h-12 rounded-full flex items-center justify-center border transition-all ${activePlayer.isSub || activePlayer.isUnfit ? 'bg-slate-800/50 text-slate-600 border-slate-800 cursor-not-allowed' : 'cursor-pointer bg-slate-800 hover:bg-slate-700 text-white border-slate-600'}`}
                          >
                            <Minus className="w-6 h-6" />
                          </button>
                          <button type="button"
                            onClick={() => runBowlingGuardedAction(handleAddOver)}
                            disabled={isMedicalCritical || activePlayer.isSub || activePlayer.isUnfit || atOversCap || isInningsFinished}
                            className={`w-12 h-12 rounded-full flex items-center justify-center shadow-lg transition-all ${isMedicalCritical || activePlayer.isSub || activePlayer.isUnfit || atOversCap || isInningsFinished ? 'bg-slate-800/50 text-slate-600 cursor-not-allowed shadow-none opacity-40' : 'cursor-pointer bg-emerald-600 hover:bg-emerald-500 text-white shadow-emerald-500/20'}`}
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
                        <p className="text-[11px] text-slate-500 mt-1">
                          Baseline today: {resolveFatigueFloor(activePlayer).toFixed(1)}
                        </p>
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
                            onClick={() => runBowlingGuardedAction(() => setRecoveryMode('auto'))}
                            className={`px-2 py-1 text-xs font-bold rounded ${recoveryMode === 'auto' ? 'bg-slate-700 text-white' : 'text-slate-400'}`}
                          >
                            Auto
                          </button>
                          <button
                            type="button"
                            onClick={() => runBowlingGuardedAction(() => setRecoveryMode('manual'))}
                            className={`px-2 py-1 text-xs font-bold rounded ${recoveryMode === 'manual' ? 'bg-slate-700 text-white' : 'text-slate-400'}`}
                          >
                            Manual
                          </button>
                        </div>
                      </div>
                      <select
                        value={recoveryMode === 'manual' ? manualRecovery : activePlayer.hrRecovery}
                        onChange={(e) => runBowlingGuardedAction(() => setManualRecovery(e.target.value as RecoveryLevel))}
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
                      <button type="button" onClick={() => runBowlingGuardedAction(handleMarkUnfit)} className={`border p-4 rounded-lg transition-all flex flex-col items-center group shadow-lg ${activePlayer.isUnfit ? 'bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 border-emerald-500/30 shadow-emerald-900/10' : 'bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 border-rose-500/30 shadow-rose-900/10'}`}>
                        <Zap className="w-5 h-5 mb-0.5" />
                        <span className="text-sm font-bold">{activePlayer.isUnfit ? 'Mark Fit' : 'Mark Unfit'}</span>
                        <span className="text-[10px] opacity-70">{activePlayer.isUnfit ? 'Restore player state' : 'Force critical state'}</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => runBowlingGuardedAction(() => {
                          void handleRotateBowler();
                        })}
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
                        onClick={() => runBowlingGuardedAction(handleRest)}
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

                  {shouldShowTelemetryGraph && (
                    <div className="mt-6">
                      <FatigueForecastChart
                        currentFatigue={activePlayer.fatigue}
                        strainIndex={safeNum(activePlayer.strainIndex, 0)}
                        oversBowled={safeNum(activePlayer.overs, 0)}
                        currentInjuryRisk={activePlayer.injuryRisk}
                        currentNoBallRisk={activePlayer.noBallRisk}
                        playerStatus={activePlayer.isUnfit ? 'UNFIT' : activePlayer.status}
                        matchFormat={matchContext.format}
                        intensity={matchContext.pitch || matchContext.phase || 'Medium'}
                        heartRateRecovery={activePlayer.hrRecovery ?? 'Good'}
                      />
                    </div>
                  )}
                  {shouldRenderCopilotUnderGraph && (
                    <div style={copilotSectionStyle}>
                      <CopilotChatPanel
                        analysisReady={combinedAnalysisActive}
                        analysisId={effectiveCopilotAnalysisId || analysisBundleId}
                        analysisExecuted={analysisExecuted}
                        analysisStale={analysisStale}
                        resetKey={copilotResetKey}
                        suggestedQuestions={copilotSuggestedQuestions}
                        fallbackContext={copilotFallbackContext}
                        tacticalRecommendationState={copilotTacticalRecommendationState}
                        forceFallbackMode={copilotFallbackMode}
                        onAnalysisIdSync={(analysisId) => {
                          setCopilotSessionAnalysisId(analysisId);
                          setCopilotVerifiedAnalysisId(String(analysisId || '').trim());
                        }}
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

            <div className={`${isCoachOutputState ? 'min-h-0 flex flex-col px-6 py-5' : 'flex-1 min-h-0 flex flex-col px-6 py-5'}`}>
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
                        {routerStatusHint && (
                          <div className="rounded-md border border-slate-700 bg-slate-900/30 px-3 py-2">
                            <div className="flex items-center gap-2">
                              <span className={`inline-block h-1.5 w-1.5 rounded-full ${routerStatusHint.dotClass}`} />
                              <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold tracking-wide ${routerStatusHint.toneClass}`}>
                                {routerStatusHint.label}
                              </span>
                            </div>
                            <p className="text-[11px] text-slate-300 mt-1">{routerStatusHint.engagedLine}</p>
                            {analysisRunModeLine && (
                              <p className="text-[11px] text-slate-400 mt-1">{analysisRunModeLine}</p>
                            )}
                            {analysisAgentFailureLine && (
                              <p className="text-[11px] text-slate-500 mt-1">{analysisAgentFailureLine}</p>
                            )}
                            <div className="mt-2 flex flex-wrap gap-1.5">
                              {routerAgentChips.map((chip) => (
                                <span
                                  key={chip.key}
                                  className={`text-[10px] px-2 py-0.5 rounded border font-semibold tracking-wide ${chip.className}`}
                                >
                                  {chip.label}
                                </span>
                              ))}
                            </div>
                            <div
                              style={{
                                marginTop: '10px',
                                display: 'flex',
                                flexDirection: 'column',
                                gap: '8px',
                              }}
                            >
                              <div
                                style={{
                                  display: 'flex',
                                  alignItems: 'center',
                                  justifyContent: 'space-between',
                                  padding: '8px 10px',
                                  borderRadius: '10px',
                                  border: '1px solid rgba(110, 231, 183, 0.18)',
                                  background: 'rgba(10, 20, 40, 0.45)',
                                }}
                              >
                                <span
                                  style={{
                                    fontSize: '11px',
                                    color: 'rgba(255,255,255,0.62)',
                                    letterSpacing: '0.4px',
                                    textTransform: 'uppercase',
                                  }}
                                >
                                  Model Router
                                </span>
                                <span
                                  style={{
                                    fontSize: '12px',
                                    color: '#C7FAE6',
                                    fontWeight: 600,
                                  }}
                                >
                                  {modelRouterLabel}
                                </span>
                              </div>
                            </div>
                          </div>
                        )}
                        {agentWarning && (
                          <div className="w-full">
                            <div className="text-[11px] text-amber-300 border border-amber-500/30 bg-amber-500/10 rounded-md px-3 py-2 text-left">
                              {agentWarning}
                            </div>
                          </div>
                        )}
                        {!showCompactRunningState && showBatsmanAiAlert && (
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
                        {!showCompactRunningState && substitutionRecommendation && (
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
                          {!showCompactRunningState && (
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
                          )}

                          {!showCompactRunningState && isFullAnalysis && combinedBriefing && (
                            <div className="p-4 rounded-xl border border-slate-700 bg-[#162032]">
                              <p className="text-xs font-bold text-slate-200 mb-2">Coach Briefing</p>
                              <p className="text-xs text-slate-300 whitespace-pre-line leading-relaxed">{combinedBriefing}</p>
                            </div>
                          )}

                          {!showCompactRunningState && showAnalysisFailureInline && (
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
                                          : row.state === 'FALLBACK'
                                            ? 'border-amber-500/35 text-amber-200 bg-amber-500/10'
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
                                      Trend: {fatigueTrendDisplayLabel}
                                    </span>
                                  </div>
                                  <p className="text-xs text-slate-300 leading-relaxed">
                                    {fatigueCoachCopy.title}
                                  </p>
                                  {fatigueCoachCopy.bullets.length > 0 && (
                                    <ul className="space-y-1.5 mt-3">
                                      {fatigueCoachCopy.bullets.map((item, idx) => (
                                        <li key={`fatigue-point-${idx}`} className="text-[11px] text-slate-300">• {item}</li>
                                      ))}
                                    </ul>
                                  )}
                                  <p className="text-[11px] text-slate-400 mt-3 leading-relaxed">
                                    {isBattingTacticalContext
                                      ? `Projected fatigue risk: ${fatigueCoachCopy.nextOverRiskLabel}`
                                      : `Next over risk: ${fatigueCoachCopy.nextOverRiskLabel}`}
                                  </p>
                                </div>
                              )}

                              {riskSectionVisible && (
                                <div className="p-4 rounded-xl border border-slate-700 bg-[#162032]">
                                  <p className="text-xs font-bold text-slate-200 mb-2">Injury Risk Analysis</p>
                                  <p className="text-xs text-slate-300 leading-relaxed">
                                    {injuryCoachCopy.title}
                                  </p>
                                  <p className="text-[11px] text-slate-300 mt-2 leading-relaxed">
                                    Likely injury: {injuryCoachCopy.likelyInjury}
                                  </p>
                                  {injuryCoachCopy.bullets.length > 0 && (
                                    <ul className="space-y-1.5 mt-3">
                                      {injuryCoachCopy.bullets.map((item, idx) => (
                                        <li key={`risk-point-${idx}`} className="text-[11px] text-slate-300">• {item}</li>
                                      ))}
                                    </ul>
                                  )}
                                  <p className="text-[11px] text-slate-400 mt-3 leading-relaxed">
                                    {injuryCoachCopy.riskDriver}
                                  </p>
                                  <p className="text-[11px] text-slate-400 mt-1 leading-relaxed">
                                    Confidence: {injuryCoachCopy.confidenceLabel}
                                  </p>
                                </div>
                              )}

                              {hasAnyAnalysis && (
                                <motion.div
                                  initial={{
                                    opacity: 0.94,
                                    boxShadow: '0 0 0 1px rgba(45,212,191,0.14), 0 0 0 rgba(45,212,191,0)',
                                  }}
                                  animate={{
                                    opacity: 1,
                                    boxShadow: [
                                      '0 0 0 1px rgba(45,212,191,0.14), 0 0 0 rgba(45,212,191,0)',
                                      tacticalCardGlowTarget,
                                      '0 0 0 1px rgba(45,212,191,0.24), 0 0 14px rgba(45,212,191,0.16), 0 10px 20px rgba(8,47,73,0.30)',
                                    ],
                                  }}
                                  transition={{
                                    opacity: { duration: 0.24, ease: 'easeOut' },
                                    boxShadow: { duration: 0.9, times: [0, 0.45, 1], ease: 'easeOut' },
                                  }}
                                  style={{ willChange: 'opacity, box-shadow' }}
                                  className="relative p-5 rounded-xl border border-teal-300/35 bg-gradient-to-b from-cyan-400/14 via-teal-400/10 to-[#162032] border-l-[4px] border-l-teal-300/85"
                                >
                                  <div className="mb-3 flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
                                    <h2 className="text-[11px] font-bold uppercase tracking-wide leading-tight text-indigo-100">
                                      TACTICAL RECOMMENDATION
                                    </h2>
                                    <div className="flex items-center gap-2">
                                      <span
                                        className={`inline-flex w-fit text-[10px] px-2 py-0.5 rounded border font-semibold uppercase tracking-wide ${tacticalPriorityBadgeClass}`}
                                      >
                                        Priority: {tacticalPriority}
                                      </span>
                                      {tacticalNotFitToContinue && (
                                        <span className="inline-flex w-fit text-[10px] px-2 py-0.5 rounded border font-semibold uppercase tracking-wide border-rose-400/50 bg-rose-500/20 text-rose-100">
                                          NOT FIT TO CONTINUE
                                        </span>
                                      )}
                                    </div>
                                  </div>
                                  <div className="space-y-3">
                                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                                      <div className="rounded-lg border border-slate-700 bg-slate-900/30 px-2.5 py-2">
                                        <p className="text-[10px] uppercase tracking-wide text-slate-400">Availability Status</p>
                                        <p className="text-xs text-slate-100 mt-1">{tacticalAvailabilityStatus}</p>
                                      </div>
                                      <div className="rounded-lg border border-slate-700 bg-slate-900/30 px-2.5 py-2">
                                        <p className="text-[10px] uppercase tracking-wide text-slate-400">Dominant Driver</p>
                                        <p className="text-xs text-slate-100 mt-1">{tacticalDominantDriverLabel}</p>
                                      </div>
                                      <div className="rounded-lg border border-slate-700 bg-slate-900/30 px-2.5 py-2">
                                        <p className="text-[10px] uppercase tracking-wide text-slate-400">Decision</p>
                                        <p className="text-xs text-slate-100 mt-1">{tacticalDecisionLabel}</p>
                                      </div>
                                      <div className="rounded-lg border border-slate-700 bg-slate-900/30 px-2.5 py-2">
                                        <p className="text-[10px] uppercase tracking-wide text-slate-400">{tacticalReplacementLabel}</p>
                                        <p className="text-xs text-slate-100 mt-1">{tacticalRecommendedReplacement}</p>
                                        {tacticalReplacementReason && (
                                          <p className="text-[11px] text-slate-400 mt-1 leading-relaxed">
                                            Reason: {tacticalReplacementReason}
                                          </p>
                                        )}
                                      </div>
                                    </div>
                                    {tacticalMatchSituationLines.length > 0 && (
                                      <div>
                                        <p className="text-[10px] uppercase tracking-wide text-slate-400">Match Situation</p>
                                        {tacticalMatchSituationLines.map((line, index) => (
                                          <p key={`tactical-situation-${index}`} className="text-xs text-slate-300 mt-1 leading-relaxed">{line}</p>
                                        ))}
                                      </div>
                                    )}
                                    {tacticalAssessmentDisplayLines.length > 0 && (
                                      <div>
                                        <p className="text-[10px] uppercase tracking-wide text-slate-400">Assessment</p>
                                        {tacticalAssessmentDisplayLines.map((line, index) => (
                                          <p key={`tactical-assessment-${index}`} className="text-xs text-slate-300 mt-1 leading-relaxed">{line}</p>
                                        ))}
                                      </div>
                                    )}
                                    {tacticalTradeoffLine && (
                                      <div>
                                        <p className="text-[10px] uppercase tracking-wide text-slate-400">Tradeoff</p>
                                        <p className="text-xs text-slate-300 mt-1 leading-relaxed">{tacticalTradeoffLine}</p>
                                      </div>
                                    )}
                                    {(tacticalRecommendedMove || tacticalSwapReason) && (
                                      <div>
                                        <p className="text-[10px] uppercase tracking-wide text-slate-400">Recommended Move</p>
                                        {tacticalRecommendedMove && (
                                          <p className="text-sm text-white mt-1 leading-relaxed break-words whitespace-normal">
                                            {tacticalRecommendedMove}
                                          </p>
                                        )}
                                        {tacticalSwapReason && (
                                          <p className="text-[11px] text-slate-400 mt-1 leading-relaxed break-words whitespace-normal">{tacticalSwapReason}</p>
                                        )}
                                        {tacticalSuggestedBenchOptions.length > 0 && (
                                          <p className="text-[11px] text-slate-400 mt-1 leading-relaxed">
                                            Bench options: {tacticalSuggestedBenchOptions.map((option) => `${option.name} (${option.roleTag})`).join(', ')}.
                                          </p>
                                        )}
                                      </div>
                                    )}
                                    {tacticalWhyLines.length > 0 && (
                                      <div>
                                        <p className="text-[10px] uppercase tracking-wide text-slate-400">Why This Is Smart</p>
                                        <ul className="space-y-1 mt-1">
                                          {tacticalWhyLines.map((item, index) => (
                                            <li key={`tactical-why-${index}`} className="text-[11px] text-slate-300">• {item}</li>
                                          ))}
                                        </ul>
                                      </div>
                                    )}
                                    {tacticalIfIgnored && (
                                      <div>
                                        <p className="text-[10px] uppercase tracking-wide text-slate-400">If Ignored</p>
                                        <p className="text-xs text-slate-300 mt-1 leading-relaxed">{tacticalIfIgnored}</p>
                                      </div>
                                    )}
                                    <div>
                                      <p className="text-[10px] uppercase tracking-wide text-slate-400">Confidence</p>
                                      <p className="text-xs text-slate-300 mt-1 leading-relaxed">{tacticalRecommendation.confidence}</p>
                                    </div>
                                  </div>
                                </motion.div>
                              )}
                            </>
                          )}

                          {!showCompactRunningState && showAnalysisFailureCard && (
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

                          {!showCompactRunningState && (
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
                                      : routerNarrative}
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
                                  <p className="text-[10px] uppercase tracking-wide text-slate-400 mb-1.5">Agents Selected</p>
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
                                  <p className="text-[10px] uppercase tracking-wide text-slate-400 mb-2">Debug details</p>
                                  <div className="space-y-1.5">
                                    {routerDetailRows.map((row) => (
                                      <p key={`advanced-router-${row.agent}`} className="text-[11px] text-slate-300 leading-relaxed">
                                        <span className="font-semibold text-slate-200">
                                          {row.agent === 'risk' ? 'Risk' : row.agent === 'fatigue' ? 'Fatigue' : 'Tactical'}
                                        </span>{' '}
                                        - {row.routeLabel} - {row.statusLabel}
                                        {row.reason ? ` - ${row.reason}` : ''}
                                      </p>
                                    ))}
                                  </div>
                                  {!showRouterTechnicalDetails && (
                                    <p className="text-[10px] text-slate-500 mt-2">
                                      Technical traces are hidden in production view.
                                    </p>
                                  )}
                                </div>

                                <div
                                  style={{
                                    marginTop: '10px',
                                    padding: '12px 14px',
                                    borderRadius: '12px',
                                    border: '1px solid rgba(255,255,255,0.08)',
                                    background: 'rgba(8, 18, 36, 0.42)',
                                  }}
                                >
                                  <div
                                    style={{
                                      fontSize: '11px',
                                      color: 'rgba(255,255,255,0.55)',
                                      letterSpacing: '0.5px',
                                      textTransform: 'uppercase',
                                      marginBottom: '8px',
                                    }}
                                  >
                                    Router Diagnostics
                                  </div>
                                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px' }}>
                                      <span style={{ fontSize: '12px', color: 'rgba(255,255,255,0.62)' }}>
                                        Selected by router
                                      </span>
                                      <span style={{ fontSize: '12px', color: '#ffffff', fontWeight: 600 }}>
                                        {modelSelectedLabel}
                                      </span>
                                    </div>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px' }}>
                                      <span style={{ fontSize: '12px', color: 'rgba(255,255,255,0.62)' }}>
                                        Routing mode
                                      </span>
                                      <span style={{ fontSize: '12px', color: '#C7FAE6', fontWeight: 600 }}>
                                        {routerDiagnosticsModeLabel}
                                      </span>
                                    </div>
                                  </div>
                                </div>

                                {showWhyThisDecision && (
                                  <div className="rounded-lg border border-slate-700 bg-slate-900/30 px-3 py-2.5">
                                    <p className="text-[10px] uppercase tracking-wide text-slate-400 mb-2">Why this decision</p>
                                    <div className="space-y-2">
                                      {agentDecisionRows.map((row) => (
                                        <p key={`advanced-why-${row.agent}`} className="text-[11px] text-slate-300 leading-relaxed">
                                          <span className={row.selected ? 'text-emerald-300' : 'text-slate-500'}>
                                            {row.selected ? '✅' : '⛔'}
                                          </span>{' '}
                                          <span className="font-semibold text-slate-200">{row.agent === 'risk' ? 'Risk' : row.agent === 'fatigue' ? 'Fatigue' : 'Tactical'}</span>{' '}
                                          — {row.why}
                                        </p>
                                      ))}
                                    </div>
                                  </div>
                                )}

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
                          )}

                          {!showCompactRunningState && isExplicitFallbackMode && (
                            <p className="text-[11px] text-slate-400 flex items-center gap-1.5">
                              {aiEnabled
                                ? 'Fallback mode active (using local/rules response for this run).'
                                : 'Fallback mode active (Azure OpenAI unavailable).'}
                              <Info
                                className="w-3 h-3 text-slate-500"
                                title={
                                  aiEnabled
                                    ? 'This run used fallback/rules output. Copilot chat may still use AI if available.'
                                    : 'Set AOAI env vars in local settings or Azure App Service to enable Azure OpenAI.'
                                }
                              />
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
                      {analysisExecuted && analysisStale && (
                        <p
                          style={{
                            marginTop: '12px',
                            marginBottom: '12px',
                            padding: '10px 12px',
                            borderRadius: '12px',
                            background: 'rgba(255, 184, 77, 0.10)',
                            border: '1px solid rgba(255, 184, 77, 0.28)',
                            color: '#ffd38a',
                            fontSize: '13px',
                            lineHeight: '1.4',
                          }}
                        >
                          ⚠️ Inputs changed — dismiss or rerun AI analysis for updated guidance.
                        </p>
                      )}
                      {analysisExecuted && !fullAnalysisIsRunning && hasPartialAnalysis && (
                        <p
                          style={{
                            marginTop: '12px',
                            marginBottom: '12px',
                            padding: '10px 12px',
                            borderRadius: '12px',
                            background: 'rgba(56, 189, 248, 0.10)',
                            border: '1px solid rgba(56, 189, 248, 0.28)',
                            color: '#bae6fd',
                            fontSize: '13px',
                            lineHeight: '1.4',
                          }}
                        >
                          Partial analysis available — run full combined analysis to include all required agents.
                        </p>
                      )}
                      <div className="min-h-[48px] flex items-center">
                        <button type="button"
                          onClick={(event) => handleRunCoachFull(event)}
                          disabled={fullAnalysisCtaDisabled}
                          className={`w-full py-3 rounded-2xl border text-sm font-semibold transition-all duration-200 relative text-center ${fullAnalysisCtaDisabled ? 'cursor-not-allowed' : ''}`}
                          style={fullAnalysisCtaStyle}
                        >
                          <span className="block w-full whitespace-nowrap">{fullAnalysisCtaLabel}</span>
                          <span
                            className="absolute inline-flex items-center justify-center rounded-full p-0.5 text-sky-100/60 transition-colors duration-150 hover:text-sky-100/90 focus-visible:text-sky-100/90"
                            style={{ right: 14, top: '50%', transform: 'translateY(-50%)' }}
                            onMouseEnter={() => setShowFullAnalysisInfo(true)}
                            onMouseLeave={() => setShowFullAnalysisInfo(false)}
                            onFocus={() => setShowFullAnalysisInfo(true)}
                            onBlur={() => setShowFullAnalysisInfo(false)}
                            tabIndex={0}
                            role="button"
                            aria-label="About full combined analysis"
                            onMouseDown={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                            }}
                            onClick={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                            }}
                          >
                            <Info className="h-3.5 w-3.5" />
                            <span
                              role="tooltip"
                              className={`pointer-events-none absolute transition-all duration-150 ${showFullAnalysisInfo ? 'opacity-100 scale-100 -translate-y-0.5' : 'opacity-0 scale-95 translate-y-0'}`}
                              style={{
                                position: 'absolute',
                                right: 0,
                                bottom: 'calc(100% + 10px)',
                                maxWidth: 240,
                                width: 'max-content',
                                padding: '10px 12px',
                                borderRadius: 12,
                                background: 'rgba(10, 18, 36, 0.96)',
                                border: '1px solid rgba(120, 150, 210, 0.22)',
                                boxShadow: '0 10px 30px rgba(0,0,0,0.35)',
                                color: '#e8eefc',
                                fontSize: 13,
                                lineHeight: 1.4,
                                textAlign: 'left',
                                zIndex: 60,
                                transformOrigin: 'bottom right',
                                whiteSpace: 'normal',
                              }}
                            >
                              Combines outputs from fatigue, risk, and tactical agents into one unified coaching recommendation.
                            </span>
                          </span>
                        </button>
                      </div>

                      <button type="button"
                        onClick={handleDismissAnalysis}
                        className="w-full py-3 rounded-lg border border-slate-700 text-slate-400 text-sm hover:text-white hover:bg-slate-800 transition-colors relative text-center"
                      >
                        <span className="block w-full">Dismiss Analysis</span>
                        <span
                          className="absolute inline-flex items-center justify-center rounded-full p-0.5 text-sky-100/55 transition-colors duration-150 hover:text-sky-100/85 focus-visible:text-sky-100/85"
                          style={{ right: 14, top: '50%', transform: 'translateY(-50%)' }}
                          onMouseEnter={() => setShowDismissAnalysisInfo(true)}
                          onMouseLeave={() => setShowDismissAnalysisInfo(false)}
                          onFocus={() => setShowDismissAnalysisInfo(true)}
                          onBlur={() => setShowDismissAnalysisInfo(false)}
                          tabIndex={0}
                          role="button"
                          aria-label="About dismiss analysis"
                          onMouseDown={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                          }}
                          onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                          }}
                        >
                          <Info className="h-3.5 w-3.5" />
                          <span
                            role="tooltip"
                            className={`pointer-events-none absolute transition-all duration-150 ${showDismissAnalysisInfo ? 'opacity-100 scale-100 -translate-y-0.5' : 'opacity-0 scale-95 translate-y-0'}`}
                            style={{
                              position: 'absolute',
                              right: 0,
                              bottom: 'calc(100% + 10px)',
                              maxWidth: 240,
                              width: 'max-content',
                              padding: '10px 12px',
                              borderRadius: 12,
                              background: 'rgba(10, 18, 36, 0.96)',
                              border: '1px solid rgba(120, 150, 210, 0.22)',
                              boxShadow: '0 10px 30px rgba(0,0,0,0.35)',
                              color: '#e8eefc',
                              fontSize: 13,
                              lineHeight: 1.4,
                              textAlign: 'left',
                              zIndex: 60,
                              transformOrigin: 'bottom right',
                              whiteSpace: 'normal',
                            }}
                          >
                            Clears the current AI analysis so you can run it again with updated inputs.
                          </span>
                        </span>
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
      <ConfirmSwitchOverlay
        open={showNextBatterConfirm && Boolean(recommendedNextBatter)}
        suggestion={recommendedNextBatter}
        onSwitch={confirmNextBatterSwitch}
        onCancel={closeNextBatterConfirm}
        title={recommendedNextBatter ? `Recommended Next Batter: ${recommendedNextBatter.bowlerName}` : undefined}
        prompt={recommendedNextBatter ? `Switch to ${recommendedNextBatter.bowlerName}?` : undefined}
        confirmLabel="Confirm / Switch"
      />
      <MatchModeGuardOverlay
        open={showMatchModeGuard}
        onSwitch={handleSwitchToBattingAndContinue}
        onCancel={closeMatchModeGuard}
        title={matchModeGuardContent?.title}
        message={matchModeGuardContent?.message}
        confirmLabel={matchModeGuardContent?.confirmLabel}
      />
      <MatchModeGuardOverlay
        open={showBowlingCoachModeGuard}
        onSwitch={handleSwitchToBowlingAndRunCoach}
        onCancel={closeBowlingCoachModeGuard}
        title={bowlingCoachModeGuardContent?.title || 'Switch to BOWLING?'}
        message={bowlingCoachModeGuardContent?.message || 'Bowler Coach Analysis requires BOWLING mode.'}
        confirmLabel={bowlingCoachModeGuardContent?.confirmLabel || 'Switch & Run'}
      />
    </motion.div>
  );
}

interface BaselinesProps {
  baselineSource: 'cosmos' | 'fallback';
  baselineWarning: string | null;
  demoMode: boolean;
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

const createPersistentPlayerId = (): string => `plr-${createDraftRowKey()}`;

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
    inRoster: rosterIdSet ? Boolean(rosterIdSet.has(resolvedRosterKey)) : Boolean(normalized.inRoster),
    sleep: clamp(safeNum(normalized.sleepHoursToday, 7), BASELINE_METRIC_LIMITS.sleep.min, BASELINE_METRIC_LIMITS.sleep.max),
    recovery: clamp(safeNum(normalized.recoveryMinutes, 45), BASELINE_METRIC_LIMITS.recovery.min, BASELINE_METRIC_LIMITS.recovery.max),
    fatigueLimit: clamp(safeNum(normalized.fatigueLimit, 6), BASELINE_METRIC_LIMITS.fatigueLimit.min, BASELINE_METRIC_LIMITS.fatigueLimit.max),
    control: clamp(safeNum(normalized.controlBaseline, 78), BASELINE_METRIC_LIMITS.control.min, BASELINE_METRIC_LIMITS.control.max),
    speed: clamp(safeNum(normalized.speed, 7), BASELINE_METRIC_LIMITS.speed.min, BASELINE_METRIC_LIMITS.speed.max),
    power: clamp(safeNum(normalized.power, 6), BASELINE_METRIC_LIMITS.power.min, BASELINE_METRIC_LIMITS.power.max),
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
    baselineId: resolvedId,
    name,
    role: row.role,
    sleepHoursToday: clamp(safeNum(row.sleep, 7), BASELINE_METRIC_LIMITS.sleep.min, BASELINE_METRIC_LIMITS.sleep.max),
    recoveryMinutes: clamp(safeNum(row.recovery, 45), BASELINE_METRIC_LIMITS.recovery.min, BASELINE_METRIC_LIMITS.recovery.max),
    fatigueLimit: clamp(safeNum(row.fatigueLimit, 6), BASELINE_METRIC_LIMITS.fatigueLimit.min, BASELINE_METRIC_LIMITS.fatigueLimit.max),
    controlBaseline: clamp(safeNum(row.control, 78), BASELINE_METRIC_LIMITS.control.min, BASELINE_METRIC_LIMITS.control.max),
    speed: clamp(safeNum(row.speed, 7), BASELINE_METRIC_LIMITS.speed.min, BASELINE_METRIC_LIMITS.speed.max),
    power: clamp(safeNum(row.power, 6), BASELINE_METRIC_LIMITS.power.min, BASELINE_METRIC_LIMITS.power.max),
    orderIndex: parseBaselineOrderIndex(row.orderIndex),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
};

function Baselines({
  baselineSource,
  baselineWarning,
  demoMode,
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
  const [hasRosterHintBeenUsed, setHasRosterHintBeenUsed] = useState(false);

  const sortedSignature = (rows: BaselineDraftRow[]): string =>
    JSON.stringify(
      rows
        .map((row) => ({
          name: String(row.name || ''),
          role: row.role,
          sleep: clamp(safeNum(row.sleep, 7), BASELINE_METRIC_LIMITS.sleep.min, BASELINE_METRIC_LIMITS.sleep.max),
          recovery: clamp(safeNum(row.recovery, 45), BASELINE_METRIC_LIMITS.recovery.min, BASELINE_METRIC_LIMITS.recovery.max),
          fatigueLimit: clamp(safeNum(row.fatigueLimit, 6), BASELINE_METRIC_LIMITS.fatigueLimit.min, BASELINE_METRIC_LIMITS.fatigueLimit.max),
          control: clamp(safeNum(row.control, 78), BASELINE_METRIC_LIMITS.control.min, BASELINE_METRIC_LIMITS.control.max),
          speed: clamp(safeNum(row.speed, 7), BASELINE_METRIC_LIMITS.speed.min, BASELINE_METRIC_LIMITS.speed.max),
          power: clamp(safeNum(row.power, 6), BASELINE_METRIC_LIMITS.power.min, BASELINE_METRIC_LIMITS.power.max),
          orderIndex: parseBaselineOrderIndex(row.orderIndex),
        }))
        .map((row) => ({
          name: row.name,
          role: row.role,
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
      if (!Number.isFinite(sleep) || sleep < BASELINE_METRIC_LIMITS.sleep.min || sleep > BASELINE_METRIC_LIMITS.sleep.max) {
        return `Row ${index + 1}: Sleep must be between 0 and 12.`;
      }
      if (!Number.isFinite(recovery) || recovery < BASELINE_METRIC_LIMITS.recovery.min || recovery > BASELINE_METRIC_LIMITS.recovery.max) {
        return `Row ${index + 1}: Recovery must be between 0 and 120.`;
      }
      if (!Number.isFinite(fatigueLimit) || fatigueLimit < BASELINE_METRIC_LIMITS.fatigueLimit.min || fatigueLimit > BASELINE_METRIC_LIMITS.fatigueLimit.max) {
        return `Row ${index + 1}: Fatigue Limit must be between 0 and 10.`;
      }
      if (!Number.isFinite(control) || control < BASELINE_METRIC_LIMITS.control.min || control > BASELINE_METRIC_LIMITS.control.max) {
        return `Row ${index + 1}: Control must be between 0 and 100.`;
      }
      if (!Number.isFinite(speed) || speed < BASELINE_METRIC_LIMITS.speed.min || speed > BASELINE_METRIC_LIMITS.speed.max) {
        return `Row ${index + 1}: Speed must be between 0 and 15.`;
      }
      if (!Number.isFinite(power) || power < BASELINE_METRIC_LIMITS.power.min || power > BASELINE_METRIC_LIMITS.power.max) {
        return `Row ${index + 1}: Power must be between 0 and 10.`;
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
    if (!hasRosterHintBeenUsed) {
      setHasRosterHintBeenUsed(true);
    }
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
      const warning = error instanceof ApiClientError && (error.status === 401 || error.status === 403)
        ? 'Sign in with Microsoft to load player baselines.'
        : error instanceof ApiClientError && error.status === 500
          ? 'Baselines service is unavailable. Check Functions env configuration.'
          : 'Failed to load baselines from backend.';
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
    if (!demoMode) return;
    const normalized = draftRowsToBaselines(draftBaselines);
    void saveBaselines(normalized).catch(() => {
      // Demo autosave is best-effort; keep UI responsive even if storage is blocked.
    });
  }, [demoMode, draftBaselines]);

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
    const boundedUpdates: Partial<BaselineDraftRow> = { ...updates };
    if (Object.prototype.hasOwnProperty.call(updates, 'sleep')) {
      boundedUpdates.sleep = clamp(
        safeNum(updates.sleep, 0),
        BASELINE_METRIC_LIMITS.sleep.min,
        BASELINE_METRIC_LIMITS.sleep.max
      );
    }
    if (Object.prototype.hasOwnProperty.call(updates, 'recovery')) {
      boundedUpdates.recovery = clamp(
        safeNum(updates.recovery, 0),
        BASELINE_METRIC_LIMITS.recovery.min,
        BASELINE_METRIC_LIMITS.recovery.max
      );
    }
    if (Object.prototype.hasOwnProperty.call(updates, 'fatigueLimit')) {
      boundedUpdates.fatigueLimit = clamp(
        safeNum(updates.fatigueLimit, 0),
        BASELINE_METRIC_LIMITS.fatigueLimit.min,
        BASELINE_METRIC_LIMITS.fatigueLimit.max
      );
    }
    if (Object.prototype.hasOwnProperty.call(updates, 'control')) {
      boundedUpdates.control = clamp(
        safeNum(updates.control, 0),
        BASELINE_METRIC_LIMITS.control.min,
        BASELINE_METRIC_LIMITS.control.max
      );
    }
    if (Object.prototype.hasOwnProperty.call(updates, 'speed')) {
      boundedUpdates.speed = clamp(
        safeNum(updates.speed, 0),
        BASELINE_METRIC_LIMITS.speed.min,
        BASELINE_METRIC_LIMITS.speed.max
      );
    }
    if (Object.prototype.hasOwnProperty.call(updates, 'power')) {
      boundedUpdates.power = clamp(
        safeNum(updates.power, 0),
        BASELINE_METRIC_LIMITS.power.min,
        BASELINE_METRIC_LIMITS.power.max
      );
    }
    setDraftBaselines((prev) => {
      const nextRows = prev.map((row) => {
        if (row._localId !== localId) return row;
        const stableRowId = String(row.id || '').trim() || `plr-${row._localId}`;
        return {
          ...row,
          ...boundedUpdates,
          name: boundedUpdates.name !== undefined ? String(boundedUpdates.name) : row.name,
          id: stableRowId,
          inRoster: boundedUpdates.inRoster !== undefined ? Boolean(boundedUpdates.inRoster) : row.inRoster,
        };
      });
      syncDraftToRoster(nextRows);
      return nextRows;
    });
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
        id: createPersistentPlayerId(),
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
  const hasBaselineRows = draftBaselines.length > 0;
  const shouldShowRosterHintGlow = hasBaselineRows && !hasRosterHintBeenUsed;
  const emptyStatePanelStyle: React.CSSProperties = {
    border: '1px solid rgba(34,211,238,0.22)',
    background: 'linear-gradient(135deg, rgba(8,20,40,0.92), rgba(6,14,28,0.96))',
    borderRadius: '18px',
    padding: '22px 24px',
    color: '#dbeafe',
    boxShadow: '0 0 0 1px rgba(16,185,129,0.06), 0 12px 40px rgba(0,0,0,0.22)',
  };
  const helperStripStyle: React.CSSProperties = {
    marginBottom: '14px',
    padding: '12px 16px',
    borderRadius: '12px',
    border: '1px solid rgba(45,212,191,0.18)',
    background: 'rgba(15,23,42,0.72)',
    color: '#cbd5e1',
    fontSize: '14px',
  };

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
          <p className="text-slate-400 mt-1">
            {demoMode
              ? 'Demo mode keeps player data in localStorage only.'
              : 'Baseline fields are saved to Cosmos playersByUser. Roster selection is local session state.'}
          </p>
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
	        {!isLoadingBaselines && hasBaselineRows && (
	          <div className="px-4 pt-4">
	            <div style={helperStripStyle}>
	              <div>
	                Tip: Check the{' '}
	                <span style={{ color: '#ffffff', fontWeight: 700 }}>
	                  Roster
	                </span>{' '}
	                box to add a player into the current match squad.
	              </div>
	              <div style={{ marginTop: '4px', fontSize: '12.5px', color: 'rgba(203,213,225,0.82)' }}>
	                Baseline stores reusable player profiles. Roster selects who is active for this match.
	              </div>
	            </div>
	          </div>
	        )}
	        {isLoadingBaselines ? (
	          <div className="flex-1 min-h-[460px] flex items-center justify-center px-6">
	            <div className="flex flex-col items-center justify-center text-center">
	              <div className="h-12 w-12 rounded-full border-2 border-slate-500/35 border-t-emerald-400 animate-spin" />
	              <p className="mt-4 text-sm text-slate-400">Loading players...</p>
	            </div>
	          </div>
	        ) : !hasBaselineRows ? (
	          <div className="flex-1 min-h-[460px] flex items-center justify-center px-6 py-10">
	            <div style={{ ...emptyStatePanelStyle, width: '100%', maxWidth: '980px' }}>
	              <h3 style={{ fontSize: '28px', fontWeight: 700, color: '#f8fafc' }}>
	                Build Your Team Baseline
	              </h3>
	              <p
	                style={{
	                  marginTop: '10px',
	                  fontSize: '15px',
	                  lineHeight: 1.6,
	                  color: 'rgba(226,232,240,0.78)',
	                  maxWidth: '700px',
	                }}
	              >
	                Create player profiles once and reuse them across every match. Keep your squad data saved and ready for fast match setup.
	              </p>
	              <div style={{ marginTop: '16px' }}>
	                <button
	                  type="button"
	                  onClick={addDraftPlayer}
	                  className="inline-flex items-center gap-2 rounded-lg px-5 py-2.5 font-bold transition-all bg-emerald-600 hover:bg-emerald-500 text-white shadow-lg shadow-emerald-900/40"
	                >
	                  <Plus className="w-4 h-4" />
	                  Create First Player
	                </button>
	              </div>
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
	                {draftBaselines.map((p, index) => {
	                  const isActive = p.inRoster === true;
	                  const trimmedName = p.name.trim();
	                  const idDisplay = p.id || trimmedName || '—';
	                  const glowRosterCheckbox = shouldShowRosterHintGlow && index === 0;
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
                         onChange={(e) => updateDraft(p._localId, { name: e.target.value })}
                         className="bg-transparent font-bold focus:outline-none border-b py-1 transition-colors w-full text-white border-transparent focus:border-emerald-500"
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
	                     <div
	                       style={
	                         glowRosterCheckbox
	                           ? {
	                               display: 'inline-flex',
	                               alignItems: 'center',
	                               justifyContent: 'center',
	                               padding: '4px',
	                               boxShadow:
	                                 '0 0 0 2px rgba(34,211,238,0.22), 0 0 18px rgba(45,212,191,0.28), 0 0 28px rgba(59,130,246,0.18)',
	                               borderRadius: '8px',
	                               transition: 'box-shadow 0.25s ease',
	                             }
	                           : undefined
	                       }
	                     >
	                       <input
	                         type="checkbox"
	                         checked={isActive}
	                         onChange={(e) => handleRosterToggle(p, e.target.checked)}
	                         title="Toggle roster membership for this match."
	                         className="w-4 h-4 accent-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed"
	                       />
	                     </div>
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
                         max="120"
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
                       min="0" max="15"
                       value={p.speed}
                       onChange={(e) => updateDraft(p._localId, { speed: Number(e.target.value) })}
                       className="w-12 bg-transparent text-center text-white font-mono focus:text-emerald-400 focus:outline-none"
                     />
                   </td>
                   <td className="px-4 py-4 text-center">
                     <input 
                       type="number" 
                       min="0" max="10"
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
	                 })}
               
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
