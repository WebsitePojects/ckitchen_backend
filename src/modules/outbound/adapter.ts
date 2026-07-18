/**
 * DUMMY outbound adapter (AGGREGATOR_API_INTEGRATION_SPEC.md §4: "a dummy
 * adapter proves the loop until credentials arrive"). Implements
 * {@link AggregatorOutboundAdapter}: records every call it receives (so
 * tests can assert exactly what worker.ts sent) and returns a configurable
 * result, defaulting to success. Mirrors src/modules/middleware/adapter.ts's
 * DummyProviderAdapter style for the inbound side.
 *
 * A future live Grab/foodpanda adapter implements the same interface 1:1
 * from spec §1's endpoint table — nothing in service.ts or worker.ts changes.
 */
import type { AggregatorOutboundAdapter, OutboundCommandRequest, OutboundSendResult } from "./types.js";

export interface DummyOutboundAdapterOptions {
  /** Every sendCommand call returns this result instead of the default success. */
  forcedResult?: OutboundSendResult;
  /** Per-call override, evaluated before `forcedResult` — lets a test script a sequence (e.g. fail twice, then succeed). */
  resultForAttempt?: (cmd: OutboundCommandRequest) => OutboundSendResult;
}

export class DummyOutboundAdapter implements AggregatorOutboundAdapter {
  readonly provider = "DUMMY";
  /** Every call this adapter has received, in order — the test-visible send log. */
  readonly calls: OutboundCommandRequest[] = [];
  private forcedResult?: OutboundSendResult;
  private resultForAttempt?: (cmd: OutboundCommandRequest) => OutboundSendResult;

  constructor(options: DummyOutboundAdapterOptions = {}) {
    this.forcedResult = options.forcedResult;
    this.resultForAttempt = options.resultForAttempt;
  }

  /** Test hook: change the forced result after construction (e.g. flip to a failure mid-test). */
  setForcedResult(result: OutboundSendResult | undefined): void {
    this.forcedResult = result;
  }

  /** Test hook: script a per-call result sequence after construction. */
  setResultForAttempt(fn: ((cmd: OutboundCommandRequest) => OutboundSendResult) | undefined): void {
    this.resultForAttempt = fn;
  }

  async sendCommand(cmd: OutboundCommandRequest): Promise<OutboundSendResult> {
    this.calls.push(cmd);
    if (this.resultForAttempt) return this.resultForAttempt(cmd);
    if (this.forcedResult) return this.forcedResult;
    return { ok: true, providerRef: `DUMMY-${cmd.commandId}-${cmd.attempt}` };
  }
}
