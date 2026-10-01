import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { configDocument, effectiveMode, loadConfigJson, parseConfigArgs, parseConfigJson, saveConfigArgs } from "./config.ts";
import { DEFAULT_CONFIG } from "./types.ts";

const directory = mkdtempSync(join(tmpdir(), "warm-v2-"));
const path = join(directory, "warm-cache.json");
try {
  const fresh = loadConfigJson(path).config;
  assert.equal(effectiveMode(fresh), "both");
  assert.equal(fresh.intervalMs, null);
  const legacy = parseConfigJson('{"enabled":false,"warmDuringTools":["gradle"],"warmSpendCeilingUsd":2}');
  assert.equal(effectiveMode(legacy), "native");
  assert.equal(legacy.intervalMs, 240000);
  assert.equal(legacy.warmAllTools, false);
  assert.equal(legacy.warmSpendCeilingUsd, 2);
  assert.deepEqual(parseConfigJson(JSON.stringify(configDocument(legacy))), legacy);
  for (const mode of ["off", "native", "idle", "tools", "both"]) {
    const config = parseConfigArgs(`mode=${mode}`);
    assert.equal(config.mode, mode);
    assert.equal(config.enabled, mode !== "off" && mode !== "native");
    assert.deepEqual(parseConfigJson(JSON.stringify(configDocument(config))), config);
  }
  assert.equal(parseConfigArgs("auto", { ...DEFAULT_CONFIG, intervalMs: 123000 }).intervalMs, null);
  assert.equal(parseConfigArgs("interval=auto").intervalMs, null);
  assert.equal(parseConfigArgs("maxidle=unlimited spend=unlimited").maxIdleWarmMs, 0);
  assert.equal(parseConfigArgs("maxidle=unlimited spend=unlimited").warmSpendCeilingUsd, 0);
  for (const args of ["interval=typo", "interval=1ms", "interval=0.001s", "spend=-1", "spend=typo", "max=1.5", "tools=all,gradle", "toolmax=0", "ttl=wrong", "log=wrong", "scope=wrong", "unknown"]) {
    assert.throws(() => parseConfigArgs(args), Error, args);
  }
  assert.throws(() => parseConfigJson('{"schemaVersion":2,"mode":"off","enabled":true}'));
  assert.throws(() => parseConfigJson('{"schemaVersion":2,"interval":"1ms"}'));
  assert.throws(() => parseConfigJson('{"schemaVersion":3}'));

  // Session B's unrelated command cannot restore its stale spend/CLI state.
  saveConfigArgs("spend=2", path);
  saveConfigArgs("nowidget", path);
  assert.equal(loadConfigJson(path).config.warmSpendCeilingUsd, 2);
  assert.equal(loadConfigJson(path).config.showWidget, false);
  const before = readFileSync(path, "utf8");
  assert.throws(() => saveConfigArgs("spend=typo", path));
  assert.equal(readFileSync(path, "utf8"), before);
  writeFileSync(`${path}.lock`, "held by another writer");
  assert.throws(() => saveConfigArgs("spend=3", path), /busy/);
  assert.equal(readFileSync(path, "utf8"), before);
  rmSync(`${path}.lock`);

  // Actual separate writers retry lock contention, then both updates survive.
  const source = new URL("./config.ts", import.meta.url).href;
  async function writer(args: string): Promise<void> {
    const script = `import {saveConfigArgs} from ${JSON.stringify(source)};
      for(let i=0;;i++){try{saveConfigArgs(${JSON.stringify(args)},${JSON.stringify(path)});break}
      catch(e){if(i>100||!e.message.includes('busy'))throw e; await new Promise(r=>setTimeout(r,5));}}`;
    const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], { stdio: "pipe" });
    let errors = "";
    child.stderr.on("data", chunk => { errors += chunk; });
    await new Promise<void>((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", code => code === 0 ? resolve() : reject(new Error(errors)));
    });
  }
  await Promise.all([writer("spend=3"), writer("maxidle=45m")]);
  assert.equal(loadConfigJson(path).config.warmSpendCeilingUsd, 3);
  assert.equal(loadConfigJson(path).config.maxIdleWarmMs, 2700000);
} finally { rmSync(directory, { recursive: true, force: true }); }
console.log("config.test.ts: all assertions passed");
