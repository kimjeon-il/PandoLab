const RENDER_QUALITY_TIERS = Object.freeze({
  COARSE: 'coarse',
  MEDIUM: 'medium',
  HIGH: 'high',
});

const TIER_ORDER = Object.freeze([
  RENDER_QUALITY_TIERS.COARSE,
  RENDER_QUALITY_TIERS.MEDIUM,
  RENDER_QUALITY_TIERS.HIGH,
]);

function percentile(values, ratio) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))] || 0;
}

function normalizedTier(value) {
  return TIER_ORDER.includes(value) ? value : RENDER_QUALITY_TIERS.MEDIUM;
}

export function resolveInitialRenderQuality({
  deviceMemory = null,
  hardwareConcurrency = null,
  saveData = false,
} = {}) {
  const memory = Number(deviceMemory);
  const cores = Number(hardwareConcurrency);
  const knownMemory = Number.isFinite(memory) && memory > 0;
  const knownCores = Number.isFinite(cores) && cores > 0;
  // Runtime quality is determined by capability hints, not form factor.
  if (saveData || (knownMemory && memory <= 4) || (knownCores && cores <= 4)) return RENDER_QUALITY_TIERS.COARSE;
  if (knownMemory && knownCores && memory >= 8 && cores >= 8) return RENDER_QUALITY_TIERS.HIGH;
  return RENDER_QUALITY_TIERS.MEDIUM;
}

export function renderQualityProfile(tier, {
  phase = 'settle',
  revision = 0,
  metrics = {},
  reason = '',
  devicePixelRatio = 1,
} = {}) {
  const normalized = normalizedTier(tier);
  const nativeDpr=Number(devicePixelRatio);
  const admittedDpr=Number.isFinite(nativeDpr)&&nativeDpr>0?nativeDpr:1;
  // Only live Viewer consumers own quality fields. Old mesh LOD, GPU upload
  // and cache budgets do not change the base globe.
  return Object.freeze({
    tier:normalized,
    phase:phase==='interaction'?'interaction':'settle',
    revision:Number(revision)||0,
    labelCandidateLimit:{coarse:128,medium:256,high:512}[normalized],
    dprCap:admittedDpr,
    metrics:Object.freeze({
      p95FrameMs:Number(metrics.p95FrameMs)||0,
      p99FrameMs:Number(metrics.p99FrameMs)||0,
      longFrameCount:Number(metrics.longFrameCount)||0,
    }),
    reason:String(reason||''),
  });
}

export function createAdaptiveRenderQualityController({
  deviceMemory = null,
  hardwareConcurrency = null,
  saveData = false,
  devicePixelRatio = 1,
  evaluationWindow = 20,
  degradeWindows = 2,
  upgradeWindows = 6,
  changeCooldownMs = 0,
  now = () => globalThis.performance?.now?.() ?? Date.now(),
} = {}) {
  let tier = resolveInitialRenderQuality({ deviceMemory, hardwareConcurrency, saveData });
  let phase = 'settle';
  let revision = 1;
  let lastReason = 'device-hints';
  let lastChangeAt = -Infinity;
  let overBudgetWindows = 0;
  let underBudgetWindows = 0;
  let samplesSinceEvaluation = 0;
  let qualityChangeCount = 0;
  let longFrameCount = 0;
  const frameSamples = [];
  const maximumTierIndex = 2;
  let memoryPressure=false, stableActiveMs=0, windowActiveMs=0;

  function metrics() {
    return {
      p95FrameMs: percentile(frameSamples, 0.95),
      p99FrameMs: percentile(frameSamples, 0.99),
      longFrameCount,
    };
  }

  function profile() {
    return renderQualityProfile(tier, { phase, revision, metrics: metrics(), reason: lastReason,
      devicePixelRatio });
  }

  function changeTier(nextTier, reason) {
    const nextIndex = Math.min(maximumTierIndex, Math.max(0, TIER_ORDER.indexOf(normalizedTier(nextTier))));
    const normalized = TIER_ORDER[nextIndex];
    if (normalized === tier) return false;
    tier = normalized;
    revision += 1;
    qualityChangeCount += 1;
    lastChangeAt = now();
    lastReason = String(reason || 'runtime-frame-budget');
    overBudgetWindows = 0;
    underBudgetWindows = 0;
    stableActiveMs=0; windowActiveMs=0;
    return true;
  }

  function setPhase(nextPhase, reason) {
    const normalized = nextPhase === 'interaction' ? 'interaction' : 'settle';
    if (normalized === phase) return false;
    phase = normalized;
    revision += 1;
    lastReason = String(reason || normalized);
    if(phase==='settle')promoteIfStable();
    return true;
  }

  function evaluate() {
    const current = metrics();
    const expensive = memoryPressure || current.p95FrameMs > 40;
    const comfortable = !memoryPressure && current.p95FrameMs > 0 && current.p95FrameMs < 25;
    if (expensive) {
      overBudgetWindows += 1;
      underBudgetWindows = 0;
    } else if (comfortable) {
      underBudgetWindows += 1;
      overBudgetWindows = 0;
    } else {
      overBudgetWindows = 0;
      underBudgetWindows = 0;
    }
    if (now() - lastChangeAt < changeCooldownMs) return false;
    stableActiveMs = comfortable ? stableActiveMs + windowActiveMs : 0;
    windowActiveMs = 0;
    const index = TIER_ORDER.indexOf(tier);
    if(overBudgetWindows>=degradeWindows){
      if(index>0)return changeTier(TIER_ORDER[index-1],'frame-p95-over-budget');
    }
    return promoteIfStable();
  }

  function promoteIfStable() {
    const index=TIER_ORDER.indexOf(tier);
    if (phase === 'settle' && !memoryPressure && underBudgetWindows >= upgradeWindows
      && stableActiveMs >= 15000) {
      if(index<maximumTierIndex)return changeTier(TIER_ORDER[index + 1],'frame-budget-stable');
    }
    return false;
  }

  function recordFrame(durationMs, { frameIntervalMs=0,suspended=false,waiting=false,memoryPressure:pressure=false } = {}) {
    if(suspended||waiting){stableActiveMs=0;windowActiveMs=0;underBudgetWindows=0;return false;}
    memoryPressure=pressure;
    const duration = Math.max(0, Number(durationMs) || 0,Number(frameIntervalMs)||0);
    if (!duration) return false;
    windowActiveMs += duration;
    frameSamples.push(duration);
    if (frameSamples.length > 60) frameSamples.splice(0, frameSamples.length - 60);
    if (duration >= 45) longFrameCount += 1;
    samplesSinceEvaluation += 1;
    if (samplesSinceEvaluation < Math.max(4, Number(evaluationWindow) || 20)) return false;
    samplesSinceEvaluation = 0;
    return evaluate();
  }

  return Object.freeze({
    beginInteraction: reason => setPhase('interaction', reason || 'interaction'),
    endInteraction: reason => setPhase('settle', reason || 'settle'),
    recordFrame,
    setTier: (nextTier, reason = 'manual') => changeTier(nextTier, reason),
    profile,
    stats: () => Object.freeze({
      ...profile(),
      sampleCount: frameSamples.length,
      overBudgetWindows,
      underBudgetWindows,
      qualityChangeCount,
      maximumTier: TIER_ORDER[maximumTierIndex],
    }),
  });
}
