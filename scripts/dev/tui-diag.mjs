// Diagnostic: does Ink render with our FilteredStdin + mouse pipeline?
import { render, Box, Text } from 'ink';
import React from 'react';
import {
  FilteredStdin,
  MouseParser,
  filterMouseSequences,
  SGR_MOUSE_ENABLE,
} from '../dist/src/tui/mouse.js';
import process from 'node:process';

console.error(`isTTY stdin=${process.stdin.isTTY} stdout=${process.stdout.isTTY}`);

const filtered = new FilteredStdin(process.stdin);
const mouse = new MouseParser();
process.stdout.write(SGR_MOUSE_ENABLE);
process.stdin.resume();
const handler = (chunk) => {
  const s = chunk.toString('latin1');
  for (const ev of mouse.push(s)) console.error('mouse:', JSON.stringify(ev));
  const clean = filterMouseSequences(s);
  if (clean) filtered.write(Buffer.from(clean, 'latin1'));
};
process.stdin.on('data', handler);

const App = () =>
  React.createElement(
    Box,
    null,
    React.createElement(
      Text,
      { color: 'green' },
      `TUI-OK ${process.stdout.columns || 0}x${process.stdout.rows || 0}`,
    ),
  );
render(React.createElement(App), {
  stdin: filtered,
  exitOnCtrlC: false,
  alternateScreen: true,
  incrementalRendering: true,
});
setTimeout(() => {
  console.error('diag: exiting');
  process.exit(0);
}, 2000);
