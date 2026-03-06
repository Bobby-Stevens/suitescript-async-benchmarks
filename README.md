# SuiteScript Async Benchmarks

Forensic benchmark scripts that test how `.promise()` actually behaves in SuiteScript 2.1 on the server side. Tests N/search, N/query, and N/https across Scheduled Scripts and User Events.

Companion code for my blog posts:
- [Your NetSuite Client Scripts Are 4x Slower Than They Need to Be](https://nsxsolutions.com/blog/suitescript-async-client-side)
- [What .promise() Actually Does on the Server in SuiteScript](https://nsxsolutions.com/blog/suitescript-async-server-side-investigation)

## What this tests

SuiteScript 2.1 exposes `.promise()` variants on several server-side modules. The assumption is that wrapping calls in `Promise.all` runs them in parallel, just like it does on the client side.

These scripts measure whether that's actually true by tracking the exact timing of every individual `.promise()` call: when it launched, when it resolved, and in what order. The gap pattern between resolves tells you whether the operations ran concurrently or serially.

## The scripts

### `async-forensic-scheduled.js`

The full test suite, running as a Scheduled Script. Includes six tests:

- **Test 0:** Original benchmark IDs that showed 2-4x speedup in early testing
- **Test 1:** Cold start detection on N/search (5 records)
- **Test 2:** Warm serial pattern on N/search (25 records)
- **Test 3:** N/query (SuiteQL) to check if a different module behaves differently
- **Test 4:** N/https (Suitelet calls) to test real HTTP I/O (requires ping Suitelet)
- **Test 5:** Scaling comparison at 5, 15, and 25 records
- **Test 6:** Repeat of Test 2 for consistency

Each test runs both sync and async, then analyzes the resolve timing to determine if execution was serial or concurrent.

### `async-forensic-userevent.js`

A trimmed version of the forensic suite running as a User Event `afterSubmit`. Tests N/search with the original benchmark IDs, 5 dynamic records, 15 dynamic records, and optionally N/https. Deploy on any record type you can easily save manually.

### `ping-suitelet.js`

A minimal Suitelet that responds immediately with a JSON timestamp. Required for the N/https tests in the other two scripts. Deploy this first, then set `PING_SCRIPT_ID` and `PING_DEPLOY_ID` in the forensic scripts to match.

```javascript
/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 */
define([], () => {
  const onRequest = (context) => {
    context.response.write({ output: JSON.stringify({ pong: Date.now() }) });
  };
  return { onRequest };
});
```

## Setup

1. Upload all three scripts to your NetSuite File Cabinet
2. Create script records and deployments for each:
   - `ping-suitelet.js` as a Suitelet (deploy first)
   - `async-forensic-scheduled.js` as a Scheduled Script
   - `async-forensic-userevent.js` as a User Event Script (deploy on Sales Order or similar)
3. In both forensic scripts, set the config values at the top:
   ```javascript
   const PING_SCRIPT_ID = 'customscript_your_ping';
   const PING_DEPLOY_ID = 'customdeploy_your_ping';
   ```
4. Run the Scheduled Script manually from the deployment page
5. For the User Event, edit and save a record it's deployed on
6. Check the Execution Log for results

## What to look for

The scripts analyze resolve timing gaps and report a standard deviation. Here is how to read the results:

**Uniform gaps (std deviation < 5ms)** = serial execution. The operations are being processed one at a time regardless of the `.promise()` wrapper.

**Variable gaps (std deviation > 5ms)** = possible concurrency. The operations may be running in parallel, or there may be a cold-start artifact skewing the data.

The scripts also report:
- Resolve order vs launch order (sequential = serial, scrambled = at least reordered internally)
- Per-call sync timing to detect cold starts (first call significantly slower than the rest)
- Governance unit consumption for sync vs async
- An automated verdict based on all collected evidence

## Our findings

Tested on a production NetSuite account running version 2025.2 with 2 SuiteCloud Processors.

| Module | Script Type | Serial? | Sync vs Async |
|--------|------------|---------|---------------|
| N/search | Scheduled Script | Yes (stdDev 0.5ms) | Sync wins |
| N/search | User Event | Yes (stdDev 0.0ms) | Sync wins (warm) |
| N/query | Scheduled Script | Yes (stdDev 0.0ms) | Async "wins" due to cold start only |
| N/https | Scheduled Script | Yes (stdDev 0.0ms) | Sync wins |
| N/https | User Event | Yes (stdDev 0.0ms) | Sync wins |

Server-side `.promise()` processes operations serially on Graal.js. The Promise API provides modern syntax and structured error handling, but not parallel execution. Early benchmarks showing 2-4x speedups were caused by cold-start overlap on the first call to a module within an execution context.

Client-side `.promise()` is a different story. The browser's V8 engine runs concurrent HTTP requests through a real event loop. Client-side async gives you genuine parallelism and a proven 4.4x speedup. That is where you should focus your optimization efforts.

## Got different results?

If you run these scripts on your account and see different behavior, I want to know. Open an issue with your execution logs, NetSuite version, and account configuration (processor count, queue count). Different account sizes, data center pods, or future NetSuite releases could behave differently.

## Author

**Bobby Stevens** - [NSX Solutions](https://nsxsolutions.com)

NetSuite developer specializing in SuiteScript development, API integrations, and performance optimization.
