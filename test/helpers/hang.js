#!/usr/bin/env node
// A stand-in for ffmpeg that starts and never finishes; it records its pid so the test can check it was killed.
require('node:fs').writeFileSync(process.env.STUB_PID_FILE, String(process.pid));
setInterval(() => undefined, 1000);
