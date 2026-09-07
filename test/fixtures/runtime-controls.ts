function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason instanceof Error ? signal.reason : new Error('probe hold aborted'));
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  });
}

export default function runtimeControls(pi: { registerTool(tool: object): void }) {
  pi.registerTool({
    name: 'luminaries_probe_hold',
    label: 'Luminaries Probe Hold',
    description: 'Hold a deterministic tool boundary when explicitly requested by a Luminaries runtime test.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['label', 'milliseconds'],
      properties: { label: { type: 'string' }, milliseconds: { type: 'number', minimum: 50, maximum: 10000 } },
    },
    async execute(_id: string, params: { label: string; milliseconds: number }, signal: AbortSignal) {
      await wait(params.milliseconds, signal);
      return {
        content: [{ type: 'text', text: `HOLD_COMPLETE:${params.label}` }],
        details: { marker: 'HOLD_COMPLETE', label: params.label, milliseconds: params.milliseconds },
      };
    },
  });
}
