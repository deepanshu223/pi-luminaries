import { createFauxCore, fauxAssistantMessage } from '@earendil-works/pi-ai';

// Pi runs normally; only the provider response comes from the test's loopback server.
export default function scriptedProvider(pi) {
  let sessionId;
  pi.on('session_start', (_event, context) => {
    sessionId = context.sessionManager.getSessionId();
  });
  const faux = createFauxCore({
    provider: 'luminaries-test',
    models: [{ id: 'scripted' }, { id: 'reasoning', reasoning: true }],
  });
  pi.registerProvider('luminaries-test', {
    api: faux.api,
    baseUrl: process.env.LUMINARIES_TEST_PROVIDER,
    apiKey: 'local-test',
    models: faux.models,
    streamSimple(model, context, options) {
      faux.setResponses([
        async () => {
          const response = await fetch(process.env.LUMINARIES_TEST_PROVIDER, {
            method: 'POST',
            signal: options?.signal,
            body: JSON.stringify({
              sessionId,
              model: model.id,
              thinking: options?.reasoning,
              systemPrompt: context.systemPrompt,
              messages: context.messages,
              tools: pi.getActiveTools(),
            }),
          });
          const content = await response.json();
          return fauxAssistantMessage(content, {
            stopReason: content.some((part) => part.type === 'toolCall') ? 'toolUse' : 'stop',
          });
        },
      ]);
      return faux.streamSimple(model, context, options);
    },
  });
  pi.registerCommand('test-input', {
    handler: async (text) =>
      pi.sendMessage(
        { customType: 'test-input', content: text, display: true },
        { deliverAs: 'followUp', triggerTurn: true },
      ),
  });
  pi.registerCommand('test-error', {
    handler: async () => {
      throw new Error('Test input could not be read');
    },
  });
}
