import React, { useState, useEffect, useRef } from 'react';
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
import { FatigueAgentResponse, OrchestrateResponse, RiskAgentResponse, TacticalAgentResponse, TacticalCombinedDecision } from './types/agents';
import {
  ApiClientError,
  apiAgentFrameworkMessagesUrl,
  apiHealthUrl,
  apiOrchestrateUrl,
  checkHealth,
  deleteBaseline,
  getBaselinesWithMeta,
  postAgentFrameworkOrchestrate,
  postOrchestrate,
  resetBaselines,
  saveBaselines,
} from './lib/apiClient';
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

interface MatchContext {
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
  hrRecovery: 'Good' | 'Moderate' | 'Poor';
  injuryRisk: 'Low' | 'Medium' | 'High' | 'Critical';
  noBallRisk: 'Low' | 'Medium' | 'High';
  agentFatigueOverride?: number;
  agentRiskOverride?: 'Low' | 'Medium' | 'High' | 'Critical';
  runs: number;
  balls: number;
  boundaryEvents: Array<'4' | '6'>;
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

interface AgentFeedStatus {
  fatigue: 'idle' | 'loading' | 'done' | 'error';
  risk: 'idle' | 'loading' | 'done' | 'error';
  tactical: 'idle' | 'loading' | 'done' | 'error';
}

interface OrchestrateMetaView {
  mode: 'auto' | 'full';
  executedAgents: Array<'fatigue' | 'risk' | 'tactical'>;
  usedFallbackAgents: Array<'fatigue' | 'risk' | 'tactical'>;
}

interface RouterDecisionView {
  intent: 'fatigue_check' | 'risk_check' | 'substitution' | 'full';
  selectedAgents: Array<'fatigue' | 'risk' | 'tactical'>;
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
    runs: 0, balls: 0, boundaryEvents: [], isDismissed: false, dismissalType: 'Not Out',
    baselineFatigue: 6, sleepHours: 7.5, recoveryTime: 45, controlBaseline: 80, speed: 9, power: 7
  },
  { 
    id: 'p2', name: 'R. Khan', role: 'Spinner', 
    isActive: true,
    lastRestOvers: 7,
    overs: 8, consecutiveOvers: 1, fatigue: 4, hrRecovery: 'Good', injuryRisk: 'Low', noBallRisk: 'Low',
    runs: 0, balls: 0, boundaryEvents: [], isDismissed: false, dismissalType: 'Not Out',
    baselineFatigue: 8, sleepHours: 6, recoveryTime: 30, controlBaseline: 88, speed: 7, power: 5
  },
  { 
    id: 'p3', name: 'B. Stokes', role: 'All-rounder', 
    isActive: true,
    lastRestOvers: 0,
    overs: 3, consecutiveOvers: 3, fatigue: 5, hrRecovery: 'Moderate', injuryRisk: 'Medium', noBallRisk: 'Low',
    runs: 24, balls: 18, boundaryEvents: ['4', '4', '6'], isDismissed: false, dismissalType: 'Not Out',
    baselineFatigue: 5, sleepHours: 8, recoveryTime: 50, controlBaseline: 76, speed: 8, power: 8
  },
  { 
    id: 'p4', name: 'P. Cummins', role: 'Fast Bowler', 
    isActive: true,
    lastRestOvers: 10,
    overs: 10, consecutiveOvers: 0, fatigue: 7, hrRecovery: 'Poor', injuryRisk: 'High', noBallRisk: 'Medium',
    runs: 0, balls: 0, boundaryEvents: [], isDismissed: false, dismissalType: 'Not Out',
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
    <button 
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

const LOCAL_BASELINE_DEFAULTS: Array<Partial<Baseline>> = [
  {
    id: 'J. Archer',
    playerId: 'J. Archer',
    name: 'J. Archer',
    role: 'FAST',
    isActive: true,
    sleepHoursToday: 7.5,
    recoveryMinutes: 45,
    fatigueLimit: 6,
    controlBaseline: 80,
    speed: 9,
    power: 0,
  },
  {
    id: 'R. Khan',
    playerId: 'R. Khan',
    name: 'R. Khan',
    role: 'SPIN',
    isActive: true,
    sleepHoursToday: 7.1,
    recoveryMinutes: 40,
    fatigueLimit: 6,
    controlBaseline: 86,
    speed: 8,
    power: 0,
  },
  {
    id: 'B. Stokes',
    playerId: 'B. Stokes',
    name: 'B. Stokes',
    role: 'AR',
    isActive: true,
    sleepHoursToday: 7.3,
    recoveryMinutes: 55,
    fatigueLimit: 6,
    controlBaseline: 75,
    speed: 8,
    power: 7,
  },
  {
    id: 'M. Starc',
    playerId: 'M. Starc',
    name: 'M. Starc',
    role: 'FAST',
    isActive: true,
    sleepHoursToday: 6.8,
    recoveryMinutes: 50,
    fatigueLimit: 6,
    controlBaseline: 79,
    speed: 9,
    power: 0,
  },
];

const getLocalDefaultBaselines = (): Baseline[] =>
  LOCAL_BASELINE_DEFAULTS.map((row) => normalizeBaselineRecord(row));

const MAX_ROSTER = 11;
const BASELINES_STORAGE_KEY = 'tactiq.baselines';
const BASELINES_CHANGED_EVENT = 'tactiq-baselines-changed';
const MATCH_ROSTER_IDS_STORAGE_KEY = 'tactiq_matchRosterIds';

const serializeBaselinesForStorage = (rows: Baseline[]): string =>
  JSON.stringify(rows.map((row) => normalizeBaselineRecord(row)));

const readBaselinesFromStorage = (): Baseline[] | null => {
  if (typeof window === 'undefined') return null;
  const raw = window.localStorage.getItem(BASELINES_STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed.map((entry) => normalizeBaselineRecord(entry));
  } catch {
    return null;
  }
};

const writeBaselinesToStorage = (rows: Baseline[]): void => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(BASELINES_STORAGE_KEY, serializeBaselinesForStorage(rows));
    window.dispatchEvent(new Event(BASELINES_CHANGED_EVENT));
  } catch {
    // Ignore storage write failures in restricted browser modes.
  }
};

const readMatchRosterIdsFromStorage = (): string[] | null => {
  if (typeof window === 'undefined') return null;
  const raw = window.localStorage.getItem(MATCH_ROSTER_IDS_STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed
      .map((entry) => normalizeBaselineId(String(entry || '')))
      .filter((entry, index, list) => entry.length > 0 && list.indexOf(entry) === index);
  } catch {
    return null;
  }
};

const writeMatchRosterIdsToStorage = (ids: string[]): void => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(MATCH_ROSTER_IDS_STORAGE_KEY, JSON.stringify(ids));
  } catch {
    // Ignore storage write failures in restricted browser modes.
  }
};

const getEligibleRosterBaselineIds = (rows: Baseline[]): string[] =>
  orderBaselinesForDisplay(rows)
    .map((row) => normalizeBaselineRecord(row))
    .filter((row) => row.active === true || row.isActive === true)
    .map((row) => normalizeBaselineId(row.id || row.playerId || row.name))
    .filter((id, index, list) => id.length > 0 && list.indexOf(id) === index);

const resolveMatchRosterIds = (
  baselines: Baseline[],
  storedIds: string[] | null
): string[] => {
  const orderedIds = getEligibleRosterBaselineIds(baselines);
  if (storedIds === null || storedIds.length === 0) {
    return orderedIds.slice(0, MAX_ROSTER);
  }

  const availableKeys = new Set(orderedIds.map((id) => baselineKey(id)));
  const next: string[] = [];
  const seen = new Set<string>();

  storedIds.forEach((id) => {
    const normalized = normalizeBaselineId(id);
    const key = baselineKey(normalized);
    if (!key || seen.has(key) || !availableKeys.has(key)) return;
    next.push(normalized);
    seen.add(key);
  });

  return next.slice(0, MAX_ROSTER);
};

