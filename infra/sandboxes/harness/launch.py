"""Trusted one-frame bootstrap. Credentials never enter Docker config or process argv."""
import json
import os
import sys

CREDENTIAL_KEYS = frozenset((
    "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL",
    "OPENAI_API_KEY", "OPENAI_BASE_URL", "KIMI_API_KEY", "KIMI_BASE_URL",
    "KIMI_DISABLE_TELEMETRY",
))
ENVIRONMENT = {
    "HOME": "/home/harness",
    "XDG_CONFIG_HOME": "/home/harness/.config",
    "XDG_CACHE_HOME": "/home/harness/.cache",
    "XDG_DATA_HOME": "/home/harness/.local/share",
    "PATH": "/opt/rakazo-harness/node_modules/.bin:/opt/kimi/bin:/usr/local/bin:/usr/bin:/bin",
    "LANG": "C.UTF-8", "TMPDIR": "/tmp",
    "CODEX_HOME": "/home/harness/.codex",
    "CLAUDE_CONFIG_DIR": "/home/harness/.claude",
    "KIMI_SHARE_DIR": "/home/harness/.kimi",
}


def launch():
    # Do not buffer past the bootstrap newline: subsequent bytes belong to native stdin.
    frame = bytearray()
    while len(frame) <= 1024 * 1024:
        value = os.read(0, 1)
        if not value:
            raise ValueError("Missing bootstrap frame")
        if value == b"\n":
            break
        frame.extend(value)
    else:
        raise ValueError("Bootstrap frame exceeded its limit")
    request = json.loads(frame)
    if not isinstance(request, dict) or set(request) != {"argv", "env"}:
        raise ValueError("Invalid bootstrap frame")
    argv, environment = request["argv"], request["env"]
    if (not isinstance(argv, list) or not 1 <= len(argv) <= 128
            or any(not isinstance(arg, str) or not arg or "\0" in arg for arg in argv)):
        raise ValueError("Invalid command")
    if (not isinstance(environment, dict) or not set(environment) <= CREDENTIAL_KEYS
            or any(not isinstance(value, str) or "\0" in value for value in environment.values())):
        raise ValueError("Invalid environment")
    os.execvpe(argv[0], argv, {**ENVIRONMENT, **environment})


if __name__ == "__main__":
    try:
        launch()
    except Exception:
        # Input may contain a credential; do not render exception arguments or traceback.
        sys.stderr.write("Isolated runtime bootstrap failed.\n")
        sys.exit(1)
