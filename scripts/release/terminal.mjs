/** Linux PTY regression via util-linux script, with no Python or shell dotfile changes. */
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import sharp from "sharp";
if (process.platform !== "linux")
  throw new Error(
    "This PTY harness requires Linux util-linux script; other platforms need their native terminal verification.",
  );
const quote = (s) => `'${s.replaceAll("'", "'\\''")}'`,
  dir = await mkdtemp(path.join(os.tmpdir(), "tracktool-terminal-")),
  cli = path.resolve("dist/node/cli/main.js"),
  evidence = path.resolve(process.argv[2] || "sandbox/release-check");
await mkdir(evidence, { recursive: true });
const env = {
  ...process.env,
  TERM: "xterm-256color",
  XDG_CONFIG_HOME: path.join(dir, "config"),
  XDG_CACHE_HOME: path.join(dir, "cache"),
};
const jpg = await sharp({
  create: { width: 8, height: 8, channels: 3, background: "red" },
})
  .jpeg()
  .toBuffer();
for (let i = 0; i < 24; i++)
  await writeFile(path.join(dir, `中文${i}.jpg`), jpg);
function session(command) {
  const child = spawn("script", ["-qefc", command, "/dev/null"], {
    cwd: dir,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let text = "",
    code;
  child.stdout.on("data", (b) => (text += b));
  child.stderr.on("data", (b) => (text += b));
  const end = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (n) => {
      code = n;
      resolve(n);
    });
  });
  async function until(pattern) {
    const start = Date.now();
    while (!pattern.test(text)) {
      if (code !== undefined || Date.now() - start > 20000)
        throw new Error(`PTY did not match ${pattern}: ${text}`);
      await new Promise((r) => setTimeout(r, 25));
    }
    return text;
  }
  return {
    child,
    end,
    until,
    get text() {
      return text;
    },
  };
}
const results = {};
let active;
try {
  for (const cancel of [false, true]) {
    active = session(
      `stty cols 52; exec ${quote(process.execPath)} ${quote(cli)} --dry-run exif show-missing ${quote(dir)} GPSAltitude`,
    );
    await active.until(/\d+\/24/);
    if (cancel) active.child.stdin.write("\x03");
    const code = await active.end;
    assert.equal(code, cancel ? 130 : 0, active.text);
    assert.ok(active.text.includes("\x1b[?25h"), active.text);
    results[cancel ? "cancel" : "progress"] = {
      exit: code,
      cursor_restored: true,
      narrow_columns: 52,
    };
    active = undefined;
  }
  const custom = path.join(dir, "custom.json"),
    completion = path.join(dir, "completion.zsh");
  await writeFile(
    custom,
    JSON.stringify({ "track_tag.Default": ["自定义活动"] }),
  );
  const generated = spawnSync(process.execPath, [cli, "completion", "zsh"], {
    env,
    cwd: dir,
    encoding: "utf8",
  });
  assert.equal(generated.status, 0, generated.stderr);
  await writeFile(completion, generated.stdout);
  await writeFile(path.join(dir, "唯一路线.kml"), "fixture");
  active = session("zsh -f");
  active.child.stdin.write(
    `unsetopt ZLE_BEEP; PROMPT='PROBE> '; autoload -Uz compinit; compinit -D; source ${quote(completion)}; tracktool() { print -r -- RESULT:$*; }; print READY\n`,
  );
  await active.until(/READY\r?\n/);
  const trials = [
    ["tracktool kml pu\t\n", "RESULT:kml push"],
    ["tracktool kml push --dry-r\t\n", "RESULT:kml push --dry-run"],
    ["tracktool kml push --type Tr\t\n", "RESULT:kml push --type Train"],
    ["tracktool kml push 唯一\t\n", "RESULT:kml push 唯一路线.kml"],
    [
      `tracktool kml set-tag --config ${custom} --tag 自定\t\n`,
      `RESULT:kml set-tag --config ${custom} --tag 自定义活动`,
    ],
  ];
  for (const [input, wanted] of trials) {
    active.child.stdin.write(input);
    await active.until(
      new RegExp(wanted.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
  }
  active.child.stdin.write("exit\n");
  assert.equal(await active.end, 0);
  active = undefined;
  results.zsh = {
    commands: true,
    flags: true,
    category: true,
    chinese_path: true,
    dynamic_tag: true,
  };
  const bashCompletion = path.join(dir, "completion.bash");
  const bashGenerated = spawnSync(
    process.execPath,
    [cli, "completion", "bash"],
    { env, cwd: dir, encoding: "utf8" },
  );
  assert.equal(bashGenerated.status, 0, bashGenerated.stderr);
  await writeFile(bashCompletion, bashGenerated.stdout);
  active = session("bash --noprofile --norc");
  active.child.stdin.write(
    `PS1='PROBE> '; source ${quote(bashCompletion)}; tracktool() { printf 'RESULT:%s\\n' "$*"; }; printf 'BASHREADY\\n'\n`,
  );
  await active.until(/BASHREADY\r?\n/);
  for (const [input, wanted] of trials) {
    active.child.stdin.write(input);
    await active.until({
      test: (value) => value.includes(wanted),
      toString: () => wanted,
    });
  }
  active.child.stdin.write("exit\n");
  assert.equal(await active.end, 0);
  active = undefined;
  results.bash = {
    commands: true,
    flags: true,
    category: true,
    chinese_path: true,
    dynamic_tag: true,
  };
  const pipeline = spawnSync(
    "bash",
    [
      "--noprofile",
      "--norc",
      "-c",
      `set -o pipefail; ${quote(process.execPath)} ${quote(cli)} config show --public --config ${quote(custom)} | cat`,
    ],
    { cwd: dir, env, encoding: "utf8" },
  );
  assert.equal(pipeline.status, 0, pipeline.stderr);
  assert.ok(!pipeline.stdout.includes("\x1b["));
  JSON.parse(pipeline.stdout);
  results.bash.pipeline_stdout = true;
  await writeFile(
    path.join(evidence, "terminal.json"),
    JSON.stringify(results, null, 2) + "\n",
  );
  console.log(JSON.stringify(results));
} finally {
  if (active) {
    active.child.kill("SIGTERM");
    await active.end;
  }
  await rm(dir, { recursive: true, force: true });
}