const baselineFromPlayer = (player: Player): Baseline =>
  normalizeBaselineRecord({
    id: normalizeBaselineId(player.id),
    playerId: normalizeBaselineId(player.id),
    name: player.name,
    role: playerRoleToBaselineRole(player.role),
    isActive: player.isActive !== false,
    active: player.isActive !== false,
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
  matchRosterIds: string[]
): Player[] => {
  const byName = new Map<string, Player>();
  const byId = new Map<string, Player>();
  currentPlayers.forEach((player) => {
    byName.set(baselineKey(player.name), player);
    byId.set(player.id, player);
  });

  const baselineById = new Map<string, Baseline>();
  orderBaselinesForDisplay(baselines)
    .map((baseline) => normalizeBaselineRecord(baseline))
    .forEach((baseline) => {
      if (baseline.active !== true && baseline.isActive !== true) return;
      const id = normalizeBaselineId(baseline.id || baseline.playerId || baseline.name);
      if (!id) return;
      baselineById.set(baselineKey(id), baseline);
    });

  // Roster is derived strictly from local match roster IDs.
  return matchRosterIds
    .map((id) => baselineById.get(baselineKey(id)))
    .filter((baseline): baseline is Baseline => Boolean(baseline))
    .map((baseline) => {
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
        isDismissed: false,
        dismissalType: 'Not Out',
        baselineFatigue: baseline.fatigueLimit,
        sleepHours: baseline.sleepHoursToday,
        recoveryTime: baseline.recoveryMinutes,
        controlBaseline: baseline.controlBaseline,
        speed: baseline.speed,
        power: baseline.power,
        recoveryOffset: 0,
      } satisfies Player;
    });
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
    const candidate = [parsed.message, parsed.error, parsed.detail].find(
      (value): value is string => typeof value === 'string' && value.trim().length > 0
    );
    if (candidate) return candidate.trim();
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
      message = `Backend error (${error.status}). Check API logs.`;
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
  const [showSplash, setShowSplash] = useState(true);
  const [page, setPage] = useState<Page>('landing');
  const [matchContext, setMatchContext] = useState<MatchContext>({
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
  const [activePlayerId, setActivePlayerId] = useState<string>('');
  const [agentState, setAgentState] = useState<'idle' | 'thinking' | 'done' | 'offline' | 'invalid'>('idle');
  const [agentWarning, setAgentWarning] = useState<string | null>(null);
  const [agentFailure, setAgentFailure] = useState<AgentFailureDetail | null>(null);
  const [aiAnalysis, setAiAnalysis] = useState<AiAnalysis | null>(null);
  const [riskAnalysis, setRiskAnalysis] = useState<AiAnalysis | null>(null);
  const [tacticalAnalysis, setTacticalAnalysis] = useState<TacticalAgentResponse | null>(null);
  const [combinedDecision, setCombinedDecision] = useState<TacticalCombinedDecision | null>(null);
  const [orchestrateMeta, setOrchestrateMeta] = useState<OrchestrateMetaView | null>(null);
  const [routerDecision, setRouterDecision] = useState<RouterDecisionView | null>(null);
  const [agentFeedStatus, setAgentFeedStatus] = useState<AgentFeedStatus>({ fatigue: 'idle', risk: 'idle', tactical: 'idle' });
  const [analysisActive, setAnalysisActive] = useState(false);
  const [analysisRequested, setAnalysisRequested] = useState(false);
  const [recoveryMode, setRecoveryMode] = useState<RecoveryMode>('auto');
  const [manualRecovery, setManualRecovery] = useState<RecoveryLevel>('Moderate');
  const [baselineSource, setBaselineSource] = useState<'cosmos' | 'fallback'>('fallback');
  const [baselineWarning, setBaselineWarning] = useState<string | null>(null);
  const [workingBaselines, setWorkingBaselines] = useState<Baseline[]>(getLocalDefaultBaselines());
  const [matchRosterIds, setMatchRosterIds] = useState<string[]>([]);
  const [isProfileOpen, setIsProfileOpen] = useState(false);
  const fatigueRequestSeq = useRef(0);
  const fatigueAbortRef = useRef<AbortController | null>(null);
  const recoveryIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const previousActivePlayerIdRef = useRef<string | null>(null);

  useEffect(() => {
    let rosterIdsRef = readMatchRosterIdsFromStorage();

    const applyBaselinesToRoster = (rows: Baseline[]) => {
      const orderedRows = orderBaselinesForDisplay(rows);
      setWorkingBaselines(orderedRows);
      const resolvedIds = resolveMatchRosterIds(orderedRows, rosterIdsRef);
      rosterIdsRef = resolvedIds;
      setMatchRosterIds(resolvedIds);
      writeMatchRosterIdsToStorage(resolvedIds);
      setPlayers((prev) => {
        const derivedRoster = buildRosterPlayersFromBaselines(prev, orderedRows, resolvedIds);
        setActivePlayerId((currentId) => {
          if (derivedRoster.some((player) => player.id === currentId)) return currentId;
          return derivedRoster[0]?.id ?? '';
        });
        return derivedRoster;
      });
    };

    const loadFromStorage = (warning?: string) => {
      const stored = readBaselinesFromStorage();
      const rows = orderBaselinesForDisplay(stored !== null ? stored : getLocalDefaultBaselines());
      if (!stored) writeBaselinesToStorage(rows);
      setBaselineSource('fallback');
      setBaselineWarning(warning || null);
      applyBaselinesToRoster(rows);
    };

    const loadFromBackend = async () => {
      try {
        const response = await getBaselinesWithMeta();
        const rows = orderBaselinesForDisplay(response.baselines);
        setBaselineSource(response.source);
        setBaselineWarning(
          response.warning || (response.source === 'fallback' ? 'Cosmos not configured. Using fallback baseline profiles.' : null)
        );
        writeBaselinesToStorage(rows);
        applyBaselinesToRoster(rows);
      } catch (error) {
        if (import.meta.env.DEV) {
          console.warn('[baselines] backend load failed; using local fallback', error);
        }
        loadFromStorage('Failed to load baselines from backend. Using local defaults.');
      }
    };

    const handleStorage = (event: StorageEvent) => {
      if (event.key && event.key !== BASELINES_STORAGE_KEY && event.key !== MATCH_ROSTER_IDS_STORAGE_KEY) {
        return;
      }

      if (event.key === MATCH_ROSTER_IDS_STORAGE_KEY) {
        rosterIdsRef = readMatchRosterIdsFromStorage();
        const storedBaselines = readBaselinesFromStorage();
        if (storedBaselines) {
          applyBaselinesToRoster(storedBaselines);
        }
        return;
      }

      loadFromStorage();
    };

    const handleLocalEvent = () => {
      loadFromStorage();
    };

    loadFromBackend();
    window.addEventListener('storage', handleStorage);
    window.addEventListener(BASELINES_CHANGED_EVENT, handleLocalEvent);
    return () => {
      window.removeEventListener('storage', handleStorage);
      window.removeEventListener(BASELINES_CHANGED_EVENT, handleLocalEvent);
    };
  }, []);

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
      injuryRisk,
      noBallRisk,
      heartRateRecovery: String(activeDerived.hrRecovery || 'Moderate'),
      fatigueLimit: activeDerived.fatigueLimit,
      sleepHours: activeDerived.sleepHrs,
      recoveryMinutes: activeDerived.recoveryMin,
      matchContext: {
        format: matchContext.format || 'T20',
        phase: normalizedPhase,
        over: safeNum(Number(formatOverStr(matchState.ballsBowled)), 0),
        intensity: matchContext.pitch || 'Medium',
      },
    };
  }, [activeDerived, normalizedPhase, matchContext, matchState.ballsBowled]);

  const updateMatchState = (updates: Partial<MatchState>) => {
    setMatchState(prev => {
      const next = { ...prev, ...updates };
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

      return updated;
    }));
  };

  const movePlayerToSub = (playerId: string) => {
    // Regression guard: roster operations never call baseline APIs.
    const idx = players.findIndex(p => p.id === playerId);
    if (idx !== -1) {
      const rosterBefore = players.filter(p => p.inRoster !== false);
      const rosterIndex = rosterBefore.findIndex(p => p.id === playerId);
      const copy = [...players];
      const [moved] = copy.splice(idx, 1);
      moved.isSub = true;
      moved.inRoster = false;
      moved.isActive = false;
      copy.push(moved);
      if (activePlayerId === playerId) {
        let nextActiveId = rosterIndex > 0 ? rosterBefore[rosterIndex - 1]?.id : undefined;
        if (!nextActiveId) {
          const rosterAfter = copy.filter(p => p.inRoster !== false);
          nextActiveId = rosterAfter[0]?.id;
        }
        if (nextActiveId) setActivePlayerId(nextActiveId);
      }
      setPlayers(copy);
    }
  };

  const applyMatchRosterIds = (nextIdsInput: string[]) => {
    const orderedBaselines = orderBaselinesForDisplay(
      workingBaselines.length > 0 ? workingBaselines : (readBaselinesFromStorage() ?? getLocalDefaultBaselines())
    );
    const resolvedIds = resolveMatchRosterIds(orderedBaselines, nextIdsInput);
    setMatchRosterIds(resolvedIds);
    writeMatchRosterIdsToStorage(resolvedIds);
    setPlayers((prevPlayers) => {
      const derivedRoster = buildRosterPlayersFromBaselines(prevPlayers, orderedBaselines, resolvedIds);
      setActivePlayerId((currentId) => {
        if (derivedRoster.some((player) => player.id === currentId)) return currentId;
        return derivedRoster[0]?.id ?? '';
      });
      return derivedRoster;
    });
  };

  const deleteRosterPlayer = (rosterPlayerId: string) => {
    const normalizedId = normalizeBaselineId(rosterPlayerId);
    if (!normalizedId) return;
    const normalizedKey = baselineKey(normalizedId);

    // Keep baseline + roster in sync locally: removing from roster marks baseline inactive for this session.
    const nextBaselines = orderBaselinesForDisplay(
      workingBaselines.length > 0 ? workingBaselines : (readBaselinesFromStorage() ?? getLocalDefaultBaselines())
    ).map((baseline) => {
      const baselineId = normalizeBaselineId(baseline.id || baseline.playerId || baseline.name);
      if (baselineKey(baselineId) !== normalizedKey) return baseline;
      return normalizeBaselineRecord({
        ...baseline,
        isActive: false,
        active: false,
        updatedAt: new Date().toISOString(),
      });
    });
    setWorkingBaselines(nextBaselines);
    writeBaselinesToStorage(nextBaselines);

    const currentIds = matchRosterIds.length > 0 ? matchRosterIds : (readMatchRosterIdsFromStorage() || []);
    const nextIds = currentIds.filter((id) => baselineKey(id) !== normalizedKey);
    applyMatchRosterIds(nextIds);
  };

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

  const handleNewSpell = () => {
    if (!activePlayer) return;
    if (activePlayer.isUnfit) return;
    // Compatibility marker for legacy spell tracking fields.
    updatePlayer(activePlayer.id, {
      lastRestOvers: activePlayer.overs,
      isResting: false,
      restStartMs: undefined,
      restElapsedSec: 0,
      recoveryElapsed: 0,
      isManuallyUnfit: false,
      isInjured: false,
    });
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
    reason: 'button_click' | 'non_button' = 'non_button'
  ) => {
    const orchestrateRequestUrl = useAgentFramework ? apiAgentFrameworkMessagesUrl : apiOrchestrateUrl;
    const frameworkMode = mode === 'full' ? 'all' : 'route';

    if (reason !== 'button_click') {
      if (import.meta.env.DEV) {
        console.warn('Coach analysis blocked', { reason });
      }
      return;
    }
    if (import.meta.env.DEV) {
      console.log('Coach analysis triggered', { reason: 'button_click' });
    }
    if (agentState === 'thinking') return;
    if (!currentTelemetry) {
      setAgentWarning(null);
      setAgentFailure({
        status: 'network',
        url: apiOrchestrateUrl,
        message: 'No active player telemetry available for analysis.',
        hint: null,
      });
      setAgentState('invalid');
      setAnalysisActive(false);
      return;
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
    setCombinedDecision(null);
    setOrchestrateMeta(null);
    setRouterDecision(null);
    setAgentFeedStatus({ fatigue: 'loading', risk: 'idle', tactical: 'loading' });
    setAgentWarning(null);
    setAgentFailure(null);
    setAgentState('thinking');

    const requestMode: 'auto' | 'route' = mode === 'auto' ? 'auto' : 'route';
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
    const batsmen = players.filter((p) => p.role === 'Batsman' && p.inRoster !== false && !p.isDismissed);
    const bench = players
      .filter((p) => {
        if (p.id === activePlayer?.id) return false;
        if (p.inRoster === false) return false;
        if (p.isDismissed) return false;
        const workload = sanitizeBowlerWorkload(p, matchContext.format);
        return workload.oversRemaining > 0;
      })
      .map((p) => p.name);
    const selectedPlayerBaseline = activePlayer ? baselineFromPlayer(activePlayer) : null;
    const text = `${currentTelemetry.playerName} overs ${oversBowled}/${maxOvers} (remaining ${oversRemaining}), fatigue ${fatigue.toFixed(1)}/10, injury risk ${injuryLabel}, no-ball risk ${noBallRiskLabel}, ${quotaComplete ? 'quota completed for format' : 'quota available'}, ${isUnfit ? 'marked unfit' : 'currently fit'}.`;
    const payload = {
      text,
      mode: requestMode,
      signals: {
        injury,
        isUnfit,
        fatigue,
        noBallRisk,
        oversBowled,
        oversRemaining,
        maxOvers,
        quotaComplete,
        intensity: matchContext.pitch || 'Medium',
      },
      telemetry: {
        playerId: currentTelemetry.playerId,
        playerName: currentTelemetry.playerName,
        role: currentTelemetry.role,
        fatigueIndex: fatigue,
        heartRateRecovery: currentTelemetry.heartRateRecovery,
        oversBowled,
        oversRemaining,
        maxOvers,
        quotaComplete,
        consecutiveOvers: 0,
        injuryRisk: injuryLabel,
        noBallRisk,
        fatigueLimit: currentTelemetry.fatigueLimit,
        sleepHours: currentTelemetry.sleepHours,
        recoveryMinutes: currentTelemetry.recoveryMinutes,
        isUnfit,
      },
      matchContext: {
        format: currentTelemetry.matchContext.format,
        phase: normalizedPhase,
        requiredRunRate: Number(requiredRunRate.toFixed(2)),
        currentRunRate: Number(currentRunRate.toFixed(2)),
        wicketsInHand,
        oversRemaining: inningsOversRemaining,
        over: safeNum(Number(formatOverStr(matchState.ballsBowled)), 0),
        intensity: currentTelemetry.matchContext.intensity,
        conditions: matchContext.weather,
        target: typeof matchState.target === 'number' ? matchState.target : undefined,
        score: matchState.runs,
        balls: ballsRemaining,
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
      console.log('Orchestrate payload', payload);
    }

    try {
      await checkHealth(controller.signal);
      const result: OrchestrateResponse = useAgentFramework
        ? await postAgentFrameworkOrchestrate(payload, frameworkMode, controller.signal)
        : await postOrchestrate(payload, controller.signal);
      if (requestId !== fatigueRequestSeq.current) return;
      const fatigueMapped = result.fatigue ? buildAiAnalysis(result.fatigue, 'fatigue') : null;
      const riskMapped = result.risk ? buildAiAnalysis(result.risk, 'risk') : null;
      const tacticalMapped = result.tactical || null;

      setAiAnalysis(fatigueMapped);
      setRiskAnalysis(riskMapped);
      setTacticalAnalysis(tacticalMapped);
      setCombinedDecision((result.finalDecision || result.combinedDecision) || null);
      setOrchestrateMeta({
        mode: result.meta.mode,
        executedAgents: result.meta.executedAgents,
        usedFallbackAgents: result.meta.usedFallbackAgents || [],
      });
      setRouterDecision(result.routerDecision || null);

      const fatigueErrored = result.errors.some((e) => e.agent === 'fatigue');
      const riskErrored = result.errors.some((e) => e.agent === 'risk');
      const tacticalErrored = result.errors.some((e) => e.agent === 'tactical');
      setAgentFeedStatus({
        fatigue: result.meta.executedAgents.includes('fatigue')
          ? (fatigueMapped ? 'done' : fatigueErrored ? 'error' : 'idle')
          : 'idle',
        risk: result.meta.executedAgents.includes('risk')
          ? (riskMapped ? 'done' : riskErrored ? 'error' : 'idle')
          : 'idle',
        tactical: result.meta.executedAgents.includes('tactical')
          ? (tacticalMapped ? 'done' : tacticalErrored ? 'error' : 'idle')
          : 'idle',
      });

      const visibleErrors = result.errors.filter((e) => !(e.agent === 'tactical' && tacticalMapped));
      setAgentWarning(visibleErrors.length > 0 ? visibleErrors.map((e) => `${e.agent}: ${e.message}`).join(' | ') : null);
      setAgentFailure(null);
      setAgentState(result.errors.length > 0 && !fatigueMapped && !riskMapped && !tacticalMapped ? 'offline' : 'done');
      setAnalysisActive(true);
    } catch (error) {
      if ((error as Error)?.name === 'AbortError') return;
      if (requestId !== fatigueRequestSeq.current) return;
      setAgentFeedStatus((prev) => ({
        fatigue: prev.fatigue === 'loading' ? 'error' : prev.fatigue,
        risk: prev.risk === 'loading' ? 'error' : prev.risk,
        tactical: prev.tactical === 'loading' ? 'error' : prev.tactical,
      }));
      setAgentWarning(null);
      setAgentFailure(toAgentFailureDetail(error, orchestrateRequestUrl));
      setAgentState('offline');
      setAnalysisActive(false);
    }
  };

  useEffect(() => {
    if (page !== 'dashboard') return;
    fatigueAbortRef.current?.abort();
    if (!analysisRequested) {
      setAiAnalysis(null);
      setRiskAnalysis(null);
      setTacticalAnalysis(null);
      setCombinedDecision(null);
      setOrchestrateMeta(null);
      setRouterDecision(null);
      setAgentFeedStatus({ fatigue: 'idle', risk: 'idle', tactical: 'idle' });
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
    setCombinedDecision(null);
    setOrchestrateMeta(null);
    setRouterDecision(null);
    setAgentFeedStatus({ fatigue: 'idle', risk: 'idle', tactical: 'idle' });
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
    const shouldPersist = options?.persist !== false;
    const orderedBaselines = orderBaselinesForDisplay(baselines);
    const storedRosterIds = readMatchRosterIdsFromStorage();
    const currentRosterIds = matchRosterIds.length > 0 || storedRosterIds === null
      ? matchRosterIds
      : storedRosterIds;
    const normalizedRosterIds = resolveMatchRosterIds(orderedBaselines, currentRosterIds);
    const baselineIdSet = new Set(getEligibleRosterBaselineIds(orderedBaselines).map((id) => baselineKey(id)));
    const seen = new Set(normalizedRosterIds.map((id) => baselineKey(id)));
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
    const resolvedRosterIds = [...normalizedRosterIds, ...additions].slice(0, MAX_ROSTER);
    setWorkingBaselines(orderedBaselines);
    setBaselineSource(source);
    setBaselineWarning(warning || (source === 'fallback' ? 'Cosmos not configured. Using fallback baseline profiles.' : null));
    setMatchRosterIds(resolvedRosterIds);
    writeMatchRosterIdsToStorage(resolvedRosterIds);
    if (shouldPersist) {
      writeBaselinesToStorage(orderedBaselines);
    }
    // IMPORTANT: Roster is derived from local match roster IDs only.
    setPlayers((prev) => {
      const derivedRoster = buildRosterPlayersFromBaselines(prev, orderedBaselines, resolvedRosterIds);
      if (!derivedRoster.some((player) => player.id === activePlayerId) && derivedRoster.length > 0) {
        setTimeout(() => setActivePlayerId(derivedRoster[0].id), 0);
      }
      return derivedRoster;
    });
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
                  <button 
                    onClick={() => navigateTo('dashboard')}
                    className={`text-sm font-medium transition-colors px-3 py-1.5 rounded-md ${page === 'dashboard' ? 'bg-emerald-500/10 text-emerald-400' : 'text-slate-400 hover:text-white'}`}
                  >
                    Dashboard
                  </button>
                  <button 
                    onClick={() => navigateTo('baselines')}
                    className={`text-sm font-medium transition-colors px-3 py-1.5 rounded-md ${page === 'baselines' ? 'bg-emerald-500/10 text-emerald-400' : 'text-slate-400 hover:text-white'}`}
                  >
                    Player Baselines
                  </button>
                </>
              )}
              
              {/* Profile Dropdown */}
              <div className="relative">
                <button 
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
                      <button className="w-full flex items-center gap-2 text-sm text-slate-400 hover:text-white py-2 px-2 hover:bg-white/5 rounded-lg transition-colors">
                        <Settings className="w-4 h-4" /> Account Settings
                      </button>
                      <button className="w-full flex items-center gap-2 text-sm text-rose-400 hover:text-rose-300 py-2 px-2 hover:bg-rose-500/10 rounded-lg transition-colors">
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
                    <button 
                       onClick={() => updatePlayer(activePlayer.id, { isInjured: false })}
                       className="flex-1 py-3 rounded-xl bg-slate-800 text-slate-300 font-bold hover:bg-slate-700 transition-colors text-sm"
                    >
                      Dismiss
                    </button>
                    <button 
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
              combinedDecision={combinedDecision}
              orchestrateMeta={orchestrateMeta}
              routerDecision={routerDecision}
              agentFeedStatus={agentFeedStatus}
              analysisActive={analysisActive}
              runAgent={runAgent}
              onDismissAnalysis={dismissAnalysis}
              handleAddOver={handleAddOver}
              handleDecreaseOver={handleDecreaseOver}
              handleNewSpell={handleNewSpell}
              handleRest={handleRest}
              handleMarkUnfit={handleMarkUnfit}
              recoveryMode={recoveryMode}
              setRecoveryMode={setRecoveryMode}
              manualRecovery={manualRecovery}
              setManualRecovery={setManualRecovery}
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
        <button className="w-8 h-8 rounded-full bg-slate-800 text-slate-400 flex items-center justify-center hover:bg-slate-700 hover:text-white transition-colors shadow-lg border border-white/5">
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
            <button 
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
  const handleChange = (key: keyof MatchContext, value: string) => {
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
                <button
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
                <button
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
                  <button 
                    onClick={() => handleChange('weather', 'Cool')}
                    className={`flex-1 flex items-center justify-center gap-2 py-3 rounded-lg text-sm font-medium border ${context.weather === 'Cool' ? 'bg-indigo-500/20 border-indigo-500 text-white' : 'bg-slate-800 border-slate-700 text-slate-400'}`}
                  >
                    <Wind className="w-4 h-4" /> Cool
                  </button>
                  <button 
                    onClick={() => handleChange('weather', 'Hot')}
                    className={`flex-1 flex items-center justify-center gap-2 py-3 rounded-lg text-sm font-medium border ${context.weather === 'Hot' ? 'bg-orange-500/20 border-orange-500 text-white' : 'bg-slate-800 border-slate-700 text-slate-400'}`}
                  >
                    <Thermometer className="w-4 h-4" /> Hot
                  </button>
                </div>
            </div>
          </div>

          <button 
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

interface DashboardProps {
  matchContext: MatchContext;
  matchState: MatchState;
  players: Player[];
  activePlayer: (Player & { status: StatusLevel; loadRatio: number; maxOvers: number; oversRemaining: number }) | null;
  setActivePlayerId: React.Dispatch<React.SetStateAction<string>>;
  updatePlayer: (id: string, updates: Partial<Player> | ((player: Player) => Partial<Player>)) => void;
  updateMatchState: (updates: Partial<MatchState>) => void;
  deleteRosterPlayer: (id: string) => void;
  movePlayerToSub: (id: string) => void;
  agentState: 'idle' | 'thinking' | 'done' | 'offline' | 'invalid';
  aiAnalysis: AiAnalysis | null;
  riskAnalysis: AiAnalysis | null;
  tacticalAnalysis: TacticalAgentResponse | null;
  combinedDecision: TacticalCombinedDecision | null;
  orchestrateMeta: OrchestrateMetaView | null;
  routerDecision: RouterDecisionView | null;
  agentFeedStatus: AgentFeedStatus;
  agentWarning: string | null;
  agentFailure: AgentFailureDetail | null;
  analysisActive: boolean;
  runAgent: (mode?: 'auto' | 'full', reason?: 'button_click' | 'non_button') => Promise<void>;
  onDismissAnalysis: () => void;
  handleAddOver: () => void;
  handleDecreaseOver: () => void;
  handleNewSpell: () => void;
  handleRest: () => void;
  handleMarkUnfit: () => void;
  recoveryMode: RecoveryMode;
  setRecoveryMode: React.Dispatch<React.SetStateAction<RecoveryMode>>;
  manualRecovery: RecoveryLevel;
  setManualRecovery: React.Dispatch<React.SetStateAction<RecoveryLevel>>;
  onGoToBaselines: () => void;
  onBack: () => void;
}

function Dashboard({
  matchContext, matchState, players, activePlayer, setActivePlayerId, updatePlayer, updateMatchState, deleteRosterPlayer, movePlayerToSub,
  agentState, aiAnalysis, riskAnalysis, tacticalAnalysis, combinedDecision, orchestrateMeta, routerDecision, agentFeedStatus, agentWarning, agentFailure, analysisActive, runAgent, onDismissAnalysis, handleAddOver, handleDecreaseOver, handleNewSpell, handleRest, handleMarkUnfit,
  recoveryMode, setRecoveryMode, manualRecovery, setManualRecovery, onGoToBaselines, onBack
}: DashboardProps) {
  const [arTelemetryView, setArTelemetryView] = useState<'batting' | 'bowling'>('batting');
  const [strainIndex, setStrainIndex] = useState(0);
  const [isResettingBaselines, setIsResettingBaselines] = useState(false);
  const [rosterEmptyError, setRosterEmptyError] = useState<string | null>(null);
  const [substitutionRecommendation, setSubstitutionRecommendation] = useState<string | null>(null);
  const [isRunCoachHovered, setIsRunCoachHovered] = useState(false);
  const [showRouterSignals, setShowRouterSignals] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);

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
    setStrainIndex(0);
  }, [activePlayer?.id]);

  const rosterPlayers = players.filter((p: Player) => p.inRoster !== false);
  const totalCount = rosterPlayers.length;
  const hasRosterPlayers = rosterPlayers.length > 0;
  const isRosterFull = totalCount >= MAX_ROSTER;

  const handleResetBaselines = async () => {
    setRosterEmptyError(null);
    setIsResettingBaselines(true);
    try {
      await resetBaselines();
      const response = await getBaselinesWithMeta();
      writeBaselinesToStorage(response.baselines);
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
    onDismissAnalysis?.();
  };

  const telemetryView: 'batting' | 'bowling' = activePlayer?.role === 'Batsman'
    ? 'batting'
    : activePlayer?.role === 'All-rounder'
      ? arTelemetryView
      : 'bowling';
  const isBatsmanActive = telemetryView === 'batting';

  const totalBalls = totalBallsFromOvers(matchState.totalOvers);
  const ballsBowled = Math.min(totalBalls, Math.max(0, matchState.ballsBowled));
  const ballsRemaining = Math.max(totalBalls - ballsBowled, 0);
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
  const applyStrainDelta = (delta: number) => {
    setStrainIndex((prev) => Math.max(0, Math.min(5, prev + delta)));
  };
  const overStr = formatOverStr(ballsBowled);
  const oversFaced = ballsBowled / 6;
  const currentRunRate = ballsBowled > 0 ? matchState.runs / oversFaced : 0;
  const runsNeeded = matchState.target != null ? Math.max(matchState.target - matchState.runs, 0) : 0;
  const requiredRunRate = matchState.target != null && ballsRemaining > 0 ? (runsNeeded / ballsRemaining) * 6 : 0;
  const requiredStrikeRate = matchState.target != null && ballsRemaining > 0 ? (runsNeeded / ballsRemaining) * 100 : 0;
  const projectedScoreAtCurrentRR = matchState.runs + (currentRunRate * (ballsRemaining / 6));
  const winByRuns = matchState.target != null ? projectedScoreAtCurrentRR >= matchState.target : false;
  const batsmanStrikeRate = activePlayer && activePlayer.balls > 0
    ? (activePlayer.runs / activePlayer.balls) * 100
    : 0;

  const srGap = Math.max(0, requiredStrikeRate - batsmanStrikeRate);
  const phaseMultiplier = matchContext.phase === 'Death' ? 1.2 : matchContext.phase === 'Middle' ? 1.0 : 0.9;
  const pressureDrivers = [
    {
      key: 'sr_gap',
      score: Math.min(4.5, srGap / 12),
      reason: `SR gap ${srGap.toFixed(1)} (${batsmanStrikeRate.toFixed(1)} vs ${requiredStrikeRate.toFixed(1)})`,
      recommendation: 'Rotate strike early in the over and avoid back-to-back dot balls.'
    },
    {
      key: 'balls_left',
      score: Math.min(3.0, Math.max(0, 1 - (ballsRemaining / Math.max(1, totalBalls))) * 3.0),
      reason: `${ballsRemaining} balls left from ${totalBalls}`,
      recommendation: 'Pre-plan two scoring zones and commit to high-percentage placement.'
    },
    {
      key: 'wickets',
      score: Math.min(2.5, Math.max(0, matchState.wickets - 2) * 0.42),
      reason: `${matchState.wickets} wickets down`,
      recommendation: 'Reduce aerial risk and preserve wicket value for the back end.'
    },
    {
      key: 'phase',
      score: matchContext.phase === 'Death' ? 1.2 : matchContext.phase === 'Middle' ? 0.7 : 0.4,
      reason: `${matchContext.phase} phase`,
      recommendation: matchContext.phase === 'Death'
        ? 'Target straighter boundary options against yorker-heavy plans.'
        : 'Work singles into gaps to keep required rate stable.'
    }
  ];

  const pressureIndex = Math.max(
    0,
    Math.min(10, pressureDrivers.reduce((sum, driver) => sum + driver.score, 0) * phaseMultiplier)
  );
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
    : primaryDriver === 'balls_left'
      ? 'Time Pressure Increasing'
      : primaryDriver === 'wickets'
        ? 'Wicket Context Raising Risk'
        : isPressureCritical
          ? 'High Batting Pressure Detected'
          : 'Run-Rate Tempo Behind Requirement';
  const tacticalAlertText = primaryDriver === 'sr_gap'
    ? 'Current scoring speed is below chase requirement; stabilize tempo without gifting high-risk chances.'
    : primaryDriver === 'balls_left'
      ? 'Ball inventory is shrinking quickly; prioritize strike rotation and boundary setup patterns.'
      : primaryDriver === 'wickets'
        ? 'Wickets in hand are limited, so expected-value shot selection is now critical.'
        : 'Pressure is building from multiple signals; adjust intent and shot map proactively.';
  const alertWhyLine = `Why this alert: SR gap ${srGap.toFixed(1)}, balls left ${ballsRemaining}, wickets ${matchState.wickets}, phase ${matchContext.phase}.`;
  const pressureToneClass = pressureIndex > 7 ? 'text-rose-400' : pressureIndex >= 4 ? 'text-amber-300' : 'text-emerald-400';
  const pressureBarClass = pressureIndex > 7 ? 'bg-rose-500' : pressureIndex >= 4 ? 'bg-amber-400' : 'bg-emerald-500';
  const boundaryEvents = activePlayer?.boundaryEvents || [];
  const foursCount = boundaryEvents.filter((event) => event === '4').length;
  const sixesCount = boundaryEvents.filter((event) => event === '6').length;
  const selectedAgents = routerDecision?.selectedAgents || orchestrateMeta?.executedAgents || [];
  const selectedAgentSet = new Set(selectedAgents);
  const agentBorderColor: Record<'fatigue' | 'risk' | 'tactical', string> = {
    fatigue: 'rgb(96, 165, 250)',
    risk: 'rgb(74, 222, 128)',
    tactical: 'rgb(252, 211, 77)',
  };
  const toStatusLabel = (status: 'idle' | 'loading' | 'done' | 'error', isSelected: boolean, isFallback?: boolean): 'OK' | 'RUNNING' | 'SKIPPED' | 'FALLBACK' | 'ERROR' => {
    if (!isSelected && orchestrateMeta?.mode === 'auto') return 'SKIPPED';
    if (status === 'loading') return 'RUNNING';
    if (status === 'error') return isFallback ? 'FALLBACK' : 'ERROR';
    if (status === 'done') return isFallback ? 'FALLBACK' : 'OK';
    return isSelected ? 'RUNNING' : 'SKIPPED';
  };
  const finalDecision = combinedDecision
    ? {
        severity: aiAnalysis?.severity || riskAnalysis?.severity || 'LOW',
        action: combinedDecision.immediateAction,
        reasons: [
          combinedDecision.rationale,
          combinedDecision.suggestedAdjustments[0] || 'No additional adjustment suggested.',
        ],
      }
    : aiAnalysis && riskAnalysis
      ? {
          severity: aiAnalysis.severity === 'CRITICAL' || riskAnalysis.severity === 'CRITICAL'
            ? 'CRITICAL'
            : aiAnalysis.severity === 'HIGH' || riskAnalysis.severity === 'HIGH'
              ? 'HIGH'
              : aiAnalysis.severity === 'MED' || riskAnalysis.severity === 'MED'
                ? 'MED'
                : 'LOW',
          action:
            aiAnalysis.severity === 'CRITICAL' || riskAnalysis.severity === 'CRITICAL'
              ? 'Immediate substitution advised. Remove from active workload quota now.'
              : aiAnalysis.severity === 'HIGH' || riskAnalysis.severity === 'HIGH'
                ? 'Rotate bowler for next over.'
                : aiAnalysis.severity === 'MED' || riskAnalysis.severity === 'MED'
                  ? 'No immediate change; manage remaining quota and monitor trend.'
                  : 'No change, continue and monitor trend.',
          reasons: [
            aiAnalysis.headline,
            riskAnalysis.headline,
          ],
        }
      : null;
  const isCoachOutputState = analysisActive;
  const handleAddBoundary = (boundary: '4' | '6') => {
    if (!activePlayer) return;
    updatePlayer(activePlayer.id, { boundaryEvents: [...boundaryEvents, boundary] });
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
              onClick={() => applyStrainDelta(1)}
              disabled={isStrainMax}
              className={`${strainButtonBase} bg-emerald-500/10 border border-emerald-400/30 text-emerald-200 hover:bg-emerald-500/20 hover:border-emerald-400/60 hover:shadow-[0_0_18px_rgba(16,185,129,0.25)] focus-visible:ring-emerald-400/45`}
            >
              Minor
            </button>
            <button
              type="button"
              onClick={() => applyStrainDelta(2)}
              disabled={isStrainMax}
              className={`${strainButtonBase} bg-emerald-500/15 border border-emerald-400/40 text-white hover:bg-emerald-500/25 hover:shadow-[0_0_22px_rgba(16,185,129,0.35)] focus-visible:ring-emerald-400/45`}
            >
              Heavy
            </button>
            <button
              type="button"
              onClick={() => setStrainIndex(0)}
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

  // Auto-follow new analysis output while user is near the bottom.
  useEffect(() => {
    if (!isCoachOutputState) return;
    if (!stickToBottomRef.current) return;
    scrollCoachOutputToBottom('smooth');
  }, [agentState, aiAnalysis, riskAnalysis, tacticalAnalysis, combinedDecision, orchestrateMeta, agentWarning, substitutionRecommendation, isCoachOutputState]);

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
               max={totalBalls}
               step="1"
               value={ballsBowled}
               onChange={(e) => updateMatchState({ ballsBowled: Math.min(totalBalls, Math.max(0, Number(e.target.value) || 0)) })}
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
        </div>
      </div>

      <div className="w-full flex-1 min-h-0">
      <div data-testid="dashboard-grid" className="h-full min-h-0 grid lg:grid-cols-12 gap-6 mt-0 items-stretch">
        
        {/* LEFT: ROSTER (EDITABLE) */}
        <div className="lg:col-span-3 flex flex-col gap-4 min-h-0 h-full">
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
              {hasRosterPlayers ? rosterPlayers.map((player: Player) => {
                const isSelected = activePlayer?.id === player.id;
                return (
                  <div key={player.id} className="relative group">
                    <button
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
                      {/* Only show Chevron if not hovering (to avoid clash with delete) or just keep it simple */}
                      {isSelected && <ChevronRight className="w-5 h-5 text-emerald-500 ml-auto shrink-0 group-hover:hidden" />}
                    </button>
                    
                    {/* Delete Button (Hover) */}
                    <button 
                      onClick={(e) => { e.stopPropagation(); removeFromRoster(player.baselineId || player.id); }}
                      className="absolute right-2 top-1/2 -translate-y-1/2 p-2 rounded-lg bg-rose-500/20 text-rose-400 opacity-0 group-hover:opacity-100 transition-opacity hover:bg-rose-500 hover:text-white"
                    >
                      <Trash2 className="w-5 h-5" />
                    </button>
                  </div>
                );
              }) : (
                <div className="rounded-xl border border-white/10 bg-slate-900/50 px-4 py-6 text-center">
                  <p className="text-sm font-semibold text-slate-200">No players yet</p>
                  <p className="mt-1 text-xs text-slate-400">
                    Add your first player profile from the Add Player button below.
                  </p>
                  <div className="mt-4 flex flex-col gap-2">
                    <button
                      onClick={handleResetBaselines}
                      disabled={isResettingBaselines}
                      className="w-full rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-xs font-bold text-emerald-200 hover:bg-emerald-500/20 disabled:opacity-60 disabled:cursor-not-allowed"
                    >
                      {isResettingBaselines ? 'Resetting...' : 'Reset Baselines'}
                    </button>
                  </div>
                  {rosterEmptyError && <p className="mt-3 text-[11px] text-rose-300">{rosterEmptyError}</p>}
                </div>
              )}

              <div className="mt-2 pt-2 border-t border-white/5">
                <button
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
            </div>
          </div>
        </div>

        {/* CENTER: METRICS */}
        <div className="lg:col-span-6 flex flex-col gap-4 min-h-0 h-full">
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
                <div className="px-3 py-1 bg-slate-800 rounded border border-slate-700 text-xs font-mono text-slate-400">
                  ID: {activePlayer.id.toUpperCase()}
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
                    className="min-h-0 flex flex-col"
                  >
                  <div className="grid grid-cols-2 gap-4 mb-8">
                    <div className="bg-[#162032] rounded-xl p-5 border border-white/5 text-center">
                      <div className="text-xs font-bold uppercase mb-2 text-slate-500">Runs</div>
                      <div className="text-5xl font-mono font-medium mb-2 text-white">{activePlayer.runs}</div>
                      <div className="flex justify-center gap-4 mt-2">
                        <button
                          onClick={() => {
                            const runDelta = Math.min(1, activePlayer.runs);
                            updatePlayer(activePlayer.id, { runs: Math.max(0, activePlayer.runs - 1) });
                            updateMatchState({ runs: Math.max(0, matchState.runs - runDelta) });
                          }}
                          className="w-8 h-8 rounded-full flex items-center justify-center border bg-slate-800 hover:bg-slate-700 text-white border-slate-600"
                        >
                          <Minus className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => {
                            updatePlayer(activePlayer.id, { runs: activePlayer.runs + 1 });
                            updateMatchState({ runs: matchState.runs + 1 });
                          }}
                          className="w-8 h-8 rounded-full flex items-center justify-center bg-emerald-600 hover:bg-emerald-500 text-white shadow-lg shadow-emerald-500/20"
                        >
                          <Plus className="w-4 h-4" />
                        </button>
                      </div>
                    </div>

                    <div className="bg-[#162032] rounded-xl p-5 border border-white/5 text-center">
                      <div className="text-xs font-bold uppercase mb-2 text-slate-500">Balls Faced</div>
                      <div className="text-5xl font-mono font-medium mb-2 text-white">{activePlayer.balls}</div>
                      <div className="flex justify-center gap-4 mt-2">
                        <button
                          onClick={() => {
                            const nextBalls = Math.max(0, activePlayer.balls - 1);
                            const reducedMatchBalls = Math.max(0, ballsBowled - 1);
                            updatePlayer(activePlayer.id, { balls: nextBalls });
                            updateMatchState({ ballsBowled: reducedMatchBalls });
                          }}
                          className="w-8 h-8 rounded-full flex items-center justify-center border bg-slate-800 hover:bg-slate-700 text-white border-slate-600"
                        >
                          <Minus className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => {
                            const nextBalls = activePlayer.balls + 1;
                            const increasedMatchBalls = Math.min(totalBalls, ballsBowled + 1);
                            updatePlayer(activePlayer.id, { balls: nextBalls });
                            updateMatchState({ ballsBowled: increasedMatchBalls });
                          }}
                          className="w-8 h-8 rounded-full flex items-center justify-center bg-emerald-600 hover:bg-emerald-500 text-white shadow-lg shadow-emerald-500/20"
                        >
                          <Plus className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  </div>

                  <div className="h-px bg-gradient-to-r from-transparent via-slate-700 to-transparent my-2" />

                  <div className="grid grid-cols-2 gap-x-8 gap-y-6 mt-6">
                    <div className="bg-[#162032] p-4 rounded-lg border border-white/5">
                      <div className="flex items-center justify-between mb-1">
                        <label className="text-xs font-bold uppercase tracking-wide text-slate-400">Strike Rate</label>
                        <span className="text-[10px] text-slate-500">Live</span>
                      </div>
                      <div className="flex items-end gap-2 mb-2">
                        <div className={`text-4xl font-mono tabular-nums ${pressureToneClass}`}>
                          {batsmanStrikeRate.toFixed(1)}
                        </div>
                        <span className="text-[10px] text-slate-500 pb-1">runs / 100 balls</span>
                      </div>
                      <div className="flex items-center gap-3 text-[11px]">
                        <div className="inline-flex items-center gap-1.5 rounded-md border border-white/10 bg-slate-900/40 px-2 py-1">
                          <span className="text-slate-500">Required SR</span>
                          <span className="font-mono tabular-nums text-slate-300">{requiredStrikeRate.toFixed(1)}</span>
                        </div>
                        <span className="text-slate-600">|</span>
                        <div className="inline-flex items-center gap-1.5 rounded-md border border-white/10 bg-slate-900/40 px-2 py-1">
                          <span className="text-slate-500">Required RR</span>
                          <span className="font-mono tabular-nums text-slate-300">{requiredRunRate.toFixed(2)}</span>
                        </div>
                      </div>
                      <div className="mt-2 text-[11px] text-slate-500">
                        Current RR: <span className="font-mono tabular-nums text-slate-300">{currentRunRate.toFixed(2)}</span>
                        <span className="mx-2 text-slate-600">|</span>
                        Projection: <span className="font-mono tabular-nums text-slate-300">{projectedScoreAtCurrentRR.toFixed(0)}</span>
                        {matchState.target != null && (
                          <>
                            <span className="mx-2 text-slate-600">|</span>
                            <span className={winByRuns ? 'text-emerald-400' : 'text-rose-400'}>{winByRuns ? 'On Track' : 'Behind Rate'}</span>
                          </>
                        )}
                      </div>
                    </div>

                    <div className="bg-[#162032] p-4 rounded-lg border border-white/5">
                      <label className="text-xs font-bold mb-2 block text-slate-400">Boundaries</label>
                      <div className="space-y-2">
                        <div className="flex items-center rounded-lg border border-white/10 bg-slate-900/40 px-3 py-2">
                          <span className="w-12 text-xs font-semibold text-slate-300">Four</span>
                          <span className="flex-1 text-center text-sm font-mono text-white">{foursCount}</span>
                          <button
                            onClick={() => handleAddBoundary('4')}
                            aria-label="Add four boundary"
                            disabled={!activePlayer || activePlayer.isDismissed}
                            className="w-8 h-8 rounded-full border border-white/15 bg-slate-800/80 text-slate-200 flex items-center justify-center transition-all hover:border-emerald-400/40 hover:text-emerald-300 hover:shadow-[0_0_10px_rgba(16,185,129,0.25)] disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
                          >
                            <Plus className="w-4 h-4" />
                          </button>
                        </div>
                        <div className="flex items-center rounded-lg border border-white/10 bg-slate-900/40 px-3 py-2">
                          <span className="w-12 text-xs font-semibold text-slate-300">Six</span>
                          <span className="flex-1 text-center text-sm font-mono text-white">{sixesCount}</span>
                          <button
                            onClick={() => handleAddBoundary('6')}
                            aria-label="Add six boundary"
                            disabled={!activePlayer || activePlayer.isDismissed}
                            className="w-8 h-8 rounded-full border border-white/15 bg-slate-800/80 text-slate-200 flex items-center justify-center transition-all hover:border-emerald-400/40 hover:text-emerald-300 hover:shadow-[0_0_10px_rgba(16,185,129,0.25)] disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
                          >
                            <Plus className="w-4 h-4" />
                          </button>
                        </div>
                      </div>
                      <p className="mt-2 text-[10px] text-slate-500">Tap Add 4 / Add 6 during scoring.</p>
                    </div>
                  </div>

                  <div className="mt-6 bg-[#162032] p-4 rounded-lg border border-white/5">
                    <div className="flex items-center justify-between mb-2">
                      <label className="text-xs font-bold text-slate-400">Pressure Index (0-10)</label>
                      <span className={`font-mono font-bold ${pressureToneClass}`}>{pressureIndex.toFixed(1)}</span>
                    </div>
                    <div className="h-3 bg-slate-800 rounded-full overflow-hidden border border-white/5">
                      <motion.div
                        initial={false}
                        animate={{ width: `${(pressureIndex / 10) * 100}%` }}
                        className={`h-full ${pressureBarClass}`}
                        transition={{ duration: 0.25 }}
                      />
                    </div>
                    <div className="mt-2 flex justify-between text-[10px] uppercase tracking-wide text-slate-500">
                      <span>Low &lt;4</span>
                      <span>Moderate 4-7</span>
                      <span>High &gt;7</span>
                    </div>
                  </div>

                  <div className="mt-auto pt-8">
                    <p className="text-[10px] font-bold text-slate-500 uppercase mb-3">Dismissal Controls</p>
                    <div className="grid grid-cols-3 gap-3">
                      <select
                        value={activePlayer.dismissalType || 'Not Out'}
                        onChange={(e) => updatePlayer(activePlayer.id, { dismissalType: e.target.value as Player['dismissalType'] })}
                        className="bg-slate-800 border border-slate-700 text-white rounded-lg px-3 py-3 text-xs font-bold"
                      >
                        <option value="Not Out">Not Out</option>
                        <option value="Bowled">Bowled</option>
                        <option value="Caught">Caught</option>
                        <option value="LBW">LBW</option>
                        <option value="Run Out">Run Out</option>
                      </select>
                      <button
                        onClick={() => {
                          const nextDismissed = !activePlayer.isDismissed;
                          updatePlayer(activePlayer.id, { isDismissed: nextDismissed, dismissalType: nextDismissed ? (activePlayer.dismissalType || 'Caught') : 'Not Out' });
                          updateMatchState({
                            wickets: nextDismissed
                              ? Math.min(10, matchState.wickets + 1)
                              : Math.max(0, matchState.wickets - 1)
                          });
                        }}
                        className={`p-3 rounded-lg transition-colors border text-xs font-bold ${activePlayer.isDismissed ? 'bg-rose-500/20 text-rose-300 border-rose-500/40' : 'bg-amber-500/10 text-amber-300 border-amber-500/30 hover:bg-amber-500/20'}`}
                      >
                        {activePlayer.isDismissed ? 'Mark Not Out' : 'Mark Out'}
                      </button>
                      <button
                        onClick={() => {
                          const correctedScore = Math.max(0, matchState.runs - activePlayer.runs);
                          const correctedBalls = Math.max(0, ballsBowled - activePlayer.balls);
                          const correctedWickets = activePlayer.isDismissed ? Math.max(0, matchState.wickets - 1) : matchState.wickets;
                          updatePlayer(activePlayer.id, { runs: 0, balls: 0, boundaryEvents: [], isDismissed: false, dismissalType: 'Not Out' });
                          updateMatchState({
                            runs: correctedScore,
                            ballsBowled: correctedBalls,
                            wickets: correctedWickets
                          });
                        }}
                        className="p-3 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 text-xs font-bold"
                      >
                        Reset Innings
                      </button>
                    </div>
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
                      <button
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
                          <button
                            onClick={handleDecreaseOver}
                            disabled={activePlayer.isSub || activePlayer.isUnfit}
                            className={`w-12 h-12 rounded-full flex items-center justify-center border transition-all ${activePlayer.isSub || activePlayer.isUnfit ? 'bg-slate-800/50 text-slate-600 border-slate-800 cursor-not-allowed' : 'cursor-pointer bg-slate-800 hover:bg-slate-700 text-white border-slate-600'}`}
                          >
                            <Minus className="w-6 h-6" />
                          </button>
                          <button
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
                      <button onClick={handleMarkUnfit} className={`border p-4 rounded-lg transition-all flex flex-col items-center group shadow-lg ${activePlayer.isUnfit ? 'bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 border-emerald-500/30 shadow-emerald-900/10' : 'bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 border-rose-500/30 shadow-rose-900/10'}`}>
                        <Zap className="w-5 h-5 mb-0.5" />
                        <span className="text-sm font-bold">{activePlayer.isUnfit ? 'Mark Fit' : 'Mark Unfit'}</span>
                        <span className="text-[10px] opacity-70">{activePlayer.isUnfit ? 'Restore player state' : 'Force critical state'}</span>
                      </button>
                      <button onClick={handleNewSpell} disabled={activePlayer.isUnfit} className={`p-4 rounded-lg transition-colors flex flex-col items-center border ${activePlayer.isUnfit ? 'bg-slate-800/50 text-slate-600 border-slate-800 cursor-not-allowed' : 'bg-slate-800 hover:bg-slate-700 text-slate-300 border-slate-700'}`}>
                        <CheckCircle2 className="w-5 h-5 mb-0.5" />
                        <span className="text-sm font-bold">New Spell</span>
                        <span className="text-[10px] opacity-70">Reset count</span>
                      </button>
                      <button
                        onClick={handleRest}
                        disabled={activePlayer.isUnfit}
                        className={`p-4 rounded-lg transition-all flex flex-col items-center border ${activePlayer.isUnfit ? 'bg-slate-800/50 text-slate-600 border-slate-800 cursor-not-allowed' : activePlayer.isResting ? 'bg-emerald-500/20 border-emerald-500/50 text-emerald-400 shadow-[0_0_15px_rgba(16,185,129,0.2)]' : 'bg-slate-800 hover:bg-slate-700 text-slate-300 border-slate-700'}`}
                      >
                        <Wind className={`w-5 h-5 mb-0.5 ${activePlayer.isResting ? 'animate-pulse' : ''}`} />
                        <span className="text-sm font-bold">{activePlayer.isResting ? 'Resting...' : 'Rest'}</span>
                        <span className="text-[10px] opacity-70">{activePlayer.isResting ? 'Click to Resume' : 'Start Recovery'}</span>
                      </button>
                    </div>
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
              ) : (
                 <div className="flex flex-1 min-h-0 flex-col items-center justify-center text-center text-slate-500">
                   <Users className="w-14 h-14 mb-4 opacity-50" />
                   <p className="text-slate-300 font-medium">
                     {hasRosterPlayers ? 'Select a player from the roster to view telemetry.' : 'No players yet'}
                   </p>
                   <p className="mt-2 text-xs text-slate-500">
                     {hasRosterPlayers ? 'Telemetry controls are disabled until a player is selected.' : 'Add a player or reset baselines to enable telemetry controls.'}
                   </p>
                 </div>
              )}
            </div>

          </div>
        </div>

        {/* RIGHT: COACH AGENT */}
        <div className="lg:col-span-3 flex flex-col gap-4 min-h-0 h-full">
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
                            aria-label="Run Coach Agent"
                            onClick={() => {
                              primeCoachAutoScroll();
                              runAgent('auto', 'button_click');
                            }}
                            onMouseEnter={() => setIsRunCoachHovered(true)}
                            onMouseLeave={() => setIsRunCoachHovered(false)}
                            disabled={agentState === 'thinking'}
                            className="w-full rounded-full px-12 py-4 text-base font-semibold flex items-center justify-center gap-3 text-white shadow-[0_12px_40px_rgba(99,102,241,0.30)] hover:scale-[1.02] hover:shadow-[0_14px_50px_rgba(30,41,59,0.65)] active:scale-[0.99] transition-all duration-300 ease-out cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300/70 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0F172A] disabled:opacity-70 disabled:cursor-not-allowed"
                            style={{ backgroundColor: isRunCoachHovered ? '#4C1D95' : '#7C3AED' }}
                          >
                            <PlayCircle className="w-5 h-5 dashboard-icon-tall-lg shrink-0" /> Run Coach Agent
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
                          {agentState === 'thinking' ? 'Analyzing...' : 'Analysis Output'}
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
                        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="w-full text-left pr-1 space-y-5">
                          <div className="p-4 rounded-xl border border-indigo-400/35 bg-[#162032]">
                            <div className="flex items-center justify-between">
                              <h4 className="text-sm font-bold text-white">Tactical Coach AI</h4>
                              <span className="text-[10px] px-2 py-0.5 rounded border border-indigo-400/40 text-indigo-200 bg-indigo-500/10">
                                {orchestrateMeta?.mode === 'full' ? 'FULL COMBINED' : 'AUTO ROUTING'}
                              </span>
                            </div>
                            <p className="text-[11px] text-slate-400 mt-1">Router intent: {routerDecision?.intent || 'monitor'}</p>
                          </div>

                          <div className="p-4 rounded-xl border border-slate-700 bg-[#162032]">
                            <p className="text-xs font-bold text-slate-200 mb-2">Model Router</p>
                            <div className="flex flex-wrap gap-1.5 mb-2">
                              {(routerDecision?.selectedAgents || orchestrateMeta?.executedAgents || []).map((agent) => (
                                <span key={agent} className="text-[10px] px-2 py-0.5 rounded border border-slate-600 text-slate-200 bg-slate-800">
                                  {agent.toUpperCase()}
                                </span>
                              ))}
                            </div>
                            <p className="text-xs text-slate-300 mb-2">{routerDecision?.reason || 'Router selecting agents from current signals.'}</p>
                            <button
                              onClick={() => setShowRouterSignals((v) => !v)}
                              className="text-[11px] text-slate-400 hover:text-slate-200"
                            >
                              {showRouterSignals ? 'Hide Signals' : 'Show Signals'}
                            </button>
                            {showRouterSignals && (
                              <div className="mt-2 grid grid-cols-2 gap-2 text-[10px] text-slate-400">
                                {Object.entries(routerDecision?.signals || {}).map(([k, v]) => (
                                  <div key={k} className="flex justify-between gap-2 border border-slate-800 rounded px-2 py-1">
                                    <span>{k}</span>
                                    <span className="text-slate-200">{String(v)}</span>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>

                          {[
                            {
                              key: 'fatigue' as const,
                              title: 'Fatigue Agent',
                              subtitle: 'Workload and recovery drift',
                              status: toStatusLabel(agentFeedStatus.fatigue, selectedAgentSet.has('fatigue'), orchestrateMeta?.usedFallbackAgents.includes('fatigue')),
                              summary: aiAnalysis ? `${aiAnalysis.headline}` : 'No output',
                              detail: aiAnalysis ? `Fatigue ${safeNum(aiAnalysis.fatigueIndex, 0).toFixed(1)} · ${aiAnalysis.recommendation}` : 'Skipped by router',
                              severity: aiAnalysis?.severity,
                            },
                            {
                              key: 'risk' as const,
                              title: 'Risk Agent',
                              subtitle: 'Injury and no-ball risk',
                              status: toStatusLabel(agentFeedStatus.risk, selectedAgentSet.has('risk'), orchestrateMeta?.usedFallbackAgents.includes('risk')),
                              summary: riskAnalysis ? `${riskAnalysis.headline}` : 'No output',
                              detail: riskAnalysis ? `Risk ${Math.round(safeNum(riskAnalysis.riskScore, 0))} · ${riskAnalysis.recommendation}` : 'Skipped by router',
                              severity: riskAnalysis?.severity,
                            },
                            {
                              key: 'tactical' as const,
                              title: 'Tactical Agent',
                              subtitle: 'Substitution and next action',
                              status: toStatusLabel(agentFeedStatus.tactical, selectedAgentSet.has('tactical'), tacticalAnalysis?.status === 'fallback' || orchestrateMeta?.usedFallbackAgents.includes('tactical')),
                              summary: tacticalAnalysis ? tacticalAnalysis.immediateAction : 'No output',
                              detail: tacticalAnalysis ? tacticalAnalysis.rationale : 'Skipped by router',
                              severity: tacticalAnalysis ? `${Math.round((tacticalAnalysis.confidence || 0) * 100)}%` : undefined,
                            },
                          ].map((step) => (
                            <div
                              key={step.key}
                              className={`p-4 rounded-xl border border-l-4 ${selectedAgentSet.has(step.key) || orchestrateMeta?.mode === 'full' ? 'border-slate-700 bg-[#162032]' : 'border-slate-800 bg-slate-900/30 opacity-70'}`}
                              style={{ borderLeftColor: agentBorderColor[step.key] }}
                            >
                              <div className="flex items-center justify-between mb-1">
                                <div className="flex items-center gap-2">
                                  <span className={`w-2 h-2 rounded-full ${
                                    step.status === 'OK' ? 'bg-emerald-400' :
                                    step.status === 'RUNNING' ? 'bg-indigo-400 animate-pulse' :
                                    step.status === 'FALLBACK' ? 'bg-amber-400' :
                                    step.status === 'ERROR' ? 'bg-rose-400' : 'bg-slate-600'
                                  }`} />
                                  <p className="text-xs font-bold text-white">{step.title}</p>
                                </div>
                                <div className="flex items-center gap-2">
                                  {step.status === 'FALLBACK' && <span className="text-[10px] px-1.5 py-0.5 rounded border border-amber-500/40 text-amber-300">Fallback logic</span>}
                                  <span className="text-[10px] px-2 py-0.5 rounded border border-slate-600 text-slate-200">{step.status}</span>
                                </div>
                              </div>
                              <p className="text-[11px] text-slate-500 mb-1">{step.subtitle}</p>
                              {step.status === 'SKIPPED' ? (
                                <p className="text-xs text-slate-500">Skipped by router</p>
                              ) : (
                                <>
                                  <p className="text-xs text-slate-200 line-clamp-2">{step.summary}</p>
                                  <p className="text-[11px] text-slate-400 mt-1 line-clamp-2">{step.detail}</p>
                                </>
                              )}
                            </div>
                          ))}

                          {combinedDecision && (
                            <div className="p-5 rounded-xl border border-indigo-400/35 bg-gradient-to-b from-indigo-500/12 to-[#162032] border-l-[3px] border-l-indigo-300/85 shadow-[0_0_26px_rgba(99,102,241,0.22)]">
                              <p className="text-[11px] font-bold uppercase tracking-wide text-slate-300 mb-1">Final Recommendation</p>
                              <h3 className="text-lg font-bold text-white mb-2">{combinedDecision.immediateAction}</h3>
                              <ul className="text-xs text-slate-300 space-y-1 mb-2">
                                <li>• {combinedDecision.rationale}</li>
                                {(combinedDecision.suggestedAdjustments || []).slice(0, 2).map((item, idx) => (
                                  <li key={`${item}-${idx}`}>• {item}</li>
                                ))}
                              </ul>
                              {orchestrateMeta?.mode === 'full' && (
                                <p className="text-[11px] text-indigo-200">
                                  Consensus: Risk {riskAnalysis?.severity || 'N/A'} | Fatigue {aiAnalysis ? safeNum(aiAnalysis.fatigueIndex, 0).toFixed(1) : 'N/A'} | Tactical {tacticalAnalysis ? 'Action-ready' : 'N/A'}
                                </p>
                              )}
                              {orchestrateMeta?.mode === 'auto' && orchestrateMeta.executedAgents.length <= 1 && (
                                <p className="text-[11px] text-slate-400 mt-2">
                                  Auto routing ran: {orchestrateMeta.executedAgents.join(', ')}. Run full analysis for a combined view.
                                </p>
                              )}
                            </div>
                          )}

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
                  <p className="text-sm text-slate-300 font-medium">
                    {hasRosterPlayers ? 'Select a player to analyze' : 'No players available'}
                  </p>
                  <p className="mt-2 text-xs text-slate-500">
                    {hasRosterPlayers ? 'Run Coach Agent will be enabled after player selection.' : 'Add players or reset baselines to run coach analysis.'}
                  </p>
                  <button
                    type="button"
                    disabled
                    className="mt-5 w-full rounded-full px-12 py-4 text-base font-semibold flex items-center justify-center gap-3 text-white bg-slate-700/70 opacity-70 cursor-not-allowed"
                  >
                    <PlayCircle className="w-5 h-5 dashboard-icon-tall-lg shrink-0" /> Run Coach Agent
                  </button>
                </div>
              )}
            </div>

	            {activePlayer && isCoachOutputState && (
	              <div className="flex-none shrink-0 p-6 pt-3 border-t border-white/5 bg-[#0F172A]">
	                <div className="space-y-3">
	                  {isCoachOutputState && (
	                    <>
	                      <button
                        onClick={() => {
                          primeCoachAutoScroll();
                          runAgent('full', 'button_click');
                        }}
                        disabled={agentState === 'thinking'}
                        className={`w-full py-3 rounded-lg border text-sm transition-colors ${agentState === 'thinking' ? 'border-slate-700 text-slate-500 cursor-not-allowed' : 'border-indigo-400/30 text-indigo-200 hover:text-white hover:bg-indigo-500/10'}`}
                      >
                        {agentState === 'thinking' ? 'Running Full Combined Analysis...' : 'Run Full Combined Analysis'}
                      </button>

                      <button
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

  const draftRosterIds = React.useMemo(() => {
    const seen = new Set<string>();
    return draftBaselines
      .filter((row) => row.inRoster === true && row.active === true)
      .map((row) => normalizeBaselineId(row.id || row.name))
      .filter((id) => {
        const key = baselineKey(id);
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, MAX_ROSTER);
  }, [draftBaselines]);

  useEffect(() => {
    const currentKeys = matchRosterIds.map((id) => baselineKey(id));
    const nextKeys = draftRosterIds.map((id) => baselineKey(id));
    if (currentKeys.length === nextKeys.length && currentKeys.every((key, index) => key === nextKeys[index])) {
      return;
    }
    if (import.meta.env.DEV) {
      console.log('[baselines] roster re-derived', { current: matchRosterIds, next: draftRosterIds });
    }
    onMatchRosterIdsChange(draftRosterIds);
  }, [draftRosterIds, matchRosterIds, onMatchRosterIdsChange]);

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
    if (checked && row.active !== true) {
      setErrorMessage('Only globally active players can be added to the current roster.');
      return;
    }

    setDraftBaselines((prev) => {
      const currentRow = prev.find((entry) => entry._localId === row._localId);
      const wasInRoster = Boolean(currentRow?.inRoster);
      const currentCount = prev.filter((entry) => entry.inRoster === true && entry.active === true).length;
      if (checked && !wasInRoster && currentCount >= MAX_ROSTER) {
        setErrorMessage(`Roster is full (${MAX_ROSTER}/${MAX_ROSTER}).`);
        return prev;
      }
      const nextRows = prev.map((entry) =>
        entry._localId === row._localId ? { ...entry, inRoster: checked } : entry
      );
      if (import.meta.env.DEV) {
        console.log('[baselines] roster checkbox toggled', {
          id: resolvedId,
          checked,
        });
      }
      return nextRows;
    });
    setSuccessMessage(null);
  };

  const loadBaselines = async (showSuccess?: string) => {
    setIsLoadingBaselines(true);
    setBaselineFetchFailed(false);
    setErrorMessage(null);
    try {
      const response = await getBaselinesWithMeta();
      const sourceRows = orderBaselinesForDisplay(response.baselines);
      const rosterIdSet = new Set(matchRosterIds.map((id) => baselineKey(id)));
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
      setRuntimeWarning(
        response.warning || (response.source === 'fallback' ? 'Cosmos not configured. Using fallback baseline profiles.' : null)
      );
      onBaselinesSynced(draftRowsToBaselines(normalized), response.source, response.warning);
      setBaselineFetchFailed(false);
      if (showSuccess) setSuccessMessage(showSuccess);
    } catch (error) {
      const storedBaselines = readBaselinesFromStorage();
      const fallbackRows = orderBaselinesForDisplay(storedBaselines !== null ? storedBaselines : getLocalDefaultBaselines());
      const rosterIdSet = new Set(matchRosterIds.map((id) => baselineKey(id)));
      const fallback = fallbackRows.map((row) => baselineToDraftRow(row, rosterIdSet));
      const warning = 'Failed to load baselines from backend. Using local defaults.';
      setSavedBaselines(fallback);
      setDraftBaselines(fallback.map((row) => ({ ...row })));
      if (import.meta.env.DEV) {
        console.log('[baselines] draft reloaded from fallback', {
          count: fallback.length,
        });
      }
      setRuntimeSource('fallback');
      setRuntimeWarning(warning);
      onBaselinesSynced(draftRowsToBaselines(fallback), 'fallback', warning);
      setBaselineFetchFailed(true);
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
        const nextInRoster = updates.active === false ? false : row.inRoster;
        return {
          ...row,
          ...updates,
          name: nextName,
          id: derivedDraftId,
          inRoster: nextInRoster,
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
        .filter((row) => row._isDraft && row.active === true)
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
    const previousSaved = savedBaselines;
    const previousDraft = draftBaselines;
    try {
      await resetBaselines();
      setSavedBaselines([]);
      setDraftBaselines([]);
      onBaselinesSynced([], 'cosmos');
      setRuntimeSource('cosmos');
      setRuntimeWarning(null);
      setSuccessMessage('All baseline players were deleted.');
    } catch (error) {
      setSavedBaselines(previousSaved);
      setDraftBaselines(previousDraft);
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
        <button
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
          <p className="text-slate-400 mt-1">Changes stay local until Save Changes is clicked. Cosmos DB is the baseline source-of-truth.</p>
        </div>
        <div className="flex gap-4">
          <button
            onClick={handleReset}
            className="flex items-center gap-2 bg-rose-700/70 hover:bg-rose-600 text-white px-4 py-2.5 rounded-lg font-bold transition-colors"
          >
            Reset Database
          </button>
          <button
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

      {!isLoadingBaselines && baselineFetchFailed && (runtimeSource === 'fallback' || runtimeWarning) && (
        <div className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-amber-200 text-sm">
          {runtimeWarning || 'Cosmos DB is unavailable; using fallback baseline profiles.'}
        </div>
      )}
      {errorMessage && (
        <div className="mb-4 rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-rose-200 text-sm">
          {errorMessage}
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
	               {(!baselineFetchFailed && draftBaselines.length === 0) ? (
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
                  const isGloballyActive = p.active === true;
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
                       disabled={!isGloballyActive && !isActive}
                       title={!isGloballyActive ? 'Globally inactive players cannot be added to roster.' : 'Toggle roster membership for this match.'}
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
                     <button 
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
                   <button 
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
