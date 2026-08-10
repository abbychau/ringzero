/** Render the real transcript + sidebar layout with the reported rows and
 * verify no line exceeds the frame or pushes the sidebar column. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from 'ink-testing-library';
import { Box, Text } from 'ink';
import { TranscriptRow, Sidebar } from '../src/tui/components.js';
import { layoutBlocks, initial, type Block } from '../src/tui/state.js';
import { strWidth } from '../src/tui/term.js';
import { decodeOutput } from '../src/tools/bash.js';

const MAIN_W = 93;
const SIDEBAR_W = 24;
const GAP = 1;

function frameLines(f: string): string[] {
  return f.split('\n');
}

test('tool-call block with CRLF output + thinking rows keeps the sidebar aligned', () => {
  const args = '{"command":"netstat -ano | findstr \":8080\" | findstr LISTENING & type .srv.log"}';
  const output =
    '  TCP    0.0.0.0:8080           0.0.0.0:0              LISTENING       68904\r\n' +
    '  TCP    [::]:8080              [::]:0                 LISTENING       68904\r\n' +
    '::1 - - [10/Aug/2026 19:16:41] "GET /index.html HTTP/1.1" 200 -\r\n' +
    'log line 4';
  const think =
    'The server IS running (PID 68904, listening on 0.0.0.0:8080 and [::]:8080), and the log ' +
    'shows the GET /index.html request returned 200. The powershell command produced the same ' +
    'netstat output. The server log tail: '.repeat(2) +
    'end.';
  const blocks: Block[] = [
    {
      tag: 'assistant',
      text: 'The command timed out — let me check whether the server actually started despite that:',
    },
    {
      tag: 'tool',
      name: 'bash',
      args,
      // decodeOutput is what the bash tool actually runs the output through:
      // it strips the CR from cmd's CRLF, so no \r ever reaches the TUI.
      output: decodeOutput(Buffer.from(output, 'utf8')),
      done: true,
      expanded: false,
    },
    { tag: 'thinking', text: think, expanded: false },
  ];
  const rows = layoutBlocks(blocks, MAIN_W);
  const state = { ...initial('deepseek-v4-flash'), blocks };
  const { lastFrame } = render(
    <Box flexDirection="row">
      <Box flexDirection="column" width={MAIN_W}>
        {rows.map((r, i) => (
          <TranscriptRow key={i} block={blocks[r.blockIdx]!} text={r.text} />
        ))}
        {Array.from({ length: Math.max(0, 10 - rows.length) }, (_, i) => (
          <Text key={`pad${i}`}> </Text>
        ))}
      </Box>
      <Text> </Text>
      <Sidebar
        state={state}
        model="deepseek-v4-flash"
        sessionId="abc123456789"
        budget={32000}
        height={10}
        cwdName="myproj"
        total={rows.length}
        visible={rows.length}
      />
    </Box>,
  );
  const frame = lastFrame()!;
  // A stray CR would rewind the terminal cursor to column 0 mid-row and dump
  // the sidebar content at the left edge — it must never reach the output.
  assert.ok(
    !frame.includes('\r'),
    `carriage return leaked into the frame: ${JSON.stringify(frame)}`,
  );
  const lines = frameLines(frame);
  for (const ln of lines) {
    const w = strWidth(ln);
    assert.ok(
      w <= MAIN_W + GAP + SIDEBAR_W,
      `line too wide (${w} > ${MAIN_W + GAP + SIDEBAR_W}): ${JSON.stringify(ln)}`,
    );
  }
  // The sidebar column must start at MAIN_W + GAP on every content line: no
  // transcript row may push it right.
  const sidebarStart = MAIN_W + GAP;
  for (const ln of lines) {
    if (strWidth(ln) <= sidebarStart) continue; // padding/blank lines
    const prefix = ln.slice(0, sidebarStart);
    assert.ok(
      strWidth(prefix) >= sidebarStart,
      `transcript row reached into the sidebar: ${JSON.stringify(ln)}`,
    );
  }
});
