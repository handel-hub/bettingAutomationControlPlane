// acp-bytenode-compat-lab/lib/test-harness.mjs
// Isolated differential test harness for Control Plane compatibility lab

import { getEnvironmentMetadata } from './env.mjs';

export class TestHarness {
  constructor(suiteName) {
    this.suiteName = suiteName;
    this.tests = [];
    this.results = [];
  }

  test(id, name, mechanism, fn) {
    this.tests.push({ id, name, mechanism, fn });
  }

  async runAll() {
    console.log(`\n============================================================`);
    console.log(` SUITE: ${this.suiteName}`);
    console.log(` TOTAL TESTS: ${this.tests.length}`);
    console.log(`============================================================\n`);

    this.results = [];
    let passed = 0;
    let failed = 0;

    for (const t of this.tests) {
      const start = Date.now();
      let ok = false;
      let error = null;
      let data = null;

      try {
        data = await t.fn();
        ok = true;
        passed++;
        const elapsed = Date.now() - start;
        console.log(`[PASS] [${t.id}] ${t.name} (${t.mechanism}) in ${elapsed}ms`);
      } catch (err) {
        ok = false;
        failed++;
        error = {
          message: err.message,
          name: err.name,
          stack: err.stack ? err.stack.split('\n')[0] : null,
        };
        const elapsed = Date.now() - start;
        console.error(`[FAIL] [${t.id}] ${t.name} (${t.mechanism}) in ${elapsed}ms: ${err.message}`);
      }

      this.results.push({
        id: t.id,
        name: t.name,
        mechanism: t.mechanism,
        pass: ok,
        elapsedMs: Date.now() - start,
        data: ok ? (data !== undefined ? data : true) : null,
        error,
      });
    }

    console.log(`\n------------------------------------------------------------`);
    console.log(` SUMMARY: ${passed} Passed, ${failed} Failed out of ${this.tests.length}`);
    console.log(`------------------------------------------------------------\n`);

    return {
      suite: this.suiteName,
      environment: getEnvironmentMetadata(),
      summary: {
        total: this.tests.length,
        passed,
        failed,
        successRate: this.tests.length > 0 ? (passed / this.tests.length) * 100 : 0,
      },
      results: this.results,
    };
  }
}
