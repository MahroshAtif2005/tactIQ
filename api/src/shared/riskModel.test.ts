import test from 'node:test';
import assert from 'node:assert/strict';
import { computeInjuryScore, computeNoBallScore } from './riskModel';
import { RiskAgentRequest } from './types';

function makeInput(overrides: Partial<RiskAgentRequest>): RiskAgentRequest {
  return {
    playerId: 'P1',
    fatigueIndex: 0,
    injuryRisk: 'UNKNOWN',
    noBallRisk: 'UNKNOWN',
    oversBowled: 0,
    consecutiveOvers: 0,
    oversRemaining: 4,
    maxOvers: 4,
    heartRateRecovery: 'GOOD',
    isUnfit: false,
    format: 'T20',
    ...overrides,
  };
}

test('A) low workload and low fatigue => injury LOW, no-ball LOW', () => {
  const input = makeInput({
    fatigueIndex: 2.3,
    oversBowled: 1,
    oversRemaining: 3,
    maxOvers: 4,
    heartRateRecovery: 'GOOD',
  });
  const injury = computeInjuryScore(input);
  const noBall = computeNoBallScore(input);

  assert.equal(injury.level, 'LOW');
  assert.equal(noBall.level, 'LOW');
});

test('B) moderate fatigue + rising workload => injury MEDIUM and no-ball MEDIUM', () => {
  const input = makeInput({
    fatigueIndex: 5.2,
    oversBowled: 3,
    oversRemaining: 1,
    maxOvers: 4,
    heartRateRecovery: 'GOOD',
  });
  const injury = computeInjuryScore(input);
  const noBall = computeNoBallScore(input);

  assert.equal(injury.level, 'MEDIUM');
  assert.equal(noBall.level, 'MEDIUM');
});

test('C) high fatigue and high workload => injury HIGH, no-ball HIGH', () => {
  const input = makeInput({
    fatigueIndex: 7.5,
    oversBowled: 4,
    oversRemaining: 0,
    maxOvers: 4,
    heartRateRecovery: 'GOOD',
  });
  const injury = computeInjuryScore(input);
  const noBall = computeNoBallScore(input);

  assert.equal(injury.level, 'HIGH');
  assert.equal(noBall.level, 'HIGH');
});

test('D) oversBowled == 0 with fresh spell and low fatigue => no-ball LOW', () => {
  const input = makeInput({
    fatigueIndex: 2.5,
    oversBowled: 0,
    oversRemaining: 4,
    maxOvers: 4,
    heartRateRecovery: 'GOOD',
  });
  const noBall = computeNoBallScore(input);

  assert.equal(noBall.level, 'LOW');
});

test('E) injury becomes CRITICAL when fatigue is very high and workload is heavy', () => {
  const input = makeInput({
    fatigueIndex: 9.2,
    oversBowled: 4,
    oversRemaining: 0,
    maxOvers: 4,
    heartRateRecovery: 'GOOD',
  });
  const injury = computeInjuryScore(input);

  assert.equal(injury.level, 'CRITICAL');
});
