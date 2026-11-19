import { now } from '../utils.js';
import { numSetting } from '../db/settings.js';
import { db } from '../db/connection.js';
import { WSOL_MINT, minimumEntryLamports } from '../config.js';
import { escapeHtml, fmtSol } from '../format.js';
import { executeJupiterSwap, liveWalletBalanceLamports, fetchLiveTokenBalance, confirmSwapFill, liveWalletPubkey } from '../liveExecutor.js';
import { canOpenMorePositions, openPositionCount, currentPositionSizeSol, reserveLivePosition, finalizeLivePosition, failLivePosition } from '../db/positions.js';
import { intentById, claimIntent, settleIntent } from '../db/intents.js';
import { logDecisionEvent } from '../db/decisions.js';
import { refreshCandidateForExecution } from './positions.js';
import { bot } from '../telegram/bot.js';
import { candidateSummary } from '../telegram/format.js';
import { sendPositionOpen, sendTelegram } from '../telegram/send.js';
import { updateCandidateStatus } from '../db/candidates.js';
import { createTradeIntent } from '../db/intents.js';

export async function executeLiveBuy(selectedRow, decision, batchId, rows = [], triggerCandidateId = null) {
  const amountLamports = Math.floor(currentPositionSizeSol() * 1_000_000_000);
  const balance = await liveWalletBalanceLamports();
  const requiredLamports = minimumEntryLamports(amountLamports);
  if (balance < requiredLamports) {
    throw new Error(`Insufficient SOL balance. Need ${fmtSol(requiredLamports / 1_000_000_000)} SOL including reserve, ATA rent, and fee buffer.`);
  }
  const mint = selectedRow.candidate.token.mint;
  // Reserve before signing. A duplicate is refused here, with no SOL spent.
  const positionId = reserveLivePosition(selectedRow.id, selectedRow.candidate, decision, `live_batch_${batchId}`);
  let swap;
  try {
    swap = await executeJupiterSwap({
      inputMint: WSOL_MINT,
      outputMint: mint,
      amount: amountLamports,
    });
    const fill = await confirmSwapFill(swap.signature, { mint, owner: liveWalletPubkey() });
    if (fill?.tokenAmountRaw) swap.outputAmount = fill.tokenAmountRaw;
    if (!swap.outputAmount) {
      swap.outputAmount = await fetchLiveTokenBalance(mint) || swap.outputAmount;
    }
    finalizeLivePosition(positionId, {
      signature: swap.signature,
      tokenAmountRaw: swap.outputAmount || null,
      actualSizeSol: fill?.solDeltaLamports ? Math.abs(fill.solDeltaLamports) / 1_000_000_000 : null,
      feeLamports: fill?.feeLamports || null,
    });
  } catch (err) {
    failLivePosition(positionId, err.message);
    throw err;
  }
  logDecisionEvent({
    batchId,
    triggerCandidateId,
    selectedRow,
    rows,
    decision,
    mode: 'live',
    action: 'live_entry_executed',
    guardrails: { balanceLamports: balance, amountLamports, requiredLamports },
    execution: { positionId, swap },
  });
  await sendPositionOpen(positionId);
}

export async function executeLiveSell(position, reason, { exact = false } = {}) {
  // Full exits sell whatever the wallet actually holds; a stored estimate is not
  // a balance and would leave dust or fail outright. Partial exits pass `exact`.
  let amount = position.token_amount_raw || position.token_amount_est;
  if (!exact) {
    const liveBalance = await fetchLiveTokenBalance(position.mint);
    if (liveBalance && Number(liveBalance) > 0) amount = liveBalance;
  }
  if (!amount || Number(amount) <= 0) throw new Error('Live position has no token amount to sell.');
  return executeJupiterSwap({
    inputMint: position.mint,
    outputMint: WSOL_MINT,
    amount,
  });
}

