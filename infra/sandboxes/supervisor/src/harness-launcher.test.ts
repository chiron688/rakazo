import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const launcher = fileURLToPath(new URL("../../harness/launch.py", import.meta.url));
function run(frame: unknown, remaining = "") {
  return spawnSync("python3", ["-I", launcher], {
    input: `${JSON.stringify(frame)}\n${remaining}`,
    encoding: "utf8",
    timeout: 5_000,
    env: {
      PATH: "/usr/local/bin:/usr/bin:/bin",
      HOST_ONLY_SECRET: "host-value",
      NODE_OPTIONS: "hostile-value",
    },
  });
}

describe("private runtime credential bootstrap", () => {
  it("preserves native stdin and uses an exact private environment", () => {
    const result = run(
      {
        argv: [
          "/usr/bin/python3",
          "-I",
          "-c",
          "import os,sys,json;print(json.dumps(dict(os.environ)));print(sys.stdin.read())",
        ],
        env: { OPENAI_API_KEY: "fake-api-value" },
      },
      "native request\n",
    );
    expect(result.status).toBe(0);
    const lines = result.stdout.split("\n");
    const env = JSON.parse(lines[0] ?? "{}");
    expect(env).toMatchObject({
      OPENAI_API_KEY: "fake-api-value",
      HOME: "/home/harness",
      CODEX_HOME: "/home/harness/.codex",
    });
    expect(env.HOST_ONLY_SECRET).toBeUndefined();
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(lines[1]).toBe("native request");
  });

  it.each(["LD_PRELOAD", "PYTHONPATH", "NODE_OPTIONS", "HOME", "PATH"])(
    "rejects %s without rendering secret input",
    (key) => {
      const result = run({ argv: ["/usr/bin/true"], env: { [key]: "fake-api-value" } });
      expect(result.status).toBe(1);
      expect(result.stderr).toBe("Isolated runtime bootstrap failed.\n");
      expect(result.stdout).toBe("");
    },
  );
});
