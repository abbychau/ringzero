// Example RingZero plugin. Drop a copy into <cwd>/.ringzero/plugins/ or
// ~/.ringzero/plugins/ (file name becomes the plugin name, e.g. hello.mjs → /hello).
export default async function init(api) {
  // Custom tool
  api.registerTool({
    definition: {
      name: 'hello_world',
      description: 'Say hello. For demos.',
      inputSchema: { type: 'object', properties: { name: { type: 'string' } } },
    },
    async execute(input) {
      return `Hello, ${input.name ?? 'world'}!`;
    },
  });
  // Custom slash command → /hello
  api.registerCommand('hello', (args, a) => {
    a.say(`hello ${args.join(' ') || 'world'}`);
  });
  // Block any bash usage by default (example hook)
  api.onToolBefore(async ({ name }) => (name === 'bash' ? { allowed: false } : undefined));
}
