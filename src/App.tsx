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
  X,
  UserPlus,
  UserMinus,
  Cpu,
  HelpCircle,
  Info
} from 'lucide-react';
import { motion, AnimatePresence, useMotionValue, useSpring, useTransform, useMotionTemplate } from 'motion/react';
import { FatigueAgentResponse, RiskAgentResponse } from './types/agents';
import { ApiClientError, postFatigueAgent, postRiskAgent } from './lib/apiClient';

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
  name: string;
  role: 'Bowler' | 'Fast Bowler' | 'Spinner' | 'Batsman' | 'All-rounder';
  isSub?: boolean;
  inRoster?: boolean; // Default true if undefined for backward compatibility
  isActive?: boolean;
  // Live Metrics
  overs: number;
  consecutiveOvers: number;
  fatigue: number; // 0-10
  hrRecovery: 'Good' | 'Moderate' | 'Poor';
  injuryRisk: 'Low' | 'Medium' | 'High';
  noBallRisk: 'Low' | 'Medium' | 'High';
  agentFatigueOverride?: number;
  agentRiskOverride?: 'Low' | 'Medium' | 'High';
  runs: number;
  balls: number;
  boundaryEvents: Array<'4' | '6'>;
  isDismissed?: boolean;
  dismissalType?: 'Bowled' | 'Caught' | 'LBW' | 'Run Out' | 'Not Out';
  // Baseline Data
  baselineFatigue: number;
  sleepHours: number;
  recoveryTime: number; // in minutes
  isResting?: boolean;
  restStartMs?: number;
  restStartFatigue?: number;
  restElapsedSec?: number;
  recoveryElapsed?: number;
  isInjured?: boolean;
  isManuallyUnfit?: boolean;
}

interface FatigueAgentPayload {
  playerId: string;
  playerName: string;
  role: string;
  oversBowled: number;
  consecutiveOvers: number;
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
}

interface RiskAgentPayload {
  playerId: string;
  fatigueIndex: number;
  injuryRisk: 'LOW' | 'MED' | 'HIGH' | 'MEDIUM';
  noBallRisk: 'LOW' | 'MED' | 'HIGH' | 'MEDIUM';
  oversBowled: number;
  consecutiveOvers: number;
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
  consecutiveOvers: number;
  fatigue: number;
  injuryRisk: Player['injuryRisk'];
  noBallRisk: Player['noBallRisk'];
  agentFatigueOverride?: number;
  agentRiskOverride?: Player['agentRiskOverride'];
}

// --- Mock Data ---

const INITIAL_PLAYERS: Player[] = [
  { 
    id: 'p1', name: 'J. Archer', role: 'Fast Bowler', 
    isActive: true,
    overs: 2, consecutiveOvers: 2, fatigue: 3, hrRecovery: 'Good', injuryRisk: 'Low', noBallRisk: 'Low',
    runs: 0, balls: 0, boundaryEvents: [], isDismissed: false, dismissalType: 'Not Out',
    baselineFatigue: 6, sleepHours: 7.5, recoveryTime: 45
  },
  { 
    id: 'p2', name: 'R. Khan', role: 'Spinner', 
    isActive: true,
    overs: 8, consecutiveOvers: 1, fatigue: 4, hrRecovery: 'Good', injuryRisk: 'Low', noBallRisk: 'Low',
    runs: 0, balls: 0, boundaryEvents: [], isDismissed: false, dismissalType: 'Not Out',
    baselineFatigue: 8, sleepHours: 6, recoveryTime: 30
  },
  { 
    id: 'p3', name: 'B. Stokes', role: 'All-rounder', 
    isActive: true,
    overs: 3, consecutiveOvers: 3, fatigue: 5, hrRecovery: 'Moderate', injuryRisk: 'Medium', noBallRisk: 'Low',
    runs: 24, balls: 18, boundaryEvents: ['4', '4', '6'], isDismissed: false, dismissalType: 'Not Out',
    baselineFatigue: 5, sleepHours: 8, recoveryTime: 50
  },
  { 
    id: 'p4', name: 'P. Cummins', role: 'Fast Bowler', 
    isActive: true,
    overs: 10, consecutiveOvers: 0, fatigue: 7, hrRecovery: 'Poor', injuryRisk: 'High', noBallRisk: 'Medium',
    runs: 0, balls: 0, boundaryEvents: [], isDismissed: false, dismissalType: 'Not Out',
    baselineFatigue: 7, sleepHours: 5.5, recoveryTime: 60
  },
];

// --- Components ---

