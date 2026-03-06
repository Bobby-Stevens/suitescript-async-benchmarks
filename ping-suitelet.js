/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 * 
 * PING SUITELET
 * 
 * Responds immediately with a JSON timestamp.
 * Used by the forensic async benchmark scripts to test
 * whether N/https .promise() calls execute in parallel.
 */
define([], () => {
  const onRequest = (context) => {
    context.response.write({ output: JSON.stringify({ pong: Date.now() }) });
  };
  return { onRequest };
});
