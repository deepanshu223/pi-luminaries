export default function optionalExtension(pi) {
  pi.registerTool({
    name: 'test_extension_tool',
    label: 'Test extension tool',
    description: 'Report that this extension is loaded.',
    parameters: { type: 'object', properties: {} },
    async execute() {
      return { content: [{ type: 'text', text: 'Extension is available.' }], details: {} };
    },
  });
}
