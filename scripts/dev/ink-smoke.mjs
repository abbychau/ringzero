// Verify Ink v7 renders from our ESM setup (no TTY needed via renderToString).
import { renderToString, Box, Text } from 'ink';
import React from 'react';

const out = renderToString(
  React.createElement(Box, null, React.createElement(Text, { color: 'green' }, 'ink-ok')),
  { columns: 40 },
);
console.log(JSON.stringify(out));
console.log('REACT_VERSION', React.version);
