/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 * 
 * FORENSIC ASYNC INVESTIGATION - USER EVENT VERSION
 * 
 * Confirms whether the serial execution pattern observed in Scheduled Scripts
 * also applies to User Event scripts (afterSubmit).
 * 
 * Deploy on Sales Order or any record you can easily save manually.
 * 
 * TESTS (trimmed for UE governance):
 *   0. Original 5 IDs that showed 2-4x speedup
 *   1. N/search, 5 dynamic records
 *   2. N/search, 15 dynamic records
 *   3. N/https, 5 Suitelet calls (if configured)
 */
define(['N/search', 'N/https', 'N/runtime'], (search, https, runtime) => {

  const PING_SCRIPT_ID = null;
  const PING_DEPLOY_ID = null;

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
      ? gaps.reduce((sum, g) => sum + Math.pow(g - avgGap, 2), 0) / gaps.length : 0;
    const gapStdDev = Math.sqrt(gapVariance);
    return {
      count: timings.length, inOrderCount, gaps,
      avgGap: avgGap.toFixed(1), gapStdDev: gapStdDev.toFixed(1),
      gapUniform: gapStdDev < 5, waitTimes,
      resolveOrder: byResolve.map(t => `L${t.launchIndex}`).join(','),
    };
  };

  const runSyncTest = (ids, operation) => {
    const timings = [];
    const t = Date.now();
    for (let i = 0; i < ids.length; i++) {
      const callStart = Date.now();
      operation(ids[i]);
      timings.push({ index: i, id: ids[i], ms: Date.now() - callStart });
    }
    const total = Date.now() - t;
    const callTimes = timings.map(t => t.ms);
    return {
      total, callTimes, first: callTimes[0],
      restAvg: callTimes.length > 1
        ? (callTimes.slice(1).reduce((a, b) => a + b, 0) / (callTimes.length - 1)).toFixed(1) : 'N/A',
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
          timings.push({ id, launchIndex, resolveIndex: resolveCounter++, launchTs, resolveTs, waitTime: resolveTs - launchTs });
          return result;
        });
      })
    );
    const total = Date.now() - t;
    return { total, analysis: analyzeTimings(timings) };
  };

  const afterSubmit = async (context) => {
    if (context.type !== context.UserEventType.EDIT && context.type !== context.UserEventType.CREATE) return;

    const script = runtime.getCurrentScript();

    log.audit('UE FORENSIC', '===============================================');
    log.audit('UE FORENSIC', 'Async Investigation - User Event afterSubmit');
    log.audit('UE FORENSIC', '===============================================');
    log.audit('ENV', `Script: ${script.id} | Deploy: ${script.deploymentId}`);
    log.audit('ENV', `Processors: ${runtime.processorCount} | Queues: ${runtime.queueCount}`);
    log.audit('ENV', `Governance: ${script.getRemainingUsage()}`);
    log.audit('ENV', `Trigger: ${context.type} on record ${context.newRecord.id}`);

    const fields = ['tranid', 'total', 'status'];
    const searchSync = (id) => search.lookupFields({ type: search.Type.SALES_ORDER, id, columns: fields });
    const searchAsync = (id) => search.lookupFields.promise({ type: search.Type.SALES_ORDER, id, columns: fields });

    const soIds = [];
    search.create({
      type: search.Type.SALES_ORDER,
      filters: [['mainline', 'is', 'T'], 'AND', ['internalid', 'isnotempty', '']],
      columns: [search.createColumn({ name: 'internalid', sort: search.Sort.DESC })]
    }).run().each(r => {
      if (soIds.length >= 15) return false;
      soIds.push(Number(r.getValue('internalid')));
      return true;
    });

    const ids5 = soIds.slice(0, 5);
    const ids15 = soIds.slice(0, 15);

    // TEST 0: ORIGINAL 5 IDs
    log.audit('', '===============================================');
    log.audit('TEST 0', 'ORIGINAL 5 IDs - the 2-4x speedup records');
    log.audit('', '===============================================');

    const originalIds = [226296, 226188, 226088, 225984, 225983];
    const t0Sync = runSyncTest(originalIds, searchSync);
    log.audit('T0 SYNC', `Total: ${t0Sync.total}ms | Per-call: [${t0Sync.callTimes.join(', ')}]`);

    const t0Async = await runAsyncTest(originalIds, searchAsync);
    log.audit('T0 ASYNC', `Total: ${t0Async.total}ms`);
    log.audit('T0 ASYNC', `Gaps: [${t0Async.analysis.gaps.join(', ')}]`);
    log.audit('T0 ASYNC', `Gap stdDev: ${t0Async.analysis.gapStdDev}ms - ${t0Async.analysis.gapUniform ? 'UNIFORM (serial)' : 'VARIABLE'}`);
    log.audit('T0 ASYNC', `Resolve order: ${t0Async.analysis.resolveOrder}`);
    log.audit('T0 ASYNC', `Wait times: [${t0Async.analysis.waitTimes.join(', ')}]`);
    log.audit('T0 RESULT', `Speedup: ${(t0Sync.total / t0Async.total).toFixed(2)}x - ${t0Sync.total > t0Async.total ? 'ASYNC WINS' : 'SYNC WINS'}`);

    // TEST 1: N/search, 5 dynamic records
    log.audit('', '===============================================');
    log.audit('TEST 1', 'N/search - 5 dynamic records');
    log.audit('', '===============================================');

    const t1Sync = runSyncTest(ids5, searchSync);
    log.audit('T1 SYNC', `Total: ${t1Sync.total}ms | Per-call: [${t1Sync.callTimes.join(', ')}]`);
    log.audit('T1 SYNC', `First: ${t1Sync.first}ms | Rest avg: ${t1Sync.restAvg}ms`);

    const t1Async = await runAsyncTest(ids5, searchAsync);
    log.audit('T1 ASYNC', `Total: ${t1Async.total}ms`);
    log.audit('T1 ASYNC', `Gaps: [${t1Async.analysis.gaps.join(', ')}]`);
    log.audit('T1 ASYNC', `Gap stdDev: ${t1Async.analysis.gapStdDev}ms - ${t1Async.analysis.gapUniform ? 'UNIFORM (serial)' : 'VARIABLE'}`);
    log.audit('T1 ASYNC', `Resolve order: ${t1Async.analysis.resolveOrder}`);
    log.audit('T1 RESULT', `Speedup: ${(t1Sync.total / t1Async.total).toFixed(2)}x - ${t1Sync.total > t1Async.total ? 'ASYNC WINS' : 'SYNC WINS'}`);

    // TEST 2: N/search, 15 dynamic records
    log.audit('', '===============================================');
    log.audit('TEST 2', 'N/search - 15 dynamic records');
    log.audit('', '===============================================');

    const t2Sync = runSyncTest(ids15, searchSync);
    log.audit('T2 SYNC', `Total: ${t2Sync.total}ms | Per-call: [${t2Sync.callTimes.join(', ')}]`);

    const t2Async = await runAsyncTest(ids15, searchAsync);
    log.audit('T2 ASYNC', `Total: ${t2Async.total}ms`);
    log.audit('T2 ASYNC', `Gaps: [${t2Async.analysis.gaps.join(', ')}]`);
    log.audit('T2 ASYNC', `Gap stdDev: ${t2Async.analysis.gapStdDev}ms - ${t2Async.analysis.gapUniform ? 'UNIFORM (serial)' : 'VARIABLE'}`);
    log.audit('T2 ASYNC', `Resolve order: ${t2Async.analysis.resolveOrder}`);
    log.audit('T2 RESULT', `Speedup: ${(t2Sync.total / t2Async.total).toFixed(2)}x - ${t2Sync.total > t2Async.total ? 'ASYNC WINS' : 'SYNC WINS'}`);

    // TEST 3: N/https (if configured)
    log.audit('', '===============================================');
    let t3HttpUniform = null;

    if (PING_SCRIPT_ID && PING_DEPLOY_ID) {
      log.audit('TEST 3', 'N/https - 5 Suitelet calls');
      log.audit('', '===============================================');

      const httpIds = Array.from({ length: 5 }, (_, i) => i);
      const httpSync = () => https.requestSuitelet({ scriptId: PING_SCRIPT_ID, deploymentId: PING_DEPLOY_ID });
      const httpAsync = () => https.requestSuitelet.promise({ scriptId: PING_SCRIPT_ID, deploymentId: PING_DEPLOY_ID });

      const t3Sync = runSyncTest(httpIds, httpSync);
      log.audit('T3 SYNC', `Total: ${t3Sync.total}ms | Per-call: [${t3Sync.callTimes.join(', ')}]`);

      const t3Async = await runAsyncTest(httpIds, httpAsync);
      log.audit('T3 ASYNC', `Total: ${t3Async.total}ms`);
      log.audit('T3 ASYNC', `Gaps: [${t3Async.analysis.gaps.join(', ')}]`);
      log.audit('T3 ASYNC', `Gap stdDev: ${t3Async.analysis.gapStdDev}ms - ${t3Async.analysis.gapUniform ? 'UNIFORM (serial even for HTTP)' : 'VARIABLE (HTTP has parallelism)'}`);
      log.audit('T3 ASYNC', `Wait times: [${t3Async.analysis.waitTimes.join(', ')}]`);
      log.audit('T3 RESULT', `Speedup: ${(t3Sync.total / t3Async.total).toFixed(2)}x - ${t3Sync.total > t3Async.total ? 'ASYNC WINS' : 'SYNC WINS'}`);
      t3HttpUniform = t3Async.analysis.gapUniform;
    } else {
      log.audit('TEST 3', 'SKIPPED - Set PING_SCRIPT_ID and PING_DEPLOY_ID');
      log.audit('', '===============================================');
    }

    // VERDICT
    log.audit('', '===============================================');
    log.audit('UE VERDICT', 'Does User Event afterSubmit match Scheduled Script behavior?');
    log.audit('', '-----------------------------------------------');

    const t0Serial = t0Async.analysis.gapUniform;
    const t1Serial = t1Async.analysis.gapUniform;
    const t2Serial = t2Async.analysis.gapUniform;

    log.audit('EVIDENCE', `Original IDs: ${t0Serial ? 'Serial (stdDev ' + t0Async.analysis.gapStdDev + 'ms)' : 'Variable (stdDev ' + t0Async.analysis.gapStdDev + 'ms)'} - ${t0Sync.total > t0Async.total ? 'async wins' : 'sync wins'}`);
    log.audit('EVIDENCE', `N/search x5: ${t1Serial ? 'Serial (stdDev ' + t1Async.analysis.gapStdDev + 'ms)' : 'Variable (stdDev ' + t1Async.analysis.gapStdDev + 'ms)'} - ${t1Sync.total > t1Async.total ? 'async wins' : 'sync wins'}`);
    log.audit('EVIDENCE', `N/search x15: ${t2Serial ? 'Serial (stdDev ' + t2Async.analysis.gapStdDev + 'ms)' : 'Variable (stdDev ' + t2Async.analysis.gapStdDev + 'ms)'} - ${t2Sync.total > t2Async.total ? 'async wins' : 'sync wins'}`);
    if (t3HttpUniform !== null) {
      log.audit('EVIDENCE', `N/https x5: ${t3HttpUniform ? 'Serial even for HTTP' : 'HTTP parallelism detected'}`);
    }

    log.audit('', '-----------------------------------------------');

    if (t0Serial && t1Serial && t2Serial) {
      log.audit('UE VERDICT', 'CONFIRMED - User Event shows same serial pattern as Scheduled Script');
      log.audit('UE VERDICT', 'Server-side .promise() is serial regardless of script type.');
    } else {
      log.audit('UE VERDICT', 'DIFFERENT - User Event shows different behavior. Investigate further.');
    }

    log.audit('', '===============================================');
    log.audit('GOV', `Units remaining: ${script.getRemainingUsage()}`);
    log.audit('', '===============================================');
  };

  return { afterSubmit };
});