const GlowingBackButton = ({ onClick, label = "Back" }: { onClick: () => void, label?: string }) => {
  return (
    <button 
      onClick={onClick}
      className="group flex items-center gap-3 text-slate-400 hover:text-white transition-colors px-2 py-2"
    >
      <div className="relative flex items-center justify-center">
        {/* The Glow - Moves with the arrow */}
        <div className="absolute inset-0 bg-emerald-500/60 blur-[8px] rounded-full opacity-0 group-hover:opacity-100 group-hover:-translate-x-1 transition-all duration-300 pointer-events-none" />
        
        {/* The Arrow */}
        <ArrowLeft className="w-5 h-5 relative z-10 group-hover:-translate-x-1 transition-transform duration-300" />
      </div>
      <span className="font-medium text-sm tracking-wide">{label}</span>
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

const Particle = ({ top, left, size, opacity, depth, blur, mouseX, mouseY }: any) => {
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

const computeTelemetry = (player: Player): Partial<Player> => {
  if (player.isInjured) {
    return {
      fatigue: 10,
      injuryRisk: 'High',
      hrRecovery: 'Poor',
      noBallRisk: 'High'
    };
  }

  if (player.isManuallyUnfit) {
    return {
      injuryRisk: 'High',
      noBallRisk: 'High'
    };
  }

  if (player.agentFatigueOverride !== undefined || player.agentRiskOverride !== undefined) {
    const overrideFatigue = Math.max(0, Math.min(10, player.agentFatigueOverride ?? player.fatigue));
    return {
      fatigue: overrideFatigue,
    };
  }

  if (player.isResting) {
    const fatigue = Math.max(0, Math.min(10, player.fatigue));
    return {
      fatigue,
      injuryRisk: player.injuryRisk,
      noBallRisk: player.noBallRisk,
      hrRecovery: player.hrRecovery,
    };
  }

  let fatigue = 0;

  // 1. Sleep Penalty
  // If Sleep (hrs) < 6 -> increase base fatigue by +1.5
  // If Sleep (hrs) < 5 -> increase base fatigue by +2.5
  if (player.sleepHours < 5) fatigue += 2.5;
  else if (player.sleepHours < 6) fatigue += 1.5;

  // 2. Base Fatigue from Total Overs (0.5 per over)
  fatigue += player.overs * 0.5;

  // 3. Consecutive Over Strain (Extra Load)
  // Calculate marginal cost of consecutive overs (above the base 0.5)
  for (let i = 1; i <= player.consecutiveOvers; i++) {
    let multiplier = 1.0;
    if (i >= 6) multiplier = 1.5;
    else if (i >= 4) multiplier = 1.2;
    
    // Total cost of a consecutive over is 1.0 * multiplier
    // We subtract 0.5 because it's already counted in Total Overs
    const marginalCost = (1.0 * multiplier) - 0.5;
    fatigue += marginalCost;
  }

  // Clamp Fatigue
  fatigue = Math.min(10, Math.max(0, fatigue));

  // 4. Recovery-only adjustment (risk dropdowns remain user-controlled)
  let hrRecovery = player.hrRecovery;
  const limit = player.baselineFatigue;

  // HR Recovery Adjustment
  if (player.sleepHours < 6 && hrRecovery === 'Good') hrRecovery = 'Moderate';
  if (fatigue > limit && hrRecovery === 'Good') hrRecovery = 'Moderate';

  return { fatigue, hrRecovery };
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

const safeNum = (v: any, fallback: number): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
};

const computeRecoveredFatigue = (current: number, dtSeconds: number, baselineTarget: number, limit: number): number => {
  const safeCurrent = Math.max(0, Math.min(10, safeNum(current, 3.0)));
  const target = Math.max(0, Math.min(10, safeNum(baselineTarget, 3.0)));
  const safeLimit = Math.max(0, Math.min(10, safeNum(limit, 6)));

  let decayRate = 0.01 + (safeCurrent / 10) * 0.03;
  decayRate = safeNum(decayRate, 0.02);
  decayRate = Math.min(Math.max(decayRate, 0.01), 0.05);
  if (safeCurrent <= target + 0.5) decayRate *= 0.3;

  const next = Math.max(target, Math.min(10, safeCurrent - (decayRate * Math.max(1, dtSeconds))));
  if (!Number.isFinite(next)) {
    console.warn('NaN fatigue calc', { current: safeCurrent, decayRate, baselineTarget: target, limit: safeLimit });
  }
  return Number.isFinite(next) ? next : safeCurrent;
};

const deriveRiskFromFatigue = (fatigueIndex: number): 'Low' | 'Medium' | 'High' => {
  if (fatigueIndex >= 7) return 'High';
  if (fatigueIndex >= 5) return 'Medium';
  return 'Low';
};

const formatMMSS = (s: number): string => {
  const safe = Math.max(0, Math.floor(s));
  return `${String(Math.floor(safe / 60)).padStart(2, '0')}:${String(safe % 60).padStart(2, '0')}`;
};

// --- Main App Component ---

export default function App() {
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
  const [players, setPlayers] = useState<Player[]>(INITIAL_PLAYERS);
  const [activePlayerId, setActivePlayerId] = useState<string>('p1');
  const [agentState, setAgentState] = useState<'idle' | 'thinking' | 'done' | 'offline' | 'invalid'>('idle');
  const [agentWarning, setAgentWarning] = useState<string | null>(null);
  const [aiAnalysis, setAiAnalysis] = useState<AiAnalysis | null>(null);
  const [riskAnalysis, setRiskAnalysis] = useState<AiAnalysis | null>(null);
  const [agentFeedStatus, setAgentFeedStatus] = useState<AgentFeedStatus>({ fatigue: 'idle', risk: 'idle' });
  const [analysisRequested, setAnalysisRequested] = useState(false);
  const [isProfileOpen, setIsProfileOpen] = useState(false);
  const fatigueRequestSeq = useRef(0);
  const fatigueAbortRef = useRef<AbortController | null>(null);
  const playersRef = useRef<Player[]>([]);

  useEffect(() => {
    playersRef.current = players;
  }, [players]);

  const activePlayer = players.find(p => p.id === activePlayerId) || players[0];
  const currentTelemetry = React.useMemo(() => {
    const player = players.find((p) => p.id === activePlayerId);
    if (!player) return null;
    return {
      playerId: player.id.toUpperCase(),
      playerName: player.name,
      role: player.role,
      oversBowled: Math.max(0, safeNum(player.overs, 0)),
      consecutiveOvers: Math.max(0, safeNum(player.consecutiveOvers, 0)),
      fatigueIndex: Math.max(0, Math.min(10, safeNum(player.fatigue, 3.0))),
      injuryRisk: String(player.injuryRisk || 'Medium').toUpperCase() as 'LOW' | 'MEDIUM' | 'HIGH',
      noBallRisk: String(player.noBallRisk || 'Medium').toUpperCase() as 'LOW' | 'MEDIUM' | 'HIGH',
      heartRateRecovery: String(player.hrRecovery || 'Moderate'),
      fatigueLimit: Math.max(0, safeNum(player.baselineFatigue, 6)),
      sleepHours: Math.max(0, safeNum(player.sleepHours, 7)),
      recoveryMinutes: Math.max(0, safeNum(player.recoveryTime, 45)),
      matchContext: {
        format: matchContext.format || 'T20',
        phase: matchContext.phase || 'Middle',
        over: safeNum(Number(formatOverStr(matchState.ballsBowled)), 0),
        intensity: matchContext.pitch || 'Medium',
      },
    };
  }, [players, activePlayerId, matchContext, matchState.ballsBowled]);

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
  }, [matchContext.format]);

  useEffect(() => {
    setPlayers((prev) =>
      prev.map((p) => {
        if (!p.isResting) return p;
        return {
          ...p,
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
    if (!hasRestingPlayers) return;

    const tickSeconds = 1;
    const interval = setInterval(() => {
      setPlayers((prev) =>
        prev.map((p) => {
          if (!p.isResting) return p;

          const startMs = p.restStartMs ?? Date.now();
          const nextElapsedSeconds = Math.max(0, Math.floor((Date.now() - startMs) / 1000));
          const recoveryMinutes = safeNum(p.recoveryTime, 45);
          const recoveryTargetSec = Math.max(1, Math.floor(recoveryMinutes * 60));
          const restProgress = Math.max(0, Math.min(1, nextElapsedSeconds / recoveryTargetSec));
          const baselineTargetFatigue = Math.max(0, Math.min(10, safeNum(p.baselineFatigue, 3.0)));
          const startFatigue = Math.max(0, Math.min(10, safeNum(p.restStartFatigue ?? (p.agentFatigueOverride ?? p.fatigue), 3.0)));
          const rawNextFatigue = startFatigue - ((startFatigue - baselineTargetFatigue) * restProgress);
          const nextFatigue = Number.isFinite(rawNextFatigue)
            ? Math.max(0, Math.min(10, rawNextFatigue))
            : startFatigue;

          console.log('isResting:', p.isResting, 'elapsed:', nextElapsedSeconds);

          return {
            ...p,
            restElapsedSec: nextElapsedSeconds,
            recoveryElapsed: nextElapsedSeconds / 60,
            ...(p.agentFatigueOverride !== undefined
              ? {
                  agentFatigueOverride: nextFatigue,
                }
              : {
                  fatigue: nextFatigue,
                }),
            hrRecovery: p.hrRecovery,
          };
        })
      );
    }, tickSeconds * 1000);

    return () => clearInterval(interval);
  }, [hasRestingPlayers]);

  const updatePlayer = (id: string, updates: Partial<Player>) => {
    setPlayers(prev => prev.map(p => {
      if (p.id !== id) return p;
      
      // 1. Merge updates into a temporary object
      let updated = { ...p, ...updates };

      if (!('agentFatigueOverride' in updates) && !('agentRiskOverride' in updates)) {
        updated.agentFatigueOverride = undefined;
        updated.agentRiskOverride = undefined;
      }

      // 2. Guardrails
      // Consecutive overs cannot exceed total overs
      if (updated.consecutiveOvers > updated.overs) {
         updated.consecutiveOvers = updated.overs;
      }
      
      // 3. Recompute Telemetry (Fatigue, Risk, HR) derived from inputs
      const telemetry = computeTelemetry(updated);
      
      // 4. Final Merge
      return { ...updated, ...telemetry };
    }));
  };

  const addPlayer = (name: string, role: Player['role'], isSub: boolean = false, inRoster: boolean = true) => {
    const newPlayer: Player = {
      id: `p${Date.now()}`,
      name,
      role,
      isSub,
      inRoster,
      isActive: inRoster,
      overs: 0,
      consecutiveOvers: 0,
      fatigue: 0,
      hrRecovery: 'Good',
      injuryRisk: 'Low',
      noBallRisk: 'Low',
      runs: 0,
      balls: 0,
      boundaryEvents: [],
      isDismissed: false,
      dismissalType: 'Not Out',
      baselineFatigue: 7, 
      sleepHours: 7,
      recoveryTime: 45
    };
    setPlayers([...players, newPlayer]);
    setActivePlayerId(newPlayer.id);
  };

  const movePlayerToSub = (playerId: string) => {
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

  const deletePlayer = (id: string) => {
    const newPlayers = players.filter(p => p.id !== id);
    setPlayers(newPlayers);
    if (activePlayerId === id && newPlayers.length > 0) {
      setActivePlayerId(newPlayers[0].id);
    }
  };

  const handleAddOver = () => {
    if (activePlayer.injuryRisk === 'High' || activePlayer.isSub) return;
    // Logic: +1 Total Over (Fatigue recomputed automatically)
    updatePlayer(activePlayer.id, { 
      overs: activePlayer.overs + 1, 
    });
  };

  const handleDecreaseOver = () => {
    if (activePlayer.overs > 0) {
      updatePlayer(activePlayer.id, { 
        overs: activePlayer.overs - 1,
      });
    }
  };

  const handleConsecutiveChange = (delta: number) => {
    if (delta > 0) {
      if (activePlayer.injuryRisk === 'High' || activePlayer.isSub) return;
      // Increasing consecutive also implies increasing total
      updatePlayer(activePlayer.id, { 
        consecutiveOvers: activePlayer.consecutiveOvers + 1,
        overs: activePlayer.overs + 1,
      });
    } else {
      // Decreasing consecutive (correction or just reduction)
      const newVal = Math.max(0, activePlayer.consecutiveOvers + delta);
      updatePlayer(activePlayer.id, { consecutiveOvers: newVal });
    }
  };

  const handleNewSpell = () => {
    // Reset consecutive overs (Fatigue drops automatically)
    updatePlayer(activePlayer.id, {
      consecutiveOvers: 0,
      isManuallyUnfit: false,
      isInjured: false,
    });
  };

  const handleRest = () => {
    // Toggle Rest Mode without clearing fatigue/risk immediately
    setPlayers((prev) =>
      prev.map((p) => {
        if (p.id !== activePlayer.id) return p;
        const nextResting = !p.isResting;
        const elapsed = p.restElapsedSec || 0;
        if (nextResting) {
          console.log('Rest started');
        } else {
          console.log('Rest resumed');
        }
        return {
          ...p,
          isResting: nextResting,
          restStartMs: nextResting ? Date.now() : p.restStartMs,
          restStartFatigue: nextResting
            ? safeNum(p.agentFatigueOverride ?? p.fatigue, 3.0)
            : p.restStartFatigue,
          restElapsedSec: nextResting ? 0 : elapsed,
          recoveryElapsed: (nextResting ? 0 : elapsed) / 60,
          consecutiveOvers: nextResting ? 0 : p.consecutiveOvers,
          isManuallyUnfit: nextResting ? false : p.isManuallyUnfit,
          isInjured: nextResting ? false : p.isInjured,
        };
      })
    );
  };

  const handleMarkUnfit = () => {
    updatePlayer(activePlayer.id, {
      isManuallyUnfit: true,
      injuryRisk: 'High',
      noBallRisk: 'High'
    });
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

  const captureTelemetrySnapshot = (player: Player): TelemetrySnapshot => ({
    playerId: player.id,
    overs: safeNum(player.overs, 0),
    consecutiveOvers: safeNum(player.consecutiveOvers, 0),
    fatigue: safeNum(player.fatigue, 0),
    injuryRisk: player.injuryRisk,
    noBallRisk: player.noBallRisk,
    agentFatigueOverride: player.agentFatigueOverride,
    agentRiskOverride: player.agentRiskOverride,
  });

  const isTelemetryEqual = (a: TelemetrySnapshot, b: TelemetrySnapshot): boolean =>
    a.playerId === b.playerId &&
    a.overs === b.overs &&
    a.consecutiveOvers === b.consecutiveOvers &&
    a.fatigue === b.fatigue &&
    a.injuryRisk === b.injuryRisk &&
    a.noBallRisk === b.noBallRisk &&
    a.agentFatigueOverride === b.agentFatigueOverride &&
    a.agentRiskOverride === b.agentRiskOverride;

  const runAgent = async (reason: 'button_click' | 'non_button' = 'non_button') => {
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
    if (!currentTelemetry) return;
    setAnalysisRequested(true);

    fatigueAbortRef.current?.abort();
    const controller = new AbortController();
    fatigueAbortRef.current = controller;
    const requestId = ++fatigueRequestSeq.current;

    setAiAnalysis(null);
    setRiskAnalysis(null);
    setAgentFeedStatus({ fatigue: 'loading', risk: 'idle' });
    setAgentWarning(null);
    setAgentState('thinking');

    const activePlayerState = playersRef.current.find((p) => p.id === activePlayerId);
    if (!activePlayerState) return;
    const telemetrySnapshot = captureTelemetrySnapshot(activePlayerState);
    const snapshotId = `${currentTelemetry.playerId}:${currentTelemetry.fatigueIndex}:${currentTelemetry.oversBowled}:${currentTelemetry.consecutiveOvers}:${Date.now()}`;
    const payload: FatigueAgentPayload = {
      playerId: currentTelemetry.playerId,
      playerName: currentTelemetry.playerName,
      role: currentTelemetry.role,
      oversBowled: currentTelemetry.oversBowled,
      consecutiveOvers: currentTelemetry.consecutiveOvers,
      fatigueIndex: currentTelemetry.fatigueIndex,
      injuryRisk: currentTelemetry.injuryRisk,
      noBallRisk: currentTelemetry.noBallRisk,
      heartRateRecovery: currentTelemetry.heartRateRecovery,
      fatigueLimit: currentTelemetry.fatigueLimit,
      sleepHours: currentTelemetry.sleepHours,
      recoveryMinutes: currentTelemetry.recoveryMinutes,
      snapshotId,
      matchContext: currentTelemetry.matchContext,
    };
    const riskPayload: RiskAgentPayload = {
      playerId: currentTelemetry.playerId,
      fatigueIndex: currentTelemetry.fatigueIndex,
      injuryRisk: currentTelemetry.injuryRisk,
      noBallRisk: currentTelemetry.noBallRisk,
      oversBowled: currentTelemetry.oversBowled,
      consecutiveOvers: currentTelemetry.consecutiveOvers,
      heartRateRecovery: currentTelemetry.heartRateRecovery,
      format: currentTelemetry.matchContext.format,
      phase: currentTelemetry.matchContext.phase,
      intensity: currentTelemetry.matchContext.intensity,
      conditions: matchContext.weather,
      target: matchState.target,
      score: matchState.runs,
      over: safeNum(Number(formatOverStr(matchState.ballsBowled)), 0),
      balls: Math.max(0, totalBallsFromOvers(matchState.totalOvers) - matchState.ballsBowled),
    };
    if (import.meta.env.DEV) {
      console.log('[agent] calling', '/api/agents/fatigue');
      console.log('Fatigue analyze payload', payload);
    }

    try {
      const result = await postFatigueAgent(payload, controller.signal);
      if (requestId !== fatigueRequestSeq.current) return;
      if (import.meta.env.DEV) {
        console.log('Fatigue analyze response', result);
      }
      const mapped = buildAiAnalysis(result, 'fatigue');
      if (!mapped) {
        setAgentFeedStatus({ fatigue: 'error', risk: 'idle' });
        setAgentState('invalid');
        setAgentWarning('Invalid AI response');
        return;
      }

      setAiAnalysis(mapped);
      setAgentFeedStatus({ fatigue: 'done', risk: 'loading' });
      if (import.meta.env.DEV) {
        console.log('[agent] calling', '/api/agents/risk');
      }
      const riskResult = await postRiskAgent(riskPayload, controller.signal);
      if (requestId !== fatigueRequestSeq.current) return;
      if (import.meta.env.DEV) {
        console.log('Risk analyze response', riskResult);
      }
      const mappedRisk = buildAiAnalysis(riskResult, 'risk');
      if (!mappedRisk) {
        setAgentFeedStatus({ fatigue: 'done', risk: 'error' });
        setAgentState('invalid');
        setAgentWarning('Invalid risk response');
        return;
      }
      setRiskAnalysis(mappedRisk);
      setAgentFeedStatus({ fatigue: 'done', risk: 'done' });
      setAgentState('done');

      const currentPlayer = playersRef.current.find((p) => p.id === telemetrySnapshot.playerId);
      if (currentPlayer) {
        const nowSnapshot = captureTelemetrySnapshot(currentPlayer);
        if (!isTelemetryEqual(telemetrySnapshot, nowSnapshot) && import.meta.env.DEV) {
          console.error('Telemetry mutated during coach analysis; reverting', {
            before: telemetrySnapshot,
            after: nowSnapshot,
          });
          setPlayers((prev) =>
            prev.map((p) =>
              p.id === telemetrySnapshot.playerId
                ? {
                    ...p,
                    overs: telemetrySnapshot.overs,
                    consecutiveOvers: telemetrySnapshot.consecutiveOvers,
                    fatigue: telemetrySnapshot.fatigue,
                    injuryRisk: telemetrySnapshot.injuryRisk,
                    noBallRisk: telemetrySnapshot.noBallRisk,
                    agentFatigueOverride: telemetrySnapshot.agentFatigueOverride,
                    agentRiskOverride: telemetrySnapshot.agentRiskOverride,
                  }
                : p
            )
          );
        }
      }
    } catch (error) {
      if ((error as Error)?.name === 'AbortError') return;
      if (requestId !== fatigueRequestSeq.current) return;
      setAgentFeedStatus((prev) => ({
        fatigue: prev.fatigue === 'loading' ? 'error' : prev.fatigue,
        risk: prev.risk === 'loading' ? 'error' : prev.risk,
      }));
      if (error instanceof ApiClientError) {
        setAgentWarning(error.message);
      } else {
        setAgentWarning('AI Offline. Start backend: cd api && func start');
      }
      setAgentState('offline');
    }
  };

  useEffect(() => {
    if (page !== 'dashboard') return;
    fatigueAbortRef.current?.abort();
    if (!analysisRequested) {
      setAiAnalysis(null);
      setRiskAnalysis(null);
      setAgentFeedStatus({ fatigue: 'idle', risk: 'idle' });
      setAgentWarning(null);
      setAgentState('idle');
    }
    setAnalysisRequested(false);
    return () => {
      fatigueAbortRef.current?.abort();
    };
  }, [activePlayerId, page]);

  const dismissAnalysis = () => {
    fatigueAbortRef.current?.abort();
    setAnalysisRequested(false);
    setAgentState('idle');
    setAgentWarning(null);
    setAiAnalysis(null);
    setRiskAnalysis(null);
    setAgentFeedStatus({ fatigue: 'idle', risk: 'idle' });
  };

  const navigateTo = (p: Page) => {
    window.scrollTo(0, 0);
    setPage(p);
  };

  return (
    <div className="min-h-screen bg-[#020408] text-slate-100 font-sans selection:bg-emerald-500/30 overflow-x-hidden relative">
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
      <nav className="border-b border-white/10 bg-[#060B16]/90 backdrop-blur-md sticky top-0 z-50">
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
                       onClick={() => updatePlayer(activePlayer.id, { inRoster: false, isSub: true, isActive: false })}
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

      <main className="relative z-10 min-h-[calc(100vh-5rem)] w-full flex flex-col">
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
              addPlayer={addPlayer}
              deletePlayer={deletePlayer}
              movePlayerToSub={movePlayerToSub}
              agentState={agentState}
              agentWarning={agentWarning}
              aiAnalysis={aiAnalysis}
              riskAnalysis={riskAnalysis}
              agentFeedStatus={agentFeedStatus}
              runAgent={runAgent}
              onDismissAnalysis={dismissAnalysis}
              handleAddOver={handleAddOver}
              handleDecreaseOver={handleDecreaseOver}
              handleConsecutiveChange={handleConsecutiveChange}
              handleNewSpell={handleNewSpell}
              handleRest={handleRest}
              handleMarkUnfit={handleMarkUnfit}
              onBack={() => navigateTo('setup')}
            />
          )}
          {page === 'baselines' && (
            <Baselines 
              key="baselines"
              players={players}
              addPlayer={addPlayer}
              updatePlayer={updatePlayer}
              deletePlayer={deletePlayer}
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

function Dashboard({ 
  matchContext, matchState, players, activePlayer, setActivePlayerId, updatePlayer, updateMatchState, addPlayer, deletePlayer, movePlayerToSub,
  agentState, aiAnalysis, riskAnalysis, agentFeedStatus, agentWarning, runAgent, onDismissAnalysis, handleAddOver, handleDecreaseOver, handleConsecutiveChange, handleNewSpell, handleRest, handleMarkUnfit, onBack 
}: any) {
  const [isAdding, setIsAdding] = useState(false);
  const [newPlayerName, setNewPlayerName] = useState('');
  const [newPlayerRole, setNewPlayerRole] = useState<Player['role']>('Fast Bowler');
  const [substitutionRecommendation, setSubstitutionRecommendation] = useState<string | null>(null);

  useEffect(() => {
    setSubstitutionRecommendation(null);
  }, [activePlayer?.id]);

  const handleSavePlayer = () => {
    if (newPlayerName.trim()) {
      const isSub = players.length >= 11;
      addPlayer(newPlayerName, newPlayerRole, isSub, true);
      setNewPlayerName('');
      setIsAdding(false);
    }
  };

  const handleRemoveActive = () => {
    setSubstitutionRecommendation(`⚠️ URGENT: ${activePlayer.name} marked unfit. Immediate substitution recommended.`);
    movePlayerToSub(activePlayer.id);
  };

  const handleDismissAnalysis = () => {
    console.log('dismiss analysis');
    setSubstitutionRecommendation(null);
    onDismissAnalysis?.();
  };

  const rosterPlayers = players.filter((p: Player) => p.inRoster !== false);
  const totalCount = rosterPlayers.length;
  const isMaxed = totalCount >= 13;
  const isBatsmanActive = activePlayer?.role === 'Batsman';

  const totalBalls = totalBallsFromOvers(matchState.totalOvers);
  const ballsBowled = Math.min(totalBalls, Math.max(0, matchState.ballsBowled));
  const ballsRemaining = Math.max(totalBalls - ballsBowled, 0);
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
  const finalDecision = aiAnalysis && riskAnalysis
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
            ? 'Immediate substitution advised. Remove from active spell now.'
            : aiAnalysis.severity === 'HIGH' || riskAnalysis.severity === 'HIGH'
            ? 'Rotate bowler for next over.'
            : aiAnalysis.severity === 'MED' || riskAnalysis.severity === 'MED'
              ? 'No immediate change; manage spell length and monitor trend.'
              : 'No change, continue and monitor trend.',
        reasons: [
          aiAnalysis.headline,
          riskAnalysis.headline,
        ],
      }
    : null;
  const fatigueCardTheme = {
    wrapper: 'p-4 rounded-xl border border-emerald-500/25 border-l-[3px] border-l-emerald-400/80 bg-gradient-to-b from-emerald-500/8 to-[#162032] shadow-[0_0_18px_rgba(16,185,129,0.08)] hover:shadow-[0_0_24px_rgba(16,185,129,0.14)] transition-shadow',
    badge: 'text-emerald-200 border-emerald-500/45 bg-emerald-900/35',
    chip: 'text-emerald-100 border-emerald-500/35 bg-emerald-500/10 shadow-[0_0_12px_rgba(16,185,129,0.14)]',
  };
  const riskCardTheme = {
    wrapper: 'p-4 rounded-xl border border-amber-500/25 border-l-[3px] border-l-amber-400/85 bg-gradient-to-b from-amber-500/8 to-[#162032] shadow-[0_0_18px_rgba(245,158,11,0.09)] hover:shadow-[0_0_26px_rgba(245,158,11,0.16)] transition-shadow',
    badge: 'text-amber-200 border-amber-500/45 bg-amber-900/35',
    chip: 'text-amber-100 border-amber-500/35 bg-amber-500/10 shadow-[0_0_12px_rgba(245,158,11,0.15)]',
  };

  const handleAddBoundary = (boundary: '4' | '6') => {
    if (!activePlayer) return;
    updatePlayer(activePlayer.id, { boundaryEvents: [...boundaryEvents, boundary] });
  };


  return (
    <motion.div 
      initial={{ opacity: 0 }} 
      animate={{ opacity: 1 }}
      className="flex-1 p-4 md:p-6 w-full flex flex-col"
    >
      {/* Context Bar */}
      <div className="bg-[#0F172A] border border-white/5 rounded-xl p-3 flex flex-wrap items-center gap-6 mb-6">
        <GlowingBackButton onClick={onBack} label="Match Setup" />
        <div className="h-6 w-px bg-white/10 hidden md:block" />
        <div className="flex items-center gap-6 text-xs font-bold tracking-wider text-slate-400">
           <span className="flex items-center gap-2"><Trophy className="w-3 h-3" /> {matchContext.format}</span>
           <span className="flex items-center gap-2 text-amber-400"><Zap className="w-3 h-3" /> {matchContext.phase}</span>
           <span className="flex items-center gap-2"><Activity className="w-3 h-3" /> {matchContext.pitch.toUpperCase()} INTENSITY</span>
           <span className="flex items-center gap-2 text-blue-400"><Thermometer className="w-3 h-3" /> {matchContext.weather.toUpperCase()}</span>
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

      <div className="flex-1 grid lg:grid-cols-12 gap-6 min-h-0">
        
        {/* LEFT: ROSTER (EDITABLE) */}
        <div className="lg:col-span-3 flex flex-col gap-4">
          <div className="bg-[#0F172A] border border-white/5 rounded-2xl flex-1 flex flex-col overflow-hidden">
            <div className="p-4 border-b border-white/5 bg-slate-900/50 flex items-center justify-between">
               <h3 className="text-sm font-bold text-slate-400 flex items-center gap-2">
                 <Users className="w-4 h-4" /> Roster ({totalCount}/13)
               </h3>
               {totalCount > 11 && (
                 <span className="text-[10px] bg-amber-500/10 text-amber-400 px-2 py-0.5 rounded border border-amber-500/20">Subs Active</span>
               )}
            </div>
            
            <div className="p-3 space-y-2 overflow-y-auto flex-1">
              {rosterPlayers.map((p: Player, index: number) => {
                const isSub = index >= 11;
                return (
                  <div key={p.id} className="relative group">
                    <button
                      onClick={() => setActivePlayerId(p.id)}
                      className={`w-full flex items-center gap-3 p-3 rounded-xl transition-all border text-left ${
                        activePlayer.id === p.id 
                          ? 'bg-emerald-500/10 border-emerald-500/50' 
                          : 'bg-transparent border-transparent hover:bg-white/5'
                      }`}
                    >
                      <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold shadow-lg shrink-0 ${
                        activePlayer.id === p.id ? 'bg-emerald-500 text-black' : 'bg-slate-800 text-slate-400 group-hover:bg-slate-700'
                      }`}>
                        {p.name.charAt(0)}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className={`font-semibold text-sm truncate ${activePlayer.id === p.id ? 'text-white' : 'text-slate-300'}`}>
                          {p.name} {isSub && <span className="text-[10px] text-amber-500 ml-1">(Sub)</span>}
                        </div>
                        <div className="text-[10px] uppercase font-bold text-slate-500 truncate">{p.role}</div>
                      </div>
                      {/* Only show Chevron if not hovering (to avoid clash with delete) or just keep it simple */}
                      {activePlayer.id === p.id && <ChevronRight className="w-4 h-4 text-emerald-500 ml-auto shrink-0 group-hover:hidden" />}
                    </button>
                    
                    {/* Delete Button (Hover) */}
                    <button 
                      onClick={(e) => { e.stopPropagation(); deletePlayer(p.id); }}
                      className="absolute right-2 top-1/2 -translate-y-1/2 p-2 rounded-lg bg-rose-500/20 text-rose-400 opacity-0 group-hover:opacity-100 transition-opacity hover:bg-rose-500 hover:text-white"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                );
              })}

              {/* Add Player Form/Button */}
              {!isMaxed && (
                <div className="mt-2 pt-2 border-t border-white/5">
                  {!isAdding ? (
                    <button 
                      onClick={() => setIsAdding(true)}
                      className="w-full py-3 rounded-xl border border-dashed border-slate-700 text-slate-500 hover:text-white hover:border-emerald-500/50 hover:bg-emerald-500/5 transition-all flex items-center justify-center gap-2 text-sm font-medium"
                    >
                      <UserPlus className="w-4 h-4" /> Add Player
                    </button>
                  ) : (
                    <div className="bg-slate-800/50 rounded-xl p-3 border border-slate-700 animate-in fade-in slide-in-from-top-2">
                      <div className="space-y-3">
                        <input 
                          autoFocus
                          placeholder="Player Name"
                          value={newPlayerName}
                          onChange={(e) => setNewPlayerName(e.target.value)}
                          className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-emerald-500"
                        />
                        <select 
                          value={newPlayerRole}
                          onChange={(e) => setNewPlayerRole(e.target.value)}
                          className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-emerald-500"
                        >
                          <option value="Bowler">Bowler</option>
                          <option value="Fast Bowler">Fast Bowler</option>
                          <option value="Spinner">Spinner</option>
                          <option value="Batsman">Batsman</option>
                          <option value="All-rounder">All-rounder</option>
                        </select>
                        <div className="flex gap-2">
                          <button 
                            onClick={handleSavePlayer}
                            disabled={!newPlayerName.trim()}
                            className="flex-1 bg-emerald-600 hover:bg-emerald-500 text-white py-1.5 rounded-lg text-xs font-bold transition-colors disabled:opacity-50"
                          >
                            Save
                          </button>
                          <button 
                            onClick={() => setIsAdding(false)}
                            className="px-3 bg-slate-700 hover:bg-slate-600 text-white rounded-lg transition-colors"
                          >
                            <X className="w-4 h-4" />
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* CENTER: METRICS */}
        <div className="lg:col-span-6 flex flex-col gap-4">
          <div className={`bg-[#0F172A] border rounded-2xl flex-1 p-6 relative overflow-hidden flex flex-col transition-all duration-500 ${
            (activePlayer.fatigue > activePlayer.baselineFatigue || activePlayer.injuryRisk === 'High')
              ? 'border-rose-500/50 shadow-[0_0_30px_rgba(225,29,72,0.15)]' 
              : 'border-white/5'
          }`}>
            {/* Background Decor */}
             <div className="absolute top-0 right-0 w-64 h-64 bg-emerald-500/5 blur-[80px] rounded-full pointer-events-none" />

            <div className="flex justify-between items-start mb-8 relative z-10">
              <div>
                 <div className="flex items-center gap-2 mb-1">
                   <Activity className={`w-4 h-4 ${activePlayer && activePlayer.injuryRisk === 'High' ? 'text-rose-500 animate-pulse' : 'text-emerald-400'}`} />
                   <span className={`text-xs font-bold uppercase tracking-widest ${activePlayer && activePlayer.injuryRisk === 'High' ? 'text-rose-500' : 'text-emerald-400'}`}>
                     {activePlayer?.role === 'Batsman' ? 'Batsman Live Telemetry' : 'Bowler Live Telemetry'}
                   </span>
                 </div>
                 <h2 className="text-3xl font-bold text-white">{activePlayer ? activePlayer.name : 'Select Player'}</h2>
              </div>
              {activePlayer && (
                <div className="px-3 py-1 bg-slate-800 rounded border border-slate-700 text-xs font-mono text-slate-400">
                  ID: {activePlayer.id.toUpperCase()}
                </div>
              )}
            </div>

            {/* Main Stats Panels */}
            {activePlayer ? (
            <AnimatePresence mode="wait" initial={false}>
              {activePlayer.role === 'Batsman' ? (
                <motion.div
                  key="batsman-telemetry"
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -8 }}
                  transition={{ duration: 0.2 }}
                  className="relative z-10 min-h-[560px] flex flex-col"
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
                            <Plus className="w-3.5 h-3.5" />
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
                            <Plus className="w-3.5 h-3.5" />
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
                  className="relative z-10 min-h-[560px] flex flex-col"
                >
                  {(activePlayer.fatigue > activePlayer.baselineFatigue || activePlayer.injuryRisk === 'High') && (
                    <div className="mb-6 bg-rose-950/40 border border-rose-500/30 rounded-xl p-4 flex flex-col sm:flex-row items-center justify-between gap-4 animate-in fade-in slide-in-from-top-4 backdrop-blur-md shadow-2xl shadow-rose-900/10">
                      <div className="flex items-center gap-4 w-full sm:w-auto">
                        <div className="w-10 h-10 rounded-full bg-rose-500/20 flex items-center justify-center border border-rose-500/30 shrink-0 animate-pulse">
                          <AlertTriangle className="w-5 h-5 text-rose-400" />
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
                        <LogOut className="w-3.5 h-3.5" /> Remove from Active Squad
                      </button>
                    </div>
                  )}

                  <div className="grid grid-cols-2 gap-4 mb-8">
                    <div className={`bg-[#162032] rounded-xl p-5 border text-center relative group transition-all ${activePlayer.injuryRisk === 'High' ? 'border-rose-500/50 shadow-[0_0_15px_rgba(244,63,94,0.1)]' : 'border-white/5'}`}>
                      <div className={`text-xs font-bold uppercase mb-2 ${activePlayer.injuryRisk === 'High' ? 'text-rose-400' : 'text-slate-500'}`}>Overs Bowled</div>
                      <div className={`text-5xl font-mono font-medium mb-2 ${activePlayer.injuryRisk === 'High' ? 'text-rose-500' : 'text-white'}`}>{activePlayer.overs}</div>
                      <div className="flex justify-center gap-4 mt-2 opacity-100 transition-opacity">
                        <button
                          onClick={handleDecreaseOver}
                          disabled={activePlayer.isSub}
                          className={`w-8 h-8 rounded-full flex items-center justify-center border transition-all ${activePlayer.isSub ? 'bg-slate-800/50 text-slate-600 border-slate-800 cursor-not-allowed' : 'bg-slate-800 hover:bg-slate-700 text-white border-slate-600'}`}
                        >
                          <Minus className="w-4 h-4" />
                        </button>
                        <button
                          onClick={handleAddOver}
                          disabled={activePlayer.injuryRisk === 'High' || activePlayer.isSub}
                          className={`w-8 h-8 rounded-full flex items-center justify-center shadow-lg transition-all ${activePlayer.injuryRisk === 'High' || activePlayer.isSub ? 'bg-slate-800/50 text-slate-600 cursor-not-allowed shadow-none' : 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-emerald-500/20'}`}
                        >
                          <Plus className="w-4 h-4" />
                        </button>
                      </div>
                    </div>

                    <div className={`bg-[#162032] rounded-xl p-5 border text-center relative group transition-all ${activePlayer.injuryRisk === 'High' ? 'border-rose-500/50 shadow-[0_0_15px_rgba(244,63,94,0.1)]' : 'border-white/5'}`}>
                      <div className={`text-xs font-bold uppercase mb-2 ${activePlayer.injuryRisk === 'High' ? 'text-rose-400' : 'text-slate-500'}`}>Consecutive Overs</div>
                      <div className={`text-5xl font-mono font-medium mb-2 ${activePlayer.injuryRisk === 'High' ? 'text-rose-500' : activePlayer.consecutiveOvers > 3 ? 'text-amber-400' : 'text-white'}`}>{activePlayer.consecutiveOvers}</div>
                      <div className="flex justify-center gap-4 mt-2 opacity-100 transition-opacity">
                        <button
                          onClick={() => handleConsecutiveChange(-1)}
                          disabled={activePlayer.isSub}
                          className={`w-8 h-8 rounded-full flex items-center justify-center border transition-all ${activePlayer.isSub ? 'bg-slate-800/50 text-slate-600 border-slate-800 cursor-not-allowed' : 'bg-slate-800 hover:bg-slate-700 text-white border-slate-600'}`}
                        >
                          <Minus className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => handleConsecutiveChange(1)}
                          disabled={activePlayer.injuryRisk === 'High' || activePlayer.isSub}
                          className={`w-8 h-8 rounded-full flex items-center justify-center border transition-all ${activePlayer.injuryRisk === 'High' || activePlayer.isSub ? 'bg-slate-800/50 text-slate-600 border-slate-800 cursor-not-allowed' : 'bg-slate-700 hover:bg-slate-600 text-white border-slate-600'}`}
                        >
                          <Plus className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  </div>

                  <div className="h-px bg-gradient-to-r from-transparent via-slate-700 to-transparent my-2" />

                  <div className="grid grid-cols-2 gap-x-8 gap-y-6 mt-6">
                    <div>
                      <div className="flex justify-between mb-2">
                        <label className={`text-xs font-bold flex items-center gap-2 ${activePlayer.injuryRisk === 'High' ? 'text-rose-500' : 'text-slate-400'}`}>
                          <Activity className={`w-3 h-3 ${activePlayer.injuryRisk === 'High' ? 'animate-pulse' : ''}`} /> Fatigue Index (0-10)
                        </label>
                        <span className={`font-mono ${activePlayer.injuryRisk === 'High' ? 'text-rose-500' : 'text-white'}`}>{activePlayer.fatigue.toFixed(1)}</span>
                      </div>
                      <div className="h-3 bg-slate-800 rounded-full overflow-hidden">
                        <motion.div
                          initial={false}
                          animate={{ width: `${(activePlayer.fatigue / 10) * 100}%` }}
                          className={`h-full rounded-full ${activePlayer.fatigue > 7 ? 'bg-rose-500' : activePlayer.fatigue > 4 ? 'bg-amber-400' : 'bg-emerald-500'}`}
                        />
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
                      <label className={`text-xs font-bold mb-2 block flex items-center gap-2 ${activePlayer.injuryRisk === 'High' ? 'text-rose-500' : 'text-slate-400'}`}>
                        <AlertTriangle className={`w-3 h-3 ${activePlayer.injuryRisk === 'High' ? 'animate-pulse' : ''}`} /> Heart Rate Recovery
                      </label>
                      <select
                        value={activePlayer.hrRecovery}
                        onChange={(e) => updatePlayer(activePlayer.id, { hrRecovery: e.target.value })}
                        className={`w-full bg-[#162032] text-sm rounded-lg px-3 py-2 border focus:outline-none ${activePlayer.injuryRisk === 'High' ? 'text-rose-500 border-rose-500/50 bg-rose-500/5' : 'text-white border-slate-700'}`}
                      >
                        <option value="Good">Good</option>
                        <option value="Moderate">Moderate</option>
                        <option value="Poor">Poor</option>
                      </select>
                    </div>

                    <div className={`bg-[#162032] p-3 rounded-lg flex items-center justify-between border transition-all duration-300 ${activePlayer.injuryRisk === 'High' ? 'border-rose-500/50 bg-rose-500/10 shadow-[0_0_15px_rgba(244,63,94,0.15)]' : 'border-white/5'}`}>
                      <span className={`text-sm font-medium ${activePlayer.injuryRisk === 'High' ? 'text-rose-500 font-bold' : 'text-slate-300'}`}>Injury Risk</span>
                      <select
                        value={activePlayer.injuryRisk}
                        onChange={(e) => updatePlayer(activePlayer.id, { injuryRisk: e.target.value })}
                        className={`bg-transparent text-sm font-bold text-right outline-none ${activePlayer.injuryRisk === 'High' ? 'text-rose-500' : activePlayer.injuryRisk === 'Medium' ? 'text-amber-500' : 'text-emerald-500'}`}
                      >
                        <option value="Low">LOW</option>
                        <option value="Medium">MED</option>
                        <option value="High">HIGH</option>
                      </select>
                    </div>

                    <div className={`bg-[#162032] p-3 rounded-lg flex items-center justify-between border transition-all duration-300 ${activePlayer.noBallRisk === 'High' ? 'border-rose-500/50 bg-rose-500/10 shadow-[0_0_15px_rgba(244,63,94,0.15)]' : 'border-white/5'}`}>
                      <span className={`text-sm font-medium ${activePlayer.noBallRisk === 'High' ? 'text-rose-500 font-bold' : 'text-slate-300'}`}>No-Ball Risk</span>
                      <select
                        value={activePlayer.noBallRisk}
                        onChange={(e) => updatePlayer(activePlayer.id, { noBallRisk: e.target.value })}
                        className={`bg-transparent text-sm font-bold text-right outline-none ${activePlayer.noBallRisk === 'High' ? 'text-rose-500' : activePlayer.noBallRisk === 'Medium' ? 'text-amber-500' : 'text-emerald-500'}`}
                      >
                        <option value="Low">LOW</option>
                        <option value="Medium">MED</option>
                        <option value="High">HIGH</option>
                      </select>
                    </div>
                  </div>

                  <div className="mt-auto pt-8">
                    <p className="text-[10px] font-bold text-slate-500 uppercase mb-3">Quick Actions</p>
                    <div className="grid grid-cols-3 gap-3">
                      <button onClick={handleMarkUnfit} className="bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 border border-rose-500/30 p-3 rounded-lg transition-all flex flex-col items-center group shadow-lg shadow-rose-900/10">
                        <Zap className="w-5 h-5 mb-1" />
                        <span className="text-xs font-bold">Mark Unfit</span>
                        <span className="text-[9px] opacity-70">High injury risk</span>
                      </button>
                      <button onClick={handleNewSpell} className="bg-slate-800 hover:bg-slate-700 text-slate-300 p-3 rounded-lg transition-colors flex flex-col items-center border border-slate-700">
                        <CheckCircle2 className="w-5 h-5 mb-1" />
                        <span className="text-xs font-bold">New Spell</span>
                        <span className="text-[9px] opacity-70">Reset count</span>
                      </button>
                      <button
                        onClick={handleRest}
                        className={`p-3 rounded-lg transition-all flex flex-col items-center border ${activePlayer.isResting ? 'bg-emerald-500/20 border-emerald-500/50 text-emerald-400 shadow-[0_0_15px_rgba(16,185,129,0.2)]' : 'bg-slate-800 hover:bg-slate-700 text-slate-300 border-slate-700'}`}
                      >
                        <Wind className={`w-5 h-5 mb-1 ${activePlayer.isResting ? 'animate-pulse' : ''}`} />
                        <span className="text-xs font-bold">{activePlayer.isResting ? 'Resting...' : 'Rest'}</span>
                        <span className="text-[9px] opacity-70">{activePlayer.isResting ? 'Click to Resume' : 'Start Recovery'}</span>
                      </button>
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
            ) : (
               <div className="flex flex-col items-center justify-center h-full text-slate-500">
                 <Users className="w-12 h-12 mb-4 opacity-50" />
                 <p>Select a player from the roster to view metrics.</p>
               </div>
            )}

          </div>
        </div>

        {/* RIGHT: COACH AGENT */}
        <div className="lg:col-span-3 flex flex-col gap-4">
           <div className="bg-[#0F172A] border border-white/5 rounded-2xl flex-1 p-6 relative flex flex-col overflow-hidden">
              <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-indigo-500 via-purple-500 to-pink-500 opacity-50" />
              
              <div className="w-full flex items-center justify-between mb-8 absolute top-6 px-6">
                <span className="text-sm font-bold text-slate-300 flex items-center gap-2">
                  <Shield className="w-4 h-4 text-indigo-400" /> Tactical Coach AI
                </span>
              </div>
              
              {activePlayer ? (
              <>
               {agentWarning && (
                 <div className="w-full px-6 mb-4">
                   <div className="text-[11px] text-amber-300 border border-amber-500/30 bg-amber-500/10 rounded-md px-3 py-2 text-left">
                     {agentWarning}
                   </div>
                 </div>
               )}
               {showBatsmanAiAlert && (
                 <motion.div
                   initial={{ opacity: 0, y: 10 }}
                   animate={{ opacity: 1, y: 0 }}
                   className="mb-6 w-full px-6"
                 >
                    <div className={`rounded-xl p-5 relative overflow-hidden border ${isPressureCritical ? 'bg-rose-950/20 border-rose-500/30' : 'bg-amber-950/20 border-amber-500/30'}`}>
                       <div className="flex items-start gap-3">
                         <div className={`w-9 h-9 rounded-lg flex items-center justify-center border shrink-0 ${isPressureCritical ? 'bg-rose-500/15 border-rose-500/40' : 'bg-amber-500/15 border-amber-500/40'}`}>
                           <AlertTriangle className={`w-4 h-4 ${isPressureCritical ? 'text-rose-400' : 'text-amber-300'}`} />
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
                   className="mb-8 w-full px-6"
                 >
                    <div className="bg-rose-950/20 border border-rose-500/20 rounded-xl p-6 relative overflow-hidden group">
                       <div className="absolute top-0 right-0 w-32 h-32 bg-rose-500/5 blur-[40px] rounded-full pointer-events-none group-hover:bg-rose-500/10 transition-colors" />
                       <div className="flex items-start gap-4 relative z-10">
                          <div className="w-10 h-10 rounded-lg bg-rose-500/10 flex items-center justify-center border border-rose-500/20 shrink-0">
                             <AlertTriangle className="w-5 h-5 text-rose-400" />
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
              {/* EMPTY_STATE_MARKER */}
              {agentState === 'idle' && !substitutionRecommendation && (
                <div className="h-full w-full flex flex-col items-center justify-center px-6">
                  <div className="flex flex-col items-center -mt-10">
                    <div className="w-28 h-28 rounded-3xl flex items-center justify-center bg-gradient-to-br from-indigo-500/25 via-purple-500/20 to-blue-500/15 border border-white/10 shadow-[0_0_40px_rgba(99,102,241,0.25)] backdrop-blur-md mb-8">
                      <Shield className="w-12 h-12 text-white/90" />
                    </div>
                    <h3 className="text-2xl font-semibold text-white/95 mb-12 text-center">Ready to Analyze</h3>
                  </div>
                  <button
                    type="button"
                    aria-label="Run Coach Agent"
                    onClick={() => runAgent('button_click')}
                    className="w-full max-w-[420px] h-14 rounded-full px-10 text-lg font-semibold flex items-center justify-center gap-3 bg-gradient-to-r from-indigo-500 via-purple-500 to-blue-500 shadow-[0_12px_40px_rgba(99,102,241,0.30)] hover:brightness-110 hover:shadow-[0_12px_55px_rgba(99,102,241,0.45)] active:scale-[0.99] transition cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300/70 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0F172A]"
                  >
                    <PlayCircle className="w-5 h-5 shrink-0" /> Run Coach Agent
                  </button>
                </div>
              )}

              {(agentState === 'thinking' || agentState === 'done' || agentState === 'offline' || agentState === 'invalid') && (
                <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="w-full mt-10 text-left overflow-y-auto max-h-[62vh] pr-1 space-y-5">
                  <div className={fatigueCardTheme.wrapper}>
                    <div className="flex items-center justify-between mb-2">
                      <h4 className="text-sm font-bold text-white">Fatigue Agent</h4>
                      <span className={`text-[10px] px-2 py-0.5 rounded border ${fatigueCardTheme.badge}`}>
                        {agentFeedStatus.fatigue === 'loading'
                          ? 'LOADING'
                          : agentFeedStatus.fatigue === 'done'
                            ? `${aiAnalysis?.severity ?? 'LOW'} · F ${safeNum(aiAnalysis?.fatigueIndex, 0).toFixed(1)}`
                            : agentFeedStatus.fatigue.toUpperCase()}
                      </span>
                    </div>
                    {agentFeedStatus.fatigue === 'loading' && (
                      <p className="text-xs text-slate-400">Analyzing telemetry...</p>
                    )}
                    {agentFeedStatus.fatigue === 'error' && (
                      <p className="text-xs text-amber-300">Fatigue agent unavailable. Start backend: <span className="font-mono">cd api && func start</span></p>
                    )}
                    {agentFeedStatus.fatigue === 'done' && aiAnalysis && (
                      <>
                        <p className="text-xs font-semibold text-slate-100 mb-1">{aiAnalysis.headline}</p>
                        <p className="text-xs text-slate-300 mb-2 line-clamp-3">{aiAnalysis.explanation}</p>
                        <p className="text-[10px] text-slate-400 mb-2">
                          Fatigue ({safeNum(aiAnalysis.fatigueIndex, 0).toFixed(1)}) | Injury {aiAnalysis.injuryRisk} | No-ball {aiAnalysis.noBallRisk}
                        </p>
                        <div className="flex flex-wrap gap-1.5 mb-2">
                          {aiAnalysis.signals.map((signal, i) => (
                            <span key={`${signal}-${i}`} className={`text-[10px] px-2 py-0.5 rounded border ${fatigueCardTheme.chip}`}>{signal}</span>
                          ))}
                        </div>
                        <p className="text-xs text-white">{aiAnalysis.recommendation}</p>
                      </>
                    )}
                  </div>

                  <div className={riskCardTheme.wrapper}>
                    <div className="flex items-center justify-between mb-2">
                      <h4 className="text-sm font-bold text-white">{agentFeedStatus.risk === 'error' ? 'Risk Agent (offline)' : 'Risk Agent'}</h4>
                      <span className={`text-[10px] px-2 py-0.5 rounded border ${
                        agentFeedStatus.risk === 'error'
                          ? 'text-rose-300 border-rose-500/40 bg-rose-500/10'
                          : riskCardTheme.badge
                      }`}>
                        {agentFeedStatus.risk === 'loading'
                          ? 'LOADING'
                          : agentFeedStatus.risk === 'done'
                            ? `${riskAnalysis?.severity ?? 'LOW'} · R ${Math.round(safeNum(riskAnalysis?.riskScore, 0))}`
                            : agentFeedStatus.risk.toUpperCase()}
                      </span>
                    </div>
                    {agentFeedStatus.risk === 'loading' && (
                      <p className="text-xs text-slate-400">Aggregating risk signals...</p>
                    )}
                    {agentFeedStatus.risk === 'error' && (
                      <p className="text-xs text-amber-300">Risk agent unavailable. Start backend: <span className="font-mono">cd api && func start</span></p>
                    )}
                    {agentFeedStatus.risk === 'done' && riskAnalysis && (
                      <>
                        <p className="text-xs font-semibold text-slate-100 mb-1">{riskAnalysis.headline}</p>
                        <p className="text-xs text-slate-300 mb-2 line-clamp-3">{riskAnalysis.explanation}</p>
                        <p className="text-[10px] text-slate-400 mb-2">
                          Risk Score ({Math.round(safeNum(riskAnalysis.riskScore, 0))}) | Injury {riskAnalysis.injuryRisk} | No-ball {riskAnalysis.noBallRisk}
                        </p>
                        <div className="flex flex-wrap gap-1.5 mb-2">
                          {riskAnalysis.signals.map((signal, i) => (
                            <span key={`${signal}-${i}`} className={`text-[10px] px-2 py-0.5 rounded border ${riskCardTheme.chip}`}>{signal}</span>
                          ))}
                        </div>
                        <p className="text-xs text-white">{riskAnalysis.recommendation}</p>
                      </>
                    )}
                  </div>

                  {finalDecision && (
                    <div className={`p-5 rounded-xl border ${
                      finalDecision.severity === 'CRITICAL'
                        ? 'bg-gradient-to-b from-indigo-500/12 to-[#162032] border-indigo-400/35 border-l-[3px] border-l-indigo-300/85 shadow-[0_0_26px_rgba(99,102,241,0.22)]'
                        : finalDecision.severity === 'HIGH'
                        ? 'bg-gradient-to-b from-indigo-500/12 to-[#162032] border-indigo-400/35 border-l-[3px] border-l-indigo-300/85 shadow-[0_0_26px_rgba(99,102,241,0.22)]'
                        : finalDecision.severity === 'MED'
                          ? 'bg-gradient-to-b from-indigo-500/12 to-[#162032] border-indigo-400/35 border-l-[3px] border-l-indigo-300/85 shadow-[0_0_26px_rgba(99,102,241,0.22)]'
                          : 'bg-gradient-to-b from-indigo-500/12 to-[#162032] border-indigo-400/35 border-l-[3px] border-l-indigo-300/85 shadow-[0_0_26px_rgba(99,102,241,0.22)]'
                    }`}>
                      <p className="text-[11px] font-bold uppercase tracking-wide text-slate-300 mb-1">Final Analysis / Decision</p>
                      <h3 className="text-base font-bold text-white mb-2">Final Decision</h3>
                      <p className="text-sm text-slate-200 mb-2">{finalDecision.action}</p>
                      <p className="text-xs text-slate-400">Reasons: {finalDecision.reasons[0]}; {finalDecision.reasons[1]}</p>
                    </div>
                  )}

                  <button 
                    onClick={handleDismissAnalysis}
                    className="w-full py-3 rounded-lg border border-slate-700 text-slate-400 text-sm hover:text-white hover:bg-slate-800 transition-colors"
                  >
                    Dismiss Analysis
                  </button>
                </motion.div>
              )}
              </>
              ) : (
                <div className="mt-8 text-slate-500 text-sm">Select a player to analyze</div>
              )}
           </div>
        </div>
      </div>
    </motion.div>
  );
}

function Baselines({ players, updatePlayer, addPlayer, deletePlayer, onBack }: any) {
  const [activeTooltip, setActiveTooltip] = useState<string | null>(null);

  const toggleTooltip = (field: string) => {
    if (activeTooltip === field) {
      setActiveTooltip(null);
    } else {
      setActiveTooltip(field);
    }
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
          <p className="text-slate-400 mt-1">Fatigue Limit (0-10) represents a player’s baseline capacity from historical data. When live match values exceed this tolerance, fatigue and risk increase.</p>
        </div>
        <div className="flex gap-4">
           <button className="flex items-center gap-2 bg-emerald-600 hover:bg-emerald-500 text-white px-5 py-2.5 rounded-lg font-bold shadow-lg shadow-emerald-900/40 transition-all">
            <Save className="w-4 h-4" /> Save Changes
          </button>
        </div>
      </div>

      <div className="flex-1 bg-[#0F172A] border border-white/5 rounded-2xl overflow-hidden shadow-2xl flex flex-col">
         <div className="overflow-auto flex-1">
           <table className="w-full text-left border-collapse min-w-[1000px]">
             <thead>
               <tr className="bg-slate-900/80 border-b border-white/5 text-xs font-bold text-slate-400 uppercase tracking-wider sticky top-0 z-10 backdrop-blur-md">
                 <th className="px-6 py-5 w-[15%]">Player Name</th>
                 <th className="px-6 py-5 w-[12%]">Role</th>
                 <th className="px-4 py-5 text-center w-[12%] relative group/th">
                   <div className="flex items-center justify-center gap-2">
                     Fatigue Limit (0-10)
                     <button 
                       onClick={() => toggleTooltip('fatigue')}
                       className="text-slate-500 hover:text-emerald-400 focus:outline-none transition-colors"
                     >
                       <Info size={14} />
                     </button>
                   </div>
                   {activeTooltip === 'fatigue' && (
                      <div className="absolute top-full mt-2 left-1/2 -translate-x-1/2 w-64 bg-[#020408] border border-emerald-500/30 text-xs text-slate-300 p-3 rounded-lg shadow-2xl z-[100] text-left pointer-events-none font-normal normal-case">
                          <div className="font-bold text-emerald-400 mb-1 flex items-center gap-2"><Activity size={12}/> Fatigue Threshold</div>
                          <p className="leading-relaxed">Baseline fatigue tolerance value. Higher values indicate greater capacity to handle match load before risk increases.</p>
                          <div className="absolute -top-1 left-1/2 -translate-x-1/2 w-2 h-2 bg-[#020408] border-l border-t border-emerald-500/30 rotate-45"></div>
                      </div>
                   )}
                 </th>
                 <th className="px-4 py-5 text-center w-[12%] text-indigo-400">Sleep (Hrs)</th>
                 <th className="px-4 py-5 text-center w-[12%] relative group/th">
                   <div className="flex items-center justify-center gap-2">
                     Recovery (Min)
                     <button 
                       onClick={() => toggleTooltip('recovery')}
                       className="text-slate-500 hover:text-emerald-400 focus:outline-none transition-colors"
                     >
                       <Info size={14} />
                     </button>
                   </div>
                   {activeTooltip === 'recovery' && (
                      <div className="absolute top-full mt-2 right-0 w-64 bg-[#020408] border border-emerald-500/30 text-xs text-slate-300 p-3 rounded-lg shadow-2xl z-[100] text-left pointer-events-none font-normal normal-case">
                          <div className="font-bold text-emerald-400 mb-1 flex items-center gap-2"><Wind size={12}/> Recovery Time</div>
                          <p className="leading-relaxed">Number of minutes needed for this player to recover fully from fatigue.</p>
                          <div className="absolute -top-1 right-8 w-2 h-2 bg-[#020408] border-l border-t border-emerald-500/30 rotate-45"></div>
                      </div>
                   )}
                 </th>
                 <th className="px-6 py-5 text-right w-[20%]">Status</th>
                 <th className="px-4 py-5 text-center w-[10%]">Roster</th>
                 <th className="px-4 py-5 w-[5%]"></th>
               </tr>
             </thead>
             <tbody className="divide-y divide-white/5 text-sm">
               {players.map((p: Player) => {
                  const isActive = p.isActive !== false;
                  // Determine status based on configuration safety
                  let status = { label: "Within Safe Range", color: "text-emerald-400 bg-emerald-500/10 border-emerald-500/20" };
                  
                  if (!isActive) {
                    status = { label: "Inactive", color: "text-slate-300 bg-slate-700/40 border-slate-500/40" };
                  } else if ((p.sleepHours || 0) < 5 || p.baselineFatigue > 9) {
                    status = { label: "Risk Threshold Exceeded", color: "text-rose-400 bg-rose-500/10 border-rose-500/20" };
                  } else if ((p.sleepHours || 0) < 6 || p.baselineFatigue > 8) {
                    status = { label: "Approaching Limit", color: "text-amber-400 bg-amber-500/10 border-amber-500/20" };
                  }

                  return (
                 <tr key={p.id} className="group hover:bg-white/[0.02] transition-colors">
                   <td className="px-6 py-4">
                     <div className="flex flex-col">
                       <input 
                         type="text" 
                         value={p.name}
                         onChange={(e) => updatePlayer(p.id, { name: e.target.value })}
                         className="bg-transparent text-white font-bold focus:outline-none border-b border-transparent focus:border-emerald-500 py-1 transition-colors w-full"
                       />
                       {players.indexOf(p) >= 11 && <span className="text-[10px] text-amber-500 uppercase font-bold mt-1">Substitute</span>}
                     </div>
                   </td>
                   <td className="px-6 py-4">
                      <select 
                        value={p.role}
                        onChange={(e) => updatePlayer(p.id, { role: e.target.value as any })}
                        className="bg-slate-800 border border-slate-700 text-white text-xs rounded-lg px-2 py-1.5 focus:border-emerald-500 outline-none w-full"
                      >
                        <option value="Bowler">Bowler</option>
                        <option value="Fast Bowler">Fast Bowler</option>
                        <option value="Spinner">Spinner</option>
                        <option value="Batsman">Batsman</option>
                        <option value="All-rounder">All-rounder</option>
                      </select>
                   </td>
                   <td className="px-4 py-4 text-center">
                     <div className="flex items-center justify-center gap-2 group-hover:bg-slate-800/50 rounded-lg py-1">
                       <input 
                         type="number" 
                         min="1" max="10"
                         value={p.baselineFatigue}
                         onChange={(e) => updatePlayer(p.id, { baselineFatigue: Number(e.target.value) })}
                         className="w-12 bg-transparent text-center text-white font-mono focus:text-emerald-400 focus:outline-none"
                       />
                     </div>
                   </td>
                   {/* New Sleep Section */}
                   <td className="px-4 py-4 text-center bg-indigo-500/5">
                     <div className="flex items-center justify-center gap-2">
                       <input 
                         type="number" 
                         step="0.5"
                         min="0" max="24"
                         value={p.sleepHours || 0}
                         onChange={(e) => updatePlayer(p.id, { sleepHours: Number(e.target.value) })}
                         className={`w-12 bg-transparent text-center font-mono focus:outline-none font-bold ${
                           (p.sleepHours || 0) < 6 ? 'text-rose-400' : 'text-indigo-400'
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
                         value={p.recoveryTime || 45}
                         onChange={(e) => updatePlayer(p.id, { recoveryTime: Number(e.target.value) })}
                         className="w-12 bg-transparent text-center text-white font-mono focus:text-emerald-400 focus:outline-none"
                       />
                       <span className="text-xs text-slate-500">min</span>
                     </div>
                   </td>
                   <td className="px-6 py-4 text-right">
                      {/* Status Indicator based on configuration safety */}
                      <div className="flex justify-end">
                        <span className={`px-3 py-1 rounded-full text-[10px] font-bold uppercase tracking-wide border ${status.color}`}>
                          {status.label}
                        </span>
                      </div>
                   </td>
                   <td className="px-4 py-4 text-center">
                     <div className="flex items-center justify-center">
                        <button
                          onClick={() => {
                            const nextIsActive = !isActive;
                            updatePlayer(p.id, { isActive: nextIsActive, inRoster: nextIsActive });
                          }}
                          className={`
                            relative flex items-center justify-center gap-2 px-3 py-1.5 rounded-lg text-[10px] font-bold uppercase tracking-wider transition-all duration-300 w-24
                            ${isActive
                              ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/50 hover:bg-emerald-500/30 shadow-[0_0_10px_rgba(16,185,129,0.2)]' 
                              : 'bg-slate-800/50 text-slate-500 border border-slate-700 hover:border-slate-500 hover:text-slate-300 hover:bg-slate-800'}
                          `}
                        >
                          {isActive ? (
                            <>
                              <CheckCircle2 className="w-3 h-3" />
                              <span>Active</span>
                            </>
                          ) : (
                            <>
                              <Plus className="w-3 h-3" />
                              <span>Inactive</span>
                            </>
                          )}
                        </button>
                     </div>
                   </td>
                   <td className="px-4 py-4 text-center">
                     <button 
                       onClick={() => deletePlayer(p.id)}
                       className="p-2 text-slate-600 hover:text-rose-500 hover:bg-rose-500/10 rounded-lg transition-colors opacity-0 group-hover:opacity-100"
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
                 <td colSpan={8} className="px-6 py-4 text-center border-t border-dashed border-white/10">
                   <button 
                     onClick={() => addPlayer("New Player", "Fast Bowler", false, false)}
                     className="flex items-center gap-2 mx-auto text-sm font-bold text-slate-500 hover:text-emerald-400 transition-colors py-4 w-full justify-center group"
                   >
                     <div className="w-8 h-8 rounded-full border border-slate-600 group-hover:border-emerald-500 flex items-center justify-center transition-colors">
                        <Plus className="w-4 h-4" />
                     </div>
                     Add New Player to Baseline Model
                   </button>
                 </td>
               </tr>
             </tbody>
           </table>
         </div>
      </div>
    </motion.div>
  );
}

function BaselineInfoCard({ icon, title, desc }: any) {
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
