/**
 * @NApiVersion 2.1
 * @NScriptType ScheduledScript
 * 
 * FORENSIC ASYNC INVESTIGATION - FULL SUITE
 * 
 * THEORY TO PROVE OR DISPROVE:
 *   Server-side .promise() on Graal.js is a promise-compatible API layer
 *   over serial execution. The underlying operations are processed one at a
 *   time, not in parallel. Observed speedups in small batches are caused by
 *   cold-start connection overhead on the first call, not true concurrency.
 * 
 * TESTS:
 *   0. Original 5 IDs that showed 2-4x speedup in earlier benchmarks
 *   1. Cold start detection (N/search, 5 records)
 *   2. Warm serial pattern (N/search, 25 records)
 *   3. N/query (SuiteQL) cross-module check
 *   4. N/https Suitelet calls (requires ping Suitelet)
 *   5. Scaling comparison at 5, 15, 25
 *   6. Repeat of test 2 for consistency
 * 
 * SETUP FOR TEST 4:
 *   Deploy a simple ping Suitelet (see ping-suitelet.js)
 *   Then set PING_SCRIPT_ID and PING_DEPLOY_ID below.
 *   Leave as null to skip test 4.
 */
define(['N/search', 'N/query', 'N/https', 'N/runtime'], (search, query, https, runtime) => {

  // CONFIG
  const PING_SCRIPT_ID = null;
  const PING_DEPLOY_ID = null;

  // -----------------------------------------------
  // UTILITY FUNCTIONS
  // -----------------------------------------------

  const analyzeTimings = (timings) => {
    if (timings.length === 0) return null;

    const byResolve = [...timings].sort((a, b) => a.resolveTs - b.resolveTs);

    let inOrderCount = 0;
    for (let i = 0; i < byResolve.length; i++) {
      if (byResolve[i].launchIndex === i) inOrderCount++;
    }

    const resolveTimes = byResolve.map(t => t.resolveTs);
    const gaps = [];
    for (let i = 1; i < resolveTimes.length; i++) {
      gaps.push(resolveTimes[i] - resolveTimes[i - 1]);
    }

    const waitTimes = timings.map(t => t.waitTime);

    const avgGap = gaps.length > 0 ? gaps.reduce((a, b) => a + b, 0) / gaps.length : 0;
    const gapVariance = gaps.length > 0
      ? gaps.reduce((sum, g) => sum + Math.pow(g - avgGap, 2), 0) / gaps.length
      : 0;
    const gapStdDev = Math.sqrt(gapVariance);

    const threshold = Math.max(avgGap * 2, 15);
    const batchGaps = [];
    for (let i = 0; i < gaps.length; i++) {
      if (gaps[i] > threshold) {
        batchGaps.push({ after: i + 1, gap: gaps[i] });
      }
    }

    return {
      count: timings.length,
      inOrderCount,
      isSequentialOrder: inOrderCount === timings.length,
      gaps,
      avgGap: avgGap.toFixed(1),
      minGap: gaps.length > 0 ? Math.min(...gaps) : 0,
      maxGap: gaps.length > 0 ? Math.max(...gaps) : 0,
      gapStdDev: gapStdDev.toFixed(1),
      gapUniform: gapStdDev < 5,
      waitTimes,
      waitMin: Math.min(...waitTimes),
      waitMax: Math.max(...waitTimes),
      waitAvg: (waitTimes.reduce((a, b) => a + b, 0) / waitTimes.length).toFixed(1),
      batchGaps,
      resolveOrder: byResolve.map(t => `L${t.launchIndex}`).join(','),
    };
  };

  const runSyncTest = (ids, operation) => {
    const timings = [];
    const t = Date.now();
    for (let i = 0; i < ids.length; i++) {
      const callStart = Date.now();
      operation(ids[i]);
      const callTime = Date.now() - callStart;
      timings.push({ index: i, id: ids[i], ms: callTime });
    }
    const total = Date.now() - t;
    const callTimes = timings.map(t => t.ms);
    return {
      total,
      callTimes,
      first: callTimes[0],
      restAvg: callTimes.length > 1
        ? (callTimes.slice(1).reduce((a, b) => a + b, 0) / (callTimes.length - 1)).toFixed(1)
        : 'N/A',
      min: Math.min(...callTimes),
      max: Math.max(...callTimes),
    };
  };

  const runAsyncTest = async (ids, promiseOperation) => {
    const timings = [];
    let resolveCounter = 0;
    const t = Date.now();

    await Promise.all(
      ids.map((id, launchIndex) => {
        const launchTs = Date.now() - t;
        return promiseOperation(id).then(result => {
          const resolveTs = Date.now() - t;
          timings.push({
            id,
            launchIndex,
            resolveIndex: resolveCounter++,
            launchTs,
            resolveTs,
            waitTime: resolveTs - launchTs,
          });
          return result;
        });
      })
    );

    const total = Date.now() - t;
    const analysis = analyzeTimings(timings);
    return { total, analysis };
  };

  // -----------------------------------------------
  // MAIN
  // -----------------------------------------------
  const execute = async (context) => {
    const script = runtime.getCurrentScript();

    log.audit('FORENSIC', '===============================================');
    log.audit('FORENSIC', 'Async Internals Investigation - Full Suite');
    log.audit('FORENSIC', '===============================================');
    log.audit('ENV', `Script: ${script.id} | Deploy: ${script.deploymentId}`);
    log.audit('ENV', `Account: ${runtime.accountId} | Version: ${runtime.version}`);
    log.audit('ENV', `Processors: ${runtime.processorCount} | Queues: ${runtime.queueCount}`);
    log.audit('ENV', `Governance: ${script.getRemainingUsage()}`);

    // Find test records
    const soIds = [];
    search.create({
      type: search.Type.SALES_ORDER,
      filters: [['mainline', 'is', 'T'], 'AND', ['internalid', 'isnotempty', '']],
      columns: [search.createColumn({ name: 'internalid', sort: search.Sort.DESC })]
    }).run().each(r => {
      if (soIds.length >= 25) return false;
      soIds.push(Number(r.getValue('internalid')));
      return true;
    });

    if (soIds.length === 0) {
      log.error('SETUP', 'No sales orders found. Check filters/permissions.');
      return;
    }

    log.audit('SETUP', `Found ${soIds.length} sales orders`);

    const ids5 = soIds.slice(0, 5);
    const ids15 = soIds.slice(0, 15);
    const ids25 = soIds.slice(0, 25);
    const fields = ['tranid', 'total', 'status'];

    const searchSync = (id) => search.lookupFields({
      type: search.Type.SALES_ORDER, id, columns: fields
    });
    const searchAsync = (id) => search.lookupFields.promise({
      type: search.Type.SALES_ORDER, id, columns: fields
    });
    const querySync = (id) => query.runSuiteQL({
      query: `SELECT tranid, foreigntotal, status FROM transaction WHERE id = ?`,
      params: [id]
    });
    const queryAsync = (id) => query.runSuiteQL.promise({
      query: `SELECT tranid, foreigntotal, status FROM transaction WHERE id = ?`,
      params: [id]
    });

    // -----------------------------------------------
    // TEST 0: ORIGINAL BENCHMARK IDs
    // -----------------------------------------------
    log.audit('', '===============================================');
    log.audit('TEST 0', 'ORIGINAL 5 IDs - the ones that showed 2-4x speedup');
    log.audit('', '===============================================');

    const originalIds = [226296, 226188, 226088, 225984, 225983];

    const t0SyncCold = runSyncTest(originalIds, searchSync);
    log.audit('T0 SYNC (1st)', `Total: ${t0SyncCold.total}ms | Per-call: [${t0SyncCold.callTimes.join(', ')}]`);
    log.audit('T0 SYNC (1st)', `First: ${t0SyncCold.first}ms | Rest avg: ${t0SyncCold.restAvg}ms`);

    const t0SyncWarm = runSyncTest(originalIds, searchSync);
    log.audit('T0 SYNC (2nd)', `Total: ${t0SyncWarm.total}ms | Per-call: [${t0SyncWarm.callTimes.join(', ')}]`);
    log.audit('T0 SYNC (2nd)', `First: ${t0SyncWarm.first}ms | Rest avg: ${t0SyncWarm.restAvg}ms`);

    const t0AsyncCold = await runAsyncTest(originalIds, searchAsync);
    log.audit('T0 ASYNC (1st)', `Total: ${t0AsyncCold.total}ms`);
    log.audit('T0 ASYNC (1st)', `Gaps: [${t0AsyncCold.analysis.gaps.join(', ')}]`);
    log.audit('T0 ASYNC (1st)', `Gap stdDev: ${t0AsyncCold.analysis.gapStdDev}ms - ${t0AsyncCold.analysis.gapUniform ? 'UNIFORM (serial)' : 'VARIABLE'}`);
    log.audit('T0 ASYNC (1st)', `Resolve order: ${t0AsyncCold.analysis.resolveOrder}`);
    log.audit('T0 ASYNC (1st)', `Wait times: [${t0AsyncCold.analysis.waitTimes.join(', ')}]`);

    const t0AsyncWarm = await runAsyncTest(originalIds, searchAsync);
    log.audit('T0 ASYNC (2nd)', `Total: ${t0AsyncWarm.total}ms`);
    log.audit('T0 ASYNC (2nd)', `Gaps: [${t0AsyncWarm.analysis.gaps.join(', ')}]`);
    log.audit('T0 ASYNC (2nd)', `Gap stdDev: ${t0AsyncWarm.analysis.gapStdDev}ms - ${t0AsyncWarm.analysis.gapUniform ? 'UNIFORM (serial)' : 'VARIABLE'}`);
    log.audit('T0 ASYNC (2nd)', `Resolve order: ${t0AsyncWarm.analysis.resolveOrder}`);
    log.audit('T0 ASYNC (2nd)', `Wait times: [${t0AsyncWarm.analysis.waitTimes.join(', ')}]`);

    log.audit('T0 COMPARE', `Sync cold:  ${t0SyncCold.total}ms | Sync warm:  ${t0SyncWarm.total}ms`);
    log.audit('T0 COMPARE', `Async cold: ${t0AsyncCold.total}ms | Async warm: ${t0AsyncWarm.total}ms`);
    log.audit('T0 COMPARE', `Cold speedup: ${(t0SyncCold.total / t0AsyncCold.total).toFixed(2)}x | Warm speedup: ${(t0SyncWarm.total / t0AsyncWarm.total).toFixed(2)}x`);

    const t0ColdWin = t0SyncCold.total > t0AsyncCold.total;
    const t0WarmWin = t0SyncWarm.total > t0AsyncWarm.total;
    if (t0ColdWin && !t0WarmWin) {
      log.audit('T0 VERDICT', 'Async only wins on cold run. Speedup IS cold-start artifact.');
    } else if (t0ColdWin && t0WarmWin) {
      log.audit('T0 VERDICT', 'Async wins both cold and warm. Investigate further.');
    } else {
      log.audit('T0 VERDICT', 'Sync wins both. No async advantage with these records.');
    }

    // -----------------------------------------------
    // TEST 1: COLD START (N/search, 5 records)
    // -----------------------------------------------
    log.audit('', '===============================================');
    log.audit('TEST 1', 'COLD START - N/search, 5 dynamic records');
    log.audit('', '===============================================');

    const t1Sync = runSyncTest(ids5, searchSync);
    log.audit('T1 SYNC', `Total: ${t1Sync.total}ms | Per-call: [${t1Sync.callTimes.join(', ')}]`);
    log.audit('T1 SYNC', `First: ${t1Sync.first}ms | Rest avg: ${t1Sync.restAvg}ms`);

    const t1Async = await runAsyncTest(ids5, searchAsync);
    log.audit('T1 ASYNC', `Total: ${t1Async.total}ms`);
    log.audit('T1 ASYNC', `Gaps: [${t1Async.analysis.gaps.join(', ')}]`);
    log.audit('T1 ASYNC', `Gap stdDev: ${t1Async.analysis.gapStdDev}ms - ${t1Async.analysis.gapUniform ? 'UNIFORM (serial)' : 'VARIABLE'}`);
    log.audit('T1 ASYNC', `Resolve order: ${t1Async.analysis.resolveOrder}`);
    log.audit('T1 ASYNC', `Wait times: [${t1Async.analysis.waitTimes.join(', ')}]`);

    const t1Speedup = (t1Sync.total / t1Async.total).toFixed(2);
    const t1ColdStart = t1Sync.first > Number(t1Sync.restAvg) * 2;
    log.audit('T1 RESULT', `Speedup: ${t1Speedup}x - ${t1Sync.total > t1Async.total ? 'ASYNC WINS' : 'SYNC WINS'}`);
    log.audit('T1 RESULT', `Cold start: ${t1ColdStart ? 'CONFIRMED - first call ' + t1Sync.first + 'ms vs rest avg ' + t1Sync.restAvg + 'ms' : 'NOT DETECTED'}`);

    // -----------------------------------------------
    // TEST 2: WARM SERIAL (N/search, 25 records)
    // -----------------------------------------------
    log.audit('', '===============================================');
    log.audit('TEST 2', 'WARM SERIAL PATTERN - N/search, 25 records');
    log.audit('', '===============================================');

    const t2Sync = runSyncTest(ids25, searchSync);
    log.audit('T2 SYNC', `Total: ${t2Sync.total}ms | First: ${t2Sync.first}ms | Rest avg: ${t2Sync.restAvg}ms`);

    const t2Async = await runAsyncTest(ids25, searchAsync);
    log.audit('T2 ASYNC', `Total: ${t2Async.total}ms`);
    log.audit('T2 ASYNC', `Gaps: [${t2Async.analysis.gaps.join(', ')}]`);
    log.audit('T2 ASYNC', `Gap stdDev: ${t2Async.analysis.gapStdDev}ms - ${t2Async.analysis.gapUniform ? 'UNIFORM (serial confirmed)' : 'VARIABLE'}`);
    log.audit('T2 ASYNC', `Resolve order: ${t2Async.analysis.resolveOrder}`);
    log.audit('T2 ASYNC', `Batch gaps: ${t2Async.analysis.batchGaps.length > 0 ? JSON.stringify(t2Async.analysis.batchGaps) : 'None'}`);

    const t2Speedup = (t2Sync.total / t2Async.total).toFixed(2);
    log.audit('T2 RESULT', `Speedup: ${t2Speedup}x - ${t2Sync.total > t2Async.total ? 'ASYNC WINS' : 'SYNC WINS'}`);

    // -----------------------------------------------
    // TEST 3: N/query (SuiteQL, 15 records)
    // -----------------------------------------------
    log.audit('', '===============================================');
    log.audit('TEST 3', 'N/query (SuiteQL) - 15 records');
    log.audit('', '===============================================');

    const t3Sync = runSyncTest(ids15, querySync);
    log.audit('T3 SYNC', `Total: ${t3Sync.total}ms | Per-call: [${t3Sync.callTimes.join(', ')}]`);
    log.audit('T3 SYNC', `First: ${t3Sync.first}ms | Rest avg: ${t3Sync.restAvg}ms`);

    const t3Async = await runAsyncTest(ids15, queryAsync);
    log.audit('T3 ASYNC', `Total: ${t3Async.total}ms`);
    log.audit('T3 ASYNC', `Gaps: [${t3Async.analysis.gaps.join(', ')}]`);
    log.audit('T3 ASYNC', `Gap stdDev: ${t3Async.analysis.gapStdDev}ms - ${t3Async.analysis.gapUniform ? 'UNIFORM (serial)' : 'VARIABLE'}`);
    log.audit('T3 ASYNC', `Resolve order: ${t3Async.analysis.resolveOrder}`);

    const t3Speedup = (t3Sync.total / t3Async.total).toFixed(2);
    log.audit('T3 RESULT', `Speedup: ${t3Speedup}x - ${t3Sync.total > t3Async.total ? 'ASYNC WINS' : 'SYNC WINS'}`);

    // -----------------------------------------------
    // TEST 4: N/https (Suitelet calls)
    // -----------------------------------------------
    log.audit('', '===============================================');

    let t4GapUniform = null;
    let t4GapStdDev = null;

    if (PING_SCRIPT_ID && PING_DEPLOY_ID) {
      log.audit('TEST 4', 'N/https - 10 Suitelet calls');
      log.audit('', '===============================================');

      const httpIds = Array.from({ length: 10 }, (_, i) => i);

      const httpSync = () => https.requestSuitelet({
        scriptId: PING_SCRIPT_ID,
        deploymentId: PING_DEPLOY_ID,
      });
      const httpAsync = () => https.requestSuitelet.promise({
        scriptId: PING_SCRIPT_ID,
        deploymentId: PING_DEPLOY_ID,
      });

      const t4Sync = runSyncTest(httpIds, httpSync);
      log.audit('T4 SYNC', `Total: ${t4Sync.total}ms | Per-call: [${t4Sync.callTimes.join(', ')}]`);
      log.audit('T4 SYNC', `First: ${t4Sync.first}ms | Rest avg: ${t4Sync.restAvg}ms`);

      const t4Async = await runAsyncTest(httpIds, httpAsync);
      log.audit('T4 ASYNC', `Total: ${t4Async.total}ms`);
      log.audit('T4 ASYNC', `Gaps: [${t4Async.analysis.gaps.join(', ')}]`);
      log.audit('T4 ASYNC', `Gap stdDev: ${t4Async.analysis.gapStdDev}ms - ${t4Async.analysis.gapUniform ? 'UNIFORM (serial even for HTTP)' : 'VARIABLE (HTTP has real parallelism)'}`);
      log.audit('T4 ASYNC', `Resolve order: ${t4Async.analysis.resolveOrder}`);
      log.audit('T4 ASYNC', `Wait times: [${t4Async.analysis.waitTimes.join(', ')}]`);

      const t4Speedup = (t4Sync.total / t4Async.total).toFixed(2);
      log.audit('T4 RESULT', `Speedup: ${t4Speedup}x - ${t4Sync.total > t4Async.total ? 'ASYNC WINS' : 'SYNC WINS'}`);

      t4GapUniform = t4Async.analysis.gapUniform;
      t4GapStdDev = t4Async.analysis.gapStdDev;
    } else {
      log.audit('TEST 4', 'SKIPPED - Set PING_SCRIPT_ID and PING_DEPLOY_ID to enable');
      log.audit('', '===============================================');
    }

    // -----------------------------------------------
    // TEST 5: SCALING (5, 15, 25 warm)
    // -----------------------------------------------
    log.audit('', '===============================================');
    log.audit('TEST 5', 'SCALING - N/search at 5, 15, 25 (warm)');
    log.audit('', '===============================================');

    for (const size of [{ label: '5', ids: ids5 }, { label: '15', ids: ids15 }, { label: '25', ids: ids25 }]) {
      const sSync = runSyncTest(size.ids, searchSync);
      const sAsync = await runAsyncTest(size.ids, searchAsync);
      const speedup = (sSync.total / sAsync.total).toFixed(2);

      log.audit(`T5 [${size.label}]`,
        `Sync: ${sSync.total}ms | Async: ${sAsync.total}ms | ${speedup}x | ` +
        `Gaps stdDev: ${sAsync.analysis.gapStdDev}ms | ` +
        `Avg gap: ${sAsync.analysis.avgGap}ms | ` +
        `${sSync.total > sAsync.total ? 'ASYNC' : 'SYNC'} wins`
      );
    }

    // -----------------------------------------------
    // TEST 6: REPEAT (run test 2 again)
    // -----------------------------------------------
    log.audit('', '===============================================');
    log.audit('TEST 6', 'REPEAT - N/search, 25 records (second run)');
    log.audit('', '===============================================');

    const t6Sync = runSyncTest(ids25, searchSync);
    const t6Async = await runAsyncTest(ids25, searchAsync);
    const t6Speedup = (t6Sync.total / t6Async.total).toFixed(2);

    log.audit('T6 RESULT', `Sync: ${t6Sync.total}ms | Async: ${t6Async.total}ms | ${t6Speedup}x`);
    log.audit('T6 RESULT', `Gaps: [${t6Async.analysis.gaps.join(', ')}]`);
    log.audit('T6 RESULT', `Gap stdDev: ${t6Async.analysis.gapStdDev}ms - ${t6Async.analysis.gapUniform ? 'Still uniform' : 'Changed'}`);
    log.audit('T6 RESULT', `vs Test 2: Run1=${t2Async.total}ms Run2=${t6Async.total}ms Delta=${Math.abs(t2Async.total - t6Async.total)}ms - ${Math.abs(t2Async.total - t6Async.total) < 100 ? 'CONSISTENT' : 'INCONSISTENT'}`);

    // -----------------------------------------------
    // FINAL VERDICT
    // -----------------------------------------------
    log.audit('', '===============================================');
    log.audit('VERDICT', 'THEORY: .promise() is serial execution with Promise API wrapper');
    log.audit('', '-----------------------------------------------');

    log.audit('EVIDENCE', `0. Original IDs: cold ${(t0SyncCold.total / t0AsyncCold.total).toFixed(2)}x | warm ${(t0SyncWarm.total / t0AsyncWarm.total).toFixed(2)}x - ${t0ColdWin && !t0WarmWin ? 'Cold-start artifact confirmed' : t0ColdWin && t0WarmWin ? 'Async wins both - investigate' : 'Sync wins both'}`);
    log.audit('EVIDENCE', `1. Cold start: ${t1ColdStart ? 'CONFIRMED - first call ' + t1Sync.first + 'ms vs rest ' + t1Sync.restAvg + 'ms' : 'Not detected'}`);
    log.audit('EVIDENCE', `2. N/search serial: ${t2Async.analysis.gapUniform ? 'YES - gaps uniform (stdDev ' + t2Async.analysis.gapStdDev + 'ms)' : 'NO - gaps variable (stdDev ' + t2Async.analysis.gapStdDev + 'ms)'}`);
    log.audit('EVIDENCE', `3. N/query serial: ${t3Async.analysis.gapUniform ? 'YES - gaps uniform (stdDev ' + t3Async.analysis.gapStdDev + 'ms)' : 'NO - gaps variable (stdDev ' + t3Async.analysis.gapStdDev + 'ms)'}`);

    if (t4GapUniform !== null) {
      log.audit('EVIDENCE', `4. N/https serial: ${t4GapUniform ? 'YES - serial even for HTTP (stdDev ' + t4GapStdDev + 'ms)' : 'NO - HTTP shows real parallelism (stdDev ' + t4GapStdDev + 'ms)'}`);
    } else {
      log.audit('EVIDENCE', '4. N/https: SKIPPED');
    }

    log.audit('EVIDENCE', `5. Repeat consistent: ${Math.abs(t2Async.total - t6Async.total) < 100 ? 'YES' : 'NO'}`);

    log.audit('', '-----------------------------------------------');

    const searchSerial = t2Async.analysis.gapUniform;
    const querySerial = t3Async.analysis.gapUniform;

    if (searchSerial && querySerial && (t4GapUniform === null || t4GapUniform)) {
      log.audit('VERDICT', 'THEORY CONFIRMED');
      log.audit('VERDICT', 'Server-side .promise() is serial execution wrapped in Promise API.');
      log.audit('VERDICT', 'Graal.js processes operations one at a time.');
      log.audit('VERDICT', 'Early benchmarks showing speedup were caused by cold-start overlap.');
      log.audit('VERDICT', 'Async on server = code convenience, NOT performance optimization.');
    } else if (searchSerial && querySerial && t4GapUniform === false) {
      log.audit('VERDICT', 'PARTIALLY CONFIRMED');
      log.audit('VERDICT', 'Database ops (N/search, N/query) are serial.');
      log.audit('VERDICT', 'BUT N/https shows genuine parallelism - delegates to Java HTTP threads.');
      log.audit('VERDICT', 'Server-side async is a real win ONLY for external HTTP calls.');
    } else {
      log.audit('VERDICT', 'THEORY DISPROVED');
      log.audit('VERDICT', 'Operations show genuine concurrency.');
    }

    log.audit('', '===============================================');
    log.audit('GOV', `Units remaining: ${script.getRemainingUsage()}`);
    log.audit('', '===============================================');
  };

  return { execute };
});