export async function executeConfirmedIntent(chatId, intentId) {
  const intent = intentById(intentId);
  if (!intent || intent.status !== 'pending_confirmation') return bot.sendMessage(chatId, 'Pending intent not found.');
  if (!canOpenMorePositions()) {
    return bot.sendMessage(chatId, `Max open positions reached (${openPositionCount()}/${numSetting('max_open_positions', 3)}).`);
  }
  // Claim first: the status flip is the lock, so a second tap cannot swap twice.
  if (!claimIntent(intentId)) {
    return bot.sendMessage(chatId, `Intent #${intentId} is already being handled.`);
  }
  const { decision } = intent.payload;
  let positionId = null;
  try {
    const freshRow = await refreshCandidateForExecution({
      id: intent.candidate_id,
      candidate: intent.payload.candidate,
    });
    if (!freshRow.candidate.filters?.passed) {
      const failures = freshRow.candidate.filters?.failures || [];
      settleIntent(intentId, 'rejected_stale', { error: failures.join('; ') || 'fresh execution guard failed' });
      return bot.sendMessage(chatId, [
        '🛑 <b>Trade intent rejected on fresh check</b>',
        '',
        candidateSummary(freshRow.candidate, decision),
        '',
        `Failures: ${escapeHtml(failures.join('; ') || 'fresh execution guard failed')}`,
      ].join('\n'), { parse_mode: 'HTML', disable_web_page_preview: true });
    }
    const amountLamports = Math.floor(currentPositionSizeSol() * 1_000_000_000);
    const balance = await liveWalletBalanceLamports();
    const requiredLamports = minimumEntryLamports(amountLamports);
    if (balance < requiredLamports) {
      settleIntent(intentId, 'rejected_insufficient_balance', { error: 'insufficient SOL including reserve, ATA rent, and fee buffer' });
      return bot.sendMessage(chatId, `Insufficient SOL balance. Need ${fmtSol(requiredLamports / 1_000_000_000)} SOL.`, { parse_mode: 'HTML' });
    }
    positionId = reserveLivePosition(intent.candidate_id, freshRow.candidate, decision, `confirmed_intent_${intentId}`);
    const swap = await executeJupiterSwap({
      inputMint: WSOL_MINT,
      outputMint: freshRow.candidate.token.mint,
      amount: amountLamports,
    });
    const fill = await confirmSwapFill(swap.signature, { mint: freshRow.candidate.token.mint, owner: liveWalletPubkey() });
    if (fill?.tokenAmountRaw) swap.outputAmount = fill.tokenAmountRaw;
    if (!swap.outputAmount) {
      swap.outputAmount = await fetchLiveTokenBalance(freshRow.candidate.token.mint) || swap.outputAmount;
    }
    finalizeLivePosition(positionId, {
      signature: swap.signature,
      tokenAmountRaw: swap.outputAmount || null,
      actualSizeSol: fill?.solDeltaLamports ? Math.abs(fill.solDeltaLamports) / 1_000_000_000 : null,
      feeLamports: fill?.feeLamports || null,
    });
    settleIntent(intentId, 'executed_live', { signature: swap.signature });
    logDecisionEvent({
      batchId: null,
      triggerCandidateId: intent.candidate_id,
      selectedRow: freshRow,
      rows: [],
      decision,
      mode: 'live',
      action: 'confirmed_intent_executed',
      guardrails: { balanceLamports: balance, amountLamports, intentId },
      execution: { positionId, swap },
    });
    return sendPositionOpen(positionId);
  } catch (err) {
    if (positionId) failLivePosition(positionId, err.message);
    // A signed transaction whose /execute call timed out is not a failure: the
    // swap may have landed, so the intent must stay visible for manual review.
    const status = err.phase === 'execute' ? 'execution_unknown' : 'execution_failed';
    settleIntent(intentId, status, { error: err.message });
    const label = status === 'execution_unknown'
      ? 'Live execution state unknown — check the wallet before retrying'
      : 'Live execution failed';
    return bot.sendMessage(chatId, `${escapeHtml(label)}: ${escapeHtml(err.message)}`, { parse_mode: 'HTML' });
  }
}

export async function rejectIntent(chatId, intentId) {
  const intent = intentById(intentId);
  if (!intent) return bot.sendMessage(chatId, 'Intent not found.');
  const result = db.prepare(`
    UPDATE trade_intents SET status = 'rejected', updated_at_ms = ?
    WHERE id = ? AND status = 'pending_confirmation'
  `).run(now(), intentId);
  if (result.changes === 0) {
    return bot.sendMessage(chatId, `Intent #${intentId} is ${intent.status}; nothing rejected.`);
  }
  return bot.sendMessage(chatId, `Rejected trade intent #${intentId}.`);
}
