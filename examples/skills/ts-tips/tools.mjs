// Skill-provided tools (optional). Loaded when the skill is enabled.
// Default export must be an array of Tool objects.
export default [
  {
    definition: {
      name: 'ts_style_check',
      description: 'Return the project TypeScript style rules.',
      inputSchema: { type: 'object', properties: {} },
    },
    async execute() {
      return 'Explicit types; strict mode; ESM with .js import extensions.';
    },
  },
];
